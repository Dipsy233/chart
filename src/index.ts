/**
 * Chart — a zero-intrusion observation engine for AI agents.
 *
 * Three layers, one direction:
 *
 *   events ──▶ facts ──▶ findings ──▶ report
 *            (measure)   (Regimen)   (spec)
 *
 * Nothing here reads a clock, writes a file, opens a socket, or touches the
 * observed process. Time is an argument (`live.nowMs` or `anchor`), state is an
 * argument (`RuleState`), and output is data.
 *
 * Three modes, never confused:
 *
 *   observe   — live. Judged and **recorded**.
 *   replay    — the record, faithfully. Reads findings; never re-judges.
 *   simulate  — a hypothetical. Re-judges with a pack; never recorded, and
 *               labelled `hypothetical: true` so no caller can mistake it.
 *
 * Quick start:
 *
 *   import { observe, DEFAULT_PACK, report, SETTLED_REPORT } from "chart";
 *   const view = observe(events, { pack: DEFAULT_PACK })!;
 *   const rendered = report(view, SETTLED_REPORT);
 */

import { buildFacts } from "./facts/build.ts";
import { deriveRuns, pickRun } from "./facts/runs.ts";
import { withLive } from "./core/live.ts";
import type { ChartEvent } from "./core/events.ts";
import type { Attention, EvalContext, Facts, Finding, LiveContext, Run } from "./core/types.ts";
import { DEFAULT_PACK } from "./regimen/defaults.ts";
import {
  dryRun,
  emptyRuleState,
  evaluate,
  record as makeRecord,
  type Evaluation,
  type FindingRecord,
  type RuleError,
  type RuleState,
} from "./regimen/evaluate.ts";
import type { RulePack, RulePhase } from "./regimen/rule.ts";
import { renderReport, renderText, type RenderContext } from "./report/render.ts";
import { deriveOutcome, outcomeHeadline } from "./report/verdict.ts";
import type { ReportSpec, RenderedReport } from "./report/spec.ts";

/* ── Public types and values ─────────────────────────────────────────────── */

export type { ChartEvent, ChartEventType, ChartEventPayloadMap } from "./core/events.ts";
export * from "./core/types.ts";
export type { Rule, RulePack, RuleEmit, RuleIssue, RulePhase } from "./regimen/rule.ts";
export { validatePack, orderedRules, mergePacks, hashPack, appliesInPhase } from "./regimen/rule.ts";
export type {
  When,
  Condition,
  FieldCondition,
  QuantCondition,
  WindowCondition,
  ScalarOp,
  Quant,
  JsonValue,
  PredicateIssue,
  OperatorInfo,
  ValueKind,
} from "./regimen/predicate.ts";
export {
  matches,
  evalCondition,
  compare,
  resolvePath,
  validateWhen,
  describeWhen,
  describeCondition,
  describeWindow,
  anchorOf,
  OPERATOR_CATALOG,
  operatorsFor,
} from "./regimen/predicate.ts";
export type { WindowSpec, WindowSpan, WindowMeasure, WindowResult } from "./regimen/window.ts";
export { runWindow, WINDOW_MEASURES, MAX_SCAN_EVENTS } from "./regimen/window.ts";
export type { RuleState, RuleError, Evaluation, EvaluateOptions, FindingRecord } from "./regimen/evaluate.ts";
export {
  evaluate,
  evaluateLive,
  evaluateSettled,
  dryRun,
  emptyRuleState,
  findingsAtLeast,
  attentionFrom,
} from "./regimen/evaluate.ts";
export { DEFAULT_PACK, defaultPack } from "./regimen/defaults.ts";
export { EXAMPLE_PACK, examplePack } from "./regimen/examples.ts";
export { renderTemplate, formatDuration, plural, shortenPath } from "./regimen/template.ts";
export type { ReportSpec, ReportSection, RenderedReport, RenderedSection } from "./report/spec.ts";
export { renderReport, renderText } from "./report/render.ts";
export { LIVE_REPORT, SETTLED_REPORT, DEFAULT_REPORTS } from "./report/defaults.ts";
export { deriveOutcome, outcomeHeadline } from "./report/verdict.ts";
export { buildFacts } from "./facts/build.ts";
export { deriveRuns, pickRun, isObservedStream } from "./facts/runs.ts";
export { matchGlob, matchAnyGlob, compileGlob } from "./facts/glob.ts";
export { toChartEvent, toChartEvents, isAbsenceEvent, type AbsenceLikeEvent } from "./adapters/absence.ts";

/* ── Observation ────────────────────────────────────────────────────────── */

/** One run, reduced and judged. What a host holds and re-renders. */
export interface Observation {
  run: Run;
  facts: Facts;
  attention: Attention;
  findings: Finding[];
  errors: RuleError[];
  state: RuleState;
  /** Which phase was judged, when one was asked for. */
  phase?: RulePhase;
  /** The clock the judgement was anchored to. */
  anchor: number;
  /** True only for `simulate()`: this is a hypothetical, not the record. */
  hypothetical?: true;
}

export interface ObserveOptions {
  /** The rule pack to judge with. Defaults to Chart's own pack. */
  pack?: RulePack;
  live?: LiveContext;
  /** Carried between live evaluations; pass the previous result to keep cooldowns. */
  state?: RuleState;
  session?: { id?: string; project?: string };
  /** Which run to judge. Defaults to the newest. */
  runId?: string;
  /** Judge only the rules that apply in this phase. Omit for every rule. */
  phase?: RulePhase;
  /** The clock windows are anchored to. Defaults to `live.nowMs`, then the run end. */
  anchor?: number;
}

/** Reduce a whole stream and judge its newest run (or the one named by `runId`). */
export function observe(events: readonly ChartEvent[], options: ObserveOptions = {}): Observation | undefined {
  const run = pickRun(deriveRuns(events), options.runId);
  if (!run) return undefined;
  return observeRun(events, run, options);
}

/** Reduce and judge a specific run. */
export function observeRun(
  events: readonly ChartEvent[],
  run: Run,
  options: ObserveOptions = {},
): Observation {
  return judge(events, run, options.pack ?? DEFAULT_PACK, options, false);
}

/**
 * Judge a run with a pack that was **not** the one in force — a hypothetical.
 *
 * The result is labelled `hypothetical: true` and must never be recorded. This
 * is the rule editor's "what would this have said?" button, not a replay: a
 * replay shows what was actually recorded at the time (see `replayReport`).
 */
export function simulate(events: readonly ChartEvent[], pack: RulePack = DEFAULT_PACK, options: ObserveOptions = {}): Observation | undefined {
  const run = pickRun(deriveRuns(events), options.runId);
  if (!run) return undefined;
  return judge(events, run, pack, options, true);
}

function judge(
  events: readonly ChartEvent[],
  run: Run,
  pack: RulePack,
  options: ObserveOptions,
  hypothetical: boolean,
): Observation {
  const facts = buildFacts(events, run);
  const slice = events.slice(run.fromIndex, run.toIndex + 1);
  const live = withLive(facts, options.live ?? {});
  const context: EvalContext = {
    facts,
    live,
    session: options.session,
    events: slice,
    anchor: options.anchor,
  };
  const result = evaluate(pack, context, { phase: options.phase, state: options.state });
  return {
    run,
    facts,
    attention: result.attention,
    findings: result.findings,
    errors: result.errors,
    state: result.state,
    anchor: context.anchor ?? live.nowMs ?? facts.run.endedAt ?? facts.lastActivityAt,
    ...(result.phase ? { phase: result.phase } : {}),
    ...(hypothetical ? { hypothetical: true as const } : {}),
  };
}

/**
 * Turn an observation into the record to persist next to the events.
 *
 * This is what a faithful replay reads. Call it when the judgement happens, not
 * later: the point of the record is that it captured the rules *then*.
 */
export function record(observation: Observation, pack: RulePack): FindingRecord {
  return makeRecord(observation, pack, observation.phase ?? "settled", observation.anchor);
}

/* ── Replay ─────────────────────────────────────────────────────────────── */

/**
 * Render a past run from its record. **Does not evaluate anything.**
 *
 * Facts are recomputed from the events — safe, because facts carry no
 * thresholds and are a pure function of the stream. Findings come from the
 * record, so a run that had no rule configured then still shows no such finding
 * today, no matter what the current pack says.
 */
export function replayReport(
  recorded: FindingRecord,
  facts: Facts,
  spec: ReportSpec,
  live: LiveContext = {},
): RenderedReport {
  const context: RenderContext = {
    facts,
    attention: recorded.attention,
    live: withLive(facts, live),
  };
  return renderReport(spec, context);
}

/** The same, as text. */
export function replayText(
  recorded: FindingRecord,
  facts: Facts,
  spec: ReportSpec,
  live: LiveContext = {},
): string {
  return renderText(replayReport(recorded, facts, spec, live));
}

/* ── Reports ────────────────────────────────────────────────────────────── */

/** Render a spec against an observation. */
export function report(observation: Observation, spec: ReportSpec, live: LiveContext = {}): RenderedReport {
  const context: RenderContext = {
    facts: observation.facts,
    attention: observation.attention,
    live: withLive(observation.facts, live),
  };
  return renderReport(spec, context);
}

/** Render a spec as plain text. */
export function reportText(observation: Observation, spec: ReportSpec, live: LiveContext = {}): string {
  return renderText(report(observation, spec, live));
}

/** Fill in the live numbers from an explicit clock. */
export function withDerivedLive(facts: Facts, live: LiveContext): LiveContext {
  return withLive(facts, live);
}

/* ── Packs on disk + the editor model ───────────────────────────────────── */

export type { PackIO, PackSummary } from "./store/packStore.ts";
export {
  PackStore,
  PackInvalidError,
  parsePack,
  serializePack,
  assertPackName,
  PACK_NAME_RE,
} from "./store/packStore.ts";
export type { FieldInfo, EventTypeInfo } from "./editor/catalog.ts";
export {
  FACT_FIELDS,
  LIVE_FIELDS,
  EVENT_FIELDS,
  EVENT_TYPES,
  eventFields,
  allFields,
  fieldFor,
} from "./editor/catalog.ts";
export type { RulePreview, PreviewOptions } from "./editor/draft.ts";
export {
  newRule,
  validateRule,
  describeRule,
  operatorsForField,
  previewRule,
  upsertRule,
  removeRule,
  resetPack,
  isIdTaken,
  suggestId,
} from "./editor/draft.ts";

export { deriveOutcome as outcome, outcomeHeadline as headline };
export { withLive } from "./core/live.ts";
export { dryRun as judgeOnce };
