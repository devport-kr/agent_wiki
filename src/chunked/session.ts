import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  ChunkedSessionSchema,
  type ChunkedSession,
  type ChunkedSectionStatus,
  type SectionPlanOutput,
} from "../contracts/chunked-generation";
import type { S3JsonAdapter } from "../shared/s3-storage";

export function sessionPathForRepo(repoFullName: string, rootDir = "devport-output/chunked"): string {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repoFullName: ${repoFullName}`);
  }
  return path.resolve(rootDir, owner, repo, "session.json");
}

export async function loadSession(
  sessionPath: string,
  s3?: { adapter: S3JsonAdapter; key: string; exclusive?: boolean },
): Promise<ChunkedSession | null> {
  if (s3) {
    try {
      const remote = await s3.adapter.readJson(s3.key);
      if (remote !== null) {
        try {
          return ChunkedSessionSchema.parse(remote);
        } catch {
          if (s3.exclusive) return null;
        }
      } else if (s3.exclusive) {
        return null;
      }
    } catch (err) {
      process.stderr.write(`[s3] warning: loadSession from S3 failed: ${String(err)}\n`);
      if (s3.exclusive) return null;
    }
  }

  const absolute = path.resolve(sessionPath);
  let raw: string;
  try {
    raw = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const parsed = JSON.parse(raw);
  return ChunkedSessionSchema.parse(parsed);
}

export function initSession(plan: SectionPlanOutput, planPath: string): ChunkedSession {
  const sections: Record<string, ChunkedSectionStatus> = {};
  for (const section of plan.sections) {
    sections[section.sectionId] = { status: "pending" };
  }

  return {
    sessionId: crypto.randomUUID(),
    repoFullName: plan.repoFullName,
    commitSha: plan.commitSha,
    ingestRunId: plan.ingestRunId,
    planPath: path.resolve(planPath),
    startedAt: new Date().toISOString(),
    sections,
  };
}

export async function saveSession(
  sessionPath: string,
  session: ChunkedSession,
  s3?: { adapter: S3JsonAdapter; key: string; exclusive?: boolean },
): Promise<void> {
  const validated = ChunkedSessionSchema.parse(session);

  if (!s3?.exclusive) {
    const absolute = path.resolve(sessionPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  }

  if (s3) {
    try {
      await s3.adapter.writeJson(s3.key, validated);
    } catch (err) {
      process.stderr.write(`[s3] warning: saveSession to S3 failed: ${String(err)}\n`);
      if (s3.exclusive) throw err;
    }
  }
}

export function markSectionPersisted(
  session: ChunkedSession,
  sectionId: string,
  details: {
    sectionOutputPath: string;
    chunksInserted: number;
    claimCount: number;
    citationCount: number;
    subsectionCount: number;
    koreanChars: number;
  },
): ChunkedSession {
  const existing = session.sections[sectionId];
  if (!existing) {
    throw new Error(`Section ${sectionId} not found in session`);
  }

  return {
    ...session,
    sections: {
      ...session.sections,
      [sectionId]: {
        status: "persisted" as const,
        sectionOutputPath: details.sectionOutputPath,
        persistedAt: new Date().toISOString(),
        chunksInserted: details.chunksInserted,
        claimCount: details.claimCount,
        citationCount: details.citationCount,
        subsectionCount: details.subsectionCount,
        koreanChars: details.koreanChars,
      },
    },
  };
}
