import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { detectRepoFreshness } from "../src/freshness/detect";
import { loadFreshnessState, saveFreshnessState } from "../src/freshness/state";

function createTempStatePath(): string {
  const root = mkdtempSync(join(tmpdir(), "devport-freshness-state-"));
  return join(root, "baseline.json");
}

describe("freshness baseline state", () => {
  it("baseline rejects malformed persisted payloads", async () => {
    const statePath = createTempStatePath();
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          schema_version: 1,
          repos: {
            "acme/widget": {
              repo_ref: "acme/widget",
              sectionEvidenceIndex: [],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(loadFreshnessState(statePath)).rejects.toThrow(/Invalid freshness state schema/);

    rmSync(dirname(statePath), { recursive: true, force: true });
  });

  it("baseline writes byte-stable deterministic output", async () => {
    const statePath = createTempStatePath();

    const input = {
      schema_version: 1 as const,
      repos: {
        "zeta/repo": {
          repo_ref: "zeta/repo",
          last_delivery_commit: "fedcba9876543210fedcba9876543210fedcba98",
          sectionEvidenceIndex: [
            {
              sectionId: "architecture",
              repoPaths: ["src/z.ts", "src/a.ts", "src/a.ts"],
            },
          ],
        },
        "acme/widget": {
          repo_ref: "acme/widget",
          last_delivery_commit: "0123456789abcdef0123456789abcdef01234567",
          etag: "W/\"etag-123\"",
          sectionEvidenceIndex: [
            {
              sectionId: "entrypoint",
              repoPaths: ["src/main.ts", "src/index.ts"],
            },
          ],
        },
      },
    };

    await saveFreshnessState(statePath, input);
    const first = readFileSync(statePath, "utf8");

    await saveFreshnessState(statePath, input);
    const second = readFileSync(statePath, "utf8");

    expect(second).toBe(first);

    const parsed = JSON.parse(first) as {
      repos: Record<string, { sectionEvidenceIndex: Array<{ repoPaths: string[] }> }>;
    };
    expect(Object.keys(parsed.repos)).toEqual(["acme/widget", "zeta/repo"]);
    expect(parsed.repos["zeta/repo"].sectionEvidenceIndex[0].repoPaths).toEqual(["src/a.ts", "src/z.ts"]);

    rmSync(dirname(statePath), { recursive: true, force: true });
  });
});

describe("freshness detect", () => {
  it("detect routes repo normalization through ingestion helper", async () => {
    vi.resetModules();
    const normalizeGitHubRepoIdentityForResolver = vi.fn((rawRepoRef: string) => {
      if (rawRepoRef.includes("@")) {
        throw new Error("repo_ref must not include @ref for freshness detection");
      }

      const [owner, repo] = rawRepoRef.toLowerCase().split("/");
      return { owner, repo, repo_ref: `${owner}/${repo}` };
    });

    vi.doMock("../src/ingestion/github", async () => {
      const actual = await vi.importActual<typeof import("../src/ingestion/github")>("../src/ingestion/github");
      return {
        ...actual,
        normalizeGitHubRepoIdentityForResolver,
      };
    });

    const { detectRepoFreshness: detectWithMock } = await import("../src/freshness/detect");

    const client = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } }),
          getBranch: async () => ({
            data: { commit: { sha: "0123456789abcdef0123456789abcdef01234567" } },
          }),
          compareCommits: async () => ({
            data: {
              status: "identical",
              files: [],
            },
            headers: {},
          }),
        },
      },
    };

    await detectWithMock(
      {
        repo_ref: "Acme/Widget",
        baseline: {
          repo_ref: "acme/widget",
          last_delivery_commit: "0123456789abcdef0123456789abcdef01234567",
          sectionEvidenceIndex: [],
        },
      },
      { client },
    );

    expect(normalizeGitHubRepoIdentityForResolver).toHaveBeenCalledTimes(2);
    expect(normalizeGitHubRepoIdentityForResolver).toHaveBeenNthCalledWith(1, "Acme/Widget");
    expect(normalizeGitHubRepoIdentityForResolver).toHaveBeenNthCalledWith(2, "acme/widget");

    vi.doUnmock("../src/ingestion/github");
    vi.resetModules();
  });

  it("detect returns noop when baseline commit matches current head", async () => {
    const compareCommits = vi.fn(async () => ({
      data: {
        status: "identical",
        files: [],
      },
      headers: {},
    }));

    const client = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } }),
          getBranch: async () => ({
            data: { commit: { sha: "0123456789abcdef0123456789abcdef01234567" } },
          }),
          compareCommits,
        },
      },
    };

    const result = await detectRepoFreshness(
      {
        repo_ref: "Acme/Widget",
        baseline: {
          repo_ref: "acme/widget",
          last_delivery_commit: "0123456789abcdef0123456789abcdef01234567",
          sectionEvidenceIndex: [],
        },
      },
      { client },
    );

    expect(result.mode).toBe("noop");
    expect(result.changed_paths).toEqual([]);
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it("detect returns deterministic changed paths including rename previous filename", async () => {
    const client = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } }),
          getBranch: async () => ({
            data: { commit: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
          }),
          compareCommits: async () => ({
            data: {
              status: "ahead",
              files: [
                {
                  filename: "src/new-name.ts",
                  status: "renamed",
                  previous_filename: "src/old-name.ts",
                },
                {
                  filename: "src/feature.ts",
                  status: "modified",
                },
              ],
            },
            headers: {},
          }),
        },
      },
    };

    const result = await detectRepoFreshness(
      {
        repo_ref: "acme/widget",
        baseline: {
          repo_ref: "acme/widget",
          last_delivery_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sectionEvidenceIndex: [],
        },
      },
      { client },
    );

    expect(result.mode).toBe("incremental-candidate");
    expect(result.changed_paths).toEqual([
      "src/feature.ts",
      "src/new-name.ts",
      "src/old-name.ts",
    ]);
  });

  it("detect classifies paginated compare as full rebuild required", async () => {
    const client = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } }),
          getBranch: async () => ({
            data: { commit: { sha: "cccccccccccccccccccccccccccccccccccccccc" } },
          }),
          compareCommits: async () => ({
            data: {
              status: "ahead",
              files: [
                {
                  filename: "src/a.ts",
                  status: "modified",
                },
              ],
            },
            headers: {
              link: '<https://api.github.com/...>; rel="next", <https://api.github.com/...>; rel="last"',
            },
          }),
        },
      },
    };

    const result = await detectRepoFreshness(
      {
        repo_ref: "acme/widget",
        baseline: {
          repo_ref: "acme/widget",
          last_delivery_commit: "dddddddddddddddddddddddddddddddddddddddd",
          sectionEvidenceIndex: [],
        },
      },
      { client },
    );

    expect(result.mode).toBe("full-rebuild-required");
    expect(result.ambiguity_reasons).toContain("COMPARE_PAGINATED");
    expect(result.mode).not.toBe("incremental-candidate");
  });
});
