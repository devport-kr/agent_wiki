# devport-agent — Agent Instructions

## Role

You are the AI agent operating this tool. This project generates Korean-language wiki documentation for GitHub repositories. Your job is to understand the codebase and write the wiki content. The script `src/agent.ts` handles the mechanical pipeline — snapshotting, change detection, packaging. It never calls another AI. You are the intelligence.

Do not try to call an external LLM. Do not use OpenAI or Anthropic APIs. Read the code, understand it yourself, write the output.

## CRITICAL — Only Use `src/agent.ts`

The only script you are allowed to run is `src/agent.ts` with its commands: `ingest`, `detect`, `package`, `plan-sections`, `validate-plan`, `persist-section`, `finalize`.

Legacy multi-CLI entrypoints were removed. Use only `src/agent.ts` commands listed above.

## CRITICAL — Always Run the Full Pipeline

**Never stop at `package`. Always run the complete pipeline through `finalize`.**

The full sequence for every repo is:
1. `ingest` → 2. `plan-sections` (get context) → 3. **YOU generate the section plan** → 4. `validate-plan` → 5. write section outputs → 6. `persist-section` for each section → 7. `finalize --advance_baseline`

Do not pause and ask the user whether to continue to `persist-section` or `finalize`. The database and OpenAI are always available. Run the full pipeline autonomously from start to finish.

The only reason to stop early is an unrecoverable error (e.g. validation failure that requires rewriting content).

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

This is the preferred workflow. It produces higher quality output because you design the section structure based on the actual project, then focus on one section at a time.

```bash
# Step 1: snapshot the repo
# Replace {repo-slug} with the repo name, e.g. "ollama" for ollama/ollama
npx tsx src/agent.ts ingest --repo owner/repo --out devport-output/workspace/{repo-slug}-artifact.json

# Step 2: get planning context — this gives you repo profile, README, and constraints
npx tsx src/agent.ts plan-sections --artifact devport-output/workspace/{repo-slug}-artifact.json --out devport-output/workspace/{repo-slug}-plan-context.json
```

After step 2, read `devport-output/workspace/{repo-slug}-plan-context.json`. It contains:
- `profile` — repo name, primary language, project type, domain hint
- `readmeExcerpt` — first 3000 chars of the README
- `keyPaths` — most important file paths
- `fileTree` — files grouped by top-level directory with sizes
- `constraints` — min/max sections, subsections, character counts

**Step 3: YOU generate the section plan**

Read the PlanContext, the README, and key source files. Based on what the project actually is, design a section plan. Write it as `SectionPlanOutput` JSON:

```json
{
  "artifactType": "chunked-section-plan",
  "repoFullName": "<from plan-context.json>",
  "commitSha": "<from plan-context.json>",
  "ingestRunId": "<from plan-context.json>",
  "snapshotPath": "<from plan-context.json>",
  "generatedAt": "<ISO 8601 timestamp>",
  "overviewKo": "<이 저장소의 한국어 개요 — 합니다체로 작성합니다. 예: 이 프로젝트는 X를 제공하는 오픈소스 도구입니다.>",
  "totalSections": 5,
  "sections": [
    {
      "sectionId": "sec-1",
      "titleKo": "<이 프로젝트의 고유한 정체성을 반영하는 한국어 제목>",
      "summaryKo": "<이 섹션이 다루는 내용과 이유를 합니다체로 요약합니다>",
      "focusPaths": ["README.md", "src/main.ts", "src/config.ts"],
      "subsectionCount": 3,
      "subsections": [
        {
          "subsectionId": "sub-1-1",
          "titleKo": "프로젝트 소개와 개요",
          "objectiveKo": "이 프로젝트가 무엇이고 어떤 문제를 해결하는지, 핵심 목표와 기능은 무엇인지, 설치·실행 방법은 어떤지를 README 수준으로 요약합니다. 이후 위키 전체가 어떤 순서로 프로젝트를 설명하는지 안내합니다.",
          "targetEvidenceKinds": ["docs"],
          "targetCharacterCount": 3000
        }
      ]
    }
  ],
  "crossReferences": [
    { "fromSectionId": "sec-1", "toSectionId": "sec-2", "relation": "다음 섹션에서 상세 구현을 설명합니다" }
  ]
}
```

**How to design good sections:**
- Read the README first — understand what the project does from the user's perspective
- **MANDATORY — `sub-1-1` is the project entry point.** This subsection is a special override:
  - Its `titleKo` must be "프로젝트 소개와 개요" (or a project-specific variant like "Dify 플랫폼 소개와 개요")
  - It must **NOT** analyze specific code files, function names, or call flows
  - It must read like a README/TL;DR: explain what the project is, what problem it solves, its goals, key capabilities
  - It must include how to get started (install, download, run)
  - It must end with a short map of what the remaining wiki sections cover
  - Think of it as an **academic abstract** for the entire wiki — a reader who only reads `sub-1-1` should understand what the project is and why it matters
  - `targetEvidenceKinds` for `sub-1-1` should be `["docs"]`, not `["code"]`
  - `sub-1-2` and `sub-1-3` then dive into the technical code-level analysis (entry points, architecture, Mermaid diagrams)
- Sections should reflect the project's **identity**, not a generic template
  - For an AI agent framework: "에이전트 도구 시스템과 실행 계약", "프롬프트 체이닝과 LLM 통합"
  - For a database: "데이터 구조와 인메모리 엔진", "명령 파싱과 처리 파이프라인"
  - For a web framework: "라우팅 시스템과 미들웨어 체인", "템플릿 렌더링과 정적 자산"
- Each section's `focusPaths` must be real files that exist in the snapshot
- Each section must have ≥ 3 subsections with distinct, specific objectives
- One section must be trend-focused (recent releases, changelog)
- At least one section must suggest including a Mermaid architecture diagram

Write the plan to `devport-output/workspace/{repo-slug}-section-plan.json`.

**Step 4: Validate the plan**

```bash
npx tsx src/agent.ts validate-plan --input devport-output/workspace/{repo-slug}-section-plan.json --context devport-output/workspace/{repo-slug}-plan-context.json --out devport-output/workspace/{repo-slug}-section-plan.json
```

If validation fails, read the error messages, fix your plan, and re-run.

**Step 5: For EACH section in the validated plan, one at a time:**

1. Read the `focusPaths` listed for that section in `devport-output/workspace/{repo-slug}-section-plan.json`
2. Read the actual source files at those paths under the snapshot directory
3. Write a `SectionOutput` JSON file to `devport-output/workspace/{repo-slug}-section-N-output.json` using the Write tool
4. Run persist-section to validate and persist it:

```bash
npx tsx src/agent.ts persist-section --plan devport-output/workspace/{repo-slug}-section-plan.json --section sec-1 --input devport-output/workspace/{repo-slug}-section-1-output.json
```

Repeat for `sec-2`, `sec-3`, ... through all sections in the plan.

**Step 6: Finalize — cross-validate all sections and update the database:**

```bash
npx tsx src/agent.ts finalize --plan devport-output/workspace/{repo-slug}-section-plan.json --advance_baseline
```

#### What you write per section (`SectionOutput`)

For each section, write a JSON file like `section-1-output.json` using the Write tool:

```json
{
  "sectionId": "sec-1",
  "titleKo": "<검증된 플랜의 한국어 섹션 제목>",
  "summaryKo": "<합니다체로 작성한 한국어 요약, 2–3문장>",
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
      "bodyKo": "<합니다체로 작성한 한국어 본문 — 최소 3,000자, 4,000–5,000자 목표>"
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
- No padding patterns (repeated line prefixes, escaped newlines)

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
    "overviewKo": "<이 저장소를 소개하는 한국어 문단 — 합니다체로 작성합니다. 예: 이 프로젝트는 X를 위한 도구입니다.>",

    "sections": [
      {
        "sectionId": "sec-1",
        "titleKo": "<Korean section title>",
        "summaryKo": "<이 섹션의 한국어 요약, 2–3문장. 합니다체로 작성합니다.>",
        "subsections": [
          {
            "sectionId": "sec-1",
            "subsectionId": "sub-1-1",
            "titleKo": "<Korean subsection title>",
            "objectiveKo": "<이 서브섹션이 설명하는 내용을 합니다체로 기술합니다>",
            "bodyKo": "<합니다체로 작성한 한국어 본문 — 최소 3,000자, 4,000–5,000자 목표. 모든 문장은 이 저장소의 실제 코드를 다뤄야 합니다: 구체적 파일 경로, 함수명, 인자 구조, 호출 흐름, 에러 경로를 포함합니다. 일반론이나 반복 상용구로 채우지 않습니다.>",
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

### Core Principles

- Read the actual source files in `snapshot_path`. Do not make up what the code does.
- Use `metadata.key_paths` from `artifact.json` to know which files to prioritize reading.
- Every `bodyKo` must discuss real code: specific file names, function names, data structures, call flows. **Exception: `sub-1-1` is a project overview** — it discusses the project at a high level (what it is, goals, capabilities, getting started) without diving into specific code paths. See the mandatory `sub-1-1` override rule in the section plan design guidelines.
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

### CRITICAL — Anti-Padding Rules

**Do NOT pad `bodyKo` with filler to reach the 3,000-character minimum.** The validator will reject padding patterns. If your genuine content is under 3,000 characters, you have not read enough source code — go back and read more files, then write more substantive analysis.

The following patterns are **explicitly banned** and will cause `persist-section` to fail:

1. **Repeated-prefix lines** — Lines that start identically and differ only in the suffix:
   ```
   ❌ BAD:
   지금 항목 식별자는 sec-1/sub-1-1/1이다. 이 항목은 실제 코드에서 확인되는...
   지금 항목 식별자는 sec-1/sub-1-1/1이다. 우선 의존 경로를 추적한 뒤...
   지금 항목 식별자는 sec-1/sub-1-1/1이다. 예외 처리 지점은 즉시 감지가...
   ```

2. **Generic advice not tied to this repo** — Sentences that could appear in any wiki because they reference no specific code:
   ```
   ❌ BAD:
   테스트는 기능 성공 여부만 보지 말고 계약 불변성과 예외 경로까지 점검하는 쪽으로 운영해야 한다.
   버그가 간헐적으로 보일 때는 호출 경로와 스트림 경로를 시간축으로 맞춰보면 빠르게 재현된다.
   하나의 변경이 여러 레이어를 관통하면 배포 전에 문서, 설정, 런타임을 동시에 확인해야 한다.
   ```

3. **Escaped newline padding** — Appending `\\n` sequences or trailing whitespace to inflate character count.

4. **Mermaid diagrams with escaped backslashes** — Writing `\\\\n` inside Mermaid blocks instead of real newlines. These render as broken text, not diagrams.

**Rule of thumb:** If you deleted a sentence and the wiki lost no information about this specific repo, that sentence is filler. Remove it.

### Good vs Bad `bodyKo` — Concrete Examples

**❌ BAD bodyKo** (해라체 + 일반론, 구체적 파일·함수 언급 없음):
```
CLI 호출은 단순 명령 문자열이 아니라 라우팅 규칙의 시작점이다. 사용자가 명령을 호출하면
실행 경로와 인자 파싱을 수행하고, 필요 시 서버 상태 확인 후 자동으로 서비스를 띄운다.
이 구조는 사용자가 서버를 직접 올리지 않아도 동작이 진행되도록 만든다.
```
→ 해라체("~이다", "~띄운다", "~만든다")를 사용했고, 구체적 파일·함수 언급이 없습니다.

**✅ GOOD bodyKo** (합니다체 + 구체적 파일, 함수, 데이터 흐름):
```
CLI 진입점은 `cmd/cmd.go`의 `NewCLI()` 함수입니다. 이 함수는 cobra.Command 트리를
구성하며, `run`, `create`, `pull`, `list` 등 각 서브커맨드를 RunE 핸들러로 바인딩합니다.
`run` 서브커맨드의 경우 `RunHandler.execute()`가 먼저 `ensureServerRunning()`을
호출하여 소켓 `/tmp/ollama.sock`의 응답성을 확인합니다. 실패 시 `cmd.StartServer()`로
백그라운드 serve 프로세스를 기동합니다. 이 과정에서 `api.Client{}`는 `OLLAMA_HOST`
환경변수(기본값 `http://127.0.0.1:11434`)를 읽어 엔드포인트를 결정합니다.
```

**핵심 차이점:**
- GOOD은 합니다체를 사용하고, 구체적 파일 경로(`cmd/cmd.go`), 함수명(`NewCLI()`, `ensureServerRunning()`), 변수명(`OLLAMA_HOST`), 기본값(`http://127.0.0.1:11434`)을 명시합니다.
- BAD는 해라체를 사용하고, 어떤 프로젝트에든 붙여넣을 수 있는 일반론입니다.

### Korean Writing Style Guide

0. **문체 — 합니다체(하십시오체) 필수**
   - 모든 Ko 필드(`overviewKo`, `summaryKo`, `bodyKo`)는 반드시 합니다체로 작성합니다
   - 허용 어미: `~합니다`, `~됩니다`, `~있습니다`, `~입니다`, `~했습니다`, `~됩니다`
   - 금지 어미 (해라체): `~한다`, `~된다`, `~있다`, `~이다`, `~였다`, `~했다`
   - 금지 어미 (해요체): `~해요`, `~돼요`, `~있어요`, `~이에요`
   - 한국어 위키백과, 공식 기술 문서, 학술 논문의 격식체와 동일한 수준을 목표로 합니다
   - `titleKo`는 명사형 종결이므로 어미 규칙 적용 대상이 아닙니다

1. **문단 구조** — 각 문단은 다음 패턴을 따릅니다:
   - **주제문**: 이 문단이 설명하는 코드 개념을 한 문장으로 제시합니다
   - **근거**: 실제 파일, 함수, 데이터 구조를 인용하며 동작을 설명합니다
   - **연결**: 다음 개념으로 자연스럽게 이어지는 전환문을 작성합니다

2. **용어 일관성** — 같은 개념에 같은 한국어 용어를 사용합니다:
   - 함수/메서드: `함수`로 통일 (메서드, 펑션 혼용 금지)
   - 호출: `호출`로 통일 (콜, 인보크 혼용 금지)
   - 반환값: `반환값`으로 통일 (리턴값, 결과값 혼용 금지)
   - 의존성: `의존성`으로 통일 (디펜던시 금지)
   - 처리: `처리`로 통일 (핸들링, 프로세싱 혼용 금지)

3. **코드 인용 규칙**:
   - 파일 경로는 항상 백틱으로 감쌉니다: `` `src/agent.ts` ``
   - 함수명과 변수명도 항상 백틱으로 감쌉니다: `` `validateSection()` ``
   - 영어 기술 용어(API, HTTP, JSON 등)는 백틱 없이 그대로 사용합니다
   - Mermaid 다이어그램은 실제 줄바꿈을 포함한 올바른 코드 블록으로 작성합니다

4. **분량 달성 전략** — 3,000자 최소를 자연스럽게 채우려면:
   - 함수의 **인자 형태와 반환 구조**를 설명합니다
   - **에러 처리 경로**와 실패 시 동작을 설명합니다
   - **호출 체인**을 단계별로 따라갑니다 (A → B → C, 각 단계에서 무슨 변환이 일어나는지)
   - 관련 **테스트 파일**을 언급하고 어떤 시나리오를 검증하는지 설명합니다
   - 다른 섹션과의 **연결점**을 명시합니다 (예: "이 스케줄러의 구체적 구현은 sec-3에서 다룹니다")

5. **문장 길이와 구조**
   - 한 문장은 80자(한글 기준) 이내를 권장합니다
   - 하나의 문장에 접속 어미("~고", "~며", "~어서", "~면서")를 2개까지만 허용합니다 — 3개 이상이면 문장을 나눕니다
   - 구어체·감탄 표현을 사용하지 않습니다: "꽤", "꽤나", "참", "정말", "너무", "매우"
   - "즉"은 한 문단당 최대 1회만 사용합니다 — 남용하면 모든 문단이 동일한 리듬을 갖게 됩니다

6. **위키 톤 — 중립적·객관적 서술**
   - 주관적 평가를 삼갑니다: "흥미롭다", "눈에 띈다", "인상적이다", "의미심장하다"
   - 추측·의견 관용구를 최소화합니다: "~하는 셈이다", "~라고 볼 수 있다", "~라고 보는 편이 맞다"
   - 독자에게 말 거는 표현을 삼갑니다: "초보자에게 이 섹션이 주는 메시지는 분명하다" → 삭제하거나 객관적 사실로 대체합니다
   - 코드 리뷰 톤을 삼갑니다: "이 선택은 중요하다", "눈여겨볼 필요가 있다" → "이 구현은 X 역할을 합니다"
   - 사실 → 사실 → 사실 패턴으로 서술합니다: 주어 + 동작 + 결과의 반복
   - ❌ "보안적으로 가장 흥미로운 파일은 `init-firewall.sh`다."
   - ✅ "`init-firewall.sh`는 컨테이너의 네트워크 정책을 허용 목록 기반으로 재구성합니다."

### Section-Type Writing Advice

각 섹션 유형별로 기대하는 내용이 다릅니다:

| 섹션 유형 | 반드시 포함해야 하는 내용 |
|-----------|--------------------------|
| **sub-1-1 프로젝트 개요** | 프로젝트가 무엇인지, 해결하는 문제, 핵심 목표와 기능, 설치·실행 방법, 위키 전체 구조 안내. 코드 분석 금지 — README/TL;DR 수준으로 작성합니다 |
| **입문자 빠른 시작** | 설치·실행 명령, 디렉토리 구조 트리, 진입점 파일 경로, Mermaid 아키텍처 다이어그램을 포함합니다 |
| **실행 아키텍처** | 호출 체인(진입 → 라우팅 → 처리 → 응답), 각 계층의 대표 파일과 함수, 시퀀스 다이어그램을 포함합니다 |
| **핵심 기능 구현** | 데이터 스키마/계약 정의, 변환 함수 시그니처, 상태 머신이 있으면 상태 전이도를 포함합니다 |
| **트렌드와 변화** | 릴리스 날짜·버전, 변경 파일 수, `__devport__/trends/*` 데이터를 인용합니다 |
| **검증 전략** | 테스트 파일 경로, 테스트가 검증하는 구체적 시나리오, 품질 게이트 기준값을 포함합니다 |
| **확장 포인트** | 플러그인/훅 인터페이스, 기여 가이드의 규칙, 설정 확장 방법을 포함합니다 |

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
