import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ENV_FILES = [".env.local", ".env"] as const;

export interface EnvLoadResult {
  loadedFiles: string[];
  loadedKeys: string[];
}

export function loadEnvFiles(options: { cwd?: string; files?: string[] } = {}): EnvLoadResult {
  const cwd = options.cwd ?? process.cwd();
  const files = options.files ?? [...DEFAULT_ENV_FILES];

  const loadedFiles: string[] = [];
  const loadedKeys: string[] = [];

  for (const file of files) {
    const absolute = path.resolve(cwd, file);
    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    for (const line of source.split(/\r?\n/)) {
      const entry = parseEnvLine(line);
      if (!entry) {
        continue;
      }

      if (process.env[entry.key] !== undefined) {
        continue;
      }

      process.env[entry.key] = entry.value;
      loadedKeys.push(entry.key);
    }

    loadedFiles.push(absolute);
  }

  return {
    loadedFiles,
    loadedKeys,
  };
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const separatorIndex = withoutExport.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = withoutExport.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const rawValue = withoutExport.slice(separatorIndex + 1).trim();
  const value = unquote(rawValue);
  return { key, value };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}
