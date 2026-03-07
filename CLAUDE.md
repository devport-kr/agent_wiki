# portki public-agent instructions for Claude Code

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

## Required Flow

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

All agent-authored intermediate files must be written to `portki-output/workspace/` and prefixed with the repo slug.

Examples:

- `portki-output/workspace/redis-artifact.json`
- `portki-output/workspace/redis-section-plan.json`
- `portki-output/workspace/redis-section-2-output.json`

## Commands

### `ingest`

```bash
npx tsx src/agent.ts ingest --repo owner/repo --out portki-output/workspace/{repo-slug}-artifact.json
```

Read these fields from the artifact:

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

- `noop`: stop
- `incremental`: regenerate only the impacted sections
- `full-rebuild`: regenerate everything

### `plan-sections`

```bash
npx tsx src/agent.ts plan-sections --artifact portki-output/workspace/{repo-slug}-artifact.json --out portki-output/workspace/{repo-slug}-plan-context.json
```

### `validate-plan`

```bash
npx tsx src/agent.ts validate-plan --input portki-output/workspace/{repo-slug}-section-plan.json --context portki-output/workspace/{repo-slug}-plan-context.json --out portki-output/workspace/{repo-slug}-section-plan.json
```

### `persist-section`

```bash
npx tsx src/agent.ts persist-section --plan portki-output/workspace/{repo-slug}-section-plan.json --section sec-1 --input portki-output/workspace/{repo-slug}-section-1-output.json
```

What it does:

- validates the section JSON
- checks body length, repetition, Mermaid, and source paths
- updates the local `session.json`

What it does not do:

- database writes
- embedding generation
- external API calls

### `finalize`

```bash
npx tsx src/agent.ts finalize --plan portki-output/workspace/{repo-slug}-section-plan.json --advance_baseline
```

Outputs:

- `portki-output/wiki/{owner}/{repo}/README.md`
- `portki-output/wiki/{owner}/{repo}/01-sec-1.md`
- additional section Markdown files

### `package`

```bash
npx tsx src/agent.ts package --input portki-output/workspace/{repo-slug}-accepted-output.json --advance_baseline
```

This validates a monolithic accepted output and writes the same Markdown result.

## Writing Rules

- Use real snapshot files only.
- All Korean prose must use formal `합니다` style.
- Prefer 4 to 6 sections.
- Each section must have at least 3 subsections.
- Each `bodyKo` must be at least 3,000 characters.
- Include at least one Mermaid architecture block.
- `sourcePaths` must be real snapshot paths.
- Do not use repetitive filler blocks.

## `sub-1-1` Override

`sub-1-1` is the project introduction summary.

- explain the project purpose
- explain the problem space
- include getting-started guidance
- briefly map the remaining sections

Code call-flow analysis should begin in `sub-1-2` or later.

## Output Paths

```text
portki-output/
  workspace/
  snapshots/{owner}/{repo}/
  chunked/{owner}/{repo}/session.json
  wiki/{owner}/{repo}/
  freshness/state.json
```
