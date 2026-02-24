import type OpenAI from "openai";

export interface EmbeddingResult {
  text: string;
  embedding: number[];
  tokenCount: number;
}

const MODEL = "text-embedding-3-small";
const MAX_BATCH_SIZE = 100;

export async function embedTexts(client: OpenAI, texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: MODEL,
      input: batch,
    });

    for (const item of response.data) {
      results.push({
        text: batch[item.index],
        embedding: item.embedding,
        tokenCount: response.usage.total_tokens,
      });
    }
  }

  return results;
}

export function vectorToSql(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
