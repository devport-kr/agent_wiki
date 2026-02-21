import { describe, expect, it } from "vitest";

import { DeliveryWikiArtifactSchema } from "../src/contracts/wiki-delivery";
import { packageAcceptedOutputsForDelivery } from "../src/orchestration/package-delivery";
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
    {
      claimId: "claim-2",
      sectionId: "sec-2",
      subsectionId: "sub-2-1",
      statementKo: "프로세서 계층은 캐시와 재시도 정책을 조합해 외부 의존성 지연에도 안정적으로 응답합니다.",
      citationIds: ["cit-2"],
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
    {
      citationId: "cit-2",
      evidenceId: "ev-2",
      repoPath: "src/runtime/processor.ts",
      lineRange: { start: 10, end: 35 },
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
  ],
  groundingReport: {
    artifactType: "grounding-report",
    gateId: "GND-01",
    checkedAt: "2026-02-17T17:00:10.000Z",
    passed: true,
    totalClaims: 2,
    claimsWithCitations: 2,
    citationCoverage: 1,
    issues: [],
  },
} as const;

describe("wiki delivery provenance", () => {
  it("counters are derived from adapted sections", () => {
    const delivery = adaptWikiDraftToDelivery(BASE_DRAFT, {
      ingestRunId: "ingest-1",
      generationRunId: "generation-1",
      modelId: "gpt-5.3-codex",
      generatedAt: "2026-02-17T17:10:00.000Z",
    });

    const sectionCount = delivery.sections.length;
    const subsectionCount = delivery.sections.reduce((count, section) => count + section.subsectionIds.length, 0);

    expect(delivery.metadata.sectionCount).toBe(sectionCount);
    expect(delivery.metadata.subsectionCount).toBe(subsectionCount);
    expect(delivery.metadata.provenance.counters.sectionCount).toBe(sectionCount);
    expect(delivery.metadata.provenance.counters.subsectionCount).toBe(subsectionCount);
    expect(delivery.metadata.provenance.counters.claimCount).toBe(BASE_DRAFT.claims.length);
    expect(delivery.metadata.provenance.counters.citationCount).toBe(BASE_DRAFT.citations.length);
    expect(delivery.metadata.provenance.commitSha).toBe(delivery.project.commitSha);
  });

  it("is deterministic for identical accepted draft and options", () => {
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

    const options = {
      ingestRunId: "ingest-2",
      generationRunId: "generation-2",
      modelId: "gpt-5.3-codex",
      generatedAt: "2026-02-17T17:11:00.000Z",
    };

    const first = adaptWikiDraftToDelivery(shuffled, options);
    const second = adaptWikiDraftToDelivery(shuffled, options);

    expect(first).toEqual(second);
  });

  it("rejects artifacts missing required provenance metadata", () => {
    const delivery = adaptWikiDraftToDelivery(BASE_DRAFT, {
      ingestRunId: "ingest-3",
      generationRunId: "generation-3",
      modelId: "gpt-5.3-codex",
      generatedAt: "2026-02-17T17:12:00.000Z",
    });

    const missingModel = JSON.parse(JSON.stringify(delivery));
    delete missingModel.metadata.provenance.run.modelId;

    expect(DeliveryWikiArtifactSchema.safeParse(missingModel).success).toBe(false);
  });

  it("attaches deterministic quality scorecard metadata to packaged artifact", () => {
    const sections = Array.from({ length: 6 }).map((_, sectionIndex) => ({
      sectionId: `sec-${sectionIndex + 1}`,
      titleKo: `섹션 ${sectionIndex + 1}`,
      summaryKo: `섹션 ${sectionIndex + 1}은 캐시 계층(Cache Layer)과 복구 흐름을 설명합니다.`,
      subsections: Array.from({ length: 3 }).map((__, subsectionIndex) => ({
        sectionId: `sec-${sectionIndex + 1}`,
        subsectionId: `sub-${sectionIndex + 1}-${subsectionIndex + 1}`,
        titleKo: `하위 섹션 ${sectionIndex + 1}-${subsectionIndex + 1}`,
        bodyKo:
          `src/runtime/pipeline.ts 경로를 기준으로 요청 처리와 예외 복구 단계를 설명합니다. ` +
          `(근거: sec-${sectionIndex + 1}, sub-${subsectionIndex + 1})`,
      })),
    }));

    const claims = Array.from({ length: 18 }).map((_, index) => ({
      claimId: `claim-${index + 1}`,
      sectionId: `sec-${Math.floor(index / 3) + 1}`,
      subsectionId: `sub-${Math.floor(index / 3) + 1}-${(index % 3) + 1}`,
      statementKo: `이 구간은 큐 처리와 복구 정책이 결합되어 오류 전파를 제한한다는 점을 설명합니다 (${index + 1}).`,
      citationIds: [`cit-${index + 1}`],
    }));

    const citations = Array.from({ length: 18 }).map((_, index) => ({
      citationId: `cit-${index + 1}`,
      evidenceId: `ev-${index + 1}`,
      repoPath: "src/runtime/pipeline.ts",
      lineRange: { start: index + 1, end: index + 20 },
      commitSha: BASE_DRAFT.commitSha,
      permalink: `https://github.com/acme/widget/blob/${BASE_DRAFT.commitSha}/src/runtime/pipeline.ts#L${index + 1}-L${index + 20}`,
      rationale: "pipeline retry queue flow",
    }));

    const accepted = {
      ingest_run_id: "ingest-quality-1",
      repo_ref: "acme/widget",
      commit_sha: BASE_DRAFT.commitSha,
      section_count: 6,
      subsection_count: 18,
      total_korean_chars:
        BASE_DRAFT.overviewKo.length +
        sections.reduce(
          (sum, section) =>
            sum + section.summaryKo.length + section.subsections.reduce((subSum, subsection) => subSum + subsection.bodyKo.length, 0),
          0,
        ),
      claim_count: claims.length,
      citation_count: citations.length,
      draft: {
        ...BASE_DRAFT,
        sections,
        claims,
        citations,
        groundingReport: {
          ...BASE_DRAFT.groundingReport,
          totalClaims: claims.length,
          claimsWithCitations: claims.length,
          citationCoverage: 1,
        },
      },
      grounding_report: {
        ...BASE_DRAFT.groundingReport,
        totalClaims: claims.length,
        claimsWithCitations: claims.length,
        citationCoverage: 1,
      },
    };

    const first = packageAcceptedOutputsForDelivery([accepted], {
      modelId: "gpt-5.3-codex",
      generatedAt: "2026-02-19T11:20:00.000Z",
    });
    const second = packageAcceptedOutputsForDelivery([accepted], {
      modelId: "gpt-5.3-codex",
      generatedAt: "2026-02-19T11:20:00.000Z",
    });

    expect(first).toEqual(second);
    expect(first.artifacts[0].metadata.qualityScorecard).toBeDefined();
    expect(first.artifacts[0].metadata.qualityScorecard.semanticFaithfulness).toBeGreaterThanOrEqual(0);
    expect(first.artifacts[0].metadata.qualityScorecard.semanticFaithfulness).toBeLessThanOrEqual(1);
  });
});
