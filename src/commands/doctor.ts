/**
 * src/commands/doctor.ts — `portki doctor`
 *
 * Environment health check.
 */

import { existsSync } from "node:fs";
import { access, readdir, constants } from "node:fs/promises";
import path from "node:path";

export async function doctorCommand(): Promise<void> {
  process.stderr.write(`[portki] doctor\n\n`);

  let allOk = true;

  // Node.js version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  const nodeOk = major >= 20;
  process.stderr.write(
    `  ${nodeOk ? "ok" : "FAIL"} Node.js ${nodeVersion}${nodeOk ? "" : " (requires >= 20)"}\n`,
  );
  if (!nodeOk) allOk = false;

  // portki-output/ writable
  const outputDir = path.resolve("portki-output");
  let writable = false;
  if (existsSync(outputDir)) {
    try {
      await access(outputDir, constants.W_OK);
      writable = true;
    } catch {
      // not writable
    }
  } else {
    // Directory doesn't exist yet — that's fine, it will be created
    writable = true;
  }
  process.stderr.write(
    `  ${writable ? "ok" : "FAIL"} portki-output/ ${existsSync(outputDir) ? "writable" : "will be created on first run"}\n`,
  );
  if (!writable) allOk = false;

  // Active sessions
  const chunkedDir = path.resolve("portki-output/chunked");
  let sessionCount = 0;
  if (existsSync(chunkedDir)) {
    try {
      const owners = await readdir(chunkedDir, { withFileTypes: true });
      for (const owner of owners) {
        if (!owner.isDirectory()) continue;
        const repos = await readdir(path.join(chunkedDir, owner.name), { withFileTypes: true });
        for (const repo of repos) {
          if (!repo.isDirectory()) continue;
          const sessionPath = path.join(chunkedDir, owner.name, repo.name, "session.json");
          if (existsSync(sessionPath)) sessionCount++;
        }
      }
    } catch {
      // ignore
    }
  }
  process.stderr.write(`  ok Active sessions: ${sessionCount}\n`);

  // GITHUB_TOKEN
  const hasToken = !!process.env["GITHUB_TOKEN"];
  process.stderr.write(
    `  ${hasToken ? "ok" : "info"} GITHUB_TOKEN: ${hasToken ? "set" : "not set (optional, public repos work without it)"}\n`,
  );

  process.stderr.write(`\n  ${allOk ? "All checks passed." : "Some checks failed."}\n\n`);

  if (!allOk) {
    process.exitCode = 1;
  }
}
