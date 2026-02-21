import type pg from "pg";
import type OpenAI from "openai";

import type { SectionOutput } from "../contracts/chunked-generation";
import { embedTexts, vectorToSql } from "../persistence/embed";

export interface PersistSectionOptions {
  pool: pg.Pool;
  openai: OpenAI;
  projectExternalId: string;
  commitSha: string;
}

export interface PersistSectionResult {
  chunksInserted: number;
}

interface ChunkEntry {
  text: string;
  record: {
    projectExternalId: string;
    sectionId: string;
    subsectionId: string | null;
    chunkType: "summary" | "body";
    content: string;
    metadata: Record<string, unknown>;
    commitSha: string;
  };
}

function collectSectionChunks(
  section: SectionOutput,
  projectExternalId: string,
  commitSha: string,
): ChunkEntry[] {
  const chunks: ChunkEntry[] = [];

  // Section summary chunk
  chunks.push({
    text: section.summaryKo,
    record: {
      projectExternalId,
      sectionId: section.sectionId,
      subsectionId: null,
      chunkType: "summary",
      content: section.summaryKo,
      metadata: {
        titleKo: section.titleKo,
        sourcePaths: section.sourcePaths,
        sourcePathCount: section.sourcePaths.length,
      },
      commitSha,
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
          metadata: {
            titleKo: sub.titleKo,
            sectionTitleKo: section.titleKo,
            sourcePathCount: section.sourcePaths.length,
          },
          commitSha,
        },
      });
  }

  return chunks;
}

/**
 * Persists a single section to the database.
 * Scoped delete: only removes chunks for this specific section.
 * Idempotent — re-running for the same section replaces its chunks.
 * Does NOT touch project_wiki_snapshots or wiki_drafts (that's finalize's job).
 */
export async function persistSectionToDb(
  sectionOutput: SectionOutput,
  options: PersistSectionOptions,
): Promise<PersistSectionResult> {
  const { pool, openai, projectExternalId, commitSha } = options;

  // Collect chunks for embedding
  const chunkEntries = collectSectionChunks(sectionOutput, projectExternalId, commitSha);
  const texts = chunkEntries.map((entry) => entry.text);

  process.stderr.write(`  embedding ${texts.length} chunks for ${sectionOutput.sectionId}...\n`);

  // Batch embed
  const embeddingResults = await embedTexts(openai, texts);

  // Transaction: scoped delete + insert
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Scoped delete: only this section's chunks
    await client.query(
      "DELETE FROM wiki_section_chunks WHERE project_external_id = $1 AND section_id = $2",
      [projectExternalId, sectionOutput.sectionId],
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

    await client.query("COMMIT");

    return { chunksInserted: chunkEntries.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
