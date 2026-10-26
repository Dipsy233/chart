/**
 * A Regimen rule is data: a flat list of conditions, a verdict, and the words
 * to say.
 *
 * Deliberately *not* a workflow. There is no `action`, no branch, no call-out.
 * Chart observes; a rule may only produce a finding. That single constraint is
 * what keeps the engine replayable (see docs/DESIGN.md) and what stops the
 * observer from ever touching the observed agent.
 *
 * `phase` says when a rule can be judged:
 *
 *   live     — while the run is in flight, anchored at `now`
 *   settled  — once at the end, anchored at the run's last moment
 *   both     — either (the default)
 *
 * A leftover process only makes sense settled; a stall only makes sense live.
 * The old engine hard-coded that distinction into which branch read which input;
 * here it is a field, so a user's rule declares it too.
 */

import type { AttentionLevel, Finding } from "../core/types.ts";
import { isLevel } from "../core/types.ts";
import type { When } from "./predicate.ts";
import { validateWhen } from "./predicate.ts";

export type RulePhase = "live" | "settled" | "both";

export interface RuleEmit {
  /** Stable slug used in `Attention.reasons`. Defaults to the rule id. */
  reason?: string;
  level: AttentionLevel;
  /** One line, `{{path}}` templates allowed. */
  title: string;
  /** Optional second line. */
  detail?: string;
  /** Free-form labels for filtering a report. */
  tags?: string[];
  /**
   * Where to collect evidence from. Paths into the facts (`facts.failed`), or
   * `window.ids` for the events a window condition selected. Defaults to
   * `facts.evidence`.
   */
  evidence?: string[];
}

export interface Rule {
  id: string;
  /** Shown in the UI; falls back to the id. */
  name?: string;
  /** What the rule is for, in one sentence. */
  description?: string;
  /** `live` / `settled` / `both` (default). */
  phase?: RulePhase;
  /** Higher runs first. Ties keep file order. */
  priority?: number;
  /** A flat list of conditions with one combinator. */
  when: When;
  emit: RuleEmit;
  /**
   * After firing, do not fire again for this many milliseconds (live
   * evaluations only — a settled run evaluates once). 0 = every time.
   */
  cooldownMs?: number;
  /**
   * Rule ids this rule silences when it fires. The classic use: a count rule
   * should not also be reported while the unresolved-failure rule is speaking.
   */
  suppresses?: string[];
  /** Off = kept in the pack but never evaluated. */
  enabled?: boolean;
  /** For the editor: where the rule came from. */
  source?: "default" | "user";
}

export interface RulePack {
  /** Pack format version, so a future migration can be detected. */
  version: 1;
  /** Display name of the pack. */
  name?: string;
  rules: Rule[];
}

export interface RuleIssue {
  ruleId: string;
  path: string;
  message: string;
}

const PHASES: RulePhase[] = ["live", "settled", "both"];

/**
 * Validate a pack. Returns every problem rather than the first, because a rule
 * editor that only reports one error at a time is unusable.
 */
export function validatePack(pack: unknown): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (typeof pack !== "object" || pack === null) {
    return [{ ruleId: "", path: "", message: "a pack must be an object" }];
  }
  const candidate = pack as Partial<RulePack>;
  if (candidate.version !== 1) {
    issues.push({ ruleId: "", path: "version", message: "expected version 1" });
  }
  if (!Array.isArray(candidate.rules)) {
    issues.push({ ruleId: "", path: "rules", message: "expected an array of rules" });
    return issues;
  }
  const seen = new Set<string>();
  candidate.rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    const id = typeof rule?.id === "string" ? rule.id : "";
    if (!id) issues.push({ ruleId: "", path: `${at}.id`, message: "a rule needs an id" });
    else if (seen.has(id)) issues.push({ ruleId: id, path: `${at}.id`, message: "duplicate rule id" });
    else seen.add(id);

    if (rule?.when === undefined) {
      issues.push({ ruleId: id, path: `${at}.when`, message: "a rule needs a when block" });
    } else {
      for (const issue of validateWhen(rule.when, `${at}.when`)) {
        issues.push({ ruleId: id, path: issue.path, message: issue.message });
      }
    }

    if (rule?.phase !== undefined && !PHASES.includes(rule.phase)) {
      issues.push({ ruleId: id, path: `${at}.phase`, message: `expected one of ${PHASES.join(", ")}` });
    }

    const emit = rule?.emit;
    if (!emit || typeof emit !== "object") {
      issues.push({ ruleId: id, path: `${at}.emit`, message: "a rule needs an emit block" });
    } else {
      if (!isLevel(emit.level)) {
        issues.push({
          ruleId: id,
          path: `${at}.emit.level`,
          message: "expected one of none, low, medium, high",
        });
      }
      if (typeof emit.title !== "string" || emit.title.trim().length === 0) {
        issues.push({ ruleId: id, path: `${at}.emit.title`, message: "a rule needs a title" });
      }
    }

    if (rule?.cooldownMs !== undefined && !(typeof rule.cooldownMs === "number" && rule.cooldownMs >= 0)) {
      issues.push({ ruleId: id, path: `${at}.cooldownMs`, message: "expected a non-negative number" });
    }
    if (rule?.suppresses !== undefined) {
      if (!Array.isArray(rule.suppresses) || rule.suppresses.some((value) => typeof value !== "string")) {
        issues.push({ ruleId: id, path: `${at}.suppresses`, message: "expected an array of rule ids" });
      }
    }
  });
  return issues;
}

/** Rules in evaluation order: enabled, highest priority first, stable otherwise. */
export function orderedRules(pack: RulePack, phase?: RulePhase): Rule[] {
  return pack.rules
    .map((rule, index) => ({ rule, index }))
    .filter((entry) => entry.rule.enabled !== false)
    .filter((entry) => !phase || appliesInPhase(entry.rule, phase))
    .sort((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index)
    .map((entry) => entry.rule);
}

/** Whether a rule is judged in this phase. `both` (the default) is always. */
export function appliesInPhase(rule: Rule, phase: RulePhase): boolean {
  const declared = rule.phase ?? "both";
  return declared === "both" || declared === phase;
}

/**
 * Merge packs into one, later rules overriding earlier ones by id.
 *
 * The normal shape of a user pack is "the defaults, plus my rules, minus the
 * two I disagree with" — `mergePacks(DEFAULT_PACK, myPack)` says exactly that,
 * and a rule with `enabled: false` is how you switch a default off without
 * copying its conditions.
 */
export function mergePacks(...packs: RulePack[]): RulePack {
  const byId = new Map<string, Rule>();
  const order: string[] = [];
  for (const pack of packs) {
    for (const rule of pack.rules) {
      if (!byId.has(rule.id)) order.push(rule.id);
      byId.set(rule.id, rule);
    }
  }
  return {
    version: 1,
    name: packs.map((pack) => pack.name).filter(Boolean).join(" + ") || "merged",
    rules: order.map((id) => byId.get(id)!).filter(Boolean),
  };
}

/** A stable content hash, so a recorded finding can name the pack that judged it. */
export function hashPack(pack: RulePack): string {
  const json = JSON.stringify(pack);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export type { Finding };
