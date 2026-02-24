import { z } from "zod";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/;
const REPO_FULL_NAME_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

function normalizeAnchor(value: string): string {
  const anchor = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9가-힣-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return anchor;
}

const RequiredSectionTextSchema = z.string().trim().min(1);

const DeliveryProjectIdentitySchema = z
  .object({
    repoFullName: z.string().trim().regex(REPO_FULL_NAME_PATTERN),
    commitSha: z.string().trim().regex(COMMIT_SHA_PATTERN),
    ingestRunId: z.string().trim().min(1).optional(),
  })
  .strict();

export const DeliverySectionSchema = z
  .object({
    sectionId: RequiredSectionTextSchema,
    heading: z.string().trim().min(1).optional(),
    anchor: z.string().trim().min(1).optional(),
    summary: RequiredSectionTextSchema,
    deepDiveMarkdown: RequiredSectionTextSchema,
    order: z.number().int().min(0),
    subsectionIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .transform((section) => {
    const heading = section.heading?.trim() ?? section.sectionId;
    const normalizedAnchor = normalizeAnchor(section.anchor ?? section.sectionId);

    return {
      ...section,
      heading,
      anchor: normalizedAnchor.length > 0 ? normalizedAnchor : normalizeAnchor(section.sectionId),
      subsectionIds: section.subsectionIds.map((subsectionId) => subsectionId.trim()),
    };
  });

export const DeliveryProvenanceSchema = z
  .object({
    generatedAt: z.string().datetime(),
    commitSha: z.string().trim().regex(COMMIT_SHA_PATTERN),
    counters: z
      .object({
        sectionCount: z.number().int().min(1),
        subsectionCount: z.number().int().min(1),
        claimCount: z.number().int().min(0),
        citationCount: z.number().int().min(0),
      })
      .strict(),
    run: z
      .object({
        generationRunId: z.string().trim().min(1),
        ingestRunId: z.string().trim().min(1).optional(),
        modelId: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const DeliveryMetadataSchema = z
  .object({
    artifactType: z.literal("wiki-delivery"),
    sourceArtifactType: z.literal("wiki-draft"),
    contractVersion: z.literal("out-01.v1"),
    generatedAt: z.string().datetime(),
    sectionCount: z.number().int().min(1),
    subsectionCount: z.number().int().min(1),
    deterministicOrdering: z
      .object({
        sections: z.literal("sectionId:asc"),
        subsections: z.literal("subsectionId:asc"),
      })
      .strict(),
    provenance: DeliveryProvenanceSchema,
  })
  .strict();

export const DeliveryWikiArtifactSchema = z
  .object({
    project: DeliveryProjectIdentitySchema,
    sections: z.array(DeliverySectionSchema).min(1),
    metadata: DeliveryMetadataSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.metadata.sectionCount !== value.sections.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metadata.sectionCount must equal sections length",
        path: ["metadata", "sectionCount"],
      });
    }

    const subsectionCount = value.sections.reduce((count, section) => count + section.subsectionIds.length, 0);
    if (value.metadata.subsectionCount !== subsectionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metadata.subsectionCount must equal subsectionIds aggregate",
        path: ["metadata", "subsectionCount"],
      });
    }

    if (value.metadata.generatedAt !== value.metadata.provenance.generatedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metadata.generatedAt must equal provenance.generatedAt",
        path: ["metadata", "generatedAt"],
      });
    }

    if (value.project.commitSha !== value.metadata.provenance.commitSha) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provenance.commitSha must equal project.commitSha",
        path: ["metadata", "provenance", "commitSha"],
      });
    }

    if (value.metadata.provenance.counters.sectionCount !== value.metadata.sectionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provenance.counters.sectionCount must equal metadata.sectionCount",
        path: ["metadata", "provenance", "counters", "sectionCount"],
      });
    }

    if (value.metadata.provenance.counters.subsectionCount !== value.metadata.subsectionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provenance.counters.subsectionCount must equal metadata.subsectionCount",
        path: ["metadata", "provenance", "counters", "subsectionCount"],
      });
    }

    const sectionIds = new Set<string>();
    const anchors = new Set<string>();

    for (let index = 0; index < value.sections.length; index += 1) {
      const section = value.sections[index];
      if (section.order !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "sections must use contiguous deterministic order values starting at 0",
          path: ["sections", index, "order"],
        });
      }

      if (sectionIds.has(section.sectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate sectionId: ${section.sectionId}`,
          path: ["sections", index, "sectionId"],
        });
      }
      sectionIds.add(section.sectionId);

      if (anchors.has(section.anchor)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate anchor: ${section.anchor}`,
          path: ["sections", index, "anchor"],
        });
      }
      anchors.add(section.anchor);
    }
  });

export type DeliverySection = z.infer<typeof DeliverySectionSchema>;
export type DeliveryProvenance = z.infer<typeof DeliveryProvenanceSchema>;
export type DeliveryMetadata = z.infer<typeof DeliveryMetadataSchema>;
export type DeliveryWikiArtifact = z.infer<typeof DeliveryWikiArtifactSchema>;
