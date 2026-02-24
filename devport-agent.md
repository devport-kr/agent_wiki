# devport-agent

> AI-powered Korean Code Wiki Generator for Open-Source Projects
> Built with [get-shit-done](https://github.com/gsd-build/get-shit-done) | Runs in opencode / Claude Code

---

## Project Vision

devport-agent is an AI agent that dynamically discovers popular open-source GitHub projects and generates **rich, comprehensive Korean-language code wikis** — modeled after [Google Code Wiki (codewiki.google)](https://codewiki.google/). It serves as the wiki content generator for the devport project's port/wiki system.

Unlike brief summaries or simple hands-on guides, devport-agent produces **deep, structured documentation** comparable to what codewiki.google generates — but in Korean, for the Korean developer community.

### Separation of Concerns

- **devport-agent** (this project): Generates wiki content as **JSON** and outputs it for storage
- **devport-api** (`../devport-api`): Handles storage (PostgreSQL), RAG chatbot, publishing workflow, versioning, and serving wikis to users

The agent's sole responsibility is **content generation** — it produces structured JSON that maps to the devport-api's existing wiki schema (`ProjectWikiSnapshot`, `WikiDraft`, `WikiPublishedVersion` entities with JSONB `sections` field).

---

## Problem Statement

1. **Korean developers lack rich, native-language documentation** for major open-source projects. Most documentation exists only in English, and existing Korean resources are shallow blog posts or partial translations.
2. **Code Wiki (codewiki.google)** demonstrates that AI can generate comprehensive, always-up-to-date project documentation — but it only serves English content.
3. **There is no Korean equivalent** — no platform that automatically generates and maintains deep Korean code wikis for open-source projects.

---

## Benchmark: Google Code Wiki (codewiki.google)

### What It Is

Google Code Wiki is a Gemini-powered platform that auto-generates rich, interactive documentation from GitHub repositories. It features:

- AI-generated wikis that stay up-to-date with every merged PR
- Featured repositories (Kubernetes, React, Go, Flutter, etc.)
- Chat-with-codebase functionality (RAG-based Q&A)
- Architecture diagrams auto-generated from code
- Deep-linked references back to source code

### Content Structure (Analyzed from Kubernetes, React, Go wikis)

Each project wiki follows this pattern:

```
Project Wiki Root
|
+-- Overview (프로젝트 개요)
|   - What the project is
|   - Key functional areas listed with descriptions
|   - Links to each major section
|
+-- Major Section 1 (e.g., "API Definition and Enforcement")
|   +-- Deep prose explanation (2,000-10,000+ words)
|   +-- Sub-section: Component A
|   |   - Detailed technical explanation
|   |   - File references (linked back to source)
|   |   - Cross-references to related sections
|   +-- Sub-section: Component B
|   +-- Sub-section: Component C
|
+-- Major Section 2 (e.g., "Core Control Plane Components")
|   +-- Same deep structure...
|
+-- ... (6-16 major sections per project)
|
+-- Table of Contents sidebar (always visible)
+-- Chat interface (RAG-based Q&A)
+-- Diagrams (architecture visualizations)
+-- Metadata: generation date, commit hash, "Gemini can make mistakes" disclaimer
```

### Content Characteristics (Key Benchmarks)

| Characteristic | Google Code Wiki | devport-agent Target |
|---|---|---|
| **Content depth** | 2,000-10,000+ words per major section | Same depth, in Korean |
| **Total wiki size** | 50,000-200,000+ words per project | Equivalent |
| **Code references** | Inline file paths linked to source | Same, with GitHub links |
| **Cross-references** | Sections link to related sections | Same |
| **Auto-update** | Re-generated on PR merge | Scheduled re-generation |
| **Diagrams** | Architecture diagrams from code | Architecture diagrams |
| **Chat/Q&A** | "Chat with your codebase" via Gemini | RAG chatbot (via devport-api) |
| **Language** | English only | Korean (primary) |
| **Section count** | 6-16 major sections per project | Same |
| **Sub-sections** | 3-10 per major section | Same |
| **Technical precision** | Source file references, API details | Same |

### Content Depth Examples

**Kubernetes wiki** generated these major sections:
1. Kubernetes API Definition and Enforcement
2. Kubernetes Core Control Plane Components
3. Node-Level Agent and Proxy
4. Kubernetes Object Management and Controllers
5. Cluster Lifecycle Management with Kubeadm
6. API Request Admission, Authentication, and Authorization
7. Kubernetes Command-Line Tools
8. Internal Build System and Development Utilities
9. Staging and Third-Party Dependencies

Each section has 3-8 sub-sections, each sub-section containing 500-3,000 words of technical prose with inline code references.

**React wiki** generated:
1. React Project Management and Contribution
2. React Compiler (with sub-sections: Internals, Pipeline, Playground)
3. React Renderer Implementations (DOM, Native, Server Components)
4. React Core Utilities and Packages
5. Development Scripts and Testing Infrastructure

**Go wiki** generated 16+ major sections covering everything from language spec to cryptographic primitives.

---

## Architecture

### System Overview

```
+------------------+     +-------------------+     +---------------------------+
|  GitHub Search   |     |  Wiki Generation  |     |  devport-api              |
|  Agent           |---->|  Agent            |---->|  (existing backend)       |
|                  |     |                   |     |                           |
|  - Discover      |     |  - Clone repo     |     |  - ProjectWikiSnapshot    |
|    trending/     |     |  - Analyze code   |     |  - WikiDraft              |
|    popular repos |     |  - Generate       |     |  - WikiPublishedVersion   |
|  - Filter by     |     |    Korean wiki    |     |  - WikiChatService (RAG)  |
|    quality/stars |     |  - Output JSON    |     |  - PostgreSQL + Redis     |
|  - Track updates |     |    sections       |     |  - Publishing workflow    |
+------------------+     +-------------------+     +---------------------------+
                                |
                                v
                         JSON output matching
                         devport-api schema
                         (JSONB sections format)
```

### Agent Pipeline (2-Stage)

#### Stage 1: Discovery Agent (GitHub Search)
- Search GitHub for trending, popular open-source projects
- Filter criteria: stars, activity, license, language diversity
- Maintain a registry of tracked projects
- Detect when projects have new releases or significant changes
- Output: list of repositories to generate/update wikis for

#### Stage 2: Wiki Generation Agent (Core)
- Clone/pull the target repository
- Analyze codebase structure: directory tree, key files, architecture
- Generate comprehensive Korean wiki following the codewiki.google structure:
  - **프로젝트 개요** (Project Overview): what it is, key functional areas
  - **주요 섹션** (Major Sections): 6-16 sections based on codebase analysis
  - **하위 섹션** (Sub-sections): 3-10 per major section with deep technical prose
  - **코드 참조** (Code References): inline file paths linked to GitHub
  - **상호 참조** (Cross-references): sections linking to related sections
  - **아키텍처 다이어그램** (Architecture Diagrams): Mermaid diagram strings
- All content in natural, technical Korean (not machine-translated)
- Output: **JSON** matching devport-api's wiki schema

> **Note:** RAG chatbot, embedding, storage, versioning, and publishing are handled by **devport-api** — not this agent.

### Korean Content Quality Standards

The generated Korean wikis must meet these standards:

1. **Natural Korean technical writing** — not literal translation from English. Use established Korean CS terminology (e.g., "배포" for deployment, "의존성" for dependency, "동시성" for concurrency).
2. **Depth over brevity** — each major section should be 2,000-10,000+ words equivalent, matching codewiki.google depth.
3. **Technical precision** — include exact file paths, API signatures, and code snippets from the actual repository.
4. **Korean developer context** — where relevant, add context that Korean developers specifically need (e.g., Korean community resources, Korean-language alternatives).
5. **Consistent terminology** — maintain a glossary (용어집) per project for consistent translation of technical terms.

### JSON Output Format (devport-api Integration)

The agent outputs JSON that maps directly to devport-api's `ProjectWikiSnapshot` entity with dynamic JSONB `sections`. The devport-api already has:

- `ProjectWikiSnapshot` — live wiki with dynamic sections (JSONB), current counters, readiness gates
- `WikiDraft` — editable drafts per project
- `WikiPublishedVersion` — versioned snapshots with `(project_id, version_number)` unique constraint
- `WikiChatService` — RAG chatbot powered by OpenAI APIs, grounded on wiki content
- `WikiFreshnessSignalService` — updates wiki from crawler webhooks
- `WikiSectionVisibilityService` — controls which sections are shown/hidden

Each generated wiki outputs JSON in this structure:

```json
{
  "projectExternalId": "uuid-from-devport-api",
  "repositoryFullName": "kubernetes/kubernetes",
  "generatedAt": "2026-02-17T06:00:00Z",
  "commitHash": "918b5ac",
  "sections": [
    {
      "key": "project-overview",
      "titleKo": "프로젝트 개요",
      "titleEn": "Project Overview",
      "contentKo": "이 저장소는 Kubernetes 클러스터 관리 시스템을 구현하며...",
      "order": 0,
      "subSections": [
        {
          "key": "key-functional-areas",
          "titleKo": "핵심 기능 영역",
          "contentKo": "소프트웨어는 여러 주요 기능 영역을 포함합니다...",
          "codeReferences": [
            { "filePath": "pkg/apis/core/types.go", "description": "핵심 API 객체 정의" }
          ],
          "order": 0
        }
      ]
    },
    {
      "key": "api-definition-enforcement",
      "titleKo": "Kubernetes API 정의 및 적용",
      "titleEn": "Kubernetes API Definition and Enforcement",
      "contentKo": "Kubernetes API는 리소스의 원하는 상태와 현재 상태를 나타내는 내부 Go 구조체를 통해 정의됩니다...",
      "order": 1,
      "subSections": [
        {
          "key": "core-api-definitions",
          "titleKo": "핵심 API 객체 정의 및 스킴 등록",
          "contentKo": "Kubernetes API 객체는 Pod, Deployment, StatefulSet 등의 리소스 상태를 나타내는 Go 구조체로 정의됩니다...",
          "codeReferences": [
            { "filePath": "pkg/apis/core/types.go", "description": "핵심 타입 정의" },
            { "filePath": "pkg/apis/apps/register.go", "description": "스킴 등록" }
          ],
          "crossReferences": ["api-versioning", "api-validation"],
          "diagrams": [
            { "type": "mermaid", "code": "graph TD; A[API Request] --> B[Versioned]; B --> C[Internal]; C --> D[Validation]" }
          ],
          "order": 0
        }
      ]
    }
  ],
  "glossary": [
    { "en": "Pod", "ko": "파드", "description": "Kubernetes에서 배포 가능한 가장 작은 단위" },
    { "en": "Deployment", "ko": "디플로이먼트", "description": "파드의 선언적 업데이트를 관리하는 리소스" }
  ],
  "metadata": {
    "totalSections": 9,
    "totalSubSections": 42,
    "estimatedCharCount": 150000,
    "languageModel": "claude-opus-4-6",
    "generationDurationMs": 180000
  }
}
```

This JSON is then consumed by devport-api which:
1. Stores it as a `WikiDraft` or directly as a `ProjectWikiSnapshot`
2. Handles versioning via `WikiPublishedVersion`
3. Feeds it into the RAG chatbot via `WikiChatService`
4. Controls section visibility via `WikiSectionVisibilityService`
5. Updates freshness signals via `WikiFreshnessSignalService`

---

## Technical Stack & Framework

### Built With: get-shit-done (GSD)

This project uses the [GSD framework](https://github.com/gsd-build/get-shit-done) for structured AI agent development:

- **Context engineering**: documents stay under degradation thresholds, fresh 200k token windows per executor
- **Multi-agent orchestration**: parallel research agents, planner + verifier, wave-based execution
- **Spec-driven development**: PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md drive all work
- **Atomic commits**: one commit per completed task, enabling git bisect and clean history

### GSD Workflow for This Project

```
/gsd:new-project       -> Discovery, requirements, roadmap
/gsd:discuss-phase N   -> Lock implementation decisions per phase
/gsd:plan-phase N      -> Research + verified atomic plans
/gsd:execute-phase N   -> Parallel wave execution
/gsd:verify-work N     -> User acceptance testing
```

### Runtime: opencode / Claude Code

The agent is designed to run in:
- **opencode** (primary target)
- **Claude Code** (compatible)
- **Gemini CLI** (compatible via GSD)

### Core Technologies (Planned)

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Agent framework | GSD + LLM orchestration | Multi-agent pipeline |
| GitHub API | GitHub REST/GraphQL API | Repository discovery & metadata |
| Code analysis | Tree-sitter / AST parsing | Codebase structure analysis |
| Wiki generation | LLM (Claude/GPT) | Korean content generation |
| Output format | JSON | Matches devport-api's JSONB wiki schema |
| Diagrams | Mermaid | Architecture visualization (as strings in JSON) |

> **Handled by devport-api** (not this agent): PostgreSQL storage, Redis caching, RAG embeddings, chatbot, publishing workflow, versioning, section visibility

---

## Goals

### v1 Goals (MVP)

1. **GitHub Discovery Agent**: automatically find and track top 50 open-source projects by category (web frameworks, languages, databases, ML, etc.)
2. **Wiki Generation for 10 projects**: generate full Korean code wikis matching codewiki.google depth for 10 flagship projects (e.g., Kubernetes, React, Go, Next.js, FastAPI, PyTorch, etc.)
3. **Content depth benchmark**: each wiki must have 6+ major sections, 3+ sub-sections each, totaling 50,000+ Korean characters per project
4. **Source code linking**: every wiki section references relevant source files on GitHub
5. **JSON output**: structured output matching devport-api's `ProjectWikiSnapshot` JSONB schema
6. **Terminology glossary**: per-project Korean-English technical glossary embedded in JSON

### v2 Goals

1. **Scale to 100+ projects** with automated scheduling
2. **Delta updates**: detect changes (new releases, significant PRs) and regenerate only affected sections
3. **Architecture diagrams**: auto-generated Mermaid diagrams per project (as strings in JSON)
4. **Webhook integration**: trigger devport-api's `CrawlerWebhookController` on wiki generation completion
5. **Quality scoring**: self-evaluate generated content against codewiki.google depth benchmarks

### Out of Scope (Handled by devport-api)

- RAG chatbot / embedding / vector search → `WikiChatService` in devport-api (OpenAI API)
- Wiki storage / versioning / publishing → `WikiDraft` / `WikiPublishedVersion` in devport-api
- Section visibility controls → `WikiSectionVisibilityService` in devport-api
- User-facing API / frontend → devport-api + devport-web
- English wiki generation (English already served by codewiki.google)
- Non-GitHub repositories (GitLab, Bitbucket — future consideration)

---

## Key Differentiators vs. codewiki.google

| Feature | codewiki.google | devport (agent + api) |
|---------|----------------|----------------------|
| Language | English | **Korean** |
| Content source | Gemini analysis | Multi-LLM analysis (Claude/GPT) |
| Terminology | English CS terms | **Korean CS terminology with glossary** |
| Cultural context | Global | **Korean developer community focused** |
| Platform | Google hosted | **Self-hosted / devport integrated** |
| Chat | Gemini chat | **RAG chatbot via devport-api (OpenAI API)** |
| Open source | No | **Yes** |
| Customizable | No | **Yes — section visibility, depth controls** |
| Output format | Rendered HTML | **JSON → devport-api → rendered** |

---

## Project Structure

```
devport-agent/
├── .planning/                  # GSD planning artifacts
│   ├── PROJECT.md
│   ├── REQUIREMENTS.md
│   ├── ROADMAP.md
│   ├── STATE.md
│   └── research/
├── .claude/                    # GSD + Claude Code config
├── agents/
│   ├── discovery/              # GitHub search & tracking agent
│   ├── generator/              # Wiki generation agent (core)
│   └── orchestrator/           # Pipeline coordinator
├── templates/
│   └── wiki-schema.json        # JSON schema for wiki output
├── glossary/
│   └── common-terms.json       # Shared Korean CS terminology
├── output/
│   └── wikis/                  # Generated wiki JSON files
│       ├── kubernetes.json
│       ├── react.json
│       └── ...
├── devport-agent.md            # This file — project spec
└── a-practical-guide-to-building-agents.pdf  # Reference material

# Related project:
# ../devport-api/               # Spring Boot backend (PostgreSQL, Redis, RAG, publishing)
#   └── src/main/java/kr/devport/api/domain/wiki/  # Wiki domain entities & services
```

---

## References

- [Google Code Wiki (codewiki.google)](https://codewiki.google/) — Benchmark platform
- [get-shit-done (GSD)](https://github.com/gsd-build/get-shit-done) — Agent development framework
- [A Practical Guide to Building Agents](./a-practical-guide-to-building-agents.pdf) — Agent design patterns reference
- [opencode](https://github.com/nicepkg/opencode) — Target runtime environment
- **devport-api** (`../devport-api`) — Backend that consumes this agent's JSON output (Spring Boot 4, PostgreSQL 16, Redis 7, OpenAI API for RAG chatbot)
