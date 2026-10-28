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
  type Evaluation,
  type RuleError,
  type RuleState,
} from "./regimen/evaluate.ts";
import { makeRecord, recordBody, type FindingRecord } from "./regimen/record.ts";
import type { RulePack, RulePhase } from "./regimen/rule.ts";
import { renderReport, renderText, type RenderContext } from "./report/render.ts";
import { deriveOutcome, outcomeHeadline } from "./report/verdict.ts";
import type { ReportSpec, RenderedReport } from "./report/spec.ts";

/* ── Public types and values ─────────────────────────────────────────────── */

export type { ChartEvent, ChartEventType, ChartEventPayloadMap } from "./core/events.ts";
export * from "./core/types.ts";
export type { Rule, RulePack, RuleEmit, RuleIssue, RulePhase } from "./regimen/rule.ts";
export {
  validatePack,
  orderedRules,
  mergePacks,
  hashPack,
  appliesInPhase,
  impliedPhase,
  phaseOf,
} from "./regimen/rule.ts";
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
  describeSequence,
  anchorOf,
  OPERATOR_CATALOG,
  operatorsFor,
} from "./regimen/predicate.ts";
export type { WindowSpec, WindowSpan, WindowMeasure, WindowResult } from "./regimen/window.ts";
export { runWindow, WINDOW_MEASURES, MAX_SCAN_EVENTS } from "./regimen/window.ts";
export type { SequenceSpec, SequenceStep, SequenceGap, SequenceResult } from "./regimen/sequence.ts";
export { runSequence, DEFAULT_MAX_GAP_EVENTS, DEFAULT_MAX_GAP_MS } from "./regimen/sequence.ts";
export type { RuleState, RuleError, Evaluation, EvaluateOptions } from "./regimen/evaluate.ts";
export type { FindingRecord, FindingRecordBody, ChainCheck } from "./regimen/record.ts";
export { digestOf, canonicalJson, makeRecord, verifyChain } from "./regimen/record.ts";
export type { ReservedReason } from "./regimen/reasons.ts";
export {
  RESERVED_REASONS,
  REASON_LABELS,
  isReservedReason,
  isNamespacedReason,
  isValidReason,
  normalizeReason,
  reasonFor,
} from "./regimen/reasons.ts";
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
export {
  renderTemplate,
  checkTemplate,
  formatDuration,
  formatPercent,
  formatBytes,
  formatNumber,
  plural,
  shortenPath,
} from "./regimen/template.ts";
export type { TemplateIssue } from "./regimen/template.ts";
export type {
  ReportSpec,
  ReportSection,
  RenderedReport,
  RenderedSection,
  SectionFilter,
} from "./report/spec.ts";
export { renderReport, renderText, type RenderContext } from "./report/render.ts";
export {
  validateSpec,
  checkSpecTemplates,
  knownFieldFor,
  type SpecIssue,
  type TemplateIssueAt,
  type TemplateCheckOptions,
} from "./report/validate.ts";
export { LIVE_REPORT, SETTLED_REPORT, DEFAULT_REPORTS } from "./report/defaults.ts";
export { CLASSIC_REPORT } from "./report/classic.ts";
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
  /** The pack that judged, when the caller named one. Stamped into a report. */
  packName?: string;
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
    ...(pack.name ? { packName: pack.name } : {}),
  };
}

/**
 * Turn an observation into the record to persist next to the events.
 *
 * This is what a faithful replay reads. Call it when the judgement happens, not
 * later: the point of the record is that it captured the rules *then*.
 *
 * Pass the previous record of the session to seal the chain — `verifyChain`
 * then proves nothing in the log was edited, reordered or removed.
 */
export function record(
  observation: Observation,
  pack: RulePack,
  previous?: FindingRecord,
): FindingRecord {
  return makeRecord(
    recordBody({
      runId: observation.run.id,
      phase: observation.phase ?? "settled",
      anchor: observation.anchor,
      findings: observation.findings,
      attention: observation.attention,
      errors: observation.errors,
      pack,
    }),
    previous,
  );
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
    // A replay must say it is a replay, and name the pack recorded with it.
    // Otherwise a report of last week reads as if today's rules had judged it.
    judgedBy: {
      ...(recorded.packName ? { packName: recorded.packName } : {}),
      ...(recorded.packHash ? { packHash: recorded.packHash } : {}),
      at: recorded.anchor,
      replayed: true,
    },
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
    judgedBy: {
      ...(observation.packName ? { packName: observation.packName } : {}),
      at: observation.anchor,
      ...(observation.hypothetical ? { replayed: false } : {}),
    },
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
  replaceRuleAt,
  moveRuleTo,
  removeRule,
  resetPack,
  isIdTaken,
  isIdTakenByOther,
  suggestId,
} from "./editor/draft.ts";

export { deriveOutcome as outcome, outcomeHeadline as headline };
export { describeRule as describeRuleOf } from "./regimen/describe.ts";
export type { ConditionTrace, RuleTrace, LeafOutcome } from "./regimen/trace.ts";
export { traceRule, traceWhen } from "./regimen/trace.ts";
export { withLive, metricsFromFrames, metricsAt } from "./core/live.ts";
export type { EggSampleLike, MetricsFrameLike } from "./core/live.ts";
export { dryRun as judgeOnce };
