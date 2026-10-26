/**
 * Runs — the unit Chart judges.
 *
 * A driven runtime opens a run with the user's message and closes it with
 * `agent_end`. An *observed* agent (Absence's case) never receives a message
 * from us, so the oldest activity after the last run opens it instead. Both
 * shapes are handled here, and the grouping is a pure function of the stream so
 * a replay groups identically.
 */

import type { ChartEvent, ChartEventType } from "../core/events.ts";
import type { Run, RunStatus } from "../core/types.ts";

/** Events that can open a run in a session nobody prompts. */
const OBSERVED_OPENINGS: ReadonlySet<ChartEventType> = new Set<ChartEventType>([
  "process",
  "file_change",
  "file_write",
  "file_edit",
  "file_read",
  "command",
  "search",
  "mcp",
  "tool_start",
  "thinking",
]);

/** Whether this window has no driven-runtime marker, so runs open from activity. */
export function isObservedStream(events: readonly ChartEvent[]): boolean {
  for (const event of events) {
    if (event.type === "agent_start") return false;
    if (event.type === "message" && event.payload.role === "user") return false;
  }
  return events.length > 0;
}

/**
 * Split the stream into runs. A new user message before `agent_end` marks the
 * previous run `interrupted`. `fromIndex`/`toIndex` are inclusive indices into
 * `events`.
 */
export function deriveRuns(events: readonly ChartEvent[]): Run[] {
  const runs: Run[] = [];
  const observed = isObservedStream(events);
  let start: { from: number; startedAt: number } | null = null;

  const flush = (toIndex: number, endedAt: number | undefined, status: RunStatus) => {
    if (!start) return;
    runs.push({
      id: `run_${runs.length + 1}`,
      startedAt: start.startedAt,
      endedAt,
      ...(endedAt !== undefined ? { durationMs: Math.max(0, endedAt - start.startedAt) } : {}),
      status,
      fromIndex: start.from,
      toIndex,
    });
    start = null;
  };

  /** Whether the open run has done anything beyond its opening marker. */
  const hasActivity = (from: number, until: number): boolean =>
    events.slice(from, until).some((candidate) => candidate.type !== "agent_start");

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "message" && event.payload.role === "user") {
      // A prompt that arrives right after the runtime's own `agent_start` is
      // the same run, not a new one: adapters differ on which event they emit
      // first, and a phantom `run_1` would make every report misnumbered.
      if (start && hasActivity(start.from, i)) flush(i - 1, undefined, "interrupted");
      start = { from: i, startedAt: event.timestamp };
      continue;
    }
    // A driven runtime's own marker opens the run too, so a stream that starts
    // at `agent_start` (no user prompt in the window) still has a run to judge.
    if (event.type === "agent_start" && !start) {
      start = { from: i, startedAt: event.timestamp };
      continue;
    }
    if (observed && !start && OBSERVED_OPENINGS.has(event.type)) {
      start = { from: i, startedAt: event.timestamp };
      continue;
    }
    if (event.type === "agent_end" && start) {
      const reason = String(event.payload.reason);
      flush(
        i,
        event.timestamp,
        reason === "aborted" ? "interrupted" : reason === "error" ? "error" : "completed",
      );
    }
  }

  if (start) flush(events.length - 1, undefined, "running");
  return runs;
}

/** The selected run, falling back to the newest. */
export function pickRun(runs: readonly Run[], selectedId?: string): Run | undefined {
  if (selectedId) {
    const found = runs.find((run) => run.id === selectedId);
    if (found) return found;
  }
  return runs[runs.length - 1];
}
