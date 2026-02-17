import type { RepoCandidate } from "./types";

const LICENSE_PENALTIES: Record<string, number> = {
  gpl: 0.0,
  agpl: 0.0,
  sspl: 0.0,
  lgpl: 0.0,
};

const MAX_SCORE_ROUNDING = 6;
const QUALITY_REFERENCE_ISO = "2026-02-17T00:00:00.000Z";

function deterministicHash(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function resolveReferenceDate(referenceDate?: string): string {
  return referenceDate || QUALITY_REFERENCE_ISO;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getQualityComponents(candidate: {
  stars: number;
  pushed_at: string;
  updated_at: string;
  license: string | null;
  topics: string[];
  source_category: string;
  quality_reference_iso?: string;
}) {
  const nowMs = Date.parse(resolveReferenceDate(candidate.quality_reference_iso));
  const pushedMs = Date.parse(candidate.pushed_at);
  const updatedMs = Date.parse(candidate.updated_at);
  const ageDays = Math.max(0, (nowMs - pushedMs) / 86400000);
  const recencyDays = Math.max(0, (nowMs - updatedMs) / 86400000);

  const starScore = clamp01(Math.log(candidate.stars + 1) / Math.log(1 + 1_000_000));
  const pushScore = clamp01(1 - ageDays / 365);
  const updateScore = clamp01(1 - recencyDays / 730);

  const hasCategoryTopic = candidate.source_category ? 1 : 0;
  const topicScore = candidate.topics.length > 0 ? Math.min(1, candidate.topics.length / 5) : 0;
  const license = (candidate.license || "").toLowerCase();
  const licenseScore = LICENSE_PENALTIES[license] === 0 ? 0 : 1;

  const qualityBase =
    starScore * 40 +
    pushScore * 25 +
    updateScore * 15 +
    topicScore * 10 +
    licenseScore * 5 +
    hasCategoryTopic * 5;

  const tieBreaker = deterministicHash(`${candidate.source_category}::${candidate.full_name}`);
  const normalizedTie = (tieBreaker % 1_000) / 1_000;

  return {
    starScore,
    pushScore,
    updateScore,
    hasCategoryTopic,
    topicScore,
    licenseScore,
    qualityBase,
    normalizedTie,
  };
}

export function calculateQualityScore(candidate: {
  full_name: string;
  stars: number;
  pushed_at: string;
  updated_at: string;
  license: string | null;
  topics: string[];
  source_category: string;
  quality_reference_iso?: string;
}): number {
  const components = getQualityComponents(candidate);
  const total = components.qualityBase + components.normalizedTie;
  return Number(total.toFixed(MAX_SCORE_ROUNDING));
}

export function normalizeCandidateScore(candidate: RepoCandidate): RepoCandidate {
  const quality_score = calculateQualityScore(candidate);
  return {
    ...candidate,
    quality_score,
  };
}

export function rankCandidates(candidates: RepoCandidate[]): RepoCandidate[] {
  return [...candidates].sort((left, right) => {
    const delta = right.quality_score - left.quality_score;
    if (delta !== 0) {
      return delta;
    }

    return left.full_name.localeCompare(right.full_name);
  });
}
