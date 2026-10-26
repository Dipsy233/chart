/**
 * Windows — the one place a rule may look at the stream instead of a snapshot.
 *
 * A window is a *query*, not a state machine:
 *
 *   { "window": {
 *       "events": { "type": ["command"],
 *                   "where": { "conditions": [ … ] } },
 *       "span":   { "lastMs": 120000 },
 *       "measure": "streak", "op": "gte", "value": 5 } }
 *
 * It scans the run's events, keeps those inside the span around the anchor,
 * computes one number, and compares it. Every time. From scratch.
 *
 * That is what makes it replayable: the answer is a pure function of
 * `(events, anchor, spec)`. There is no counter living between evaluations, so
 * a replay with the same anchor gives the same number — which is exactly the
 * property the old design's "no clock in the language" rule was trying to
 * protect, achieved without giving up time.
 *
 * `anchor` is always passed in, never read: `nowMs` while live, the run's end
 * when settled, whatever the editor passes when simulating.
 *
 * Windows do **not** nest. A `where` filter is a flat list of field conditions,
 * so a window cannot contain a window. Sequence correlation ("A, then B within
 * X") is a *fact* to be added to the fact layer, not a language feature — see
 * docs/DESIGN.md §3.
 */

import type { ChartEvent } from "../core/events.ts";
import type { JsonValue, ScalarOp, When } from "./predicate.ts";

export type WindowMeasure =
  | "count"
  | "streak"
  | "sum"
  | "max"
  | "min"
  | "avg"
  | "gapMs"
  | "distinct";

export const WINDOW_MEASURES: WindowMeasure[] = [
  "count",
  "streak",
  "sum",
  "max",
  "min",
  "avg",
  "gapMs",
  "distinct",
];

/** How far around the anchor to look. Omitted = the whole run. */
export interface WindowSpan {
  /** Only events at or after `anchor - lastMs`. */
  lastMs?: number;
  /** Only events at or before `anchor + nextMs`. */
  nextMs?: number;
}

export interface WindowSpec {
  /** Which events count. `type` narrows the stream; `where` filters the rest. */
  events?: { type?: string | string[]; where?: When };
  span?: WindowSpan;
  measure: WindowMeasure;
  /** For sum/max/min/avg/distinct: the path inside the event to read. */
  of?: string;
  op: ScalarOp;
  value?: JsonValue;
}

export interface WindowResult {
  measure: WindowMeasure;
  /** The computed number. */
  value: number;
  /** Whether `op`/`value` accepted it. */
  matched: boolean;
  /** How many events the window selected (before aggregation). */
  selected: number;
  /** The newest 32 selected event ids — the evidence a finding points at. */
  ids: string[];
  firstAt?: number;
  lastAt?: number;
}

/** Evidence is capped: a finding links to a handful of events, not thousands. */
export const MAX_WINDOW_IDS = 32;

/** A guard against a pathological stream, not a performance optimisation. */
export const MAX_SCAN_EVENTS = 100_000;

/** The two bits of the predicate layer a window needs, injected to avoid a cycle. */
const MEASURES_NEEDING_OF: ReadonlySet<WindowMeasure> = new Set<WindowMeasure>(["sum", "max", "min", "avg"]);

export interface WindowRuntime {
  matches: (when: When, item: unknown) => boolean;
  compare: (op: ScalarOp, actual: number, expected: JsonValue | undefined) => boolean;
  readPath: (item: unknown, path: string) => unknown;
}

/** Run one window and return its number, whether it matched, and its evidence. */
export function runWindow(
  spec: WindowSpec,
  events: readonly ChartEvent[],
  anchor: number,
  runtime: WindowRuntime,
): WindowResult {
  if (events.length > MAX_SCAN_EVENTS) {
    throw new Error(`window scan refused: ${events.length} events exceeds the ${MAX_SCAN_EVENTS} budget`);
  }

  if (MEASURES_NEEDING_OF.has(spec.measure) && !spec.of) {
    throw new Error(`window measure "${spec.measure}" needs an \`of\` path inside the event`);
  }

  const types = normalizeTypes(spec.events?.type);
  const where = spec.events?.where;
  // `lastMs` means "the N ms before the anchor", so it implies an upper bound of
  // the anchor; `nextMs` means "the N ms after it", so it implies a lower bound.
  // Giving both makes a closed interval around the anchor.
  const lastMs = spec.span?.lastMs;
  const nextMs = spec.span?.nextMs;
  const from = lastMs !== undefined ? anchor - Math.max(0, lastMs) : nextMs !== undefined ? anchor : undefined;
  const to = nextMs !== undefined ? anchor + Math.max(0, nextMs) : lastMs !== undefined ? anchor : undefined;

  const selected: ChartEvent[] = [];
  /** Current run of consecutive matches, and the longest one seen. */
  let streak = 0;
  let bestStreak = 0;

  for (const event of events) {
    if (from !== undefined && event.timestamp < from) continue;
    if (to !== undefined && event.timestamp > to) continue;
    // A window with no `type` considers every event; a window with a type
    // ignores other types entirely — they neither match nor break a streak.
    if (types && !types.has(event.type)) continue;
    const ok = where ? runtime.matches(where, event) : true;
    if (ok) {
      selected.push(event);
      streak += 1;
      if (streak > bestStreak) bestStreak = streak;
    } else {
      // A same-type event that fails the filter breaks the streak: that is what
      // "consecutive failures" means — one success in between ends the run.
      streak = 0;
    }
  }

  const value = measureOf(spec, selected, bestStreak, runtime);
  const firstAt = selected[0]?.timestamp;
  const lastAt = selected[selected.length - 1]?.timestamp;
  return {
    measure: spec.measure,
    value,
    matched: runtime.compare(spec.op, value, spec.value),
    selected: selected.length,
    ids: selected.slice(-MAX_WINDOW_IDS).map((event) => event.id),
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
  };
}

function measureOf(
  spec: WindowSpec,
  selected: ChartEvent[],
  bestStreak: number,
  runtime: WindowRuntime,
): number {
  switch (spec.measure) {
    case "count":
      return selected.length;
    case "streak":
      return bestStreak;
    case "gapMs": {
      const first = selected[0]?.timestamp;
      const last = selected[selected.length - 1]?.timestamp;
      return first !== undefined && last !== undefined ? Math.max(0, last - first) : 0;
    }
    case "distinct": {
      const path = spec.of ?? "type";
      const seen = new Set<string>();
      for (const event of selected) seen.add(String(runtime.readPath(event, path) ?? ""));
      return seen.size;
    }
    case "sum":
    case "max":
    case "min":
    case "avg": {
      const path = spec.of;
      if (!path) return 0;
      const numbers = selected
        .map((event) => runtime.readPath(event, path))
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (numbers.length === 0) return 0;
      switch (spec.measure) {
        case "sum":
          return numbers.reduce((sum, value) => sum + value, 0);
        case "max":
          return Math.max(...numbers);
        case "min":
          return Math.min(...numbers);
        default:
          return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      }
    }
  }
}

function normalizeTypes(type: string | string[] | undefined): Set<string> | undefined {
  if (type === undefined) return undefined;
  return new Set(Array.isArray(type) ? type : [type]);
}
