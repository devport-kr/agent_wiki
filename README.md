# devport-agent

GitHub 저장소를 대상으로 한국어 위키 문서를 생성하는 CLI 파이프라인입니다.

## 설치

```bash
npm install
cp .env.example .env
```

## 환경 변수

| 변수 | 설명 |
|------|------|
| `GITHUB_TOKEN` | 비공개 저장소 접근 시 필요 |
| `OPENAI_API_KEY` | `persist-section`, `finalize` 실행 시 필요 |
| `DEVPORT_SNAPSHOT_BACKEND` | `local`(기본값) \| `hybrid` \| `s3` |
| `DEVPORT_S3_BUCKET` / `DEVPORT_S3_REGION` | S3 모드 사용 시 필요 |
| `DEVPORT_DB_*` | PostgreSQL 연결 정보 (`persist-section`, `finalize` 필요) |

전체 항목은 `.env.example`을 참고하십시오.

## 명령

모든 명령은 프로젝트 루트에서 실행합니다.

```bash
npx tsx src/agent.ts <command> [flags]
```

| 명령 | 설명 |
|------|------|
| `ingest` | 저장소 스냅샷 수집 |
| `detect` | 마지막 배포 이후 변경사항 감지 |
| `plan-sections` | 저장소 구조 분석 및 섹션 계획 수립 |
| `persist-section` | 섹션 출력 검증 및 DB 영속화 |
| `finalize` | 전체 섹션 교차 검증 및 기준점 갱신 |
| `package` | 출력물 검증 및 `delivery.json` 패키징 |

## 워크플로우

### 청크 단위 생성 (권장)

```bash
npx tsx src/agent.ts ingest --repo owner/repo --out devport-output/workspace/{slug}-artifact.json
npx tsx src/agent.ts plan-sections --artifact devport-output/workspace/{slug}-artifact.json --out devport-output/workspace/{slug}-section-plan.json

# 각 섹션별 반복
npx tsx src/agent.ts persist-section --plan devport-output/workspace/{slug}-section-plan.json --section sec-1 --input devport-output/workspace/{slug}-section-1-output.json

npx tsx src/agent.ts finalize --plan devport-output/workspace/{slug}-section-plan.json --advance_baseline
```

### 증분 업데이트

```bash
npx tsx src/agent.ts detect --repo owner/repo
# noop → 중단 / incremental → 영향 섹션만 재생성 / full-rebuild → 전체 재생성
```

## 출력 경로

```
devport-output/
  snapshots/{owner}/{repo}/     # 저장소 스냅샷
  delivery/{owner}/{repo}/      # delivery.json
  freshness/state.json          # 증분 기준점
  chunked/{owner}/{repo}/       # 섹션 세션 상태
```

`devport-output/`은 `.gitignore`에 포함되어 있습니다.
