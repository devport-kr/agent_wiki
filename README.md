# portki (포트키)

<div align="center">

[![NPM version](https://img.shields.io/npm/v/@devport-kr/portki?style=flat-square)](https://www.npmjs.com/package/@devport-kr/portki) [![Node.js version](https://img.shields.io/badge/Node.js-20%2B-brightgreen?style=flat-square)](https://nodejs.org) [![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)


 ###  **portki**는 **ports** + **wiki** 의 합성어로 ['포트키(Portkey)'](https://en.wikipedia.org/wiki/Magical_objects_in_Harry_Potter#Portkeys)처럼 순간이동해 다양한 AI 프로젝트를 만날 수 있는 Agent 입니다. 

 **[devport](https://devport.kr)의 [ports](https://devport.kr/ports)에 있는 모든 위키를 책임지고 있습니다.**
 
</div>




### 🤖 실행 지원 환경 (Supported CLI Environments)

portki는 대표적인 CLI 기반 AI 에이전트들과 완벽하게 통합됩니다. 각 환경에 맞춘 최적화된 어댑터를 통해 위키 생성 파이프라인을 쉽게 구축할 수 있습니다.

<div align="center" style="display: flex; justify-content: center; gap: 40px; margin: 20px 0;">
  <a href="https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview" style="text-decoration:none; color:inherit; display:inline-flex; align-items:center; gap:8px;">
    <img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude-color.svg" width="28" height="28" alt="Claude Code" />
    <b>Claude Code</b>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://platform.openai.com" style="text-decoration:none; color:inherit; display:inline-flex; align-items:center; gap:8px;">
    <img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/codex-color.svg" width="28" height="28" alt="OpenAI Codex" />
    <b>Codex</b>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://ai.google.dev/" style="text-decoration:none; color:inherit; display:inline-flex; align-items:center; gap:8px;">
    <img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/gemini-color.svg" width="28" height="28" alt="Gemini CLI" />
    <b>Gemini CLI</b>
  </a>
</div>


---

## 📦 설치 (Installation)

**Node.js 20 이상**이 필요합니다.

```bash
npm install -g @devport-kr/portki
portki help
```

**환경 점검:** 현재 시스템 환경이 portki를 실행하기에 적합한지 확인하려면 아래 명령어를 사용하세요.
```bash
portki doctor
```

---

## 🚀 빠른 시작 (Quick Start)


> 💡 **안내:** 아래 명령어들에 사용된 `devport-kr/portki`는 예시 저장소입니다. 실제로 위키를 생성하고자 하는 대상 GitHub 저장소(예: `facebook/react`, `owner/repo`)로 변경하여 실행해 주세요.

### 1. Claude Code
프로젝트 루트에서 어댑터를 설치한 후, Claude Code 내에서 슬래시 명령어로 실행합니다.

```bash
# 어댑터 설치 (최초 1회)
portki install --agent claude

# Claude Code에서 실행
/portki devport-kr/portki
```
*참고: 어댑터를 설치하지 않은 경우 터미널에서 `portki devport-kr/portki`를 실행한 뒤, 출력되는 `handoff.md`의 경로를 Claude에게 직접 전달해도 됩니다.*

### 2. Codex (OpenAI)
Codex 환경에 맞게 `AGENTS.md` 파일에 portki 사용법을 자동으로 추가합니다.

```bash
# 어댑터 설치 (최초 1회)
portki install --agent codex
```
*Codex 사용 예시:* "portki devport-kr/portki 실행하고, handoff.md 지침을 따라서 위키를 만들어줘."

### 3. Gemini CLI
Gemini CLI 환경을 위한 전용 슬래시 명령어를 설정합니다.

```bash
# 어댑터 설치 (최초 1회)
portki install --agent gemini

# Gemini CLI에서 실행
/portki devport-kr/portki
```

---

## ⚙️ 주요 명령어 (Commands)

portki는 AI 에이전트의 원활한 작업을 위한 상위 명령어와, 디테일한 제어를 위한 하위 명령어를 제공합니다.

| 분류 | 명령어 | 설명 |
|---|---|---|
| **기본 실행** | `portki owner/repo` | 저장소를 분석하고 AI 에이전트용 작업 지침서(`handoff.md`)를 생성합니다. |
| **상태 관리** | `portki status owner/repo` | 현재 진행 중인 파이프라인의 작업 상태를 확인합니다. |
| | `portki resume owner/repo` | 중단된 작업을 마지막으로 완료된 단계부터 이어서 진행합니다. |
| **환경 설정** | `portki doctor` | 시스템 실행 환경 및 의존성 상태를 점검합니다. |
| | `portki install --agent <name>` | 특정 AI 에이전트(`claude`, `codex`, `gemini`)용 어댑터를 설치합니다. |

*(수동 작업 및 세밀한 파이프라인 제어가 필요한 경우 `ingest`, `plan-sections`, `validate-plan`, `persist-section`, `finalize`, `detect` 등의 하위 명령어를 지원합니다.)*

---

## 🔄 워크플로우 (Workflows)

portki는 코드베이스 규모에 구애받지 않고 고품질의 위키를 생성하기 위해 **청크 단위 작업(Chunked Generation)**을 수행합니다.

### 1. AI 에이전트 자동 워크플로우 (권장)
가장 쉽고 권장하는 방식입니다. portki가 분석 파이프라인을 구축하면, 에이전트가 이를 따라 문서를 완성합니다.

1. `portki owner/repo` 실행하여 저장소 스냅샷 수집 및 `handoff.md` 생성.
2. AI 에이전트가 `handoff.md` 지침에 따라 섹션별 계획 수립 및 검증(`validate-plan`).
3. 섹션 단위로 문서를 작성하고 로컬 세션에 반영(`persist-section`).
4. 모든 섹션 작성이 끝나면 최종 Markdown 파일로 조립(`finalize`).

### 2. 증분 업데이트 (Incremental Update)
기존에 생성된 위키가 있다면, 변경된 코드만 추적하여 효율적으로 문서를 갱신할 수 있습니다.

1. **변경 사항 감지**: `portki detect --repo owner/repo`
   - 변경이 없으면 건너뜀 (`noop`)
   - 일부 변경 시 연관된 섹션만 업데이트 (`incremental`)
   - 대규모 구조 변경 시 전체 재작성 (`full-rebuild`)
2. 변경된 스냅샷 수집 후 필요한 섹션만 재생성 및 병합 진행.

---

## 📂 출력 디렉토리 구조 (Output Directory)

모든 작업 내역과 최종 결과물은 프로젝트 루트를 오염시키지 않도록 `portki-output/` 폴더에 안전하게 저장됩니다. (기본적으로 `.gitignore`에 포함됩니다.)

```text
portki-output/
  ├── workspace/              # AI 에이전트용 중간 작업 파일 (*.json)
  ├── snapshots/owner/repo/   # 원본 코드 스냅샷 (직접 수정 금지)
  ├── chunked/owner/repo/     # 섹션별 작업 내역 및 세션 상태
  ├── freshness/state.json    # 증분 업데이트를 위한 베이스라인 상태값
  └── wiki/owner/repo/        # ✨ 완성된 최종 Markdown 위키
```

---

## 💻 권장 실행 환경
안정적인 위키 생성을 위해 높은 수준의 추론 능력을 가진 모델 사용을 권장합니다. *(2026년 3월 7일 기준)*

| 환경 | 권장 모델 | 추론(Thinking) 레벨 | 설정 파일 |
|---|---|---|---|
| **Claude Code** | `Opus 4.6` | High | [`CLAUDE.md`](./CLAUDE.md) |
| **Codex** | `GPT-5.4` | xHigh | [`AGENTS.md`](./AGENTS.md) |
| **Gemini CLI** | `gemini 3.1-pro-preview` | High | [`AGENTS.md`](./AGENTS.md) |