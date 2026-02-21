import { promises as fs } from "node:fs";
import path from "node:path";

import type { GitHubResolver } from "./github";
import type { ParsedRepoRef } from "./ref";
import { refreshSnapshotManifest } from "./trends";

const OFFICIAL_DOCS_DIR = "__devport__/official-docs";
const MAX_DISCOVERED_URLS = 20;
const MAX_MIRRORED_BYTES = 256_000;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/giu;
const RAW_URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+/giu;

type FetchLike = (
  url: string,
  init?: {
    redirect?: "follow" | "error" | "manual";
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface PersistOfficialDocsInput {
  snapshotPath: string;
  repo: ParsedRepoRef;
  resolver: GitHubResolver;
  commitSha: string;
  fetchImpl?: FetchLike;
}

interface OfficialDocIndexEntry {
  source_url: string;
  mirror_path: string | null;
  status: "mirrored" | "fetch-failed" | "fetch-unavailable";
}

export interface OfficialDocsArtifactsResult {
  index_path: string;
  discovered_count: number;
  mirrored_count: number;
  manifest_signature: string;
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function normalizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function loadRootReadme(snapshotPath: string): Promise<string> {
  const candidates = ["README.md", "README.MD", "Readme.md", "readme.md"];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(path.join(snapshotPath, candidate), "utf8");
    } catch {
      // continue
    }
  }
  return "";
}

function extractHttpUrls(text: string): string[] {
  const urls = new Set<string>();

  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const normalized = normalizeUrl(match[1]);
    if (normalized) {
      urls.add(normalized);
    }
  }

  for (const match of text.matchAll(RAW_URL_PATTERN)) {
    const normalized = normalizeUrl(match[0]);
    if (normalized) {
      urls.add(normalized);
    }
  }

  return [...urls]
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }))
    .slice(0, MAX_DISCOVERED_URLS);
}

function resolveFetchImpl(fetchImpl?: FetchLike): FetchLike | undefined {
  if (fetchImpl) {
    return fetchImpl;
  }

  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof globalFetch === "function") {
    return globalFetch;
  }

  return undefined;
}

async function mirrorUrlToSnapshot(
  snapshotPath: string,
  sourceUrl: string,
  index: number,
  fetchImpl: FetchLike | undefined,
): Promise<OfficialDocIndexEntry> {
  if (!fetchImpl) {
    return {
      source_url: sourceUrl,
      mirror_path: null,
      status: "fetch-unavailable",
    };
  }

  try {
    const response = await fetchImpl(sourceUrl, { redirect: "follow" });
    if (!response.ok) {
      return {
        source_url: sourceUrl,
        mirror_path: null,
        status: "fetch-failed",
      };
    }

    const rawText = await response.text();
    const text = rawText.slice(0, MAX_MIRRORED_BYTES);
    const mirrorRelativePath = normalizePath(
      path.join(OFFICIAL_DOCS_DIR, `doc-${String(index + 1).padStart(2, "0")}.md`),
    );
    const mirrorAbsolutePath = path.join(snapshotPath, mirrorRelativePath);

    await fs.mkdir(path.dirname(mirrorAbsolutePath), { recursive: true });
    await fs.writeFile(
      mirrorAbsolutePath,
      `# ${sourceUrl}\n\n${text}\n`,
      "utf8",
    );

    return {
      source_url: sourceUrl,
      mirror_path: mirrorRelativePath,
      status: "mirrored",
    };
  } catch {
    return {
      source_url: sourceUrl,
      mirror_path: null,
      status: "fetch-failed",
    };
  }
}

export async function persistOfficialDocsArtifacts(
  input: PersistOfficialDocsInput,
): Promise<OfficialDocsArtifactsResult> {
  const discoveryMode = (process.env.DEVPORT_OFFICIAL_DOC_DISCOVERY ?? "auto")
    .trim()
    .toLowerCase();

  const readmeContent = await loadRootReadme(input.snapshotPath);
  const discoveredUrls = discoveryMode === "off" ? [] : extractHttpUrls(readmeContent);

  let homepageUrl: string | null = null;
  if (discoveryMode !== "off") {
    try {
      const meta = await input.resolver.getRepositoryMeta(input.repo);
      homepageUrl = normalizeUrl(meta.homepage_url ?? "");
    } catch {
      homepageUrl = null;
    }
  }

  const discoveredWithHomepage = new Set(discoveredUrls);
  if (homepageUrl) {
    discoveredWithHomepage.add(homepageUrl);
  }

  const finalDiscoveredUrls = [...discoveredWithHomepage]
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }))
    .slice(0, MAX_DISCOVERED_URLS);

  const fetchImpl = discoveryMode === "off" ? undefined : resolveFetchImpl(input.fetchImpl);

  const docs: OfficialDocIndexEntry[] = [];
  for (let index = 0; index < finalDiscoveredUrls.length; index += 1) {
    docs.push(
      await mirrorUrlToSnapshot(
        input.snapshotPath,
        finalDiscoveredUrls[index],
        index,
        fetchImpl,
      ),
    );
  }

  const indexRelativePath = normalizePath(path.join(OFFICIAL_DOCS_DIR, "index.json"));
  const indexAbsolutePath = path.join(input.snapshotPath, indexRelativePath);
  await fs.mkdir(path.dirname(indexAbsolutePath), { recursive: true });
  await fs.writeFile(
    indexAbsolutePath,
    `${JSON.stringify(
      {
        repo_ref: input.repo.repo_full_name,
        commit_sha: input.commitSha,
        discovery_mode: discoveryMode,
        discovered_count: finalDiscoveredUrls.length,
        mirrored_count: docs.filter((entry) => entry.status === "mirrored").length,
        docs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const manifestSignature = await refreshSnapshotManifest(input.snapshotPath);

  return {
    index_path: indexRelativePath,
    discovered_count: finalDiscoveredUrls.length,
    mirrored_count: docs.filter((entry) => entry.status === "mirrored").length,
    manifest_signature: manifestSignature,
  };
}
