import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { get_encoding } from "@dqbd/tiktoken";

const DEFAULT_MAX_TOKENS = 220;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".css": "CSS",
  ".go": "Go",
  ".java": "Java",
  ".js": "JavaScript",
  ".json": "JSON",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".mjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".sh": "Shell",
  ".sql": "SQL",
  ".swift": "Swift",
  ".toml": "TOML",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".txt": "Text",
  ".xml": "XML",
  ".yaml": "YAML",
  ".yml": "YAML",
};

export interface SnapshotChunk {
  chunk_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  text: string;
  normalized_text: string;
  token_count: number;
}

export interface ChunkSnapshotInput {
  snapshotPath: string;
  maxTokens?: number;
}

export function chunkSnapshot(input: ChunkSnapshotInput): SnapshotChunk[] {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const files = listSnapshotFiles(input.snapshotPath);
  const tokenizer = get_encoding("cl100k_base");
  const chunks: SnapshotChunk[] = [];

  try {
    for (const absolutePath of files) {
      const relativePath = relative(input.snapshotPath, absolutePath).replaceAll("\\", "/");
      const language = inferLanguage(relativePath);
      const source = readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
      const lines = source.split("\n");

      let startLine = 1;
      let endLine = 0;
      let tokenCount = 0;
      let selectedLines: string[] = [];

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const normalizedLine = normalizeText(line);
        const lineTokens = tokenizer.encode(normalizedLine).length;

        if (selectedLines.length > 0 && tokenCount + lineTokens > maxTokens) {
          chunks.push(
            buildChunk({
              filePath: relativePath,
              startLine,
              endLine,
              language,
              lines: selectedLines,
              tokenCount,
            }),
          );
          selectedLines = [];
          tokenCount = 0;
          startLine = index + 1;
          endLine = index;
        }

        selectedLines.push(line);
        tokenCount += lineTokens;
        endLine = index + 1;
      }

      if (selectedLines.length > 0) {
        chunks.push(
          buildChunk({
            filePath: relativePath,
            startLine,
            endLine,
            language,
            lines: selectedLines,
            tokenCount,
          }),
        );
      }
    }
  } finally {
    tokenizer.free();
  }

  return chunks;
}

function buildChunk(input: {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  lines: string[];
  tokenCount: number;
}): SnapshotChunk {
  const text = input.lines.join("\n");
  const normalizedText = normalizeText(text);
  const chunkId = createHash("sha1")
    .update(`${input.filePath}|${input.startLine}|${input.endLine}|${normalizedText}`)
    .digest("hex");

  return {
    chunk_id: chunkId,
    file_path: input.filePath,
    start_line: input.startLine,
    end_line: input.endLine,
    language: input.language,
    text,
    normalized_text: normalizedText,
    token_count: input.tokenCount,
  };
}

function listSnapshotFiles(snapshotPath: string): string[] {
  const output: string[] = [];
  const stack = [snapshotPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stats = statSync(absolutePath);
      if (stats.size === 0 || stats.size > 256_000) {
        continue;
      }

      output.push(absolutePath);
    }
  }

  return output.sort((a, b) => a.localeCompare(b));
}

function inferLanguage(path: string): string {
  const extensionIndex = path.lastIndexOf(".");
  if (extensionIndex < 0) {
    return "Text";
  }

  const extension = path.slice(extensionIndex).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "Text";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
