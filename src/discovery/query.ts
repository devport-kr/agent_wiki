import { createHash } from "node:crypto";
import {
  discoveryFilterInputSchema,
  type DiscoveryFilterInput,
} from "./types";

const CATEGORY_TOPIC_OVERRIDES: Record<string, string> = {
  "open-source": "open-source",
  open: "open-source",
  web: "javascript",
  frontend: "javascript",
  backend: "backend",
  devops: "devops",
  ml: "machine-learning",
  ai: "artificial-intelligence",
};

export interface SearchQueryOutput {
  query: string;
  profile: {
    query_profile_id: string;
    canonical_input: DiscoveryFilterInput;
  };
}

function dedupeLowercase(values: string[]): string[] {
  const normalized = values.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of normalized) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }

  return result.sort();
}

function normalizeCategory(category: string): string {
  const normalized = category.trim().toLowerCase();
  return CATEGORY_TOPIC_OVERRIDES[normalized] || normalized;
}

function formatDateFromDaysAgo(days: number, now = new Date()): string {
  const base = new Date(now.toISOString());
  base.setUTCDate(base.getUTCDate() - Math.max(0, days));
  return base.toISOString().slice(0, 10);
}

export function buildSearchQuery(rawInput: unknown, now = new Date()): SearchQueryOutput {
  const parsed = discoveryFilterInputSchema.parse(rawInput);
  const category = normalizeCategory(parsed.category);
  const topics = dedupeLowercase([ ...parsed.topics, category ]);
  const licenses = dedupeLowercase(parsed.licenses);

  const fragments: string[] = [];
  if (topics.length > 0) {
    fragments.push(...topics.map((topic) => `topic:${topic}`));
  }

  fragments.push(`stars:>=${parsed.min_stars}`);

  if (parsed.max_last_push_days) {
    fragments.push(`pushed:>=${formatDateFromDaysAgo(parsed.max_last_push_days, now)}`);
  }

  if (licenses.length === 1) {
    fragments.push(`license:${licenses[0]}`);
  } else if (licenses.length > 1) {
    fragments.push(`(${licenses.map((license) => `license:${license}`).join(" OR ")})`);
  }

  const canonicalInput: DiscoveryFilterInput = {
    ...parsed,
    category,
    topics,
    licenses,
  };

  const query = fragments.join(" ");
  const payload = JSON.stringify(canonicalInput);
  const query_profile_id = createHash("sha1").update(payload).digest("hex");

  return {
    query,
    profile: {
      query_profile_id,
      canonical_input: canonicalInput,
    },
  };
}
