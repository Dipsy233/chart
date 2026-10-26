/**
 * Regimen's evaluator: rules + facts (+ the event stream for windows) → findings.
 *
 * Two properties this file is written to preserve, because everything else in
 * Chart depends on them:
 *
 *   DETERMINISTIC — the only inputs are the facts, the live context (whose clock
 *   is an *argument*, not `Date.now()`), the run's events, and an explicit
 *   `RuleState`. No module-level counters, no memoised "last time", no hidden
 *   state. Feed the same inputs in and you get the same findings out, forever.
 *
 *   FAIL-OPEN — a rule that throws is reported as a `RuleError` and skipped. An
 *   observation engine must never take the run down with it.
 *
 * Findings are the only output. Nothing here writes, calls out, or touches the
 * observed process.
 */

import type { Attention, AttentionLevel, EvalContext, Finding } from "../core/types.ts";
import { LEVEL_RANK, maxLevel } from "../core/types.ts";
import { withLive } from "../core/live.ts";
import { anchorOf, matches, resolvePath, windowFor, type Condition } from "./predicate.ts";
import type { WindowResult } from "./window.ts";
import type { Rule, RulePack, RulePhase } from "./rule.ts";
import { appliesInPhase, hashPack, orderedRules } from "./rule.ts";
import { renderTemplate } from "./template.ts";

/** State a caller keeps between live evaluations. Owned by the caller, not the module. */
export interface RuleState {
  /** Rule id → clock value when it last fired. */
  lastFired: Record<string, number>;
}

export function emptyRuleState(): RuleState {
  return { lastFired: {} };
}

export interface RuleError {
  ruleId: string;
  message: string;
}

export interface Evaluation {
  findings: Finding[];
  attention: Attention;
  state: RuleState;
  errors: RuleError[];
  /** Which phase this evaluation was judged in, when one was given. */
  phase?: RulePhase;
}

export interface EvaluateOptions {
  /** Judge only the rules that apply in this phase. Omit to judge every rule. */
  phase?: RulePhase;
  /** Cooldown state. Pass the previous evaluation's state back to keep cooldowns. */
  state?: RuleState;
}

/**
 * Evaluate a pack against one run.
 *
 * The clock a finding is stamped with and cooldowns are measured against comes
 * from `anchorOf(context)` — `anchor`, then `live.nowMs`, then the run's end.
 */
export function evaluate(pack: RulePack, context: EvalContext, options: EvaluateOptions = {}): Evaluation {
  // Live numbers are derived here, not by the caller: a host that passes a raw
  // `nowMs` still gets `stalledSeconds`, and every consumer agrees.
  const enriched: EvalContext = { ...context, live: withLive(context.facts, context.live) };
  const clock = anchorOf(enriched);
  const state = options.state ?? emptyRuleState();
  const findings: Finding[] = [];
  const errors: RuleError[] = [];
  const nextState: RuleState = { lastFired: { ...state.lastFired } };

  for (const rule of orderedRules(pack, options.phase)) {
    if (rule.emit.level === "none") continue; // "silent" = the rule is off
    try {
      // The rule's conditions are flat, so the only windows to collect are the
      // ones directly in `when`. A `where` filter may not contain a window.
      const windows: WindowResult[] = [];
      const ok = matchesWhen(rule.when.conditions, rule.when.combinator ?? "all", enriched, windows);
      if (!ok) continue;

      const cooldown = rule.cooldownMs ?? 0;
      if (cooldown > 0) {
        const last = state.lastFired[rule.id];
        if (last !== undefined && clock - last < cooldown) continue;
      }

      const finding = buildFinding(rule, enriched, clock, windows);
      if (!finding) continue;

      findings.push(finding);
      if (cooldown > 0) nextState.lastFired[rule.id] = clock;
    } catch (error) {
      errors.push({ ruleId: rule.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Suppression runs after the whole pass so it does not depend on rule order.
  // A rule never suppresses itself: the target set only ever holds ids named by
  // *other* rules that fired, and self-references are dropped here.
  const suppressed = new Set<string>();
  for (const finding of findings) {
    const rule = pack.rules.find((candidate) => candidate.id === finding.ruleId);
    for (const id of rule?.suppresses ?? []) {
      if (id !== finding.ruleId) suppressed.add(id);
    }
  }
  const kept = findings.filter((finding) => !suppressed.has(finding.ruleId));

  return {
    findings: kept,
    attention: attentionFrom(kept),
    state: nextState,
    errors,
    ...(options.phase ? { phase: options.phase } : {}),
  };
}

/** Judge the rules that apply while the run is in flight. */
export function evaluateLive(pack: RulePack, context: EvalContext, options: Omit<EvaluateOptions, "phase"> = {}): Evaluation {
  return evaluate(pack, context, { ...options, phase: "live" });
}

/** Judge the rules that apply once the run has settled. */
export function evaluateSettled(pack: RulePack, context: EvalContext, options: Omit<EvaluateOptions, "phase"> = {}): Evaluation {
  return evaluate(pack, context, { ...options, phase: "settled" });
}

/** Evaluate a flat condition list, keeping the windows it ran for evidence. */
function matchesWhen(
  conditions: Condition[],
  combinator: "all" | "any",
  context: EvalContext,
  windows: WindowResult[],
): boolean {
  let any = false;
  for (const condition of conditions) {
    const ok = conditionOk(condition, context, windows);
    if (combinator === "any") {
      if (ok) any = true;
    } else if (!ok) {
      return false;
    }
  }
  return combinator === "any" ? any : true;
}

function conditionOk(condition: Condition, context: EvalContext, windows: WindowResult[]): boolean {
  if ("window" in condition) {
    const result = windowFor(condition.window, context);
    windows.push(result);
    return result.matched;
  }
  return matches({ conditions: [condition] }, context, context);
}

function buildFinding(
  rule: Rule,
  context: EvalContext,
  clock: number,
  windows: WindowResult[],
): Finding | undefined {
  const level: AttentionLevel = rule.emit.level;
  const evidence = collectEvidence(rule.emit.evidence, context, windows);
  const vars = {
    evidence: evidence.length,
    rule: { id: rule.id, name: rule.name ?? rule.id },
    // Window numbers are addressable as `window.count`, `window.streak`, …
    // and `window.ids` for the events.
    window: windowVars(windows),
  };
  const templateContext = {
    facts: context.facts,
    live: context.live,
    session: context.session,
    vars,
  };
  const title = renderTemplate(rule.emit.title, templateContext).trim();
  const detail = rule.emit.detail ? renderTemplate(rule.emit.detail, templateContext).trim() : undefined;

  return {
    ruleId: rule.id,
    reason: rule.emit.reason ?? rule.id,
    level,
    title: title || rule.name || rule.id,
    ...(detail ? { detail } : {}),
    tags: rule.emit.tags ?? [],
    evidence,
    at: clock,
  };
}

/**
 * The values a template may read from the windows a rule ran. With one window
 * the numbers are bare (`{{vars.window.count}}`); with several they are also
 * available by index (`{{vars.window.1.count}}`).
 */
function windowVars(windows: WindowResult[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ids: windows.flatMap((result) => result.ids),
    matched: windows.some((result) => result.matched),
    count: windows.reduce((sum, result) => sum + result.value, 0),
  };
  windows.forEach((result, index) => {
    out[String(index)] = {
      measure: result.measure,
      value: result.value,
      count: result.value,
      selected: result.selected,
      ids: result.ids,
      firstAt: result.firstAt,
      lastAt: result.lastAt,
    };
    // A single window also publishes its measure name at the top level, so
    // `{{vars.window.streak}}` reads naturally for the common case.
    if (windows.length === 1) {
      out[result.measure] = result.value;
      out.selected = result.selected;
      out.firstAt = result.firstAt;
      out.lastAt = result.lastAt;
      out.gapMs = result.measure === "gapMs" ? result.value : out.gapMs;
    }
  });
  return out;
}

/** Flatten the evidence a rule asked for into event ids. */
function collectEvidence(
  paths: string[] | undefined,
  context: EvalContext,
  windows: WindowResult[],
): string[] {
  const out = new Set<string>();
  const take = (value: unknown): void => {
    if (typeof value === "string") {
      out.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) take(item);
      return;
    }
    if (value && typeof value === "object") {
      const maybe = (value as { evidence?: unknown }).evidence;
      if (maybe !== undefined) take(maybe);
    }
  };

  for (const path of paths ?? ["facts.evidence"]) {
    if (path.startsWith("window.")) {
      const rest = path.slice("window.".length);
      if (rest === "ids" || rest === "") {
        for (const result of windows) for (const id of result.ids) out.add(id);
        continue;
      }
      const [index, field] = rest.split(".");
      const result = windows[Number(index)];
      if (result && (field === "ids" || field === undefined)) {
        for (const id of result.ids) out.add(id);
      }
      continue;
    }
    const root = path.startsWith("live.")
      ? context.live
      : path.startsWith("session.")
        ? context.session
        : context.facts;
    take(resolvePath(root, path.replace(/^(facts|live|session)\./, "")));
  }

  // Every finding carries evidence, or it is not a finding.
  if (out.size === 0) for (const id of context.facts.evidence.slice(-5)) out.add(id);
  return [...out].slice(0, 32);
}

/** The verdict: the loudest finding wins, everything else is a reason. */
export function attentionFrom(findings: Finding[]): Attention {
  let level: AttentionLevel = "none";
  for (const finding of findings) level = maxLevel(level, finding.level);

  const reasons = [...new Set(findings.map((finding) => finding.reason))];
  const evidence = [...new Set(findings.flatMap((finding) => finding.evidence))].slice(0, 32);
  return { level, reasons, evidence, findings };
}

/**
 * One-shot evaluation with no cooldowns: "what would these rules have said?"
 *
 * This is a *simulation*, not a replay. A replay shows what was recorded at the
 * time; a simulation asks a hypothetical question and must never be mistaken for
 * the record. `simulate()` in index.ts labels the result accordingly.
 */
export function dryRun(pack: RulePack, context: EvalContext, phase?: RulePhase): Evaluation {
  return evaluate(pack, context, { phase, state: emptyRuleState() });
}

/** Findings at or above `minLevel`, newest first — the report's default cut. */
export function findingsAtLeast(findings: Finding[], minLevel: AttentionLevel): Finding[] {
  return findings
    .filter((finding) => LEVEL_RANK[finding.level] >= LEVEL_RANK[minLevel])
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.at - a.at);
}

/* ── The record ─────────────────────────────────────────────────────────── */

/**
 * What was judged, and by whom. This is what a faithful replay reads.
 *
 * Findings are recorded rather than recomputed on purpose: rules change, and a
 * report of a past run must show what was reported *then*. `packHash` names the
 * exact pack that judged it, so "why did this say high?" is always answerable.
 */
export interface FindingRecord {
  runId: string;
  phase: RulePhase;
  /** Content hash of the pack that produced these findings. */
  packHash: string;
  packName?: string;
  /** The clock the judgement was anchored to. */
  anchor: number;
  findings: Finding[];
  attention: Attention;
  errors: RuleError[];
}

/** Turn an evaluation into a record to persist next to the events. */
export function record(observation: {
  run: { id: string };
  facts: { lastActivityAt: number; run: { endedAt?: number } };
  attention: Attention;
  findings: Finding[];
  errors: RuleError[];
}, pack: RulePack, phase: RulePhase, anchor: number): FindingRecord {
  return {
    runId: observation.run.id,
    phase,
    packHash: hashPack(pack),
    ...(pack.name ? { packName: pack.name } : {}),
    anchor,
    findings: observation.findings,
    attention: observation.attention,
    errors: observation.errors,
  };
}
