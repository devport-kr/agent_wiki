import { z } from "zod";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/;
const REPO_PATH_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*\s$).+/;

export const LineRangeSchema = z
  .object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.end < value.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "line range end must be greater than or equal to start",
        path: ["end"],
      });
    }
  });

export const CitationSchema = z
  .object({
    citationId: z.string().min(1),
    evidenceId: z.string().min(1),
    repoPath: z.string().regex(REPO_PATH_PATTERN),
    lineRange: LineRangeSchema,
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    permalink: z.string().url().optional(),
    rationale: z.string().min(1).optional(),
  })
  .strict();

export const ClaimSchema = z
  .object({
    claimId: z.string().min(1),
    sectionId: z.string().min(1),
    subsectionId: z.string().min(1),
    statementKo: z.string().min(20),
    citationIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const EvidenceChunkSchema = z
  .object({
    evidenceId: z.string().min(1),
    repoPath: z.string().regex(REPO_PATH_PATTERN),
    lineRange: LineRangeSchema,
    snippet: z.string().min(1),
    language: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    lexicalScore: z.number().min(0).max(1),
    semanticScore: z.number().min(0).max(1),
  })
  .strict();

export const SectionSubsectionPlanSchema = z
  .object({
    sectionId: z.string().min(1),
    subsectionId: z.string().min(1),
    titleKo: z.string().min(3),
    objectiveKo: z.string().min(10),
    targetEvidenceKinds: z.array(z.enum(["code", "config", "tests", "docs"])).min(1),
    targetCharacterCount: z.number().int().min(700),
  })
  .strict();

export const SectionPlanSectionSchema = z
  .object({
    sectionId: z.string().min(1),
    titleKo: z.string().min(3),
    summaryKo: z.string().min(10),
    subsections: z.array(SectionSubsectionPlanSchema).min(3),
  })
  .strict();

export const SectionCrossReferenceSchema = z
  .object({
    fromSectionId: z.string().min(1),
    toSectionId: z.string().min(1),
    relation: z.string().min(3),
  })
  .strict();

export const SectionPlanSchema = z
  .object({
    artifactType: z.literal("section-plan"),
    repoFullName: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    generatedAt: z.string().datetime(),
    overviewKo: z.string().min(30),
    sections: z.array(SectionPlanSectionSchema).min(6),
    crossReferences: z.array(SectionCrossReferenceSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sectionIds = new Set<string>();
    const subsectionIds = new Set<string>();

    for (const section of value.sections) {
      if (sectionIds.has(section.sectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate sectionId: ${section.sectionId}`,
          path: ["sections"],
        });
      }
      sectionIds.add(section.sectionId);

      for (const subsection of section.subsections) {
        if (subsection.sectionId !== section.sectionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "subsection.sectionId must match parent sectionId",
            path: ["sections"],
          });
        }

        const key = `${subsection.sectionId}:${subsection.subsectionId}`;
        if (subsectionIds.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate subsection key: ${key}`,
            path: ["sections"],
          });
        }
        subsectionIds.add(key);
      }
    }

    for (const reference of value.crossReferences) {
      if (!sectionIds.has(reference.fromSectionId) || !sectionIds.has(reference.toSectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cross reference must target existing section ids",
          path: ["crossReferences"],
        });
      }
    }
  });

export const DraftSubsectionSchema = z
  .object({
    sectionId: z.string().min(1),
    subsectionId: z.string().min(1),
    titleKo: z.string().min(3),
    bodyKo: z.string().min(80),
  })
  .strict();

export const DraftSectionSchema = z
  .object({
    sectionId: z.string().min(1),
    titleKo: z.string().min(3),
    summaryKo: z.string().min(20),
    subsections: z.array(DraftSubsectionSchema).min(3),
  })
  .strict();

export const SourceDocSchema = z
  .object({
    sourceId: z.string().min(1),
    path: z.string().regex(REPO_PATH_PATTERN),
  })
  .strict();

export const TrendFactSchema = z
  .object({
    factId: z.string().min(1),
    category: z.string().min(1),
    summaryKo: z.string().min(10),
  })
  .strict();

export const GroundingIssueSchema = z
  .object({
    code: z.enum([
      "MISSING_CITATION",
      "INVALID_PATH",
      "INVALID_LINE_RANGE",
      "UNRESOLVABLE_EVIDENCE",
      "SEMANTIC_MISMATCH",
      "LOW_SIGNAL_CITATION",
      "ANTI_TEMPLATE",
      "DUPLICATE_GENERIC_CITATION",
      "UNKNOWN",
    ]),
    message: z.string().min(1),
    claimId: z.string().min(1).optional(),
    citationId: z.string().min(1).optional(),
  })
  .strict();

export const TerminologyDiagnosticsSchema = z
  .object({
    consistencyScore: z.number().min(0).max(1),
    untranslatedTokenRatio: z.number().min(0).max(1),
    analyzedTokenCount: z.number().int().min(0),
    notes: z.array(z.string().min(1)),
  })
  .strict();

export const QualityScorecardSchema = z
  .object({
    semanticFaithfulness: z.number().min(0).max(1),
    conceptualDepth: z.number().min(0).max(1),
    operationalClarity: z.number().min(0).max(1),
    citationQuality: z.number().min(0).max(1),
    novelty: z.number().min(0).max(1),
  })
  .strict();

export const GroundingReportSchema = z
  .object({
    artifactType: z.literal("grounding-report"),
    gateId: z.enum(["GND-01", "GND-03", "GND-04"]),
    checkedAt: z.string().datetime(),
    passed: z.boolean(),
    totalClaims: z.number().int().min(0),
    claimsWithCitations: z.number().int().min(0),
    citationCoverage: z.number().min(0).max(1),
    issues: z.array(GroundingIssueSchema),
    diagnostics: TerminologyDiagnosticsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.claimsWithCitations > value.totalClaims) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "claimsWithCitations cannot exceed totalClaims",
        path: ["claimsWithCitations"],
      });
    }

    if (value.totalClaims === 0 && value.citationCoverage !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "citationCoverage must be 0 when totalClaims is 0",
        path: ["citationCoverage"],
      });
    }

    if (value.totalClaims > 0) {
      const expected = Number((value.claimsWithCitations / value.totalClaims).toFixed(6));
      const actual = Number(value.citationCoverage.toFixed(6));
      if (expected !== actual) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "citationCoverage must match claimsWithCitations / totalClaims",
          path: ["citationCoverage"],
        });
      }
    }
  });

export const WikiDraftArtifactSchema = z
  .object({
    artifactType: z.literal("wiki-draft"),
    repoFullName: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    generatedAt: z.string().datetime(),
    overviewKo: z.string().min(50),
    sections: z.array(DraftSectionSchema).min(6),
    sourceDocs: z.array(SourceDocSchema).min(1),
    trendFacts: z.array(TrendFactSchema).optional(),
    claims: z.array(ClaimSchema).min(1).optional(),
    citations: z.array(CitationSchema).min(1).optional(),
    groundingReport: GroundingReportSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sectionIds = new Set(value.sections.map((section) => section.sectionId));
    const subsectionIds = new Set<string>();

    for (const section of value.sections) {
      for (const subsection of section.subsections) {
        if (subsection.sectionId !== section.sectionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "draft subsection sectionId must match parent sectionId",
            path: ["sections"],
          });
        }
        subsectionIds.add(`${subsection.sectionId}:${subsection.subsectionId}`);
      }
    }

    const citations = value.citations ?? [];
    const claims = value.claims ?? [];

    const citationIds = new Set<string>();
    for (const citation of citations) {
      if (citationIds.has(citation.citationId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate citationId: ${citation.citationId}`,
          path: ["citations"],
        });
      }
      citationIds.add(citation.citationId);
    }

    for (const claim of claims) {
      if (!sectionIds.has(claim.sectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `claim references unknown sectionId: ${claim.sectionId}`,
          path: ["claims"],
        });
      }

      const subsectionKey = `${claim.sectionId}:${claim.subsectionId}`;
      if (!subsectionIds.has(subsectionKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `claim references unknown subsection: ${subsectionKey}`,
          path: ["claims"],
        });
      }

      for (const citationId of claim.citationIds) {
        if (!citationIds.has(citationId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `claim references unknown citationId: ${citationId}`,
            path: ["claims"],
          });
        }
      }
    }
  });

export type SectionPlan = z.infer<typeof SectionPlanSchema>;
export type EvidenceChunk = z.infer<typeof EvidenceChunkSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type GroundingIssue = z.infer<typeof GroundingIssueSchema>;
export type GroundingReport = z.infer<typeof GroundingReportSchema>;
export type WikiDraftArtifact = z.infer<typeof WikiDraftArtifactSchema>;
export type QualityScorecard = z.infer<typeof QualityScorecardSchema>;
export type SourceDoc = z.infer<typeof SourceDocSchema>;
export type TrendFact = z.infer<typeof TrendFactSchema>;
