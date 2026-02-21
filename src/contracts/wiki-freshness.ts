import { z } from "zod";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/;
const REPO_REF_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const REPO_PATH_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*\s$).+/;

export const FreshnessRepoRefSchema = z.string().trim().regex(REPO_REF_PATTERN);

export const FreshnessSectionEvidenceSchema = z
  .object({
    sectionId: z.string().trim().min(1),
    repoPaths: z.array(z.string().trim().regex(REPO_PATH_PATTERN)).min(1),
  })
  .strict();

export const FreshnessBaselineSchema = z
  .object({
    repo_ref: FreshnessRepoRefSchema,
    last_delivery_commit: z.string().trim().regex(COMMIT_SHA_PATTERN),
    etag: z.string().trim().min(1).optional(),
    sectionEvidenceIndex: z.array(FreshnessSectionEvidenceSchema).default([]),
  })
  .strict();

export const FreshnessStateFileSchema = z
  .object({
    schema_version: z.literal(1),
    repos: z.record(FreshnessRepoRefSchema, FreshnessBaselineSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [repoKey, baseline] of Object.entries(value.repos)) {
      if (repoKey !== baseline.repo_ref) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "repo map key must match baseline.repo_ref",
          path: ["repos", repoKey, "repo_ref"],
        });
      }
    }
  });

export const ChangedFileStatusSchema = z.enum([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

export const FreshnessChangedFileSchema = z
  .object({
    path: z.string().trim().min(1),
    status: ChangedFileStatusSchema,
    previous_path: z.string().trim().min(1).optional(),
  })
  .strict();

export const FreshnessAmbiguityReasonSchema = z.enum([
  "COMPARE_FILE_LIST_MISSING",
  "COMPARE_PAGINATED",
  "COMPARE_FILE_CAP_REACHED",
  "COMPARE_STATUS_DIVERGED",
  "COMPARE_STATUS_UNKNOWN",
  "COMPARE_FILE_ENTRY_INVALID",
]);

const DetectorBaseSchema = z
  .object({
    repo_ref: FreshnessRepoRefSchema,
    base_commit: z.string().trim().regex(COMMIT_SHA_PATTERN),
    head_commit: z.string().trim().regex(COMMIT_SHA_PATTERN),
    changed_paths: z.array(z.string().trim().min(1)),
  })
  .strict();

export const FreshnessNoopOutcomeSchema = DetectorBaseSchema.extend({
  mode: z.literal("noop"),
  changed_files: z.array(FreshnessChangedFileSchema).length(0),
  ambiguity_reasons: z.array(FreshnessAmbiguityReasonSchema).length(0),
});

export const FreshnessIncrementalCandidateOutcomeSchema = DetectorBaseSchema.extend({
  mode: z.literal("incremental-candidate"),
  changed_files: z.array(FreshnessChangedFileSchema).min(1),
  ambiguity_reasons: z.array(FreshnessAmbiguityReasonSchema).length(0),
});

export const FreshnessFullRebuildRequiredOutcomeSchema = DetectorBaseSchema.extend({
  mode: z.literal("full-rebuild-required"),
  changed_files: z.array(FreshnessChangedFileSchema),
  ambiguity_reasons: z.array(FreshnessAmbiguityReasonSchema).min(1),
});

export const FreshnessDetectorOutcomeSchema = z.union([
  FreshnessNoopOutcomeSchema,
  FreshnessIncrementalCandidateOutcomeSchema,
  FreshnessFullRebuildRequiredOutcomeSchema,
]);

export type FreshnessBaseline = z.infer<typeof FreshnessBaselineSchema>;
export type FreshnessStateFile = z.infer<typeof FreshnessStateFileSchema>;
export type FreshnessChangedFile = z.infer<typeof FreshnessChangedFileSchema>;
export type FreshnessDetectorOutcome = z.infer<typeof FreshnessDetectorOutcomeSchema>;
export type FreshnessAmbiguityReason = z.infer<typeof FreshnessAmbiguityReasonSchema>;
