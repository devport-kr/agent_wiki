import type { DeliveryProvenance, DeliverySection } from "../contracts/wiki-delivery";

const DEFAULT_GENERATION_RUN_ID = "delivery-packaging";
const DEFAULT_MODEL_ID = "unknown-model";

export interface BuildDeliveryProvenanceInput {
  sections: DeliverySection[];
  commitSha: string;
  generatedAt: string;
  claimCount: number;
  citationCount: number;
  ingestRunId?: string;
  generationRunId?: string;
  modelId?: string;
}

export function buildDeliveryProvenance(input: BuildDeliveryProvenanceInput): DeliveryProvenance {
  const subsectionCount = input.sections.reduce((count, section) => count + section.subsectionIds.length, 0);

  return {
    generatedAt: input.generatedAt,
    commitSha: input.commitSha,
    counters: {
      sectionCount: input.sections.length,
      subsectionCount,
      claimCount: input.claimCount,
      citationCount: input.citationCount,
    },
    run: {
      generationRunId: input.generationRunId?.trim() || DEFAULT_GENERATION_RUN_ID,
      ingestRunId: input.ingestRunId?.trim() || undefined,
      modelId: input.modelId?.trim() || DEFAULT_MODEL_ID,
    },
  };
}
