import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { formatIngestKey } from "./ref";

const MANIFEST_FILE_NAME = "snapshot-manifest.json";
const GIT_DIRECTORY = ".git";

export interface RepoManifestFileEntry {
  path: string;
  bytes: number;
  hash: string;
}

export interface SnapshotManifestSource {
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

interface GitShell {
  materialize({
    repoFullName,
    commitSha,
    snapshotPath,
  }: {
    repoFullName: string;
    commitSha: string;
    snapshotPath: string;
  }): Promise<void>;
}

interface RepoSnapshotManagerConfig {
  snapshotRoot: string;
  now?: () => string;
  forceRebuild?: boolean;
  sourcePath?: string;
  gitShell?: GitShell;
}

interface RepoSnapshotRequest {
  repoFullName: string;
  owner: string;
  repo: string;
  commitSha: string;
  resolvedRef: string;
  sourceRef: string | null;
  sourceDefaultBranch: string;
}

export interface RepoSnapshotResult {
  snapshotPath: string;
  snapshotId: string;
  manifest: SnapshotManifestSource;
  idempotentHit: boolean;
}

function safeNow(now: () => string = () => new Date().toISOString()): string {
  return now();
}

function normalizeRelativePath(raw: string): string {
  return path
    .relative(".", raw)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function isManifestFile(entryPath: string): boolean {
  return path.basename(entryPath) === MANIFEST_FILE_NAME;
}

function sortEntries(entries: RepoManifestFileEntry[]): RepoManifestFileEntry[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}

function hashFile(filePath: string): Promise<string> {
  return fs.readFile(filePath).then((content) => {
    return createHash("sha1")
      .update(content)
      .digest("hex");
  });
}

async function walkFiles(root: string, current: string, entries: RepoManifestFileEntry[]): Promise<void> {
  const absolute = path.join(root, current);
  const normalizedCurrent = normalizeRelativePath(current);

  if (isManifestFile(normalizedCurrent)) {
    return;
  }

  const stat = await fs.lstat(absolute);

  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isDirectory()) {
    if (normalizedCurrent === GIT_DIRECTORY) {
      return;
    }

    if (path.basename(absolute) === GIT_DIRECTORY) {
      return;
    }

    const items = await fs.readdir(absolute, { withFileTypes: true });
    const sorted = items.sort((left, right) => left.name.localeCompare(right.name));

    for (const item of sorted) {
      if (item.name === GIT_DIRECTORY) {
        continue;
      }

      if (item.isDirectory()) {
        await walkFiles(root, path.join(current, item.name), entries);
        continue;
      }

      if (item.isFile()) {
        const fileAbsolute = path.join(root, current, item.name);
        const fileStat = await fs.stat(fileAbsolute);
        entries.push({
          path: normalizeRelativePath(path.join(current, item.name)),
          bytes: fileStat.size,
          hash: await hashFile(fileAbsolute),
        });
      }
    }

    return;
  }

  if (stat.isFile()) {
    entries.push({
      path: path.relative(root, absolute).replace(/\\/g, "/"),
      bytes: stat.size,
      hash: await hashFile(absolute),
    });
  }
}

function manifestDigest(entries: RepoManifestFileEntry[]): string {
  const normalized = sortEntries(entries);

  const hash = createHash("sha1");
  for (const entry of normalized) {
    hash.update(`${entry.path}:`);
    hash.update(String(entry.bytes));
    hash.update(`:${entry.hash}`);
    hash.update("\n");
  }

  return hash.digest("hex");
}

async function runGitCommand(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const processRef = spawn("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });

    processRef.once("error", reject);
    processRef.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`git command failed: git ${args.join(" ")}`));
    });
  });
}

const defaultGitShell: GitShell = {
  async materialize({ repoFullName, commitSha, snapshotPath }) {
    const repoUrl = `https://github.com/${repoFullName}.git`;
    await runGitCommand(["clone", "--quiet", repoUrl, snapshotPath], process.cwd());
    await runGitCommand(["checkout", "--quiet", "--detach", commitSha], snapshotPath);
  },
};

export class LocalSourceShell implements GitShell {
  constructor(private readonly sourcePath: string) {}

  async materialize({ snapshotPath }: { repoFullName: string; commitSha: string; snapshotPath: string }): Promise<void> {
    await fs.rm(snapshotPath, { recursive: true, force: true });
    await fs.cp(this.sourcePath, snapshotPath, { recursive: true, force: true });
  }
}

async function readManifest(snapshotPath: string): Promise<SnapshotManifestSource | null> {
  const manifestPath = path.join(snapshotPath, MANIFEST_FILE_NAME);
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as SnapshotManifestSource;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  }
}

async function buildManifest(
  request: RepoSnapshotRequest,
  now: () => string,
  snapshotPath: string,
): Promise<SnapshotManifestSource> {
  const files: RepoManifestFileEntry[] = [];
  await walkFiles(snapshotPath, ".", files);

  const filtered = files.filter((entry) => !isManifestFile(entry.path));
  const signature = manifestDigest(filtered);

  const fileCount = filtered.length;
  const totalBytes = filtered.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    repo_full_name: request.repoFullName,
    owner: request.owner,
    repo: request.repo,
    commit_sha: request.commitSha,
    resolved_ref: request.resolvedRef,
    source_ref: request.sourceRef || request.resolvedRef,
    source_default_branch: request.sourceDefaultBranch,
    file_count: fileCount,
    total_bytes: totalBytes,
    manifest_signature: signature,
    created_at: now(),
  };
}

export class RepoSnapshotManager {
  private readonly now: () => string;
  private readonly forceRebuild: boolean;
  private readonly rootPath: string;
  private readonly gitShell: GitShell;

  constructor(private readonly config: RepoSnapshotManagerConfig) {
    this.now = config.now || (() => new Date().toISOString());
    this.forceRebuild = Boolean(config.forceRebuild);
    this.rootPath = path.resolve(config.snapshotRoot || "devport-output/snapshots");
    this.gitShell =
      config.gitShell ||
      (config.sourcePath
        ? new LocalSourceShell(config.sourcePath)
        : defaultGitShell);
  }

  async createSnapshot(request: RepoSnapshotRequest): Promise<RepoSnapshotResult> {
    const snapshotId = formatIngestKey({
      owner: request.owner,
      repo: request.repo,
      commitSha: request.commitSha,
    });
    const snapshotPath = path.join(this.rootPath, request.owner, request.repo, snapshotId);
    const manifestPath = path.join(snapshotPath, MANIFEST_FILE_NAME);

    const existing = existsSync(snapshotPath) ? await readManifest(snapshotPath) : null;

    if (!this.forceRebuild && existing) {
      const files: RepoManifestFileEntry[] = [];
      await walkFiles(snapshotPath, ".", files);
      const filtered = files.filter((entry) => !isManifestFile(entry.path));
      const currentSignature = manifestDigest(filtered);

      if (existing.commit_sha === request.commitSha && existing.manifest_signature === currentSignature) {
        return {
          snapshotPath,
          snapshotId,
          manifest: existing,
          idempotentHit: true,
        };
      }
    }

    await fs.rm(snapshotPath, { recursive: true, force: true });
    await this.gitShell.materialize({
      repoFullName: request.repoFullName,
      commitSha: request.commitSha,
      snapshotPath,
    });

    const manifest = await buildManifest(request, this.now, snapshotPath);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return {
      snapshotPath,
      snapshotId,
      manifest,
      idempotentHit: false,
    };
  }
}

export type { RepoSnapshotManagerConfig, RepoSnapshotRequest };
