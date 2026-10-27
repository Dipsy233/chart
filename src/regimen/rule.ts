/**
 * A Regimen rule is data: a flat list of conditions, a verdict, and the words
 * to say.
 *
 * Deliberately *not* a workflow. There is no `action`, no branch, no call-out.
 * Chart observes; a rule may only produce a finding. That single constraint is
 * what keeps the engine replayable (see docs/DESIGN.md) and what stops the
 * observer from ever touching the observed agent.
 *
 * `phase` — when a rule can be judged — is **derived from the conditions**, not
 * declared:
 *
 *   no `facts.ended` condition   both     (judged throughout — the default)
 *   `facts.ended = true`         settled  (only once the run has ended)
 *   `facts.ended = false`        live     (only while it is still running)
 *
 * A leftover process only makes sense settled; a stall only makes sense live. The
 * old engine hard-coded that distinction into which branch read which input, then
 * this engine made it a field, and now the field is gone too: "only after the run
 * ended" is already a condition, and saying it twice is one time too many.
 *
 * The optional `phase` field survives only as an escape hatch for packs written
 * before this change; conditions win when they say anything, and a declaration
 * that contradicts them is rejected (see `validatePack`).
 */

import type { AttentionLevel, Finding } from "../core/types.ts";
import { isLevel } from "../core/types.ts";
import type { When } from "./predicate.ts";
import { validateWhen } from "./predicate.ts";
import { isValidReason, RESERVED_REASONS } from "./reasons.ts";

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
  /**
   * Legacy: derived from the conditions, so a new rule never sets this.
   * Honoured only when the conditions say nothing about `facts.ended`.
   */
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
    } else if (rule?.phase !== undefined && rule?.when !== undefined) {
      // The conditions are the declaration; a legacy field that disagrees with
      // them is silently ignored by `phaseOf`, which is worse than an error.
      const implied = impliedPhase(rule.when);
      const declared = rule.phase === "both" ? undefined : rule.phase;
      if (implied !== undefined && declared !== undefined && implied !== declared) {
        issues.push({
          ruleId: id,
          path: `${at}.phase`,
          message: `\`phase: "${rule.phase}"\` contradicts the conditions, which imply "${implied}" — drop the field, the conditions decide`,
        });
      }
    }

    // A rule that waits for the run to end cannot also be judged only while it
    // is running: nothing says so, and the rule would never fire.
    if (rule?.phase === "live" && requiresEnded(rule.when)) {
      issues.push({
        ruleId: id,
        path: `${at}.when`,
        message:
          'this rule can never fire: phase is "live" but the conditions require facts.ended to be true — drop the ended condition, or judge it settled/both',
      });
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
      // The reason is the machine-readable key a report compares on, so it is a
      // closed vocabulary: a reserved slug, or the rule's own namespace.
      if (emit.reason !== undefined && !isValidReason(emit.reason)) {
        issues.push({
          ruleId: id,
          path: `${at}.emit.reason`,
          message: `expected a reserved reason (${RESERVED_REASONS.slice(0, 3).join(", ")}, …) or a namespaced one like "user.${id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}"`,
        });
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

/**
 * The phase a rule's conditions *pin down*, or `undefined` if they say nothing.
 *
 * This is the engine's single answer to "when is this rule judged", so a pack
 * cannot disagree with itself: the conditions are the declaration. `undefined`
 * means "the conditions do not care", which leaves a legacy `phase` field (or
 * `both`) in charge.
 *
 * Only `all` pins anything: with `any`, an ended-branch is one way to fire and
 * the other branches still work mid-run, so no phase can be inferred.
 */
export function impliedPhase(when: When | undefined): RulePhase | undefined {
  if (!when || !Array.isArray(when.conditions)) return undefined;
  if ((when.combinator ?? "all") !== "all") return undefined;
  for (const condition of when.conditions) {
    if (!("field" in condition) || condition.field !== "facts.ended") continue;
    switch (condition.op) {
      case "eq":
        if (condition.value === true) return "settled";
        if (condition.value === false) return "live";
        break;
      case "ne":
        if (condition.value === true) return "live";
        if (condition.value === false) return "settled";
        break;
      case "exists":
        return "settled";
      case "notExists":
        return "live";
      default:
        break;
    }
  }
  return undefined;
}

/**
 * The phase a rule is judged in: what its conditions imply, else the legacy
 * `phase` field, else `both`.
 */
export function phaseOf(rule: Rule): RulePhase {
  return impliedPhase(rule.when) ?? rule.phase ?? "both";
}

/**
 * Whether the conditions can only be true once the run has ended.
 *
 * Only the top-level conditions are inspected — a `where` filter reads an array
 * element or an event, never the run's own ended flag, so an `ended` path inside
 * one is not this pattern. `eq: true` is the positive form; a negated op
 * (`ne: true`, or `eq: false`) requires the opposite.
 */
function requiresEnded(when: When | undefined): boolean {
  return impliedPhase(when) === "settled";
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
  const declared = phaseOf(rule);
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
