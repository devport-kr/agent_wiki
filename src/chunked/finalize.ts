import { readFile } from "node:fs/promises";
import path from "node:path";

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
 * Finalize: runs after all sections are persisted.
 * Runs cross-section validation and optionally advances the freshness baseline.
 */
export async function finalize(
  session: ChunkedSession,
  plan: SectionPlanOutput,
  options: FinalizeOptions,
): Promise<FinalizeResult> {
  const { advanceBaseline, statePath, s3FreshnessOptions } = options;

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

  // 4. Assemble synthetic accepted output (needed for freshness baseline)
  const acceptedOutput = assembleAcceptedOutput(plan, sectionOutputs);

  // 5. Advance freshness baseline if flagged
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
          `    Re-run finalize --advance_baseline after fixing source paths\n`,
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
