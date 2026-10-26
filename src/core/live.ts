/**
 * Deriving the live numbers rules read.
 *
 * `stalledSeconds` and `elapsedSeconds` are not facts — they depend on a clock.
 * Chart never reads one: the host passes `nowMs`, and this function turns it
 * into the two numbers the rule language exposes. Doing it here (rather than in
 * the evaluator's callers) means a host cannot forget, and doing it as a pure
 * function of `(facts, nowMs)` means a replay with the same clock agrees.
 */

import type { Facts, LiveContext } from "./types.ts";

export function withLive(facts: Facts, live: LiveContext): LiveContext {
  if (live.nowMs === undefined) return live;
  return {
    ...live,
    elapsedSeconds: Math.max(0, Math.floor((live.nowMs - facts.run.startedAt) / 1000)),
    stalledSeconds: Math.max(0, Math.floor((live.nowMs - facts.lastActivityAt) / 1000)),
  };
}
