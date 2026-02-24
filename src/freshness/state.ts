import { promises as fs } from "node:fs";
import path from "node:path";

import { parseRepoRef } from "../ingestion/ref";
import {
  FreshnessBaselineSchema,
  FreshnessStateFileSchema,
  type FreshnessBaseline,
  type FreshnessStateFile,
} from "../contracts/wiki-freshness";

const EMPTY_STATE: FreshnessStateFile = {
  schema_version: 1,
  repos: {},
};

export function normalizeFreshnessRepoRef(repoRef: string): string {
  const parsed = parseRepoRef(repoRef);
  if (parsed.requested_ref !== null) {
    throw new Error("freshness baseline repo_ref must not include @ref");
  }
  return parsed.repo_full_name;
}

function normalizePathList(paths: string[]): string[] {
  const unique = new Set(paths.map((entry) => entry.trim()));
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function canonicalizeBaseline(input: FreshnessBaseline): FreshnessBaseline {
  const parsed = FreshnessBaselineSchema.parse({
    ...input,
    repo_ref: normalizeFreshnessRepoRef(input.repo_ref),
    last_delivery_commit: input.last_delivery_commit.toLowerCase(),
    sectionEvidenceIndex: input.sectionEvidenceIndex.map((section) => ({
      sectionId: section.sectionId.trim(),
      repoPaths: normalizePathList(section.repoPaths),
    })),
  });

  const sections = [...parsed.sectionEvidenceIndex].sort((left, right) => {
    const sectionOrder = left.sectionId.localeCompare(right.sectionId);
    if (sectionOrder !== 0) {
      return sectionOrder;
    }
    const leftSig = left.repoPaths.join("\n");
    const rightSig = right.repoPaths.join("\n");
    return leftSig.localeCompare(rightSig);
  });

  return {
    ...parsed,
    sectionEvidenceIndex: sections,
  };
}

function canonicalizeState(input: FreshnessStateFile): FreshnessStateFile {
  const parsed = FreshnessStateFileSchema.parse(input);
  const sortedRepoKeys = Object.keys(parsed.repos).sort((left, right) => left.localeCompare(right));

  const repos: Record<string, FreshnessBaseline> = {};
  for (const repoKey of sortedRepoKeys) {
    const normalizedRepo = normalizeFreshnessRepoRef(repoKey);
    repos[normalizedRepo] = canonicalizeBaseline(parsed.repos[repoKey]);
  }

  return {
    schema_version: 1,
    repos,
  };
}

export function parseFreshnessState(raw: string): FreshnessStateFile {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Invalid freshness state JSON payload");
  }

  try {
    return canonicalizeState(payload as FreshnessStateFile);
  } catch {
    throw new Error("Invalid freshness state schema");
  }
}

export async function loadFreshnessState(statePath: string): Promise<FreshnessStateFile> {
  const absolute = path.resolve(statePath);
  let raw: string;

  try {
    raw = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STATE;
    }
    throw error;
  }

  return parseFreshnessState(raw);
}

export function serializeFreshnessState(state: FreshnessStateFile): string {
  const canonical = canonicalizeState(state);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export async function saveFreshnessState(statePath: string, state: FreshnessStateFile): Promise<void> {
  const absolute = path.resolve(statePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, serializeFreshnessState(state), "utf8");
}
