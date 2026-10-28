/**
 * Validate a report spec without rendering it.
 *
 * A report editor needs the same thing a rule editor gets from `validateRule`:
 * every problem, with a JSON-ish path, so the user can be pointed at the exact
 * field that is wrong. Rendering is fail-open by design (an unknown path renders
 * empty), which is right for a *report* and useless as *feedback* — a section
 * whose `source` is a typo silently renders "nothing to show" forever.
 *
 * The checks are deliberately structural, not semantic: this module does not try
 * to prove that `facts.files.created` exists (Chart cannot know what a custom
 * host passes as `session.*`), only that the shape is one the renderer can use.
 * Resolving a path against a real context is the *preview*'s job.
 */

import type { ReportSection, ReportSpec } from "./spec.ts";
import { validateWhen } from "../regimen/predicate.ts";
import { LEVELS } from "../core/types.ts";

export interface SpecIssue {
  /** Index into `spec.sections`, when the problem is inside one. */
  section: number;
  /** A path into the spec, e.g. `sections[2].columns[0].cell`. */
  path: string;
  message: string;
}

const KINDS = ["header", "verdict", "findings", "stats", "table", "list", "text", "timeline", "evidence"];

export function validateSpec(spec: unknown): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return [{ section: -1, path: "", message: "a report spec must be an object" }];
  }
  const candidate = spec as Partial<ReportSpec>;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    issues.push({ section: -1, path: "id", message: "a spec needs an id" });
  }
  if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
    issues.push({ section: -1, path: "title", message: "a spec needs a title" });
  }
  if (candidate.for !== undefined && !["live", "settled", "any"].includes(candidate.for)) {
    issues.push({ section: -1, path: "for", message: 'expected "live", "settled" or "any"' });
  }
  if (!Array.isArray(candidate.sections)) {
    issues.push({ section: -1, path: "sections", message: "a spec needs a `sections` array" });
    return issues;
  }
  if (candidate.sections.length === 0) {
    issues.push({ section: -1, path: "sections", message: "a report with no sections renders nothing" });
  }

  candidate.sections.forEach((section, index) => {
    if (typeof section !== "object" || section === null) {
      issues.push({ section: index, path: `sections[${index}]`, message: "expected a section object" });
      return;
    }
    issues.push(...validateSection(section as ReportSection, index));
  });

  return issues;
}

function validateSection(section: ReportSection, index: number): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const at = (field: string) => `sections[${index}].${field}`;
  const kind = (section as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) {
    issues.push({ section: index, path: at("kind"), message: `expected one of ${KINDS.join(", ")}` });
    return issues;
  }

  /** A `filter` is a `When` over one element, so a window or sequence makes no sense. */
  const filter = (value: unknown, field: string) => {
    if (value === undefined) return;
    for (const issue of validateWhen(value, at(field))) {
      issues.push({ section: index, path: issue.path, message: issue.message });
    }
    for (const condition of (value as { conditions?: unknown[] })?.conditions ?? []) {
      if (typeof condition !== "object" || condition === null) continue;
      if ("window" in condition) {
        issues.push({
          section: index,
          path: at(field),
          message: "a filter reads one row — a window needs the event stream, so it belongs in a rule",
        });
      }
      if ("sequence" in condition) {
        issues.push({
          section: index,
          path: at(field),
          message: "a filter reads one row — a sequence needs order, so it belongs in a rule",
        });
      }
    }
  };

  /** A required string field. Missing counts as wrong: the renderer needs it. */
  const requiresString = (field: string, why: string) => {
    const value = (section as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({ section: index, path: at(field), message: why });
    }
  };

  switch (section.kind) {
    case "header":
      requiresString("title", "a header needs a title");
      break;

    case "verdict":
      if (section.showFindings !== undefined && typeof section.showFindings !== "boolean") {
        issues.push({ section: index, path: at("showFindings"), message: "expected true or false" });
      }
      break;

    case "findings":
      if (section.minLevel !== undefined && !LEVELS.includes(section.minLevel)) {
        issues.push({ section: index, path: at("minLevel"), message: `expected one of ${LEVELS.join(", ")}` });
      }
      if (section.tags !== undefined && !Array.isArray(section.tags)) {
        issues.push({ section: index, path: at("tags"), message: "expected an array of tag strings" });
      }
      filter(section.filter, "filter");
      break;

    case "stats":
      if (!Array.isArray(section.rows) || section.rows.length === 0) {
        issues.push({ section: index, path: at("rows"), message: "a stats section needs at least one row" });
      } else {
        section.rows.forEach((row, rowIndex) => {
          if (typeof row?.label !== "string" || typeof row?.value !== "string") {
            issues.push({
              section: index,
              path: at(`rows[${rowIndex}]`),
              message: "expected { label, value } as strings",
            });
          }
        });
      }
      break;

    case "table":
      requiresString("source", "a table needs a `source` path");
      if (!Array.isArray(section.columns) || section.columns.length === 0) {
        issues.push({ section: index, path: at("columns"), message: "a table needs at least one column" });
      } else {
        section.columns.forEach((column, columnIndex) => {
          if (typeof column?.header !== "string" || column.header.length === 0) {
            issues.push({ section: index, path: at(`columns[${columnIndex}].header`), message: "a column needs a header" });
          }
          if (typeof column?.cell !== "string" || column.cell.length === 0) {
            issues.push({ section: index, path: at(`columns[${columnIndex}].cell`), message: "a column needs a cell template" });
          }
          if (column?.width !== undefined && !["auto", "narrow", "wide"].includes(column.width)) {
            issues.push({
              section: index,
              path: at(`columns[${columnIndex}].width`),
              message: 'expected "auto", "narrow" or "wide"',
            });
          }
        });
      }
      filter(section.filter, "filter");
      break;

    case "list":
      requiresString("source", "a list needs a `source` path");
      requiresString("item", "a list needs an `item` template");
      filter(section.filter, "filter");
      break;

    case "text":
      requiresString("source", "a text section needs a `source` path");
      if (section.style !== undefined && !["paragraph", "code"].includes(section.style)) {
        issues.push({ section: index, path: at("style"), message: 'expected "paragraph" or "code"' });
      }
      filter(section.filter, "filter");
      break;

    case "timeline":
    case "evidence":
      break;
  }

  if ("limit" in section && section.limit !== undefined) {
    if (!(typeof section.limit === "number" && Number.isFinite(section.limit) && section.limit > 0)) {
      issues.push({ section: index, path: at("limit"), message: "expected a positive number" });
    }
  }

  return issues;
}
