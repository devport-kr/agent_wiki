import { z } from "zod";

import type { WikiDraftArtifact } from "../contracts/wiki-generation";
import type { GroundedAcceptedOutput } from "../contracts/grounded-output";

const PLACEHOLDER_PATTERN = /^(?:n\/?a|na|none|null|tbd|todo|미정|없음|-|_)$/i;

const KOREAN_ENGLISH_PAIR_PATTERN = /([가-힣][가-힣a-z0-9\s\-_/]{0,80}?)\s*\(\s*([a-z][a-z0-9\s\-_/]{1,80})\s*\)/gi;
const ENGLISH_KOREAN_PAIR_PATTERN = /([a-z][a-z0-9\s\-_/]{1,80})\s*\(\s*([가-힣][가-힣a-z0-9\s\-_/]{0,80}?)\s*\)/gi;

export const GlossaryEntrySchema = z
  .object({
    termKo: z.string().trim().min(1),
    termEn: z.string().trim().min(1),
    definition: z.string().trim().min(10),
  })
  .strict();

export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export interface GlossaryEntryInput {
  termKo?: string | null;
  termEn?: string | null;
  definition?: string | null;
}

export function buildGlossaryFromAcceptedOutput(acceptedOutput: GroundedAcceptedOutput): GlossaryEntry[] {
  return buildGlossaryFromDraft(acceptedOutput.draft);
}

export function buildGlossaryFromDraft(draft: WikiDraftArtifact): GlossaryEntry[] {
  const candidates: GlossaryEntryInput[] = [];
  for (const text of collectDraftText(draft)) {
    candidates.push(...extractGlossaryCandidatesFromText(text));
  }
  return normalizeGlossaryEntries(candidates);
}

export function normalizeGlossaryEntries(candidates: GlossaryEntryInput[]): GlossaryEntry[] {
  const canonicalEntries = new Map<string, GlossaryEntry>();

  for (const candidate of candidates) {
    const parsed = GlossaryEntrySchema.safeParse({
      termKo: normalizeTermKo(candidate.termKo),
      termEn: normalizeTermEn(candidate.termEn),
      definition: normalizeWhitespace(candidate.definition),
    });
    if (!parsed.success) {
      continue;
    }

    const normalized = parsed.data;
    if (
      isPlaceholder(normalized.termKo) ||
      isPlaceholder(normalized.termEn) ||
      isPlaceholder(normalized.definition)
    ) {
      continue;
    }

    const canonicalKey = toCanonicalEn(normalized.termEn);
    const existing = canonicalEntries.get(canonicalKey);

    if (!existing) {
      canonicalEntries.set(canonicalKey, normalized);
      continue;
    }

    canonicalEntries.set(canonicalKey, {
      termKo: pickLexicographicallyStable(existing.termKo, normalized.termKo),
      termEn: pickLexicographicallyStable(existing.termEn, normalized.termEn),
      definition: pickPreferredDefinition(existing.definition, normalized.definition),
    });
  }

  return Array.from(canonicalEntries.values()).sort(compareGlossaryEntry);
}

function collectDraftText(draft: WikiDraftArtifact): string[] {
  const texts: string[] = [draft.overviewKo];

  for (const section of draft.sections) {
    texts.push(section.titleKo, section.summaryKo);
    for (const subsection of section.subsections) {
      texts.push(subsection.titleKo, subsection.bodyKo);
    }
  }

  for (const claim of draft.claims) {
    texts.push(claim.statementKo);
  }

  for (const citation of draft.citations) {
    if (citation.rationale) {
      texts.push(citation.rationale);
    }
  }

  return texts;
}

function extractGlossaryCandidatesFromText(text: string): GlossaryEntryInput[] {
  const candidates: GlossaryEntryInput[] = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    candidates.push(...extractPairMatches(sentence, KOREAN_ENGLISH_PAIR_PATTERN));
    candidates.push(...extractPairMatches(sentence, ENGLISH_KOREAN_PAIR_PATTERN, true));
  }

  return candidates;
}

function extractPairMatches(
  sentence: string,
  pattern: RegExp,
  reverse = false,
): GlossaryEntryInput[] {
  const matches: GlossaryEntryInput[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);
  let match = regex.exec(sentence);

  while (match) {
    const left = normalizeWhitespace(match[1]);
    const right = normalizeWhitespace(match[2]);

    matches.push(
      reverse
        ? { termKo: right, termEn: left, definition: sentence }
        : { termKo: left, termEn: right, definition: sentence },
    );

    match = regex.exec(sentence);
  }

  return matches;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[\n\r]+|(?<=[.!?다])\s+/u)
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length > 0);
}

function toCanonicalKo(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9가-힣 ]/g, "").trim();
}

function toCanonicalEn(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

function pickPreferredDefinition(current: string, incoming: string): string {
  if (incoming.length > current.length) {
    return incoming;
  }
  if (incoming.length < current.length) {
    return current;
  }
  return pickLexicographicallyStable(current, incoming);
}

function pickLexicographicallyStable(left: string, right: string): string {
  return left.localeCompare(right, "en", { sensitivity: "base" }) <= 0 ? left : right;
}

function compareGlossaryEntry(left: GlossaryEntry, right: GlossaryEntry): number {
  const byEnglish = left.termEn.localeCompare(right.termEn, "en", {
    sensitivity: "base",
    numeric: true,
  });
  if (byEnglish !== 0) {
    return byEnglish;
  }

  return left.termKo.localeCompare(right.termKo, "ko", {
    sensitivity: "base",
    numeric: true,
  });
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTermKo(value: string | null | undefined): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) {
    return normalized;
  }

  let tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length > 3) {
    tokens = tokens.slice(tokens.length - 3);
  }

  while (tokens.length > 0 && /^(?:와|과|및|그리고|이|그|해당)$/u.test(tokens[0])) {
    tokens = tokens.slice(1);
  }

  if (tokens.length === 0) {
    return "";
  }

  const lastIndex = tokens.length - 1;
  tokens[lastIndex] = tokens[lastIndex].replace(/(은|는|이|가|을|를|와|과|의|에|에서|로|으로)$/u, "");
  return tokens.join(" ").trim();
}

function normalizeTermEn(value: string | null | undefined): string {
  return normalizeWhitespace(value).replace(/[.,;:]+$/g, "");
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value.trim());
}
