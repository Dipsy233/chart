/**
 * Chart's data model, in three layers.
 *
 *   Facts    — measurements. What the observer saw. Rule-independent, so the
 *              same facts can be re-judged by a different rule set forever.
 *   Findings — judgments. One rule firing once, with its evidence.
 *   Attention/Report — presentation. A ranked verdict and a document model.
 *
 * The separation is the whole point of Chart: Absence's current report mixes
 * measurement with judgment (thresholds are passed *into* the fact builder, so
 * facts change when settings change, and history cannot be re-judged). Chart
 * keeps measurements pure and puts every threshold in a rule.
 */

import type { ChartEvent } from "./events.ts";

/* ── Levels ─────────────────────────────────────────────────────────────── */

export type AttentionLevel = "none" | "low" | "medium" | "high";

/** Ordered so `max` is a comparison, not a table lookup. */
export const LEVEL_RANK: Record<AttentionLevel, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
};

export const LEVELS: AttentionLevel[] = ["none", "low", "medium", "high"];

export function maxLevel(a: AttentionLevel, b: AttentionLevel): AttentionLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export function isLevel(value: unknown): value is AttentionLevel {
  return typeof value === "string" && value in LEVEL_RANK;
}

/* ── Runs ───────────────────────────────────────────────────────────────── */

export type RunStatus = "running" | "completed" | "error" | "interrupted";

export type RunOutcome = "completed" | "completed_with_warnings" | "failed" | "stopped" | "no_change";

/** One agent run: the unit Chart judges. Derived from the event stream alone. */
export interface Run {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** How long the run lasted; present once it has settled. */
  durationMs?: number;
  status: RunStatus;
  /** Index into the session's event array, inclusive. */
  fromIndex: number;
  toIndex: number;
}

/* ── Fact pieces ────────────────────────────────────────────────────────── */

export interface FileFact {
  path: string;
  firstSeenAt: number;
  lastSeenAt: number;
  read: boolean;
  agentWrite: boolean;
  agentEdit: boolean;
  /** Changed on disk without a matching agent write/edit. */
  externalChange: boolean;
  additions: number;
  deletions: number;
  evidence: string[];
}

export type CommandStatus = "running" | "success" | "failed" | "unknown";

export interface CommandFact {
  eventId: string;
  toolCallId?: string;
  toolName: string;
  command: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number;
  status: CommandStatus;
  evidence: string[];
}

export interface ProcessFact {
  pid: number;
  name: string;
  commandLine: string;
  /** The shell command that laid it. */
  command?: string;
  startedAt: number;
  exitedAt?: number;
  children: number;
  running: boolean;
  kind: "primary" | "tool";
  kindReason?: string;
  /** How long it lived, measured against the run end (deterministic, no wall clock). */
  lifetimeMs: number;
  evidence: string[];
}

export interface McpUsageFact {
  server: string;
  calls: number;
  failed: number;
  tools: string[];
  evidence: string[];
}

export interface ReadKnowledge {
  path: string;
  startLine: number;
  endLine: number;
  evidence: string[];
}

export interface SearchKnowledge {
  tool: string;
  query: string;
  scope?: string;
  matches: number;
  evidence: string[];
}

export interface Recovery {
  failedCommandId: string;
  recoveryEvents: string[];
  successfulCommandId?: string;
  hadEdit: boolean;
}

export type PhaseType = "investigating" | "implementing" | "executing" | "verifying" | "recovering";

export interface Phase {
  type: PhaseType;
  at: number;
  eventId: string;
}

export type TimelineKind =
  | "start"
  | "think"
  | "read"
  | "search"
  | "edit"
  | "write"
  | "run"
  | "process"
  | "observe"
  | "error"
  | "end";

export interface TimelineNode {
  eventId: string;
  kind: TimelineKind;
  at: number;
  offsetMs: number;
  action: string;
  subject: string;
  effects: string[];
}

/** A path whose content returned to a state the agent already held. Raw measurement. */
export interface RevertFact {
  path: string;
  count: number;
  evidence: string[];
}

/** An identical command that failed more than once. Raw measurement. */
export interface RetryFact {
  command: string;
  count: number;
  evidence: string[];
}

export interface OutsideChangeFact {
  path: string;
  count: number;
  evidence: string[];
}

/**
 * Something the agent said or was told, kept as text a rule can match.
 *
 * A rule that asks "did the agent read the credentials file" can look at paths;
 * "did the user ask about pricing" can only look at what was said. That is what
 * this fact is for: the transcript, reduced, with the event ids a finding points
 * at. Streaming deltas are skipped — the final event carries the same text.
 */
export interface TextFact {
  /** The text as it arrived, trimmed. */
  text: string;
  /** When it was said, so a report can order it. */
  at: number;
  /** The event the text came from. */
  eventId: string;
  /** The events this fact points at — the same id, in the evidence shape. */
  evidence: string[];
}
/* ── Facts ──────────────────────────────────────────────────────────────── */

export interface Facts {
  sessionId: string;
  run: Run;

  files: {
    read: string[];
    /** Written this run for the first time in the session. */
    created: string[];
    modified: string[];
    deleted: string[];
    /** Watcher changes the agent did not make. */
    observed: string[];
    byPath: Record<string, FileFact>;
  };

  commands: { total: number; running: number; succeeded: number; failed: number; unknown: number };
  commandFacts: CommandFact[];
  /** Commands that failed, in order — the evidence a failure rule points at. */
  failed: CommandFact[];

  mcp: { calls: number; failed: number; servers: Record<string, McpUsageFact> };

  processes: {
    /** Every process the agent laid, primaries and tools. */
    all: ProcessFact[];
    /** Only `primary` eggs, in the order they were laid. */
    primary: ProcessFact[];
    /** Primaries still alive when the run ended — unfiltered. */
    runningAtEnd: ProcessFact[];
    tools: number;
    byPid: Record<number, ProcessFact>;
  };

  errors: { total: number; evidence: string[] };

  changes: { additions: number; deletions: number };

  counts: { reads: number; searches: number; edits: number; writes: number };

  knowledge: { reads: ReadKnowledge[]; searches: SearchKnowledge[] };

  phases: Phase[];
  currentPhase: PhaseType;
  recoveries: Recovery[];

  /** Raw version-revert counts, per path. Thresholds live in rules. */
  reverts: RevertFact[];
  /** Raw repeated-failure counts, per command. Thresholds live in rules. */
  retries: RetryFact[];

  /** The longest run of back-to-back failures. */
  failureStreak: { count: number; evidence: string[] };

  /** Watcher changes outside the project root, unfiltered. */
  outsideChanges: OutsideChangeFact[];

  timeline: TimelineNode[];

  /** Failed commands nothing recovered from. */
  unresolved: string[];

  /** Whether the run has settled (`endedAt` is set or the status is not running). */
  ended: boolean;

  lastActivityAt: number;
  /** Every event id in the run, in order. */
  evidence: string[];

  /** The agent's last non-empty assistant message. */
  response?: string;

  /**
   * The run's opening prompt — the first user message, trimmed.
   *
   * Kept as its own string because it is the one piece of text almost every
   * "was this run about X?" rule wants, and `facts.text.prompts[0].text` is a
   * mouthful for something that common.
   */
  firstPrompt?: string;

  /**
   * The transcript, as text a rule can match on:
   *
   *   { "field": "facts.text.thoughts", "quant": "any",
   *     "where": { "conditions": [{ "field": "text", "op": "matches", "value": "rm -rf" }] } }
   *
   * Commands are not here on purpose: `facts.commandFacts[*].command` already
   * carries them, together with the exit code a content rule usually also wants.
   */
  text: {
    /** Every user message in the run, in order. */
    prompts: TextFact[];
    /** Every non-empty assistant message in the run, in order. */
    replies: TextFact[];
    /** Every reasoning block, in order. */
    thoughts: TextFact[];
  };
}

/** The event slice a run was built from — kept for replay and for reports. */
export interface RunTrace {
  run: Run;
  events: ChartEvent[];
}

/* ── Live context ───────────────────────────────────────────────────────── */

/**
 * Everything a rule may look at that is not in `Facts`. Kept separate so facts
 * stay a pure function of the event stream: `nowMs` is an *input*, not a clock
 * read, so a replayed evaluation still produces the same findings.
 *
 * `metrics` is the host's sampler, reduced to what a *rule* can decide on. It is
 * deliberately a snapshot, not a history: Chart never stores time series, and a
 * rule that wants "sustained for a minute" says so in its own conditions
 * (`live.elapsedSeconds`) rather than asking the engine to remember frames.
 *
 * The shape mirrors Absence's `EggMetricSample` / `HostMetricSample`
 * (`packages/core/src/metrics.ts`) with one difference: Absence keeps CPU as a
 * cumulative counter and lets the UI derive `rate()`. A rule cannot call a
 * function, so the host converts the counter to `cpuPercent` before handing the
 * snapshot over — the same number the dashboard draws, available to a predicate.
 */
export interface MetricsSnapshot {
  eggs?: Array<{
    /** The egg root pid (Absence: `eggPid`). */
    pid: number;
    name: string;
    /** `agent` is the runtime itself; `primary`/`tool` are eggs the agent laid. */
    kind?: "agent" | "primary" | "tool";
    status?: "running" | "exited";
    /** Instantaneous CPU, in percent of one core (can exceed 100 on many cores). */
    cpuPercent?: number;
    /** Cumulative CPU seconds. */
    cpuSeconds?: number;
    rssBytes?: number;
    /** How many OS processes roll into this egg. */
    processCount?: number;
    /** Session-to-date averages, so a rule can tell "spiky" from "always hot". */
    avgCpuPercent?: number;
    avgRssBytes?: number;
  }>;
  /** The whole agent tree, including the runtime's own processes. */
  agent?: {
    cpuPercent?: number;
    cpuSeconds?: number;
    rssBytes?: number;
    processCount?: number;
    avgCpuPercent?: number;
    avgRssBytes?: number;
  };
  /** The machine the run is on, so "90% of the host" and "90% of a core" differ. */
  host?: {
    cpuCores?: number;
    /** Host CPU usage, 0–100. */
    cpuPercent?: number;
    memTotalBytes?: number;
    memAvailableBytes?: number;
    /** Host memory used, 0–100. */
    memPercent?: number;
    load1?: number;
  };
}

export interface LiveContext {
  /** The clock to judge "stalled" against. Absent = never stalled. */
  nowMs?: number;
  busy?: boolean;
  status?: string;
  /** Derived by the evaluator from `nowMs`; rules read it, never compute it. */
  stalledSeconds?: number;
  /** Seconds the run has been going, derived from `nowMs`. */
  elapsedSeconds?: number;
  metrics?: MetricsSnapshot;
}

/** The object a condition walks. Shape is part of the public rule contract. */
export interface EvalContext {
  facts: Facts;
  live: LiveContext;
  session?: { id?: string; project?: string };
  /**
   * The run's events, in order. Required by `window` conditions; ignored by
   * everything else. Read-only — Chart never writes to the record.
   */
  events?: readonly ChartEvent[];
  /**
   * The clock windows are measured against. Absent = `live.nowMs`, then the run
   * end, then the last activity. Never read from a real clock.
   */
  anchor?: number;
}

/* ── Findings ───────────────────────────────────────────────────────────── */

/** One rule firing once. Always carries evidence. */
export interface Finding {
  ruleId: string;
  /** Stable slug for machine use; defaults to `ruleId`. */
  reason: string;
  level: AttentionLevel;
  title: string;
  detail?: string;
  tags: string[];
  evidence: string[];
  /** When it fired: the newest evidence timestamp, or the run's last activity. */
  at: number;
}

export interface Attention {
  level: AttentionLevel;
  reasons: string[];
  evidence: string[];
  findings: Finding[];
}
