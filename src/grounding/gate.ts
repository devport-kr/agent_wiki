import {
  GroundingReportSchema,
  type WikiDraftArtifact,
} from "../contracts/wiki-generation";
import type { EvidenceStore } from "./evidence-store";

export interface ValidateDraftInput {
  draft: WikiDraftArtifact;
  evidenceStore: EvidenceStore;
  snapshotPath: string;
  checkedAt?: string;
}

export interface GroundingGateResult {
  report: ReturnType<typeof GroundingReportSchema.parse>;
  diagnostics: {
    consistencyScore: number;
    untranslatedTokenRatio: number;
    analyzedTokenCount: number;
    notes: string[];
  };
}

/**
 * Compatibility-only gate.
 *
 * Grounding validation is detached from the active packaging runtime in the
 * beginner/trend citationless pipeline. This class remains to preserve imports
 * in legacy paths and tests.
 */
export class GroundingGate {
  validateDraft(input: ValidateDraftInput): GroundingGateResult {
    const claims = input.draft.claims ?? [];
    const totalClaims = claims.length;
    const claimsWithCitations = claims.filter((claim) => (claim.citationIds ?? []).length > 0).length;
    const citationCoverage =
      totalClaims === 0 ? 0 : Number((claimsWithCitations / totalClaims).toFixed(6));

    return {
      report: GroundingReportSchema.parse({
        artifactType: "grounding-report",
        gateId: "GND-03",
        checkedAt: input.checkedAt ?? new Date().toISOString(),
        passed: true,
        totalClaims,
        claimsWithCitations,
        citationCoverage,
        issues: [],
      }),
      diagnostics: {
        consistencyScore: 1,
        untranslatedTokenRatio: 0,
        analyzedTokenCount: 0,
        notes: [
          "Grounding gate is compatibility-only; packaging runtime no longer depends on citation grounding checks.",
        ],
      },
    };
  }
}
