/**
 * src/commands/status.ts — `portki status owner/repo`
 *
 * Shows pipeline progress for a given repo.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { loadSession, sessionPathForRepo } from "../chunked/session";
import { repoSlug, workspacePath } from "./wiki";

export async function statusCommand(argv: string[]): Promise<void> {
  const ownerRepo = argv[0];
  if (!ownerRepo || !ownerRepo.includes("/")) {
    throw new Error("Usage: portki status owner/repo");
  }

  const repo = ownerRepo.toLowerCase();
  const slug = repoSlug(repo);

  process.stderr.write(`[portki] status: ${repo}\n\n`);

  const checks: Array<{ label: string; path: string; done: boolean }> = [
    { label: "ingest (artifact)", path: workspacePath(repo, "artifact.json"), done: false },
    { label: "plan-sections (context)", path: workspacePath(repo, "plan-context.json"), done: false },
    { label: "section-plan.json", path: workspacePath(repo, "section-plan.json"), done: false },
    { label: "handoff.md", path: workspacePath(repo, "handoff.md"), done: false },
  ];

  for (const check of checks) {
    check.done = existsSync(path.resolve(check.path));
    const icon = check.done ? "+" : "-";
    process.stderr.write(`  [${icon}] ${check.label}\n`);
  }

  // Check session for per-section status
  const sessionPath = sessionPathForRepo(repo);
  const session = await loadSession(sessionPath);

  if (session) {
    process.stderr.write(`\n  Session: ${session.sessionId}\n`);
    const sectionIds = Object.keys(session.sections).sort();
    let persisted = 0;
    for (const secId of sectionIds) {
      const sec = session.sections[secId];
      const icon = sec.status === "persisted" ? "+" : "-";
      process.stderr.write(`    [${icon}] ${secId}: ${sec.status}\n`);
      if (sec.status === "persisted") persisted++;
    }
    process.stderr.write(`\n  Sections: ${persisted}/${sectionIds.length} persisted\n`);
  } else {
    process.stderr.write(`\n  No session found yet.\n`);
  }

  // Check finalized output
  const wikiReadme = `portki-output/wiki/${repo}/README.md`;
  const finalized = existsSync(path.resolve(wikiReadme));
  const fIcon = finalized ? "+" : "-";
  process.stderr.write(`  [${fIcon}] finalized (wiki output)\n`);

  process.stderr.write("\n");
}
