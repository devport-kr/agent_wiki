import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateSection } from "../src/chunked/validate-section";
import { SectionOutputSchema } from "../src/contracts/chunked-generation";
import { packageAcceptedOutputsForDelivery } from "../src/orchestration/package-delivery";
import { validateDeliveryEnvelope } from "../src/packaging/validate";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function createAcceptedOutput(options: { withGlossaryTerms?: boolean; ingestRunId?: string } = {}) {
  const withGlossaryTerms = options.withGlossaryTerms ?? true;
  const ingestRunId = options.ingestRunId ?? "run-1";

  const summaryKo = withGlossaryTerms
    ? "캐시 계층(Cache Layer)은 읽기 성능을 안정화하고 장애 구간에서 응답 지연을 줄입니다."
    : "이 섹션은 핵심 실행 흐름을 설명하고 장애 대응 구조를 상세하게 다룹니다.";

  const bodyKo = withGlossaryTerms
    ? "비동기 큐(Async Queue)와 캐시 계층(Cache Layer)을 결합해 처리량을 유지하고 실패 전파를 제한합니다."
    : "이 하위 섹션은 요청 처리 순서와 상태 전이를 충분한 길이로 설명합니다.";

  const draft = {
    artifactType: "wiki-draft",
    repoFullName: "acme/widget",
    commitSha: COMMIT_SHA,
    generatedAt: "2026-02-18T09:00:00.000Z",
    overviewKo:
      "이 위키 초안은 저장소 구조와 실행 경계를 코드 근거에 맞춰 설명하며 파이프라인의 책임 분리를 한국어로 상세히 정리합니다.",
    sections: Array.from({ length: 6 }).map((_, sectionIndex) => ({
      sectionId: `sec-${sectionIndex + 1}`,
      titleKo: `섹션 ${sectionIndex + 1}`,
      summaryKo,
      subsections: Array.from({ length: 3 }).map((__, subsectionIndex) => ({
        sectionId: `sec-${sectionIndex + 1}`,
        subsectionId: `sub-${sectionIndex + 1}-${subsectionIndex + 1}`,
        titleKo: `하위 섹션 ${sectionIndex + 1}-${subsectionIndex + 1}`,
        bodyKo: `${bodyKo} (근거: src/runtime/pipeline.ts, 구간: ${sectionIndex + 1}-${subsectionIndex + 1})`,
      })),
    })),
    claims: Array.from({ length: 6 * 3 }).map((_, index) => {
      const sectionId = `sec-${Math.floor(index / 3) + 1}`;
      const subsectionId = `sub-${Math.floor(index / 3) + 1}-${(index % 3) + 1}`;
      return {
        claimId: `claim-${index + 1}`,
        sectionId,
        subsectionId,
        statementKo: `이 하위 섹션은 실행 경계와 오류 전파 규칙을 코드 경로 기준으로 설명합니다 (참조: ${subsectionId}).`,
        citationIds: [`cit-${index + 1}`],
      };
    }),
    citations: Array.from({ length: 6 * 3 }).map((_, index) => ({
      citationId: `cit-${index + 1}`,
      evidenceId: `ev-${index + 1}`,
      repoPath: "src/runtime/pipeline.ts",
      lineRange: { start: index * 10 + 1, end: index * 10 + 20 },
      commitSha: COMMIT_SHA,
    })),
    groundingReport: {
      artifactType: "grounding-report",
      gateId: "GND-03",
      checkedAt: "2026-02-18T09:00:10.000Z",
      passed: true,
      totalClaims: 1,
      claimsWithCitations: 1,
      citationCoverage: 1,
      issues: [],
    },
  } as const;

  return {
    ingest_run_id: ingestRunId,
    repo_ref: "acme/widget",
    commit_sha: COMMIT_SHA,
    section_count: 6,
    subsection_count: 18,
    total_korean_chars: 52_000,
    claim_count: 18,
    citation_count: 18,
    draft,
    grounding_report: draft.groundingReport,
  };
}

describe("delivery packaging validation", () => {
  it("blocks invalid payloads with explicit OUT-04 reasons", () => {
    const packaged = packageAcceptedOutputsForDelivery([createAcceptedOutput()], {
      generatedAt: "2026-02-18T09:10:00.000Z",
      modelId: "gpt-5.3-codex",
    });

    const invalid = structuredClone(packaged.artifacts[0]);
    invalid.sections[0].summary = "";

    const result = validateDeliveryEnvelope(invalid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("String must contain at least 1 character"))).toBe(true);
  });

  it("blocks when provenance or glossary invariants are broken", () => {
    const packaged = packageAcceptedOutputsForDelivery([createAcceptedOutput()], {
      generatedAt: "2026-02-18T09:11:00.000Z",
      modelId: "gpt-5.3-codex",
    });

    const invalid = structuredClone(packaged.artifacts[0]);
    invalid.provenance.commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    invalid.glossary = [];

    const result = validateDeliveryEnvelope(invalid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("must equal project.commitSha"))).toBe(true);
    expect(result.issues.some((issue) => issue.path === "glossary")).toBe(true);
  });

  it("blocks when long padding is repeated across subsections", () => {
    const output = createAcceptedOutput();
    // Intentionally build a long, non-periodic block (no repeated 240+ char windows within the same body),
    // then paste it into every subsection. This should be caught by the cross-subsection repetition gate.
    const repeatedBlock = Array.from({ length: 240 }, (_, index) => `토큰${index}는공통블록의연속성을유지합니다`).join(" ");

    for (const section of output.draft.sections) {
      for (const sub of section.subsections) {
        sub.bodyKo = `서브섹션 ${sub.subsectionId}의 도입 문장입니다. ${repeatedBlock} (근거: src/runtime/pipeline.ts)`;
      }
    }

    expect(() =>
      packageAcceptedOutputsForDelivery([output], {
        generatedAt: "2026-02-18T09:13:00.000Z",
        modelId: "gpt-5.3-codex",
      }),
    ).toThrow(/cross-subsection bodyKo repetition detected/i);
  });
});

describe("delivery packaging compatibility", () => {
  it("rejects section missing architecture mermaid block", () => {
    const snapshotPath = mkdtempSync(join(tmpdir(), "devport-snapshot-"));
    mkdirSync(join(snapshotPath, "__devport__/trends"), { recursive: true });
    writeFileSync(join(snapshotPath, "README.md"), "# readme");
    writeFileSync(join(snapshotPath, "__devport__/trends/releases.json"), "{}");

    const makeBody = (prefix: string) =>
      `${Array.from({ length: 450 }, (_, index) => `${prefix}토큰${index}경로설명`).join(" ")} (근거: README.md)`;

    const sectionWithoutMermaid = {
      sectionId: "sec-1",
      titleKo: "프로젝트 한눈에 보기",
      summaryKo: "핵심 구조를 입문자 관점에서 설명하고 주요 파일 경로를 안내합니다.",
      sourcePaths: ["README.md", "__devport__/trends/releases.json"],
      subsections: [
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-1",
          titleKo: "진입 흐름",
          bodyKo: makeBody("a"),
        },
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-2",
          titleKo: "핵심 모듈",
          bodyKo: makeBody("b"),
        },
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-3",
          titleKo: "데이터 경로",
          bodyKo: makeBody("c"),
        },
      ],
      claims: [
        {
          claimId: "claim-1",
          sectionId: "sec-1",
          subsectionId: "sub-1-1",
          statementKo: "진입 흐름은 README 경로를 따라 초기화 순서를 설명합니다.",
          citationIds: ["cit-1"],
        },
      ],
      citations: [
        {
          citationId: "cit-1",
          evidenceId: "ev-1",
          repoPath: "README.md",
          lineRange: { start: 1, end: 1 },
          commitSha: COMMIT_SHA,
          permalink: `https://github.com/acme/widget/blob/${COMMIT_SHA}/README.md#L1-L1`,
          rationale: "README 경로 존재를 확인합니다.",
        },
      ],
    };

    const errors = validateSection(sectionWithoutMermaid as never, { snapshotPath });
    expect(errors.some((error) => /mermaid/i.test(error))).toBe(true);
  });

  it("accepts section output without claims/citations and with sourcePaths", () => {
    const parsed = SectionOutputSchema.safeParse({
      sectionId: "sec-1",
      titleKo: "프로젝트 한눈에 보기",
      summaryKo: "이 섹션은 프로젝트 구조와 실행 흐름을 입문자 관점에서 설명합니다.",
      sourcePaths: ["README.md", "__devport__/trends/releases.json"],
      subsections: [
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-1",
          titleKo: "진입 구조",
          bodyKo:
            "진입점 파일과 실행 흐름을 단계별로 설명합니다. 실행 순서와 오류 처리 경계를 정리하고, 초기화 이후 어떤 모듈이 호출되는지까지 입문자 관점으로 연결합니다.",
        },
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-2",
          titleKo: "구성 요소",
          bodyKo:
            "핵심 구성 요소의 책임 분리를 설명합니다. 모듈 연결과 데이터 전달 방식을 정리하고, 어떤 경로가 문서 소스와 트렌드 소스를 함께 소비하는지까지 설명합니다.",
        },
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-3",
          titleKo: "학습 포인트",
          bodyKo:
            "입문자가 먼저 읽어야 할 코드 경로를 소개합니다. 변경 이력과 문서 포인트를 연결하고, 기능 이해를 위해 어떤 파일부터 따라가야 하는지 구체적으로 안내합니다.",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("packages deterministic envelopes with compatible section/provenance fields", () => {
    const first = packageAcceptedOutputsForDelivery(
      [createAcceptedOutput({ ingestRunId: "run-2" }), createAcceptedOutput({ ingestRunId: "run-1" })],
      {
        generatedAt: "2026-02-18T09:12:00.000Z",
        modelId: "gpt-5.3-codex",
      },
    );

    const second = packageAcceptedOutputsForDelivery(
      [createAcceptedOutput({ ingestRunId: "run-2" }), createAcceptedOutput({ ingestRunId: "run-1" })],
      {
        generatedAt: "2026-02-18T09:12:00.000Z",
        modelId: "gpt-5.3-codex",
      },
    );

    expect(first).toEqual(second);
    expect(first.summary).toEqual({ attempted: 2, packaged: 2, blocked: 0 });
    expect(first.artifacts.map((artifact) => artifact.project.ingestRunId)).toEqual(["run-1", "run-2"]);
    expect(first.artifacts[0].sections[0]).toMatchObject({
      sectionId: "sec-1",
      summary: expect.any(String),
      deepDiveMarkdown: expect.any(String),
    });
    expect(first.artifacts[0].provenance.run.modelId).toBe("gpt-5.3-codex");
    expect(first.artifacts[0].glossary.length).toBeGreaterThan(0);
  });

  it("blocks packaging when gnd-04 strict findings exist", () => {
    const lowQuality = createAcceptedOutput({ ingestRunId: "run-strict" });
    lowQuality.draft.claims[0].statementKo =
      "보안 키 회전 주기를 인프라 정책 엔진과 연동해 실시간으로 결정합니다.";

    expect(() =>
      packageAcceptedOutputsForDelivery([lowQuality], {
        modelId: "gpt-5.3-codex",
        generatedAt: "2026-02-19T11:11:00.000Z",
      }),
    ).not.toThrow();

    expect(() =>
      packageAcceptedOutputsForDelivery([lowQuality], {
        modelId: "gpt-5.3-codex",
        generatedAt: "2026-02-19T11:11:00.000Z",
        qualityGateLevel: "strict",
      }),
    ).toThrow(/OUT-04 packaging blocked/i);
  });
});
