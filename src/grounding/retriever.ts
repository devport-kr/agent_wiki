import MiniSearch from "minisearch";

import type { RetrievalIndex } from "../indexing/build-index";

export interface HybridRetrieveInput {
  query: string;
  maxResults: number;
}

export interface RetrievedEvidence {
  evidence_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  score: number;
  lexical_score: number;
  semantic_score: number;
}

export interface QueryEmbeddingProviderLike {
  embedText: (input: {
    stageLabel: string;
    requestId: string;
    text: string;
  }) => Promise<{ embedding: number[] }>;
}

export interface HybridRetrieverOptions {
  lexicalWeight?: number;
  semanticWeight?: number;
  pathLexicalBoost?: number;
  embeddingProvider?: QueryEmbeddingProviderLike;
}

type Candidate = {
  evidence_id: string;
  lexical_score: number;
  semantic_score: number;
  path_bonus: number;
};

export class HybridRetriever {
  private readonly index: RetrievalIndex;
  private readonly miniSearch: MiniSearch;
  private readonly lexicalWeight: number;
  private readonly semanticWeight: number;
  private readonly pathLexicalBoost: number;
  private readonly embeddingProvider?: QueryEmbeddingProviderLike;

  constructor(index: RetrievalIndex, options: HybridRetrieverOptions = {}) {
    this.index = index;
    this.lexicalWeight = options.lexicalWeight ?? 0.45;
    this.semanticWeight = options.semanticWeight ?? 0.55;
    this.pathLexicalBoost = options.pathLexicalBoost ?? 0.15;
    this.embeddingProvider = options.embeddingProvider;

    this.miniSearch = new MiniSearch({
      fields: ["text", "file_path", "language"],
      storeFields: ["evidence_id", "file_path"],
      idField: "evidence_id",
    });

    this.miniSearch.addAll(this.index.lexical_documents);
  }

  async retrieve(input: HybridRetrieveInput): Promise<RetrievedEvidence[]> {
    const lexicalResults = this.miniSearch.search(input.query, {
      prefix: true,
      fuzzy: 0.1,
      boost: {
        file_path: 3,
        text: 2,
      },
    });

    const lexicalMax = lexicalResults.length > 0 ? lexicalResults[0].score : 1;
    const lexicalById = new Map<string, number>();
    for (const result of lexicalResults) {
      const score = lexicalMax > 0 ? result.score / lexicalMax : 0;
      lexicalById.set(String(result.id), score);
    }

    const queryEmbedding = await this.embedQuery(input.query);
    const semanticById = new Map<string, number>();
    for (const embedding of this.index.embedding_documents) {
      semanticById.set(embedding.evidence_id, cosineSimilarity(queryEmbedding, embedding.vector));
    }

    const queryTokens = tokenize(input.query);
    const allEvidenceIds = new Set<string>([
      ...Array.from(lexicalById.keys()),
      ...Array.from(semanticById.keys()),
    ]);

    const candidates: Candidate[] = Array.from(allEvidenceIds)
      .map((evidenceId) => {
        const record = this.index.evidence_store.getById(evidenceId);
        if (!record) {
          return null;
        }

        const lexicalScore = lexicalById.get(evidenceId) ?? 0;
        const semanticScore = normalizeSemanticScore(semanticById.get(evidenceId) ?? 0);
        const pathBonus = computePathBonus(record.file_path, queryTokens, this.pathLexicalBoost);

        return {
          evidence_id: evidenceId,
          lexical_score: Math.min(1, lexicalScore + pathBonus),
          semantic_score: semanticScore,
          path_bonus: pathBonus,
        };
      })
      .filter((candidate): candidate is Candidate => Boolean(candidate));

    return candidates
      .map((candidate) => {
        const record = this.index.evidence_store.getById(candidate.evidence_id);
        if (!record) {
          return null;
        }

        const score =
          this.lexicalWeight * candidate.lexical_score + this.semanticWeight * candidate.semantic_score;

        return {
          evidence_id: candidate.evidence_id,
          file_path: record.file_path,
          start_line: record.start_line,
          end_line: record.end_line,
          score,
          lexical_score: candidate.lexical_score,
          semantic_score: candidate.semantic_score,
        };
      })
      .filter((candidate): candidate is RetrievedEvidence => Boolean(candidate))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        return a.evidence_id.localeCompare(b.evidence_id);
      })
      .slice(0, Math.max(0, input.maxResults));
  }

  private async embedQuery(query: string): Promise<number[]> {
    if (this.embeddingProvider) {
      return (
        await this.embeddingProvider.embedText({
          stageLabel: "retriever",
          requestId: `query:${query}`,
          text: query,
        })
      ).embedding;
    }

    return deterministicQueryEmbedding(query);
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function computePathBonus(filePath: string, tokens: string[], maxBoost: number): number {
  if (tokens.length === 0) {
    return 0;
  }

  const lowerPath = filePath.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (lowerPath.includes(token)) {
      matched += 1;
    }
  }

  if (matched === 0) {
    return 0;
  }

  return Math.min(maxBoost, (matched / tokens.length) * maxBoost);
}

function normalizeSemanticScore(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const dimensions = Math.min(left.length, right.length);
  if (dimensions === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < dimensions; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function deterministicQueryEmbedding(query: string): number[] {
  const tokens = tokenize(query);
  const dimensions = 16;
  const vector = Array.from({ length: dimensions }, () => 0);

  for (const token of tokens) {
    for (let index = 0; index < token.length; index += 1) {
      const code = token.charCodeAt(index);
      const slot = (code + index) % dimensions;
      vector[slot] += (code % 31) / 31;
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (!norm) {
    return vector;
  }

  return vector.map((value) => value / norm);
}
