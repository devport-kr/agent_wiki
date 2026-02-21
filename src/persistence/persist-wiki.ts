import type pg from "pg";
import type OpenAI from "openai";

import type { GroundedAcceptedOutput } from "../contracts/grounded-output";
import type { DeliveryArtifactEnvelope } from "../packaging/validate";
import { embedTexts, vectorToSql } from "./embed";

export interface PersistWikiOptions {
  pool: pg.Pool;
  openai: OpenAI;
  advanceBaseline: boolean;
  statePath: string;
}

export interface PersistWikiResult {
  projectExternalId: string;
  chunksInserted: number;
}

interface ChunkRecord {
  projectExternalId: string;
  sectionId: string;
  subsectionId: string | null;
  chunkType: "summary" | "body";
  content: string;
  embedding: number[];
  tokenCount: number;
  metadata: Record<string, unknown>;
  commitSha: string;
}

function buildSectionsJsonb(
  acceptedOutput: GroundedAcceptedOutput,
): Array<Record<string, unknown>> {
  return acceptedOutput.draft.sections.map((section, index) => {
    const subsections = section.subsections
      .slice()
      .sort((a, b) => a.subsectionId.localeCompare(b.subsectionId, "en", { numeric: true }));

    const deepDiveParts = subsections.map(
      (sub) => `## ${sub.titleKo}\n\n${sub.bodyKo}`,
    );

    return {
      sectionId: section.sectionId,
      heading: section.titleKo,
      anchor: section.sectionId,
      summary: section.summaryKo,
      deepDiveMarkdown: deepDiveParts.join("\n\n"),
      defaultExpanded: false,
      order: index,
      metadata: {
        commitSha: acceptedOutput.commit_sha,
        subsectionCount: subsections.length,
      },
    };
  });
}

function buildCurrentCounters(acceptedOutput: GroundedAcceptedOutput): Record<string, unknown> {
  const sourceDocCount =
    acceptedOutput.source_doc_count ?? acceptedOutput.draft.sourceDocs?.length ?? 0;
  const trendFactCount =
    acceptedOutput.trend_fact_count ?? acceptedOutput.draft.trendFacts?.length ?? 0;

  return {
    sectionCount: acceptedOutput.section_count,
    subsectionCount: acceptedOutput.subsection_count,
    sourceDocCount,
    trendFactCount,
    totalKoreanChars: acceptedOutput.total_korean_chars,
  };
}

function collectChunks(
  acceptedOutput: GroundedAcceptedOutput,
  projectExternalId: string,
): Array<{ text: string; record: Omit<ChunkRecord, "embedding" | "tokenCount"> }> {
  const chunks: Array<{ text: string; record: Omit<ChunkRecord, "embedding" | "tokenCount"> }> = [];

  for (const section of acceptedOutput.draft.sections) {
    // Section summary chunk
    chunks.push({
      text: section.summaryKo,
      record: {
        projectExternalId,
        sectionId: section.sectionId,
        subsectionId: null,
        chunkType: "summary",
        content: section.summaryKo,
        metadata: { titleKo: section.titleKo },
        commitSha: acceptedOutput.commit_sha,
      },
    });

    // Subsection body chunks
    for (const sub of section.subsections) {
      chunks.push({
        text: sub.bodyKo,
        record: {
          projectExternalId,
          sectionId: section.sectionId,
          subsectionId: sub.subsectionId,
          chunkType: "body",
          content: sub.bodyKo,
          metadata: { titleKo: sub.titleKo, sectionTitleKo: section.titleKo },
          commitSha: acceptedOutput.commit_sha,
        },
      });
    }
  }

  return chunks;
}

export async function persistWikiToDb(
  acceptedOutput: GroundedAcceptedOutput,
  envelope: DeliveryArtifactEnvelope,
  options: PersistWikiOptions,
): Promise<PersistWikiResult> {
  const { pool, openai } = options;

  // 1. Resolve project
  const projectResult = await pool.query<{ id: number; external_id: string }>(
    "SELECT id, external_id FROM projects WHERE LOWER(full_name) = LOWER($1)",
    [acceptedOutput.repo_ref],
  );

  if (projectResult.rows.length === 0) {
    throw new Error(
      `Project not found in database for repo_ref: ${acceptedOutput.repo_ref}. ` +
        `Ensure the project exists in the projects table with a matching full_name.`,
    );
  }

  const { id: projectId, external_id: projectExternalId } = projectResult.rows[0];

  // 2. Build sections JSONB
  const sectionsJsonb = buildSectionsJsonb(acceptedOutput);
  const currentCounters = buildCurrentCounters(acceptedOutput);

  // 3. Collect chunk texts for embedding
  const chunkEntries = collectChunks(acceptedOutput, projectExternalId);
  const texts = chunkEntries.map((entry) => entry.text);

  process.stderr.write(`  embedding ${texts.length} chunks via OpenAI...\n`);

  // 4. Batch embed
  const embeddingResults = await embedTexts(openai, texts);

  // 5. Transaction: delete old chunks, insert new chunks, upsert snapshot + draft
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Delete existing chunks for this project
    await client.query(
      "DELETE FROM wiki_section_chunks WHERE project_external_id = $1",
      [projectExternalId],
    );

    // Insert new chunks
    for (let i = 0; i < chunkEntries.length; i++) {
      const entry = chunkEntries[i];
      const emb = embeddingResults[i];

      await client.query(
        `INSERT INTO wiki_section_chunks
          (project_external_id, section_id, subsection_id, chunk_type, content,
           embedding, token_count, metadata, commit_sha, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8::jsonb, $9, NOW(), NOW())`,
        [
          entry.record.projectExternalId,
          entry.record.sectionId,
          entry.record.subsectionId,
          entry.record.chunkType,
          entry.record.content,
          vectorToSql(emb.embedding),
          emb.tokenCount,
          JSON.stringify(entry.record.metadata),
          entry.record.commitSha,
        ],
      );
    }

    // Upsert project_wiki_snapshots
    const generatedAt = acceptedOutput.draft.generatedAt;
    await client.query(
      `INSERT INTO project_wiki_snapshots
        (project_external_id, generated_at, sections, current_counters,
         is_data_ready, hidden_sections, readiness_metadata, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, true, '[]'::jsonb,
              '{"passesTopStarGate": true}'::jsonb, NOW(), NOW())
      ON CONFLICT (project_external_id) DO UPDATE SET
        generated_at = EXCLUDED.generated_at,
        sections = EXCLUDED.sections,
        current_counters = EXCLUDED.current_counters,
        is_data_ready = true,
        readiness_metadata = '{"passesTopStarGate": true}'::jsonb,
        updated_at = NOW()`,
      [
        projectExternalId,
        generatedAt,
        JSON.stringify(sectionsJsonb),
        JSON.stringify(currentCounters),
      ],
    );

    // Upsert wiki_drafts — find latest draft by project_id, or insert new
    const existingDraft = await client.query<{ id: number }>(
      "SELECT id FROM wiki_drafts WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [projectId],
    );

    if (existingDraft.rows.length > 0) {
      await client.query(
        `UPDATE wiki_drafts
        SET sections = $1::jsonb, current_counters = $2::jsonb, updated_at = NOW()
        WHERE id = $3`,
        [
          JSON.stringify(sectionsJsonb),
          JSON.stringify(currentCounters),
          existingDraft.rows[0].id,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO wiki_drafts
          (project_id, sections, current_counters, hidden_sections, created_at, updated_at)
        VALUES ($1, $2::jsonb, $3::jsonb, '[]'::jsonb, NOW(), NOW())`,
        [projectId, JSON.stringify(sectionsJsonb), JSON.stringify(currentCounters)],
      );
    }

    await client.query("COMMIT");

    return {
      projectExternalId,
      chunksInserted: chunkEntries.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
