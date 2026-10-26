/**
 * Sequences — ordered steps over the stream, with bounded gaps.
 *
 * This is the one thing a flat condition list could not express: *ordering*.
 * "The same command failed, then succeeded, then failed again" is not a count
 * (a count cannot see the success in between) and it is not a window (a window
 * has no order). It is a small pattern over the stream.
 *
 * The design deliberately stops short of a temporal logic:
 *
 *   · a sequence is a **flat list of steps** — the rule stays one list of
 *     conditions, and a step is not a place to hang another sequence;
 *   · every gap is **bounded** (`maxEvents` and `maxMs`), so matching is a
 *     bounded scan rather than a search, and a pathological stream cannot make
 *     it quadratic;
 *   · matching is **leftmost and non-overlapping**, so the answer is a number
 *     and a list of event ids, not a set of possible alignments.
 *
 * Both bounds are inputs (like the window's span), so the same stream and anchor
 * always produce the same match — replay stays exact.
 *
 * The user-facing reason for this file: an agent that fixes a failure and then
 * breaks it again is *flapping*, and "flapping" was previously a fact the code
 * would have had to know about. Now it is a rule anyone can write.
 */

import type { ChartEvent } from "../core/events.ts";
import type { When } from "./predicate.ts";

export interface SequenceStep {
  /** Only events of these types can match this step. */
  type?: string | string[];
  /** Extra field conditions on the event (no windows, no quantifiers). */
  where?: When;
  /** A name for templates: `{{vars.sequence.step.fail}}`. */
  as?: string;
}

export interface SequenceGap {
  /** How many events may sit between two consecutive steps. Default 500. */
  maxEvents?: number;
  /** How long, in ms, may pass between two consecutive steps. Default 1 hour. */
  maxMs?: number;
}

export interface SequenceSpec {
  /** Ordered, at least two. */
  steps: SequenceStep[];
  /** Bounds on the gap between consecutive steps. */
  gap?: SequenceGap;
  /** How many complete matches to require. Default 1. */
  times?: number;
  /** Only look this far back from the anchor. Omitted = the whole run. */
  span?: { lastMs?: number };
}

export interface SequenceResult {
  matched: boolean;
  /** How many non-overlapping matches were found (capped at `times`). */
  count: number;
  /** Every event id used by the matches, in order. */
  ids: string[];
  /** The steps of the first match, so a template can name them. */
  step: Record<string, { id: string; timestamp: number }>;
  firstAt?: number;
  lastAt?: number;
}

export const DEFAULT_MAX_GAP_EVENTS = 500;
export const DEFAULT_MAX_GAP_MS = 60 * 60_000;
export const MAX_SEQUENCE_IDS = 32;

/** The two bits of the condition layer a sequence needs, injected to avoid a cycle. */
export interface SequenceRuntime {
  matches: (when: When, item: unknown) => boolean;
}

export function runSequence(
  spec: SequenceSpec,
  events: readonly ChartEvent[],
  anchor: number,
  runtime: SequenceRuntime,
): SequenceResult {
  const steps = spec.steps;
  if (steps.length < 2) throw new Error("a sequence needs at least two steps");

  const maxEvents = Math.max(1, spec.gap?.maxEvents ?? DEFAULT_MAX_GAP_EVENTS);
  const maxMs = Math.max(0, spec.gap?.maxMs ?? DEFAULT_MAX_GAP_MS);
  const times = Math.max(1, spec.times ?? 1);
  const from = spec.span?.lastMs !== undefined ? anchor - Math.max(0, spec.span.lastMs) : undefined;

  const candidate: ChartEvent[] = [];
  for (const event of events) {
    if (from !== undefined && event.timestamp < from) continue;
    if (event.timestamp > anchor) continue; // never look past the anchor
    candidate.push(event);
  }

  const matches: number[][] = [];
  let cursor = 0;
  while (matches.length < times && cursor < candidate.length) {
    const match = matchAt(candidate, cursor, steps, maxEvents, maxMs, runtime);
    if (!match) {
      cursor += 1;
      continue;
    }
    matches.push(match);
    // Non-overlapping: the next match starts after the last event used.
    cursor = match[match.length - 1]! + 1;
  }

  const ids: string[] = [];
  for (const match of matches) for (const index of match) ids.push(candidate[index]!.id);

  const firstMatch = matches[0];
  const step: Record<string, { id: string; timestamp: number }> = {};
  if (firstMatch) {
    firstMatch.forEach((index, position) => {
      const label = steps[position]?.as;
      if (!label) return;
      const event = candidate[index]!;
      step[label] = { id: event.id, timestamp: event.timestamp };
    });
  }

  const firstAt = firstMatch ? candidate[firstMatch[0]!]!.timestamp : undefined;
  const lastAt = firstMatch ? candidate[firstMatch[firstMatch.length - 1]!]!.timestamp : undefined;

  return {
    matched: matches.length >= times,
    count: matches.length,
    ids: ids.slice(0, MAX_SEQUENCE_IDS),
    step,
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
  };
}

/** Try to match every step starting at `start`; returns the event indices. */
function matchAt(
  events: readonly ChartEvent[],
  start: number,
  steps: SequenceStep[],
  maxEvents: number,
  maxMs: number,
  runtime: SequenceRuntime,
): number[] | undefined {
  const first = steps[0]!;
  if (!matchesStep(events[start]!, first, runtime)) return undefined;

  const indices = [start];
  let position = start;

  for (let step = 1; step < steps.length; step++) {
    const next = steps[step]!;
    const limit = Math.min(events.length - 1, position + maxEvents);
    const fromTime = events[position]!.timestamp;
    let found = -1;
    for (let index = position + 1; index <= limit; index++) {
      const event = events[index]!;
      if (event.timestamp - fromTime > maxMs) break;
      if (matchesStep(event, next, runtime)) {
        found = index;
        break;
      }
    }
    if (found === -1) return undefined;
    indices.push(found);
    position = found;
  }

  return indices;
}

function matchesStep(event: ChartEvent, step: SequenceStep, runtime: SequenceRuntime): boolean {
  if (step.type !== undefined) {
    const types = Array.isArray(step.type) ? step.type : [step.type];
    if (!types.includes(event.type)) return false;
  }
  return step.where ? runtime.matches(step.where, event) : true;
}
