# devport-agent — How to Use This

## What This Is

`src/agent.ts` is a tool interface. You (the AI — Claude Code, opencode, whatever) are the intelligence. This script handles the mechanical, deterministic parts:

- **ingest** — snapshot a GitHub repo to disk
- **detect** — compare repo HEAD against last delivery, find what changed
- **package** — validate the output you generated, write `delivery.json`

You read the snapshot, understand the code, and write the wiki. The script never calls another AI.

## 2026-02-22 Beginner/Trend Hard-Swap

- Wiki generation is citationless. Do not produce claim/citation/grounding artifacts.
- Plan shape is beginner/trend-first (4-6 sections) and must include one architecture Mermaid block.
- Section evidence uses `sourcePaths` and can reference synthetic snapshot paths under `__devport__/trends/*` and `__devport__/official-docs/*`.
- Ingestion should mirror trend data and official docs into snapshot artifacts.

---

## Prerequisites

No token needed for public repos. `ingest` and `detect` make unauthenticated GitHub API requests by default (60 req/hour limit — enough for normal use).

For **private repos** or if you hit rate limits, add a token:

```
GITHUB_TOKEN=ghp_...   # optional — private repos or high-volume use
```

Quality-first runtime defaults:

```bash
DEVPORT_SNAPSHOT_BACKEND=hybrid
DEVPORT_PLANNER_VERSION=v2
DEVPORT_QUALITY_GATE_LEVEL=strict
DEVPORT_TREND_WINDOW_DAYS=180
DEVPORT_OFFICIAL_DOC_DISCOVERY=auto
```

When using S3 snapshot storage, also configure:

```bash
DEVPORT_S3_BUCKET=...
DEVPORT_S3_REGION=...
DEVPORT_S3_PREFIX=snapshots
```

---

## Commands

### `ingest`

Downloads (or uses cache) a repo snapshot and emits an artifact JSON.

```bash
npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json
```

**Flags:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--repo` | yes | — | `owner/repo` or `owner/repo@ref` |
| `--ref` | no | default branch | branch name, tag, or full commit SHA |
| `--out` | no | stdout | where to write artifact JSON |
| `--snapshot_root` | no | `devport-output/snapshots` | where snapshots are cached |
| `--snapshot_backend` | no | env or `hybrid` | snapshot backend mode (`local`, `s3`, `hybrid`) |
| `--lease_cache_max_bytes` | no | env | local lease-cache cap for hydration |
| `--force_rebuild` | no | false | re-download even if cached |

**What you get:**

`artifact.json` contains:
- `commit_sha` — the exact commit that was snapshotted
- `snapshot_path` — local directory where all repo files are stored flat
- `files_scanned`, `metadata.key_paths`, `metadata.language_mix` — repo overview
- `idempotent_hit: true` — cache was used; `false` — freshly downloaded

The files at `snapshot_path` are what you read to understand the codebase.

---

### `detect`

Compares GitHub's current HEAD against the last commit you delivered. Tells you what changed and which sections need to be regenerated.

```bash
npx tsx src/agent.ts detect --repo owner/repo
```

**Flags:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--repo` | yes | — | `owner/repo` |
| `--state_path` | no | `devport-output/freshness/state.json` | freshness baseline file |

**stdout output (always JSON):**

```json
{
  "status": "noop",
  "repo_ref": "owner/repo",
  "base_commit": "abc1234...",
  "head_commit": "def5678...",
  "changed_paths": [],
  "impacted_section_ids": []
}
```

**`status` values:**

| Value | Meaning | What to do |
|-------|---------|------------|
| `noop` | Nothing changed since last delivery | Stop. Delivery is current. |
| `incremental` | Some files changed, specific sections impacted | Regenerate only `impacted_section_ids` |
| `full-rebuild` | Too many changes, or no baseline exists yet | Regenerate everything |

`detect` requires a freshness baseline. The baseline is created the first time you run `package --advance_baseline`. If it doesn't exist yet, you get `"status": "full-rebuild"` with `"reason": "BASELINE_MISSING"`.

---

### `package`

Takes the `GroundedAcceptedOutput` you produced, validates it against the OUT-04 delivery contract, builds the glossary and provenance, and writes `delivery.json`.

```bash
npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
```

Or pipe from stdin:

```bash
cat accepted-output.json | npx tsx src/agent.ts package --advance_baseline
```

**Flags:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--input` | no | stdin | path to your generated `GroundedAcceptedOutput` JSON |
| `--out_dir` | no | `devport-output/delivery` | root dir for delivery output |
| `--quality_gate_level` | no | env or `strict` | strictness for semantic quality checks (`standard`, `strict`) |
| `--advance_baseline` | no | false | save freshness state so `detect` works next time |
| `--state_path` | no | `devport-output/freshness/state.json` | where to save the baseline |

**Output:**

```
devport-output/delivery/{owner}/{repo}/delivery.json
```

**Always use `--advance_baseline` unless you have a specific reason not to.** Without it, `detect` will say `BASELINE_MISSING` every time and force a full rebuild.

---

## Workflows

### First run — generate a wiki for a repo

```bash
# 1. Snapshot the repo
npx tsx src/agent.ts ingest --repo google-gemini/gemini-cli --out artifact.json

# 2. Read artifact.json to know: commit_sha, snapshot_path, key_paths, language_mix
#    Read files under snapshot_path to understand the codebase
#    Generate a GroundedAcceptedOutput → write it to accepted-output.json

# 3. Validate, package, and save freshness baseline
npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
```

Result: `devport-output/delivery/google-gemini/gemini-cli/delivery.json`

---

### Incremental update — repo has new commits

```bash
# 1. Check what changed
npx tsx src/agent.ts detect --repo google-gemini/gemini-cli

# If status=noop: stop, nothing to do.

# If status=incremental or full-rebuild:
# 2. Snapshot at the new HEAD
npx tsx src/agent.ts ingest --repo google-gemini/gemini-cli --out artifact.json

# 3. Read artifact.json + snapshot files
#    For incremental: regenerate ONLY the sections listed in impacted_section_ids
#    For full-rebuild: regenerate all sections
#    Write result to accepted-output.json

# 4. Package and advance baseline
npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
```

---

## What You Generate (`GroundedAcceptedOutput`)

This is the JSON structure you write to `accepted-output.json`. Every field is required.

```typescript
{
  ingest_run_id: string,        // copy from artifact.json
  repo_ref: string,             // "owner/repo" lowercase
  commit_sha: string,           // copy from artifact.json
  section_count: number,
  subsection_count: number,
  total_korean_chars: number,   // count of Korean characters across all bodyKo fields
  claim_count: number,
  citation_count: number,

  draft: {
    artifactType: "wiki-draft",
    repoFullName: string,       // lowercase owner/repo
    commitSha: string,
    generatedAt: string,        // ISO 8601
    overviewKo: string,         // Korean overview paragraph

    sections: [{
      sectionId: string,        // "sec-1", "sec-2", ...
      titleKo: string,
      summaryKo: string,
      subsections: [{
        sectionId: string,      // same as parent sectionId
        subsectionId: string,   // "sub-1-1", "sub-1-2", ...
        titleKo: string,
        objectiveKo: string,
        bodyKo: string,         // main Korean content, minimum 3,000 chars — aim for 4,000–5,000
        targetEvidenceKinds: ["code" | "tests" | "config" | "docs"],
        targetCharacterCount: number
      }]
    }],

    claims: [{
      claimId: string,          // "claim-1", "claim-2", ...
      sectionId: string,
      subsectionId: string,
      statementKo: string,      // Korean claim, minimum 20 chars
      citationIds: string[]     // must reference real citationIds below
    }],

    citations: [{
      citationId: string,       // "cit-1", "cit-2", ...
      evidenceId: string,
      repoPath: string,         // file path within the repo
      lineRange: { start: number, end: number },
      commitSha: string,
      permalink: string,        // github.com/{repo}/blob/{sha}/{path}#L{start}-L{end}
      rationale: string         // Korean, why this code supports the claim
    }],

    groundingReport: {
      artifactType: "grounding-report",
      gateId: "GND-03",
      checkedAt: string,        // ISO 8601
      passed: true,
      totalClaims: number,
      claimsWithCitations: number,
      citationCoverage: number, // 0.0–1.0
      issues: []
    }
  },

  grounding_report: { /* same as draft.groundingReport */ }
}
```

**Hard constraints enforced by `package`:**

- Minimum **6 sections**, each with minimum **3 subsections**
- At least **1 cross-reference** between sections (in `draft` — handled internally)
- Every claim's `citationIds` must reference a real citation in `draft.citations`
- `groundingReport.passed` must be `true`
- `project.commitSha` must equal `provenance.commitSha` (set them both from `artifact.commit_sha`)
- Glossary is auto-built from Korean text — no need to generate it manually
- `delivery.json` is written to `devport-output/delivery/{owner}/{repo}/delivery.json`

If validation fails, `package` throws with a specific OUT-04 error message telling you exactly what's wrong.

---

## File Layout

```
.planning/
  ingestion-snapshots/          # cached repo snapshots (managed by ingest)
    google-gemini/
      gemini-cli/
        {commitSha}/            # flat snapshot of the repo at that commit
          manifest.json
          src/...
          README.md
          ...

  delivery/                     # final output (written by package)
    google-gemini/
      gemini-cli/
        delivery.json

  freshness/
    state.json                  # baseline for detect (written by package --advance_baseline)
```

---

## Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `--repo is required` | Missing `--repo` flag | Add `--repo owner/repo` |
| `OUT-04 validation failed` | Your output JSON failed the delivery contract | Read the error message — it names the exact field |
| `No input provided. Pipe JSON or use --input` | Called `package` without `--input` and nothing piped | Use `--input accepted-output.json` |
| `BASELINE_MISSING` from detect | `package --advance_baseline` was never run | Run a full generation first, then `package --advance_baseline` |
| `freshness baseline not saved` (warning) | `--advance_baseline` failed because sections have no citation paths | Ensure your claims have `citationIds` that map to citations with `repoPath` |
