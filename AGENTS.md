# devport-agent — Agent Instructions

## Role

You are the AI agent operating this tool. This project generates Korean-language wiki documentation for GitHub repositories. Your job is to understand the codebase and write the wiki content. The script `src/agent.ts` handles the mechanical pipeline — snapshotting, change detection, packaging. It never calls another AI. You are the intelligence.

Do not try to call an external LLM. Do not use OpenAI or Anthropic APIs. Read the code, understand it yourself, write the output.

## CRITICAL — Only Use `src/agent.ts`

The only script you are allowed to run is `src/agent.ts` with its commands: `ingest`, `detect`, `package`, `plan-sections`, `persist-section`, `finalize`.

Legacy multi-CLI entrypoints were removed. Use only `src/agent.ts` commands listed above.

## 2026-02-22 Hard-Swap Override (Beginner/Trend)

If any guidance below conflicts with this section, this section wins.

- The wiki pipeline is now citationless: do not generate `claims`, `citations`, or grounding artifacts.
- `plan-sections` targets a beginner/trend template (4-6 sections) and requires one architecture Mermaid block.
- `persist-section` evidence is section-level `sourcePaths`, including synthetic ingest artifacts under `__devport__/trends/*` and `__devport__/official-docs/*`.
- Ingestion should enrich snapshots with trend files and official-doc mirrors.
- Recommended runtime env additions:

```bash
DEVPORT_TREND_WINDOW_DAYS=180
DEVPORT_OFFICIAL_DOC_DISCOVERY=auto
```

---

## Setup

No GitHub token needed for public repos. `npm install` is the only prerequisite.

For private repos only, set `GITHUB_TOKEN` in `.env`.

---

## Running in Parallel (Multiple Terminals)

You can run multiple terminals simultaneously, each processing a different repo. It is safe as long as each terminal is working on a unique `owner/repo`.

### Parallel file naming — MANDATORY RULE

**All intermediate files must be written to `devport-output/workspace/` and prefixed with the repo slug.** Never write them to the project root.

The slug is the repo name portion of `owner/repo` (e.g. `ollama` for `ollama/ollama`).

| Generic root-level (WRONG) | Correct path |
|----------------------------|--------------|
| `artifact.json` | `devport-output/workspace/ollama-artifact.json` |
| `section-plan.json` | `devport-output/workspace/ollama-section-plan.json` |
| `section-1-output.json` | `devport-output/workspace/ollama-section-1-output.json` |
| `accepted-output.json` | `devport-output/workspace/ollama-accepted-output.json` |

Example — two repos running at the same time:
```
Terminal A (ollama/ollama):                           Terminal B (redis/redis):
devport-output/workspace/ollama-artifact.json         devport-output/workspace/redis-artifact.json
devport-output/workspace/ollama-section-plan.json     devport-output/workspace/redis-section-plan.json
devport-output/workspace/ollama-section-1-output.json devport-output/workspace/redis-section-1-output.json
```

Why system-managed files are already safe:
- Snapshots: `devport-output/snapshots/{owner}/{repo}/` — repo-scoped ✅
- Delivery: `devport-output/delivery/{owner}/{repo}/delivery.json` — repo-scoped ✅
- Session: `devport-output/chunked/{owner}/{repo}/session.json` — repo-scoped ✅
- Freshness state: `devport-output/freshness/state.json` — shared file but internally keyed by `owner/repo`, so concurrent writes at the exact same millisecond is the only risk. If it happens, re-run `package --advance_baseline` for the affected repo.

---

## What `state.json` and `--advance_baseline` Are

`state.json` is a memory file. After you generate and package a wiki, it records which commit that wiki was based on and which source files were used for each section:

```json
{
  "repos": {
    "google-gemini/gemini-cli": {
      "last_delivery_commit": "cd79615...",
      "sectionEvidenceIndex": [
        { "sectionId": "sec-1", "repoPaths": ["src/core/index.ts", "src/cli.ts"] },
        { "sectionId": "sec-2", "repoPaths": ["src/auth/oauth.ts"] }
      ]
    }
  }
}
```

`--advance_baseline` on the `package` command tells it to write this memory after saving `delivery.json`.

Without it: next time `detect` runs for this repo, it has no memory of what was previously delivered. It cannot tell what changed. It will always return `status: "full-rebuild"` and you regenerate everything from scratch every single time.

With it: next time `detect` runs, it knows the last delivered commit, fetches the diff from GitHub, maps changed files to the sections that used them, and tells you exactly which sections to regenerate — saving you from a full rebuild when only a few files changed.

**Always pass `--advance_baseline` when you run `package`.** The only reason to skip it is if something went wrong mid-generation and you don't want to overwrite a known-good baseline.

---

## Commands

All commands are run from the project root with `npx tsx src/agent.ts`.

### 1. `ingest` — snapshot a repo

```bash
npx tsx src/agent.ts ingest --repo owner/repo --out devport-output/workspace/{repo-slug}-artifact.json
# Example: npx tsx src/agent.ts ingest --repo ollama/ollama --out devport-output/workspace/ollama-artifact.json
```

Downloads (or uses cache) the full repo snapshot and writes metadata to `artifact.json`.

Flags:
- `--repo` (required) — `owner/repo` or `owner/repo@ref`
- `--ref` (optional) — branch, tag, or full commit SHA. Defaults to the repo's default branch.
- `--out` (optional) — path to write artifact JSON. Prints to stdout if omitted.
- `--snapshot_root` (optional) — where to cache snapshots. Default: `devport-output/snapshots`
- `--force_rebuild` (optional) — re-download even if a cached snapshot already exists.

What `{repo-slug}-artifact.json` contains — read all of these:
- `ingest_run_id` — unique ID for this run, copy it into your output exactly
- `commit_sha` — the exact commit SHA that was snapshotted, copy it into your output exactly
- `repo_ref` — normalized `owner/repo` string (lowercase), copy it into your output exactly
- `snapshot_path` — absolute path to the directory containing all repo files
- `files_scanned` — total number of files in the snapshot
- `metadata.key_paths` — most important file paths in the repo (use these to prioritize what to read)
- `metadata.language_mix` — language distribution as percentages (e.g. `{ "TypeScript": 82.4, "JSON": 10.1 }`)
- `idempotent_hit` — `true` if cache was used, `false` if freshly downloaded

After running `ingest`, read the files under `snapshot_path`. Start with `metadata.key_paths` — these are the highest-signal files. Read as many as needed to fully understand the architecture, entry points, data flow, and key abstractions.

**Reminder:** The output file at `devport-output/workspace/{repo-slug}-artifact.json` is only read by you (the AI) and passed via flags to subsequent commands. It never collides with other repos. The `devport-output/` directory is gitignored so these files stay local.

---

### 2. `detect` — check what changed since last delivery

```bash
npx tsx src/agent.ts detect --repo owner/repo
```

Compares the current GitHub HEAD against the commit you last delivered. Reads stdout as JSON.

Flags:
- `--repo` (required) — `owner/repo`
- `--state_path` (optional) — path to freshness state file. Default: `devport-output/freshness/state.json`

Output JSON written to stdout:
```json
{
  "status": "noop | incremental | full-rebuild",
  "repo_ref": "owner/repo",
  "base_commit": "abc1234...",
  "head_commit": "def5678...",
  "changed_paths": ["src/foo.ts", "README.md"],
  "impacted_section_ids": ["sec-2", "sec-5"]
}
```

What each status means and what you must do:

| status | meaning | action |
|--------|---------|--------|
| `noop` | Nothing changed since last delivery | Stop. Delivery is already current. Do nothing. |
| `incremental` | Some files changed, specific sections identified | Regenerate ONLY the sections in `impacted_section_ids`. Keep all other sections unchanged. |
| `full-rebuild` | Too many changes, or no baseline exists yet | Regenerate all sections from scratch. |

If `detect` returns `"reason": "BASELINE_MISSING"`, it means `package --advance_baseline` has never been run for this repo. Run a full generation first.

---

### 3. `package` — validate your output and write delivery.json

```bash
npx tsx src/agent.ts package --input devport-output/workspace/{repo-slug}-accepted-output.json --advance_baseline
# Example: npx tsx src/agent.ts package --input devport-output/workspace/ollama-accepted-output.json --advance_baseline
```

Takes the `GroundedAcceptedOutput` JSON you produced, validates it against the OUT-04 contract, auto-builds the glossary from your Korean text, attaches provenance metadata, and writes the final `delivery.json`.

Flags:
- `--input` (optional) — path to your generated JSON file. Reads from stdin if omitted.
- `--out_dir` (optional) — root directory for delivery output. Default: `devport-output/delivery`
- `--advance_baseline` (optional but almost always required) — saves the freshness state so `detect` can run incremental updates next time. If you skip this, `detect` will always say `BASELINE_MISSING` and force a full rebuild every time.
- `--state_path` (optional) — where to write the freshness baseline. Default: `devport-output/freshness/state.json`

Output written to: `devport-output/delivery/{owner}/{repo}/delivery.json`

**Always pass `--advance_baseline`** unless you have a specific reason not to.

---

### 4. `plan-sections` — analyze repo and produce a section plan

```bash
npx tsx src/agent.ts plan-sections --artifact devport-output/workspace/{repo-slug}-artifact.json --out devport-output/workspace/{repo-slug}-section-plan.json
# Example: npx tsx src/agent.ts plan-sections --artifact devport-output/workspace/ollama-artifact.json --out devport-output/workspace/ollama-section-plan.json
```

Analyzes the repo snapshot structure and produces a section plan with per-section focus file lists. This is deterministic — no LLM calls. It tells you what sections to write and which files to read for each one.

Flags:
- `--artifact` (required) — path to the artifact JSON from `ingest`
- `--out` (optional) — path to write the section plan. Prints to stdout if omitted.

The output `{repo-slug}-section-plan.json` contains:
- `sections[]` — each with `sectionId`, `titleKo`, `summaryKo`, `focusPaths`, `subsections`
- `focusPaths` — the specific files you should read when writing that section (up to 30 per section, prioritized by importance)
- `subsections[]` — pre-planned subsection IDs, titles, and objectives
- `crossReferences[]` — relationships between sections

---

### 5. `persist-section` — validate and persist a single section

```bash
npx tsx src/agent.ts persist-section --plan devport-output/workspace/{repo-slug}-section-plan.json --section sec-1 --input devport-output/workspace/{repo-slug}-section-1-output.json
# Example: npx tsx src/agent.ts persist-section --plan devport-output/workspace/ollama-section-plan.json --section sec-1 --input devport-output/workspace/ollama-section-1-output.json
```

Validates a single section output, embeds its chunks via OpenAI, and writes them to PostgreSQL. Runs per-section validation to catch errors early.

Flags:
- `--plan` (required) — path to the section plan from `plan-sections`
- `--section` (required) — which section ID to persist (e.g. `sec-1`)
- `--input` (required) — path to your section output JSON
- `--session` (optional) — path to session state file. Auto-derived from repo name if omitted.

Requires: `OPENAI_API_KEY`, `DEVPORT_DB_*` env vars.

The command is idempotent — re-running for the same section replaces its chunks. Progress is tracked in a session file at `devport-output/chunked/{owner}/{repo}/session.json`.

---

### 6. `finalize` — cross-validate all sections and update snapshot

```bash
npx tsx src/agent.ts finalize --plan devport-output/workspace/{repo-slug}-section-plan.json --advance_baseline
# Example: npx tsx src/agent.ts finalize --plan devport-output/workspace/ollama-section-plan.json --advance_baseline
```

Runs after all sections are persisted. Validates the complete wiki across all sections (cross-section repetition, global ID uniqueness) and updates `project_wiki_snapshots` and `wiki_drafts` tables.

Flags:
- `--plan` (required) — path to the section plan
- `--session` (optional) — path to session state file. Auto-derived if omitted.
- `--advance_baseline` (optional but recommended) — saves freshness state for future `detect` runs
- `--state_path` (optional) — where to write freshness baseline. Default: `devport-output/freshness/state.json`

Requires: `OPENAI_API_KEY`, `DEVPORT_DB_*` env vars.

---

## Workflows

### RECOMMENDED: Chunked wiki generation (section-at-a-time)

This is the preferred workflow. It produces higher quality output because you focus on one section at a time instead of generating everything in one pass.

```bash
# Step 1: snapshot the repo
# Replace {repo-slug} with the repo name, e.g. "ollama" for ollama/ollama
npx tsx src/agent.ts ingest --repo owner/repo --out devport-output/workspace/{repo-slug}-artifact.json

# Step 2: plan sections — this analyzes the repo and tells you what to write
npx tsx src/agent.ts plan-sections --artifact devport-output/workspace/{repo-slug}-artifact.json --out devport-output/workspace/{repo-slug}-section-plan.json
```

After step 2, read `devport-output/workspace/{repo-slug}-section-plan.json`. It contains:
- A list of sections with `sectionId`, `titleKo`, `summaryKo`
- `focusPaths` for each section — the specific files you should read for that section
- `subsections` for each section — pre-planned subsection structure with titles and objectives

**Step 3: For EACH section in the plan, one at a time:**

1. Read the `focusPaths` listed for that section in `devport-output/workspace/{repo-slug}-section-plan.json`
2. Read the actual source files at those paths under the snapshot directory
3. Write a `SectionOutput` JSON file to `devport-output/workspace/{repo-slug}-section-N-output.json` using the Write tool
4. Run persist-section to validate and persist it:

```bash
npx tsx src/agent.ts persist-section --plan devport-output/workspace/{repo-slug}-section-plan.json --section sec-1 --input devport-output/workspace/{repo-slug}-section-1-output.json
```

Repeat for `sec-2`, `sec-3`, ... through all sections in the plan.

**Step 4: Finalize — cross-validate all sections and update the database:**

```bash
npx tsx src/agent.ts finalize --plan devport-output/workspace/{repo-slug}-section-plan.json --advance_baseline
```

#### What you write per section (`SectionOutput`)

For each section, write a JSON file like `section-1-output.json` using the Write tool:

```json
{
  "sectionId": "sec-1",
  "titleKo": "<Korean section title — copy from section-plan.json or improve it>",
  "summaryKo": "<Korean summary, 2–3 sentences>",
  "sourcePaths": [
    "README.md",
    "src/agent.ts",
    "__devport__/trends/releases.json",
    "__devport__/official-docs/index.json"
  ],
  "subsections": [
    {
      "sectionId": "sec-1",
      "subsectionId": "sub-1-1",
      "titleKo": "<Korean subsection title>",
      "bodyKo": "<Korean body — minimum 3,000 chars, aim for 4,000–5,000>"
    },
    {
      "sectionId": "sec-1",
      "subsectionId": "sub-1-2",
      "titleKo": "...",
      "bodyKo": "..."
    },
    {
      "sectionId": "sec-1",
      "subsectionId": "sub-1-3",
      "titleKo": "...",
      "bodyKo": "..."
    }
  ]
}
```

**Per-section constraints (validated by `persist-section`):**
- Minimum 3 subsections per section
- `bodyKo` minimum 3,000 characters per subsection
- `sourcePaths` minimum 1 path, and every path must exist in the snapshot
- Include architecture Mermaid content in the architecture-focused section
- No repeated sentences within `bodyKo`

**Cross-section constraints (validated by `finalize`):**
- No repeated content across sections (Jaccard similarity check)
- Keep section/subsection IDs deterministic and non-overlapping

**Naming convention for section output files:** Always write to `devport-output/workspace/` with the repo slug prefix: `devport-output/workspace/{repo-slug}-section-{N}-output.json` (e.g. `devport-output/workspace/ollama-section-1-output.json`). Never write to the project root — it pollutes the working directory.

---

### Legacy: Monolithic wiki generation (all sections at once)

Use this only for small repos (< 200 files) where the overhead of section-at-a-time is not worth it.

```bash
# Step 1: snapshot
npx tsx src/agent.ts ingest --repo owner/repo --out devport-output/workspace/{repo-slug}-artifact.json

# Step 2: YOU read devport-output/workspace/{repo-slug}-artifact.json, read the snapshot files, generate GroundedAcceptedOutput
# Write it to devport-output/workspace/{repo-slug}-accepted-output.json

# Step 3: package and save baseline
npx tsx src/agent.ts package --input devport-output/workspace/{repo-slug}-accepted-output.json --advance_baseline
```

### Incremental update

```bash
# Step 1: detect changes
npx tsx src/agent.ts detect --repo owner/repo
# Read the JSON from stdout

# If status=noop: stop, nothing to do.

# If status=incremental or full-rebuild:
# Step 2: re-snapshot at new HEAD
npx tsx src/agent.ts ingest --repo owner/repo --out devport-output/workspace/{repo-slug}-artifact.json

# Step 3: YOU read the snapshot and regenerate
# For incremental: regenerate ONLY sections listed in impacted_section_ids from detect output
# For full-rebuild: regenerate all sections
# Write each section to devport-output/workspace/{repo-slug}-section-N-output.json, then persist-section each one
# Or for monolithic: write result to devport-output/workspace/{repo-slug}-accepted-output.json

# Step 4: package and advance baseline
npx tsx src/agent.ts package --input devport-output/workspace/{repo-slug}-accepted-output.json --advance_baseline
```

---

## What You Must Generate (`GroundedAcceptedOutput`)

This is the JSON structure you write to `devport-output/workspace/{repo-slug}-accepted-output.json`. Write it using the `Write` tool.

**CRITICAL — Write the JSON directly. Do NOT write a Node.js, Python, or shell script to generate it.**
Do not create `/tmp/gen_wiki.js` or any helper script. Do not use `cat >`, `echo`, `node -e`, or any shell command to produce the JSON. Use the `Write` tool to write the JSON to `devport-output/workspace/{repo-slug}-accepted-output.json` directly, inline, in one shot. The JSON must be written by you as the AI, not generated by a script.

Every field is required. Do not omit any field. Do not add fields that aren't listed here.

```json
{
  "ingest_run_id": "<copy from artifact.json exactly>",
  "repo_ref": "<copy from artifact.json exactly — lowercase owner/repo>",
  "commit_sha": "<copy from artifact.json exactly>",
  "section_count": 5,
  "subsection_count": 15,
  "total_korean_chars": 72000,
  "source_doc_count": 24,
  "trend_fact_count": 8,

  "draft": {
    "artifactType": "wiki-draft",
    "repoFullName": "<lowercase owner/repo>",
    "commitSha": "<copy from artifact.json>",
    "generatedAt": "<ISO 8601 timestamp, e.g. 2026-02-18T12:00:00.000Z>",
    "overviewKo": "<Korean paragraph introducing the entire repository — what it is, what it does, why it exists>",

    "sections": [
      {
        "sectionId": "sec-1",
        "titleKo": "<Korean section title>",
        "summaryKo": "<Korean summary of this section, 2–3 sentences>",
        "subsections": [
          {
            "sectionId": "sec-1",
            "subsectionId": "sub-1-1",
            "titleKo": "<Korean subsection title>",
            "objectiveKo": "<Korean statement of what this subsection explains>",
            "bodyKo": "<Korean body content — minimum 3,000 chars, aim for 4,000–5,000. Every sentence must discuss actual code in this repo: specific file paths, function names, argument shapes, call flows, error paths. Do NOT pad with generic advice or repeated boilerplate.>",
            "targetEvidenceKinds": ["code", "tests"],
            "targetCharacterCount": 3000
          }
        ]
      }
    ],
    "sourceDocs": [
      {
        "sourceId": "src-1",
        "path": "README.md"
      }
    ],
    "trendFacts": [
      {
        "factId": "trend-1",
        "category": "release",
        "summaryKo": "최근 180일 릴리스 주기가 짧아졌고 기능 배포 빈도가 높아졌습니다."
      }
    ]
  }
}
```

---

## Hard Constraints — `package` will reject your output if any of these are violated

1. **Beginner/trend template target is 4–6 sections.** Keep section count aligned with the plan output.
2. **Minimum 3 subsections per section**. Every section must have at least `sub-N-1`, `sub-N-2`, `sub-N-3`.
3. **`sectionId` in subsection must match parent section's `sectionId`** exactly.
4. **`section_count`, `subsection_count`, `total_korean_chars`, `source_doc_count`, `trend_fact_count`** at the top level must be accurate.
5. **`total_korean_chars`** must include `overviewKo`, all section `summaryKo`, and all subsection `bodyKo` characters.
6. **`sourcePaths` and `draft.sourceDocs[].path` must point to real snapshot files.**
7. **At least one architecture Mermaid block must exist in the generated wiki.**
8. **Korean text (`Ko` fields) must actually be in Korean** (Hangul characters).
9. **`bodyKo` minimum 3,000 characters per subsection** with unique sentences only.
10. **Do not generate a glossary manually** — packaging derives it automatically.

---

## How to Write Good Wiki Content

- Read the actual source files in `snapshot_path`. Do not make up what the code does.
- Use `metadata.key_paths` from `artifact.json` to know which files to prioritize reading.
- Every `bodyKo` must discuss real code: specific file names, function names, data structures, call flows.
- Build section evidence from `sourcePaths`, including synthetic snapshot artifacts under `__devport__/trends/*` and `__devport__/official-docs/*`.
- Trend sections should reference releases/tags/changelog artifacts and explain the movement in beginner-friendly language.
- Sections should cover distinct aspects of the codebase. For a large repo, split aggressively — do not cram everything into 6 sections. Examples of distinct sections:
  - Monorepo structure and package boundaries
  - CLI bootstrap and execution modes
  - Core orchestration engine
  - Tool system and plugin/extension model
  - MCP integration and lifecycle
  - Policy engine and security
  - Authentication and credentials
  - Telemetry and observability
  - Configuration system
  - SDK and external API surface
  - Testing strategy and test infrastructure
  - Build system and CI pipeline
- Do not repeat the same content across sections.
- Look at `metadata.files_scanned` in `artifact.json`. If it is above 500, you must write at least 8 sections. If above 1,000, at least 10.

---

## File Layout

```
devport-output/               ← gitignored, never commit this directory
  workspace/                  ← intermediate files written by the AI agent
    {repo-slug}-artifact.json
    {repo-slug}-section-plan.json
    {repo-slug}-section-1-output.json
    {repo-slug}-section-2-output.json
    ...

  snapshots/                  ← managed by `ingest`, do not edit manually
    {owner}/
      {repo}/
        {commitSha}/
          manifest.json
          <all repo files>

  delivery/                   ← written by `package`
    {owner}/
      {repo}/
        delivery.json

  chunked/                    ← session state for persist-section / finalize
    {owner}/
      {repo}/
        session.json

  freshness/
    state.json                ← written by `package --advance_baseline`, read by `detect`
```

---

## Error Reference

| Error message | What went wrong | How to fix |
|---------------|----------------|------------|
| `--repo is required` | Missing `--repo` flag | Add `--repo owner/repo` to the command |
| `OUT-04 validation failed: N) field: message` | Your JSON failed contract validation | Read the exact field name and message, fix that field in your output |
| `No input provided. Pipe JSON or use --input` | Called `package` without input | Add `--input devport-output/workspace/{repo-slug}-accepted-output.json` |
| `BASELINE_MISSING` | `package --advance_baseline` was never run for this repo | Run a full generation first with `--advance_baseline` |
| `freshness baseline not saved: UPDT-02 ... missing section evidence paths` | A section is missing usable `sourcePaths` evidence | Ensure each section contains valid `sourcePaths` that exist in snapshot |
| `GEN-01 violation: section count out of range` | Section count is outside beginner/trend target | Keep section count aligned with planned 4–6 range |
| `GEN-02 violation: sec-N must include >= 3 subsections` | A section has fewer than 3 subsections | Add subsections to the failing section |
| `OUT-04 packaging blocked` | One or more outputs failed packaging | Read the full error — it lists each failure with the field that failed |
| `Section validation failed for sec-N` | `persist-section` per-section validation failed | Read the listed issues — fix bodyKo length, missing mermaid/sourcePaths, invalid paths, etc. |
| `Section ID mismatch` | `--section` flag doesn't match `sectionId` in the input JSON | Make sure the JSON's `sectionId` matches the `--section` flag |
| `Cannot finalize: sections not yet persisted` | `finalize` called before all sections are done | Run `persist-section` for the listed missing sections first |
| `Cross-section validation failed` | `finalize` found repeated content across sections | Read the listed issues and rewrite duplicated content blocks |
| `No session found` | `finalize` can't find the session file | Run `persist-section` for at least one section first, or pass `--session` explicitly |
