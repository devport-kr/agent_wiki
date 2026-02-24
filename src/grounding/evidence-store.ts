import { createHash } from "node:crypto";

import type { SnapshotChunk } from "../indexing/chunker";

export interface EvidenceRecord {
  evidence_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  text: string;
  normalized_text: string;
  token_count: number;
  commit_sha: string;
}

export class EvidenceStore {
  private readonly recordsById = new Map<string, EvidenceRecord>();
  private readonly orderedIds: string[] = [];

  register(chunk: SnapshotChunk, commitSha: string): EvidenceRecord {
    const evidenceId = createEvidenceId(chunk, commitSha);
    const existing = this.recordsById.get(evidenceId);
    if (existing) {
      return existing;
    }

    const record: EvidenceRecord = {
      evidence_id: evidenceId,
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      language: chunk.language,
      text: chunk.text,
      normalized_text: chunk.normalized_text,
      token_count: chunk.token_count,
      commit_sha: commitSha,
    };

    this.recordsById.set(evidenceId, record);
    this.orderedIds.push(evidenceId);
    return record;
  }

  getById(evidenceId: string): EvidenceRecord | undefined {
    return this.recordsById.get(evidenceId);
  }

  list(): EvidenceRecord[] {
    return this.orderedIds
      .map((id) => this.recordsById.get(id))
      .filter((record): record is EvidenceRecord => Boolean(record));
  }
}

export function buildEvidenceStore(chunks: SnapshotChunk[], commitSha: string): EvidenceStore {
  const store = new EvidenceStore();
  for (const chunk of chunks) {
    store.register(chunk, commitSha);
  }
  return store;
}

export function createEvidenceId(chunk: SnapshotChunk, commitSha: string): string {
  const digest = createHash("sha1")
    .update(
      `${commitSha}|${chunk.file_path}|${chunk.start_line}|${chunk.end_line}|${chunk.normalized_text}`,
    )
    .digest("hex");

  return `ev-${digest.slice(0, 16)}`;
}
