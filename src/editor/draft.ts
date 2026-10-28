/**
 * The editor model — everything a rule editor needs that is not a UI.
 *
 * A UI layer (React, a TUI, a CLI) should contain no rule logic. It asks this
 * module:
 *
 *   validateRule(rule)              → issues, with paths into the rule
 *   describeRule(rule)              → the one sentence to show in a list
 *   previewRule(rule, events, …)    → what the rule says about *this* run
 *   newRule(id)                     → a valid starting point
 *
 * `previewRule` is the button that makes custom rules usable rather than
 * mysterious: because judging is a pure function of the record, a half-written
 * rule can be run against the selected run and the answer shown immediately. It
 * is a **simulation** — it never touches the record.
 */

import type { ChartEvent } from "../core/events.ts";
import { DEFAULT_PACK } from "../regimen/defaults.ts";
import {
  describeWhen,
  operatorsFor,
  type OperatorInfo,
  type ValueKind,
} from "../regimen/predicate.ts";
import {
  impliedPhase,
  phaseOf,
  validatePack,
  type Rule,
  type RulePack,
  type RuleIssue,
  type RulePhase,
} from "../regimen/rule.ts";

// The derivation lives in the engine, not here: a UI must not be the only place
// that knows when a rule is judged. Re-exported so an editor can keep importing
// it from the model it already uses.
export { impliedPhase, phaseOf };
import { dryRun } from "../regimen/evaluate.ts";
import { describeRule as describeRuleOf } from "../regimen/describe.ts";
import { traceRule, type RuleTrace } from "../regimen/trace.ts";
import { checkTemplate, type TemplateIssue } from "../regimen/template.ts";
import { buildFacts } from "../facts/build.ts";
import { deriveRuns, pickRun } from "../facts/runs.ts";
import { withLive } from "../core/live.ts";
import type { EvalContext, Finding, LiveContext } from "../core/types.ts";
import { fieldFor } from "./catalog.ts";

/** A valid, minimal rule — what "+ new rule" starts from. */
export function newRule(id = "my.rule"): Rule {
  return {
    id,
    name: "My rule",
    description: "",
    priority: 0,
    when: {
      combinator: "all",
      conditions: [{ field: "facts.commands.failed", op: "gte", value: 1 }],
    },
    emit: {
      level: "medium",
      title: "{{facts.commands.failed}} commands failed",
      tags: [],
      evidence: ["facts.failed"],
    },
  };
}

/** Validate one rule in isolation (a pack-level check is `validatePack`). */
export function validateRule(rule: Rule): RuleIssue[] {
  return validatePack({ version: 1, rules: [rule] });
}

/**
 * The phase to show for a rule's conditions, or `both` when they say nothing.
 * The conditions are the declaration; see `impliedPhase` in the engine.
 */
export function phaseFromWhen(when: Rule["when"]): RulePhase {
  return impliedPhase(when) ?? "both";
}

/** The phase a rule is actually judged in. */
export function effectivePhase(rule: Rule): RulePhase {
  return phaseOf(rule);
}

/**
 * The rule with its legacy `phase` field brought in line with its conditions.
 *
 * An editor calls this on every condition change. It never *adds* a phase — the
 * conditions already decide, so the field is only ever removed when it is stale.
 * A rule whose conditions say nothing keeps whatever it had.
 */
export function withDerivedPhase(rule: Rule): Rule {
  if (impliedPhase(rule.when) === undefined || rule.phase === undefined) return rule;
  const { phase: _dropped, ...rest } = rule;
  return rest;
}

/** The sentence an editor shows for a rule: what it watches and what it says. */
export function describeRule(rule: Rule): string {
  return describeRuleOf(rule);
}

/** Operators to offer for a field path, based on the catalogue's type. */
export function operatorsForField(path: string): OperatorInfo[] {
  const info = fieldFor(path);
  return operatorsFor(info?.kind ?? "any");
}

export interface PreviewOptions {
  /** The clock windows are anchored to. Defaults to the run's last moment. */
  anchor?: number;
  live?: LiveContext;
  session?: { id?: string; project?: string };
  /** Which run to judge. Defaults to the newest. */
  runId?: string;
}

export interface RulePreview {
  findings: Finding[];
  errors: Array<{ ruleId: string; message: string }>;
  /** Whether the rule fired at all. */
  fired: boolean;
  /** True: this was a simulation, not the record. */
  hypothetical: true;
  /** The event count the rule was judged against. */
  events: number;
  /**
   * Which condition said no — or, when it fired, which ones made it fire.
   *
   * `fired: false` on its own is the reason custom rules felt mysterious: the
   * form could not tell a user *why* nothing happened. This is the answer, using
   * the same `evalCondition` the evaluator calls, so it cannot disagree with the
   * verdict.
   */
  trace: RuleTrace;
  /** Template problems in the rule's own wording (a typo'd path renders empty). */
  templateIssues: TemplateIssue[];
  /** The phase this preview actually judged, when one applied. */
  phase?: RulePhase;
}

/**
 * Judge one rule against a run. A simulation: it never writes a record and
 * never consults one, so it answers "what would this rule say about that run?".
 *
 * The result carries a `trace` and the wording's template issues, so an editor
 * can show *why* in the same interaction that shows *what*.
 */
export function previewRule(
  rule: Rule,
  events: readonly ChartEvent[],
  options: PreviewOptions = {},
): RulePreview | undefined {
  const run = pickRun(deriveRuns(events), options.runId);
  if (!run) return undefined;
  const facts = buildFacts(events, run);
  const slice = events.slice(run.fromIndex, run.toIndex + 1);
  const live = withLive(facts, options.live ?? {});
  const context: EvalContext = {
    facts,
    live,
    events: slice,
    anchor: options.anchor,
  };
  const pack: RulePack = { version: 1, name: "preview", rules: [rule] };
  const result = dryRun(pack, context);

  // The wording is checked against the same context the finding was built from,
  // so `{{vars.window.count}}` resolves for a rule that has a window, and is
  // reported as unresolved for one that does not.
  const templateContext = {
    facts,
    live,
    session: options.session,
    vars: {
      evidence: 0,
      rule: { id: rule.id, name: rule.name ?? rule.id },
      window: { ids: [], matched: false, count: 0 },
      sequence: { ids: [], matched: false, count: 0, step: {} },
    },
  };
  const templateIssues = [
    ...checkTemplate(rule.emit.title, templateContext),
    ...(rule.emit.detail ? checkTemplate(rule.emit.detail, templateContext) : []),
  ];

  return {
    findings: result.findings,
    errors: result.errors,
    fired: result.findings.length > 0,
    hypothetical: true,
    events: slice.length,
    trace: traceRule(rule, context),
    templateIssues,
    ...(result.phase ? { phase: result.phase } : {}),
  };
}

/** The pack with this rule inserted or replaced by id, ready to save. */
export function upsertRule(pack: RulePack, rule: Rule): RulePack {
  const index = pack.rules.findIndex((candidate) => candidate.id === rule.id);
  const rules = [...pack.rules];
  if (index === -1) rules.push(rule);
  else rules[index] = rule;
  return { ...pack, rules };
}

/** The pack without this rule. */
export function removeRule(pack: RulePack, id: string): RulePack {
  return { ...pack, rules: pack.rules.filter((rule) => rule.id !== id) };
}

/** A pack holding only the defaults, for "reset this pack". */
export function resetPack(name?: string): RulePack {
  const pack = structuredClone(DEFAULT_PACK);
  if (name) pack.name = name;
  return pack;
}

/**
 * Whether a rule id is free in this pack. An editor should warn before a new
 * rule silently replaces an existing one.
 */
export function isIdTaken(pack: RulePack, id: string): boolean {
  return pack.rules.some((rule) => rule.id === id);
}

/** A slug suggestion from a human title, e.g. "Five failures" → "user.five-failures". */
export function suggestId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `user.${slug || "rule"}`;
}

export type { ValueKind };

/**
 * Replace a rule in a pack **by position**, not by id.
 *
 * `upsertRule` matches on `id`, which is right for a save and catastrophic for an
 * edit: the rule editor's `id` field fires on every keystroke, so
 * `upsertRule(pack, { ...rule, id: "user.my-rul" })` misses the existing rule and
 * *appends a new one*. Typing four characters in the id field left five rules
 * behind, four of them unreachable.
 *
 * Editing needs a stable handle that is not the field being edited, so an editor
 * keyed by position uses this instead. The id stays a value; the position is the
 * identity.
 */
export function replaceRuleAt(pack: RulePack, index: number, rule: Rule): RulePack {
  if (index < 0 || index >= pack.rules.length) return upsertRule(pack, rule);
  const rules = [...pack.rules];
  rules[index] = rule;
  return { ...pack, rules };
}

/**
 * Move a rule to a new index, keeping array order — the grip on the card.
 * Order is evaluation order, so this is a behaviour change, not cosmetics.
 */
export function moveRuleTo(pack: RulePack, from: number, to: number): RulePack {
  if (from === to || from < 0 || from >= pack.rules.length) return pack;
  const rules = [...pack.rules];
  const [moved] = rules.splice(from, 1);
  if (!moved) return pack;
  rules.splice(Math.max(0, Math.min(to, rules.length)), 0, moved);
  return { ...pack, rules };
}

/**
 * Whether renaming to `id` would collide with a *different* rule.
 *
 * `isIdTaken` compares against the whole pack including the rule being renamed,
 * so it answered "taken" for the rule's own current id — which is why the editor
 * could not tell a real collision from itself.
 */
export function isIdTakenByOther(pack: RulePack, id: string, selfId: string): boolean {
  return pack.rules.some((rule) => rule.id === id && rule.id !== selfId);
}
