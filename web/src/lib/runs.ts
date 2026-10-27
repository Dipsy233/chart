/**
 * Runs, as the editor sees them.
 *
 * A *run* is one round of events: it opens with a user prompt (or the runtime's
 * own `agent_start`) and closes with `agent_end`. The report panel simulates one
 * run at a time, so this module turns the flat event stream into a list of runs
 * and into "frames" — the prefix of a run revealed so far during playback.
 *
 * A frame is deliberately a real `Run` with a truncated `toIndex` and
 * `status: "running"` when it is not finished: `buildFacts` already understands
 * that shape, so playback judges exactly the same facts a live run would.
 */

import type { ChartEvent } from "../../../src/core/events.ts";
import type { Run, RunStatus } from "../../../src/core/types.ts";
import { deriveRuns } from "../../../src/facts/runs.ts";

export interface RunView {
  run: Run;
  /** 0-based position in the session, for "第 N 轮" labels. */
  index: number;
  eventCount: number;
  slice: ChartEvent[];
}

export function runViews(events: readonly ChartEvent[]): RunView[] {
  return deriveRuns(events).map((run, index) => ({
    run,
    index,
    eventCount: Math.max(0, run.toIndex - run.fromIndex + 1),
    slice: events.slice(run.fromIndex, run.toIndex + 1),
  }));
}

/** The named run, or the newest one — the same fallback the engine uses. */
export function pickRunView(views: readonly RunView[], id?: string): RunView | undefined {
  if (id) {
    const found = views.find((view) => view.run.id === id);
    if (found) return found;
  }
  return views[views.length - 1];
}

export function zhRunStatus(status: RunStatus | undefined): string {
  switch (status) {
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "error":
      return "出错";
    case "interrupted":
      return "被中断";
    default:
      return "—";
  }
}

export function runStatusTone(status: RunStatus | undefined): "ok" | "live" | "warn" | "high" | "off" {
  switch (status) {
    case "running":
      return "live";
    case "completed":
      return "ok";
    case "interrupted":
      return "warn";
    case "error":
      return "high";
    default:
      return "off";
  }
}

/** How long the run lasted: measured, or "so far" for one still in flight. */
export function runDuration(run: Run, events: readonly ChartEvent[]): number {
  if (run.durationMs !== undefined) return run.durationMs;
  const last = events[run.toIndex]?.timestamp ?? run.startedAt;
  return Math.max(0, last - run.startedAt);
}

export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/* ── playback ───────────────────────────────────────────────────────────── */

export interface Frame {
  /** The run to judge: the real one at the end, a truncated one before it. */
  run: Run;
  /** 0-based index *inside the run* of the last revealed event. */
  cursor: number;
  total: number;
  atEnd: boolean;
  /** The clock the judgement is anchored to (the next event, or the run end). */
  anchor: number;
  /** The revealed prefix of the run. */
  revealed: ChartEvent[];
  /** The global index of the last revealed event. */
  index: number;
}

/**
 * The state of the playback at `cursorIndex`.
 *
 * The anchor is the *next* event's timestamp, not the current one: while a run is
 * in flight, "now" sits in the gap before the next thing happens. That is what
 * makes `live.stalledSeconds` and "last 2 minutes" windows mean something during
 * playback instead of always reading zero.
 */
export function frameAt(events: readonly ChartEvent[], view: RunView, cursorIndex: number): Frame {
  const total = view.eventCount;
  const cursor = Math.max(0, Math.min(cursorIndex, Math.max(0, total - 1)));
  const index = view.run.fromIndex + cursor;
  const atEnd = cursor >= total - 1;
  const lastAt = events[index]?.timestamp ?? view.run.startedAt;
  const nextAt = events[index + 1]?.timestamp;
  const anchor = atEnd ? (view.run.endedAt ?? lastAt) : (nextAt ?? lastAt);
  const run: Run = atEnd
    ? view.run
    : { ...view.run, toIndex: index, status: "running", endedAt: undefined, durationMs: undefined };
  return {
    run,
    cursor,
    total,
    atEnd,
    anchor,
    revealed: events.slice(view.run.fromIndex, index + 1),
    index,
  };
}
