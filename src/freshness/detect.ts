import { Octokit } from "@octokit/rest";

import {
  FreshnessBaselineSchema,
  FreshnessChangedFileSchema,
  FreshnessDetectorOutcomeSchema,
  type FreshnessAmbiguityReason,
  type FreshnessBaseline,
  type FreshnessChangedFile,
  type FreshnessDetectorOutcome,
} from "../contracts/wiki-freshness";
import { normalizeGitHubRepoIdentityForResolver } from "../ingestion/github";

interface DetectFreshnessInput {
  repo_ref: string;
  baseline: FreshnessBaseline;
}

interface CompareFileLike {
  filename?: string;
  status?: string;
  previous_filename?: string;
}

interface CompareResponseLike {
  data: {
    status?: string;
    files?: CompareFileLike[];
  };
  headers?: {
    link?: string;
  };
}

interface RepoResolverClient {
  rest: {
    repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: { default_branch: string } }>;
      getBranch(params: { owner: string; repo: string; branch: string }): Promise<{ data: { commit: { sha: string } } }>;
      compareCommits(params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
        per_page: number;
        page: number;
      }): Promise<CompareResponseLike>;
    };
  };
}

interface FreshnessDetectorOptions {
  token?: string;
  client?: RepoResolverClient;
}

function createClient(token?: string): RepoResolverClient {
  return new Octokit(token ? { auth: token } : undefined) as RepoResolverClient;
}

function normalizeChangedPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function normalizeChangedFiles(files: CompareFileLike[] | undefined): {
  changed_files: FreshnessChangedFile[];
  changed_paths: string[];
  ambiguity_reasons: FreshnessAmbiguityReason[];
} {
  if (!Array.isArray(files)) {
    return {
      changed_files: [],
      changed_paths: [],
      ambiguity_reasons: ["COMPARE_FILE_LIST_MISSING"],
    };
  }

  const changedFiles: FreshnessChangedFile[] = [];
  const changedPaths = new Set<string>();
  const reasons = new Set<FreshnessAmbiguityReason>();

  for (const file of files) {
    const status = typeof file.status === "string" ? file.status : "";
    const filename = typeof file.filename === "string" ? normalizeChangedPath(file.filename) : "";
    const previousFilenameRaw = typeof file.previous_filename === "string" ? file.previous_filename : undefined;
    const previousFilename = previousFilenameRaw ? normalizeChangedPath(previousFilenameRaw) : undefined;

    if (!filename || !status) {
      reasons.add("COMPARE_FILE_ENTRY_INVALID");
      continue;
    }

    try {
      const parsed = FreshnessChangedFileSchema.parse({
        path: filename,
        status,
        previous_path: previousFilename,
      });
      changedFiles.push(parsed);
      changedPaths.add(filename);
      if (status === "renamed" && previousFilename) {
        changedPaths.add(previousFilename);
      }
    } catch {
      reasons.add("COMPARE_FILE_ENTRY_INVALID");
    }
  }

  const sortedFiles = changedFiles
    .slice()
    .sort((left, right) => {
      const pathOrder = left.path.localeCompare(right.path);
      if (pathOrder !== 0) {
        return pathOrder;
      }

      const previousOrder = (left.previous_path ?? "").localeCompare(right.previous_path ?? "");
      if (previousOrder !== 0) {
        return previousOrder;
      }

      return left.status.localeCompare(right.status);
    });

  return {
    changed_files: sortedFiles,
    changed_paths: [...changedPaths].sort((left, right) => left.localeCompare(right)),
    ambiguity_reasons: [...reasons].sort((left, right) => left.localeCompare(right)),
  };
}

function collectAmbiguityReasons(compare: CompareResponseLike): FreshnessAmbiguityReason[] {
  const reasons = new Set<FreshnessAmbiguityReason>();
  const status = compare.data.status;
  const files = compare.data.files;

  if (!Array.isArray(files)) {
    reasons.add("COMPARE_FILE_LIST_MISSING");
  }

  const linkHeader = compare.headers?.link ?? "";
  if (linkHeader.includes('rel="next"')) {
    reasons.add("COMPARE_PAGINATED");
  }

  if (Array.isArray(files) && files.length >= 300) {
    reasons.add("COMPARE_FILE_CAP_REACHED");
  }

  if (status === "diverged") {
    reasons.add("COMPARE_STATUS_DIVERGED");
  }

  if (typeof status !== "string" || status.length === 0) {
    reasons.add("COMPARE_STATUS_UNKNOWN");
  }

  return [...reasons].sort((left, right) => left.localeCompare(right));
}

export async function detectRepoFreshness(
  input: DetectFreshnessInput,
  options: FreshnessDetectorOptions = {},
): Promise<FreshnessDetectorOutcome> {
  const normalizedRepo = normalizeGitHubRepoIdentityForResolver(input.repo_ref);
  const baseline = FreshnessBaselineSchema.parse({
    ...input.baseline,
    repo_ref: normalizeGitHubRepoIdentityForResolver(input.baseline.repo_ref).repo_ref,
    last_delivery_commit: input.baseline.last_delivery_commit.toLowerCase(),
  });

  if (baseline.repo_ref !== normalizedRepo.repo_ref) {
    throw new Error("baseline.repo_ref must match detection repo_ref");
  }

  const client = options.client ?? createClient(options.token);

  const repository = await client.rest.repos.get({
    owner: normalizedRepo.owner,
    repo: normalizedRepo.repo,
  });
  const defaultBranch = repository.data.default_branch;

  const branch = await client.rest.repos.getBranch({
    owner: normalizedRepo.owner,
    repo: normalizedRepo.repo,
    branch: defaultBranch,
  });

  const headCommit = branch.data.commit.sha.toLowerCase();
  const baseCommit = baseline.last_delivery_commit.toLowerCase();

  if (headCommit === baseCommit) {
    return FreshnessDetectorOutcomeSchema.parse({
      mode: "noop",
      repo_ref: normalizedRepo.repo_ref,
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_paths: [],
      changed_files: [],
      ambiguity_reasons: [],
    });
  }

  const compare = await client.rest.repos.compareCommits({
    owner: normalizedRepo.owner,
    repo: normalizedRepo.repo,
    base: baseCommit,
    head: headCommit,
    per_page: 100,
    page: 1,
  });

  const normalizedFiles = normalizeChangedFiles(compare.data.files);
  const reasons = new Set<FreshnessAmbiguityReason>(collectAmbiguityReasons(compare));
  for (const reason of normalizedFiles.ambiguity_reasons) {
    reasons.add(reason);
  }

  const payload = {
    repo_ref: normalizedRepo.repo_ref,
    base_commit: baseCommit,
    head_commit: headCommit,
    changed_paths: normalizedFiles.changed_paths,
    changed_files: normalizedFiles.changed_files,
    ambiguity_reasons: [...reasons].sort((left, right) => left.localeCompare(right)),
  };

  if (payload.ambiguity_reasons.length > 0) {
    return FreshnessDetectorOutcomeSchema.parse({
      mode: "full-rebuild-required",
      ...payload,
    });
  }

  return FreshnessDetectorOutcomeSchema.parse({
    mode: "incremental-candidate",
    ...payload,
  });
}
