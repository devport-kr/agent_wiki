import { z } from "zod";

import { DeliveryProvenanceSchema, DeliverySectionSchema, DeliveryWikiArtifactSchema } from "../contracts/wiki-delivery";
import { QualityScorecardSchema } from "../contracts/wiki-generation";
import { GlossaryEntrySchema } from "./glossary";

const SOURCE_ARTIFACT_TYPE = "wiki-draft" as const;
const CONTRACT_VERSION = "out-04.v1" as const;

const DeliverySourceSchema = z
  .object({
    ingestRunId: z.string().trim().min(1),
    sourceDocCount: z.number().int().min(0),
    trendFactCount: z.number().int().min(0),
  })
  .strict();

const DeliveryPackagingMetadataSchema = z
  .object({
    generatedAt: z.string().datetime(),
    deterministicOrdering: z
      .object({
        sections: z.literal("sectionId:asc"),
        subsections: z.literal("subsectionId:asc"),
        glossary: z.literal("termEn:asc,termKo:asc"),
      })
      .strict(),
    sourceArtifactType: z.literal(SOURCE_ARTIFACT_TYPE),
    qualityScorecard: QualityScorecardSchema,
  })
  .strict();

export const DeliveryArtifactEnvelopeSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    project: z
      .object({
        repoRef: z.string().trim().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
        commitSha: z.string().trim().regex(/^[a-f0-9]{7,40}$/),
        ingestRunId: z.string().trim().min(1),
      })
      .strict(),
    sections: z.array(DeliverySectionSchema).min(1),
    provenance: DeliveryProvenanceSchema,
    glossary: z.array(GlossaryEntrySchema).min(1),
    source: DeliverySourceSchema,
    metadata: DeliveryPackagingMetadataSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsedDelivery = DeliveryWikiArtifactSchema.safeParse({
      project: {
        repoFullName: value.project.repoRef,
        commitSha: value.project.commitSha,
        ingestRunId: value.project.ingestRunId,
      },
      sections: value.sections,
      metadata: {
        artifactType: "wiki-delivery",
        sourceArtifactType: value.metadata.sourceArtifactType,
        contractVersion: "out-01.v1",
        generatedAt: value.metadata.generatedAt,
        sectionCount: value.sections.length,
        subsectionCount: value.sections.reduce((count, section) => count + section.subsectionIds.length, 0),
        deterministicOrdering: {
          sections: value.metadata.deterministicOrdering.sections,
          subsections: value.metadata.deterministicOrdering.subsections,
        },
        provenance: value.provenance,
      },
    });

    if (!parsedDelivery.success) {
      for (const issue of parsedDelivery.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ["sections", ...issue.path],
        });
      }
    }

    if (value.project.commitSha !== value.provenance.commitSha) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provenance.commitSha must equal project.commitSha",
        path: ["provenance", "commitSha"],
      });
    }

    if (value.metadata.generatedAt !== value.provenance.generatedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "metadata.generatedAt must equal provenance.generatedAt",
        path: ["metadata", "generatedAt"],
      });
    }

    if (value.source.ingestRunId !== value.project.ingestRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source.ingestRunId must equal project.ingestRunId",
        path: ["source", "ingestRunId"],
      });
    }

    const duplicateTerms = new Set<string>();
    const canonicalTerms = new Set<string>();
    for (const entry of value.glossary) {
      const canonical = entry.termEn.toLowerCase().replace(/\s+/g, " ").trim();
      if (canonicalTerms.has(canonical)) {
        duplicateTerms.add(canonical);
      }
      canonicalTerms.add(canonical);
    }

    if (duplicateTerms.size > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `glossary contains duplicate canonical termEn keys: ${Array.from(duplicateTerms).join(", ")}`,
        path: ["glossary"],
      });
    }

    if (!isGlossaryDeterministic(value.glossary)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "glossary must be sorted deterministically by termEn then termKo",
        path: ["glossary"],
      });
    }
  });

export type DeliveryArtifactEnvelope = z.infer<typeof DeliveryArtifactEnvelopeSchema>;

export interface DeliveryValidationIssue {
  path: string;
  message: string;
}

export interface DeliveryValidationResult {
  ok: boolean;
  issues: DeliveryValidationIssue[];
  envelope?: DeliveryArtifactEnvelope;
}

export function validateDeliveryEnvelope(input: unknown): DeliveryValidationResult {
  const parsed = DeliveryArtifactEnvelopeSchema.safeParse(input);
  if (parsed.success) {
    return {
      ok: true,
      issues: [],
      envelope: parsed.data,
    };
  }

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
      message: issue.message,
    })),
  };
}

export function assertValidDeliveryEnvelope(input: unknown): DeliveryArtifactEnvelope {
  const result = validateDeliveryEnvelope(input);
  if (result.ok && result.envelope) {
    return result.envelope;
  }

  const reason = (result.issues || [])
    .map((issue, index) => `${index + 1}) ${issue.path}: ${issue.message}`)
    .join("; ");
  throw new Error(`OUT-04 validation failed: ${reason || "unknown validation error"}`);
}

function isGlossaryDeterministic(glossary: Array<{ termKo: string; termEn: string }>): boolean {
  for (let index = 1; index < glossary.length; index += 1) {
    const previous = glossary[index - 1];
    const current = glossary[index];
    const byEnglish = previous.termEn.localeCompare(current.termEn, "en", {
      sensitivity: "base",
      numeric: true,
    });

    if (byEnglish > 0) {
      return false;
    }

    if (byEnglish === 0) {
      const byKorean = previous.termKo.localeCompare(current.termKo, "ko", {
        sensitivity: "base",
        numeric: true,
      });
      if (byKorean > 0) {
        return false;
      }
    }
  }

  return true;
}
