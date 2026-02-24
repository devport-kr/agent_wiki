import { createHash } from "node:crypto";

import { ParsedRepoRef } from "./types";

const ALLOWED_SEGMENT = /^(?:[a-zA-Z0-9._-]+)$/;
const SHA_7 = /^[a-fA-F0-9]{7}$/;
const SHA_40 = /^[a-fA-F0-9]{40}$/;

export interface ParsedRepoInput {
  repo: string;
  ref?: string;
}

export function parseRepoRef(input: string): ParsedRepoRef {
  const trimmed = input.trim();
  const atSplit = trimmed.split("@");

  if (atSplit.length > 2) {
    throw new Error("Invalid repository reference format");
  }

  const repoPart = atSplit[0];
  const refPart = atSplit[1];

  if (!repoPart) {
    throw new Error("Missing repository path");
  }

  const repoSegments = repoPart.split("/");
  if (repoSegments.length !== 2) {
    throw new Error("Repository must be in owner/repo format");
  }

  const [owner, repo] = repoSegments;

  if (!ALLOWED_SEGMENT.test(owner) || !ALLOWED_SEGMENT.test(repo)) {
    throw new Error("Invalid owner/repo characters");
  }

  return {
    repo_full_name: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    requested_ref: refPart && refPart.trim().length ? refPart.trim() : null,
  };
}

export function normalizeRef(raw?: string | null): string | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed.length) {
    return null;
  }

  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.replace("refs/heads/", "");
  }

  return trimmed;
}

export function isLikelyCommitSha(value: string): boolean {
  return SHA_7.test(value) || SHA_40.test(value);
}

export function inferRefType(normalizedRef: string | null): "branch" | "sha" | "default" {
  if (!normalizedRef) {
    return "default";
  }

  return isLikelyCommitSha(normalizedRef) ? "sha" : "branch";
}

export function formatIngestKey({ owner, repo, commitSha }: { owner: string; repo: string; commitSha: string }): string {
  const normalized = `${owner.toLowerCase()}-${repo.toLowerCase()}-${commitSha.toLowerCase()}`;
  return createHash("sha1").update(normalized).digest("hex");
}

export function parseRepoInput(raw: ParsedRepoInput): ParsedRepoInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Repository input must be an object");
  }

  const parsedRepo = parseRepoRef(raw.repo);
  const normalizedRef = normalizeRef(raw.ref ?? parsedRepo.requested_ref);

  return {
    repo: parsedRepo.repo_full_name,
    ref: normalizedRef,
  };
}
