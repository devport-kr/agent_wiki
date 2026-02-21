import { Octokit } from "@octokit/rest";

import { type ParsedRepoRef } from "./ref";
import { inferRefType, normalizeRef, parseRepoRef } from "./ref";

export interface GitHubRepositoryMeta {
  owner: string;
  repo: string;
  full_name: string;
  default_branch: string;
}

export interface RefResolutionResult {
  requested_ref: string | null;
  requested_ref_type: "branch" | "sha" | "default";
  resolved_ref: string;
  commit_sha: string;
  source_default_branch: string;
}

export interface NormalizedGitHubRepoIdentity {
  owner: string;
  repo: string;
  repo_ref: string;
}

export interface GitHubReleaseSummary {
  id: number;
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  html_url: string | null;
}

export interface GitHubTagSummary {
  name: string;
  commit_sha: string | null;
  tarball_url: string | null;
  zipball_url: string | null;
}

export class IngestResolverError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_REPO" | "REPO_NOT_FOUND" | "REF_NOT_FOUND" | "UNRESOLVED_REF",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "IngestResolverError";
  }
}

export interface GitHubResolver {
  getRepositoryMeta(repo: ParsedRepoRef): Promise<GitHubRepositoryMeta>;
  resolveRefToCommit(repo: ParsedRepoRef, ref: string): Promise<string>;
  getRepositoryLanguages?(repo: ParsedRepoRef): Promise<Record<string, number> | null>;
  getRepositoryReleases?(
    repo: ParsedRepoRef,
    input: {
      since: string;
      per_page?: number;
      max_items?: number;
    },
  ): Promise<GitHubReleaseSummary[]>;
  getRepositoryTags?(
    repo: ParsedRepoRef,
    input?: {
      per_page?: number;
      max_items?: number;
    },
  ): Promise<GitHubTagSummary[]>;
}

export function normalizeGitHubRepoIdentityForResolver(rawRepoRef: string): NormalizedGitHubRepoIdentity {
  const parsed = parseRepoRef(rawRepoRef);
  if (parsed.requested_ref !== null) {
    throw new Error("repo_ref must not include @ref for freshness detection");
  }

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    repo_ref: parsed.repo_full_name,
  };
}

export class OctokitGitHubResolver implements GitHubResolver {
  private readonly octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit(
      token
        ? {
            auth: token,
          }
        : undefined,
    );
  }

  async getRepositoryMeta(repo: ParsedRepoRef): Promise<GitHubRepositoryMeta> {
    try {
      const response = await this.octokit.rest.repos.get({
        owner: repo.owner,
        repo: repo.repo,
      });

      return {
        owner: response.data.owner.login.toLowerCase(),
        repo: response.data.name.toLowerCase(),
        full_name: response.data.full_name.toLowerCase(),
        default_branch: response.data.default_branch,
      };
    } catch (error) {
      if (isHttpError(error, 404)) {
        throw new IngestResolverError(
          `Repository not found: ${repo.repo_full_name}`,
          "REPO_NOT_FOUND",
          error,
        );
      }

      throw new IngestResolverError(
        `Failed to load repository metadata: ${repo.repo_full_name}`,
        "INVALID_REPO",
        error,
      );
    }
  }

  async resolveRefToCommit(repo: ParsedRepoRef, ref: string): Promise<string> {
    try {
      const resolved = await this.octokit.rest.repos.getCommit({
        owner: repo.owner,
        repo: repo.repo,
        ref,
      });

      return resolved.data.sha;
    } catch (error) {
      if (isHttpError(error, 404)) {
        throw new IngestResolverError(
          `Unable to resolve ref '${ref}' for ${repo.repo_full_name}`,
          "REF_NOT_FOUND",
          error,
        );
      }

      throw new IngestResolverError(
        `Failed to resolve ref '${ref}' for ${repo.repo_full_name}`,
        "UNRESOLVED_REF",
        error,
      );
    }
  }

  async getRepositoryLanguages(repo: ParsedRepoRef): Promise<Record<string, number> | null> {
    try {
      const response = await this.octokit.rest.repos.listLanguages({
        owner: repo.owner,
        repo: repo.repo,
      });

      return response.data as Record<string, number>;
    } catch {
      return null;
    }
  }

  async getRepositoryReleases(
    repo: ParsedRepoRef,
    input: {
      since: string;
      per_page?: number;
      max_items?: number;
    },
  ): Promise<GitHubReleaseSummary[]> {
    const perPage = Math.max(1, Math.min(100, input.per_page ?? 100));
    const maxItems = Math.max(1, Math.min(500, input.max_items ?? 200));
    const releases: GitHubReleaseSummary[] = [];

    let page = 1;
    while (releases.length < maxItems) {
      const response = await this.octokit.rest.repos.listReleases({
        owner: repo.owner,
        repo: repo.repo,
        per_page: perPage,
        page,
      });

      const list = response.data ?? [];
      if (list.length === 0) {
        break;
      }

      for (const release of list) {
        const publishedAt = release.published_at ?? null;
        if (publishedAt && publishedAt < input.since) {
          continue;
        }

        releases.push({
          id: release.id,
          tag_name: release.tag_name,
          name: release.name ?? null,
          published_at: publishedAt,
          prerelease: Boolean(release.prerelease),
          draft: Boolean(release.draft),
          html_url: release.html_url ?? null,
        });

        if (releases.length >= maxItems) {
          break;
        }
      }

      if (list.length < perPage) {
        break;
      }

      page += 1;
    }

    return releases;
  }

  async getRepositoryTags(
    repo: ParsedRepoRef,
    input: {
      per_page?: number;
      max_items?: number;
    } = {},
  ): Promise<GitHubTagSummary[]> {
    const perPage = Math.max(1, Math.min(100, input.per_page ?? 100));
    const maxItems = Math.max(1, Math.min(500, input.max_items ?? 200));
    const tags: GitHubTagSummary[] = [];

    let page = 1;
    while (tags.length < maxItems) {
      const response = await this.octokit.rest.repos.listTags({
        owner: repo.owner,
        repo: repo.repo,
        per_page: perPage,
        page,
      });

      const list = response.data ?? [];
      if (list.length === 0) {
        break;
      }

      for (const tag of list) {
        tags.push({
          name: tag.name,
          commit_sha: tag.commit?.sha ?? null,
          tarball_url: tag.tarball_url ?? null,
          zipball_url: tag.zipball_url ?? null,
        });

        if (tags.length >= maxItems) {
          break;
        }
      }

      if (list.length < perPage) {
        break;
      }

      page += 1;
    }

    return tags;
  }
}

export async function resolveToCommitSha(
  repo: ParsedRepoRef,
  resolver: GitHubResolver,
): Promise<RefResolutionResult> {
  const normalizedRef = normalizeRef(repo.requested_ref);

  let metadata: GitHubRepositoryMeta;
  try {
    metadata = await resolver.getRepositoryMeta(repo);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new IngestResolverError("Unable to load repository metadata", "INVALID_REPO");
  }

  const refType = inferRefType(normalizedRef);
  const requestedRef =
    refType === "default"
      ? metadata.default_branch
      : normalizedRef;

  try {
    const commitSha = await resolver.resolveRefToCommit(
      {
        ...repo,
        requested_ref: normalizedRef,
      },
      requestedRef,
    );

    return {
      requested_ref: repo.requested_ref,
      requested_ref_type: refType,
      resolved_ref: requestedRef,
      commit_sha: commitSha.toLowerCase(),
      source_default_branch: metadata.default_branch,
    };
  } catch (error) {
    if (error instanceof IngestResolverError) {
      if (refType === "default") {
        throw error;
      }

      // If explicit ref fails, this is a hard failure for this ingest.
      throw error;
    }

    throw new IngestResolverError(
      `Failed to resolve ref for ${repo.repo_full_name}`,
      "UNRESOLVED_REF",
      error,
    );
  }
}

function isHttpError(error: unknown, status: number): boolean {
  return !!(
    error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status: unknown }).status === status
  );
}
