import { describe, expect, it } from "vitest";

import {
  GroundingReportSchema,
  QualityScorecardSchema,
  SectionPlanSchema,
  WikiDraftArtifactSchema,
} from "../src/contracts/wiki-generation";

const BASE_PLAN = {
  artifactType: "section-plan",
  repoFullName: "acme/widget",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-02-17T08:00:00.000Z",
  overviewKo: "이 위키는 저장소의 아키텍처와 핵심 모듈 상호작용을 코드 경로 기반으로 설명합니다.",
  sections: Array.from({ length: 6 }).map((_, i) => ({
    sectionId: `sec-${i + 1}`,
    titleKo: `섹션 ${i + 1}`,
    summaryKo: `섹션 ${i + 1} 요약 설명입니다.`,
    subsections: Array.from({ length: 3 }).map((__, j) => ({
      sectionId: `sec-${i + 1}`,
      subsectionId: `sub-${i + 1}-${j + 1}`,
      titleKo: `하위 ${i + 1}-${j + 1}`,
      objectiveKo: "세부 구조와 코드 흐름을 단계적으로 설명합니다.",
      targetEvidenceKinds: ["code", "tests"],
      targetCharacterCount: 1200,
    })),
  })),
  crossReferences: [{ fromSectionId: "sec-1", toSectionId: "sec-2", relation: "호출 흐름" }],
} as const;

const BASE_GROUNDING_REPORT = {
  artifactType: "grounding-report",
  gateId: "GND-01",
  checkedAt: "2026-02-17T08:20:00.000Z",
  passed: true,
  totalClaims: 2,
  claimsWithCitations: 2,
  citationCoverage: 1,
  issues: [],
} as const;

const BASE_DRAFT = {
  artifactType: "wiki-draft",
  repoFullName: "acme/widget",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-02-17T08:30:00.000Z",
  overviewKo:
    "이 문서는 저장소의 아키텍처, 주요 모듈 경계, 실행 흐름을 코드 근거와 함께 서술하는 한국어 기술 위키 초안입니다.",
  sections: BASE_PLAN.sections.map((section) => ({
    sectionId: section.sectionId,
    titleKo: section.titleKo,
    summaryKo: "요약은 섹션의 책임과 하위 구성 요소를 설명합니다.",
    subsections: section.subsections.map((subsection) => ({
      sectionId: subsection.sectionId,
      subsectionId: subsection.subsectionId,
      titleKo: subsection.titleKo,
      bodyKo: "이 하위 섹션은 코드 경로, 함수 호출 순서, 예외 처리 방식까지 상세히 설명합니다. 충분한 길이를 보장하기 위해 내용이 반복 없이 확장됩니다.",
    })),
  })),
  sourceDocs: [{ sourceId: "src-1", path: "README.md" }],
  claims: [
    {
      claimId: "claim-1",
      sectionId: "sec-1",
      subsectionId: "sub-1-1",
      statementKo: "엔트리포인트는 파이프라인 실행 전에 입력 형식을 정규화하고 단계 실행 메타데이터를 생성합니다.",
      citationIds: ["cit-1"],
    },
    {
      claimId: "claim-2",
      sectionId: "sec-2",
      subsectionId: "sub-2-1",
      statementKo: "스냅샷 레이어는 동일 커밋에서 동일한 결과를 보장하기 위해 매니페스트 서명을 기반으로 캐시를 재사용합니다.",
      citationIds: ["cit-2"],
    },
  ],
  citations: [
    {
      citationId: "cit-1",
      evidenceId: "ev-1",
      repoPath: "src/ingestion/run.ts",
      lineRange: { start: 10, end: 30 },
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      permalink: "https://github.com/acme/widget/blob/0123456789abcdef0123456789abcdef01234567/src/ingestion/run.ts#L10-L30",
    },
    {
      citationId: "cit-2",
      evidenceId: "ev-2",
      repoPath: "src/ingestion/snapshot.ts",
      lineRange: { start: 40, end: 60 },
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      permalink:
        "https://github.com/acme/widget/blob/0123456789abcdef0123456789abcdef01234567/src/ingestion/snapshot.ts#L40-L60",
    },
  ],
  groundingReport: BASE_GROUNDING_REPORT,
} as const;

describe("Phase 3 contract schemas", () => {
  it("accepts valid GEN-01 and GEN-02 section plan payloads", () => {
    const parsed = SectionPlanSchema.safeParse(BASE_PLAN);
    expect(parsed.success).toBe(true);
  });

  it("rejects section plan with fewer than 6 major sections", () => {
    const invalid = {
      ...BASE_PLAN,
      sections: BASE_PLAN.sections.slice(0, 5),
    };

    expect(SectionPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects section plan with section containing fewer than 3 subsections", () => {
    const invalid = {
      ...BASE_PLAN,
      sections: BASE_PLAN.sections.map((section, index) => {
        if (index !== 0) {
          return section;
        }

        return {
          ...section,
          subsections: section.subsections.slice(0, 2),
        };
      }),
    };

    expect(SectionPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts valid GND-01 draft with claim-to-citation traceability", () => {
    const parsed = WikiDraftArtifactSchema.safeParse(BASE_DRAFT);
    expect(parsed.success).toBe(true);
  });

  it("accepts citationless draft contract for beginner trend wiki", () => {
    const parsed = WikiDraftArtifactSchema.safeParse({
      artifactType: "wiki-draft",
      repoFullName: "acme/widget",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      generatedAt: "2026-02-22T09:00:00.000Z",
      overviewKo:
        "입문자 중심 개요 설명입니다. 핵심 구조와 최근 변경 맥락을 먼저 설명하고, 주요 모듈의 역할과 진입 순서를 이해하기 쉽게 안내합니다.",
      sections: BASE_DRAFT.sections,
      sourceDocs: [{ sourceId: "src-1", path: "README.md" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects claim that points to missing citation id", () => {
    const invalid = {
      ...BASE_DRAFT,
      claims: [
        {
          ...BASE_DRAFT.claims[0],
          citationIds: ["missing-citation"],
        },
      ],
    };

    expect(WikiDraftArtifactSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects citation with invalid file path or line range", () => {
    const invalidPath = {
      ...BASE_DRAFT,
      citations: [
        {
          ...BASE_DRAFT.citations[0],
          repoPath: "../secret.ts",
        },
      ],
    };
    expect(WikiDraftArtifactSchema.safeParse(invalidPath).success).toBe(false);

    const invalidLines = {
      ...BASE_DRAFT,
      citations: [
        {
          ...BASE_DRAFT.citations[0],
          lineRange: { start: 30, end: 10 },
        },
      ],
    };
    expect(WikiDraftArtifactSchema.safeParse(invalidLines).success).toBe(false);
  });

  it("rejects grounding report coverage mismatch", () => {
    const invalid = {
      ...BASE_GROUNDING_REPORT,
      totalClaims: 2,
      claimsWithCitations: 1,
      citationCoverage: 1,
    };

    expect(GroundingReportSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts grounding report gateId GND-04", () => {
    const report = {
      ...BASE_GROUNDING_REPORT,
      gateId: "GND-04" as const,
    };

    expect(GroundingReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts deterministic quality scorecard values", () => {
    const scorecard = {
      semanticFaithfulness: 0.9,
      conceptualDepth: 0.8,
      operationalClarity: 0.85,
      citationQuality: 0.95,
      novelty: 0.88,
    };

    expect(QualityScorecardSchema.safeParse(scorecard).success).toBe(true);
  });
});
