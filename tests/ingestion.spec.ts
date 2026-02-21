import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { IngestResolverError, resolveToCommitSha } from "../src/ingestion/github";
import type { GitHubResolver } from "../src/ingestion/github";
import { RepoSnapshotManager } from "../src/ingestion/snapshot";
import { extractMetadata } from "../src/ingestion/metadata";
import { formatIngestKey, inferRefType, isLikelyCommitSha, normalizeRef, parseRepoRef } from "../src/ingestion/ref";
import { runIngest } from "../src/ingestion/run";

const LONG_SHA_A = "0123456789abcdef0123456789abcdef01234567";
const LONG_SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

class StubResolver implements GitHubResolver {
  constructor(
    private readonly defaultBranch: string,
    private readonly branchToCommit: Record<string, string>,
    private readonly languages: Record<string, number> | null = null,
  ) {}

  async getRepositoryMeta() {
    return {
      owner: "acme",
      repo: "widget",
      full_name: "acme/widget",
      default_branch: this.defaultBranch,
    };
  }

  async resolveRefToCommit(_: { owner: string; repo: string; repo_full_name: string; requested_ref: string | null }, ref: string) {
    if (this.branchToCommit[ref]) {
      return this.branchToCommit[ref];
    }

    if (isLikelyCommitSha(ref)) {
      return ref;
    }

    throw new IngestResolverError(`Cannot resolve ref '${ref}'`, "REF_NOT_FOUND");
  }

  async getRepositoryLanguages() {
    return this.languages;
  }
}

function writeFixtureFile(root: string, relativePath: string, content: string) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function createSourceFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "devport-ingest-fixture-"));
  writeFixtureFile(directory, "README.md", "# sample repository\n");
  writeFixtureFile(directory, "package.json", "{\"name\": \"widget\"}\n");
  writeFixtureFile(directory, "src/index.ts", "export const greeting = 'hello';\n");
  writeFixtureFile(directory, "src/utils.ts", "export const value = 1;\n");
  return directory;
}

describe("INGT-01 ref parser and resolver", () => {
  it("rejects malformed repository references", () => {
    expect(() => parseRepoRef("bad-repo")).toThrowError();
    expect(() => parseRepoRef("owner//repo")).toThrowError();
    expect(() => parseRepoRef("owner/repo/extra")).toThrowError();
  });

  it("normalizes owner/repo casing and supports inline ref shorthand", () => {
    const parsed = parseRepoRef("Owner/Repo@Main");

    expect(parsed.repo_full_name).toBe("owner/repo");
    expect(parsed.owner).toBe("owner");
    expect(parsed.repo).toBe("repo");
    expect(parsed.requested_ref).toBe("Main");
    expect(inferRefType(parsed.requested_ref)).toBe("branch");
  });

  it("normalizes Git refs and recognizes commit ids", () => {
    expect(normalizeRef("refs/heads/main")).toBe("main");
    expect(isLikelyCommitSha("1234567")).toBe(true);
    expect(isLikelyCommitSha(LONG_SHA_A)).toBe(true);
    expect(isLikelyCommitSha("invalid-sha")).toBe(false);
  });

  it("resolves branch refs to commit and keeps short/long sha refs", async () => {
    const resolver = new StubResolver("main", {
      main: LONG_SHA_A,
      dev: LONG_SHA_B,
    });

    const branchRef = parseRepoRef("Acme/Widget");
    const branchResolution = await resolveToCommitSha(branchRef, resolver);

    expect(branchResolution.requested_ref_type).toBe("default");
    expect(branchResolution.resolved_ref).toBe("main");
    expect(branchResolution.commit_sha).toBe(LONG_SHA_A);

    const shortSha = parseRepoRef("Acme/Widget@1234567");
    const shortResolution = await resolveToCommitSha(shortSha, resolver);
    expect(shortResolution.requested_ref_type).toBe("sha");
    expect(shortResolution.commit_sha).toBe("1234567");

    const explicitBranch = parseRepoRef("Acme/Widget@dev");
    const branchDevResolution = await resolveToCommitSha(explicitBranch, resolver);
    expect(branchDevResolution.requested_ref).toBe("dev");
    expect(branchDevResolution.commit_sha).toBe(LONG_SHA_B);
  });
});

describe("INGT-02 deterministic snapshots", () => {
  it("reuses identical commit snapshots when manifest matches", async () => {
    const sourceRoot = createSourceFixture();
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-ingestion-snapshot-"));
    const manager = new RepoSnapshotManager({
      snapshotRoot,
      sourcePath: sourceRoot,
    });

    const request = {
      repoFullName: "acme/widget",
      owner: "acme",
      repo: "widget",
      commitSha: LONG_SHA_A,
      resolvedRef: "main",
      sourceRef: null,
      sourceDefaultBranch: "main",
    };

    const first = await manager.createSnapshot(request);
    const second = await manager.createSnapshot(request);

    const snapshotId = formatIngestKey({
      owner: request.owner,
      repo: request.repo,
      commitSha: request.commitSha,
    });

    expect(first.idempotentHit).toBe(false);
    expect(second.idempotentHit).toBe(true);
    expect(first.snapshotId).toBe(snapshotId);
    expect(second.snapshotId).toBe(snapshotId);
    expect(first.snapshotPath).toBe(second.snapshotPath);
    expect(first.manifest.manifest_signature).toBe(second.manifest.manifest_signature);

    const third = await manager.createSnapshot({
      ...request,
      commitSha: LONG_SHA_B,
    });
    expect(third.snapshotId).not.toBe(first.snapshotId);
    expect(third.snapshotPath).not.toBe(first.snapshotPath);

    rmSync(snapshotRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("exposes deterministic extracted metadata ordering and key paths", async () => {
    const sourceRoot = createSourceFixture();
    const files = await import("node:fs/promises");
    const entries = await files.readdir(sourceRoot);
    expect(entries.length).toBeGreaterThan(0);

    const tmp = mkdtempSync(join(tmpdir(), "devport-ingest-meta-"));
    const manager = new RepoSnapshotManager({
      snapshotRoot: tmp,
      sourcePath: sourceRoot,
      forceRebuild: true,
    });

    const result = await manager.createSnapshot({
      repoFullName: "acme/widget",
      owner: "acme",
      repo: "widget",
      commitSha: LONG_SHA_A,
      resolvedRef: "main",
      sourceRef: null,
      sourceDefaultBranch: "main",
    });

    const metadata = await extractMetadata(result.snapshotPath, {
      manifestSignature: result.manifest.manifest_signature,
      keyPathLimit: 120,
    });
    const metadataSecond = await extractMetadata(result.snapshotPath, {
      manifestSignature: result.manifest.manifest_signature,
      keyPathLimit: 120,
    });

    expect(metadata.files_scanned).toBe(4);
    expect(metadata.key_paths).toEqual(["README.md", "package.json", "src"]);
    expect(metadata.tree_summary.total_files).toBe(4);
    expect(metadata.tree_summary.max_depth).toBe(2);
    expect(Object.keys(metadata.language_mix)).toEqual(["JSON", "Markdown", "TypeScript"]);
    expect(metadataSecond).toEqual(metadata);

    rmSync(tmp, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });
});

describe("INGT-03 ingest run orchestration", () => {
  it("discovers official docs from README/homepage and mirrors to __devport__/official-docs", async () => {
    const sourceRoot = createSourceFixture();
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-ingest-official-docs-"));
    const now = () => "2026-01-01T00:00:00.000Z";

    const resolver = new StubResolver("main", {
      main: LONG_SHA_A,
    });

    const manager = new RepoSnapshotManager({
      snapshotRoot,
      now,
      sourcePath: sourceRoot,
    });

    const artifact = await runIngest(
      {
        repo_ref: {
          repo: "acme/widget",
          ref: "main",
        },
        force_rebuild: false,
        snapshot_root: snapshotRoot,
        fixture_commit: LONG_SHA_A,
      },
      {
        now,
        resolver,
        snapshotManager: manager,
        fixtureCommit: LONG_SHA_A,
      },
    );

    expect(existsSync(join(artifact.snapshot_path, "__devport__/official-docs/index.json"))).toBe(true);

    rmSync(snapshotRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("writes synthetic trend files under __devport__/trends", async () => {
    const sourceRoot = createSourceFixture();
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-ingest-trends-"));
    const now = () => "2026-01-01T00:00:00.000Z";

    const resolver = new StubResolver("main", {
      main: LONG_SHA_A,
    });

    const manager = new RepoSnapshotManager({
      snapshotRoot,
      now,
      sourcePath: sourceRoot,
    });

    const artifact = await runIngest(
      {
        repo_ref: {
          repo: "acme/widget",
          ref: "main",
        },
        force_rebuild: false,
        snapshot_root: snapshotRoot,
        fixture_commit: LONG_SHA_A,
      },
      {
        now,
        resolver,
        snapshotManager: manager,
        fixtureCommit: LONG_SHA_A,
      },
    );

    expect(existsSync(join(artifact.snapshot_path, "__devport__/trends/releases.json"))).toBe(true);
    expect(existsSync(join(artifact.snapshot_path, "__devport__/trends/tags.json"))).toBe(true);

    rmSync(snapshotRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("runs end-to-end and keeps stable outputs for the same commit", async () => {
    const sourceRoot = createSourceFixture();
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-ingest-run-"));
    const now = () => "2026-01-01T00:00:00.000Z";

    const resolver = new StubResolver("main", {
      main: LONG_SHA_A,
    });

    const manager = new RepoSnapshotManager({
      snapshotRoot,
      now,
      sourcePath: sourceRoot,
    });

    const first = await runIngest(
      {
        repo_ref: {
          repo: "acme/widget",
          ref: "main",
        },
        force_rebuild: false,
        snapshot_root: snapshotRoot,
        fixture_commit: LONG_SHA_A,
      },
      {
        now,
        resolver,
        snapshotManager: manager,
        fixtureCommit: LONG_SHA_A,
      },
    );

    const expectedSnapshotId = formatIngestKey({
      owner: "acme",
      repo: "widget",
      commitSha: LONG_SHA_A,
    });

    expect(first.idempotent_hit).toBe(false);
    expect(first.snapshot_id).toBe(expectedSnapshotId);
    expect(first.metadata.key_paths).toEqual([
      "README.md",
      "__devport__/trends/changelog-summary.json",
      "package.json",
      "src",
    ]);
    expect(first.commit_sha).toBe(LONG_SHA_A);
    expect(first.requested_ref).toBe("main");

    const second = await runIngest(
      {
        repo_ref: {
          repo: "acme/widget",
          ref: "main",
        },
        force_rebuild: false,
        snapshot_root: snapshotRoot,
        fixture_commit: LONG_SHA_A,
      },
      {
        now,
        resolver,
        snapshotManager: manager,
        fixtureCommit: LONG_SHA_A,
      },
    );

    expect(second.idempotent_hit).toBe(true);
    expect(second.snapshot_id).toBe(first.snapshot_id);
    expect(second.snapshot_path).toBe(first.snapshot_path);
    expect(second.manifest_signature).toBe(first.manifest_signature);
    expect(second.ingest_run_id).toBe(first.ingest_run_id);
    expect(second.metadata.tree_summary.total_files).toBe(first.metadata.tree_summary.total_files);
    expect(second.files_scanned).toBe(first.files_scanned);

    rmSync(snapshotRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("prefers resolver language mix when available and keeps deterministic ordering", async () => {
    const sourceRoot = createSourceFixture();
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-ingest-run-langs-"));
    const now = () => "2026-01-01T00:00:00.000Z";

    const resolver = new StubResolver(
      "main",
      {
        main: LONG_SHA_A,
      },
      {
        TypeScript: 100,
        Markdown: 10,
        JavaScript: 50,
      },
    );

    const manager = new RepoSnapshotManager({
      snapshotRoot,
      now,
      sourcePath: sourceRoot,
    });

    const result = await runIngest(
      {
        repo_ref: {
          repo: "acme/widget",
          ref: "main",
        },
        force_rebuild: false,
        snapshot_root: snapshotRoot,
      },
      {
        now,
        resolver,
        snapshotManager: manager,
      },
    );

    expect(Object.keys(result.metadata.language_mix)).toEqual([
      "JavaScript",
      "Markdown",
      "TypeScript",
    ]);
    expect(result.metadata.language_mix.TypeScript).toBe(100);

    rmSync(snapshotRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });
});
