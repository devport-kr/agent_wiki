import type { GroundedAcceptedOutput } from "../contracts/grounded-output";
import type { FreshnessBaseline } from "../contracts/wiki-freshness";

function compareDeterministic(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function buildSectionEvidenceFromAcceptedOutput(
  acceptedOutput: GroundedAcceptedOutput,
  sectionIds?: string[],
): FreshnessBaseline["sectionEvidenceIndex"] {
  const allowed =
    sectionIds && sectionIds.length > 0
      ? new Set(sectionIds.map((sectionId) => sectionId.trim()).filter(Boolean).sort(compareDeterministic))
      : undefined;

  const claims = acceptedOutput.draft.claims ?? [];
  const citations = acceptedOutput.draft.citations ?? [];
  const citationById = new Map(citations.map((citation) => [citation.citationId, citation]));
  const pathsBySection = new Map<string, Set<string>>();

  for (const section of acceptedOutput.draft.sections) {
    const sectionId = section.sectionId.trim();
    if (!sectionId || (allowed && !allowed.has(sectionId))) {
      continue;
    }

    const sectionPaths = pathsBySection.get(sectionId) ?? new Set<string>();

    const directSourcePaths = (section as unknown as { sourcePaths?: string[] }).sourcePaths ?? [];
    for (const sourcePath of directSourcePaths) {
      const normalized = normalizeRepoPath(sourcePath);
      if (normalized.length > 0) {
        sectionPaths.add(normalized);
      }
    }

    if (sectionPaths.size === 0 && claims.length > 0 && citations.length > 0) {
      const claimSourcePaths = claims
        .filter((claim) => claim.sectionId.trim() === sectionId)
        .flatMap((claim) => claim.citationIds)
        .map((citationId) => citationById.get(citationId)?.repoPath ?? "")
        .map((repoPath) => normalizeRepoPath(repoPath))
        .filter((repoPath) => repoPath.length > 0);

      for (const repoPath of claimSourcePaths) {
        sectionPaths.add(repoPath);
      }
    }

    if (sectionPaths.size > 0) {
      pathsBySection.set(sectionId, sectionPaths);
    }
  }

  const sectionIdsToEmit = allowed
    ? [...allowed].sort(compareDeterministic)
    : [...new Set(acceptedOutput.draft.sections.map((section) => section.sectionId.trim()).filter(Boolean))].sort(
        compareDeterministic,
      );

  return sectionIdsToEmit.map((sectionId) => {
    const sectionPaths = pathsBySection.get(sectionId);
    if (!sectionPaths || sectionPaths.size === 0) {
      throw new Error(`UPDT-02 regeneration blocked: missing section evidence paths (${sectionId})`);
    }

    return {
      sectionId,
      repoPaths: [...sectionPaths].sort(compareDeterministic),
    };
  });
}

export function extractSectionEvidenceFromAcceptedOutput(
  acceptedOutput: GroundedAcceptedOutput,
  sectionIds?: string[],
): FreshnessBaseline["sectionEvidenceIndex"] {
  return buildSectionEvidenceFromAcceptedOutput(acceptedOutput, sectionIds);
}
