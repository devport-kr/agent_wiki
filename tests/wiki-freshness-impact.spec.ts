import { describe, expect, it } from "vitest";

import { extractSectionEvidenceFromAcceptedOutput } from "../src/freshness/section-evidence";
import { mapChangedPathsToImpactedSections } from "../src/freshness/impact-map";

describe("freshness impact", () => {
  it("extracts section evidence from section.sourcePaths", () => {
    const citationlessOutput = {
      ingest_run_id: "ingest-1",
      repo_ref: "acme/widget",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      section_count: 1,
      subsection_count: 3,
      total_korean_chars: 4000,
      source_doc_count: 1,
      trend_fact_count: 1,
      draft: {
        artifactType: "wiki-draft",
        repoFullName: "acme/widget",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        generatedAt: "2026-02-22T09:00:00.000Z",
        overviewKo: "개요 설명이며 입문자 학습 순서를 코드 경로 중심으로 정리합니다.",
        sourceDocs: [{ sourceId: "src-1", path: "README.md" }],
        trendFacts: [{ factId: "trend-1", category: "release", summaryKo: "릴리스 변화가 관찰됩니다." }],
        sections: [
          {
            sectionId: "sec-1",
            titleKo: "프로젝트 개요",
            summaryKo: "요약 설명이며 실행 흐름 핵심을 안내합니다.",
            sourcePaths: ["README.md", "__devport__/trends/releases.json"],
            subsections: [
              {
                sectionId: "sec-1",
                subsectionId: "sub-1-1",
                titleKo: "진입점",
                bodyKo: "README.md 기반으로 진입 경로를 설명합니다.",
              },
              {
                sectionId: "sec-1",
                subsectionId: "sub-1-2",
                titleKo: "핵심 모듈",
                bodyKo: "핵심 모듈 연결을 설명합니다.",
              },
              {
                sectionId: "sec-1",
                subsectionId: "sub-1-3",
                titleKo: "트렌드",
                bodyKo: "릴리스 트렌드 파일 연결을 설명합니다.",
              },
            ],
          },
        ],
      },
    };

    const evidence = extractSectionEvidenceFromAcceptedOutput(citationlessOutput as never);
    expect(evidence[0].repoPaths).toContain("README.md");
  });

  it("maps direct path matches to deterministic sectionId ordering", () => {
    const result = mapChangedPathsToImpactedSections({
      changed_paths: ["src/ui/page.tsx", "src/core/service.ts"],
      sectionEvidenceIndex: [
        {
          sectionId: "sec-2",
          repoPaths: ["src/core/service.ts"],
        },
        {
          sectionId: "sec-1",
          repoPaths: ["src/ui/page.tsx"],
        },
      ],
    });

    expect(result.mode).toBe("impact-mapped");
    expect(result.impacted_section_ids).toEqual(["sec-1", "sec-2"]);
    expect(result.unmatched_changed_paths).toEqual([]);
  });

  it("maps rename continuity when previous path is in changed_paths", () => {
    const result = mapChangedPathsToImpactedSections({
      changed_paths: ["src/new/file.ts", "src/old/file.ts"],
      sectionEvidenceIndex: [
        {
          sectionId: "sec-rename",
          repoPaths: ["src/old/file.ts"],
        },
      ],
    });

    expect(result.mode).toBe("impact-mapped");
    expect(result.impacted_section_ids).toEqual(["sec-rename"]);
    expect(result.unmatched_changed_paths).toEqual(["src/new/file.ts"]);
  });

  it("fails closed when changed paths exist but no section mapping exists", () => {
    const result = mapChangedPathsToImpactedSections({
      changed_paths: ["docs/changelog.md"],
      sectionEvidenceIndex: [
        {
          sectionId: "sec-1",
          repoPaths: ["src/a.ts"],
        },
      ],
    });

    expect(result.mode).toBe("full-rebuild-required");
    expect(result.impacted_section_ids).toEqual([]);
    expect(result.unmatched_changed_paths).toEqual(["docs/changelog.md"]);
  });

  it("returns noop mapping when there are no changed paths", () => {
    const result = mapChangedPathsToImpactedSections({
      changed_paths: [],
      sectionEvidenceIndex: [
        {
          sectionId: "sec-1",
          repoPaths: ["src/a.ts"],
        },
      ],
    });

    expect(result.mode).toBe("impact-mapped");
    expect(result.impacted_section_ids).toEqual([]);
    expect(result.unmatched_changed_paths).toEqual([]);
  });
});
