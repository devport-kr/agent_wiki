/**
 * src/commands/wiki.ts — `portki owner/repo` entry point
 *
 * Runs ingest + plan-sections, then generates handoff.md for AI agents.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { runIngest } from "../ingestion/run";
import { planContext } from "../chunked/plan-sections";
import { renderHandoff } from "./handoff";

export function repoSlug(ownerRepo: string): string {
  const parts = ownerRepo.split("/");
  return parts[parts.length - 1] ?? ownerRepo;
}

export function workspacePath(ownerRepo: string, suffix: string): string {
  const slug = repoSlug(ownerRepo);
  return `portki-output/workspace/${slug}-${suffix}`;
}

export async function wikiCommand(
  ownerRepo: string,
  flags: Record<string, string>,
): Promise<void> {
  const parts = ownerRepo.toLowerCase().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: ${ownerRepo}. Use owner/repo.`);
  }
  const repo = `${parts[0]}/${parts[1]}`;
  const slug = repoSlug(repo);
  const snapshotRoot = flags["snapshot_root"] ?? "portki-output/snapshots";

  // 1. Ingest
  process.stderr.write(`[portki] ${repo} — ingesting...\n`);

  const ref = flags["ref"];
  const artifact = await runIngest({
    repo_ref: { repo, ...(ref ? { ref } : {}) },
    snapshot_root: path.resolve(snapshotRoot),
    force_rebuild: flags["force_rebuild"] === "true",
  });

  const cacheLabel = artifact.idempotent_hit ? "cache hit" : "downloaded";
  process.stderr.write(
    `  ingest: ${artifact.commit_sha.slice(0, 7)} — ${artifact.files_scanned.toLocaleString("en-US")} files (${cacheLabel})\n`,
  );

  const artifactPath = workspacePath(repo, "artifact.json");
  await mkdir(path.dirname(path.resolve(artifactPath)), { recursive: true });
  await writeFile(
    path.resolve(artifactPath),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );

  // 2. Plan context
  process.stderr.write(`  plan-sections: analyzing...\n`);

  const ctx = await planContext(artifact);

  const planContextPath = workspacePath(repo, "plan-context.json");
  await writeFile(
    path.resolve(planContextPath),
    `${JSON.stringify(ctx, null, 2)}\n`,
    "utf8",
  );

  process.stderr.write(
    `  plan-sections: ${ctx.profile.projectType}, ${ctx.profile.primaryLanguage}, ${ctx.profile.domainHint}\n`,
  );

  // 3. Generate handoff
  const handoffPath = workspacePath(repo, "handoff.md");
  const handoff = renderHandoff({
    ownerRepo: repo,
    slug,
    artifactPath,
    planContextPath,
    artifact,
    planContext: ctx,
  });

  await writeFile(path.resolve(handoffPath), handoff, "utf8");

  process.stderr.write(
    `\n  Done. Follow the handoff to complete wiki generation:\n` +
    `  ${handoffPath}\n\n`,
  );

  // Print handoff path to stdout for programmatic consumption
  process.stdout.write(`${path.resolve(handoffPath)}\n`);
}
