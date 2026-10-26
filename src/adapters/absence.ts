/**
 * The Absence adapter — the only file that knows where the events come from.
 *
 * Chart's `ChartEvent` mirrors Absence's `AbsenceEvent` on purpose, so this is
 * mostly a structural copy plus a few defensive defaults. It imports nothing:
 * pass in anything with the same shape and it works. That keeps Chart usable
 * from a browser bundle, a Node process, or a test fixture with no Absence
 * checkout in sight.
 */

import type { ChartEvent, ChartEventPayloadMap, ChartEventType } from "../core/events.ts";

/** The minimum an Absence event has to look like for `toChartEvent` to accept it. */
export interface AbsenceLikeEvent {
  id: string;
  sessionId: string;
  timestamp: number;
  type: string;
  payload: unknown;
}

const KNOWN: ReadonlySet<string> = new Set<string>([
  "agent_start",
  "agent_end",
  "message",
  "thinking",
  "tool_start",
  "tool_update",
  "tool_end",
  "file_read",
  "file_write",
  "file_edit",
  "file_change",
  "command",
  "search",
  "process",
  "approval",
  "mcp",
  "error",
]);

/** Whether this looks like an Absence event Chart can consume. */
export function isAbsenceEvent(value: unknown): value is AbsenceLikeEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AbsenceLikeEvent>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.timestamp === "number" &&
    typeof candidate.type === "string" &&
    KNOWN.has(candidate.type) &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

/** Convert one Absence event. Throws on an unknown type rather than guessing. */
export function toChartEvent(event: AbsenceLikeEvent): ChartEvent {
  const candidate: AbsenceLikeEvent | undefined = event;
  if (!isAbsenceEvent(candidate)) {
    throw new Error(`not an Absence event: ${String((candidate as { type?: unknown })?.type)}`);
  }
  return {
    id: candidate.id,
    sessionId: candidate.sessionId,
    timestamp: candidate.timestamp,
    type: candidate.type as ChartEventType,
    payload: normalizePayload(candidate.type as ChartEventType, candidate.payload as Record<string, unknown>),
  } as ChartEvent;
}

/** Convert a stream, dropping events Chart does not understand. */
export function toChartEvents(events: readonly AbsenceLikeEvent[]): ChartEvent[] {
  const out: ChartEvent[] = [];
  for (const event of events) {
    if (!isAbsenceEvent(event)) continue;
    out.push(toChartEvent(event));
  }
  return out;
}

/**
 * Absence's adapters are not perfectly uniform: a `process` event may omit
 * `children`, a `command` may omit `stderr`, an old archive may lack
 * `sessionId`. Fill only what a reduction actually reads, and leave everything
 * else exactly as it came — a fact layer that quietly invents data is worse
 * than one that crashes.
 */
function normalizePayload(type: ChartEventType, payload: Record<string, unknown>): ChartEventPayloadMap[ChartEventType] {
  switch (type) {
    case "process":
      return {
        ...payload,
        children: typeof payload.children === "number" ? payload.children : 0,
        status: payload.status === "exited" ? "exited" : "running",
        startedAt: typeof payload.startedAt === "number" ? payload.startedAt : 0,
      } as unknown as ChartEventPayloadMap["process"];
    case "command":
      return {
        ...payload,
        stdout: typeof payload.stdout === "string" ? payload.stdout : "",
        stderr: typeof payload.stderr === "string" ? payload.stderr : "",
        exitCode: typeof payload.exitCode === "number" ? payload.exitCode : 0,
      } as unknown as ChartEventPayloadMap["command"];
    case "file_read":
      return {
        ...payload,
        content: typeof payload.content === "string" ? payload.content : "",
        startLine: typeof payload.startLine === "number" ? payload.startLine : 1,
        endLine: typeof payload.endLine === "number" ? payload.endLine : 1,
      } as unknown as ChartEventPayloadMap["file_read"];
    case "search":
      return {
        ...payload,
        matches: typeof payload.matches === "number" ? payload.matches : 0,
      } as unknown as ChartEventPayloadMap["search"];
    default:
      return payload as unknown as ChartEventPayloadMap[ChartEventType];
  }
}
