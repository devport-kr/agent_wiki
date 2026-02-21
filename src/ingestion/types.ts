import { z } from "zod";

export const repoRefInputSchema = z
  .object({
    repo: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
  })
  .strict();

export type RepoRefInput = z.infer<typeof repoRefInputSchema>;

export const resolvedIngestRefSchema = z
  .object({
    repo_full_name: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    requested_ref: z.string().trim().min(1).nullable(),
    requested_ref_type: z.enum(["branch", "sha", "default"]),
    resolved_ref: z.string().trim().min(1),
    commit_sha: z.string().trim().min(4),
    resolved_via: z.string().trim().min(1),
    source_default_branch: z.string().trim().min(1),
    resolved_at: z.string().datetime(),
  })
  .strict();

export type ResolvedIngestRef = z.infer<typeof resolvedIngestRefSchema>;

export const ingestRunInputSchema = z
  .object({
    repo_ref: repoRefInputSchema,
    force_rebuild: z.boolean().default(false),
    snapshot_root: z.string().trim().min(1).default("devport-output/snapshots"),
    now: z
      .function()
      .args()
      .returns(z.string())
      .optional(),
    fixture_commit: z.string().trim().min(4).optional(),
  })
  .strict();

export type IngestRunInput = Omit<z.infer<typeof ingestRunInputSchema>, "now">;

export const treeSummarySchema = z
  .object({
    total_files: z.number().int().nonnegative(),
    total_directories: z.number().int().nonnegative(),
    max_depth: z.number().int().nonnegative(),
    by_extension: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export const languageMixSchema = z
  .record(z.string().trim().min(1), z.number().nonnegative())
  .default({});

export const ingestMetadataSchema = z
  .object({
    tree_summary: treeSummarySchema,
    language_mix: languageMixSchema,
    key_paths: z.array(z.string().trim().min(1)),
    files_scanned: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    manifest_signature: z.string().trim().min(1),
  })
  .strict();

export type IngestMetadata = z.infer<typeof ingestMetadataSchema>;

export const ingestRunArtifactSchema = z
  .object({
    ingest_run_id: z.string().trim().min(1),
    repo_ref: z.string().trim().min(1),
    requested_ref: z.string().trim().min(1).nullable(),
    resolved_ref: z.string().trim().min(1),
    commit_sha: z.string().trim().min(4),
    snapshot_path: z.string().trim().min(1),
    snapshot_id: z.string().trim().min(1),
    manifest_signature: z.string().trim().min(1),
    files_scanned: z.number().int().nonnegative(),
    idempotent_hit: z.boolean(),
    metadata: ingestMetadataSchema,
    trend_artifacts: z
      .object({
        window_days: z.number().int().positive(),
        releases_path: z.string().trim().min(1),
        tags_path: z.string().trim().min(1),
        changelog_summary_path: z.string().trim().min(1),
        release_count: z.number().int().nonnegative(),
        tag_count: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    created_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    ingest_ms: z.number().int().nonnegative(),
  })
  .strict();

export type IngestRunArtifact = z.infer<typeof ingestRunArtifactSchema>;

export interface RepoSnapshotManifest {
  repo_full_name: string;
  commit_sha: string;
  resolved_ref: string;
  source_ref: string;
  source_default_branch: string;
  manifest_signature: string;
  file_count: number;
  total_bytes: number;
  created_at: string;
}

export type SnapshotManifest = RepoSnapshotManifest;

export interface ParsedRepoRef {
  repo_full_name: string;
  owner: string;
  repo: string;
  requested_ref: string | null;
}

export interface IngestDependencyConfig {
  now?: () => string;
  snapshot_root: string;
  fixture_commit?: string;
}
