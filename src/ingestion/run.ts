import { createHash } from "node:crypto";

import {
  ingestRunArtifactSchema,
  ingestRunInputSchema,
  type IngestMetadata,
  type IngestRunArtifact,
  type IngestRunInput,
} from "./types";
import {
  type RepoSnapshotRequest,
  type RepoSnapshotResult,
  RepoSnapshotManager,
} from "./snapshot";
import { extractMetadata } from "./metadata";
import { inferRefType, normalizeRef, parseRepoRef } from "./ref";
import {
  resolveToCommitSha,
  type GitHubResolver,
  OctokitGitHubResolver,
} from "./github";
import { persistOfficialDocsArtifacts } from "./official-docs";
import { persistTrendArtifacts } from "./trends";

interface RunIngestDependencyConfig {
  now?: () => string;
  resolver?: GitHubResolver;
  snapshotManager?: RepoSnapshotManager;
  snapshotRoot?: string;
  sourcePath?: string;
  fixtureCommit?: string;
  languageResolver?: (params: {
    owner: string;
    repo: string;
    fullName: string;
    commitSha: string;
  }) => Promise<Record<string, number> | null>;
}

interface ResolvedRef {
  requested_ref: string | null;
  requested_ref_type: "branch" | "sha" | "default";
  resolved_ref: string;
  commit_sha: string;
  source_default_branch: string;
}

interface Stage {
  stage: "resolve_ref" | "snapshot" | "metadata" | "finalize";
  started_at: string;
  ended_at: string;
  status: "ok" | "failed";
}

function safeNow(now: () => string = () => new Date().toISOString()): string {
  return now();
}

function buildIngestRunId(
  repoFullName: string,
  snapshotId: string,
  manifestSignature: string,
): string {
  return createHash("sha1")
    .update(`${repoFullName}|${snapshotId}|${manifestSignature}`)
    .digest("hex");
}

async function resolveReference(
  repo: ReturnType<typeof parseRepoRef>,
  requestedRef: string | null,
  resolver: GitHubResolver,
  fixtureCommit: string | undefined,
): Promise<ResolvedRef> {
  if (fixtureCommit && requestedRef) {
    return {
      requested_ref: requestedRef,
      requested_ref_type: inferRefType(requestedRef),
      resolved_ref: requestedRef,
      commit_sha: fixtureCommit.toLowerCase(),
      source_default_branch: requestedRef,
    };
  }

  const metadata = await resolver.getRepositoryMeta(repo);
  const sourceDefaultBranch = metadata.default_branch;

  if (fixtureCommit) {
    const resolvedRef = requestedRef || sourceDefaultBranch;

    return {
      requested_ref: requestedRef,
      requested_ref_type: inferRefType(requestedRef),
      resolved_ref: resolvedRef,
      commit_sha: fixtureCommit.toLowerCase(),
      source_default_branch: sourceDefaultBranch,
    };
  }

  const resolution = await resolveToCommitSha(
    {
      ...repo,
      requested_ref: requestedRef,
    },
    resolver,
  );

  return {
    requested_ref: requestedRef,
    requested_ref_type: resolution.requested_ref_type,
    resolved_ref: resolution.resolved_ref,
    commit_sha: resolution.commit_sha.toLowerCase(),
    source_default_branch: resolution.source_default_branch,
  };
}

async function createOrReuseSnapshot(
  snapshotManager: RepoSnapshotManager,
  repo: ReturnType<typeof parseRepoRef>,
  resolved: ResolvedRef,
): Promise<RepoSnapshotResult> {
  const request: RepoSnapshotRequest = {
    repoFullName: repo.repo_full_name,
    owner: repo.owner,
    repo: repo.repo,
    commitSha: resolved.commit_sha,
    resolvedRef: resolved.resolved_ref,
    sourceRef: resolved.requested_ref,
    sourceDefaultBranch: resolved.source_default_branch,
  };

  return snapshotManager.createSnapshot(request);
}

async function extractRunMetadata(
  snapshotPath: string,
  manifestSignature: string,
  resolver: GitHubResolver,
  languageResolver: RunIngestDependencyConfig["languageResolver"],
  allowResolverLanguageLookup: boolean,
  languageArgs: {
    owner: string;
    repo: string;
    fullName: string;
    commitSha: string;
  },
): Promise<IngestMetadata> {
  const languageMix = languageResolver
    ? await languageResolver(languageArgs)
    : allowResolverLanguageLookup
      ? await loadLanguageMixFromResolver(resolver, languageArgs)
      : null;

  return extractMetadata(snapshotPath, {
    manifestSignature,
    keyPathLimit: 120,
    languageMix,
  });
}

async function loadLanguageMixFromResolver(
  resolver: GitHubResolver,
  languageArgs: {
    owner: string;
    repo: string;
    fullName: string;
    commitSha: string;
  },
): Promise<Record<string, number> | null> {
  if (typeof resolver.getRepositoryLanguages !== "function") {
    return null;
  }

  try {
    return await resolver.getRepositoryLanguages({
      owner: languageArgs.owner,
      repo: languageArgs.repo,
      repo_full_name: languageArgs.fullName,
      requested_ref: languageArgs.commitSha,
    });
  } catch {
    return null;
  }
}

function pushStage(
  stageHistory: Stage[],
  stage: Stage["stage"],
  startedAt: string,
  status: Stage["status"] = "ok",
): void {
  stageHistory.push({
    stage,
    started_at: startedAt,
    ended_at: safeNow(),
    status,
  });
}

export async function runIngest(
  rawInput: IngestRunInput,
  config: RunIngestDependencyConfig = {},
): Promise<IngestRunArtifact> {
  const now = config.now || (() => new Date().toISOString());
  const parsedInput = ingestRunInputSchema.parse(rawInput);
  const startedAt = safeNow(now);
  const startedMs = Date.now();
  const stageHistory: Stage[] = [];

  const repo = parseRepoRef(parsedInput.repo_ref.repo);
  const normalizedRequestedRef = normalizeRef(parsedInput.repo_ref.ref);

  const resolver = config.resolver || new OctokitGitHubResolver(process.env.GITHUB_TOKEN);

  const snapshotManager =
    config.snapshotManager ||
    new RepoSnapshotManager({
      snapshotRoot: parsedInput.snapshot_root,
      now,
      forceRebuild: parsedInput.force_rebuild,
      sourcePath: config.sourcePath,
    });

  let resolved: ResolvedRef;
  const resolveStart = safeNow(now);
  try {
    resolved = await resolveReference(
      repo,
      normalizedRequestedRef,
      resolver,
      config.fixtureCommit || parsedInput.fixture_commit,
    );
    pushStage(stageHistory, "resolve_ref", resolveStart);
  } catch (error) {
    pushStage(stageHistory, "resolve_ref", resolveStart, "failed");
    throw error;
  }

  const snapshotStart = safeNow(now);
  let snapshot: RepoSnapshotResult;
  try {
    snapshot = await createOrReuseSnapshot(snapshotManager, repo, resolved);
    pushStage(stageHistory, "snapshot", snapshotStart);
  } catch (error) {
    pushStage(stageHistory, "snapshot", snapshotStart, "failed");
    throw error;
  }

  const metadataStart = safeNow(now);
  let metadata: IngestMetadata;
  let trendArtifacts:
    | {
        window_days: number;
        releases_path: string;
        tags_path: string;
        changelog_summary_path: string;
        release_count: number;
        tag_count: number;
      }
    | undefined;
  let officialDocsArtifacts:
    | {
        index_path: string;
        discovered_count: number;
        mirrored_count: number;
      }
    | undefined;
  try {
    const persistedTrendArtifacts = await persistTrendArtifacts({
      snapshotPath: snapshot.snapshotPath,
      repo,
      resolver,
      commitSha: resolved.commit_sha,
      now,
    });

    trendArtifacts = {
      window_days: persistedTrendArtifacts.window_days,
      releases_path: persistedTrendArtifacts.releases_path,
      tags_path: persistedTrendArtifacts.tags_path,
      changelog_summary_path: persistedTrendArtifacts.changelog_summary_path,
      release_count: persistedTrendArtifacts.release_count,
      tag_count: persistedTrendArtifacts.tag_count,
    };

    if (persistedTrendArtifacts.manifest_signature !== snapshot.manifest.manifest_signature) {
      snapshot.manifest.manifest_signature = persistedTrendArtifacts.manifest_signature;
    }

    const persistedOfficialDocsArtifacts = await persistOfficialDocsArtifacts({
      snapshotPath: snapshot.snapshotPath,
      repo,
      resolver,
      commitSha: resolved.commit_sha,
    });

    officialDocsArtifacts = {
      index_path: persistedOfficialDocsArtifacts.index_path,
      discovered_count: persistedOfficialDocsArtifacts.discovered_count,
      mirrored_count: persistedOfficialDocsArtifacts.mirrored_count,
    };

    if (persistedOfficialDocsArtifacts.manifest_signature !== snapshot.manifest.manifest_signature) {
      snapshot.manifest.manifest_signature = persistedOfficialDocsArtifacts.manifest_signature;
    }

    const fixtureCommit = config.fixtureCommit || parsedInput.fixture_commit;
    metadata = await extractRunMetadata(
      snapshot.snapshotPath,
      snapshot.manifest.manifest_signature,
      resolver,
      config.languageResolver,
      !fixtureCommit,
      {
        owner: repo.owner,
        repo: repo.repo,
        fullName: repo.repo_full_name,
        commitSha: resolved.commit_sha,
      },
    );

    pushStage(stageHistory, "metadata", metadataStart);
  } catch (error) {
    pushStage(stageHistory, "metadata", metadataStart, "failed");
    throw error;
  }

  const finalizeStart = safeNow(now);
  const ingestMs = Math.max(0, Date.now() - startedMs);
  const completedAt = safeNow(now);
  pushStage(stageHistory, "finalize", finalizeStart);

  return ingestRunArtifactSchema.parse({
    ingest_run_id: buildIngestRunId(
      repo.repo_full_name,
      snapshot.snapshotId,
      snapshot.manifest.manifest_signature,
    ),
    repo_ref: repo.repo_full_name,
    requested_ref: resolved.requested_ref,
    resolved_ref: resolved.resolved_ref,
    commit_sha: resolved.commit_sha,
    snapshot_path: snapshot.snapshotPath,
    snapshot_id: snapshot.snapshotId,
    manifest_signature: snapshot.manifest.manifest_signature,
    files_scanned: metadata.files_scanned,
    idempotent_hit: snapshot.idempotentHit,
    metadata,
    trend_artifacts: trendArtifacts,
    official_docs: officialDocsArtifacts,
    created_at: startedAt,
    completed_at: completedAt,
    ingest_ms: ingestMs,
  });
}

export type { RunIngestDependencyConfig, Stage };
