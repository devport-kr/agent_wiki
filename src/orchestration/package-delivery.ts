import type { GroundedAcceptedOutput } from "../contracts/grounded-output";
import type { QualityGateLevel } from "../ingestion/types";
import { adaptAcceptedOutputToDelivery } from "../packaging/adapter";
import { buildGlossaryFromAcceptedOutput } from "../packaging/glossary";
import { assertValidDeliveryEnvelope, type DeliveryArtifactEnvelope } from "../packaging/validate";
import { buildQualityScorecard } from "../quality/scorecard";

/**
 * Detects repeated content in an array of subsection bodies.
 * Reusable for both single-section and full-output validation.
 *
 * Why both checks?
 * - Sentence-based: catches obvious duplication when punctuation is present.
 * - Chunk-based: catches "run-on" padding that avoids sentence boundaries (e.g., comma-joined blobs).
 */
export function detectBodyKoRepetitionInBodies(
  bodies: Array<{ sectionId: string; subsectionId: string; bodyKo: string }>,
): string[] {
  const errors: string[] = [];

  for (const sub of bodies) {
    const sentences = splitKoreanSentences(sub.bodyKo).filter((s) => s.length > 50);
    const seenSentences = new Set<string>();
    for (const sentence of sentences) {
      if (seenSentences.has(sentence)) {
        errors.push(
          `${sub.subsectionId} (${sub.sectionId}): repeated sentence detected — "${sentence.slice(0, 60)}..."`,
        );
        break; // one error per subsection is enough
      }
      seenSentences.add(sentence);
    }

    const repeatedChunk = findRepeatedChunkWithinText(sub.bodyKo, {
      windowChars: 240,
      strideChars: 40,
      minimumRepeatChars: 200,
    });
    if (repeatedChunk) {
      errors.push(
        `${sub.subsectionId} (${sub.sectionId}): repeated long chunk detected — "${repeatedChunk.slice(0, 60)}..."`,
      );
    }
  }

  return errors;
}

function detectBodyKoRepetition(acceptedOutput: GroundedAcceptedOutput): string[] {
  const bodies: Array<{ sectionId: string; subsectionId: string; bodyKo: string }> = [];
  for (const section of acceptedOutput.draft.sections) {
    for (const sub of section.subsections) {
      bodies.push({ sectionId: section.sectionId, subsectionId: sub.subsectionId, bodyKo: sub.bodyKo });
    }
  }
  return detectBodyKoRepetitionInBodies(bodies);
}

/**
 * Detects cross-subsection repeated content in an array of bodies.
 * Reusable for both single-section and full-output validation.
 */
export function detectCrossSubsectionRepetitionInBodies(
  bodies: Array<{ sectionId: string; subsectionId: string; bodyKo: string }>,
): string[] {
  type Occurrence = { sectionId: string; subsectionId: string; chunk: string };
  const occurrencesByHash = new Map<string, Occurrence[]>();

  const bodyEntries: Array<{ sectionId: string; subsectionId: string; body: string }> = [];
  for (const sub of bodies) {
    bodyEntries.push({ sectionId: sub.sectionId, subsectionId: sub.subsectionId, body: sub.bodyKo });
    const chunks = chunkText(sub.bodyKo, { windowChars: 320, strideChars: 60 });
    for (const chunk of chunks) {
      if (chunk.length < 300) {
        continue;
      }

      const canonical = normalizeForRepetition(chunk);
      if (canonical.length < 280) {
        continue;
      }

      const hash = fnv1a32(canonical);
      const list = occurrencesByHash.get(hash) ?? [];
      list.push({ sectionId: sub.sectionId, subsectionId: sub.subsectionId, chunk: canonical });
      occurrencesByHash.set(hash, list);
    }
  }

  const errors: string[] = [];
  for (const list of occurrencesByHash.values()) {
    if (list.length < 2) {
      continue;
    }

    const grouped = new Map<string, Occurrence[]>();
    for (const item of list) {
      const key = item.chunk;
      const bucket = grouped.get(key) ?? [];
      bucket.push(item);
      grouped.set(key, bucket);
    }

    for (const bucket of grouped.values()) {
      if (bucket.length < 2) {
        continue;
      }

      const uniqueSubsections = new Map<string, Occurrence>();
      for (const occ of bucket) {
        uniqueSubsections.set(`${occ.sectionId}:${occ.subsectionId}`, occ);
      }
      if (uniqueSubsections.size < 2) {
        continue;
      }

      const occurrences = Array.from(uniqueSubsections.values()).slice(0, 4);
      const locations = occurrences.map((o) => `${o.subsectionId} (${o.sectionId})`).join(", ");
      const excerpt = bucket[0].chunk.slice(0, 80);
      errors.push(
        `cross-subsection repeated chunk detected in: ${locations} — "${excerpt}..."`,
      );
    }
  }

  // Near-duplicate detection using char-level shingles + Jaccard similarity.
  const shingleSize = 80;
  const shingleStep = 40;
  const minimumCharsForSimilarity = 1800;
  const shingleSets = bodyEntries.map((item) => ({
    ...item,
    shingles: buildShingleSet(item.body, { shingleSize, step: shingleStep, minimumChars: minimumCharsForSimilarity }),
  }));

  for (let i = 0; i < shingleSets.length; i += 1) {
    for (let j = i + 1; j < shingleSets.length; j += 1) {
      const left = shingleSets[i];
      const right = shingleSets[j];

      if (left.shingles.size === 0 || right.shingles.size === 0) {
        continue;
      }

      const similarity = jaccard(left.shingles, right.shingles);
      if (similarity >= 0.9) {
        errors.push(
          `near-duplicate bodyKo detected (${similarity.toFixed(3)} Jaccard): ` +
            `${left.subsectionId} (${left.sectionId}) ↔ ${right.subsectionId} (${right.sectionId})`,
        );
      }
    }
  }

  return errors;
}

function detectCrossSubsectionBodyKoRepetition(acceptedOutput: GroundedAcceptedOutput): string[] {
  const bodies: Array<{ sectionId: string; subsectionId: string; bodyKo: string }> = [];
  for (const section of acceptedOutput.draft.sections) {
    for (const sub of section.subsections) {
      bodies.push({ sectionId: section.sectionId, subsectionId: sub.subsectionId, bodyKo: sub.bodyKo });
    }
  }
  return detectCrossSubsectionRepetitionInBodies(bodies);
}

/**
 * Validates subsection anchoring for a set of entries.
 * Reusable for both single-section and full-output validation.
 */
export function validateSubsectionAnchoringForEntries(
  entries: Array<{ sectionId: string; subsectionId: string; bodyKo: string }>,
  claims: Array<{ claimId: string; sectionId: string; subsectionId: string; citationIds: string[] }>,
  citations: Array<{ citationId: string; repoPath: string }>,
): string[] {
  const errors: string[] = [];

  const citationsById = new Map(
    citations.map((citation) => [citation.citationId, citation] as const),
  );

  const claimsBySubsection = new Map<string, typeof claims>();
  for (const claim of claims) {
    const key = `${claim.sectionId}:${claim.subsectionId}`;
    const list = claimsBySubsection.get(key) ?? [];
    list.push(claim);
    claimsBySubsection.set(key, list);
  }

  for (const sub of entries) {
    const key = `${sub.sectionId}:${sub.subsectionId}`;
    const subClaims = claimsBySubsection.get(key) ?? [];
    if (subClaims.length === 0) {
      errors.push(`${sub.subsectionId} (${sub.sectionId}): missing claim for this subsection`);
      continue;
    }

    const citedIds = new Set<string>();
    for (const claim of subClaims) {
      for (const citationId of claim.citationIds ?? []) {
        citedIds.add(citationId);
      }
    }
    if (citedIds.size === 0) {
      errors.push(`${sub.subsectionId} (${sub.sectionId}): claims exist but cite no citations`);
      continue;
    }

    const body = sub.bodyKo ?? "";
    const citedRepoPaths = Array.from(citedIds)
      .map((id) => citationsById.get(id)?.repoPath)
      .filter((repoPath): repoPath is string => typeof repoPath === "string" && repoPath.trim().length > 0);

    const hasRepoAnchor = citedRepoPaths.some((repoPath) => body.includes(repoPath));
    if (!hasRepoAnchor) {
      errors.push(
        `${sub.subsectionId} (${sub.sectionId}): bodyKo must mention at least one cited repoPath (as a substring)`,
      );
    }
  }

  return errors;
}

function validateSubsectionAnchoring(acceptedOutput: GroundedAcceptedOutput): string[] {
  const entries: Array<{ sectionId: string; subsectionId: string; bodyKo: string }> = [];
  for (const section of acceptedOutput.draft.sections) {
    for (const sub of section.subsections) {
      entries.push({ sectionId: section.sectionId, subsectionId: sub.subsectionId, bodyKo: sub.bodyKo });
    }
  }
  return validateSubsectionAnchoringForEntries(entries, acceptedOutput.draft.claims, acceptedOutput.draft.citations);
}

function splitKoreanSentences(text: string): string[] {
  return normalizeForRepetition(text)
    .split(/[\n\r]+|(?<=[.!?]|다)\s+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeForRepetition(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .replace(/\[deterministic-prompt-hash:[^\]]+\]/g, "")
    .replace(/\[reference:[^\]]+\]/g, "")
    .trim();
}

function chunkText(text: string, input: { windowChars: number; strideChars: number }): string[] {
  const normalized = normalizeForRepetition(text);
  const windowChars = Math.max(50, input.windowChars);
  const strideChars = Math.max(1, input.strideChars);

  if (normalized.length < windowChars) {
    return [];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset + windowChars <= normalized.length; offset += strideChars) {
    chunks.push(normalized.slice(offset, offset + windowChars));
  }
  return chunks;
}

function findRepeatedChunkWithinText(
  text: string,
  input: { windowChars: number; strideChars: number; minimumRepeatChars: number },
): string | null {
  const chunks = chunkText(text, { windowChars: input.windowChars, strideChars: input.strideChars });
  if (chunks.length === 0) {
    return null;
  }

  const seen = new Map<string, number>();
  for (const chunk of chunks) {
    const canonical = normalizeForRepetition(chunk);
    if (canonical.length < input.minimumRepeatChars) {
      continue;
    }
    const hash = fnv1a32(canonical);
    const count = (seen.get(hash) ?? 0) + 1;
    if (count > 1) {
      return canonical;
    }
    seen.set(hash, count);
  }
  return null;
}

function buildShingleSet(
  text: string,
  input: { shingleSize: number; step: number; minimumChars: number },
): Set<string> {
  const normalized = normalizeForRepetition(text);
  if (normalized.length < input.minimumChars) {
    return new Set();
  }
  const shingleSize = Math.max(20, input.shingleSize);
  const step = Math.max(1, input.step);
  if (normalized.length < shingleSize) {
    return new Set();
  }

  const set = new Set<string>();
  for (let offset = 0; offset + shingleSize <= normalized.length; offset += step) {
    const shingle = normalized.slice(offset, offset + shingleSize);
    set.add(fnv1a32(shingle));
  }
  return set;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const DELIVERY_CONTRACT_VERSION = "out-04.v1" as const;

export interface PackageDeliveryOptions {
  generatedAt?: string;
  modelId?: string;
  qualityGateLevel?: QualityGateLevel;
}

export interface DeliveryPackagingResult {
  artifacts: DeliveryArtifactEnvelope[];
  summary: {
    attempted: number;
    packaged: number;
    blocked: number;
  };
}

export function packageAcceptedOutputsForDelivery(
  acceptedOutputs: GroundedAcceptedOutput[],
  options: PackageDeliveryOptions = {},
): DeliveryPackagingResult {
  const sortedOutputs = acceptedOutputs
    .slice()
    .sort((left, right) => compareAcceptedOutputs(left, right));

  const artifacts: DeliveryArtifactEnvelope[] = [];
  const failures: string[] = [];

  for (const acceptedOutput of sortedOutputs) {
    try {
      const qualityGateLevel = options.qualityGateLevel ?? "standard";
      const normalizedAcceptedOutput = normalizeAcceptedOutputForPackaging(acceptedOutput);
      const legacyCitationSourcePathCount = new Set(
        normalizedAcceptedOutput.draft.citations.map((citation) => citation.repoPath),
      ).size;
      const sourceDocCount =
        normalizedAcceptedOutput.source_doc_count ??
        normalizedAcceptedOutput.draft.sourceDocs?.length ??
        legacyCitationSourcePathCount;
      const trendFactCount =
        normalizedAcceptedOutput.trend_fact_count ?? normalizedAcceptedOutput.draft.trendFacts?.length ?? 0;

      const repetitionErrors = detectBodyKoRepetition(normalizedAcceptedOutput);
      if (repetitionErrors.length > 0) {
        throw new Error(
          `OUT-04 validation failed: bodyKo repetition detected (${repetitionErrors.length} subsection(s)):\n` +
            repetitionErrors.map((e) => `  - ${e}`).join("\n") +
            "\n  Do not repeat sentences to pad character count. Write unique content for each subsection.",
        );
      }

      const crossRepetitionErrors = detectCrossSubsectionBodyKoRepetition(normalizedAcceptedOutput);
      if (crossRepetitionErrors.length > 0) {
        throw new Error(
          `OUT-04 validation failed: cross-subsection bodyKo repetition detected (${crossRepetitionErrors.length} finding(s)):\n` +
            crossRepetitionErrors.map((e) => `  - ${e}`).join("\n") +
            "\n  Do not paste the same long padding block into multiple subsections.",
        );
      }

      if (qualityGateLevel === "strict" && sourceDocCount <= 0) {
        throw new Error("strict quality gate failed: source_doc_count must be greater than 0");
      }

      const qualityScorecard = buildQualityScorecard(normalizedAcceptedOutput);

      const delivery = adaptAcceptedOutputToDelivery(normalizedAcceptedOutput, {
        generatedAt: options.generatedAt,
        modelId: options.modelId,
      });

      const envelope = assertValidDeliveryEnvelope({
        contractVersion: DELIVERY_CONTRACT_VERSION,
        project: {
          repoRef: acceptedOutput.repo_ref,
          commitSha: acceptedOutput.commit_sha,
          ingestRunId: acceptedOutput.ingest_run_id,
        },
        sections: delivery.sections,
        provenance: delivery.metadata.provenance,
        glossary: buildGlossaryFromAcceptedOutput(normalizedAcceptedOutput),
        source: {
          ingestRunId: normalizedAcceptedOutput.ingest_run_id,
          sourceDocCount,
          trendFactCount,
        },
        metadata: {
          generatedAt: delivery.metadata.generatedAt,
          deterministicOrdering: {
            sections: delivery.metadata.deterministicOrdering.sections,
            subsections: delivery.metadata.deterministicOrdering.subsections,
            glossary: "termEn:asc,termKo:asc",
          },
          sourceArtifactType: delivery.metadata.sourceArtifactType,
          qualityScorecard,
        },
      });

      artifacts.push(envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${acceptedOutput.repo_ref}@${acceptedOutput.commit_sha.slice(0, 12)}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `OUT-04 packaging blocked (${failures.length}/${sortedOutputs.length}): ${failures.join(" | ")}`,
    );
  }

  return {
    artifacts,
    summary: {
      attempted: sortedOutputs.length,
      packaged: artifacts.length,
      blocked: sortedOutputs.length - artifacts.length,
    },
  };
}

function normalizeAcceptedOutputForPackaging(acceptedOutput: GroundedAcceptedOutput): GroundedAcceptedOutput {
  return {
    ...acceptedOutput,
    draft: {
      ...acceptedOutput.draft,
      claims: acceptedOutput.draft.claims ?? [],
      citations: acceptedOutput.draft.citations ?? [],
      trendFacts: acceptedOutput.draft.trendFacts ?? [],
    },
  };
}

function compareAcceptedOutputs(left: GroundedAcceptedOutput, right: GroundedAcceptedOutput): number {
  const leftKey = `${left.repo_ref.toLowerCase()}|${left.commit_sha.toLowerCase()}|${left.ingest_run_id}`;
  const rightKey = `${right.repo_ref.toLowerCase()}|${right.commit_sha.toLowerCase()}|${right.ingest_run_id}`;
  return leftKey.localeCompare(rightKey, "en", { sensitivity: "base", numeric: true });
}
