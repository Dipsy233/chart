/**
 * The classic Absence report, written as data.
 *
 * This spec exists to prove a claim, and it is worth being explicit about which
 * one: **every section of the shipped report is expressible as a spec.** The
 * original layout lived in a 1300-line module whose order, wording and
 * thresholds were code. Here the same document is a list of sections, which
 * means a user can fork it, reorder it, drop a section, or filter a table to
 * `company/**` — without touching a renderer.
 *
 * The sections, in the order the classic report reads them:
 *
 *   outcome + headline      header + verdict
 *   world line              timeline
 *   knows                   list × 2 (reads, searches)
 *   changes                 stats + list × 4 (modified/created/deleted/observed)
 *   executions              table
 *   MCP                     table
 *   outside the project     table
 *   human attention         findings
 *   response                text
 *
 * Two things this spec does *not* do, deliberately:
 *
 *   · it does not compute the headline — `vars.headline` arrives already derived
 *     from the facts, because a report may phrase a judgement but must not make
 *     one;
 *   · it does not style anything. `width`, `style` and section kinds are hints;
 *     the host owns typography (see `docs/REPORTS.md`).
 */

import type { ReportSpec } from "./spec.ts";

export const CLASSIC_REPORT: ReportSpec = {
  id: "classic",
  title: "{{facts.run.id}} · {{vars.outcome}}",
  description:
    "The original report: what the run touched, ran, learned and left behind, then what needs a look.",
  for: "settled",
  sections: [
    {
      kind: "header",
      title: "{{vars.outcome}}",
      subtitle: "{{vars.headline}} · {{facts.run.durationMs|duration}}",
    },
    { kind: "verdict", showFindings: false },

    { kind: "timeline", title: "World line", limit: 40, empty: "Nothing happened." },

    {
      kind: "list",
      title: "Read",
      source: "facts.knowledge.reads",
      item: "{{vars.row.path}} ({{vars.row.startLine}}–{{vars.row.endLine}})",
      evidence: "evidence",
      limit: 40,
      empty: "Nothing inspected.",
    },
    {
      kind: "list",
      title: "Searched",
      source: "facts.knowledge.searches",
      item: "{{vars.row.tool}} “{{vars.row.query}}” · {{vars.row.matches}} hits",
      evidence: "evidence",
      limit: 40,
    },

    {
      kind: "stats",
      title: "Changes",
      rows: [
        {
          label: "+/− changed",
          value: "{{facts.files.created|count}} created · {{facts.files.modified|count}} modified",
        },
        { label: "observed", value: "{{facts.files.observed|count}}" },
        { label: "deleted", value: "{{facts.files.deleted|count}}" },
        { label: "lines", value: "+{{facts.changes.additions}} / −{{facts.changes.deletions}}" },
      ],
    },
    {
      kind: "list",
      title: "Modified",
      source: "facts.files.byPath",
      // `files.byPath` is an object keyed by path, so the filter is what turns
      // it into "the modified ones" — the classic report's four subsections.
      filter: { conditions: [{ field: "agentEdit", op: "eq", value: true }] },
      item: "{{vars.row.path}} · +{{vars.row.additions}} / −{{vars.row.deletions}}",
      evidence: "evidence",
      limit: 60,
    },
    {
      kind: "list",
      title: "Created",
      source: "facts.files.byPath",
      filter: { conditions: [{ field: "agentWrite", op: "eq", value: true }] },
      item: "{{vars.row.path}} · +{{vars.row.additions}}",
      evidence: "evidence",
      limit: 60,
    },
    {
      kind: "list",
      title: "Observed",
      source: "facts.files.byPath",
      filter: { conditions: [{ field: "externalChange", op: "eq", value: true }] },
      item: "{{vars.row.path}}",
      evidence: "evidence",
      limit: 60,
    },

    {
      kind: "table",
      title: "Executions",
      source: "facts.commandFacts",
      columns: [
        { header: "command", cell: "{{vars.row.command}}", width: "wide" },
        { header: "status", cell: "{{vars.row.status}}", width: "narrow" },
        { header: "exit", cell: "{{vars.row.exitCode}}", width: "narrow" },
        { header: "took", cell: "{{vars.row.durationMs|duration}}", width: "narrow" },
      ],
      evidence: "evidence",
      limit: 60,
      empty: "No commands run.",
    },

    {
      kind: "table",
      title: "MCP",
      source: "facts.mcp.servers",
      columns: [
        { header: "server", cell: "{{vars.row.server}}", width: "narrow" },
        { header: "calls", cell: "{{vars.row.calls}}", width: "narrow" },
        { header: "failed", cell: "{{vars.row.failed}}", width: "narrow" },
        { header: "tools", cell: "{{vars.row.tools|join: \", \"}}", width: "wide" },
      ],
      evidence: "evidence",
      limit: 20,
    },

    {
      kind: "table",
      title: "Outside the project",
      source: "facts.outsideChanges",
      columns: [
        { header: "path", cell: "{{vars.row.path}}", width: "wide" },
        { header: "times", cell: "{{vars.row.count}}", width: "narrow" },
      ],
      evidence: "evidence",
      limit: 20,
    },

    { kind: "findings", title: "Human attention", minLevel: "low", limit: 30, empty: "Agent is working normally." },

    { kind: "text", title: "Response", source: "facts.response", empty: "(no reply)" },
  ],
};
