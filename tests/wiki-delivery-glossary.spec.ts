import { describe, expect, it } from "vitest";

import {
  buildGlossaryFromDraft,
  normalizeGlossaryEntries,
} from "../src/packaging/glossary";

const BASE_DRAFT = {
  artifactType: "wiki-draft",
  repoFullName: "acme/widget",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-02-17T17:00:00.000Z",
  overviewKo:
    "비동기 큐(Async Queue)는 작업 순서를 안정적으로 보장하며 재시도 정책과 함께 파이프라인의 장애 복원력을 높입니다.",
  sections: Array.from({ length: 6 }).map((_, sectionIndex) => ({
    sectionId: `sec-${sectionIndex + 1}`,
    titleKo: `섹션 ${sectionIndex + 1}`,
    summaryKo:
      sectionIndex === 0
        ? "캐시 계층(Cache Layer)은 읽기 부하를 줄이고 데이터 접근 지연을 완화하는 핵심 경계입니다."
        : `섹션 ${sectionIndex + 1}은 저장소 구조를 설명하는 기본 요약입니다.`,
    subsections: Array.from({ length: 3 }).map((__, subsectionIndex) => ({
      sectionId: `sec-${sectionIndex + 1}`,
      subsectionId: `sub-${sectionIndex + 1}-${subsectionIndex + 1}`,
      titleKo: `하위 섹션 ${sectionIndex + 1}-${subsectionIndex + 1}`,
      bodyKo:
        sectionIndex === 0 && subsectionIndex === 0
          ? "이 구간은 비동기 큐 (async queue)와 캐시 계층 (cache layer)을 함께 사용해 요청 급증 구간에서도 안정적인 처리량을 유지합니다."
          : "이 하위 섹션은 코드 책임 경계와 데이터 흐름을 충분한 길이로 설명해 계약 테스트의 최소 길이 요구를 만족합니다.",
    })),
  })),
  claims: [
    {
      claimId: "claim-1",
      sectionId: "sec-1",
      subsectionId: "sub-1-1",
      statementKo:
        "캐시 계층(cache layer)은 읽기 집중 트래픽에서 백엔드 호출량을 줄여 지연 시간을 안정적으로 낮춥니다.",
      citationIds: ["cit-1"],
    },
  ],
  citations: [
    {
      citationId: "cit-1",
      evidenceId: "ev-1",
      repoPath: "src/runtime/pipeline.ts",
      lineRange: { start: 1, end: 20 },
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      rationale:
        "작업 실행기(task executor)는 큐 소비 속도를 제어하고 실패 재시도 상태를 추적합니다.",
    },
  ],
  groundingReport: {
    artifactType: "grounding-report",
    gateId: "GND-01",
    checkedAt: "2026-02-17T17:00:10.000Z",
    passed: true,
    totalClaims: 1,
    claimsWithCitations: 1,
    citationCoverage: 1,
    issues: [],
  },
} as const;

describe("wiki delivery glossary", () => {
  it("rejects malformed entries missing required mapping fields", () => {
    const normalized = normalizeGlossaryEntries([
      { termKo: "", termEn: "Cache Layer", definition: "캐시 설명" },
      { termKo: "캐시 계층", termEn: "", definition: "캐시 설명" },
      { termKo: "캐시 계층", termEn: "Cache Layer", definition: "" },
      {
        termKo: "캐시 계층",
        termEn: "Cache Layer",
        definition: "캐시 계층은 데이터 재사용으로 지연 시간을 낮추는 저장 계층입니다.",
      },
    ]);

    expect(normalized).toEqual([
      {
        termKo: "캐시 계층",
        termEn: "Cache Layer",
        definition: "캐시 계층은 데이터 재사용으로 지연 시간을 낮추는 저장 계층입니다.",
      },
    ]);
  });

  it("deduplicates synonymous duplicates by canonical keys", () => {
    const normalized = normalizeGlossaryEntries([
      {
        termKo: "비동기 큐",
        termEn: "Async Queue",
        definition: "비동기 큐는 작업 실행 순서를 제어하고 버스트 트래픽을 완화합니다.",
      },
      {
        termKo: "비동기   큐",
        termEn: "async queue",
        definition: "비동기 큐는 재시도 대기열을 통해 장애 전파를 줄입니다.",
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].termKo).toBe("비동기 큐");
    expect(normalized[0].termEn).toBe("Async Queue");
  });

  it("deterministic glossary extraction keeps stable sorted output", () => {
    const first = buildGlossaryFromDraft(BASE_DRAFT);
    const second = buildGlossaryFromDraft(BASE_DRAFT);

    expect(first).toEqual(second);
    expect(first.map((entry) => entry.termEn)).toEqual(["Async Queue", "Cache Layer", "task executor"]);
    expect(first.every((entry) => entry.definition.length > 0)).toBe(true);
  });
});
