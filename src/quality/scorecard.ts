import type { GroundedAcceptedOutput } from "../contracts/grounded-output";
import { QualityScorecardSchema, type QualityScorecard } from "../contracts/wiki-generation";

const LOW_SIGNAL_PATH_PATTERN = /(\/|^)(readme|license|changelog)(\.|$)|^docs\/vendor\//i;

export function buildQualityScorecard(
  acceptedOutput: GroundedAcceptedOutput,
): QualityScorecard {
  const draft = acceptedOutput.draft;
  const claims = draft.claims ?? [];
  const citations = draft.citations ?? [];
  const trendFacts = draft.trendFacts ?? [];

  const subsectionEntries = draft.sections.flatMap((section) =>
    section.subsections.map((subsection) => ({
      sectionId: section.sectionId,
      subsectionId: subsection.subsectionId,
      bodyKo: subsection.bodyKo,
    })),
  );

  const totalClaims = Math.max(1, claims.length);
  const totalCitations = Math.max(1, citations.length);
  const totalSubsections = Math.max(1, subsectionEntries.length);

  const readabilityScore = calculateReadabilityScore(subsectionEntries.map((entry) => entry.bodyKo));

  const semanticFaithfulness = readabilityScore;

  const averageBodyChars =
    subsectionEntries.reduce((sum, subsection) => sum + subsection.bodyKo.length, 0) / totalSubsections;
  const conceptualDepth = clamp01(averageBodyChars / 3200);

  const citationsById = new Map(citations.map((citation) => [citation.citationId, citation] as const));
  const claimsBySubsection = new Map<string, typeof claims>();
  for (const claim of claims) {
    const key = `${claim.sectionId}:${claim.subsectionId}`;
    const list = claimsBySubsection.get(key) ?? [];
    list.push(claim);
    claimsBySubsection.set(key, list);
  }

  let anchoredSubsectionCount = 0;
  for (const subsection of subsectionEntries) {
    const key = `${subsection.sectionId}:${subsection.subsectionId}`;
    const claims = claimsBySubsection.get(key) ?? [];
    const citedPaths = claims
      .flatMap((claim) => claim.citationIds)
      .map((citationId) => citationsById.get(citationId)?.repoPath)
      .filter((repoPath): repoPath is string => Boolean(repoPath));
    if (citedPaths.some((repoPath) => subsection.bodyKo.includes(repoPath))) {
      anchoredSubsectionCount += 1;
    }
  }
  const operationalClarity = clamp01(anchoredSubsectionCount / totalSubsections);

  const lowSignalCitationCount = citations.filter((citation) =>
    LOW_SIGNAL_PATH_PATTERN.test(citation.repoPath),
  ).length;
  const trendMentionCount = subsectionEntries.filter((entry) => /트렌드|릴리스|release|tag|changelog/iu.test(entry.bodyKo)).length;
  const trendCoverage = clamp01(
    (trendFacts.length > 0 ? 0.5 : 0) +
      (trendMentionCount / totalSubsections) * 0.5,
  );
  const citationQuality = clamp01(1 - lowSignalCitationCount / totalCitations);

  const canonicalBodies = subsectionEntries.map((subsection) =>
    subsection.bodyKo
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .replace(/[.,:;!?()\[\]{}"'`-]/g, "")
      .trim(),
  );
  const uniqueBodyRatio = new Set(canonicalBodies).size / totalSubsections;
  const novelty = clamp01(uniqueBodyRatio * 0.7 + trendCoverage * 0.3);

  return QualityScorecardSchema.parse({
    semanticFaithfulness: round4(semanticFaithfulness),
    conceptualDepth: round4(conceptualDepth),
    operationalClarity: round4(operationalClarity),
    citationQuality: round4((citationQuality + trendCoverage) / 2),
    novelty: round4(novelty),
  });
}

function calculateReadabilityScore(bodies: string[]): number {
  if (bodies.length === 0) {
    return 0;
  }

  const scores = bodies.map((body) => {
    const normalized = body.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      return 0;
    }

    const sentenceCount = Math.max(1, normalized.split(/[.!?]|다\s+/u).filter((part) => part.trim().length > 0).length);
    const averageSentenceLength = normalized.length / sentenceCount;

    const sentenceBandScore = clamp01(1 - Math.abs(averageSentenceLength - 95) / 95);
    const hasPathLikeToken = /[a-z0-9_.-]+\/[a-z0-9_.-]+/i.test(normalized) ? 1 : 0.5;
    return clamp01(sentenceBandScore * 0.7 + hasPathLikeToken * 0.3);
  });

  return clamp01(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
