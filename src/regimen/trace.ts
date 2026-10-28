/**
 * Why a rule did what it did — the answer an editor owes a user.
 *
 * `matches()` returns a boolean and drops everything else, which is right for the
 * evaluator (it runs on every event) and useless for a person: a rule that does
 * not fire says nothing about *which* condition said no. That is the difference
 * between a form and a tool, and it is why `previewRule` alone was not enough.
 *
 * This module walks the same `when` a second way, recording each leaf:
 *
 *   ok    the condition was true
 *   no    the condition was false (with what it actually saw)
 *   skip  `any` short-circuited before reaching it
 *   error the condition threw (a missing `context.events`, a bad path operator)
 *
 * Two invariants, so an explanation can never disagree with the verdict:
 *
 *   · it uses `evalCondition` — the *same* function the evaluator calls, not a
 *     re-implementation, so a condition cannot mean two things;
 *   · it is read-only. No windows are re-run to "double check", no state moves.
 *
 * Cost: a trace is O(conditions) on top of an evaluation that already happened,
 * and only the editor asks for one.
 */

import type { EvalContext } from "../core/types.ts";
import {
  describeCondition,
  evalCondition,
  resolvePath,
  type Condition,
  type When,
} from "./predicate.ts";
import { describeRule } from "./describe.ts";
import type { Rule } from "./rule.ts";

export type LeafOutcome = "ok" | "no" | "skip" | "error";

export interface ConditionTrace {
  /** Index into the flat condition list. */
  index: number;
  /** The condition, verbatim — the editor shows it. */
  condition: Condition;
  /** One sentence a human reads. */
  sentence: string;
  outcome: LeafOutcome;
  /**
   * What the field actually resolved to, for a compare condition. Absent for
   * windows and sequences, whose answer is a number the trace carries instead.
   */
  actual?: unknown;
  /** Why a leaf errored, when it did. */
  error?: string;
}

export interface RuleTrace {
  ruleId: string;
  /** The rule, as one sentence: what it watches and what it says. */
  sentence: string;
  /** Whether the whole `when` came out true. */
  matched: boolean;
  combinator: "all" | "any";
  conditions: ConditionTrace[];
  /**
   * The leaves responsible for the answer: the ones that said no under `all`, or
   * the ones that made it true. An editor highlights these and dims the rest.
   */
  decisive: number[];
  errors: string[];
}

/**
 * Trace one rule's conditions against a context.
 *
 * Mirrors `matchesWhen` in `evaluate.ts` exactly — including `any`
 * short-circuiting — because a trace that reports a condition the evaluator never
 * reached would be a nicer lie than the plain "no".
 */
export function traceRule(rule: Rule, context: EvalContext): RuleTrace {
  const combinator = rule.when.combinator ?? "all";
  const conditions = rule.when.conditions;
  const traces: ConditionTrace[] = [];
  let matched = combinator === "all";
  let shortCircuited = false;

  conditions.forEach((condition, index) => {
    const sentence = describeCondition(condition);
    if (shortCircuited) {
      traces.push({ index, condition, sentence, outcome: "skip" });
      return;
    }
    try {
      const ok = evalCondition(condition, context, context);
      traces.push({
        index,
        condition,
        sentence,
        outcome: ok ? "ok" : "no",
        ...(actualOf(condition, context) !== undefined ? { actual: actualOf(condition, context) } : {}),
      });
      if (combinator === "all") {
        if (!ok) {
          matched = false;
          shortCircuited = true;
        }
      } else if (ok) {
        matched = true;
        shortCircuited = true;
      }
    } catch (error) {
      traces.push({
        index,
        condition,
        sentence,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      if (combinator === "all") {
        matched = false;
      }
      shortCircuited = true;
    }
  });

  let decisive: number[];
  if (combinator === "all") {
    // `all` that failed: the condition(s) that said no. `all` that matched:
    // every condition is load-bearing, so all of them are the reason it fired.
    decisive = matched
      ? traces.filter((trace) => trace.outcome === "ok").map((trace) => trace.index)
      : traces.filter((trace) => trace.outcome === "no" || trace.outcome === "error").map((trace) => trace.index);
  } else {
    decisive = traces.filter((trace) => trace.outcome === "ok").map((trace) => trace.index);
  }

  return {
    ruleId: rule.id,
    sentence: describeRule(rule),
    matched,
    combinator,
    conditions: traces,
    decisive,
    errors: traces.filter((trace) => trace.outcome === "error").map((trace) => trace.error ?? ""),
  };
}

/** Trace a flat `where` (an array element or an event), for a quantifier row. */
export function traceWhen(when: When, item: unknown, context: EvalContext): RuleTrace {
  return traceAt({ id: "…", when, emit: { level: "none", title: "" } }, item, context);
}

/**
 * Trace a `when` whose paths resolve against `item` rather than the run.
 *
 * The evaluator does the same substitution for a `where` — it passes the element
 * as the context — so the two agree by construction.
 */
function traceAt(rule: Rule, item: unknown, _runContext: EvalContext): RuleTrace {
  return traceRule(rule, item as EvalContext);
}

/**
 * The value a compare condition saw.
 *
 * Only for plain field conditions: a window's answer is a count over events and a
 * sequence's is an ordering, so "what it saw" is not a path lookup and the trace
 * carries the sentence instead.
 */
function actualOf(condition: Condition, context: EvalContext): unknown {
  if ("window" in condition || "sequence" in condition) return undefined;
  const root = condition.field.startsWith("live.")
    ? context.live
    : condition.field.startsWith("session.")
      ? context.session
      : context.facts;
  return resolvePath(root, condition.field.replace(/^(facts|live|session)\./, ""));
}
