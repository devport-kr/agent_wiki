import { DeliveryWikiArtifactSchema, type DeliveryWikiArtifact, type DeliverySection } from "../contracts/wiki-delivery";
import type { WikiDraftArtifact } from "../contracts/wiki-generation";
import type { GroundedAcceptedOutput } from "../contracts/grounded-output";
import { buildDeliveryProvenance } from "./provenance";

const SECTION_SORT = "sectionId:asc" as const;
const SUBSECTION_SORT = "subsectionId:asc" as const;

export interface AdaptDraftToDeliveryOptions {
  ingestRunId?: string;
  generatedAt?: string;
  generationRunId?: string;
  modelId?: string;
}

export function adaptAcceptedOutputToDelivery(
  acceptedOutput: GroundedAcceptedOutput,
  options: Omit<AdaptDraftToDeliveryOptions, "ingestRunId"> = {},
): DeliveryWikiArtifact {
  return adaptWikiDraftToDelivery(acceptedOutput.draft, {
    ...options,
    ingestRunId: acceptedOutput.ingest_run_id,
    generationRunId: acceptedOutput.ingest_run_id,
  });
}

export function adaptWikiDraftToDelivery(
  draft: WikiDraftArtifact,
  options: AdaptDraftToDeliveryOptions = {},
): DeliveryWikiArtifact {
  const sections = draft.sections
    .slice()
    .sort((left, right) => compareByDeterministicId(left.sectionId, right.sectionId))
    .map((section, index) => {
      const subsections = section.subsections
        .slice()
        .sort((left, right) => compareByDeterministicId(left.subsectionId, right.subsectionId));

      const summary = requireNonEmpty(section.summaryKo, `summaryKo:${section.sectionId}`);
      const deepDiveMarkdown = buildDeepDiveMarkdown(subsections, section.sectionId);

      const payload: DeliverySection = {
        sectionId: section.sectionId,
        heading: section.titleKo,
        anchor: section.sectionId,
        summary,
        deepDiveMarkdown,
        order: index,
        subsectionIds: subsections.map((subsection) => subsection.subsectionId),
      };

      return payload;
    });

  const subsectionCount = sections.reduce((count, section) => count + section.subsectionIds.length, 0);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const provenance = buildDeliveryProvenance({
    sections,
    commitSha: draft.commitSha,
    generatedAt,
    claimCount: draft.claims.length,
    citationCount: draft.citations.length,
    ingestRunId: options.ingestRunId,
    generationRunId: options.generationRunId,
    modelId: options.modelId,
  });

  return DeliveryWikiArtifactSchema.parse({
    project: {
      repoFullName: draft.repoFullName,
      commitSha: draft.commitSha,
      ingestRunId: options.ingestRunId,
    },
    sections,
    metadata: {
      artifactType: "wiki-delivery",
      sourceArtifactType: draft.artifactType,
      contractVersion: "out-01.v1",
      generatedAt,
      sectionCount: sections.length,
      subsectionCount,
      deterministicOrdering: {
        sections: SECTION_SORT,
        subsections: SUBSECTION_SORT,
      },
      provenance,
    },
  });
}

function buildDeepDiveMarkdown(
  subsections: WikiDraftArtifact["sections"][number]["subsections"],
  sectionId: string,
): string {
  const blocks = subsections.map((subsection) => {
    const title = requireNonEmpty(subsection.titleKo, `titleKo:${sectionId}:${subsection.subsectionId}`);
    const body = requireNonEmpty(subsection.bodyKo, `bodyKo:${sectionId}:${subsection.subsectionId}`);
    return `## ${title}\n\n${body}`;
  });

  return requireNonEmpty(blocks.join("\n\n"), `deepDiveMarkdown:${sectionId}`);
}

function compareByDeterministicId(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`OUT-01 mapping violation: ${field} must be non-empty`);
  }
  return normalized;
}
