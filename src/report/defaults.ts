/**
 * The two reports Chart ships with: one for a run in flight, one for a run at
 * rest. They are ordinary specs — the same kind a user writes — so there is no
 * "built-in layout" the custom ones cannot reach.
 */

import type { ReportSpec } from "./spec.ts";

export const LIVE_REPORT: ReportSpec = {
  id: "live",
  title: "{{facts.run.id}} · live",
  description: "What the run is doing right now, and what is worth a look.",
  for: "live",
  sections: [
    {
      kind: "header",
      title: "{{facts.run.id}} · {{facts.run.status}}",
      subtitle: "{{vars.headline}}",
    },
    { kind: "verdict", showFindings: false },
    { kind: "findings", minLevel: "low", limit: 12, empty: "Nothing needs a look." },
    {
      kind: "stats",
      rows: [
        { label: "elapsed", value: "{{live.elapsedSeconds|secs}}" },
        { label: "phase", value: "{{facts.currentPhase}}" },
        { label: "commands", value: "{{facts.commands.total}} ({{facts.commands.failed}} failed)" },
        { label: "files", value: "{{facts.files.created|count}} created · {{facts.files.modified|count}} modified" },
        { label: "files read", value: "{{facts.counts.reads}}" },
        { label: "idle", value: "{{live.stalledSeconds|secs}}" },
      ],
    },
  ],
};

export const SETTLED_REPORT: ReportSpec = {
  id: "settled",
  title: "{{facts.run.id}} · {{vars.outcome}}",
  description: "The full account of a finished run: what it touched, ran, left behind, and what needs a look.",
  for: "settled",
  sections: [
    {
      kind: "header",
      title: "{{facts.run.id}} · {{vars.outcome}}",
      subtitle: "{{vars.headline}}",
    },
    { kind: "verdict", showFindings: false },
    { kind: "findings", minLevel: "low", limit: 30, empty: "Nothing needs a look." },
    {
      kind: "stats",
      rows: [
        { label: "duration", value: "{{facts.run.durationMs|duration}}" },
        { label: "commands", value: "{{facts.commands.succeeded}} ok / {{facts.commands.failed}} failed / {{facts.commands.unknown}} unknown" },
        { label: "files", value: "{{facts.files.created|count}} created · {{facts.files.modified|count}} modified · {{facts.files.deleted|count}} deleted" },
        { label: "lines", value: "+{{facts.changes.additions}} −{{facts.changes.deletions}}" },
        { label: "mcp", value: "{{facts.mcp.calls}} calls · {{facts.mcp.failed}} failed" },
        { label: "processes", value: "{{facts.processes.primary|count}} laid · {{facts.processes.runningAtEnd|count}} still running" },
      ],
    },
    {
      kind: "table",
      title: "Commands",
      source: "facts.commandFacts",
      columns: [
        { header: "command", cell: "{{vars.row.command|short}}", width: "wide" },
        { header: "status", cell: "{{vars.row.status}}", width: "narrow" },
        { header: "exit", cell: "{{vars.row.exitCode}}", width: "narrow" },
        { header: "took", cell: "{{vars.row.durationMs|duration}}", width: "narrow" },
      ],
      limit: 60,
      empty: "No commands were run.",
    },
    {
      kind: "table",
      title: "Files",
      source: "facts.files.byPath",
      columns: [
        { header: "path", cell: "{{vars.row.path}}", width: "wide" },
        { header: "how", cell: "{{vars.row.agentWrite|flag:write}}{{vars.row.agentEdit|flag:edit}}{{vars.row.externalChange|flag:external}}{{vars.row.read|flag:read}}", width: "narrow" },
        { header: "+/−", cell: "+{{vars.row.additions}} −{{vars.row.deletions}}", width: "narrow" },
      ],
      limit: 80,
      empty: "No files were touched.",
    },
    {
      kind: "table",
      title: "Processes",
      source: "facts.processes.primary",
      columns: [
        { header: "name", cell: "{{vars.row.name}}", width: "narrow" },
        { header: "pid", cell: "{{vars.row.pid}}", width: "narrow" },
        { header: "lived", cell: "{{vars.row.lifetimeMs|duration}}", width: "narrow" },
        { header: "state", cell: "{{vars.row.running|bool:running,stopped}}", width: "narrow" },
      ],
      limit: 40,
      empty: "The agent laid no processes.",
    },
    {
      kind: "table",
      title: "What the agent learned",
      source: "facts.knowledge.reads",
      columns: [
        { header: "path", cell: "{{vars.row.path}}", width: "wide" },
        { header: "lines", cell: "{{vars.row.startLine}}–{{vars.row.endLine}}", width: "narrow" },
      ],
      limit: 40,
      empty: "The agent read nothing.",
    },
    { kind: "timeline", title: "World line", limit: 40, empty: "Nothing happened." },
    { kind: "evidence", title: "Evidence", limit: 200 },
  ],
};

export const DEFAULT_REPORTS: ReportSpec[] = [LIVE_REPORT, SETTLED_REPORT];
