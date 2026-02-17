import { z } from "zod";

export const trackingStatusEnum = z.enum([
  "pending",
  "active",
  "paused",
  "blacklisted",
]);

export type TrackingStatus = z.infer<typeof trackingStatusEnum>;

export const discoveryFilterInputSchema = z
  .object({
    category: z
      .string()
      .trim()
      .min(1)
      .default("open-source"),
    min_stars: z
      .number()
      .int()
      .nonnegative()
      .default(500),
    max_last_push_days: z
      .number()
      .int()
      .positive()
      .optional()
      .default(undefined),
    licenses: z
      .array(z.string().trim().toLowerCase().min(1))
      .default([]),
    topics: z.array(z.string().trim().toLowerCase().min(1)).default([]),
    per_page: z.number().int().positive().max(100).default(30),
    page_limit: z.number().int().positive().default(3),
  })
  .strict();

export type DiscoveryFilterInput = z.infer<typeof discoveryFilterInputSchema>;

export const repoCandidateSchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().trim().min(3),
    default_branch: z.string().trim().min(1),
    stars: z.number().int().nonnegative(),
    pushed_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    language: z.string().trim().min(1).nullable(),
    license: z.string().trim().min(1).nullable(),
    topics: z.array(z.string().trim().toLowerCase().min(1)),
    homepage: z.string().url().nullable().or(z.literal("")),
    description: z.string().nullable(),
    quality_score: z.number().nonnegative(),
    source_category: z.string().trim().min(1),
    source_query_profile_id: z.string().trim().min(1),
  })
  .strict();

export type RepoCandidate = z.infer<typeof repoCandidateSchema>;

export const registryRecordSchema = repoCandidateSchema
  .omit({ source_query_profile_id: true })
  .extend({
    status: trackingStatusEnum,
    last_checked_at: z.string().datetime(),
    last_transition_at: z.string().datetime(),
    last_error: z.string().nullable(),
    priority: z.number().int().nonnegative().default(0),
    source_query_profile_id: z.string().trim().min(1),
  });

export type RegistryRecord = z.infer<typeof registryRecordSchema>;

export const discoveryRunMetricsSchema = z
  .object({
    candidates_seen: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    filtered_out: z.number().int().nonnegative(),
    upserted: z.number().int().nonnegative(),
    active_count: z.number().int().nonnegative(),
  })
  .strict();

export type DiscoveryRunMetrics = z.infer<typeof discoveryRunMetricsSchema>;

export const discoveryRunSchema = z
  .object({
    run_id: z.string().trim().min(1),
    query_profile_id: z.string().trim().min(1),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime(),
    input: discoveryFilterInputSchema,
    query: z.string().min(1),
    metrics: discoveryRunMetricsSchema,
    upsert_delta: z
      .object({
        inserted: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
      })
      .strict(),
    stage_history: z.array(
      z.object({
        stage: z.string().min(1),
        started_at: z.string().datetime(),
        ended_at: z.string().datetime(),
        status: z.enum(["ok", "skipped", "failed"]),
      }),
    ),
  })
  .strict();

export type DiscoveryRun = z.infer<typeof discoveryRunSchema>;

export const registrySnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.string().datetime(),
    query_profile_id: z.string().trim().min(1),
    records: z.array(registryRecordSchema),
  })
  .strict();

export type RegistrySnapshot = z.infer<typeof registrySnapshotSchema>;

export interface GitHubRawRepoItem {
  id: number;
  full_name: string;
  default_branch: string;
  stargazers_count: number;
  pushed_at: string;
  updated_at: string;
  language: string | null;
  license: null | {
    spdx_id: string | null;
    name?: string;
  };
  topics: string[];
  homepage: string | null;
  description: string | null;
}

export interface GitHubSearchPage {
  items: GitHubRawRepoItem[];
  total_count: number;
  has_more: boolean;
  rate_limit_remaining: number;
  rate_limit_reset: number;
}

export interface DiscoverySearchResult {
  query_profile_id: string;
  query: string;
  candidates: RepoCandidate[];
  candidates_seen: number;
  filtered_out: number;
  pages_fetched: number;
}
