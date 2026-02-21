# devport-agent

![Node](https://img.shields.io/badge/node-%3E%3D20.0-6DA55F?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Build](https://img.shields.io/badge/CI-not%20configured-lightgrey)
![License](https://img.shields.io/badge/License-Not%20Provided-lightgrey)

`devport-agent`는 GitHub 저장소를 대상으로 **한국어 입문자/트렌드 중심 위키 문서**를 생성하는 CLI 도구입니다. 저장소를 스냅샷하고, 변경사항을 감지하며, 문서 섹션을 계획하고, 생성된 섹션을 검증한 뒤 엄격한 품질 검사를 거쳐 `delivery.json` 결과물을 패키징합니다.

## 목차

- [프로젝트 개요](#프로젝트-개요)
- [왜 유용한가](#왜-유용한가)
- [프로젝트 구조 한눈에 보기](#프로젝트-구조-한눈에-보기)
- [시작하기](#시작하기)
  - [1) 설치](#1-설치)
  - [2) 설정](#2-설정)
  - [3) 빠른 실행](#3-빠른-실행)
  - [4) 기본 워크플로우](#4-기본-워크플로우)
- [사용 예시](#사용-예시)
  - [권장: 청크 단위 생성](#권장-청크-단위-생성)
  - [모놀리식(단일 문서) 생성](#모놀리식단일-문서-생성)
  - [증분 업데이트](#증분-업데이트)
- [도움말 및 지원](#도움말-및-지원)
- [유지보수자 및 기여자](#유지보수자-및-기여자)

## 프로젝트 개요

`devport-agent`는 저장소에서 위키를 생성하는 전체 파이프라인을 자동화합니다.

- 저장소 스냅샷을 다운로드/조회하고,
- 프로젝트 구조를 분석해 문서 섹션 계획을 수립하고,
- 코드 근거를 포함한 섹션 출력을 받아 검증/영속화하며,
- 마지막으로 외부 전달형태(`delivery.json`)를 생성합니다.

오케스트레이션은 `src/agent.ts`에 집중되어 있으며, 동작은 소스 코드로 명시적으로 정의된 계약과 검증 규칙을 따릅니다.

## 왜 유용한가

- **안정적인 증분 업데이트**: `detect`가 마지막 배포 커밋 이후 변경된 범위를 추적해, 필요한 섹션만 다시 생성할 수 있습니다.
- **출처 경로 기반 추적성**: 각 섹션은 `sourcePaths`와 `__devport__/trends/*`, `__devport__/official-docs/*` 아티팩트로 근거 경로를 유지합니다.
- **엄격한 품질 게이트**: 패키징 단계에서 계약 검증을 통과해야 하므로 배포 실패 가능성을 줄입니다.
- **대규모 저장소 대응**: 청크 단위로 처리하여 필요한 부분만 순차적으로 다룰 수 있습니다.
- **운영 안전성**: `devport-output/` 하위의 스냅샷/배포/상태 파일이 경로 규칙에 따라 분리됩니다.
- **단일 진입점 CLI**: 한 개의 스크립트(`src/agent.ts`)에서 명령을 일관되게 실행할 수 있습니다.

## 프로젝트 구조 한눈에 보기

- `src/agent.ts`  
  CLI 진입점 및 명령 라우팅.
- `src/ingestion/*`  
  저장소 스냅샷 수집 및 메타데이터 추출.
- `src/chunked/*`  
  섹션 계획 수립, 섹션 단위 영속화, 최종 상호검증.
- `src/packaging/*`  
  출력 형식 검증 및 패키징.
- `src/freshness/*`  
  기준점(baseline) 관리 및 변경 감지.
- `src/contracts/*`  
  정형화된 출력 계약 타입 정의.
- `src/persistence/*`  
  청크 방식에서 DB 영속화 기능을 담당.
- `src/quality/*`  
  점수화/품질 점검 유틸리티.
- `docs/`  
  에이전트 운영 가이드 및 추가 문서.

## 시작하기

### 1) 설치

저장소 루트에서 실행합니다.

```bash
npm install
```

### 2) 설정

예시 환경변수 파일을 복사한 뒤 필요 항목을 수정합니다.

```bash
cp .env.example .env
```

공개 저장소의 기본 흐름은 기본값만으로 동작하는 경우가 많습니다. 다음은 추천 구성 항목입니다.

- `GITHUB_TOKEN`
- 스냅샷 백엔드/저장 경로 관련 (`DEVPORT_SNAPSHOT_BACKEND`, `DEVPORT_S3_BUCKET`, `DEVPORT_S3_REGION`, `DEVPORT_S3_PREFIX`)
- 품질/실행 기본값 (`DEVPORT_QUALITY_GATE_LEVEL`, `DEVPORT_PLANNER_VERSION`)
- 트렌드/공식문서 수집 기본값 (`DEVPORT_TREND_WINDOW_DAYS=180`, `DEVPORT_OFFICIAL_DOC_DISCOVERY=auto`)
- `persist-section`, `finalize` 사용 시 OpenAI/DB 환경변수

### 3) 빠른 실행

CLI는 루트에서 다음처럼 사용합니다.

```bash
npx tsx src/agent.ts <command> [flags]
```

주요 명령:

- `ingest`
- `plan-sections`
- `detect`
- `persist-section`
- `finalize`
- `package`

각 명령의 옵션을 확인하려면:

```bash
npx tsx src/agent.ts ingest --help
```

### 4) 기본 워크플로우

기본 출력 경로는 다음과 같습니다.

- 스냅샷: `devport-output/snapshots/{owner}/{repo}/...`
- 전달 산출물: `devport-output/delivery/{owner}/{repo}/delivery.json`
- 증분 상태: `devport-output/freshness/state.json`

## 사용 예시

### 권장: 청크 단위 생성

중간~대형 저장소에서 권장되는 방식입니다.

```bash
# 1) 저장소 스냅샷 생성
npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json

# 2) 섹션 계획 생성
npx tsx src/agent.ts plan-sections --artifact artifact.json --out section-plan.json

# 3) 각 섹션 출력을 작성한 뒤 영속화
npx tsx src/agent.ts persist-section --plan section-plan.json --section sec-1 --input section-1-output.json
npx tsx src/agent.ts persist-section --plan section-plan.json --section sec-2 --input section-2-output.json

# 4) 전역 검증 및 기준점 갱신
npx tsx src/agent.ts finalize --plan section-plan.json --advance_baseline
```

### 모놀리식(단일 문서) 생성

작은 저장소에서 적은 오버헤드로 빠르게 수행할 때 사용합니다.

```bash
npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json
# accepted-output.json 생성
npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
```

### 증분 업데이트

저장소 변경 시 전체 재생성 대신 변경분만 반영할 수 있습니다.

```bash
# 변경 감지
npx tsx src/agent.ts detect --repo owner/repo

# 영향받은 범위에 따라 전체/일부 섹션 재생성
npx tsx src/agent.ts ingest --repo owner/repo --out artifact.json
# ...필요 섹션만 갱신...
npx tsx src/agent.ts package --input accepted-output.json --advance_baseline
```

`detect` 결과는 `noop`, `incremental`, `full-rebuild` 중 하나입니다.  
`incremental`일 경우 `impacted_section_ids`에 해당하는 섹션만 갱신하면 됩니다.

## 도움말 및 지원

- 오케스트레이션/명령 동작: [`src/agent.ts`](./src/agent.ts)
- 내부 워크플로우 규칙: [`GUIDELINE.md`](./GUIDELINE.md)
- 청크 기반 문서화 가이드: [`docs/2026-02-18-chunked-wiki-generation.md`](./docs/2026-02-18-chunked-wiki-generation.md)
- 계약 타입:
  - [`src/contracts/grounded-output.ts`](./src/contracts/grounded-output.ts)
  - [`src/contracts/wiki-generation.ts`](./src/contracts/wiki-generation.ts)
  - [`src/contracts/chunked-generation.ts`](./src/contracts/chunked-generation.ts)
- 섹션 플로우:
  - [`src/chunked/plan-sections.ts`](./src/chunked/plan-sections.ts)
  - [`src/chunked/persist-section.ts`](./src/chunked/persist-section.ts)
  - [`src/chunked/finalize.ts`](./src/chunked/finalize.ts)
- 변경 감지/상태 관리:
  - [`src/freshness/detect.ts`](./src/freshness/detect.ts)
  - [`src/freshness/state.ts`](./src/freshness/state.ts)

오류가 발생하면, 해당 명령의 `--help`와 관련 입력 JSON을 확인해 필수 값 및 제약 조건을 점검하세요.

## 유지보수자 및 기여자

이 저장소에는 현재 루트에 별도 `CONTRIBUTING.md`와 `LICENSE`가 존재하지 않습니다. 현재 기준으로는 다음을 참고하세요.

- `git shortlog -sne`로 기여자 목록을 확인하세요.
- 구현 변경 시 `npx tsx src/agent.ts <command> --help`로 입력/제약을 먼저 확인하세요.
- 생성 섹션은 근거 있는 코드 중심으로 작성하고, 중복 문장이나 과도한 중복 표현을 피하세요.
- 어떤 동작 변경이 있어도 PR에는 다음 항목을 함께 정리하세요.
  - 재현 가능한 명령 실행 순서
  - 문서/지원 링크 업데이트
  - 변경 근거 및 영향 범위

운영 정책이 추가되면 이 섹션에 링크를 함께 정리해 주세요.

## 환경 변수 빠른 참고표

CLI에서 주요하게 사용하는 변수는 다음과 같습니다.

- `DEVPORT_SNAPSHOT_BACKEND` (`local|s3|hybrid`)
- `DEVPORT_PLANNER_VERSION` (`v1|v2`)
- `DEVPORT_QUALITY_GATE_LEVEL` (`standard|strict`)
- `DEVPORT_S3_BUCKET`
- `DEVPORT_S3_REGION`
- `DEVPORT_S3_PREFIX`
- `DEVPORT_DB_HOST`, `DEVPORT_DB_PORT`, `DEVPORT_DB_NAME`, `DEVPORT_DB_USER`, `DEVPORT_DB_PASSWORD`, `DEVPORT_DB_SSL`
- `OPENAI_API_KEY`

전체 항목은 [.env.example](./.env.example)에서 확인하세요.
