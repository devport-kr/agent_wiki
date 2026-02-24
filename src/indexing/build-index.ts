import { createHash } from "node:crypto";

import { ingestRunArtifactSchema, type IngestRunArtifact } from "../ingestion/types";
import { buildEvidenceStore, type EvidenceStore } from "../grounding/evidence-store";
import { chunkSnapshot } from "./chunker";

export interface LexicalDocument {
  id: string;
  evidence_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  text: string;
  normalized_text: string;
}

export interface EmbeddingDocument {
  evidence_id: string;
  vector: number[];
}

export interface RetrievalIndex {
  index_id: string;
  repo_ref: string;
  commit_sha: string;
  manifest_signature: string;
  snapshot_path: string;
  lexical_documents: LexicalDocument[];
  embedding_documents: EmbeddingDocument[];
  evidence_store: EvidenceStore;
}

export interface EmbeddingProviderLike {
  embedText: (input: {
    stageLabel: string;
    requestId: string;
    text: string;
  }) => Promise<{ embedding: number[] }>;
}

export interface BuildRetrievalIndexOptions {
  embeddingProvider?: EmbeddingProviderLike;
  maxChunkTokens?: number;
}

export async function buildRetrievalIndex(
  artifactInput: IngestRunArtifact,
  options: BuildRetrievalIndexOptions = {},
): Promise<RetrievalIndex> {
  const artifact = ingestRunArtifactSchema.parse(artifactInput);
  const chunks = chunkSnapshot({
    snapshotPath: artifact.snapshot_path,
    maxTokens: options.maxChunkTokens,
  });
  const evidenceStore = buildEvidenceStore(chunks, artifact.commit_sha);
  const evidenceRecords = evidenceStore.list();

  const lexicalDocuments: LexicalDocument[] = evidenceRecords.map((record) => ({
    id: record.evidence_id,
    evidence_id: record.evidence_id,
    file_path: record.file_path,
    start_line: record.start_line,
    end_line: record.end_line,
    language: record.language,
    text: record.text,
    normalized_text: record.normalized_text,
  }));

  const embeddingDocuments: EmbeddingDocument[] = [];
  for (const record of evidenceRecords) {
    const vector = options.embeddingProvider
      ? (
          await options.embeddingProvider.embedText({
            stageLabel: "retriever",
            requestId: `${artifact.ingest_run_id}:${record.evidence_id}`,
            text: record.normalized_text,
          })
        ).embedding
      : deterministicEmbedding(record.normalized_text);

    embeddingDocuments.push({
      evidence_id: record.evidence_id,
      vector,
    });
  }

  return {
    index_id: createHash("sha1")
      .update(
        `${artifact.repo_ref}|${artifact.commit_sha}|${artifact.manifest_signature}|${evidenceRecords.length}`,
      )
      .digest("hex"),
    repo_ref: artifact.repo_ref,
    commit_sha: artifact.commit_sha,
    manifest_signature: artifact.manifest_signature,
    snapshot_path: artifact.snapshot_path,
    lexical_documents: lexicalDocuments,
    embedding_documents: embeddingDocuments,
    evidence_store: evidenceStore,
  };
}

function deterministicEmbedding(input: string, dimensions = 16): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const hash = createHash("sha256").update(input).digest();

  for (let index = 0; index < hash.length; index += 1) {
    const slot = index % dimensions;
    const centered = (hash[index] - 127.5) / 127.5;
    vector[slot] += centered;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (!norm) {
    return vector;
  }

  return vector.map((value) => value / norm);
}
