/**
 * One-sentence descriptions of a rule, in the engine rather than the editor.
 *
 * `describeWhen` lives in `predicate.ts` (it is about conditions), but "what
 * this rule is for" is about the *rule*, and both the editor and the trace want
 * it. Keeping it here means `regimen/trace.ts` can describe a rule without
 * importing `editor/`, which imports regimen — a cycle the layering forbids.
 */

import type { Rule } from "./rule.ts";
import { describeWhen } from "./predicate.ts";

/** The sentence an editor shows for a rule: what it watches and what it says. */
export function describeRule(rule: Rule): string {
  const level = rule.emit.level === "none" ? "off" : rule.emit.level;
  return `${describeWhen(rule.when)} → ${level}`;
}
