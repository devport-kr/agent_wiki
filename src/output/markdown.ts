import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type { GroundedAcceptedOutput } from "../contracts/grounded-output";

interface DraftSectionWithSourcePaths extends GroundedAcceptedOutput["draft"]["sections"][number] {
  sourcePaths?: string[];
}

export interface MarkdownBundleFile {
  relativePath: string;
  absolutePath: string;
}

export interface MarkdownBundleResult {
  outputDir: string;
  files: MarkdownBundleFile[];
}

export interface WriteMarkdownBundleOptions {
  outDir?: string;
}

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

function buildOutputDir(rootDir: string, repoRef: string): string {
  const [owner, repo] = repoRef.split("/");
  if (!owner || !repo) {
    throw new Error(`repo_ref must be owner/repo, got: ${repoRef}`);
  }
  return path.resolve(rootDir, owner, repo);
}

function buildSectionFileName(sectionId: string, sectionIndex: number): string {
  return `${String(sectionIndex + 1).padStart(2, "0")}-${sectionId}.md`;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(
    new Set(
      paths
        .map((value) => normalizeRepoPath(value))
        .filter((value) => value.length > 0),
    ),
  ).sort(compareDeterministic);
}

function resolveSectionSourcePaths(
  section: DraftSectionWithSourcePaths,
  acceptedOutput: GroundedAcceptedOutput,
): string[] {
  const directSourcePaths = Array.isArray(section.sourcePaths) ? uniquePaths(section.sourcePaths) : [];
  if (directSourcePaths.length > 0) {
    return directSourcePaths;
  }

  const citedSourcePaths = uniquePaths(
    (acceptedOutput.draft.claims ?? [])
      .filter((claim) => claim.sectionId === section.sectionId)
      .flatMap((claim) => claim.citationIds)
      .map((citationId) =>
        (acceptedOutput.draft.citations ?? []).find((citation) => citation.citationId === citationId)?.repoPath ?? "",
      ),
  );
  if (citedSourcePaths.length > 0) {
    return citedSourcePaths;
  }

  return [];
}

function renderSourceList(paths: string[], heading = "## 참고 소스"): string[] {
  if (paths.length === 0) {
    return [];
  }

  return [
    heading,
    "",
    ...paths.map((sourcePath) => `- \`${sourcePath}\``),
    "",
  ];
}

function renderOverviewMarkdown(
  acceptedOutput: GroundedAcceptedOutput,
  sectionFiles: Array<{ sectionId: string; titleKo: string; summaryKo: string; fileName: string }>,
): string {
  const trendFacts = acceptedOutput.draft.trendFacts ?? [];
  const sourceDocs = uniquePaths(acceptedOutput.draft.sourceDocs.map((sourceDoc) => sourceDoc.path));

  return [
    `# ${acceptedOutput.repo_ref}`,
    "",
    `- Commit: \`${acceptedOutput.commit_sha}\``,
    `- Generated: \`${acceptedOutput.draft.generatedAt}\``,
    `- Sections: ${acceptedOutput.section_count}`,
    `- Subsections: ${acceptedOutput.subsection_count}`,
    "",
    acceptedOutput.draft.overviewKo.trim(),
    "",
    "## 읽기 순서",
    "",
    ...sectionFiles.map(
      (section, index) =>
        `${index + 1}. [${section.titleKo}](${section.fileName})` +
        `${section.summaryKo.trim().length > 0 ? ` - ${section.summaryKo.trim()}` : ""}`,
    ),
    "",
    ...renderSourceList(sourceDocs, "## 전체 소스 문서"),
    ...(trendFacts.length > 0
      ? [
          "## 트렌드 요약",
          "",
          ...trendFacts.map((fact) => `- ${fact.summaryKo.trim()}`),
          "",
        ]
      : []),
  ].join("\n");
}

function renderSectionMarkdown(
  section: DraftSectionWithSourcePaths,
  sectionIndex: number,
  sourcePaths: string[],
): string {
  const lines: string[] = [
    `# ${sectionIndex + 1}. ${section.titleKo}`,
    "",
    section.summaryKo.trim(),
    "",
    ...renderSourceList(sourcePaths),
  ];

  for (const subsection of section.subsections) {
    lines.push(`## ${subsection.titleKo}`);
    lines.push("");
    lines.push(subsection.bodyKo.trim());
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export async function writeMarkdownBundle(
  acceptedOutput: GroundedAcceptedOutput,
  options: WriteMarkdownBundleOptions = {},
): Promise<MarkdownBundleResult> {
  const outputDir = buildOutputDir(options.outDir ?? "portki-output/wiki", acceptedOutput.repo_ref);
  await mkdir(outputDir, { recursive: true });

  const files: MarkdownBundleFile[] = [];
  const sectionFiles = acceptedOutput.draft.sections.map((section, index) => ({
    sectionId: section.sectionId,
    titleKo: section.titleKo,
    summaryKo: section.summaryKo,
    fileName: buildSectionFileName(section.sectionId, index),
  }));

  const readmePath = path.join(outputDir, "README.md");
  await writeFile(readmePath, `${renderOverviewMarkdown(acceptedOutput, sectionFiles)}\n`, "utf8");
  files.push({
    relativePath: "README.md",
    absolutePath: readmePath,
  });

  for (let index = 0; index < acceptedOutput.draft.sections.length; index += 1) {
    const section = acceptedOutput.draft.sections[index] as DraftSectionWithSourcePaths;
    const sourcePaths = resolveSectionSourcePaths(section, acceptedOutput);
    const fileName = buildSectionFileName(section.sectionId, index);
    const absolutePath = path.join(outputDir, fileName);
    const markdown = renderSectionMarkdown(section, index, sourcePaths);

    await writeFile(absolutePath, `${markdown}\n`, "utf8");
    files.push({
      relativePath: fileName,
      absolutePath,
    });
  }

  return {
    outputDir,
    files,
  };
}
