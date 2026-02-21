import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { finalize } from "../src/chunked/finalize";
import { planSections } from "../src/chunked/plan-sections";
import { runIngest } from "../src/ingestion/run";
import type { GitHubResolver } from "../src/ingestion/github";
import { isLikelyCommitSha } from "../src/ingestion/ref";
import { packageAcceptedOutputsForDelivery } from "../src/orchestration/package-delivery";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

class StubResolver implements GitHubResolver {
  async getRepositoryMeta() {
    return {
      owner: "acme",
      repo: "widget",
      full_name: "acme/widget",
      default_branch: "main",
    };
  }

  async resolveRefToCommit(
    _: { owner: string; repo: string; repo_full_name: string; requested_ref: string | null },
    ref: string,
  ): Promise<string> {
    if (ref === "main" || isLikelyCommitSha(ref)) {
      return COMMIT_SHA;
    }
    throw new Error(`Unknown ref: ${ref}`);
  }

  async getRepositoryLanguages(): Promise<Record<string, number>> {
    return {
      TypeScript: 80,
      Markdown: 20,
    };
  }
}

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function createSourceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "devport-e2e-quality-first-"));
  writeFixtureFile(root, "README.md", "# widget\n");
  writeFixtureFile(root, "src/runtime/pipeline.ts", "export const pipeline = true;\n");
  writeFixtureFile(root, "src/runtime/errors.ts", "export const classify = () => 'recoverable';\n");
  writeFixtureFile(root, "src/storage/snapshot.ts", "export const hash = (x: string) => x.length;\n");
  writeFixtureFile(root, "src/integration/mcp.ts", "export const connectMcp = () => true;\n");
  writeFixtureFile(root, "tests/runtime/pipeline.spec.ts", "describe('pipeline', () => {});\n");
  for (let i = 1; i <= 24; i += 1) {
    writeFixtureFile(root, `src/modules/module-${i}.ts`, `export const module${i} = ${i};\n`);
  }
  return root;
}

function createAcceptedOutput(commitSha: string) {
  const sectionTokens = ["알파", "베타", "감마", "델타", "엡실론", "제타"];
  const subsectionTokens = ["하나", "둘", "셋"];

  const sections = Array.from({ length: 6 }).map((_, sectionIndex) => ({
    sectionId: `sec-${sectionIndex + 1}`,
    titleKo: `섹션 ${sectionIndex + 1}`,
    summaryKo: `섹션 ${sectionIndex + 1}은 캐시 계층(Cache Layer)과 파이프라인 경계를 설명합니다.`,
    subsections: Array.from({ length: 3 }).map((__, subsectionIndex) => ({
      sectionId: `sec-${sectionIndex + 1}`,
      subsectionId: `sub-${sectionIndex + 1}-${subsectionIndex + 1}`,
      titleKo: `하위 섹션 ${sectionIndex + 1}-${subsectionIndex + 1}`,
      bodyKo:
        "src/runtime/pipeline.ts 경로를 기준으로 queue retry backoff 단계와 오류 전파 차단을 설명합니다. " +
        `섹션 토큰 ${sectionTokens[sectionIndex]} 와 하위 토큰 ${subsectionTokens[subsectionIndex]} 경로를 추가합니다.`,
    })),
  }));

  const claims = Array.from({ length: 18 }).map((_, index) => ({
    claimId: `claim-${index + 1}`,
    sectionId: `sec-${Math.floor(index / 3) + 1}`,
    subsectionId: `sub-${Math.floor(index / 3) + 1}-${(index % 3) + 1}`,
    statementKo:
      `pipeline queue retry backoff 처리 흐름은 복구 가능 오류에서 재시도를 수행하고 처리량을 안정화합니다 (${index + 1}).`,
    citationIds: [`cit-${index + 1}`],
  }));

  const citations = Array.from({ length: 18 }).map((_, index) => ({
    citationId: `cit-${index + 1}`,
    evidenceId: `ev-${index + 1}`,
    repoPath: "src/runtime/pipeline.ts",
    lineRange: { start: index + 1, end: index + 20 },
    commitSha: commitSha,
    permalink: `https://github.com/acme/widget/blob/${commitSha}/src/runtime/pipeline.ts#L${index + 1}-L${index + 20}`,
    rationale: "queue retry backoff throughput pipeline",
  }));

  const draft = {
    artifactType: "wiki-draft" as const,
    repoFullName: "acme/widget",
    commitSha,
    generatedAt: "2026-02-19T12:00:00.000Z",
    overviewKo:
      "이 위키는 런타임 파이프라인과 스냅샷 처리 경계를 코드 근거로 설명하며 strict 품질 게이트를 통과하도록 설계되었습니다.",
    sections,
    claims,
    citations,
    groundingReport: {
      artifactType: "grounding-report" as const,
      gateId: "GND-04" as const,
      checkedAt: "2026-02-19T12:00:10.000Z",
      passed: true,
      totalClaims: claims.length,
      claimsWithCitations: claims.length,
      citationCoverage: 1,
      issues: [],
    },
  };

  const totalKoreanChars =
    draft.overviewKo.length +
    draft.sections.reduce(
      (sum, section) =>
        sum + section.summaryKo.length + section.subsections.reduce((subSum, subsection) => subSum + subsection.bodyKo.length, 0),
      0,
    );

  return {
    ingest_run_id: "ingest-e2e-quality-first",
    repo_ref: "acme/widget",
    commit_sha: commitSha,
    section_count: draft.sections.length,
    subsection_count: draft.sections.reduce((sum, section) => sum + section.subsections.length, 0),
    total_korean_chars: totalKoreanChars,
    claim_count: draft.claims.length,
    citation_count: draft.citations.length,
    draft,
    grounding_report: draft.groundingReport,
  };
}

describe("quality-first e2e smoke", () => {
  it("finalize reports section/subsection counts without claim/citation counters", async () => {
    const root = mkdtempSync(join(tmpdir(), "devport-finalize-smoke-"));
    const sectionOutputPath = join(root, "section-1-output.json");

    const longBody =
      "README.md 경로와 __devport__/trends/releases.json 경로를 기준으로 실행 흐름을 상세히 설명합니다. " +
      "입문자 관점에서 호출 순서와 데이터 경계를 단계별로 정리해 이해 부담을 낮춥니다.";

    const sectionOutput = {
      sectionId: "sec-1",
      titleKo: "프로젝트 한눈에 보기",
      summaryKo: "입문자 관점에서 핵심 구조와 실행 흐름을 설명합니다.",
      sourcePaths: ["README.md", "__devport__/trends/releases.json"],
      subsections: [
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-1",
          titleKo: "진입 흐름",
          bodyKo: `${longBody} (섹션 A)`,
        },
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-2",
          titleKo: "핵심 모듈",
          bodyKo: `${longBody} (섹션 B)`,
        },
        {
          sectionId: "sec-1",
          subsectionId: "sub-1-3",
          titleKo: "데이터 경로",
          bodyKo: `${longBody} (섹션 C)`,
        },
      ],
    };

    writeFileSync(sectionOutputPath, `${JSON.stringify(sectionOutput, null, 2)}\n`, "utf8");

    const session = {
      sessionId: "session-1",
      repoFullName: "acme/widget",
      commitSha: COMMIT_SHA,
      ingestRunId: "ingest-run-1",
      planPath: join(root, "plan.json"),
      startedAt: "2026-02-22T10:00:00.000Z",
      sections: {
        "sec-1": {
          status: "persisted",
          sectionOutputPath,
          persistedAt: "2026-02-22T10:01:00.000Z",
          chunksInserted: 4,
          claimCount: 0,
          citationCount: 0,
          subsectionCount: 3,
          koreanChars: 1200,
        },
      },
    };

    const plan = {
      artifactType: "chunked-section-plan",
      repoFullName: "acme/widget",
      commitSha: COMMIT_SHA,
      ingestRunId: "ingest-run-1",
      snapshotPath: root,
      generatedAt: "2026-02-22T10:00:00.000Z",
      overviewKo: "전체 구조를 초심자 관점에서 요약하는 개요입니다.",
      totalSections: 1,
      sections: [
        {
          sectionId: "sec-1",
          titleKo: "프로젝트 한눈에 보기",
          summaryKo: "요약",
          focusPaths: ["README.md"],
          subsectionCount: 3,
          subsections: [
            {
              subsectionId: "sub-1-1",
              titleKo: "진입 흐름",
              objectiveKo: "진입 흐름 설명",
              targetEvidenceKinds: ["code"],
              targetCharacterCount: 3000,
            },
            {
              subsectionId: "sub-1-2",
              titleKo: "핵심 모듈",
              objectiveKo: "핵심 모듈 설명",
              targetEvidenceKinds: ["code"],
              targetCharacterCount: 3000,
            },
            {
              subsectionId: "sub-1-3",
              titleKo: "데이터 경로",
              objectiveKo: "데이터 경로 설명",
              targetEvidenceKinds: ["docs"],
              targetCharacterCount: 3000,
            },
          ],
        },
      ],
      crossReferences: [],
    };

    const transactionalQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM wiki_drafts")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM projects")) {
          return { rows: [{ id: 1, external_id: "proj-ext-1" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: transactionalQuery,
        release: vi.fn(),
      })),
    };

    const result = await finalize(session as never, plan as never, {
      pool: pool as never,
      openai: {} as never,
      advanceBaseline: false,
      statePath: join(root, "state.json"),
    });

    expect((result as { totalClaims?: number }).totalClaims).toBeUndefined();
    expect((result as { totalCitations?: number }).totalCitations).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("plans beginner-trend sections including architecture and trend section", async () => {
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-e2e-quality-first-plan-"));
    const sourceRoot = createSourceFixture();

    try {
      const artifact = await runIngest(
        {
          repo_ref: { repo: "acme/widget" },
          snapshot_root: snapshotRoot,
          force_rebuild: false,
          fixture_commit: COMMIT_SHA,
        },
        {
          resolver: new StubResolver(),
          sourcePath: sourceRoot,
          fixtureCommit: COMMIT_SHA,
          now: () => "2026-02-19T12:00:00.000Z",
        },
      );

      const plan = await planSections(artifact);
      expect(plan.totalSections).toBeGreaterThanOrEqual(4);
      expect(plan.totalSections).toBeLessThanOrEqual(6);
      expect(plan.sections.some((section) => section.titleKo.includes("아키텍처"))).toBe(true);
      expect(plan.sections.some((section) => section.titleKo.includes("트렌드"))).toBe(true);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("runs ingest -> plan-sections(v2) -> package with strict quality gate", async () => {
    const snapshotRoot = mkdtempSync(join(tmpdir(), "devport-e2e-quality-first-snapshots-"));
    const sourceRoot = createSourceFixture();

    try {
      const artifact = await runIngest(
        {
          repo_ref: { repo: "acme/widget" },
          snapshot_root: snapshotRoot,
          force_rebuild: false,
          fixture_commit: COMMIT_SHA,
        },
        {
          resolver: new StubResolver(),
          sourcePath: sourceRoot,
          fixtureCommit: COMMIT_SHA,
          now: () => "2026-02-19T12:00:00.000Z",
        },
      );

      const plan = await planSections(artifact);
      expect(plan.sections.length).toBeGreaterThanOrEqual(4);
      expect(plan.sections.length).toBeLessThanOrEqual(6);

      const accepted = createAcceptedOutput(artifact.commit_sha);
      const packaged = packageAcceptedOutputsForDelivery([accepted], {
        qualityGateLevel: "strict",
        modelId: "gpt-5.3-codex",
        generatedAt: "2026-02-19T12:00:30.000Z",
      });

      expect(packaged.summary).toEqual({ attempted: 1, packaged: 1, blocked: 0 });
      expect(packaged.artifacts[0].metadata.qualityScorecard.semanticFaithfulness).toBeGreaterThan(0);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});
