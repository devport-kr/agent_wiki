import type { GroundingReport, WikiDraftArtifact } from "./wiki-generation";

/**
 * AI-authored grounded wiki payload consumed by package/persist commands.
 */
export interface GroundedAcceptedOutput {
  ingest_run_id: string;
  repo_ref: string;
  commit_sha: string;
  section_count: number;
  subsection_count: number;
  total_korean_chars: number;
  source_doc_count: number;
  trend_fact_count: number;
  claim_count?: number;
  citation_count?: number;
  draft: WikiDraftArtifact;
  grounding_report?: GroundingReport;
}
