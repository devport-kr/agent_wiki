import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  GitHubReleaseSummary,
  GitHubResolver,
  GitHubTagSummary,
} from "./github";
import type { ParsedRepoRef } from "./ref";

const MANIFEST_FILE_NAME = "snapshot-manifest.json";
const TRENDS_DIR = "__devport__/trends";
const DEFAULT_TREND_WINDOW_DAYS = 180;
const MAX_RELEASE_ITEMS = 120;
const MAX_TAG_ITEMS = 120;

interface SnapshotManifestLike {
  repo_full_name: string;
  owner: string;
  repo: string;
  commit_sha: string;
  resolved_ref: string;
  source_ref: string;
  source_default_branch: string;
  file_count: number;
  total_bytes: number;
  manifest_signature: string;
  created_at: string;
}

interface ManifestFileEntry {
  path: string;
  bytes: number;
  hash: string;
}

export interface TrendArtifactsResult {
  window_days: number;
  releases_path: string;
  tags_path: string;
  changelog_summary_path: string;
  release_count: number;
  tag_count: number;
  manifest_signature: string;
}

interface PersistTrendArtifactsInput {
  snapshotPath: string;
  repo: ParsedRepoRef;
  resolver: GitHubResolver;
  commitSha: string;
  now?: () => string;
  trendWindowDays?: number;
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function normalizeWindowDays(raw: unknown): number {
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_TREND_WINDOW_DAYS;
  }

  return Math.max(1, Math.min(3650, Math.floor(numeric)));
}

function cutoffIso(now: string, windowDays: number): string {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) {
    return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  }

  return new Date(timestamp - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

async function collectReleases(
  repo: ParsedRepoRef,
  resolver: GitHubResolver,
  since: string,
): Promise<GitHubReleaseSummary[]> {
  if (typeof resolver.getRepositoryReleases !== "function") {
    return [];
  }

  try {
    const releases = await resolver.getRepositoryReleases(repo, {
      since,
      per_page: 100,
      max_items: MAX_RELEASE_ITEMS,
    });

    return (releases ?? [])
      .filter((release) => {
        const publishedAt = release.published_at ?? "";
        return publishedAt.length === 0 || publishedAt >= since;
      })
      .sort((left, right) => {
        const leftPublished = left.published_at ?? "";
        const rightPublished = right.published_at ?? "";
        const byPublishedDesc = rightPublished.localeCompare(leftPublished);
        if (byPublishedDesc !== 0) {
          return byPublishedDesc;
        }
        return (left.tag_name ?? "").localeCompare(right.tag_name ?? "", "en", {
          numeric: true,
          sensitivity: "base",
        });
      })
      .slice(0, MAX_RELEASE_ITEMS);
  } catch {
    return [];
  }
}

async function collectTags(repo: ParsedRepoRef, resolver: GitHubResolver): Promise<GitHubTagSummary[]> {
  if (typeof resolver.getRepositoryTags !== "function") {
    return [];
  }

  try {
    const tags = await resolver.getRepositoryTags(repo, {
      per_page: 100,
      max_items: MAX_TAG_ITEMS,
    });

    return (tags ?? [])
      .sort((left, right) =>
        left.name.localeCompare(right.name, "en", {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .slice(0, MAX_TAG_ITEMS);
  } catch {
    return [];
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readSnapshotManifest(snapshotPath: string): Promise<SnapshotManifestLike> {
  const manifestPath = path.join(snapshotPath, MANIFEST_FILE_NAME);
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw) as SnapshotManifestLike;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha1").update(content).digest("hex");
}

async function walkSnapshotFiles(
  rootPath: string,
  relativeDir: string,
  entries: ManifestFileEntry[],
): Promise<void> {
  const absoluteDir = path.join(rootPath, relativeDir);
  const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
  const sorted = dirents.sort((left, right) => left.name.localeCompare(right.name));

  for (const dirent of sorted) {
    if (dirent.isSymbolicLink()) {
      continue;
    }

    const nextRelative = normalizePath(path.join(relativeDir, dirent.name));
    if (nextRelative === ".git" || nextRelative.startsWith(".git/")) {
      continue;
    }

    if (path.basename(nextRelative) === MANIFEST_FILE_NAME) {
      continue;
    }

    if (dirent.isDirectory()) {
      await walkSnapshotFiles(rootPath, nextRelative, entries);
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    const absoluteFile = path.join(rootPath, nextRelative);
    const stat = await fs.stat(absoluteFile);
    entries.push({
      path: nextRelative,
      bytes: stat.size,
      hash: await hashFile(absoluteFile),
    });
  }
}

function buildManifestSignature(entries: ManifestFileEntry[]): string {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha1");

  for (const entry of sorted) {
    hash.update(`${entry.path}:`);
    hash.update(String(entry.bytes));
    hash.update(`:${entry.hash}`);
    hash.update("\n");
  }

  return hash.digest("hex");
}

async function refreshSnapshotManifest(snapshotPath: string): Promise<string> {
  const manifestPath = path.join(snapshotPath, MANIFEST_FILE_NAME);
  const manifest = await readSnapshotManifest(snapshotPath);
  const entries: ManifestFileEntry[] = [];

  await walkSnapshotFiles(snapshotPath, ".", entries);

  const manifestSignature = buildManifestSignature(entries);
  const fileCount = entries.length;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  const updatedManifest: SnapshotManifestLike = {
    ...manifest,
    file_count: fileCount,
    total_bytes: totalBytes,
    manifest_signature: manifestSignature,
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");
  return manifestSignature;
}

export async function persistTrendArtifacts(input: PersistTrendArtifactsInput): Promise<TrendArtifactsResult> {
  const now = (input.now ?? (() => new Date().toISOString()))();
  const windowDays = normalizeWindowDays(
    input.trendWindowDays ?? process.env.DEVPORT_TREND_WINDOW_DAYS,
  );
  const since = cutoffIso(now, windowDays);

  const releases = await collectReleases(input.repo, input.resolver, since);
  const tags = await collectTags(input.repo, input.resolver);

  const trendDir = path.join(input.snapshotPath, TRENDS_DIR);
  const releasesPath = path.join(trendDir, "releases.json");
  const tagsPath = path.join(trendDir, "tags.json");
  const changelogSummaryPath = path.join(trendDir, "changelog-summary.json");

  await writeJsonFile(releasesPath, {
    repo_ref: input.repo.repo_full_name,
    commit_sha: input.commitSha,
    window_days: windowDays,
    since,
    releases,
  });

  await writeJsonFile(tagsPath, {
    repo_ref: input.repo.repo_full_name,
    commit_sha: input.commitSha,
    window_days: windowDays,
    tags,
  });

  await writeJsonFile(changelogSummaryPath, {
    repo_ref: input.repo.repo_full_name,
    commit_sha: input.commitSha,
    window_days: windowDays,
    release_count: releases.length,
    tag_count: tags.length,
    latest_release_tags: releases.slice(0, 10).map((release) => release.tag_name),
    latest_tags: tags.slice(0, 10).map((tag) => tag.name),
  });

  const manifestSignature = await refreshSnapshotManifest(input.snapshotPath);

  return {
    window_days: windowDays,
    releases_path: normalizePath(path.relative(input.snapshotPath, releasesPath)),
    tags_path: normalizePath(path.relative(input.snapshotPath, tagsPath)),
    changelog_summary_path: normalizePath(path.relative(input.snapshotPath, changelogSummaryPath)),
    release_count: releases.length,
    tag_count: tags.length,
    manifest_signature: manifestSignature,
  };
}
