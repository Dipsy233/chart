/**
 * Regimen's condition language.
 *
 * A rule's `when` is a **flat** list of conditions with one combinator — the
 * firewall/WAF shape. `(A and B) or C` is written as two rules, not as nested
 * logic. That is not a limitation to be worked around later: a flat list is what
 * makes a rule explainable in one sentence, orderable in a UI, diffable in git,
 * and validatable without running it.
 *
 *   { "combinator": "all",              // or "any"; default "all"
 *     "conditions": [ … ] }
 *
 * Three kinds of condition:
 *
 *   { "field": "facts.commands.failed", "op": "gte", "value": 5 }
 *   { "field": "facts.processes.runningAtEnd", "quant": "any",
 *     "where": { "conditions": [ { "field": "name", "op": "eq", "value": "vite" } ] } }
 *   { "window": { … } }                 // see window.ts
 *
 * Negation is an operator (`ne`, `notContains`, `notExists`, …), never a
 * combinator, so there is no way to build a tree by accident.
 *
 * Inside a `where`, paths are relative to the array element or the event. A
 * `where` may only contain field conditions: no windows, no quantifiers. That is
 * the guard that keeps the language flat forever.
 */

import { compileGlob } from "../facts/glob.ts";
import type { EvalContext } from "../core/types.ts";
import { runWindow, WINDOW_MEASURES, type WindowResult, type WindowSpec } from "./window.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ScalarOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "notIn"
  | "contains"
  | "notContains"
  | "startsWith"
  | "notStartsWith"
  | "endsWith"
  | "notEndsWith"
  | "matches"
  | "notMatches"
  | "glob"
  | "notGlob"
  | "between"
  | "exists"
  | "notExists"
  | "empty"
  | "nonEmpty";

export const SCALAR_OPS: ScalarOp[] = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "notContains",
  "startsWith",
  "notStartsWith",
  "endsWith",
  "notEndsWith",
  "matches",
  "notMatches",
  "glob",
  "notGlob",
  "between",
  "exists",
  "notExists",
  "empty",
  "nonEmpty",
];

/** Negations are evaluated as `!positive`, so arrays stay consistent. */
const NEGATED: Partial<Record<ScalarOp, ScalarOp>> = {
  ne: "eq",
  notIn: "in",
  notContains: "contains",
  notStartsWith: "startsWith",
  notEndsWith: "endsWith",
  notMatches: "matches",
  notGlob: "glob",
  notExists: "exists",
};

export type Quant = "any" | "all" | "none" | "count";

export const QUANTS: Quant[] = ["any", "all", "none", "count"];

/** A flat list of conditions with one combinator. The only logical grouping. */
export interface When {
  combinator?: "all" | "any";
  conditions: Condition[];
}

export type Condition = FieldCondition | QuantCondition | WindowCondition;

export interface FieldCondition {
  field: string;
  op: ScalarOp;
  value?: JsonValue;
}

export interface QuantCondition {
  field: string;
  quant: Quant;
  op?: ScalarOp;
  value?: JsonValue;
  where?: When;
}

export interface WindowCondition {
  window: WindowSpec;
}

/* ── Values ─────────────────────────────────────────────────────────────── */

const regexCache = new Map<string, RegExp | undefined>();
const MAX_PATTERN = 256;
const MAX_REGEX_INPUT = 4096;

function regex(pattern: string): RegExp | undefined {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN) return undefined;
  if (regexCache.has(pattern)) return regexCache.get(pattern);
  let compiled: RegExp | undefined;
  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = undefined;
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

/** Resolve a dot path (`facts.files.modified`) against any object. */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePrimitive(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => samePrimitive(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => samePrimitive(a[key], b[key]));
  }
  return false;
}

function toComparable(value: unknown): number | string | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

function order(left: unknown, right: unknown): number | undefined {
  const a = toComparable(left);
  const b = toComparable(right);
  if (a === undefined || b === undefined) return undefined;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Compare one value with one expected value. Arrays match element-wise. */
export function compare(op: ScalarOp, actual: unknown, expected: JsonValue | undefined): boolean {
  return evalScalar(op, actual, expected);
}

function evalScalar(op: ScalarOp, actual: unknown, expected: JsonValue | undefined): boolean {
  const negated = NEGATED[op];
  if (negated) return !evalScalar(negated, actual, expected);

  if (op === "exists") return actual !== undefined && actual !== null;
  if (op === "empty") return isEmpty(actual);
  if (op === "nonEmpty") return !isEmpty(actual);

  // An array matches when any element matches, for every set-style operator.
  if (Array.isArray(actual)) {
    const elements = actual;
    switch (op) {
      case "in":
        return Array.isArray(expected) && expected.some((want) => elements.some((item) => samePrimitive(item, want)));
      case "contains":
        return elements.some((item) => samePrimitive(item, expected));
      case "eq":
        return samePrimitive(elements, expected);
      default:
        return elements.some((item) => evalScalar(op, item, expected));
    }
  }

  switch (op) {
    case "eq":
      return samePrimitive(actual, expected);
    case "gt": {
      const c = order(actual, expected);
      return c !== undefined && c > 0;
    }
    case "gte": {
      const c = order(actual, expected);
      return c !== undefined && c >= 0;
    }
    case "lt": {
      const c = order(actual, expected);
      return c !== undefined && c < 0;
    }
    case "lte": {
      const c = order(actual, expected);
      return c !== undefined && c <= 0;
    }
    case "between": {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const low = order(actual, expected[0]!);
      const high = order(actual, expected[1]!);
      return low !== undefined && high !== undefined && low >= 0 && high <= 0;
    }
    case "in":
      return Array.isArray(expected) && expected.some((want) => samePrimitive(actual, want));
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "startsWith":
      return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    case "endsWith":
      return typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected);
    case "matches": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      const compiled = regex(expected);
      return compiled !== undefined && compiled.test(actual.slice(0, MAX_REGEX_INPUT));
    }
    case "glob": {
      if (typeof expected !== "string") return false;
      const compiled = compileGlob(expected);
      if (!compiled) return false;
      return [actual].some((value) => {
        if (typeof value !== "string") return false;
        const normalised = value.replace(/\\/g, "/");
        if (compiled.test(normalised)) return true;
        const name = normalised.slice(normalised.lastIndexOf("/") + 1);
        return !expected.includes("/") && compiled.test(name);
      });
    }
    default:
      return false;
  }
}

/* ── Evaluation ─────────────────────────────────────────────────────────── */

/** The anchor windows are measured against. Always an input, never a clock. */
export function anchorOf(context: EvalContext): number {
  return context.anchor ?? context.live.nowMs ?? context.facts.run.endedAt ?? context.facts.lastActivityAt;
}

/** Evaluate a flat list of conditions against an object (a context or an item). */
export function matches(when: When, item: unknown, context?: EvalContext): boolean {
  const combinator = when.combinator ?? "all";
  const results = when.conditions.map((condition) => evalCondition(condition, item, context));
  return combinator === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** Evaluate one condition. `context` is only needed for `window` (it holds the events). */
export function evalCondition(condition: Condition, item: unknown, context?: EvalContext): boolean {
  if ("window" in condition) {
    // A window needs the stream. Missing events is a rule error, not a "false":
    // silently answering false would hide a mis-wired host forever.
    if (!context) throw new Error("a window condition needs an evaluation context with `events`");
    return windowFor(condition.window, context).matched;
  }

  const actual = resolvePath(item, condition.field);

  if ("quant" in condition) {
    const list = Array.isArray(actual) ? actual : [];
    const where = condition.where;
    const hit = (element: unknown) => (where ? matches(where, element, context) : true);
    switch (condition.quant) {
      case "any":
        return list.some(hit);
      case "all":
        return list.every(hit);
      case "none":
        return !list.some(hit);
      case "count": {
        const n = list.filter(hit).length;
        return evalScalar(condition.op ?? "gte", n, condition.value);
      }
    }
  }

  return evalScalar(condition.op, actual, condition.value);
}

/** Run a window condition and keep the result (the evaluator wants the evidence). */
export function windowFor(spec: WindowSpec, context: EvalContext): WindowResult {
  if (!context.events) throw new Error("a window condition needs `context.events` (the run's event stream)");
  return runWindow(spec, context.events, anchorOf(context), {
    matches: (when, element) => matches(when, element, context),
    compare: (op, actual, expected) => compare(op, actual, expected),
    readPath: (element, path) => resolvePath(element, path),
  });
}

/* ── Validation ─────────────────────────────────────────────────────────── */

export interface PredicateIssue {
  path: string;
  message: string;
}

const FIELD_ONLY_OPS: ScalarOp[] = SCALAR_OPS;

/**
 * Check a `when` without evaluating it. Returns every problem with a JSON-ish
 * path so an editor can point at the offending condition.
 */
export function validateWhen(when: unknown, path = "when"): PredicateIssue[] {
  const issues: PredicateIssue[] = [];
  if (!isPlainObject(when)) return [{ path, message: "expected { combinator, conditions }" }];
  if (when["combinator"] !== undefined && when["combinator"] !== "all" && when["combinator"] !== "any") {
    issues.push({ path: `${path}.combinator`, message: 'expected "all" or "any"' });
  }
  const conditions = when["conditions"];
  if (!Array.isArray(conditions) || conditions.length === 0) {
    issues.push({ path: `${path}.conditions`, message: "expected a non-empty array of conditions" });
    return issues;
  }
  conditions.forEach((condition, index) => {
    issues.push(...validateCondition(condition, `${path}.conditions[${index}]`, true));
  });
  return issues;
}

function validateCondition(condition: unknown, path: string, allowWindow: boolean): PredicateIssue[] {
  if (!isPlainObject(condition)) return [{ path, message: "expected a condition object" }];

  if ("window" in condition) {
    if (!allowWindow) {
      return [{ path, message: "a window is not allowed inside a where — add a fact instead" }];
    }
    return validateWindow(condition["window"], `${path}.window`);
  }

  if (typeof condition["field"] !== "string" || condition["field"].length === 0) {
    return [{ path: `${path}.field`, message: "expected a non-empty field path" }];
  }

  if ("quant" in condition) {
    const issues: PredicateIssue[] = [];
    if (!QUANTS.includes(condition["quant"] as Quant)) {
      issues.push({ path: `${path}.quant`, message: `expected one of ${QUANTS.join(", ")}` });
    }
    if (condition["quant"] === "count" && condition["op"] === undefined) {
      issues.push({ path: `${path}.op`, message: "count needs a comparison op (e.g. gte)" });
    }
    if (condition["op"] !== undefined && !FIELD_ONLY_OPS.includes(condition["op"] as ScalarOp)) {
      issues.push({ path: `${path}.op`, message: `expected one of ${FIELD_ONLY_OPS.join(", ")}` });
    }
    if (condition["where"] !== undefined) {
      issues.push(...validateWhen(condition["where"], `${path}.where`));
      // A where is field conditions only: no windows, no nested quantifiers.
      for (const nested of asConditions(condition["where"])) {
        if ("window" in nested) {
          issues.push({ path: `${path}.where`, message: "a window is not allowed inside a where" });
        }
        if ("quant" in nested) {
          issues.push({ path: `${path}.where`, message: "a quantifier is not allowed inside a where" });
        }
      }
    }
    return issues;
  }

  const op = condition["op"];
  if (!FIELD_ONLY_OPS.includes(op as ScalarOp)) {
    return [{ path: `${path}.op`, message: `expected one of ${FIELD_ONLY_OPS.join(", ")}` }];
  }
  const issues: PredicateIssue[] = [];
  if ((op === "in" || op === "notIn") && !Array.isArray(condition["value"])) {
    issues.push({ path: `${path}.value`, message: "in/notIn need an array value" });
  }
  if (op === "between" && (!Array.isArray(condition["value"]) || condition["value"].length !== 2)) {
    issues.push({ path: `${path}.value`, message: "between needs a [min, max] pair" });
  }
  if (op === "matches" || op === "notMatches") {
    const pattern = condition["value"];
    if (typeof pattern !== "string") {
      issues.push({ path: `${path}.value`, message: "matches needs a regex string" });
    } else if (regex(pattern) === undefined) {
      issues.push({ path: `${path}.value`, message: "invalid or oversized regex" });
    }
  }
  return issues;
}

function asConditions(when: unknown): Condition[] {
  if (!isPlainObject(when) || !Array.isArray(when["conditions"])) return [];
  return when["conditions"] as Condition[];
}

function validateWindow(spec: unknown, path: string): PredicateIssue[] {
  if (!isPlainObject(spec)) return [{ path, message: "expected a window object" }];
  const issues: PredicateIssue[] = [];
  const measure = spec["measure"];
  if (!WINDOW_MEASURES.includes(measure as never)) {
    issues.push({ path: `${path}.measure`, message: `expected one of ${WINDOW_MEASURES.join(", ")}` });
  }
  if (typeof spec["op"] !== "string" || !SCALAR_OPS.includes(spec["op"] as ScalarOp)) {
    issues.push({ path: `${path}.op`, message: "expected a comparison op" });
  }
  if ((measure === "sum" || measure === "max" || measure === "min" || measure === "avg") && typeof spec["of"] !== "string") {
    issues.push({ path: `${path}.of`, message: `${String(measure)} needs an \`of\` path inside the event` });
  }
  const span = spec["span"];
  if (span !== undefined) {
    if (!isPlainObject(span)) {
      issues.push({ path: `${path}.span`, message: "expected { lastMs?, nextMs? }" });
    } else {
      for (const key of ["lastMs", "nextMs"] as const) {
        const value = span[key];
        if (value !== undefined && !(typeof value === "number" && value >= 0)) {
          issues.push({ path: `${path}.span.${key}`, message: "expected a non-negative number of milliseconds" });
        }
      }
      if (span["lastMs"] === undefined && span["nextMs"] === undefined) {
        issues.push({ path: `${path}.span`, message: "a span needs lastMs or nextMs" });
      }
    }
  }
  const events = spec["events"];
  if (events !== undefined) {
    if (!isPlainObject(events)) {
      issues.push({ path: `${path}.events`, message: "expected { type?, where? }" });
    } else if (events["where"] !== undefined) {
      issues.push(...validateWhen(events["where"], `${path}.events.where`));
      for (const nested of asConditions(events["where"])) {
        if ("window" in nested) {
          issues.push({ path: `${path}.events.where`, message: "a window is not allowed inside a where" });
        }
      }
    }
  }
  return issues;
}

/* ── Description (for the rule editor) ──────────────────────────────────── */

const OP_WORDS: Record<ScalarOp, string> = {
  eq: "is",
  ne: "is not",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "is one of",
  notIn: "is none of",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  notStartsWith: "does not start with",
  endsWith: "ends with",
  notEndsWith: "does not end with",
  matches: "matches",
  notMatches: "does not match",
  glob: "matches files",
  notGlob: "matches no file",
  between: "is between",
  exists: "exists",
  notExists: "does not exist",
  empty: "is empty",
  nonEmpty: "is not empty",
};

/** A human sentence for a `when`. Used by the editor and by finding details. */
export function describeWhen(when: When): string {
  const joiner = (when.combinator ?? "all") === "any" ? " or " : " and ";
  return when.conditions.map(describeCondition).join(joiner);
}

export function describeCondition(condition: Condition): string {
  if ("window" in condition) return describeWindow(condition.window);
  const label = condition.field;
  if ("quant" in condition) {
    const where = condition.where ? ` that ${describeWhen(condition.where)}` : "";
    if (condition.quant === "count") {
      return `count of ${label}${where} ${OP_WORDS[condition.op ?? "gte"]} ${String(condition.value)}`;
    }
    return `${condition.quant} ${label}${where}`;
  }
  const value = condition.value === undefined ? "" : ` ${formatValue(condition.value)}`;
  return `${label} ${OP_WORDS[condition.op]}${value}`;
}

export function describeWindow(spec: WindowSpec): string {
  const types = spec.events?.type;
  const subject = types === undefined ? "events" : Array.isArray(types) ? types.join("/") : types;
  const where = spec.events?.where ? ` where ${describeWhen(spec.events.where)}` : "";
  const span =
    spec.span?.lastMs !== undefined
      ? ` in the last ${spec.span.lastMs}ms`
      : spec.span?.nextMs !== undefined
        ? ` in the next ${spec.span.nextMs}ms`
        : "";
  const of = spec.of ? ` of ${spec.of}` : "";
  return `${spec.measure}${of} of ${subject}${where}${span} ${OP_WORDS[spec.op]} ${String(spec.value ?? "")}`.replace(
    /\s+/g,
    " ",
  );
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (value === null) return "null";
  return String(value);
}

/* ── Operator catalogue (for an editor's condition builder) ─────────────── */

export type ValueKind = "string" | "number" | "boolean" | "dateTime" | "array" | "object" | "any";

export interface OperatorInfo {
  /** The value kind this operator belongs to. */
  type: ValueKind;
  operation: ScalarOp;
  /** How the editor labels it. */
  label: string;
  /** Whether it needs no right-hand value. */
  unary?: boolean;
}

/**
 * Which operators make sense for which kind of value — the same idea n8n's
 * IF/Filter node uses (an `operator: { type, operation }` pair per condition),
 * so an editor can show a short list instead of all 22.
 */
export const OPERATOR_CATALOG: OperatorInfo[] = [
  // Every kind can be asked whether it exists.
  ...(["string", "number", "boolean", "dateTime", "array", "object"] as ValueKind[]).flatMap(
    (type): OperatorInfo[] => [
      { type, operation: "exists", label: "exists", unary: true },
      { type, operation: "notExists", label: "does not exist", unary: true },
      { type, operation: "empty", label: "is empty", unary: true },
      { type, operation: "nonEmpty", label: "is not empty", unary: true },
    ],
  ),
  { type: "string", operation: "eq", label: "equals" },
  { type: "string", operation: "ne", label: "not equals" },
  { type: "string", operation: "contains", label: "contains" },
  { type: "string", operation: "notContains", label: "does not contain" },
  { type: "string", operation: "startsWith", label: "starts with" },
  { type: "string", operation: "notStartsWith", label: "does not start with" },
  { type: "string", operation: "endsWith", label: "ends with" },
  { type: "string", operation: "notEndsWith", label: "does not end with" },
  { type: "string", operation: "matches", label: "matches regex" },
  { type: "string", operation: "notMatches", label: "does not match regex" },
  { type: "string", operation: "glob", label: "matches glob" },
  { type: "string", operation: "notGlob", label: "matches no glob" },
  { type: "number", operation: "eq", label: "equals" },
  { type: "number", operation: "ne", label: "not equals" },
  { type: "number", operation: "gt", label: "greater than" },
  { type: "number", operation: "gte", label: "greater than or equal" },
  { type: "number", operation: "lt", label: "less than" },
  { type: "number", operation: "lte", label: "less than or equal" },
  { type: "number", operation: "between", label: "between" },
  { type: "number", operation: "in", label: "is one of" },
  { type: "number", operation: "notIn", label: "is none of" },
  { type: "dateTime", operation: "gt", label: "is after" },
  { type: "dateTime", operation: "gte", label: "is at or after" },
  { type: "dateTime", operation: "lt", label: "is before" },
  { type: "dateTime", operation: "lte", label: "is at or before" },
  { type: "dateTime", operation: "between", label: "is between" },
  { type: "boolean", operation: "eq", label: "is" },
  { type: "boolean", operation: "ne", label: "is not" },
  { type: "array", operation: "contains", label: "contains" },
  { type: "array", operation: "notContains", label: "does not contain" },
  { type: "array", operation: "eq", label: "equals" },
  { type: "object", operation: "eq", label: "equals" },
  { type: "object", operation: "ne", label: "not equals" },
];

/**
 * The operators an editor should offer for a value kind. `any` (the kind used
 * when a field's type is unknown) returns every distinct operation once, so an
 * editor never has to guess.
 */
export function operatorsFor(type: ValueKind): OperatorInfo[] {
  if (type !== "any") return OPERATOR_CATALOG.filter((operator) => operator.type === type);
  const seen = new Set<ScalarOp>();
  const out: OperatorInfo[] = [];
  for (const operator of OPERATOR_CATALOG) {
    if (seen.has(operator.operation)) continue;
    seen.add(operator.operation);
    out.push({ ...operator, type: "any" });
  }
  return out;
}
