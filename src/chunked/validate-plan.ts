import { existsSync } from "node:fs";
import path from "node:path";

import {
    SectionPlanOutputSchema,
    type SectionPlanOutput,
} from "../contracts/chunked-generation";

export interface ValidatePlanOptions {
    snapshotPath: string;
}

/**
 * Validates an AI-generated section plan against the SectionPlanOutput schema
 * and performs additional semantic checks (focus path existence, title uniqueness).
 *
 * Returns the validated plan or throws with actionable error messages.
 */
export function validatePlan(
    raw: unknown,
    options: ValidatePlanOptions,
): SectionPlanOutput {
    // ── Schema validation ───────────────────────────────────────────────────
    const parsed = SectionPlanOutputSchema.parse(raw);

    const errors: string[] = [];

    // ── Focus paths must exist in snapshot ───────────────────────────────────
    for (const section of parsed.sections) {
        for (const focusPath of section.focusPaths) {
            const absolute = path.join(options.snapshotPath, focusPath);
            if (!existsSync(absolute)) {
                errors.push(
                    `${section.sectionId}: focusPath "${focusPath}" does not exist in snapshot`,
                );
            }
        }
    }

    // ── Section titles must be unique ───────────────────────────────────────
    const seenTitles = new Set<string>();
    for (const section of parsed.sections) {
        const normalized = section.titleKo.trim().toLowerCase();
        if (seenTitles.has(normalized)) {
            errors.push(
                `Duplicate section title: "${section.titleKo}"`,
            );
        }
        seenTitles.add(normalized);
    }

    // ── Section IDs must follow sec-N pattern ───────────────────────────────
    for (let i = 0; i < parsed.sections.length; i++) {
        const expected = `sec-${i + 1}`;
        if (parsed.sections[i].sectionId !== expected) {
            errors.push(
                `Section at index ${i} has sectionId "${parsed.sections[i].sectionId}", expected "${expected}"`,
            );
        }
    }

    // ── Subsection IDs must follow sub-N-M pattern ──────────────────────────
    for (const section of parsed.sections) {
        const sectionNum = section.sectionId.replace("sec-", "");
        for (let i = 0; i < section.subsections.length; i++) {
            const expected = `sub-${sectionNum}-${i + 1}`;
            if (section.subsections[i].subsectionId !== expected) {
                errors.push(
                    `${section.sectionId}: subsection at index ${i} has id "${section.subsections[i].subsectionId}", expected "${expected}"`,
                );
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(
            `Plan validation failed (${errors.length} issue(s)):\n` +
            errors.map((e) => `  - ${e}`).join("\n"),
        );
    }

    return parsed;
}
