import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PlanContextSchema,
  type PlanContext,
} from "../contracts/chunked-generation";
import type { IngestRunArtifact } from "../ingestion/types";

const MAX_README_CHARS = 3000;
const MAX_FILES_PER_DIR = 30;

const SKIP_DIRS = new Set([".git", ".husky", "node_modules", "dist", ".next", "target"]);

interface FileEntry {
  relativePath: string;
  bytes: number;
}

// ── Repo profiling ──────────────────────────────────────────────────────────

type ProjectType =
  | "cli-tool"
  | "cli-server"
  | "server"
  | "web-app"
  | "library"
  | "native-system"
  | "project";

const LANG_KO_MAP: Record<string, string> = {
  "Go": "Go", "TypeScript": "TypeScript", "JavaScript": "JavaScript",
  "Python": "Python", "Rust": "Rust", "C": "C", "C++": "C++", "Java": "Java",
  "Kotlin": "Kotlin", "Swift": "Swift", "Ruby": "Ruby", "PHP": "PHP",
  "C#": "C#", "Dart": "Dart", "Elixir": "Elixir", "Scala": "Scala", "Zig": "Zig",
};

const DOMAIN_HINTS: Array<{ patterns: string[]; hintKo: string }> = [
  { patterns: ["model", "inference", "llm", "ai", "ml", "neural", "torch", "tensorflow"], hintKo: "AI/ML 모델 추론" },
  { patterns: ["runner", "scheduler", "executor", "orchestrat"], hintKo: "작업 실행 및 스케줄링" },
  { patterns: ["database", "db", "storage", "redis", "mongo", "sql", "cache", "kv"], hintKo: "데이터 저장소" },
  { patterns: ["network", "http", "grpc", "rpc", "protocol", "proxy", "gateway"], hintKo: "네트워크 통신" },
  { patterns: ["auth", "oauth", "credential", "token", "session"], hintKo: "인증 및 보안" },
  { patterns: ["container", "docker", "kubernetes", "k8s", "pod"], hintKo: "컨테이너 오케스트레이션" },
  { patterns: ["compiler", "parser", "ast", "lexer", "syntax", "lang"], hintKo: "언어 처리 및 컴파일" },
  { patterns: ["render", "ui", "component", "widget", "canvas", "graphics"], hintKo: "UI 렌더링" },
  { patterns: ["crypto", "encrypt", "hash", "cipher", "tls", "ssl"], hintKo: "암호화 및 보안" },
  { patterns: ["stream", "event", "queue", "message", "pubsub", "kafka"], hintKo: "이벤트/스트림 처리" },
  { patterns: ["api", "rest", "endpoint", "route", "handler"], hintKo: "API 서비스" },
  { patterns: ["agent", "tool", "prompt", "chain", "rag", "embed"], hintKo: "AI 에이전트" },
  { patterns: ["build", "bundle", "webpack", "vite", "rollup", "esbuild"], hintKo: "빌드 도구" },
  { patterns: ["plugin", "extension", "addon", "module", "hook"], hintKo: "플러그인 시스템" },
  { patterns: ["cli", "cmd", "command", "terminal", "shell"], hintKo: "명령줄 인터페이스" },
];

function detectPrimaryLanguage(languageMix: Record<string, number>): string {
  const entries = Object.entries(languageMix).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "Unknown";
  return entries[0][0];
}

function detectProjectType(topDirs: string[], primaryLang: string): ProjectType {
  const dirSet = new Set(topDirs.map((d) => d.toLowerCase()));

  const hasCli = dirSet.has("cmd") || dirSet.has("cli") || dirSet.has("bin");
  const hasServer = dirSet.has("server") || dirSet.has("api") || dirSet.has("routes");
  const hasWebApp = dirSet.has("app") || dirSet.has("pages") || dirSet.has("components") || dirSet.has("views");
  const hasLib = dirSet.has("lib") || dirSet.has("pkg") || dirSet.has("crate") || dirSet.has("packages");
  const isNative = ["C", "C++", "Zig", "Rust"].includes(primaryLang) && (dirSet.has("deps") || dirSet.has("vendor"));

  if (hasCli && hasServer) return "cli-server";
  if (hasCli) return "cli-tool";
  if (hasServer && hasWebApp) return "web-app";
  if (hasServer) return "server";
  if (hasWebApp) return "web-app";
  if (isNative) return "native-system";
  if (hasLib) return "library";
  return "project";
}

function detectDomainHint(topDirs: string[], keyPaths: string[]): string {
  const tokens = [
    ...topDirs.map((d) => d.toLowerCase()),
    ...keyPaths.flatMap((p) => p.toLowerCase().split("/")),
  ];

  let bestHint = "핵심 기능";
  let bestScore = 0;
  for (const { patterns, hintKo } of DOMAIN_HINTS) {
    const score = patterns.filter((p) => tokens.some((t) => t.includes(p))).length;
    if (score > bestScore) {
      bestScore = score;
      bestHint = hintKo;
    }
  }
  return bestHint;
}

// ── File scanning ───────────────────────────────────────────────────────────

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

async function collectFiles(rootPath: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  const walk = async (relativeDir: string): Promise<void> => {
    const absolute = path.join(rootPath, relativeDir);
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = dirents.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    for (const dirent of sorted) {
      if (dirent.name === "snapshot-manifest.json" || dirent.isSymbolicLink()) {
        continue;
      }

      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name.toLowerCase())) {
          continue;
        }
        await walk(path.join(relativeDir, dirent.name));
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      const filePath = normalizeRepoPath(path.join(relativeDir, dirent.name));
      try {
        const stat = await fs.stat(path.join(rootPath, filePath));
        entries.push({ relativePath: filePath, bytes: stat.size });
      } catch {
        // Skip unreadable files.
      }
    }
  };

  await walk(".");
  return entries;
}

// ── File tree builder ───────────────────────────────────────────────────────

interface FileTreeEntry {
  dir: string;
  files: string[];
  totalBytes: number;
}

function buildFileTree(files: FileEntry[]): FileTreeEntry[] {
  const byDir = new Map<string, { files: string[]; totalBytes: number }>();

  for (const file of files) {
    const parts = file.relativePath.split("/");
    const dir = parts.length > 1 ? parts[0] : ".";
    const entry = byDir.get(dir) ?? { files: [], totalBytes: 0 };
    entry.totalBytes += file.bytes;
    if (entry.files.length < MAX_FILES_PER_DIR) {
      entry.files.push(file.relativePath);
    }
    byDir.set(dir, entry);
  }

  return Array.from(byDir.entries())
    .map(([dir, data]) => ({ dir, files: data.files, totalBytes: data.totalBytes }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

// ── README reader ───────────────────────────────────────────────────────────

async function readReadmeExcerpt(snapshotPath: string): Promise<string> {
  const candidates = ["README.md", "readme.md", "Readme.md", "README.rst", "README.txt", "README"];
  for (const name of candidates) {
    try {
      const content = await fs.readFile(path.join(snapshotPath, name), "utf8");
      return content.slice(0, MAX_README_CHARS);
    } catch {
      // Try next candidate.
    }
  }
  return "";
}

// ── Main export ─────────────────────────────────────────────────────────────

function compareDeterministic(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

export async function planContext(artifact: IngestRunArtifact): Promise<PlanContext> {
  const files = await collectFiles(artifact.snapshot_path);
  const keyPaths = (artifact.metadata.key_paths ?? [])
    .map((value) => normalizeRepoPath(value))
    .filter((value) => value.length > 0)
    .sort(compareDeterministic);

  // Extract top-level directories
  const topDirSet = new Set<string>();
  for (const file of files) {
    const firstSegment = file.relativePath.split("/")[0];
    if (firstSegment && firstSegment !== file.relativePath) {
      topDirSet.add(firstSegment);
    }
  }
  const topDirs = Array.from(topDirSet).sort(compareDeterministic);

  // Build profile
  const primaryLanguage = detectPrimaryLanguage(artifact.metadata.language_mix);
  const projectType = detectProjectType(topDirs, primaryLanguage);
  const domainHint = detectDomainHint(topDirs, keyPaths);
  const repoRef = artifact.repo_ref;
  const repoName = repoRef.includes("/") ? repoRef.split("/")[1] : repoRef;
  const displayName = repoName.charAt(0).toUpperCase() + repoName.slice(1);

  // Read README
  const readmeExcerpt = await readReadmeExcerpt(artifact.snapshot_path);

  // Build file tree
  const fileTree = buildFileTree(files);

  const context: PlanContext = {
    artifactType: "plan-context",
    repoFullName: artifact.repo_ref.toLowerCase(),
    commitSha: artifact.commit_sha,
    ingestRunId: artifact.ingest_run_id,
    snapshotPath: artifact.snapshot_path,
    generatedAt: new Date().toISOString(),
    profile: {
      repoName: displayName,
      primaryLanguage,
      projectType,
      domainHint,
      topLevelDirs: topDirs,
      filesScanned: artifact.files_scanned,
    },
    readmeExcerpt,
    keyPaths,
    fileTree,
    constraints: {
      minSections: 4,
      maxSections: 6,
      minSubsectionsPerSection: 3,
      minBodyKoChars: 3000,
      requiredElements: ["mermaid-architecture"],
      sectionIdPattern: "sec-{N} where N starts at 1",
      subsectionIdPattern: "sub-{sectionN}-{subN} (e.g. sub-1-1, sub-1-2, sub-2-1)",
    },
  };

  return PlanContextSchema.parse(context);
}
