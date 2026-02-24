import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildRetrievalIndex, type EmbeddingProviderLike, type RetrievalIndex } from "../src/indexing/build-index";
import { chunkSnapshot } from "../src/indexing/chunker";
import { buildEvidenceStore } from "../src/grounding/evidence-store";
import { HybridRetriever } from "../src/grounding/retriever";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function createSnapshotFixture(): string {
  const snapshot = mkdtempSync(join(tmpdir(), "devport-retrieval-snapshot-"));
  writeFixtureFile(
    snapshot,
    "src/indexing/build-index.ts",
    [
      "export function buildIndex(snapshotPath: string) {",
      "  const lexical = buildLexicalIndex(snapshotPath);",
      "  const embedding = buildEmbeddingIndex(snapshotPath);",
      "  return { lexical, embedding };",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    snapshot,
    "src/grounding/retriever.ts",
    [
      "export function rerank(lexicalScore: number, semanticScore: number) {",
      "  return lexicalScore * 0.45 + semanticScore * 0.55;",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(snapshot, "README.md", "# retrieval fixture\n");
  return snapshot;
}

const deterministicEmbeddingProvider: EmbeddingProviderLike = {
  embedText: async ({ text }) => {
    const base = text.length || 1;
    return {
      embedding: [base % 11, base % 7, base % 5, base % 3].map((value) => value / 10),
    };
  },
};

function createArtifact(snapshotPath: string) {
  return {
    ingest_run_id: "run-1",
    repo_ref: "acme/widget",
    requested_ref: "main",
    resolved_ref: "main",
    commit_sha: COMMIT_SHA,
    snapshot_path: snapshotPath,
    snapshot_id: "snapshot-1",
    manifest_signature: "manifest-1",
    files_scanned: 3,
    idempotent_hit: false,
    metadata: {
      tree_summary: {
        total_files: 3,
        total_directories: 2,
        max_depth: 3,
        by_extension: {
          ".md": 1,
          ".ts": 2,
        },
      },
      language_mix: {
        Markdown: 1,
        TypeScript: 2,
      },
      key_paths: ["README.md", "src/indexing", "src/grounding"],
      files_scanned: 3,
      total_bytes: 300,
      manifest_signature: "manifest-1",
    },
    created_at: "2026-02-17T00:00:00.000Z",
    completed_at: "2026-02-17T00:00:01.000Z",
    ingest_ms: 1000,
  };
}

describe("index", () => {
  it("builds deterministic evidence ordering with path and line metadata", async () => {
    const snapshotPath = createSnapshotFixture();

    try {
      const artifact = createArtifact(snapshotPath);
      const first = await buildRetrievalIndex(artifact, {
        embeddingProvider: deterministicEmbeddingProvider,
      });
      const second = await buildRetrievalIndex(artifact, {
        embeddingProvider: deterministicEmbeddingProvider,
      });

      const firstEvidence = first.evidence_store.list();
      const secondEvidence = second.evidence_store.list();

      expect(firstEvidence.map((record) => record.evidence_id)).toEqual(
        secondEvidence.map((record) => record.evidence_id),
      );
      expect(first.lexical_documents.map((doc) => doc.file_path)).toEqual(
        second.lexical_documents.map((doc) => doc.file_path),
      );
      expect(firstEvidence[0]).toMatchObject({
        file_path: "README.md",
        start_line: 1,
        end_line: 2,
        commit_sha: COMMIT_SHA,
      });
      expect(firstEvidence.some((record) => record.file_path.includes("src/indexing/build-index.ts"))).toBe(
        true,
      );
      expect(first.embedding_documents).toEqual(second.embedding_documents);
    } finally {
      rmSync(snapshotPath, { recursive: true, force: true });
    }
  });
});

describe("hybrid retrieval", () => {
  it("combines lexical and semantic signals and keeps deterministic tie ordering", async () => {
    const evidenceStore = buildEvidenceStore(
      [
        {
          chunk_id: "a",
          file_path: "src/a.ts",
          start_line: 1,
          end_line: 2,
          language: "TypeScript",
          text: "same token",
          normalized_text: "same token",
          token_count: 2,
        },
        {
          chunk_id: "b",
          file_path: "src/b.ts",
          start_line: 1,
          end_line: 2,
          language: "TypeScript",
          text: "same token",
          normalized_text: "same token",
          token_count: 2,
        },
      ],
      COMMIT_SHA,
    );

    const records = evidenceStore.list();
    const lexicalDocuments = records.map((record) => ({
      id: record.evidence_id,
      evidence_id: record.evidence_id,
      file_path: record.file_path,
      start_line: record.start_line,
      end_line: record.end_line,
      language: record.language,
      text: record.text,
      normalized_text: record.normalized_text,
    }));

    const embeddingDocuments = records.map((record) => ({
      evidence_id: record.evidence_id,
      vector: [1, 0, 0],
    }));

    const manualIndex: RetrievalIndex = {
      index_id: "idx-1",
      repo_ref: "acme/widget",
      commit_sha: COMMIT_SHA,
      manifest_signature: "manifest-1",
      snapshot_path: "/tmp/fake",
      lexical_documents: lexicalDocuments,
      embedding_documents: embeddingDocuments,
      evidence_store: evidenceStore,
    };

    const retriever = new HybridRetriever(manualIndex, {
      embeddingProvider: {
        embedText: async () => ({ embedding: [1, 0, 0] }),
      },
      lexicalWeight: 0.45,
      semanticWeight: 0.55,
    });

    const result = await retriever.retrieve({ query: "same token", maxResults: 2 });
    const expectedOrder = records.map((record) => record.evidence_id).sort((a, b) => a.localeCompare(b));

    expect(result).toHaveLength(2);
    expect(result[0].score).toBeCloseTo(result[1].score, 6);
    expect(result.map((item) => item.evidence_id)).toEqual(expectedOrder);
    expect(result[0]).toMatchObject({
      file_path: records.find((record) => record.evidence_id === expectedOrder[0])?.file_path,
      start_line: 1,
      end_line: 2,
    });
    expect(result[0].lexical_score).toBeGreaterThan(0);
    expect(result[0].semantic_score).toBeGreaterThan(0);
  });

  it("returns path-traceable evidence records from a real built index", async () => {
    const snapshotPath = createSnapshotFixture();

    try {
      const artifact = createArtifact(snapshotPath);
      const index = await buildRetrievalIndex(artifact, {
        embeddingProvider: deterministicEmbeddingProvider,
      });

      const retriever = new HybridRetriever(index, {
        embeddingProvider: {
          embedText: async ({ text }) => deterministicEmbeddingProvider.embedText({
            stageLabel: "retriever",
            requestId: "query",
            text,
          }),
        },
      });

      const result = await retriever.retrieve({
        query: "build index lexical embedding",
        maxResults: 3,
      });

      expect(result.length).toBeGreaterThan(0);
      for (const item of result) {
        expect(item.evidence_id).toMatch(/^ev-/);
        expect(item.file_path.length).toBeGreaterThan(0);
        expect(item.start_line).toBeGreaterThan(0);
        expect(item.end_line).toBeGreaterThanOrEqual(item.start_line);
      }
    } finally {
      rmSync(snapshotPath, { recursive: true, force: true });
    }
  });
});

describe("chunker", () => {
  it("creates deterministic chunks with stable line spans", () => {
    const snapshotPath = createSnapshotFixture();

    try {
      const first = chunkSnapshot({ snapshotPath, maxTokens: 30 });
      const second = chunkSnapshot({ snapshotPath, maxTokens: 30 });

      expect(first.map((chunk) => chunk.chunk_id)).toEqual(second.map((chunk) => chunk.chunk_id));
      expect(first[0]).toMatchObject({
        file_path: "README.md",
        start_line: 1,
        end_line: 2,
      });
      expect(first.some((chunk) => chunk.file_path === "src/grounding/retriever.ts")).toBe(true);
    } finally {
      rmSync(snapshotPath, { recursive: true, force: true });
    }
  });
});
