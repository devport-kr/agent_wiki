import { describe, expect, it } from "vitest";

import { DeliveryWikiArtifactSchema } from "../src/contracts/wiki-delivery";
import { adaptWikiDraftToDelivery } from "../src/packaging/adapter";

const BASE_DRAFT = {
  artifactType: "wiki-draft",
  repoFullName: "acme/widget",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-02-17T17:00:00.000Z",
  overviewKo:
    "이 위키 초안은 저장소의 아키텍처, 실행 경로, 모듈 책임 경계를 코드 근거 기반으로 상세히 설명하기 위한 한국어 결과물입니다.",
  sections: Array.from({ length: 6 }).map((_, sectionIndex) => ({
    sectionId: `sec-${sectionIndex + 1}`,
    titleKo: `섹션 ${sectionIndex + 1}`,
    summaryKo: `섹션 ${sectionIndex + 1}은 핵심 책임과 호출 흐름을 한국어로 요약합니다.`,
    subsections: Array.from({ length: 3 }).map((__, subsectionIndex) => ({
      sectionId: `sec-${sectionIndex + 1}`,
      subsectionId: `sub-${sectionIndex + 1}-${subsectionIndex + 1}`,
      titleKo: `하위 섹션 ${sectionIndex + 1}-${subsectionIndex + 1}`,
      bodyKo:
        "이 하위 섹션은 코드 경로, 데이터 흐름, 예외 처리 패턴을 근거와 함께 설명하며 길이 요구사항을 충족하도록 충분한 문장을 포함합니다.",
    })),
  })),
  claims: [
    {
      claimId: "claim-1",
      sectionId: "sec-1",
      subsectionId: "sub-1-1",
      statementKo: "파이프라인 엔트리포인트는 실행 전 입력을 정규화하고 단계 추적 메타데이터를 구성합니다.",
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

describe("wiki delivery contract", () => {
  it("contract rejects missing required section fields", () => {
    const invalid = {
      project: {
        repoFullName: "acme/widget",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      sections: [
        {
          sectionId: "sec-1",
          deepDiveMarkdown: "본문",
          order: 0,
          subsectionIds: ["sub-1-1"],
        },
      ],
      metadata: {
        artifactType: "wiki-delivery",
        sourceArtifactType: "wiki-draft",
        contractVersion: "out-01.v1",
        generatedAt: "2026-02-17T17:00:00.000Z",
        sectionCount: 1,
        subsectionCount: 1,
        deterministicOrdering: {
          sections: "sectionId:asc",
          subsections: "subsectionId:asc",
        },
        provenance: {
          generatedAt: "2026-02-17T17:00:00.000Z",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          counters: {
            sectionCount: 1,
            subsectionCount: 1,
            claimCount: 0,
            citationCount: 0,
          },
          run: {
            generationRunId: "run-1",
            modelId: "gpt-5.3-codex",
          },
        },
      },
    };

    expect(DeliveryWikiArtifactSchema.safeParse(invalid).success).toBe(false);
  });

  it("contract normalizes heading and anchor defaults", () => {
    const payload = {
      project: {
        repoFullName: "acme/widget",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      sections: [
        {
          sectionId: "Sec 1",
          summary: "요약",
          deepDiveMarkdown: "본문",
          order: 0,
          subsectionIds: ["sub-1-1"],
        },
      ],
      metadata: {
        artifactType: "wiki-delivery",
        sourceArtifactType: "wiki-draft",
        contractVersion: "out-01.v1",
        generatedAt: "2026-02-17T17:00:00.000Z",
        sectionCount: 1,
        subsectionCount: 1,
        deterministicOrdering: {
          sections: "sectionId:asc",
          subsections: "subsectionId:asc",
        },
        provenance: {
          generatedAt: "2026-02-17T17:00:00.000Z",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          counters: {
            sectionCount: 1,
            subsectionCount: 1,
            claimCount: 0,
            citationCount: 0,
          },
          run: {
            generationRunId: "run-1",
            modelId: "gpt-5.3-codex",
          },
        },
      },
    };

    const parsed = DeliveryWikiArtifactSchema.parse(payload);
    expect(parsed.sections[0].heading).toBe("Sec 1");
    expect(parsed.sections[0].anchor).toBe("sec-1");
  });
});

describe("wiki delivery adapter", () => {
  it("maps draft sections to required delivery keys", () => {
    const delivery = adaptWikiDraftToDelivery(BASE_DRAFT, {
      ingestRunId: "run-1",
      generatedAt: "2026-02-17T17:05:00.000Z",
    });

    const parsed = DeliveryWikiArtifactSchema.safeParse(delivery);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.sections[0]).toMatchObject({
      sectionId: "sec-1",
      summary: expect.any(String),
      deepDiveMarkdown: expect.stringContaining("## 하위 섹션 1-1"),
    });
    expect(parsed.data.metadata.sectionCount).toBe(6);
    expect(parsed.data.metadata.subsectionCount).toBe(18);
  });

  it("preserves deterministic section ordering for identical drafts", () => {
    const shuffled = {
      ...BASE_DRAFT,
      sections: BASE_DRAFT.sections
        .slice()
        .reverse()
        .map((section) => ({
          ...section,
          subsections: section.subsections.slice().reverse(),
        })),
    };

    const first = adaptWikiDraftToDelivery(shuffled, {
      ingestRunId: "run-2",
      generatedAt: "2026-02-17T17:05:01.000Z",
    });
    const second = adaptWikiDraftToDelivery(shuffled, {
      ingestRunId: "run-2",
      generatedAt: "2026-02-17T17:05:01.000Z",
    });

    expect(first.sections.map((section) => section.sectionId)).toEqual([
      "sec-1",
      "sec-2",
      "sec-3",
      "sec-4",
      "sec-5",
      "sec-6",
    ]);
    expect(first).toEqual(second);
  });
});
