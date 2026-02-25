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

  // ── Prefix-repetition padding detection ───────────────────────────────────
  // Catches filler lines that share an identical prefix but vary in suffix,
  // e.g. "지금 항목 식별자는 sec-1/sub-1-1/1이다. ..." repeated 18 times.
  const PREFIX_LENGTH = 20;
  const PREFIX_REPEAT_THRESHOLD = 5;
  for (const sub of section.subsections) {
    const lines = sub.bodyKo
      .split(/[\n\r]+/)
      .map((line) => line.trim())
      .filter((line) => line.length >= PREFIX_LENGTH);

    const prefixCounts = new Map<string, number>();
    for (const line of lines) {
      const prefix = line.slice(0, PREFIX_LENGTH);
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }

    for (const [prefix, count] of prefixCounts) {
      if (count >= PREFIX_REPEAT_THRESHOLD) {
        errors.push(
          `${sub.subsectionId} (${section.sectionId}): padding detected — line prefix "${prefix}..." repeated ${count} times. Write unique content instead of filler lines.`,
        );
        break; // one error per subsection is enough
      }
    }
  }

  // ── Escaped newline padding detection ─────────────────────────────────────
  // Catches bodyKo that uses literal "\\n" sequences to pad content instead of
  // real line breaks. This indicates raw string concatenation padding.
  for (const sub of section.subsections) {
    const escapedNewlineCount = (sub.bodyKo.match(/\\\\n/g) ?? []).length;
    if (escapedNewlineCount >= 5) {
      errors.push(
        `${sub.subsectionId} (${section.sectionId}): bodyKo contains ${escapedNewlineCount} escaped newline sequences (\\\\n). Use real line breaks and write genuine content.`,
      );
    }
  }

  return errors;
}
