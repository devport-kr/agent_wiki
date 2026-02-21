import { existsSync } from "node:fs";
import path from "node:path";

import type { SectionOutput } from "../contracts/chunked-generation";
import type { QualityGateLevel } from "../ingestion/types";
import { detectBodyKoRepetitionInBodies } from "../orchestration/package-delivery";

export interface ValidateSectionOptions {
  snapshotPath: string;
  qualityGateLevel?: QualityGateLevel;
}

/**
 * Per-section validation that runs during `persist-section`.
 * Catches errors early before embedding/persisting.
 * Returns an array of error strings. Empty = valid.
 */
export function validateSection(
  section: SectionOutput,
  options: ValidateSectionOptions,
): string[] {
  const errors: string[] = [];

  // ── Subsection count ≥ 3 ──────────────────────────────────────────────────
  if (section.subsections.length < 3) {
    errors.push(
      `${section.sectionId}: must have at least 3 subsections, got ${section.subsections.length}`,
    );
  }

  // ── Subsection sectionId must match parent ────────────────────────────────
  for (const sub of section.subsections) {
    if (sub.sectionId !== section.sectionId) {
      errors.push(
        `${sub.subsectionId}: sectionId "${sub.sectionId}" must match parent "${section.sectionId}"`,
      );
    }
  }

  // ── bodyKo ≥ 3,000 chars ──────────────────────────────────────────────────
  for (const sub of section.subsections) {
    if (sub.bodyKo.length < 3000) {
      errors.push(
        `${sub.subsectionId} (${section.sectionId}): bodyKo is ${sub.bodyKo.length} chars, minimum is 3,000`,
      );
    }
  }

  // ── Within-section sentence repetition ────────────────────────────────────
  const bodies = section.subsections.map((sub) => ({
    sectionId: section.sectionId,
    subsectionId: sub.subsectionId,
    bodyKo: sub.bodyKo,
  }));

  const repetitionErrors = detectBodyKoRepetitionInBodies(bodies);
  errors.push(...repetitionErrors);

  // ── sourcePaths existence and snapshot resolution ─────────────────────────
  if (section.sourcePaths.length === 0) {
    errors.push(`${section.sectionId}: sourcePaths must contain at least one path`);
  }

  for (const sourcePath of section.sourcePaths) {
    const fullPath = path.join(options.snapshotPath, sourcePath);
    if (!existsSync(fullPath)) {
      errors.push(
        `${section.sectionId}: sourcePath "${sourcePath}" does not exist in snapshot`,
      );
    }
  }

  // ── Architecture Mermaid block ────────────────────────────────────────────
  const hasArchitectureMermaid = section.subsections.some((sub) =>
    /```mermaid[\s\S]*?```/i.test(sub.bodyKo),
  );
  if (!hasArchitectureMermaid) {
    errors.push(
      `${section.sectionId}: must include at least one architecture mermaid block (\`\`\`mermaid ... \`\`\`)`,
    );
  }

  // ── Strict quality gate (GND-04) ──────────────────────────────────────────
  if (options.qualityGateLevel === "strict") {
    if (!hasArchitectureMermaid) {
      errors.push(
        `${section.sectionId}: strict quality requires architecture mermaid block for beginner/trend output`,
      );
    }
  }

  return errors;
}
