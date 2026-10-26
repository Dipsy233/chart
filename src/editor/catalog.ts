/**
 * The catalogue — every path a rule may address, with a type and a label.
 *
 * This is what makes "the user picks the conditions themselves" real: an editor
 * needs to offer a list of fields, not ask the user to memorise `facts.commands.failed`.
 * The list is data, and `test/editor.test.ts` walks it against a real `Facts`
 * object so it cannot drift from the fact layer.
 *
 * Nothing here is required by the engine — a rule may address any path it likes.
 * The catalogue is the editor's contract, and a hint for autocomplete.
 */

import type { ChartEventType } from "../core/events.ts";
import type { ValueKind } from "../regimen/predicate.ts";

export interface FieldInfo {
  /** A dot path, e.g. `facts.commands.failed` or `payload.exitCode`. */
  path: string;
  kind: ValueKind;
  /** What the editor shows in the field picker. */
  label: string;
  /** One sentence for a tooltip. */
  hint?: string;
  /** Present only sometimes (e.g. `payload.outside` on a non-outside change). */
  optional?: boolean;
  /** For arrays: what each element looks like, so a `where` can be built. */
  element?: FieldInfo[];
}

export interface EventTypeInfo {
  type: ChartEventType;
  label: string;
  hint?: string;
}

/* ── Facts (the settled aggregates) ─────────────────────────────────────── */

export const FACT_FIELDS: FieldInfo[] = [
  { path: "facts.run.id", kind: "string", label: "run id" },
  { path: "facts.run.status", kind: "string", label: "run status", hint: "running, completed, error or interrupted" },
  { path: "facts.run.durationMs", kind: "number", label: "duration (ms)" },
  { path: "facts.run.startedAt", kind: "dateTime", label: "started at" },
  { path: "facts.run.endedAt", kind: "dateTime", label: "ended at" },
  { path: "facts.ended", kind: "boolean", label: "has the run ended", hint: "settled runs are judged with this true" },

  { path: "facts.commands.total", kind: "number", label: "commands run" },
  { path: "facts.commands.succeeded", kind: "number", label: "commands succeeded" },
  { path: "facts.commands.failed", kind: "number", label: "commands failed" },
  { path: "facts.commands.running", kind: "number", label: "commands still running" },
  { path: "facts.commands.unknown", kind: "number", label: "commands with no outcome" },
  { path: "facts.failed", kind: "array", label: "failed commands", element: [
    { path: "command", kind: "string", label: "command text" },
    { path: "exitCode", kind: "number", label: "exit code" },
    { path: "status", kind: "string", label: "status" },
    { path: "durationMs", kind: "number", label: "took (ms)" },
    { path: "toolName", kind: "string", label: "tool" },
  ] },
  { path: "facts.commandFacts", kind: "array", label: "every command", element: [
    { path: "command", kind: "string", label: "command text" },
    { path: "status", kind: "string", label: "status" },
    { path: "exitCode", kind: "number", label: "exit code" },
  ] },

  { path: "facts.files.read", kind: "array", label: "files read" },
  { path: "facts.files.created", kind: "array", label: "files created" },
  { path: "facts.files.modified", kind: "array", label: "files modified" },
  { path: "facts.files.deleted", kind: "array", label: "files deleted" },
  { path: "facts.files.observed", kind: "array", label: "files changed by something else" },
  { path: "facts.files.byPath", kind: "object", label: "every touched file", element: [
    { path: "path", kind: "string", label: "path" },
    { path: "read", kind: "boolean", label: "was read" },
    { path: "agentWrite", kind: "boolean", label: "agent wrote it" },
    { path: "agentEdit", kind: "boolean", label: "agent edited it" },
    { path: "externalChange", kind: "boolean", label: "changed by something else" },
    { path: "additions", kind: "number", label: "lines added" },
    { path: "deletions", kind: "number", label: "lines removed" },
  ] },

  { path: "facts.changes.additions", kind: "number", label: "lines added" },
  { path: "facts.changes.deletions", kind: "number", label: "lines removed" },
  { path: "facts.counts.reads", kind: "number", label: "reads" },
  { path: "facts.counts.searches", kind: "number", label: "searches" },
  { path: "facts.counts.writes", kind: "number", label: "writes" },
  { path: "facts.counts.edits", kind: "number", label: "edits" },

  { path: "facts.processes.primary", kind: "array", label: "processes the agent laid", element: [
    { path: "name", kind: "string", label: "name" },
    { path: "pid", kind: "number", label: "pid" },
    { path: "commandLine", kind: "string", label: "command line" },
    { path: "command", kind: "string", label: "the shell command that laid it" },
    { path: "kind", kind: "string", label: "primary or tool" },
    { path: "lifetimeMs", kind: "number", label: "lived (ms), measured against the run end" },
    { path: "running", kind: "boolean", label: "still running" },
  ] },
  { path: "facts.processes.runningAtEnd", kind: "array", label: "processes still running at the end", element: [
    { path: "name", kind: "string", label: "name" },
    { path: "pid", kind: "number", label: "pid" },
    { path: "commandLine", kind: "string", label: "command line" },
    { path: "lifetimeMs", kind: "number", label: "lived (ms)" },
  ] },
  { path: "facts.processes.tools", kind: "number", label: "helper processes folded away" },

  { path: "facts.errors.total", kind: "number", label: "error events" },
  { path: "facts.unresolved", kind: "array", label: "unresolved failures", hint: "failures no later success or edit recovered from" },
  { path: "facts.recoveries", kind: "array", label: "recovered failures", element: [
    { path: "failedCommandId", kind: "string", label: "failed command event" },
    { path: "hadEdit", kind: "boolean", label: "recovered by an edit" },
  ] },

  { path: "facts.failureStreak.count", kind: "number", label: "longest run of back-to-back failures" },
  { path: "facts.retries", kind: "array", label: "commands that failed repeatedly", element: [
    { path: "command", kind: "string", label: "command text" },
    { path: "count", kind: "number", label: "how many times it failed" },
  ] },
  { path: "facts.reverts", kind: "array", label: "files that reverted to an earlier version", element: [
    { path: "path", kind: "string", label: "path" },
    { path: "count", kind: "number", label: "how many reverts" },
  ] },
  { path: "facts.outsideChanges", kind: "array", label: "changes outside the project", element: [
    { path: "path", kind: "string", label: "path" },
    { path: "count", kind: "number", label: "how many changes" },
  ] },

  { path: "facts.mcp.calls", kind: "number", label: "MCP calls" },
  { path: "facts.mcp.failed", kind: "number", label: "MCP calls that failed" },
  { path: "facts.knowledge.reads", kind: "array", label: "what the agent read", element: [
    { path: "path", kind: "string", label: "path" },
    { path: "startLine", kind: "number", label: "first line" },
    { path: "endLine", kind: "number", label: "last line" },
  ] },
  { path: "facts.knowledge.searches", kind: "array", label: "what the agent searched", element: [
    { path: "tool", kind: "string", label: "tool" },
    { path: "query", kind: "string", label: "query" },
    { path: "matches", kind: "number", label: "hits" },
  ] },

  { path: "facts.response", kind: "string", label: "the agent's last reply" },
  { path: "facts.currentPhase", kind: "string", label: "current phase" },
  { path: "facts.lastActivityAt", kind: "dateTime", label: "last activity" },
  { path: "facts.evidence", kind: "array", label: "every event id in the run" },
];

/* ── Live context (only present while a run is in flight) ───────────────── */

export const LIVE_FIELDS: FieldInfo[] = [
  { path: "live.nowMs", kind: "dateTime", label: "the clock the host passed" },
  { path: "live.elapsedSeconds", kind: "number", label: "seconds since the run started" },
  { path: "live.stalledSeconds", kind: "number", label: "seconds since the last event" },
  { path: "live.busy", kind: "boolean", label: "the agent is working", hint: "false means it is waiting on the user" },
  { path: "live.status", kind: "string", label: "agent status" },
  { path: "live.metrics.eggs", kind: "array", label: "resource snapshot per process", element: [
    { path: "pid", kind: "number", label: "pid" },
    { path: "name", kind: "string", label: "name" },
    { path: "cpuPercent", kind: "number", label: "CPU %" },
    { path: "cpuSeconds", kind: "number", label: "CPU seconds" },
    { path: "rssBytes", kind: "number", label: "memory (bytes)" },
  ] },
];

/* ── Events (inside a window's `where`) ─────────────────────────────────── */

/** Fields common to every event. */
const COMMON_EVENT_FIELDS: FieldInfo[] = [
  { path: "type", kind: "string", label: "event type" },
  { path: "timestamp", kind: "dateTime", label: "when it happened" },
  { path: "id", kind: "string", label: "event id" },
];

/** Per-type payload fields. */
export const EVENT_FIELDS: Record<ChartEventType, FieldInfo[]> = {
  agent_start: [{ path: "payload.model", kind: "string", label: "model" }],
  agent_end: [{ path: "payload.reason", kind: "string", label: "reason", hint: "completed, aborted or error" }],
  message: [
    { path: "payload.role", kind: "string", label: "role", hint: "user, assistant or system" },
    { path: "payload.content", kind: "string", label: "content" },
  ],
  thinking: [{ path: "payload.content", kind: "string", label: "content" }],
  tool_start: [
    { path: "payload.toolName", kind: "string", label: "tool" },
    { path: "payload.args", kind: "object", label: "arguments" },
  ],
  tool_update: [{ path: "payload.toolName", kind: "string", label: "tool" }],
  tool_end: [
    { path: "payload.toolName", kind: "string", label: "tool" },
    { path: "payload.isError", kind: "boolean", label: "errored" },
  ],
  file_read: [
    { path: "payload.path", kind: "string", label: "path" },
    { path: "payload.startLine", kind: "number", label: "first line" },
    { path: "payload.endLine", kind: "number", label: "last line" },
  ],
  file_write: [
    { path: "payload.path", kind: "string", label: "path" },
    { path: "payload.content", kind: "string", label: "content" },
  ],
  file_edit: [
    { path: "payload.path", kind: "string", label: "path" },
    { path: "payload.diff", kind: "string", label: "diff" },
  ],
  file_change: [
    { path: "payload.path", kind: "string", label: "path" },
    { path: "payload.kind", kind: "string", label: "kind", hint: "created, modified or deleted" },
    { path: "payload.outside", kind: "boolean", label: "outside the project", optional: true },
  ],
  command: [
    { path: "payload.command", kind: "string", label: "command text" },
    { path: "payload.exitCode", kind: "number", label: "exit code" },
    { path: "payload.stdout", kind: "string", label: "stdout" },
    { path: "payload.stderr", kind: "string", label: "stderr" },
  ],
  search: [
    { path: "payload.tool", kind: "string", label: "tool" },
    { path: "payload.query", kind: "string", label: "query" },
    { path: "payload.matches", kind: "number", label: "hits" },
  ],
  process: [
    { path: "payload.name", kind: "string", label: "name" },
    { path: "payload.commandLine", kind: "string", label: "command line" },
    { path: "payload.command", kind: "string", label: "the command that laid it" },
    { path: "payload.status", kind: "string", label: "running or exited" },
    { path: "payload.kind", kind: "string", label: "primary or tool" },
    { path: "payload.children", kind: "number", label: "children" },
  ],
  approval: [
    { path: "payload.kind", kind: "string", label: "kind" },
    { path: "payload.title", kind: "string", label: "title" },
    { path: "payload.detail", kind: "string", label: "detail" },
  ],
  mcp: [
    { path: "payload.server", kind: "string", label: "server" },
    { path: "payload.tool", kind: "string", label: "tool" },
    { path: "payload.isError", kind: "boolean", label: "errored" },
  ],
  error: [{ path: "payload.message", kind: "string", label: "message" }],
};

export const EVENT_TYPES: EventTypeInfo[] = [
  { type: "message", label: "message", hint: "the user's prompt or the agent's reply" },
  { type: "thinking", label: "thinking", hint: "the agent's reasoning" },
  { type: "command", label: "command", hint: "a shell command that reported an exit code" },
  { type: "tool_start", label: "tool start", hint: "a tool call began" },
  { type: "tool_update", label: "tool update", hint: "a tool call streamed partial output" },
  { type: "tool_end", label: "tool end", hint: "a tool call ended; a shell failure appears only here" },
  { type: "file_read", label: "file read" },
  { type: "file_write", label: "file write" },
  { type: "file_edit", label: "file edit" },
  { type: "file_change", label: "file change", hint: "the watcher saw a change on disk" },
  { type: "search", label: "search" },
  { type: "process", label: "process", hint: "a process the agent laid" },
  { type: "mcp", label: "MCP call" },
  { type: "approval", label: "approval", hint: "the runtime is blocked on the user" },
  { type: "error", label: "error" },
  { type: "agent_start", label: "agent start" },
  { type: "agent_end", label: "agent end" },
];

/** The fields an editor should offer for a window over these types. */
export function eventFields(types: string[] | undefined): FieldInfo[] {
  const common = COMMON_EVENT_FIELDS;
  if (!types || types.length === 0) {
    const seen = new Map<string, FieldInfo>();
    for (const fields of Object.values(EVENT_FIELDS)) {
      for (const field of fields) if (!seen.has(field.path)) seen.set(field.path, field);
    }
    return [...common, ...seen.values()];
  }
  const out = [...common];
  const seen = new Set<string>();
  for (const type of types) {
    for (const field of EVENT_FIELDS[type as ChartEventType] ?? []) {
      if (seen.has(field.path)) continue;
      seen.add(field.path);
      out.push(field);
    }
  }
  return out;
}

/** Every field an editor may offer, with its group. */
export function allFields(): Array<FieldInfo & { group: "facts" | "live" }> {
  return [
    ...FACT_FIELDS.map((field) => ({ ...field, group: "facts" as const })),
    ...LIVE_FIELDS.map((field) => ({ ...field, group: "live" as const })),
  ];
}

/** Look up a field by path, for an editor that has to show its type. */
export function fieldFor(path: string): FieldInfo | undefined {
  const direct = allFields().find((field) => field.path === path);
  if (direct) return direct;
  // `facts.processes.runningAtEnd.0.name` → try the element of its parent.
  const parent = path.split(".").slice(0, -1).join(".");
  const info = allFields().find((field) => field.path === parent);
  return info?.element?.find((field) => field.path === path.split(".").pop());
}
