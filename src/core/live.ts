/**
 * Deriving the live numbers rules read.
 *
 * `stalledSeconds` and `elapsedSeconds` are not facts — they depend on a clock.
 * Chart never reads one: the host passes `nowMs`, and this function turns it
 * into the two numbers the rule language exposes. Doing it here (rather than in
 * the evaluator's callers) means a host cannot forget, and doing it as a pure
 * function of `(facts, nowMs)` means a replay with the same clock agrees.
 *
 * The same holds for resources: `metricsFromFrames` turns the host's sampler
 * frames into the snapshot a rule can decide on. It is a pure function of the
 * frames it is handed — no wall clock, no `/proc` read — so a recorded session
 * can be re-judged with a different CPU threshold exactly like its events.
 */

import type { Facts, LiveContext, MetricsSnapshot } from "./types.ts";

export function withLive(facts: Facts, live: LiveContext): LiveContext {
  if (live.nowMs === undefined) return live;
  return {
    ...live,
    elapsedSeconds: Math.max(0, Math.floor((live.nowMs - facts.run.startedAt) / 1000)),
    stalledSeconds: Math.max(0, Math.floor((live.nowMs - facts.lastActivityAt) / 1000)),
  };
}

/* ── Resource snapshots ─────────────────────────────────────────────────── */

/**
 * The snapshot as it stood at `at`.
 *
 * Playback and a live host both ask this: a rule judges the newest sample at or
 * before its anchor, so scrubbing a recorded run shows the resources of that
 * moment, not of the session's end. Frames after `at` are ignored, so the result
 * is a pure function of the frames and the anchor — no wall clock.
 */
export function metricsAt(frames: readonly MetricsFrameLike[], at: number): MetricsSnapshot {
  const upto = frames.filter((frame) => frame.ts <= at);
  return metricsFromFrames(upto.length > 0 ? upto : frames.slice(0, 1));
}

/**
 * The part of Absence's `EggMetricSample` Chart needs. Structural on purpose:
 * the sampler lives in the host (`packages/core/src/metrics.ts`), and Chart must
 * not import it — the same rule as the event adapter.
 */
export interface EggSampleLike {
  /** Absence calls it `eggPid`; a plain `pid` is accepted too. */
  eggPid?: number;
  pid?: number;
  name: string;
  kind?: "agent" | "primary" | "tool";
  status?: "running" | "exited";
  /** Cumulative CPU seconds (a counter, not a rate). */
  cpuSeconds?: number;
  rssBytes?: number;
  processCount?: number;
  /** Session-to-date averages, maintained by the host. In CPU **cores**. */
  avgCpuCoresSession?: number;
  avgRssBytesSession?: number;
}

/** The part of Absence's `MetricsFrame` Chart needs. */
export interface MetricsFrameLike {
  ts: number;
  eggs?: EggSampleLike[];
  agent?: EggSampleLike;
  host?: {
    cpuSeconds?: number;
    cpuIdleSeconds?: number;
    cpuCount?: number;
    memTotalBytes?: number;
    memAvailableBytes?: number;
    load1?: number;
  };
}

/** CPU cores in use between two samples — the same `rate()` the dashboard draws. */
function coresBetween(from: EggSampleLike, to: EggSampleLike, seconds: number): number {
  if (seconds <= 0) return 0;
  return Math.max(0, ((to.cpuSeconds ?? 0) - (from.cpuSeconds ?? 0)) / seconds);
}

/**
 * The newest frame as a rule snapshot, with CPU counters turned into percentages.
 *
 * Mirrors Absence's `metrics.ts` derivation:
 *
 *   · an egg's CPU is the rate between the last two frames **that contain it**,
 *     so an exited egg keeps its final number instead of reading 0;
 *   · RSS is a gauge, taken from the newest sample that has the egg;
 *   · the host's CPU is `(total − idle)` over the last two frames, and its
 *     memory is `used / total` from the newest frame.
 *
 * A single frame still produces a snapshot — every rate is then 0, which is
 * honest ("we have one sample, so we know no rate yet") rather than absent.
 */
export function metricsFromFrames(frames: readonly MetricsFrameLike[]): MetricsSnapshot {
  if (frames.length === 0) return {};
  const latest = frames[frames.length - 1]!;

  const eggSnapshots: NonNullable<MetricsSnapshot["eggs"]> = [];
  const seen = new Set<number>();
  // Newest first, so an egg that already exited is still reported once.
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    for (const egg of frame.eggs ?? []) {
      const pid = egg.eggPid ?? egg.pid;
      if (pid === undefined || seen.has(pid)) continue;
      seen.add(pid);
      const previous = previousWith(frames, index, pid);
      const seconds = previous ? (frame.ts - previous.frame.ts) / 1000 : 0;
      eggSnapshots.push({
        pid,
        name: egg.name,
        ...(egg.kind ? { kind: egg.kind } : {}),
        ...(egg.status ? { status: egg.status } : {}),
        cpuPercent: previous ? coresBetween(previous.egg, egg, seconds) * 100 : 0,
        cpuSeconds: egg.cpuSeconds ?? 0,
        rssBytes: egg.rssBytes ?? 0,
        processCount: egg.processCount ?? 0,
        avgCpuPercent: (egg.avgCpuCoresSession ?? 0) * 100,
        avgRssBytes: egg.avgRssBytesSession ?? egg.rssBytes ?? 0,
      });
    }
  }

  const agentFrame = latest.agent;
  const agentPrevious = agentFrame
    ? previousWith(frames, frames.length - 1, agentFrame.eggPid ?? agentFrame.pid)
    : undefined;
  const agent = agentFrame
    ? {
        cpuPercent: agentPrevious
          ? coresBetween(agentPrevious.egg, agentFrame, (latest.ts - agentPrevious.frame.ts) / 1000) * 100
          : 0,
        cpuSeconds: agentFrame.cpuSeconds ?? 0,
        rssBytes: agentFrame.rssBytes ?? 0,
        processCount: agentFrame.processCount ?? 0,
        avgCpuPercent: (agentFrame.avgCpuCoresSession ?? 0) * 100,
        avgRssBytes: agentFrame.avgRssBytesSession ?? agentFrame.rssBytes ?? 0,
      }
    : undefined;

  const host = hostSnapshot(latest, frames[frames.length - 2]);

  return {
    ...(eggSnapshots.length > 0 ? { eggs: eggSnapshots } : {}),
    ...(agent ? { agent } : {}),
    ...(host ? { host } : {}),
  };
}

/** The previous frame that still had this egg, with the egg's sample in it. */
function previousWith(
  frames: readonly MetricsFrameLike[],
  before: number,
  pid: number | undefined,
): { frame: MetricsFrameLike; egg: EggSampleLike } | undefined {
  if (pid === undefined) {
    // The agent tree is reported on the frame itself, so "the previous sample"
    // is simply the previous frame that had one.
    for (let index = before - 1; index >= 0; index -= 1) {
      const egg = frames[index]!.agent;
      if (egg) return { frame: frames[index]!, egg };
    }
    return undefined;
  }
  for (let index = before - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    const egg = (frame.eggs ?? []).find((candidate) => (candidate.eggPid ?? candidate.pid) === pid);
    if (egg) return { frame, egg };
  }
  return undefined;
}

function hostSnapshot(
  latest: MetricsFrameLike,
  previous: MetricsFrameLike | undefined,
): MetricsSnapshot["host"] | undefined {
  const host = latest.host;
  if (!host) return undefined;
  const total = host.memTotalBytes ?? 0;
  const available = host.memAvailableBytes ?? 0;
  const seconds = previous ? (latest.ts - previous.ts) / 1000 : 0;
  let cpuPercent = 0;
  if (previous?.host && seconds > 0) {
    const cpu = Math.max(0, (host.cpuSeconds ?? 0) - (previous.host.cpuSeconds ?? 0));
    const idle = Math.max(0, (host.cpuIdleSeconds ?? 0) - (previous.host.cpuIdleSeconds ?? 0));
    if (cpu > 0) cpuPercent = Math.max(0, Math.min(100, ((cpu - idle) / cpu) * 100));
  }
  return {
    cpuCores: host.cpuCount ?? 0,
    cpuPercent,
    memTotalBytes: total,
    memAvailableBytes: available,
    memPercent: total > 0 ? ((total - available) / total) * 100 : 0,
    ...(host.load1 !== undefined ? { load1: host.load1 } : {}),
  };
}
