import {
  discoveryFilterInputSchema,
  repoCandidateSchema,
  type DiscoveryFilterInput,
  type DiscoverySearchResult,
  type GitHubRawRepoItem,
  type RepoCandidate,
} from "./types";
import { calculateQualityScore, rankCandidates } from "./quality";
import { buildSearchQuery, type SearchQueryOutput } from "./query";

interface GitHubSearchPageResponse {
  items: GitHubRawRepoItem[];
  total_count: number;
  incomplete_results?: boolean;
  rate_limit_remaining?: number;
  rate_limit_reset?: number;
}

interface RunGitHubSearchParams {
  input: unknown;
  queryOverride?: SearchQueryOutput;
  now?: string;
  maxTotalPages?: number;
  pageFetcher?: (params: {
    query: string;
    page: number;
    perPage: number;
  }) => Promise<GitHubSearchPageResponse>;
}

const FORBIDDEN_LICENSES = new Set([
  "gpl",
  "gpl-3.0",
  "agpl",
  "agpl-3.0",
  "sspl",
  "sspl-1.0",
  "lgpl",
  "lgpl-3.0",
]);

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeLicense(spdxId: string | null | undefined): string | null {
  if (!spdxId || spdxId.toLowerCase() === "other") {
    return null;
  }

  return spdxId.toLowerCase();
}

function normalizeCandidateFields(
  raw: GitHubRawRepoItem,
  input: DiscoveryFilterInput,
  profileId: string,
  referenceDateIso: string,
): RepoCandidate | "filtered" {
  const candidateWithScore = {
    id: raw.id,
    full_name: String(raw.full_name || "").trim(),
    default_branch: String(raw.default_branch || "").trim(),
    stars: raw.stargazers_count,
    pushed_at: String(raw.pushed_at || "").trim(),
    updated_at: String(raw.updated_at || "").trim(),
    language: raw.language == null ? null : String(raw.language).trim(),
    license: normalizeLicense(raw.license?.spdx_id),
    topics: Array.isArray(raw.topics)
      ? raw.topics.map((topic) => String(topic).toLowerCase().trim()).filter(Boolean)
      : [],
    homepage: raw.homepage == null ? "" : String(raw.homepage).trim(),
    description: raw.description == null ? null : String(raw.description).trim(),
    quality_score: 0,
    source_category: input.category,
    source_query_profile_id: profileId,
  };

  if (FORBIDDEN_LICENSES.has((candidateWithScore.license || "").toLowerCase())) {
    return "filtered";
  }

  if (candidateWithScore.full_name.indexOf("/") < 0) {
    return "filtered";
  }

  if (candidateWithScore.stars < input.min_stars) {
    return "filtered";
  }

    if (input.max_last_push_days != null) {
      const pushedAtMs = Date.parse(candidateWithScore.pushed_at);
      if (!Number.isFinite(pushedAtMs)) {
        return "filtered";
      }

      const ageDays = (Date.parse(referenceDateIso) - pushedAtMs) / 86400000;
      if (ageDays > input.max_last_push_days) {
        return "filtered";
      }
    }

  if (input.licenses.length > 0) {
    const normalizedLicense = (candidateWithScore.license || "").toLowerCase();
    if (!normalizedLicense || !input.licenses.includes(normalizedLicense)) {
      return "filtered";
    }
  }

  const withQuality = {
    ...candidateWithScore,
    quality_score: calculateQualityScore({
      full_name: candidateWithScore.full_name,
      stars: candidateWithScore.stars,
      pushed_at: candidateWithScore.pushed_at,
      updated_at: candidateWithScore.updated_at,
      license: candidateWithScore.license,
      topics: candidateWithScore.topics,
      source_category: candidateWithScore.source_category,
      quality_reference_iso: referenceDateIso,
    }),
  };

  const validated = repoCandidateSchema.safeParse(withQuality);
  if (!validated.success) {
    return "filtered";
  }

  return validated.data;
}

function createDefaultPageFetcher(token?: string) {
  return async ({ query, page, perPage }: { query: string; page: number; perPage: number }) => {
    const searchParams = new URLSearchParams({
      q: query,
      page: String(page),
      per_page: String(perPage),
      sort: "stars",
      order: "desc",
    });

    const response = await fetch(`https://api.github.com/search/repositories?${searchParams}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub search request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();

    return {
      items: (payload.items || []) as GitHubRawRepoItem[],
      total_count: Number(payload.total_count || 0),
      incomplete_results: Boolean(payload.incomplete_results),
      rate_limit_remaining: Number(response.headers.get("x-ratelimit-remaining") || 60),
      rate_limit_reset: Number(response.headers.get("x-ratelimit-reset") || 0),
    };
  };
}

export async function runGitHubSearch({
  input,
  queryOverride,
  now,
  maxTotalPages,
  pageFetcher,
}: RunGitHubSearchParams): Promise<DiscoverySearchResult> {
  const parsedInput = discoveryFilterInputSchema.parse(input);
  const { query, profile } = queryOverride ?? buildSearchQuery(parsedInput, now ? new Date(now) : new Date());

  const fetcher = pageFetcher || createDefaultPageFetcher(process.env.GITHUB_TOKEN);
  const pagesToFetch = Math.max(1, maxTotalPages || parsedInput.page_limit);
  const referenceDateIso = now || new Date().toISOString();

  let candidatesSeen = 0;
  let filteredOut = 0;
  let pagesFetched = 0;
  let candidates: RepoCandidate[] = [];

  for (let page = 1; page <= pagesToFetch; page += 1) {
    const response = await fetcher({ query, page, perPage: parsedInput.per_page });
    pagesFetched += 1;
    candidatesSeen += response.items.length;

    for (const item of response.items) {
      const normalized = normalizeCandidateFields(item, parsedInput, profile.query_profile_id, referenceDateIso);
      if (normalized === "filtered") {
        filteredOut += 1;
        continue;
      }

      candidates.push(normalized);
    }

    if (response.rate_limit_remaining !== undefined && response.rate_limit_remaining <= 0) {
      const delayMs = Math.max(0, response.rate_limit_reset * 1000 - Date.now());
      await sleep(Math.min(delayMs, 250));
    }

    if (
      !response.incomplete_results ||
      response.items.length < parsedInput.per_page ||
      response.items.length === 0 ||
      (response.total_count !== undefined && response.total_count <= candidatesSeen)
    ) {
      break;
    }
  }

  const ranked = rankCandidates(candidates);

  return {
    query_profile_id: profile.query_profile_id,
    query,
    candidates: ranked,
    candidates_seen: candidatesSeen,
    filtered_out: filteredOut,
    pages_fetched: pagesFetched,
  };
}

export type { RunGitHubSearchParams };
