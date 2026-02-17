import path from "node:path";

import { runDiscovery, type RunDiscoveryParams } from "./run";
import { runGitHubSearch } from "./search";
import { buildSearchQuery } from "./query";
import { TrackedRepositoryStore } from "./registry";

interface CliOptions {
  [key: string]: string | undefined;
}

function parseValue(value: string | undefined): string | undefined {
  if (!value || value.startsWith("--") || !value.length) {
    return undefined;
  }

  return value;
}

function parseLicenseOrTopics(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseIntValue(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current.startsWith("--")) {
      const [rawKey, rawValue] = current.split("=", 2);
      if (rawValue != null) {
        options[rawKey.slice(2)] = rawValue;
        continue;
      }

      const next = parseValue(argv[i + 1]);
      if (next != null) {
        i += 1;
        options[rawKey.slice(2)] = next;
      } else {
        options[rawKey.slice(2)] = "true";
      }
    }
  }

  return options;
}

function buildInputFromOptions(options: CliOptions) {
  return {
    category: options.category || "open-source",
    min_stars: parseIntValue(options.min_stars, 500),
    max_last_push_days: options.max_last_push_days
      ? Number.parseInt(options.max_last_push_days, 10)
      : undefined,
    licenses: parseLicenseOrTopics(options.licenses),
    topics: parseLicenseOrTopics(options.topics),
    per_page: parseIntValue(options.per_page, 30),
    page_limit: parseIntValue(options.page_limit, 3),
  };
}

function printSummary(label: string, value: unknown) {
  process.stdout.write(`${label}: ${JSON.stringify(value, null, 2)}\n`);
}

async function runCommand(input: ReturnType<typeof buildInputFromOptions>, options: CliOptions) {
  const runParams: RunDiscoveryParams = {
    input,
    registryStore: await TrackedRepositoryStore.create({
      snapshotPath: path.resolve(options.registry_path || ".planning/discovery-registry.json"),
      now: () => new Date().toISOString(),
    }),
    bootstrap: options.bootstrap === "true" || options.bootstrap === "1",
    bootstrapActiveTarget: parseIntValue(options.bootstrap_active_target, 50),
    queryProfileIdOverride: options.query_profile_id,
  };

  const result = await runDiscovery(runParams);
  printSummary("run", result);
}

async function searchCommand(input: ReturnType<typeof buildInputFromOptions>) {
  const query = buildSearchQuery(input);
  const result = await runGitHubSearch({
    input,
    queryOverride: query,
    now: new Date().toISOString(),
    maxTotalPages: 1,
  });

  printSummary("search", {
    query: query.query,
    query_profile_id: query.profile.query_profile_id,
    summary: {
      candidates_seen: result.candidates_seen,
      accepted: result.candidates.length,
      filtered_out: result.filtered_out,
    },
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  const input = buildInputFromOptions(options);

  if (command === "search") {
    await searchCommand(input);
    return;
  }

  if (command === "run" || command === undefined || command === "live-run") {
    await runCommand(input, options);
    return;
  }

  printSummary("help", {
    usage: [
      "node src/discovery/cli.ts search --category=web [--min_stars=500 ...]",
      "node src/discovery/cli.ts run --category=web [--bootstrap] [--registry_path=.planning/registry.json]",
    ],
  });
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
