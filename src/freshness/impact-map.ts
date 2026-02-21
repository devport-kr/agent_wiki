import type { FreshnessBaseline } from "../contracts/wiki-freshness";

export type ImpactMappingMode = "impact-mapped" | "full-rebuild-required";

export interface SectionImpactMappingInput {
  changed_paths: string[];
  sectionEvidenceIndex: FreshnessBaseline["sectionEvidenceIndex"];
}

export interface SectionImpactMappingResult {
  mode: ImpactMappingMode;
  impacted_section_ids: string[];
  unmatched_changed_paths: string[];
}

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function compareDeterministic(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function toOrderedUniquePaths(paths: string[]): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRepoPath(path);
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }
  return [...unique].sort(compareDeterministic);
}

export function mapChangedPathsToImpactedSections(input: SectionImpactMappingInput): SectionImpactMappingResult {
  const changedPaths = toOrderedUniquePaths(input.changed_paths);
  if (changedPaths.length === 0) {
    return {
      mode: "impact-mapped",
      impacted_section_ids: [],
      unmatched_changed_paths: [],
    };
  }

  const matchedPaths = new Set<string>();
  const impacted = new Set<string>();

  const normalizedSectionPaths = input.sectionEvidenceIndex.map((section) => ({
    sectionId: section.sectionId,
    repoPaths: new Set(toOrderedUniquePaths(section.repoPaths)),
  }));

  for (const section of normalizedSectionPaths) {
    const sectionPaths = section.repoPaths;
    for (const path of changedPaths) {
      if (sectionPaths.has(path)) {
        impacted.add(section.sectionId);
        matchedPaths.add(path);
      }
    }
  }

  const impacted_section_ids = [...impacted].sort(compareDeterministic);
  const unmatched_changed_paths = changedPaths.filter((path) => !matchedPaths.has(path));

  if (impacted_section_ids.length === 0) {
    return {
      mode: "full-rebuild-required",
      impacted_section_ids,
      unmatched_changed_paths,
    };
  }

  return {
    mode: "impact-mapped",
    impacted_section_ids,
    unmatched_changed_paths,
  };
}
