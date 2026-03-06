/**
 * src/agent.ts — devport-agent tool interface
 *
 * Called by the AI agent (Claude Code, opencode, etc.) as a tool.
 * The AI IS the intelligence. This script handles the deterministic pipeline:
 * repo snapshot, change detection, delivery packaging, freshness baseline.
 *
 * Commands:
 *   ingest           Snapshot a GitHub repo and emit the ingest artifact
 *   detect           Detect what changed since the last delivery
 *   package          Validate AI-generated output, write delivery.json
 *   plan-sections    Analyze repo and produce section plan with focus paths
 *   persist-section  Validate and persist a single section to PostgreSQL
 *   finalize         Cross-validate all sections, update snapshot/draft tables
 *
 * Typical first-run workflow:
 *   1. npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json
 *   2. AI reads artifact.json + files under snapshot_path, generates GroundedAcceptedOutput
 *   3. npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
 *
 * Incremental update workflow:
 *   1. npx tsx src/agent.ts detect --repo owner/repo
 *      → noop: done. incremental/full-rebuild: continue
 *   2. npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json
 *   3. AI regenerates (all or only impacted sections) → accepted-output.json
 *   4. npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
 */

import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";

import { loadEnvFiles } from "./shared/load-env";
import { runIngest } from "./ingestion/run";
import { packageAcceptedOutputsForDelivery } from "./orchestration/package-delivery";
import type { GroundedAcceptedOutput } from "./contracts/grounded-output";
import { detectRepoFreshness } from "./freshness/detect";
import { mapChangedPathsToImpactedSections } from "./freshness/impact-map";
import { extractSectionEvidenceFromAcceptedOutput } from "./freshness/section-evidence";
import { loadFreshnessState, saveFreshnessState } from "./freshness/state";
import { createPool, loadDbConfig, ensurePgVector, ensureHnswIndex } from "./persistence/db";
import { planContext } from "./chunked/plan-sections";
import { validatePlan } from "./chunked/validate-plan";
import { SectionOutputSchema, SectionPlanOutputSchema, PlanContextSchema } from "./contracts/chunked-generation";
import { validateSection } from "./chunked/validate-section";
import { persistSectionToDb } from "./chunked/persist-section";
import { loadSession, initSession, saveSession, markSectionPersisted, sessionPathForRepo } from "./chunked/session";
import { finalize } from "./chunked/finalize";
import { ingestRunArtifactSchema } from "./ingestion/types";

// ── CLI arg parsing ─────────────────────────────────────────────────────────

type QualityGateLevel = "standard" | "strict";

function getQualityGateLevel(env: NodeJS.ProcessEnv): QualityGateLevel {
  const val = env.DEVPORT_QUALITY_GATE_LEVEL;
  return val === "standard" || val === "strict" ? val : "strict";
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function parseRepo(repoFlag: string, refFlag?: string): { repo: string; ref?: string } {
  const at = repoFlag.indexOf("@");
  if (at !== -1) {
    return { repo: repoFlag.slice(0, at), ref: repoFlag.slice(at + 1) };
  }
  return { repo: repoFlag, ref: refFlag };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const val = flags[name];
  if (!val) throw new Error(`--${name} is required`);
  return val;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function resolveQualityGateLevel(
  flags: Record<string, string>,
  defaultLevel: QualityGateLevel,
): QualityGateLevel {
  const flag = flags["quality_gate_level"];
  if (!flag) return defaultLevel;
  if (flag !== "standard" && flag !== "strict") {
    throw new Error(`--quality_gate_level must be standard or strict, got: ${flag}`);
  }
  return flag;
}

// ── ingest ───────────────────────────────────────────────────────────────────

async function ingestCommand(flags: Record<string, string>): Promise<void> {
  const { repo, ref } = parseRepo(requireFlag(flags, "repo"), flags["ref"]);
  const snapshotRoot = flags["snapshot_root"] ?? "devport-output/snapshots";
  const outFile = flags["out"];

  process.stderr.write(`[devport-agent] ingest: ${repo}${ref ? `@${ref}` : ""}\n`);

  const artifact = await runIngest({
    repo_ref: { repo, ...(ref ? { ref } : {}) },
    snapshot_root: path.resolve(snapshotRoot),
    force_rebuild: flags["force_rebuild"] === "true",
  });

  const cacheLabel = artifact.idempotent_hit ? "cache hit" : "downloaded";
  process.stderr.write(
    `  ✓ ${artifact.commit_sha.slice(0, 7)} — ${fmtNum(artifact.files_scanned)} files (${cacheLabel})\n`,
  );
  process.stderr.write(`  snapshot_path: ${artifact.snapshot_path}\n`);

  const json = `${JSON.stringify(artifact, null, 2)}\n`;

  if (outFile) {
    const outPath = path.resolve(outFile);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, json, "utf8");
    process.stderr.write(`  artifact → ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

// ── detect ───────────────────────────────────────────────────────────────────

async function detectCommand(flags: Record<string, string>): Promise<void> {
  const repoFlag = requireFlag(flags, "repo");
  const parts = repoFlag.toLowerCase().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--repo must be owner/repo, got: ${repoFlag}`);
  }
  const repoRef = `${parts[0]}/${parts[1]}`;
  const statePath = flags["state_path"] ?? "devport-output/freshness/state.json";

  process.stderr.write(`[devport-agent] detect: ${repoRef}\n`);

  const state = await loadFreshnessState(statePath);
  const baseline = state.repos[repoRef];

  if (!baseline) {
    process.stderr.write(`  → no baseline — full rebuild required\n`);
    process.stderr.write(`    (run \`package --advance_baseline\` after first generation)\n`);
    process.stdout.write(
      `${JSON.stringify(
        { status: "full-rebuild", reason: "BASELINE_MISSING", repo_ref: repoRef, changed_paths: [], impacted_section_ids: [] },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stderr.write(`  base: ${baseline.last_delivery_commit.slice(0, 7)}\n`);

  const detection = await detectRepoFreshness(
    { repo_ref: repoRef, baseline },
    { token: process.env["GITHUB_TOKEN"] },
  );

  if (detection.mode === "noop") {
    process.stderr.write(`  ✓ no changes — delivery is current at ${detection.head_commit.slice(0, 7)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        { status: "noop", repo_ref: repoRef, base_commit: detection.base_commit, head_commit: detection.head_commit, changed_paths: [], impacted_section_ids: [] },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const mapped = mapChangedPathsToImpactedSections({
    changed_paths: detection.changed_paths,
    sectionEvidenceIndex: baseline.sectionEvidenceIndex,
  });

  const status =
    mapped.mode === "full-rebuild-required" || detection.mode === "full-rebuild-required"
      ? "full-rebuild"
      : "incremental";

  process.stderr.write(
    `  → ${status}: ${detection.changed_paths.length} paths changed, ` +
    `${mapped.impacted_section_ids.length} sections impacted\n`,
  );
  if (mapped.impacted_section_ids.length > 0) {
    process.stderr.write(`  sections: ${mapped.impacted_section_ids.join(", ")}\n`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status,
        repo_ref: repoRef,
        base_commit: detection.base_commit,
        head_commit: detection.head_commit,
        changed_paths: detection.changed_paths,
        impacted_section_ids: mapped.impacted_section_ids,
      },
      null,
      2,
    )}\n`,
  );
}

// ── package ──────────────────────────────────────────────────────────────────

async function packageCommand(flags: Record<string, string>): Promise<void> {
  const outDir = flags["out_dir"] ?? "devport-output/delivery";
  const inputFile = flags["input"];
  const advanceBaseline = flags["advance_baseline"] === "true";
  const statePath = flags["state_path"] ?? "devport-output/freshness/state.json";
  const qualityGateLevel = resolveQualityGateLevel(flags, getQualityGateLevel(process.env));

  let raw: string;
  if (inputFile) {
    raw = await readFile(path.resolve(inputFile), "utf8");
  } else {
    raw = await readStdin();
  }

  const acceptedOutput = JSON.parse(raw) as GroundedAcceptedOutput;

  process.stderr.write(
    `[devport-agent] package: ${acceptedOutput.repo_ref}@${acceptedOutput.commit_sha.slice(0, 7)}\n`,
  );

  const packaged = packageAcceptedOutputsForDelivery([acceptedOutput], { qualityGateLevel });
  const envelope = packaged.artifacts[0];

  const glossaryCount = Array.isArray(envelope.glossary) ? envelope.glossary.length : 0;
  const sectionCount = Array.isArray(envelope.sections) ? envelope.sections.length : 0;

  const [owner, repoName] = acceptedOutput.repo_ref.split("/");
  if (!owner || !repoName) {
    throw new Error(`repo_ref must be owner/repo, got: ${acceptedOutput.repo_ref}`);
  }

  const deliveryDir = path.resolve(outDir, owner, repoName);
  const deliveryPath = path.join(deliveryDir, "delivery.json");
  await mkdir(deliveryDir, { recursive: true });
  await writeFile(deliveryPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  process.stderr.write(
    `  ✓ ${sectionCount} sections, glossary: ${glossaryCount} terms, provenance attached\n`,
  );
  process.stderr.write(`  saved → ${deliveryPath}\n`);

  if (advanceBaseline) {
    try {
      const evidence = extractSectionEvidenceFromAcceptedOutput(acceptedOutput);
      const state = await loadFreshnessState(statePath);
      const repoRef = envelope.project.repoRef.toLowerCase();

      const nextState = {
        ...state,
        repos: {
          ...state.repos,
          [repoRef]: {
            repo_ref: repoRef,
            last_delivery_commit: envelope.project.commitSha,
            sectionEvidenceIndex: evidence,
          },
        },
      };

      await saveFreshnessState(statePath, nextState);
      process.stderr.write(`  ✓ freshness baseline → ${envelope.project.commitSha.slice(0, 7)}\n`);
    } catch (err) {
      process.stderr.write(
        `  ⚠ freshness baseline not saved: ${String(err)}\n` +
        `    delivery.json is written; re-run package --advance_baseline after fixing citations\n`,
      );
    }
  }
}

// ── plan-sections ────────────────────────────────────────────────────────────

async function planSectionsCommand(flags: Record<string, string>): Promise<void> {
  const artifactFile = requireFlag(flags, "artifact");
  const outFile = flags["out"];

  const raw = await readFile(path.resolve(artifactFile), "utf8");
  const artifact = ingestRunArtifactSchema.parse(JSON.parse(raw));

  process.stderr.write(
    `[devport-agent] plan-sections: ${artifact.repo_ref} (${fmtNum(artifact.files_scanned)} files)\n`,
  );

  const context = await planContext(artifact);

  process.stderr.write(
    `  ✓ plan context generated for ${context.profile.repoName}\n` +
    `    type: ${context.profile.projectType}, lang: ${context.profile.primaryLanguage}, domain: ${context.profile.domainHint}\n` +
    `    ${context.fileTree.length} directory groups, ${context.keyPaths.length} key paths\n` +
    `    README excerpt: ${context.readmeExcerpt.length} chars\n`,
  );

  const json = `${JSON.stringify(context, null, 2)}\n`;

  if (outFile) {
    const outPath = path.resolve(outFile);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, json, "utf8");
    process.stderr.write(`  context → ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

// ── validate-plan ────────────────────────────────────────────────────────────

async function validatePlanCommand(flags: Record<string, string>): Promise<void> {
  const inputFile = requireFlag(flags, "input");
  const contextFile = requireFlag(flags, "context");
  const outFile = flags["out"];

  const contextRaw = await readFile(path.resolve(contextFile), "utf8");
  const context = PlanContextSchema.parse(JSON.parse(contextRaw));

  const planRaw = await readFile(path.resolve(inputFile), "utf8");
  const planJson = JSON.parse(planRaw);

  process.stderr.write(
    `[devport-agent] validate-plan: ${context.repoFullName}\n`,
  );

  const validated = validatePlan(planJson, {
    snapshotPath: context.snapshotPath,
  });

  process.stderr.write(
    `  ✓ plan validated: ${validated.totalSections} sections\n`,
  );

  for (const section of validated.sections) {
    process.stderr.write(
      `    ${section.sectionId}: ${section.titleKo} (${section.focusPaths.length} focus files, ${section.subsectionCount} subsections)\n`,
    );
  }

  const json = `${JSON.stringify(validated, null, 2)}\n`;

  if (outFile) {
    const outPath = path.resolve(outFile);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, json, "utf8");
    process.stderr.write(`  validated plan → ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

// ── persist-section ──────────────────────────────────────────────────────────

async function persistSectionCommand(flags: Record<string, string>): Promise<void> {
  const planFile = requireFlag(flags, "plan");
  const sectionId = requireFlag(flags, "section");
  const inputFile = requireFlag(flags, "input");
  const sessionFile = flags["session"];

  const planRaw = await readFile(path.resolve(planFile), "utf8");
  const plan = SectionPlanOutputSchema.parse(JSON.parse(planRaw));

  const sectionRaw = await readFile(path.resolve(inputFile), "utf8");
  const sectionOutput = SectionOutputSchema.parse(JSON.parse(sectionRaw));

  if (sectionOutput.sectionId !== sectionId) {
    throw new Error(
      `Section ID mismatch: --section ${sectionId} but input has sectionId "${sectionOutput.sectionId}"`,
    );
  }

  process.stderr.write(
    `[devport-agent] persist-section: ${plan.repoFullName} / ${sectionId}\n`,
  );

  const qualityGateLevel = resolveQualityGateLevel(flags, getQualityGateLevel(process.env));

  const validationErrors = validateSection(sectionOutput, {
    snapshotPath: plan.snapshotPath,
    qualityGateLevel,
  });
  if (validationErrors.length > 0) {
    throw new Error(
      `Section validation failed for ${sectionId} (${validationErrors.length} issue(s)):\n` +
      validationErrors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  process.stderr.write(`  ✓ section validation passed\n`);

  const sessionPath = sessionFile
    ? path.resolve(sessionFile)
    : sessionPathForRepo(plan.repoFullName);

  let session = await loadSession(sessionPath);
  if (!session) {
    session = initSession(plan, planFile);
    process.stderr.write(`  created new session: ${session.sessionId}\n`);
  }

  const pool = createPool(loadDbConfig());

  try {
    await ensurePgVector(pool);
    await ensureHnswIndex(pool);

    const projectResult = await pool.query<{ id: number; external_id: string }>(
      "SELECT id, external_id FROM projects WHERE LOWER(full_name) = LOWER($1)",
      [plan.repoFullName],
    );

    if (projectResult.rows.length === 0) {
      throw new Error(
        `Project not found in database for repo_ref: ${plan.repoFullName}. ` +
        `Ensure the project exists in the projects table with a matching full_name.`,
      );
    }

    const { external_id: projectExternalId } = projectResult.rows[0];

    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required for persist-section command");
    }

    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey });

    const result = await persistSectionToDb(sectionOutput, {
      pool,
      openai,
      projectExternalId,
      commitSha: plan.commitSha,
    });

    let koreanChars = sectionOutput.summaryKo.length;
    for (const sub of sectionOutput.subsections) {
      koreanChars += sub.bodyKo.length;
    }

    session = markSectionPersisted(session, sectionId, {
      sectionOutputPath: path.resolve(inputFile),
      chunksInserted: result.chunksInserted,
      claimCount: 0,
      citationCount: 0,
      subsectionCount: sectionOutput.subsections.length,
      koreanChars,
    });

    await saveSession(sessionPath, session);

    process.stderr.write(
      `  ✓ ${sectionId}: ${result.chunksInserted} chunks embedded, ` +
      `${sectionOutput.sourcePaths.length} source paths\n`,
    );
    process.stderr.write(`  session → ${sessionPath}\n`);

    const totalSections = Object.keys(session.sections).length;
    const persistedCount = Object.values(session.sections).filter((s) => s.status === "persisted").length;
    process.stderr.write(`  progress: ${persistedCount}/${totalSections} sections persisted\n`);
  } finally {
    await pool.end();
  }
}

// ── finalize ─────────────────────────────────────────────────────────────────

async function finalizeCommand(flags: Record<string, string>): Promise<void> {
  const planFile = requireFlag(flags, "plan");
  const sessionFile = flags["session"];
  const advanceBaseline = flags["advance_baseline"] === "true";
  const statePath = flags["state_path"] ?? "devport-output/freshness/state.json";
  const deleteSnapshot = flags["delete_snapshot"] === "true";

  const planRaw = await readFile(path.resolve(planFile), "utf8");
  const plan = SectionPlanOutputSchema.parse(JSON.parse(planRaw));

  const sessionPath = sessionFile
    ? path.resolve(sessionFile)
    : sessionPathForRepo(plan.repoFullName);

  const session = await loadSession(sessionPath);
  if (!session) {
    throw new Error(
      `No session found at ${sessionPath}. Run persist-section for at least one section first.`,
    );
  }

  process.stderr.write(
    `[devport-agent] finalize: ${plan.repoFullName} (session ${session.sessionId})\n`,
  );

  const result = await finalize(session, plan, {
    advanceBaseline,
    statePath,
    deleteSnapshot,
  });

  process.stderr.write(
    `  ✓ finalized: ${result.sectionsAssembled} sections, ` +
    `${result.totalSubsections} subsections, ` +
    `${result.totalSourceDocs} source docs, ${result.totalTrendFacts} trend facts, ` +
    `${fmtNum(result.totalKoreanChars)} Korean chars\n`,
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error("No input provided. Pipe JSON or use --input <file>"));
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function printHelp(): void {
  process.stderr.write(
    [
      "",
      "devport-agent — tool interface for AI agents (Claude Code, opencode, etc.)",
      "The AI is the intelligence. This script handles the deterministic pipeline steps.",
      "",
      "Commands:",
      "  ingest   Snapshot a GitHub repo and emit the ingest artifact",
      "           --repo owner/repo     (required)",
      "           --ref  branch|sha     (optional, uses default branch if omitted)",
      "           --out  artifact.json  (optional, prints to stdout if omitted)",
      "           --snapshot_root       (default: devport-output/snapshots)",
      "           --force_rebuild       (re-download even if cache is valid)",
      "",
      "  detect   Detect what changed since the last delivery",
      "           --repo owner/repo     (required)",
      "           --state_path          (default: devport-output/freshness/state.json)",
      "           stdout: { status, changed_paths, impacted_section_ids, ... }",
      "           status values: noop | incremental | full-rebuild",
      "",
      "  package  Validate AI-generated GroundedAcceptedOutput, write delivery.json",
      "           --input accepted-output.json  (optional, reads stdin if omitted)",
      "           --out_dir                     (default: devport-output/delivery)",
      "           --quality_gate_level          standard|strict (default from DEVPORT_QUALITY_GATE_LEVEL)",
      "           --advance_baseline            save freshness state for future detect",
      "           --state_path                  (default: devport-output/freshness/state.json)",
      "",
      "  plan-sections  Analyze repo and produce planning context for AI section generation",
      "                 --artifact artifact.json  (required)",
      "                 --out plan-context.json   (optional, prints to stdout if omitted)",
      "",
      "  validate-plan  Validate an AI-generated section plan against the schema",
      "                 --input section-plan.json    (required)",
      "                 --context plan-context.json  (required)",
      "                 --out section-plan.json      (optional, prints to stdout if omitted)",
      "",
      "  persist-section  Validate and persist a single section to the database",
      "                   --plan section-plan.json   (required)",
      "                   --section sec-1            (required)",
      "                   --input section-1.json     (required)",
      "                   --quality_gate_level       standard|strict (default from DEVPORT_QUALITY_GATE_LEVEL)",
      "                   --session session.json     (optional, auto-derived from repo name)",
      "                   Requires: OPENAI_API_KEY, DEVPORT_DB_* env vars",
      "",
      "  finalize  Cross-validate all sections and update snapshot/draft tables",
      "            --plan section-plan.json   (required)",
      "            --session session.json     (optional, auto-derived from repo name)",
      "            --advance_baseline         save freshness state for future detect",
      "            --state_path               (default: devport-output/freshness/state.json)",
      "            --delete_snapshot          delete snapshot directory after successful finalize",
      "            Requires: OPENAI_API_KEY, DEVPORT_DB_* env vars",
      "",
      "First-run workflow (monolithic):",
      "  1. npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json",
      "  2. AI reads artifact.json + files under snapshot_path, generates GroundedAcceptedOutput",
      "  3. npx tsx src/agent.ts package --input accepted-output.json --advance_baseline",
      "",
      "Chunked workflow (higher quality, section-at-a-time):",
      "  1. npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json",
      "  2. npx tsx src/agent.ts plan-sections --artifact artifact.json --out plan-context.json",
      "  3. AI reads plan-context.json + README + code, generates section-plan.json",
      "  4. npx tsx src/agent.ts validate-plan --input section-plan.json --context plan-context.json --out section-plan.json",
      "  5. For each section: AI reads focus files, writes section-N.json",
      "     npx tsx src/agent.ts persist-section --plan section-plan.json --section sec-N --input section-N.json",
      "  6. npx tsx src/agent.ts finalize --plan section-plan.json --advance_baseline",
      "",
      "Incremental update workflow:",
      "  1. npx tsx src/agent.ts detect --repo owner/repo",
      "     → noop: done. incremental/full-rebuild: continue below",
      "  2. npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json",
      "  3. AI regenerates (all or only impacted sections) → accepted-output.json",
      "  4. npx tsx src/agent.ts package --input accepted-output.json --advance_baseline",
      "",
    ].join("\n"),
  );
}

// ── entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvFiles();

  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exitCode = command ? 0 : 1;
    return;
  }

  const flags = parseFlags(argv.slice(1));

  if (command === "ingest") { await ingestCommand(flags); return; }
  if (command === "detect") { await detectCommand(flags); return; }
  if (command === "package") { await packageCommand(flags); return; }
if (command === "plan-sections") { await planSectionsCommand(flags); return; }
  if (command === "validate-plan") { await validatePlanCommand(flags); return; }
  if (command === "persist-section") { await persistSectionCommand(flags); return; }
  if (command === "finalize") { await finalizeCommand(flags); return; }

  process.stderr.write(`[devport-agent] unknown command: ${command}\n`);
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`\n[devport-agent] error: ${String(error)}\n`);
  process.exitCode = 1;
});
