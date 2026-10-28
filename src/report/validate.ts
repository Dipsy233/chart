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
import { matches, resolvePath, validateWhen, type When } from "../regimen/predicate.ts";
import { checkTemplate, type TemplateContext, type TemplateIssue } from "../regimen/template.ts";
import { LEVELS } from "../core/types.ts";
import { LIVE_FIELDS, REPORT_VARS, allFields, sourceFields } from "../editor/catalog.ts";

export interface SpecIssue {
  /** Index into `spec.sections`, when the problem is inside one. */
  section: number;
  /** A path into the spec, e.g. `sections[2].columns[0].cell`. */
  path: string;
  message: string;
}

/** A template that does not resolve, with the spec path that holds it. */
export interface TemplateIssueAt extends TemplateIssue {
  /** A path into the spec, e.g. `sections[2].columns[0].cell`. */
  path: string;
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

/* ── Template resolution, against real data ─────────────────────────────── */

/**
 * Check every template in a spec against a context that actually holds data.
 *
 * `validateSpec` is structural: it proves the shape is renderable, not that a
 * path resolves. This is the other half, and it is the one a *user* sees —
 * `{{facts.commands.faild}}` is a well-formed section that renders an empty
 * string forever.
 *
 * The subtlety that made the first version of this wrong: a `table`/`list`/`text`
 * template is rendered **once per row**, with `vars.row` bound to that element.
 * Checking it with `vars.row = {}` reports every single `{{vars.row.…}}` as
 * unresolved — 22 false alarms on the shipped spec. So the check binds
 * `vars.row` to the section's *first actual row*, which is exactly the context
 * the renderer will use. A section with no rows has nothing to check: there is
 * no row, so there is no template to be wrong about.
 *
 * `filter` is applied first, because the row the renderer sees is a *kept* row.
 */
export interface TemplateCheckOptions {
  /** Resolve a `source` path yourself, when the caller has a richer context. */
  resolve?: (path: string) => unknown;
  /**
   * Whether a field path is *real*, regardless of whether it has a value here.
   *
   * This is what separates "you typed the name wrong" from "this row happens not
   * to have that field". `durationMs` is optional on a command and
   * `live.elapsedSeconds` is derived from the clock, so both are legitimately
   * absent — reporting them as typos would be 22 false alarms on the shipped
   * spec, which is exactly what happened.
   *
   * The section's `source` is passed because `vars.row.x` depends on it:
   * `facts.commandFacts` elements have `command`, `facts.files.byPath` elements
   * have `path`. Pass `knownFieldFor` from `validate.ts` to get the catalogue's
   * answer.
   */
  known?: (path: string, source: string | undefined) => boolean;
}

export function checkSpecTemplates(
  spec: ReportSpec,
  context: TemplateContext,
  options: TemplateCheckOptions = {},
): TemplateIssueAt[] {
  const out: TemplateIssueAt[] = [];
  const issues = (template: string | undefined, path: string, row?: unknown, source?: string) => {
    if (template === undefined || template === "") return;
    const at: TemplateContext = row === undefined
      ? context
      : { ...context, vars: { ...(context.vars ?? {}), row } };
    for (const issue of checkTemplate(template, at)) {
      // A path the schema knows is not a typo, even when this particular row has
      // no value for it.
      if (options.known?.(issue.path, source)) continue;
      out.push({ ...issue, path });
    }
  };

  issues(spec.title, "title");

  spec.sections.forEach((section, index) => {
    const base = `sections[${index}]`;
    if ("title" in section) issues(section.title, `${base}.title`);
    if (section.kind === "header") issues(section.subtitle, `${base}.subtitle`);

    if (section.kind === "stats") {
      section.rows.forEach((row, rowIndex) => issues(row.value, `${base}.rows[${rowIndex}].value`));
    }

    if (section.kind === "table" || section.kind === "list" || section.kind === "text") {
      const first = firstRow(section, context, options.resolve);
      // No row means the section renders its `empty` text and no template runs.
      if (first === undefined) return;
      const source = section.source;
      if (section.kind === "table") {
        section.columns.forEach((column, columnIndex) =>
          issues(column.cell, `${base}.columns[${columnIndex}].cell`, first, source),
        );
      } else if (section.kind === "list") {
        issues(section.item, `${base}.item`, first, source);
      } else if (section.item) {
        issues(section.item, `${base}.item`, first, source);
      }
    }
  });

  return out;
}

/** The first element a `table`/`list`/`text` section would render, or undefined. */
function firstRow(
  section: ReportSection,
  context: TemplateContext,
  resolve: ((path: string) => unknown) | undefined,
): unknown {
  if (!("source" in section)) return undefined;
  const root = resolve
    ? resolve(section.source)
    : resolveSourcePath(section.source, context);
  const list = Array.isArray(root)
    ? root
    : root && typeof root === "object"
      ? Object.values(root as Record<string, unknown>)
      : [];
  const filter = "filter" in section ? section.filter : undefined;
  const kept = filter ? list.filter((element) => matchesElement(filter, element)) : list;
  return kept[0];
}

function resolveSourcePath(path: string, context: TemplateContext): unknown {
  if (path.startsWith("facts.")) return resolvePath(context.facts, path.slice("facts.".length));
  if (path.startsWith("live.")) return resolvePath(context.live, path.slice("live.".length));
  if (path.startsWith("session.")) return resolvePath(context.session, path.slice("session.".length));
  return resolvePath(context.facts, path);
}

/**
 * The filter's answer for one element, without needing a full `EvalContext`.
 * A spec filter may not contain a window or a sequence (validation rejects
 * both), so `matches` never needs the event stream here.
 */
function matchesElement(filter: When, element: unknown): boolean {
  return matches(filter, element);
}

/* ── A `known` predicate built from the catalogue ───────────────────────── */

/**
 * Answer "is this path a real field?" for a report template.
 *
 * Two different questions, and a template asks both:
 *
 *   `facts.commands.failed`        → a path in the catalogue (or `live.*`)
 *   `vars.row.durationMs`          → a field on the *elements of this section's
 *                                    source*, which is why the section is needed
 *
 * `live.elapsedSeconds` and `live.stalledSeconds` are derived by `withLive` and
 * are therefore absent from a bare `live: {}` — but they are real, so they are
 * listed here. Anything the catalogue does not know returns `undefined`, which
 * the caller reads as "cannot say", never as "wrong".
 */
export function knownFieldFor(): (path: string, source: string | undefined) => boolean {
  return (path: string, source: string | undefined): boolean => {
    if (path.startsWith("vars.")) {
      const rest = path.slice("vars.".length);
      if (rest === "row") return true;
      if (rest.startsWith("row.")) {
        const field = rest.slice("row.".length).split(".")[0] ?? "";
        if (source === undefined) return true;
        const fields = sourceFields(source);
        // An unknown source: cannot say. A known scalar array: `row` is a
        // string, so any `row.<field>` is a mistake.
        if (fields === undefined) return true;
        return fields.some((info) => info.path === field);
      }
      return REPORT_VARS.includes(rest.split(".")[0] as (typeof REPORT_VARS)[number]);
    }
    if (path.startsWith("live.")) {
      const rest = path.slice("live.".length);
      const known = LIVE_FIELDS.some((info) => info.path === path);
      // Derived by `withLive`, so they are real even with an empty `live`.
      return known || rest === "elapsedSeconds" || rest === "stalledSeconds";
    }
    if (path.startsWith("facts.")) {
      return allFields().some((info) => info.path === path);
    }
    return false;
  };
}
