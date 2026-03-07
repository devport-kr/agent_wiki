# portki public-agent instructions

## Role

You are the AI agent operating this tool. This repository is the public branch of the devport wiki generator. It reads public GitHub repositories and produces Korean wiki content as plain Markdown files. `src/agent.ts` handles the deterministic pipeline only. The agent is responsible for understanding the codebase and writing the content.

Do not call external LLM APIs. Do not add OpenAI or Anthropic API usage.

## Public Branch Rules

- This branch is the public version.
- There is no DB, no embeddings, no PostgreSQL, and no OpenAI API dependency.
- It should work without `.env` setup.
- Final output lives under `portki-output/wiki/{owner}/{repo}/` as Markdown files.
- `persist-section` means local validation plus session registration only.
- `finalize` assembles the full Markdown wiki bundle.
- `package` is the monolithic path that exports Markdown directly from a full accepted output.

## Only Use `src/agent.ts`

The only supported commands are:

- `ingest`
- `detect`
- `package`
- `plan-sections`
- `validate-plan`
- `persist-section`
- `finalize`

Do not use legacy entrypoints.

## Required End-to-End Flow

Preferred chunked flow:

1. `ingest`
2. `plan-sections`
3. The agent writes `section-plan.json`
4. `validate-plan`
5. The agent writes section outputs
6. `persist-section` for each section
7. `finalize --advance_baseline`

Monolithic alternative for small repos:

1. `ingest`
2. The agent writes `accepted-output.json`
3. `package --advance_baseline`

## Public Repo Assumption

- This branch targets public repositories by default.
- `GITHUB_TOKEN` is not required.
- Private repository support is out of scope for this branch.

## Workspace Naming Rule

If multiple repos are processed in parallel, all agent-authored intermediate files must be stored in `portki-output/workspace/` and prefixed with the repo slug.

Examples:

- `portki-output/workspace/ollama-artifact.json`
- `portki-output/workspace/ollama-section-plan.json`
- `portki-output/workspace/ollama-section-1-output.json`

## Commands

### `ingest`

```bash
npx tsx src/agent.ts ingest --repo owner/repo --out portki-output/workspace/{repo-slug}-artifact.json
```

The agent must read these fields:

- `ingest_run_id`
- `commit_sha`
- `repo_ref`
- `snapshot_path`
- `files_scanned`
- `metadata.key_paths`
- `metadata.language_mix`

### `detect`

```bash
npx tsx src/agent.ts detect --repo owner/repo
```

Interpret the status as:

- `noop`: do nothing
- `incremental`: regenerate only `impacted_section_ids`
- `full-rebuild`: regenerate everything

### `plan-sections`

```bash
npx tsx src/agent.ts plan-sections --artifact portki-output/workspace/{repo-slug}-artifact.json --out portki-output/workspace/{repo-slug}-plan-context.json
```

The output includes:

- `profile`
- `readmeExcerpt`
- `keyPaths`
- `fileTree`
- `constraints`

### `validate-plan`

```bash
npx tsx src/agent.ts validate-plan --input portki-output/workspace/{repo-slug}-section-plan.json --context portki-output/workspace/{repo-slug}-plan-context.json --out portki-output/workspace/{repo-slug}-section-plan.json
```

### `persist-section`

```bash
npx tsx src/agent.ts persist-section --plan portki-output/workspace/{repo-slug}-section-plan.json --section sec-1 --input portki-output/workspace/{repo-slug}-section-1-output.json
```

This command only does the following:

- validates the section JSON schema
- checks body length, repetition, Mermaid, and source paths
- updates `session.json`

It does not write to a database, generate embeddings, or call external APIs.

### `finalize`

```bash
npx tsx src/agent.ts finalize --plan portki-output/workspace/{repo-slug}-section-plan.json --advance_baseline
```

This command:

- validates cross-section repetition
- assembles persisted sections from the local session
- writes `portki-output/wiki/{owner}/{repo}/README.md`
- writes section Markdown files such as `portki-output/wiki/{owner}/{repo}/01-sec-1.md`
- optionally advances the freshness baseline

### `package`

```bash
npx tsx src/agent.ts package --input portki-output/workspace/{repo-slug}-accepted-output.json --advance_baseline
```

This validates a monolithic accepted output and writes the same Markdown wiki bundle.

## Section Writing Rules

- Read actual files from the snapshot.
- All Korean prose must use formal `합니다` style.
- Prefer 4 to 6 sections.
- Each section must have at least 3 subsections.
- Each `bodyKo` must be at least 3,000 characters.
- At least one architecture Mermaid block must exist.
- `sourcePaths` must point to real files in the snapshot.
- Do not pad with repeated sentences or repeated long blocks.

## `sub-1-1` Override

`sub-1-1` is the project-level introduction.

- Explain what the project is and why it exists.
- Include installation or getting-started guidance.
- Briefly map what the remaining sections cover.
- Do not make it a code call-flow analysis section.

## Output Shape

Per-section output:

```json
{
  "sectionId": "sec-1",
  "titleKo": "Project Overview",
  "summaryKo": "This section explains ...",
  "sourcePaths": ["README.md", "src/main.ts"],
  "subsections": [
    {
      "sectionId": "sec-1",
      "subsectionId": "sub-1-1",
      "titleKo": "Project Introduction and Overview",
      "bodyKo": "..."
    }
  ]
}
```

The final result is Markdown, not a delivery JSON artifact.

## Output Paths

```text
portki-output/
  workspace/
  snapshots/{owner}/{repo}/
  chunked/{owner}/{repo}/session.json
  wiki/{owner}/{repo}/
  freshness/state.json
```
