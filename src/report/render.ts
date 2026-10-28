/**
 * Render a report spec against a run.
 *
 * Pure: `(spec, context) → RenderedReport`. No host, no styling, no HTML. The
 * same spec renders the same document for the same facts, which is what lets a
 * user iterate on a report and diff two runs' output.
 */

import type { Attention, Facts, LiveContext } from "../core/types.ts";
import { LEVEL_RANK } from "../core/types.ts";
import { matches, resolvePath, type When } from "../regimen/predicate.ts";
import { renderTemplate, formatDuration, shortenPath } from "../regimen/template.ts";
import type { ReportSection, ReportSpec, RenderedReport, RenderedSection } from "./spec.ts";
import { deriveOutcome, outcomeHeadline } from "./verdict.ts";

export interface RenderContext {
  facts: Facts;
  attention: Attention;
  live?: LiveContext;
  session?: { id?: string; project?: string };
  /** Provenance of the verdict, passed through to `RenderedReport.judgedBy`. */
  judgedBy?: RenderedReport["judgedBy"];
}

const MAX_ROWS = 500;

export function renderReport(spec: ReportSpec, context: RenderContext): RenderedReport {
  const outcome = deriveOutcome(context.facts);
  const sections = spec.sections
    .map((section) => renderSection(section, context, outcome))
    .filter((section): section is RenderedSection => section !== undefined);

  return {
    id: spec.id,
    title: renderTemplate(spec.title, baseContext(context, outcome)),
    sections,
    ...(context.judgedBy ? { judgedBy: context.judgedBy } : {}),
  };
}

function baseContext(context: RenderContext, outcome: string) {
  return {
    facts: context.facts,
    live: context.live ?? {},
    session: context.session ?? {},
    vars: { outcome, headline: outcomeHeadline(context.facts, outcome as never) },
  };
}

function renderSection(
  section: ReportSection,
  context: RenderContext,
  outcome: string,
): RenderedSection | undefined {
  const base = baseContext(context, outcome);
  const facts = context.facts;

  switch (section.kind) {
    case "header":
      return {
        kind: "header",
        title: renderTemplate(section.title, base),
        ...(section.subtitle ? { subtitle: renderTemplate(section.subtitle, base) } : {}),
      };

    case "verdict":
      return {
        kind: "verdict",
        level: context.attention.level,
        outcome,
        reasons: context.attention.reasons,
        findings: (section.showFindings === false ? [] : context.attention.findings).map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.level,
          title: finding.title,
          ...(finding.detail ? { detail: finding.detail } : {}),
        })),
      };

    case "findings": {
      const minLevel = section.minLevel ?? "low";
      const tags = section.tags ?? [];
      const findings = context.attention.findings
        .filter((finding) => LEVEL_RANK[finding.level] >= LEVEL_RANK[minLevel])
        .filter((finding) => tags.length === 0 || finding.tags.some((tag) => tags.includes(tag)))
        // A filter reads the finding itself, so "only the ones about commands"
        // is `{ field: "tags", op: "contains", value: "commands" }`.
        .filter((finding) => !section.filter || matches(section.filter, finding))
        .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.at - a.at)
        .slice(0, section.limit ?? 50)
        .map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.level,
          title: renderTemplate(finding.title, base),
          ...(finding.detail ? { detail: renderTemplate(finding.detail, base) } : {}),
          tags: finding.tags,
          evidence: finding.evidence,
        }));
      return {
        kind: "findings",
        title: section.title ? renderTemplate(section.title, base) : "Findings",
        findings,
        ...(section.empty ? { empty: section.empty } : {}),
      };
    }

    case "stats":
      return {
        kind: "stats",
        ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
        rows: section.rows.map((row) => ({
          label: row.label,
          value: renderTemplate(row.value, base),
        })),
      };

    case "table": {
      const all = rows(section.source, section.filter, base);
      const sorted = section.sort ? sortRows(all, section.sort) : all;
      const kept = sorted.slice(0, section.limit ?? MAX_ROWS);
      return {
        kind: "table",
        ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
        columns: section.columns.map((column) => ({
          header: column.header,
          ...(column.width ? { width: column.width } : {}),
        })),
        rows: kept.map((row) =>
          section.columns.map((column) =>
            renderTemplate(column.cell, { ...base, vars: { ...base.vars, row } }),
          ),
        ),
        ...evidenceFor(section.evidence, kept),
        ...(section.empty ? { empty: section.empty } : {}),
      };
    }

    case "list": {
      const kept = rows(section.source, section.filter, base).slice(0, section.limit ?? MAX_ROWS);
      return {
        kind: "list",
        ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
        items: kept.map((row) => renderTemplate(section.item, { ...base, vars: { ...base.vars, row } })),
        ...evidenceFor(section.evidence, kept),
        ...(section.empty ? { empty: section.empty } : {}),
      };
    }

    case "text": {
      const value = resolveInContext(section.source, base);
      // A string renders as one paragraph; an array renders with `item` per
      // element, which is how the transcript becomes a list of lines.
      if (typeof value === "string") {
        return {
          kind: "text",
          ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
          text: renderTemplate(value, base),
          items: [],
          ...(section.style ? { style: section.style } : {}),
          ...(section.empty ? { empty: section.empty } : {}),
        };
      }
      const kept = rows(section.source, section.filter, base).slice(0, section.limit ?? MAX_ROWS);
      const item = section.item ?? "{{vars.row}}";
      return {
        kind: "text",
        ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
        items: kept.map((row) => renderTemplate(item, { ...base, vars: { ...base.vars, row } })),
        ...evidenceFor(section.evidence, kept),
        ...(section.style ? { style: section.style } : {}),
        ...(section.empty ? { empty: section.empty } : {}),
      };
    }

    case "timeline": {
      const nodes = facts.timeline.slice(-(section.limit ?? 40));
      return {
        kind: "timeline",
        ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
        nodes: nodes.map((node) => ({
          action: node.action,
          subject: node.subject,
          offsetMs: node.offsetMs,
          effects: node.effects,
          eventId: node.eventId,
        })),
        ...(section.empty ? { empty: section.empty } : {}),
      };
    }

    case "evidence":
      return {
        kind: "evidence",
        ...(section.title ? { title: renderTemplate(section.title, base) } : {}),
        ids: facts.evidence.slice(-(section.limit ?? 200)),
      };
  }
}

/** `facts.x`, `live.y`, `session.z`, or a bare `vars` path. */
function resolveInContext(path: string, base: ReturnType<typeof baseContext>): unknown {
  if (path.startsWith("facts.")) return resolvePath(base.facts, path.slice("facts.".length));
  if (path.startsWith("live.")) return resolvePath(base.live, path.slice("live.".length));
  if (path.startsWith("session.")) return resolvePath(base.session, path.slice("session.".length));
  return resolvePath(base.facts, path);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}

/**
 * The elements a `table` / `list` / `text` section renders: the source array,
 * narrowed by the section's `filter`.
 *
 * The filter is evaluated with the same `matches()` a rule uses, against the
 * element itself — so `{ field: "path", op: "glob", value: "company/**" }`
 * means in a report exactly what it means in a rule. Filtering happens before
 * `sort` and `limit` so a report can say "the 10 biggest of the files under X".
 */
function rows(source: string, filter: When | undefined, base: ReturnType<typeof baseContext>): unknown[] {
  const all = asArray(resolveInContext(source, base));
  if (!filter) return all;
  return all.filter((element) => matches(filter, element));
}

/**
 * The per-row evidence a section asked for, resolved from each kept element.
 *
 * A row that cannot produce ids is dropped from the list rather than given a
 * made-up one: a report must never link a claim to an event that is not the
 * evidence for it. `rows` and `evidence` are index-aligned for the host.
 */
function evidenceFor(
  path: string | undefined,
  kept: unknown[],
): { evidence?: string[][] } {
  if (!path) return {};
  return { evidence: kept.map((row) => evidenceIds(resolvePath(row, path))) };
}

function evidenceIds(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(evidenceIds);
  return [];
}

function sortRows(rows: unknown[], sort: { field: string; direction: "asc" | "desc" }): unknown[] {
  const direction = sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = resolvePath(a, sort.field);
    const right = resolvePath(b, sort.field);
    if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
    return String(left ?? "").localeCompare(String(right ?? "")) * direction;
  });
}

/* ── Helpers a host may want ────────────────────────────────────────────── */

/** Render a report as plain text — useful for CLI output and for tests. */
export function renderText(report: RenderedReport): string {
  const lines: string[] = [];
  for (const section of report.sections) {
    switch (section.kind) {
      case "header":
        lines.push(section.title);
        if (section.subtitle) lines.push(section.subtitle);
        break;
      case "verdict":
        lines.push(`[${section.level.toUpperCase()}] ${section.outcome}`);
        for (const finding of section.findings) lines.push(`  · ${finding.title}`);
        break;
      case "findings":
        lines.push(`${section.title}:`);
        if (section.findings.length === 0 && section.empty) lines.push(`  ${section.empty}`);
        for (const finding of section.findings) {
          lines.push(`  ${finding.level.toUpperCase()} ${finding.title}`);
          if (finding.detail) lines.push(`      ${finding.detail}`);
        }
        break;
      case "stats":
        if (section.title) lines.push(`${section.title}:`);
        for (const row of section.rows) lines.push(`  ${row.label}: ${row.value}`);
        break;
      case "table":
        if (section.title) lines.push(`${section.title}:`);
        if (section.rows.length === 0 && section.empty) lines.push(`  ${section.empty}`);
        lines.push(`  ${section.columns.map((column) => column.header).join(" | ")}`);
        for (const row of section.rows) lines.push(`  ${row.join(" | ")}`);
        break;
      case "list":
        if (section.title) lines.push(`${section.title}:`);
        if (section.items.length === 0 && section.empty) lines.push(`  ${section.empty}`);
        for (const item of section.items) lines.push(`  · ${item}`);
        break;
      case "text":
        if (section.title) lines.push(`${section.title}:`);
        if (section.text !== undefined) lines.push(section.text);
        if (section.items.length === 0 && section.text === undefined && section.empty) {
          lines.push(`  ${section.empty}`);
        }
        for (const item of section.items) lines.push(`  ${item}`);
        break;
      case "timeline":
        if (section.title) lines.push(`${section.title}:`);
        for (const node of section.nodes) {
          lines.push(`  ${formatDuration(node.offsetMs).padStart(6)} ${node.action.padEnd(8)} ${node.subject}`);
        }
        break;
      case "evidence":
        lines.push(`${section.title ?? "Evidence"}: ${section.ids.length} events`);
        break;
    }
  }
  return lines.join("\n");
}

export { formatDuration, shortenPath };
