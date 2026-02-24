import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type OpenAI from "openai";

import type {
  ChunkedSession,
  SectionOutput,
  SectionPlanOutput,
} from "../contracts/chunked-generation";
import { SectionOutputSchema } from "../contracts/chunked-generation";
import type { GroundedAcceptedOutput } from "../contracts/grounded-output";
import {
  detectCrossSubsectionRepetitionInBodies,
} from "../orchestration/package-delivery";
import { extractSectionEvidenceFromAcceptedOutput } from "../freshness/section-evidence";
import { loadFreshnessState, saveFreshnessState } from "../freshness/state";
import type { S3JsonAdapter } from "../shared/s3-storage";

export interface FinalizeOptions {
  pool: pg.Pool;
  openai: OpenAI;
  advanceBaseline: boolean;
  statePath: string;
  s3FreshnessOptions?: { adapter: S3JsonAdapter; key: string };
}

export interface FinalizeResult {
  sectionsAssembled: number;
  totalSubsections: number;
  totalSourceDocs: number;
  totalTrendFacts: number;
  totalKoreanChars: number;
}

const LEGACY_SECTION_COLUMNS = [
  "what_section",
  "how_section",
  "architecture_section",
  "releases_section",
  "activity_section",
  "chat_section",
];

/**
 * Loads all section output files from the session and validates their schema.
 */
async function loadAllSectionOutputs(session: ChunkedSession): Promise<SectionOutput[]> {
  const outputs: SectionOutput[] = [];

  for (const [sectionId, status] of Object.entries(session.sections)) {
    if (status.status !== "persisted") {
      throw new Error(`Section ${sectionId} is not persisted (status: ${status.status})`);
    }

    if (!status.sectionOutputPath) {
      throw new Error(`Section ${sectionId} has no sectionOutputPath`);
    }

    const raw = await readFile(path.resolve(status.sectionOutputPath), "utf8");
    const parsed = SectionOutputSchema.parse(JSON.parse(raw));
    outputs.push(parsed);
  }

  // Sort by sectionId for deterministic ordering
  outputs.sort((a, b) => a.sectionId.localeCompare(b.sectionId, "en", { numeric: true }));
  return outputs;
}

/**
 * Cross-section validation:
 * - Cross-subsection body repetition across all sections
 */
function crossSectionValidation(sections: SectionOutput[]): string[] {
  const errors: string[] = [];

  // Cross-section body repetition
  const allBodies: Array<{ sectionId: string; subsectionId: string; bodyKo: string }> = [];
  for (const section of sections) {
    for (const sub of section.subsections) {
      allBodies.push({
        sectionId: section.sectionId,
        subsectionId: sub.subsectionId,
        bodyKo: sub.bodyKo,
      });
    }
  }

  const crossRepErrors = detectCrossSubsectionRepetitionInBodies(allBodies);
  errors.push(...crossRepErrors);

  return errors;
}

/**
 * Assembles a synthetic GroundedAcceptedOutput from all section outputs.
 * Needed for cross-section validation and freshness baseline.
 */
function assembleAcceptedOutput(
  plan: SectionPlanOutput,
  sections: SectionOutput[],
): GroundedAcceptedOutput {
  const allSourcePaths = Array.from(
    new Set(
      sections.flatMap((section) =>
        section.sourcePaths
          .map((sourcePath) => sourcePath.trim())
          .filter((sourcePath) => sourcePath.length > 0),
      ),
    ),
  ).sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));

  const draftSections = sections.map((s) => ({
    sectionId: s.sectionId,
    titleKo: s.titleKo,
    summaryKo: s.summaryKo,
    sourcePaths: s.sourcePaths
      .map((sourcePath) => sourcePath.trim())
      .filter((sourcePath) => sourcePath.length > 0)
      .sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" })),
    subsections: s.subsections.map((sub) => ({
      sectionId: sub.sectionId,
      subsectionId: sub.subsectionId,
      titleKo: sub.titleKo,
      bodyKo: sub.bodyKo,
    })),
  }));

  const subsectionCount = sections.reduce((sum, s) => sum + s.subsections.length, 0);

  let totalKoreanChars = plan.overviewKo.length;
  for (const s of sections) {
    totalKoreanChars += s.summaryKo.length;
    for (const sub of s.subsections) {
      totalKoreanChars += sub.bodyKo.length;
    }
  }

  const now = new Date().toISOString();

  return {
    ingest_run_id: plan.ingestRunId,
    repo_ref: plan.repoFullName,
    commit_sha: plan.commitSha,
    section_count: sections.length,
    subsection_count: subsectionCount,
    total_korean_chars: totalKoreanChars,
    source_doc_count: allSourcePaths.length,
    trend_fact_count: 0,
    draft: {
      artifactType: "wiki-draft",
      repoFullName: plan.repoFullName,
      commitSha: plan.commitSha,
      generatedAt: now,
      overviewKo: plan.overviewKo,
      sections: draftSections as never,
      sourceDocs: allSourcePaths.map((sourcePath, index) => ({
        sourceId: `src-${index + 1}`,
        path: sourcePath,
      })),
      trendFacts: [],
    },
  };
}

/**
 * Builds JSONB section array for project_wiki_snapshots (same pattern as persist-wiki.ts).
 */
function buildSectionsJsonb(
  sections: SectionOutput[],
  commitSha: string,
): Array<Record<string, unknown>> {
  return sections.map((section, index) => {
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
        commitSha,
        subsectionCount: subsections.length,
      },
    };
  });
}

function buildCurrentCounters(
  sections: SectionOutput[],
  totalKoreanChars: number,
): Record<string, unknown> {
  const subsectionCount = sections.reduce((sum, s) => sum + s.subsections.length, 0);
  const sourceDocCount = new Set(
    sections.flatMap((section) => section.sourcePaths.map((sourcePath) => sourcePath.trim())),
  ).size;

  return {
    sectionCount: sections.length,
    subsectionCount,
    sourceDocCount,
    trendFactCount: 0,
    totalKoreanChars: totalKoreanChars,
  };
}

async function hasLegacySnapshotColumns(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_wiki_snapshots'
        AND column_name = ANY($1::text[])
    `,
    [LEGACY_SECTION_COLUMNS],
  );
  return result.rows.length === LEGACY_SECTION_COLUMNS.length;
}

/**
 * Finalize: runs after all sections are persisted.
 * Validates the complete wiki and updates snapshot/draft tables.
 */
export async function finalize(
  session: ChunkedSession,
  plan: SectionPlanOutput,
  options: FinalizeOptions,
): Promise<FinalizeResult> {
  const { pool, advanceBaseline, statePath, s3FreshnessOptions } = options;

  // 1. Verify all sections are persisted
  const pendingSections = Object.entries(session.sections)
    .filter(([_, status]) => status.status !== "persisted")
    .map(([id]) => id);

  if (pendingSections.length > 0) {
    throw new Error(
      `Cannot finalize: sections not yet persisted: ${pendingSections.join(", ")}`,
    );
  }

  // 2. Load all section outputs
  const sectionOutputs = await loadAllSectionOutputs(session);

  // 3. Cross-section validation
  const crossErrors = crossSectionValidation(sectionOutputs);
  if (crossErrors.length > 0) {
    throw new Error(
      `Cross-section validation failed (${crossErrors.length} issue(s)):\n` +
        crossErrors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  // 4. Assemble synthetic accepted output
  const acceptedOutput = assembleAcceptedOutput(plan, sectionOutputs);

  // 5. Build JSONB sections and counters
  const sectionsJsonb = buildSectionsJsonb(sectionOutputs, session.commitSha);
  const currentCounters = buildCurrentCounters(sectionOutputs, acceptedOutput.total_korean_chars);

  // 6. Resolve project from DB
  const projectResult = await pool.query<{ id: number; external_id: string }>(
    "SELECT id, external_id FROM projects WHERE LOWER(full_name) = LOWER($1)",
    [session.repoFullName],
  );

  if (projectResult.rows.length === 0) {
    throw new Error(
      `Project not found in database for repo_ref: ${session.repoFullName}. ` +
        `Ensure the project exists in the projects table with a matching full_name.`,
    );
  }

  const { id: projectId, external_id: projectExternalId } = projectResult.rows[0];

  // 7. In a single DB transaction: upsert snapshot + draft
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const generatedAt = new Date().toISOString();
    const sectionsJson = JSON.stringify(sectionsJsonb);
    const countersJson = JSON.stringify(currentCounters);
    const useLegacyColumns = await hasLegacySnapshotColumns(client);
    const legacySectionsJson = JSON.stringify({ sections: sectionsJsonb });

    if (useLegacyColumns) {
      await client.query(
        `INSERT INTO project_wiki_snapshots
          (project_external_id, generated_at, sections, current_counters,
           is_data_ready, hidden_sections, readiness_metadata,
           what_section, how_section, architecture_section, releases_section, activity_section, chat_section,
           created_at, updated_at)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, true, '[]'::jsonb, '{"passesTopStarGate": true}'::jsonb,
                $5::jsonb, $5::jsonb, $5::jsonb, $5::jsonb, $5::jsonb, $5::jsonb, NOW(), NOW())
        ON CONFLICT (project_external_id) DO UPDATE SET
          generated_at = EXCLUDED.generated_at,
          sections = EXCLUDED.sections,
          current_counters = EXCLUDED.current_counters,
          is_data_ready = true,
          readiness_metadata = '{"passesTopStarGate": true}'::jsonb,
          what_section = EXCLUDED.what_section,
          how_section = EXCLUDED.how_section,
          architecture_section = EXCLUDED.architecture_section,
          releases_section = EXCLUDED.releases_section,
          activity_section = EXCLUDED.activity_section,
          chat_section = EXCLUDED.chat_section,
          updated_at = NOW()`,
        [
          projectExternalId,
          generatedAt,
          sectionsJson,
          countersJson,
          legacySectionsJson,
        ],
      );
    } else {
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
        [projectExternalId, generatedAt, sectionsJson, countersJson],
      );
    }

    // Upsert wiki_drafts
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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // 8. Advance freshness baseline if flagged
  if (advanceBaseline) {
    try {
      const evidence = extractSectionEvidenceFromAcceptedOutput(acceptedOutput);
      const state = await loadFreshnessState(statePath, s3FreshnessOptions);
      const repoRef = session.repoFullName.toLowerCase();

      const nextState = {
        ...state,
        repos: {
          ...state.repos,
          [repoRef]: {
            repo_ref: repoRef,
            last_delivery_commit: session.commitSha,
            sectionEvidenceIndex: evidence,
          },
        },
      };

      await saveFreshnessState(statePath, nextState, s3FreshnessOptions);
      process.stderr.write(`  ✓ freshness baseline → ${session.commitSha.slice(0, 7)}\n`);
    } catch (err) {
      process.stderr.write(
        `  ⚠ freshness baseline not saved: ${String(err)}\n` +
          `    DB writes succeeded; re-run finalize --advance_baseline after fixing source paths\n`,
      );
    }
  }

  const totalSubsections = sectionOutputs.reduce((sum, section) => sum + section.subsections.length, 0);

  return {
    sectionsAssembled: sectionOutputs.length,
    totalSubsections,
    totalSourceDocs: acceptedOutput.source_doc_count,
    totalTrendFacts: acceptedOutput.trend_fact_count,
    totalKoreanChars: acceptedOutput.total_korean_chars,
  };
}
