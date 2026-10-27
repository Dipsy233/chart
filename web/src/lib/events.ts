/**
 * Building and editing an event stream by hand.
 *
 * The editor needs to answer "what if the agent had done *this*?" — so an event
 * is a form, not a blob of JSON. Each type gets a payload template with the
 * fields that matter, and the raw JSON stays one click away for anything the
 * template does not cover.
 */

import { EVENT_FIELDS } from "../../../src/editor/catalog.ts";
import type { ChartEvent, ChartEventPayloadMap, ChartEventType } from "../../../src/core/events.ts";

let counter = 0;

export function resetEventIds(): void {
  counter = 0;
}

/** A plausible payload for a new event of this type. */
export function defaultPayload(type: ChartEventType): unknown {
  switch (type) {
    case "agent_start":
      return { model: "qwen3-4b" };
    case "agent_end":
      return { reason: "completed" };
    case "message":
      return { role: "assistant", content: "" };
    case "thinking":
      return { content: "" };
    case "tool_start":
      return { toolCallId: `call_${++counter}`, toolName: "bash", args: { command: "" } };
    case "tool_update":
      return { toolCallId: "call_1", toolName: "bash", partial: {} };
    case "tool_end":
      return { toolCallId: "call_1", toolName: "bash", isError: false };
    case "file_read":
      return { path: "src/index.ts", startLine: 1, endLine: 20, content: "" };
    case "file_write":
      return { path: "src/new.ts", content: "" };
    case "file_edit":
      return { path: "src/index.ts", before: "", after: "", diff: "--- a\n+++ b\n" };
    case "file_change":
      return { path: "src/index.ts", kind: "modified" };
    case "command":
      return { command: "", stdout: "", stderr: "", exitCode: 0 };
    case "search":
      return { tool: "grep", query: "", matches: 1 };
    case "process":
      return {
        pid: 1000 + counter,
        name: "node",
        commandLine: "node script.mjs",
        status: "running",
        startedAt: Date.now(),
        children: 0,
        kind: "primary",
      };
    case "approval":
      return {
        id: `ap_${++counter}`,
        kind: "command",
        title: "Allow command?",
        detail: "",
        options: [
          { value: "accept", label: "Yes" },
          { value: "decline", label: "No" },
        ],
      };
    case "mcp":
      return { server: "filesystem", tool: "list_directory", toolName: "mcp__filesystem__list_directory", toolCallId: "call_1", isError: false };
    case "error":
      return { message: "model returned 500" };
  }
}

/** Append a new event after `at`, keeping ids unique. */
export function newEvent(type: ChartEventType, at: number, sessionId = "draft"): ChartEvent {
  return {
    id: `evt_${++counter}`,
    sessionId,
    timestamp: at,
    type,
    payload: defaultPayload(type),
  } as ChartEvent;
}

/** Re-stamp every event with a fixed step, so the stream reads as a timeline. */
export function restamp(events: readonly ChartEvent[], stepMs = 5_000, start = Date.now() - events.length * stepMs): ChartEvent[] {
  return events.map((event, index) => ({ ...event, timestamp: start + index * stepMs }));
}

/** Shift every event so the first one is `firstAt`. */
export function shiftTo(events: readonly ChartEvent[], firstAt: number): ChartEvent[] {
  const first = events[0]?.timestamp ?? 0;
  const delta = firstAt - first;
  return events.map((event) => ({ ...event, timestamp: event.timestamp + delta }));
}

/** Renumber ids in stream order, so the editor's evidence links stay readable. */
export function renumber(events: readonly ChartEvent[]): ChartEvent[] {
  counter = 0;
  return events.map((event) => ({ ...event, id: `evt_${++counter}` }));
}

/* ── path helpers for the payload form ──────────────────────────────────── */

export function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[Number(key)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Immutably set a dot path on a payload. */
export function setPath(root: unknown, path: string, value: unknown): unknown {
  const keys = path.split(".");
  const [head, ...rest] = keys;
  const base: Record<string, unknown> =
    root && typeof root === "object" && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {};
  if (head === undefined) return base;
  if (rest.length === 0) {
    base[head] = value;
    return base;
  }
  base[head] = setPath(base[head], rest.join("."), value);
  return base;
}

/** The editable fields for a type, from the catalogue. */
export function fieldsFor(type: ChartEventType) {
  return EVENT_FIELDS[type] ?? [];
}

export type { ChartEvent, ChartEventType, ChartEventPayloadMap };

/* ── one-line summaries for the compact cards ──────────────────────────── */

function firstLine(text: string | undefined): string {
  if (!text) return "";
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

/** What the card shows on its one line. */
export function eventSummary(event: ChartEvent): string {
  switch (event.type) {
    case "agent_start":
      return event.payload.model || "代理启动";
    case "agent_end":
      return `结束 · ${event.payload.reason}`;
    case "message":
      return `${event.payload.role}: ${firstLine(event.payload.content) || "(空消息)"}`;
    case "thinking":
      return firstLine(event.payload.content) || "(思考)";
    case "tool_start":
      return `${event.payload.toolName} 开始`;
    case "tool_update":
      return `${event.payload.toolName} 输出中`;
    case "tool_end":
      return `${event.payload.toolName} 结束${event.payload.isError ? " · 出错" : ""}`;
    case "file_read":
      return event.payload.path;
    case "file_write":
      return event.payload.path;
    case "file_edit":
      return event.payload.path;
    case "file_change":
      return event.payload.path;
    case "command":
      return event.payload.command || "(空命令)";
    case "search":
      return `${event.payload.tool} ${event.payload.query}`;
    case "process":
      return `${event.payload.name} · PID ${event.payload.pid}`;
    case "approval":
      return event.payload.title || event.payload.kind;
    case "mcp":
      return `${event.payload.server} · ${event.payload.tool}`;
    case "error":
      return event.payload.message || "错误";
  }
}

/** The quiet second line: an outcome, a range, a status. */
export function eventMeta(event: ChartEvent): string {
  switch (event.type) {
    case "command":
      return event.payload.exitCode === 0 ? "成功" : `退出码 ${event.payload.exitCode}`;
    case "file_read":
      return `第 ${event.payload.startLine}–${event.payload.endLine} 行`;
    case "file_change":
      return `${event.payload.kind}${event.payload.outside ? " · 项目外" : ""}`;
    case "file_write":
      return `${event.payload.content.split("\n").length} 行`;
    case "search":
      return `${event.payload.matches} 处命中`;
    case "process":
      return `${event.payload.status === "running" ? "运行中" : "已退出"}${event.payload.kind === "tool" ? " · 辅助" : ""}`;
    case "mcp":
      return event.payload.isError ? "失败" : "成功";
    case "tool_end":
      return event.payload.isError ? "失败" : "成功";
    default:
      return "";
  }
}
