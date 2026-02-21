import { promises as fs } from "node:fs";
import path from "node:path";

import {
  SectionPlanOutputSchema,
  type ChunkedSectionPlanEntry,
  type ChunkedSubsectionPlan,
  type SectionPlanOutput,
} from "../contracts/chunked-generation";
import type { IngestRunArtifact } from "../ingestion/types";

const MAX_FOCUS_PATHS_PER_SECTION = 30;
const MAX_SECTION_COUNT = 6;

const SKIP_DIRS = new Set([".git", ".husky", "node_modules", "dist", ".next", "target"]);

interface FileEntry {
  relativePath: string;
  bytes: number;
}

interface SectionTemplate {
  sectionId: string;
  titleKo: string;
  summaryKo: string;
  keywords: string[];
  hintPaths: string[];
  subsectionKinds: Array<Array<"code" | "config" | "tests" | "docs">>;
}

interface SectionTemplateSeed {
  titleKo: string;
  summaryKo: string;
  keywords: string[];
  hintPaths: string[];
  subsectionKinds: Array<Array<"code" | "config" | "tests" | "docs">>;
}

const BASE_TEMPLATE_SEEDS: SectionTemplateSeed[] = [
  {
    titleKo: "입문자 빠른 시작과 저장소 지도",
    summaryKo:
      "이 섹션은 저장소를 처음 읽는 개발자가 어떤 파일부터 확인해야 하는지와 기본 실행 맥락을 안내합니다.",
    keywords: ["readme", "getting-started", "guide", "agent", "main", "index"],
    hintPaths: ["README.md", "docs/getting-started.md", "src/agent.ts", "package.json"],
    subsectionKinds: [["docs", "code"], ["code", "config"], ["docs", "code"]],
  },
  {
    titleKo: "실행 아키텍처와 핵심 호출 흐름",
    summaryKo:
      "이 섹션은 핵심 오케스트레이션 계층의 호출 순서와 구성요소 경계를 아키텍처 관점에서 설명합니다.",
    keywords: ["orchestration", "pipeline", "chunked", "package", "validate", "finalize"],
    hintPaths: [
      "src/orchestration/package-delivery.ts",
      "src/chunked/plan-sections.ts",
      "src/chunked/persist-section.ts",
      "src/chunked/finalize.ts",
    ],
    subsectionKinds: [["code"], ["code", "config"], ["code", "tests"]],
  },
  {
    titleKo: "핵심 기능 구현과 데이터 경로",
    summaryKo:
      "이 섹션은 계약 스키마, 신선도 추적, 패키징 로직이 어떤 데이터 경로를 따라 연결되는지 설명합니다.",
    keywords: ["contracts", "freshness", "packaging", "persistence", "ingestion"],
    hintPaths: [
      "src/contracts/wiki-generation.ts",
      "src/contracts/chunked-generation.ts",
      "src/contracts/wiki-freshness.ts",
      "src/freshness/section-evidence.ts",
    ],
    subsectionKinds: [["code", "config"], ["code"], ["code", "tests"]],
  },
  {
    titleKo: "최근 트렌드와 공식 문서 변화",
    summaryKo:
      "이 섹션은 릴리스/태그 변화와 공식 문서 경로를 기반으로 최근 트렌드 신호를 정리합니다.",
    keywords: ["trend", "release", "tag", "changelog", "official-docs", "docs"],
    hintPaths: [
      "__devport__/trends/releases.json",
      "__devport__/trends/tags.json",
      "__devport__/official-docs/index.json",
      "CHANGELOG.md",
      "docs/",
    ],
    subsectionKinds: [["docs"], ["docs", "code"], ["docs", "tests"]],
  },
];

const OPTIONAL_TEMPLATE_SEEDS: SectionTemplateSeed[] = [
  {
    titleKo: "검증 전략과 운영 품질 게이트",
    summaryKo:
      "이 섹션은 테스트 구성, 품질 점수, 엄격 모드 검증 경로를 연결해 운영 안정성 확보 방법을 설명합니다.",
    keywords: ["test", "spec", "quality", "gate", "scorecard", "strict"],
    hintPaths: [
      "tests/e2e-quality-first-smoke.spec.ts",
      "tests/wiki-delivery-packaging.spec.ts",
      "src/quality/scorecard.ts",
      "src/chunked/validate-section.ts",
    ],
    subsectionKinds: [["tests"], ["code", "tests"], ["config", "tests"]],
  },
  {
    titleKo: "확장 포인트와 기여 가이드",
    summaryKo:
      "이 섹션은 외부 확장 가능 지점과 문서화된 기여 흐름을 정리해 유지보수/확장 관점을 제공합니다.",
    keywords: ["guideline", "agents", "readme", "contrib", "plugin", "extension"],
    hintPaths: ["AGENTS.md", "GUIDELINE.md", "README.md", "docs/"],
    subsectionKinds: [["docs"], ["code", "docs"], ["docs", "tests"]],
  },
];

function compareDeterministic(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

async function collectFiles(rootPath: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  const walk = async (relativeDir: string): Promise<void> => {
    const absolute = path.join(rootPath, relativeDir);
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = dirents.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    for (const dirent of sorted) {
      if (dirent.name === "snapshot-manifest.json" || dirent.isSymbolicLink()) {
        continue;
      }

      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name.toLowerCase())) {
          continue;
        }
        await walk(path.join(relativeDir, dirent.name));
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      const filePath = normalizeRepoPath(path.join(relativeDir, dirent.name));
      try {
        const stat = await fs.stat(path.join(rootPath, filePath));
        entries.push({ relativePath: filePath, bytes: stat.size });
      } catch {
        // Skip unreadable files.
      }
    }
  };

  await walk(".");
  return entries;
}

function sectionIdFromIndex(index: number): string {
  return `sec-${index + 1}`;
}

function pickTemplates(filesScanned: number): SectionTemplate[] {
  const seeds: SectionTemplateSeed[] = [...BASE_TEMPLATE_SEEDS];

  if (filesScanned >= 120) {
    seeds.push(OPTIONAL_TEMPLATE_SEEDS[0]);
  }
  if (filesScanned >= 400) {
    seeds.push(OPTIONAL_TEMPLATE_SEEDS[1]);
  }

  return seeds.slice(0, MAX_SECTION_COUNT).map((seed, index) => ({
    sectionId: sectionIdFromIndex(index),
    titleKo: seed.titleKo,
    summaryKo: seed.summaryKo,
    keywords: seed.keywords,
    hintPaths: seed.hintPaths,
    subsectionKinds: seed.subsectionKinds,
  }));
}

function buildSubsections(template: SectionTemplate): ChunkedSubsectionPlan[] {
  const sectionNumber = template.sectionId.replace("sec-", "");

  return [
    {
      subsectionId: `sub-${sectionNumber}-1`,
      titleKo: `${template.titleKo} - 구조와 책임`,
      objectiveKo: "핵심 파일 배치와 모듈 책임을 먼저 파악하고 입문자가 따라갈 기본 맥락을 제공합니다.",
      targetEvidenceKinds: template.subsectionKinds[0] ?? ["code"],
      targetCharacterCount: 3000,
    },
    {
      subsectionId: `sub-${sectionNumber}-2`,
      titleKo: `${template.titleKo} - 실행/데이터 흐름`,
      objectiveKo: "중요 호출 체인과 데이터 이동 경로를 추적해 실제 동작 관점의 이해를 제공합니다.",
      targetEvidenceKinds: template.subsectionKinds[1] ?? ["code", "config"],
      targetCharacterCount: 3000,
    },
    {
      subsectionId: `sub-${sectionNumber}-3`,
      titleKo: `${template.titleKo} - 검증과 변경 포인트`,
      objectiveKo: "테스트 근거와 변경 민감 지점을 연결해 향후 수정 시 확인해야 할 체크포인트를 제공합니다.",
      targetEvidenceKinds: template.subsectionKinds[2] ?? ["tests", "docs"],
      targetCharacterCount: 3000,
    },
  ];
}

function buildFocusPaths(
  template: SectionTemplate,
  files: FileEntry[],
  filePathSet: Set<string>,
  keyPaths: string[],
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  const normalizedKeywords = template.keywords.map((keyword) => keyword.toLowerCase());

  const addPath = (candidate: string): void => {
    const normalized = normalizeRepoPath(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    if (normalized.endsWith("/")) {
      for (const file of files) {
        if (file.relativePath.startsWith(normalized) && !seen.has(file.relativePath)) {
          seen.add(file.relativePath);
          selected.push(file.relativePath);
        }
      }
      return;
    }

    if (!filePathSet.has(normalized)) {
      return;
    }

    seen.add(normalized);
    selected.push(normalized);
  };

  for (const hintPath of template.hintPaths) {
    addPath(hintPath);
  }

  const keywordMatchedFiles = files
    .filter((file) => {
      const lowered = file.relativePath.toLowerCase();
      return normalizedKeywords.some((keyword) => lowered.includes(keyword));
    })
    .sort((left, right) => {
      if (right.bytes !== left.bytes) {
        return right.bytes - left.bytes;
      }
      return compareDeterministic(left.relativePath, right.relativePath);
    });

  for (const file of keywordMatchedFiles) {
    addPath(file.relativePath);
  }

  for (const keyPath of keyPaths) {
    addPath(keyPath);
  }

  const fallbackFiles = files
    .slice()
    .sort((left, right) => {
      if (right.bytes !== left.bytes) {
        return right.bytes - left.bytes;
      }
      return compareDeterministic(left.relativePath, right.relativePath);
    });

  for (const file of fallbackFiles) {
    addPath(file.relativePath);
  }

  return selected.slice(0, MAX_FOCUS_PATHS_PER_SECTION);
}

function buildCrossReferences(
  sections: ChunkedSectionPlanEntry[],
): Array<{ fromSectionId: string; toSectionId: string; relation: string }> {
  const references: Array<{ fromSectionId: string; toSectionId: string; relation: string }> = [];
  for (let index = 0; index < sections.length - 1; index += 1) {
    references.push({
      fromSectionId: sections[index].sectionId,
      toSectionId: sections[index + 1].sectionId,
      relation: "다음 섹션에서 연결된 구현 세부를 설명합니다",
    });
  }
  return references;
}

export async function planSections(artifact: IngestRunArtifact): Promise<SectionPlanOutput> {
  const files = await collectFiles(artifact.snapshot_path);
  const filePathSet = new Set(files.map((file) => file.relativePath));
  const keyPaths = (artifact.metadata.key_paths ?? [])
    .map((value) => normalizeRepoPath(value))
    .filter((value) => value.length > 0)
    .sort(compareDeterministic);

  const templates = pickTemplates(artifact.files_scanned);

  const sections: ChunkedSectionPlanEntry[] = templates.map((template) => {
    const subsections = buildSubsections(template);
    return {
      sectionId: template.sectionId,
      titleKo: template.titleKo,
      summaryKo: template.summaryKo,
      focusPaths: buildFocusPaths(template, files, filePathSet, keyPaths),
      subsectionCount: subsections.length,
      subsections,
    };
  });

  const plan: SectionPlanOutput = {
    artifactType: "chunked-section-plan",
    repoFullName: artifact.repo_ref.toLowerCase(),
    commitSha: artifact.commit_sha,
    ingestRunId: artifact.ingest_run_id,
    snapshotPath: artifact.snapshot_path,
    generatedAt: new Date().toISOString(),
    overviewKo:
      "이 플랜은 입문자 관점의 빠른 이해를 우선으로 구성되며, 아키텍처 설명과 트렌드 신호를 함께 포함하는 4-6개 섹션 템플릿을 제공합니다.",
    totalSections: sections.length,
    sections,
    crossReferences: buildCrossReferences(sections),
  };

  return SectionPlanOutputSchema.parse(plan);
}
