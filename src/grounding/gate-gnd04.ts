import {
  GroundingIssueSchema,
  GroundingReportSchema,
  type GroundingIssue,
  type WikiDraftArtifact,
} from "../contracts/wiki-generation";

export interface Gnd04ValidationInput {
  draft: WikiDraftArtifact;
  checkedAt?: string;
}

export interface Gnd04ValidationResult {
  report: ReturnType<typeof GroundingReportSchema.parse>;
}

export interface StrictQualitySectionInput {
  sectionId: string;
  subsections: Array<{
    subsectionId: string;
    bodyKo: string;
  }>;
}

export interface StrictQualityClaimInput {
  claimId: string;
  statementKo: string;
  citationIds: string[];
}

export interface StrictQualityCitationInput {
  citationId: string;
  repoPath: string;
  rationale?: string;
}

export interface StrictQualityInput {
  sections: StrictQualitySectionInput[];
  claims: StrictQualityClaimInput[];
  citations: StrictQualityCitationInput[];
}

const LOW_SIGNAL_PATH_PATTERN = /(\/|^)(readme|license|changelog)(\.|$)|^docs\/vendor\//i;
const ANTI_TEMPLATE_PHRASES = ["템플릿", "반복 설명", "깊게 다루지 않습니다"];

export function collectGnd04Issues(input: StrictQualityInput): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const citationsById = new Map(input.citations.map((citation) => [citation.citationId, citation] as const));

  // 1) Strict semantic alignment (claim tokens must overlap cited context tokens)
  for (const claim of input.claims) {
    const claimTokens = tokenize(claim.statementKo).filter((token) => token.length >= 3);
    const contextTokens = claim.citationIds
      .map((citationId) => citationsById.get(citationId))
      .filter((citation): citation is StrictQualityCitationInput => Boolean(citation))
      .flatMap((citation) => tokenize(`${citation.repoPath} ${citation.rationale ?? ""}`));

    const contextSet = new Set(contextTokens);
    const overlap = claimTokens.filter((token) => contextSet.has(token));
    const denominator = Math.max(1, claimTokens.length);
    const overlapRatio = overlap.length / denominator;

    if (overlapRatio < 0.15) {
      issues.push(
        buildIssue({
          code: "SEMANTIC_MISMATCH",
          claimId: claim.claimId,
          message: `Claim ${claim.claimId} has insufficient semantic overlap with cited context (${overlap.length}/${claimTokens.length}).`,
        }),
      );
    }
  }

  // 2) Anti-template detection (normalized subsection bodies collapse to same scaffold)
  const canonicalBodies = new Map<string, string[]>();
  for (const section of input.sections) {
    for (const subsection of section.subsections) {
      const canonical = normalizeTemplateBody(subsection.bodyKo);
      const existing = canonicalBodies.get(canonical) ?? [];
      existing.push(`${section.sectionId}:${subsection.subsectionId}`);
      canonicalBodies.set(canonical, existing);
    }
  }

  for (const [canonical, locations] of canonicalBodies.entries()) {
    if (locations.length < 2) {
      continue;
    }

    const looksTemplateLike = ANTI_TEMPLATE_PHRASES.some((phrase) => canonical.includes(phrase));
    if (looksTemplateLike || canonical.length < 140) {
      issues.push(
        buildIssue({
          code: "ANTI_TEMPLATE",
          message: `Template-like scaffold is repeated across subsections: ${locations.join(", ")}`,
        }),
      );
      break;
    }
  }

  // 3) Citation quality (block high concentration of low-signal paths)
  const lowSignalCitations = input.citations.filter((citation) => LOW_SIGNAL_PATH_PATTERN.test(citation.repoPath));
  const lowSignalRatio = input.citations.length === 0 ? 0 : lowSignalCitations.length / input.citations.length;
  if (lowSignalRatio > 0.5) {
    issues.push(
      buildIssue({
        code: "LOW_SIGNAL_CITATION",
        message: `Low-signal citations exceed threshold (${lowSignalCitations.length}/${input.citations.length}).`,
      }),
    );
  }

  return issues;
}

export function runGnd04Validation(input: Gnd04ValidationInput): Gnd04ValidationResult {
  const claims = input.draft.claims ?? [];
  const citations = input.draft.citations ?? [];

  const issues = collectGnd04Issues({
    sections: input.draft.sections.map((section) => ({
      sectionId: section.sectionId,
      subsections: section.subsections.map((subsection) => ({
        subsectionId: subsection.subsectionId,
        bodyKo: subsection.bodyKo,
      })),
    })),
    claims: claims.map((claim) => ({
      claimId: claim.claimId,
      statementKo: claim.statementKo,
      citationIds: claim.citationIds,
    })),
    citations: citations.map((citation) => ({
      citationId: citation.citationId,
      repoPath: citation.repoPath,
      rationale: citation.rationale,
    })),
  });

  const totalClaims = claims.length;
  const claimsWithCitations = claims.filter((claim) => claim.citationIds.length > 0).length;
  const citationCoverage = totalClaims === 0 ? 0 : Number((claimsWithCitations / totalClaims).toFixed(6));

  return {
    report: GroundingReportSchema.parse({
      artifactType: "grounding-report",
      gateId: "GND-04",
      checkedAt: input.checkedAt ?? new Date().toISOString(),
      passed: issues.length === 0,
      totalClaims,
      claimsWithCitations,
      citationCoverage,
      issues,
    }),
  };
}

function normalizeTemplateBody(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,:;!?()\[\]{}"'`-]/g, "")
    .trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_\u3131-\u318e\uac00-\ud7a3]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function buildIssue(input: {
  code: GroundingIssue["code"];
  message: string;
  claimId?: string;
  citationId?: string;
}): GroundingIssue {
  return GroundingIssueSchema.parse(input);
}
