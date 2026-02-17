import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSearchQuery } from "../src/discovery/query";
import {
  calculateQualityScore,
  rankCandidates,
} from "../src/discovery/quality";
import { TrackedRepositoryStore } from "../src/discovery/registry";
import { ensureInitialTrackedSet, filterRecordsByStatus } from "../src/discovery/bootstrap";
import { runDiscovery } from "../src/discovery/run";
import { runGitHubSearch } from "../src/discovery/search";
import type { GitHubRawRepoItem, RepoCandidate } from "../src/discovery/types";

describe("DISC-01 discovery query and scoring", () => {
  it("builds deterministic query with mapped filters", () => {
    const input = {
      category: "frontend",
      min_stars: 700,
      max_last_push_days: 30,
      licenses: ["MIT", "Apache-2.0"],
      topics: ["typescript", "javascript"],
      per_page: 25,
      page_limit: 2,
    };

    const now = "2026-01-10T00:00:00.000Z";
    const first = buildSearchQuery(input, new Date(now));
    const second = buildSearchQuery(input, new Date(now));

    expect(first.query).toContain("topic:javascript");
    expect(first.query).toContain("stars:>=700");
    expect(first.query).toContain("pushed:>=2025-12-11");
    expect(first.query).toContain("license:apache-2.0");
    expect(first.query).toContain("license:mit");
    expect(first.profile.query_profile_id).toBe(second.profile.query_profile_id);
  });

  it("scores are deterministic and ranking is stable", () => {
    const candidate = {
      full_name: "acme/widget",
      stars: 1200,
      pushed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-05T00:00:00.000Z",
      license: null,
      topics: ["typescript"],
      source_category: "frontend",
      quality_reference_iso: "2026-01-10T00:00:00.000Z",
    };

    const a = calculateQualityScore(candidate);
    const b = calculateQualityScore(candidate);
    const ranked = rankCandidates([
      {
        id: 1,
        full_name: "acme/b",
        default_branch: "main",
        stars: 1200,
        pushed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-05T00:00:00.000Z",
        language: "typescript",
        license: null,
        topics: ["typescript"],
        homepage: "",
        description: null,
        quality_score: a,
        source_category: "frontend",
        source_query_profile_id: "q",
      },
      {
        id: 2,
        full_name: "acme/a",
        default_branch: "main",
        stars: 1200,
        pushed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-05T00:00:00.000Z",
        language: "typescript",
        license: null,
        topics: ["typescript"],
        homepage: "",
        description: null,
        quality_score: b,
        source_category: "frontend",
        source_query_profile_id: "q",
      },
    ]);

    expect(a).toBe(b);
    expect(ranked[0].full_name).toBe("acme/a");
  });
});

describe("DISC-02 tracked registry upsert and transitions", () => {
  it("keeps stable identity without duplicates on repeated upserts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devport-registry-"));
    const snapshotPath = join(dir, "registry.json");
    const store = await TrackedRepositoryStore.create({ snapshotPath });

    const candidates: RepoCandidate[] = Array.from({ length: 25 }).map((_, i) => ({
      id: i + 1,
      full_name: `acme/repo-${i + 1}`,
      default_branch: "main",
      stars: 1200 + i,
      pushed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      language: "typescript",
      license: null,
      topics: ["javascript", "typescript"],
      homepage: "",
      description: null,
      quality_score: 42 + i,
      source_category: "web",
      source_query_profile_id: "profile-id",
    }));

    const first = store.upsertTrackedRepositories(candidates);
    const second = store.upsertTrackedRepositories(candidates);
    expect(first.inserted).toBe(25);
    expect(first.errors).toBe(0);
    expect(second.updated).toBe(25);
    expect(store.listByStatus("pending").length).toBe(25);
    await store.persist(snapshotPath, "manual-test");
  });

  it("rejects invalid status transitions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devport-registry-"));
    const snapshotPath = join(dir, "registry.json");
    const store = await TrackedRepositoryStore.create({ snapshotPath });

    store.upsertTrackedRepositories([
      {
        id: 1,
        full_name: "acme/noise",
        default_branch: "main",
        stars: 900,
        pushed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        language: "typescript",
        license: null,
        topics: ["typescript"],
        homepage: "",
        description: null,
        quality_score: 60,
        source_category: "web",
        source_query_profile_id: "profile-id",
      },
    ]);

    store.markBlacklisted("acme/noise");
    expect(() => store.transitionRecordStatus("acme/noise", "active")).toThrowError(/Invalid transition/);
  });
});

describe("DISC-03 bootstrap and discovery orchestration", () => {
  function makeItem(index: number): GitHubRawRepoItem {
    return {
      id: index,
      full_name: `acme/repo-${index}`,
      default_branch: "main",
      stargazers_count: 1000 + index,
      pushed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      language: "typescript",
      license: { spdx_id: "MIT", name: "MIT" },
      topics: ["javascript"],
      homepage: null,
      description: null,
    };
  }

  it("promotes highest scored repos to active in bootstrap mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devport-run-"));
    const snapshotPath = join(dir, "registry.json");
    const store = await TrackedRepositoryStore.create({ snapshotPath });

    const pageFetcher = async ({ page, perPage }: { query: string; page: number; perPage: number }) => {
      const items = Array.from({ length: 60 })
        .map((_, i) => makeItem(i + 1))
        .slice((page - 1) * perPage, page * perPage);
      return {
        items,
        total_count: 60,
        incomplete_results: page * perPage < 60,
        rate_limit_remaining: 60,
        rate_limit_reset: 0,
      };
    };

    const first = await runDiscovery({
      input: {
        category: "open-source",
        min_stars: 500,
        max_last_push_days: 365,
        licenses: ["mit"],
        topics: ["javascript"],
        per_page: 30,
        page_limit: 2,
      },
      registryStore: store,
      bootstrap: true,
      bootstrapActiveTarget: 50,
      search: {
        maxTotalPages: 2,
        pageFetcher,
      },
    });

    expect(first.run.metrics.active_count).toBe(50);
    expect(filterRecordsByStatus(store, "active").length).toBe(50);

    const second = await runDiscovery({
      input: {
        category: "open-source",
        min_stars: 500,
        max_last_push_days: 365,
        licenses: ["mit"],
        topics: ["javascript"],
        per_page: 30,
        page_limit: 2,
      },
      registryStore: store,
      bootstrap: true,
      bootstrapActiveTarget: 50,
      search: {
        maxTotalPages: 2,
        pageFetcher,
      },
    });

    expect(second.run.metrics.active_count).toBe(50);
    expect(ensureInitialTrackedSet(store, 50).promoted).toBe(0);
  });

  it("search-only run handles empty fixture deterministically", async () => {
    const queryResult = runGitHubSearch({
      input: {
        category: "open-source",
        min_stars: 500,
        licenses: ["mit"],
        topics: ["javascript"],
        per_page: 10,
        page_limit: 1,
      },
      pageFetcher: async () => ({
        items: [],
        total_count: 0,
        incomplete_results: false,
        rate_limit_remaining: 10,
        rate_limit_reset: 0,
      }),
    });

    await expect(queryResult).resolves.toMatchObject({
      candidates: [],
      candidates_seen: 0,
      filtered_out: 0,
    });
  });
});
