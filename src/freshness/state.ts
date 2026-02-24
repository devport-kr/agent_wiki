import { promises as fs } from "node:fs";
import path from "node:path";

import { parseRepoRef } from "../ingestion/ref";
import type { S3JsonAdapter } from "../shared/s3-storage";
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

export async function loadFreshnessState(
  statePath: string,
  s3?: { adapter: S3JsonAdapter; key: string; exclusive?: boolean },
): Promise<FreshnessStateFile> {
  if (s3) {
    try {
      const remote = await s3.adapter.readJson(s3.key);
      if (remote !== null) {
        try {
          return canonicalizeState(remote as FreshnessStateFile);
        } catch {
          if (s3.exclusive) return EMPTY_STATE;
          // fall through to local
        }
      } else if (s3.exclusive) {
        return EMPTY_STATE;
      }
    } catch (err) {
      process.stderr.write(`[s3] warning: loadFreshnessState from S3 failed: ${String(err)}\n`);
      if (s3.exclusive) return EMPTY_STATE;
    }
  }

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

export async function saveFreshnessState(
  statePath: string,
  state: FreshnessStateFile,
  s3?: { adapter: S3JsonAdapter; key: string; exclusive?: boolean },
): Promise<void> {
  if (!s3?.exclusive) {
    const absolute = path.resolve(statePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, serializeFreshnessState(state), "utf8");
  }

  if (s3) {
    try {
      await s3.adapter.writeJson(s3.key, canonicalizeState(state));
    } catch (err) {
      process.stderr.write(`[s3] warning: saveFreshnessState to S3 failed: ${String(err)}\n`);
      if (s3.exclusive) throw err; // re-throw in pure S3 mode — local wasn't written either
    }
  }
}
