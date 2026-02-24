import { promises as fs } from "node:fs";
import path from "node:path";

import type { IngestMetadata } from "./types";

const DEFAULT_MAX_KEY_PATHS = 120;
const DEFAULT_MAX_EXTENSION_BUCKETS = 64;
const DEFAULT_MAX_LANGUAGE_BUCKETS = 32;
const NO_EXTENSION_LABEL = "[no_ext]";

interface RepoTreeFileEntry {
  path: string;
  bytes: number;
}

interface TreeSummary {
  total_files: number;
  total_directories: number;
  max_depth: number;
  by_extension: Record<string, number>;
}

interface ExtractMetadataOptions {
  manifestSignature: string;
  keyPathLimit?: number;
  extensionBucketLimit?: number;
  languageBucketLimit?: number;
  languageMix?: Record<string, number> | null;
}

const KEY_PATH_HINTS = [
  /^readme/i,
  /^license/i,
  /^changelog/i,
  /^dockerfile/i,
  /^package\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^package-lock\.json$/i,
  /^tsconfig\.json$/i,
  /^vite\.config\./i,
  /^jest\.config\./i,
  /^next\.config\./i,
  /^turbo\.json$/i,
  /^go\.mod$/i,
  /^pyproject\.toml$/i,
  /^Cargo\.toml$/i,
  /^requirements\.txt$/i,
  /^Pipfile$/i,
  /^pom\.xml$/i,
  /^build\.gradle$/i,
  /^gradle\.properties$/i,
  /^docker-compose\.ya?ml$/i,
  /^mkdocs\.ya?ml$/i,
  /^Makefile$/i,
].map((entry) => new RegExp(entry));

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function normalizeExtension(rawPath: string): string {
  const extension = path.extname(rawPath).toLowerCase().replace(/^\./, "");
  return extension || NO_EXTENSION_LABEL;
}

function sortedObject(input: Record<string, number>): Record<string, number> {
  return Object.keys(input)
    .sort()
    .reduce<Record<string, number>>((acc, key) => {
      acc[key] = input[key];
      return acc;
    }, {});
}

function truncateSortedObject(
  input: Record<string, number>,
  limit: number,
): Record<string, number> {
  const sortedKeys = Object.keys(input).sort();
  const bounded = sortedKeys.slice(0, Math.max(0, limit));

  return bounded.reduce<Record<string, number>>((acc, key) => {
    acc[key] = input[key];
    return acc;
  }, {});
}

function extensionToLanguage(extension: string): string {
  const ext = extension.toLowerCase();

  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    go: "Go",
    java: "Java",
    kt: "Kotlin",
    kts: "Kotlin",
    cs: "C#",
    cpp: "C++",
    cc: "C++",
    cxx: "C++",
    h: "C",
    c: "C",
    md: "Markdown",
    mdx: "Markdown",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    json: "JSON",
    xml: "XML",
    sh: "Shell",
    bash: "Shell",
    dockerfile: "Dockerfile",
    php: "PHP",
    swift: "Swift",
    scala: "Scala",
    dart: "Dart",
  };

  return map[ext] ?? "Other";
}

function collectTree(rootPath: string): Promise<RepoTreeFileEntry[]> {
  const entries: RepoTreeFileEntry[] = [];
  const skipDirs = new Set([".git", ".husky", "node_modules", "dist", ".next", "target"]);

  const walk = async (relative: string): Promise<void> => {
    const absolute = path.join(rootPath, relative);
    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    const sorted = dirents.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirent of sorted) {
      if (dirent.name === "snapshot-manifest.json") {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        continue;
      }

      if (dirent.isDirectory()) {
        if (skipDirs.has(dirent.name.toLowerCase())) {
          continue;
        }

        await walk(path.join(relative, dirent.name));
        continue;
      }

      if (dirent.isFile()) {
        const filePath = path.join(relative, dirent.name);
        const stat = await fs.stat(path.join(rootPath, filePath));
        entries.push({ path: normalizePath(filePath), bytes: stat.size });
      }
    }
  };

  return walk(".").then(() => entries);
}

function calculateSummary(entries: RepoTreeFileEntry[], extensionBucketLimit: number): TreeSummary {
  const byExtension: Record<string, number> = {};
  let totalDirectories = 0;
  let maxDepth = 0;

  for (const entry of entries) {
    const extension = normalizeExtension(entry.path);
    byExtension[extension] = (byExtension[extension] ?? 0) + 1;

    const segments = entry.path.split("/");
    totalDirectories += segments.length > 1 ? segments.length - 1 : 0;
    maxDepth = Math.max(maxDepth, segments.length);
  }

  const maxTotalDirectories = entries.length > 0 ? totalDirectories : 0;

  return {
    total_files: entries.length,
    total_directories: maxTotalDirectories,
    max_depth: maxDepth,
    by_extension: truncateSortedObject(byExtension, extensionBucketLimit),
  };
}

function buildKeyPaths(entries: RepoTreeFileEntry[], maxCount: number): string[] {
  const keyPaths = new Set<string>();
  const seenDirectories = new Set<string>();

  for (const entry of entries) {
    const basename = path.basename(entry.path);
    if (!basename || basename.startsWith(".")) {
      continue;
    }

    const depthSegments = entry.path.split("/");
    if (depthSegments.length > 1) {
      seenDirectories.add(depthSegments[0]);
    }

    if (KEY_PATH_HINTS.some((pattern) => pattern.test(basename))) {
      keyPaths.add(entry.path);
    }
  }

  for (const dir of ["src", "packages", "apps", "docs", "examples", "test", "tests", "scripts", "tools", "config"]) {
    if (seenDirectories.has(dir)) {
      keyPaths.add(dir);
    }
  }

  return Array.from(keyPaths).sort().slice(0, maxCount);
}

function deriveLanguageMix(
  entries: RepoTreeFileEntry[],
  manifestLanguageMix: Record<string, number> | null | undefined,
  languageBucketLimit: number,
): Record<string, number> {
  if (manifestLanguageMix && Object.keys(manifestLanguageMix).length > 0) {
    const sanitized = Object.entries(manifestLanguageMix).reduce<Record<string, number>>((acc, [name, bytes]) => {
      if (typeof name !== "string" || !name.trim().length) {
        return acc;
      }

      if (!Number.isFinite(bytes) || bytes < 0) {
        return acc;
      }

      acc[name] = bytes;
      return acc;
    }, {});

    return truncateSortedObject(sanitized, languageBucketLimit);
  }

  const byLanguage: Record<string, number> = {};
  for (const entry of entries) {
    const language = extensionToLanguage(normalizeExtension(entry.path));
    byLanguage[language] = (byLanguage[language] ?? 0) + entry.bytes;
  }

  return truncateSortedObject(byLanguage, languageBucketLimit);
}

function totalBytes(entries: RepoTreeFileEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

export async function extractMetadata(
  snapshotPath: string,
  options: ExtractMetadataOptions,
): Promise<IngestMetadata> {
  const files = await collectTree(snapshotPath);
  const summary = calculateSummary(
    files,
    options.extensionBucketLimit ?? DEFAULT_MAX_EXTENSION_BUCKETS,
  );
  const keyPaths = buildKeyPaths(files, options.keyPathLimit ?? DEFAULT_MAX_KEY_PATHS);
  const languageMix = deriveLanguageMix(
    files,
    options.languageMix,
    options.languageBucketLimit ?? DEFAULT_MAX_LANGUAGE_BUCKETS,
  );

  return {
    tree_summary: {
      total_files: summary.total_files,
      total_directories: summary.total_directories,
      max_depth: summary.max_depth,
      by_extension: summary.by_extension,
    },
    language_mix: languageMix,
    key_paths: keyPaths,
    files_scanned: files.length,
    total_bytes: totalBytes(files),
    manifest_signature: options.manifestSignature,
  };
}

export type { ExtractMetadataOptions, RepoTreeFileEntry, TreeSummary };
