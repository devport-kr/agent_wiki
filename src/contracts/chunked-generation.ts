import { z } from "zod";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/;
const REPO_REF_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

// ── SectionPlanOutput ─────────────────────────────────────────────────────────
// Output of `plan-sections`. Per-section file focus lists for chunked generation.

export const ChunkedSubsectionPlanSchema = z
  .object({
    subsectionId: z.string().min(1),
    titleKo: z.string().min(3),
    objectiveKo: z.string().min(10),
    targetEvidenceKinds: z.array(z.enum(["code", "config", "tests", "docs"])).min(1),
    targetCharacterCount: z.number().int().min(700),
  })
  .strict();

export const ChunkedSectionPlanEntrySchema = z
  .object({
    sectionId: z.string().min(1),
    titleKo: z.string().min(3),
    summaryKo: z.string().min(10),
    focusPaths: z.array(z.string().min(1)),
    subsectionCount: z.number().int().min(3),
    subsections: z.array(ChunkedSubsectionPlanSchema).min(3),
  })
  .strict();

export const SectionPlanCrossReferenceSchema = z
  .object({
    fromSectionId: z.string().min(1),
    toSectionId: z.string().min(1),
    relation: z.string().min(3),
  })
  .strict();

export const SectionPlanOutputSchema = z
  .object({
    artifactType: z.literal("chunked-section-plan"),
    repoFullName: z.string().regex(REPO_REF_PATTERN),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    ingestRunId: z.string().min(1),
    snapshotPath: z.string().min(1),
    generatedAt: z.string().datetime(),
    overviewKo: z.string().min(30),
    totalSections: z.number().int().min(6),
    sections: z.array(ChunkedSectionPlanEntrySchema).min(6),
    crossReferences: z.array(SectionPlanCrossReferenceSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.totalSections !== value.sections.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `totalSections (${value.totalSections}) must match sections array length (${value.sections.length})`,
        path: ["totalSections"],
      });
    }

    const sectionIds = new Set<string>();
    for (const section of value.sections) {
      if (sectionIds.has(section.sectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate sectionId: ${section.sectionId}`,
          path: ["sections"],
        });
      }
      sectionIds.add(section.sectionId);

      if (section.subsectionCount !== section.subsections.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `section ${section.sectionId}: subsectionCount (${section.subsectionCount}) must match subsections length (${section.subsections.length})`,
          path: ["sections"],
        });
      }

      const subsectionIds = new Set<string>();
      for (const sub of section.subsections) {
        if (subsectionIds.has(sub.subsectionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate subsectionId: ${sub.subsectionId} in section ${section.sectionId}`,
            path: ["sections"],
          });
        }
        subsectionIds.add(sub.subsectionId);
      }
    }

    for (const ref of value.crossReferences) {
      if (!sectionIds.has(ref.fromSectionId) || !sectionIds.has(ref.toSectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cross reference targets non-existent section id`,
          path: ["crossReferences"],
        });
      }
    }
  });

// ── SectionOutput ─────────────────────────────────────────────────────────────
// What the AI writes per section (input to `persist-section`).

export const SectionOutputSubsectionSchema = z
  .object({
    sectionId: z.string().min(1),
    subsectionId: z.string().min(1),
    titleKo: z.string().min(3),
    bodyKo: z.string().min(80),
  })
  .strict();

export const SectionOutputClaimSchema = z
  .object({
    claimId: z.string().min(1),
    sectionId: z.string().min(1),
    subsectionId: z.string().min(1),
    statementKo: z.string().min(20),
    citationIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const SectionOutputCitationSchema = z
  .object({
    citationId: z.string().min(1),
    evidenceId: z.string().min(1),
    repoPath: z.string().min(1),
    lineRange: z.object({
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    }).strict().refine((v) => v.end >= v.start, { message: "lineRange.end must be >= start" }),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    permalink: z.string().url(),
    rationale: z.string().min(1),
  })
  .strict();

export const SectionOutputSchema = z
  .object({
    sectionId: z.string().min(1),
    titleKo: z.string().min(3),
    summaryKo: z.string().min(20),
    sourcePaths: z.array(z.string().min(1)).min(1),
    subsections: z.array(SectionOutputSubsectionSchema).min(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Validate subsection sectionId matches parent
    for (const sub of value.subsections) {
      if (sub.sectionId !== value.sectionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsection ${sub.subsectionId} sectionId "${sub.sectionId}" must match parent "${value.sectionId}"`,
          path: ["subsections"],
        });
      }
    }

    const seenSourcePaths = new Set<string>();
    for (const sourcePath of value.sourcePaths) {
      if (seenSourcePaths.has(sourcePath)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate sourcePath: ${sourcePath}`,
          path: ["sourcePaths"],
        });
      }
      seenSourcePaths.add(sourcePath);
    }
  });

// ── ChunkedSession ────────────────────────────────────────────────────────────
// Tracks progress across sections.

export const ChunkedSectionStatusSchema = z
  .object({
    status: z.enum(["pending", "persisted"]),
    sectionOutputPath: z.string().min(1).optional(),
    persistedAt: z.string().datetime().optional(),
    chunksInserted: z.number().int().nonnegative().optional(),
    claimCount: z.number().int().nonnegative().optional(),
    citationCount: z.number().int().nonnegative().optional(),
    subsectionCount: z.number().int().nonnegative().optional(),
    koreanChars: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ChunkedSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    repoFullName: z.string().regex(REPO_REF_PATTERN),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    ingestRunId: z.string().min(1),
    planPath: z.string().min(1),
    startedAt: z.string().datetime(),
    sections: z.record(z.string(), ChunkedSectionStatusSchema),
  })
  .strict();

// ── Type exports ──────────────────────────────────────────────────────────────

export type SectionPlanOutput = z.infer<typeof SectionPlanOutputSchema>;
export type ChunkedSectionPlanEntry = z.infer<typeof ChunkedSectionPlanEntrySchema>;
export type ChunkedSubsectionPlan = z.infer<typeof ChunkedSubsectionPlanSchema>;
export type SectionOutput = z.infer<typeof SectionOutputSchema>;
export type SectionOutputCitation = z.infer<typeof SectionOutputCitationSchema>;
export type SectionOutputClaim = z.infer<typeof SectionOutputClaimSchema>;
export type ChunkedSession = z.infer<typeof ChunkedSessionSchema>;
export type ChunkedSectionStatus = z.infer<typeof ChunkedSectionStatusSchema>;
