import { randomUUID } from "node:crypto";

import {
  discoveryRunMetricsSchema,
  discoveryRunSchema,
  type DiscoveryFilterInput,
  type DiscoveryRun,
  type DiscoveryRunMetrics,
} from "./types";
import { buildSearchQuery } from "./query";
import {
  runGitHubSearch,
  type RunGitHubSearchParams,
} from "./search";
import {
  TrackedRepositoryStore,
  type UpsertResult,
} from "./registry";
import { ensureInitialTrackedSet } from "./bootstrap";

interface StageExecution {
  stage: string;
  started_at: string;
  ended_at: string;
  status: "ok" | "skipped" | "failed";
}

interface RunDiscoveryParams {
  input: unknown;
  registryStore: TrackedRepositoryStore;
  bootstrap?: boolean;
  bootstrapActiveTarget?: number;
  now?: () => string;
  queryProfileIdOverride?: string;
  search?: Omit<RunGitHubSearchParams, "input">;
}

interface RunDiscoveryOutput {
  run: DiscoveryRun;
  upsertDelta: UpsertResult;
}

function safeDateNow(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

export async function runDiscovery({
  input,
  registryStore,
  bootstrap = false,
  bootstrapActiveTarget = 50,
  now,
  queryProfileIdOverride,
  search,
}: RunDiscoveryParams): Promise<RunDiscoveryOutput> {
  const startedAt = safeDateNow(now);
  const stageHistory: StageExecution[] = [];
  const parsedInput = buildSearchQuery(input as DiscoveryFilterInput, new Date(startedAt));
  const queryOutput = {
    ...parsedInput,
    profile: {
      ...parsedInput.profile,
      query_profile_id: queryProfileIdOverride || parsedInput.profile.query_profile_id,
    },
  };
  const queryProfileId = queryOutput.profile.query_profile_id;
  const stageDisoveryStart = safeDateNow(now);
  let searchResult;

  try {
    searchResult = await runGitHubSearch({
      input: parsedInput.profile.canonical_input,
      queryOverride: queryOutput,
      now: startedAt,
      ...(search || {}),
    });

    stageHistory.push({
      stage: "run_discovery",
      started_at: stageDisoveryStart,
      ended_at: safeDateNow(now),
      status: "ok",
    });
  } catch (error) {
    stageHistory.push({
      stage: "run_discovery",
      started_at: stageDisoveryStart,
      ended_at: safeDateNow(now),
      status: "failed",
    });

    throw error;
  }

  const applyStart = safeDateNow(now);
  let upsertDelta: UpsertResult;
  try {
    upsertDelta = registryStore.upsertTrackedRepositories(searchResult.candidates);
    stageHistory.push({
      stage: "apply_registry",
      started_at: applyStart,
      ended_at: safeDateNow(now),
      status: "ok",
    });
  } catch (error) {
    stageHistory.push({
      stage: "apply_registry",
      started_at: applyStart,
      ended_at: safeDateNow(now),
      status: "failed",
    });

    throw error;
  }

  const finalizeStart = safeDateNow(now);
  if (bootstrap) {
    ensureInitialTrackedSet(registryStore, bootstrapActiveTarget);
  }

  const activeCount = registryStore.listByStatus("active").length;
  const metrics: DiscoveryRunMetrics = discoveryRunMetricsSchema.parse({
    candidates_seen: searchResult.candidates_seen,
    accepted: searchResult.candidates.length,
    filtered_out: searchResult.filtered_out,
    upserted: upsertDelta.inserted,
    active_count: activeCount,
  });

  const run: DiscoveryRun = discoveryRunSchema.parse({
    run_id: randomUUID(),
    query_profile_id: queryProfileId,
    started_at: startedAt,
    ended_at: safeDateNow(now),
    input: parsedInput.profile.canonical_input,
    query: searchResult.query,
    metrics,
    upsert_delta: {
      inserted: upsertDelta.inserted,
      updated: upsertDelta.updated,
      errors: upsertDelta.errors,
    },
    stage_history: stageHistory.concat({
      stage: "finalize",
      started_at: finalizeStart,
      ended_at: safeDateNow(now),
      status: "ok",
    }),
  });

  return { run, upsertDelta };
}

export type { RunDiscoveryOutput, RunDiscoveryParams };
