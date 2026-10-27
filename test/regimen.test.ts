import { check, checkEqual, finish, section } from "./harness.ts";
import {
  compare,
  describeWhen,
  matches,
  operatorsFor,
  resolvePath,
  validateWhen,
  type Condition,
  type When,
} from "../src/regimen/predicate.ts";
import { runWindow } from "../src/regimen/window.ts";
import { runSequence } from "../src/regimen/sequence.ts";
import { renderTemplate, formatDuration, plural } from "../src/regimen/template.ts";
import { evaluate, emptyRuleState } from "../src/regimen/evaluate.ts";
import { hashPack, mergePacks, orderedRules, validatePack, type RulePack } from "../src/regimen/rule.ts";
import { DEFAULT_PACK } from "../src/regimen/defaults.ts";
import { EXAMPLE_PACK } from "../src/regimen/examples.ts";
import { factsOf, resetEventIds, session } from "./fixtures.ts";
import type { ChartEvent } from "../src/core/events.ts";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const ctx = {
  facts: {
    commands: { failed: 5, total: 7 },
    files: { created: ["company/intro.txt", "src/a.ts"] },
    processes: {
      runningAtEnd: [
        { pid: 1, name: "vite", lifetimeMs: 60_000 },
        { pid: 2, name: "cat", lifetimeMs: 200 },
      ],
    },
    errors: { total: 1 },
    ended: true,
    run: { status: "completed" },
    evidence: ["e1", "e2"],
  },
  live: { stalledSeconds: 4000, busy: true },
  session: {},
};

const one = (condition: Condition): When => ({ conditions: [condition] });
// The same object serves as the item (field paths) and the context (events).
const yes = (when: When, context: unknown = ctx) => matches(when, context, context as never);
const no = (when: When, context: unknown = ctx) => !matches(when, context, context as never);

function windowEvents(): ChartEvent[] {
  resetEventIds();
  const s = session();
  s.agentStart(); // 2000
  s.command("false", 1); // 3000
  s.command("false", 1); // 4000
  s.command("true", 0); // 5000  ← breaks the streak
  s.command("false", 1); // 6000
  s.command("false", 1); // 7000
  s.command("false", 1); // 8000
  s.agentEnd("completed"); // 9000
  return s.events;
}

const failing: When = { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] };

function windowCtx(events: ChartEvent[], anchor: number) {
  const facts = factsOf(events);
  return { facts, live: { nowMs: anchor }, events, anchor };
}

/* ── Scalar conditions ───────────────────────────────────────────────────── */

section("conditions: scalar");

check("gte", yes(one({ field: "facts.commands.failed", op: "gte", value: 5 })));
check("gt excludes the boundary", no(one({ field: "facts.commands.failed", op: "gt", value: 5 })));
check("lt", yes(one({ field: "facts.commands.failed", op: "lt", value: 6 })));
check("eq on a boolean", yes(one({ field: "facts.ended", op: "eq", value: true })));
check("ne is a negation operator, not a combinator", yes(one({ field: "facts.run.status", op: "ne", value: "error" })));
check("in", yes(one({ field: "facts.run.status", op: "in", value: ["completed", "error"] })));
check("notIn", yes(one({ field: "facts.run.status", op: "notIn", value: ["error"] })));
check("between", yes(one({ field: "facts.commands.failed", op: "between", value: [1, 9] })));
check("a missing field never matches a comparison", no(one({ field: "facts.nope.deeper", op: "gt", value: 0 })));
check("exists sees a real value", yes(one({ field: "facts.errors.total", op: "exists" })));
check("notExists is the operator for absence", yes(one({ field: "facts.nope", op: "notExists" })));
check("empty on a missing path", yes(one({ field: "facts.nope", op: "empty" })));
check("nonEmpty", yes(one({ field: "facts.files.created", op: "nonEmpty" })));

section("conditions: arrays and globs");

check("glob matches any element", yes(one({ field: "facts.files.created", op: "glob", value: "company/**" })));
check("a bare glob also matches the file name", yes(one({ field: "facts.files.created", op: "glob", value: "*.txt" })));
check("notGlob is the negation", yes(one({ field: "facts.files.created", op: "notGlob", value: "docs/**" })));
check("contains on an array", yes(one({ field: "facts.files.created", op: "contains", value: "src/a.ts" })));
check("notContains on an array", yes(one({ field: "facts.files.created", op: "notContains", value: "nope.ts" })));
check("matches on a string", yes(one({ field: "facts.run.status", op: "matches", value: "^comp" })));
check("notMatches", yes(one({ field: "facts.run.status", op: "notMatches", value: "^err" })));
check("an invalid regex never matches", no(one({ field: "facts.run.status", op: "matches", value: "(" })));
// JS has no inline flags, so `(?i)` is a leading marker, not a group.
check("a leading (?i) makes matches case-insensitive", yes(one({ field: "facts.run.status", op: "matches", value: "(?i)^COMP" })));
check("without it, case still matters", no(one({ field: "facts.run.status", op: "matches", value: "^COMP" })));
check("(?i) in the middle is not a marker, so it does not compile", no(one({ field: "facts.run.status", op: "matches", value: "a(?i)b" })));
check(
  "validateWhen accepts a leading (?i)",
  validateWhen({ conditions: [{ field: "facts.run.status", op: "matches", value: "(?i)comp" }] }).length === 0,
);

section("conditions: quantifiers");

check(
  "any with a where",
  yes(one({
    field: "facts.processes.runningAtEnd",
    quant: "any",
    where: { conditions: [{ field: "name", op: "eq", value: "vite" }] },
  })),
);
check(
  "where takes a flat list (and)",
  yes(one({
    field: "facts.processes.runningAtEnd",
    quant: "any",
    where: {
      conditions: [
        { field: "name", op: "eq", value: "vite" },
        { field: "lifetimeMs", op: "gte", value: 1000 },
      ],
    },
  })),
);
check(
  "none",
  yes(one({
    field: "facts.processes.runningAtEnd",
    quant: "none",
    where: { conditions: [{ field: "name", op: "eq", value: "postgres" }] },
  })),
);
check(
  "count with a filter",
  yes(one({
    field: "facts.processes.runningAtEnd",
    quant: "count",
    op: "gte",
    value: 2,
    where: { conditions: [{ field: "lifetimeMs", op: "gte", value: 100 }] },
  })),
);
check("count without a filter", yes(one({ field: "facts.processes.runningAtEnd", quant: "count", op: "eq", value: 2 })));
check("a quantifier on a missing path is empty", yes(one({ field: "facts.nope", quant: "count", op: "eq", value: 0 })));

section("conditions: flat combinators");

check(
  "all (default)",
  yes({ conditions: [{ field: "facts.ended", op: "eq", value: true }, { field: "facts.errors.total", op: "gt", value: 0 }] }),
);
check(
  "any",
  yes({
    combinator: "any",
    conditions: [{ field: "facts.errors.total", op: "gt", value: 99 }, { field: "facts.ended", op: "eq", value: true }],
  }),
);
check("an empty all is vacuously true", yes({ conditions: [] }));
check("an empty any is false", no({ combinator: "any", conditions: [] }));

/* ── Windows ─────────────────────────────────────────────────────────────── */

section("windows: count");

{
  const events = windowEvents();
  const anchor = events[events.length - 1]!.timestamp;
  const context = windowCtx(events, anchor);
  const spec = { events: { type: ["command"], where: failing }, measure: "count" as const, op: "gte" as const, value: 5 };
  check("five failures across the run", yes(one({ window: spec }), context));
  check("four failures is under the bar", no(one({ window: { ...spec, value: 6 } }), context));
  const result = runWindow(spec, events, anchor, {
    matches: (when, item) => matches(when, item),
    compare,
    readPath: resolvePath,
  });
  checkEqual("the measure is the count", result.value, 5);
  checkEqual("every match is evidence", result.selected, 5);
  check("evidence ids are real events", result.ids.length === 5 && result.ids.every((id) => events.some((event) => event.id === id)));
}

section("windows: span");

{
  const events = windowEvents();
  const anchor = events[events.length - 1]!.timestamp;
  const context = windowCtx(events, anchor);
  const base = { events: { type: ["command"], where: failing }, measure: "count" as const, op: "gte" as const, value: 1 };
  // Events are 1s apart, anchor 9000; failures at 3000/4000 and 6000/7000/8000.
  check("lastMs 3500 covers the last three", yes(one({ window: { ...base, span: { lastMs: 3500 }, value: 3 } }), context));
  check("lastMs 3500 excludes the earlier two", no(one({ window: { ...base, span: { lastMs: 3500 }, value: 5 } }), context));
  check("lastMs 2500 covers only the last two", yes(one({ window: { ...base, span: { lastMs: 2500 }, value: 2 } }), context));
  check("lastMs 1500 covers only the newest one", yes(one({ window: { ...base, span: { lastMs: 1500 }, value: 1 } }), context));
  check("no span covers the whole run", yes(one({ window: { ...base, value: 5 } }), context));
}

section("windows: streak");

{
  const events = windowEvents();
  const anchor = events[events.length - 1]!.timestamp;
  const context = windowCtx(events, anchor);
  const spec = { events: { type: ["command"], where: failing }, measure: "streak" as const, op: "gte" as const, value: 3 };
  const result = runWindow(spec, events, anchor, {
    matches: (when, item) => matches(when, item),
    compare,
    readPath: resolvePath,
  });
  checkEqual("a success breaks the streak: longest run is 3, not 5", result.value, 3);
  check("the streak rule matches", yes(one({ window: spec }), context));
  check("a streak of 4 does not", no(one({ window: { ...spec, value: 4 } }), context));
}

section("windows: gapMs");

{
  const events = windowEvents();
  const anchor = events[events.length - 1]!.timestamp;
  const context = windowCtx(events, anchor);
  const spec = { events: { type: ["command"], where: failing }, measure: "gapMs" as const, op: "lte" as const, value: 6000 };
  check("first failure to last is 5s", yes(one({ window: spec }), context));
  check("and not 3s", no(one({ window: { ...spec, value: 3000 } }), context));
}

section("windows: numeric measures");

{
  const events = windowEvents();
  const anchor = events[events.length - 1]!.timestamp;
  const runtime = { matches: (when: When, item: unknown) => matches(when, item), compare, readPath: resolvePath };
  const sum = runWindow(
    { events: { type: ["command"], where: failing }, measure: "sum", of: "payload.exitCode", op: "eq", value: 5 },
    events,
    anchor,
    runtime,
  );
  checkEqual("sum of five exit-1 failures", sum.value, 5);
  const max = runWindow({ events: { type: ["command"] }, measure: "max", of: "payload.exitCode", op: "eq", value: 1 }, events, anchor, runtime);
  checkEqual("max exit code", max.value, 1);
  const distinct = runWindow(
    { events: { type: ["command"] }, measure: "distinct", of: "payload.command", op: "eq", value: 2 },
    events,
    anchor,
    runtime,
  );
  checkEqual("two distinct commands", distinct.value, 2);
  const avg = runWindow({ events: { type: ["command"] }, measure: "avg", of: "payload.exitCode", op: "exists" }, events, anchor, runtime);
  check("avg is a number", typeof avg.value === "number" && avg.value > 0);
}

section("windows: type filter and anchors");

{
  const events = windowEvents();
  const anchor = events[events.length - 1]!.timestamp;
  const runtime = { matches: (when: When, item: unknown) => matches(when, item), compare, readPath: resolvePath };
  const all = runWindow({ measure: "count", op: "eq", value: events.length }, events, anchor, runtime);
  checkEqual("no type filter means every event", all.value, events.length);
  const messages = runWindow({ events: { type: "message" }, measure: "count", op: "eq", value: 0 }, events, anchor, runtime);
  checkEqual("a type filter narrows the stream", messages.value, 0);
  // The anchor is an input: the same events judged at an earlier moment see less.
  const early = runWindow(
    { events: { type: ["command"], where: failing }, span: { lastMs: 2000 }, measure: "count", op: "gte", value: 1 },
    events,
    5000,
    runtime,
  );
  checkEqual("moving the anchor moves the window", early.value, 2);
}

section("windows: guard rails");

{
  // A rule that cannot be evaluated is reported, not fatal.
  const events = windowEvents();
  const facts = factsOf(events);
  const pack: RulePack = {
    version: 1,
    rules: [
      {
        id: "boom",
        when: one({ window: { events: { type: ["command"] }, measure: "sum", op: "gte", value: 1 } }),
        emit: { level: "high", title: "x" },
      },
      {
        id: "fine",
        when: one({ field: "facts.commands.failed", op: "gte", value: 1 }),
        emit: { level: "low", title: "fine" },
      },
    ],
  };
  const result = evaluate(pack, { facts, live: {}, events, anchor: events[events.length - 1]!.timestamp });
  check("a window with no `of` is an error, not a crash", result.errors.length === 1);
  check("the other rule still runs", result.findings.some((finding) => finding.ruleId === "fine"));
}

section("windows: a missing stream never matches");

{
  const facts = factsOf(windowEvents());
  const pack: RulePack = {
    version: 1,
    rules: [
      {
        id: "needs-events",
        when: one({ window: { measure: "count", op: "gte", value: 0 } }),
        emit: { level: "high", title: "x" },
      },
    ],
  };
  const result = evaluate(pack, { facts, live: {} });
  check("a window with no stream is a rule error", result.errors.length === 1);
  check("and produces no finding", result.findings.length === 0);
}

/* ── Validation ──────────────────────────────────────────────────────────── */

section("validation");

check("a valid when has no issues", validateWhen({ conditions: [{ field: "facts.ended", op: "eq", value: true }] }).length === 0);
check("a missing field is reported", validateWhen({ conditions: [{ op: "eq", value: 1 }] })[0]?.path === "when.conditions[0].field");
check("an unknown op is reported", validateWhen({ conditions: [{ field: "a", op: "zzz", value: 1 }] })[0]?.path === "when.conditions[0].op");
check(
  "in without an array is reported",
  validateWhen({ conditions: [{ field: "a", op: "in", value: "x" }] })[0]?.path === "when.conditions[0].value",
);
check(
  "an invalid regex is reported",
  validateWhen({ conditions: [{ field: "a", op: "matches", value: "(" }] })[0]?.path === "when.conditions[0].value",
);
check(
  "count without an op is reported",
  validateWhen({ conditions: [{ field: "a", quant: "count", value: 1 }] })[0]?.path === "when.conditions[0].op",
);
check(
  "a window inside a where is rejected — no nesting",
  validateWhen({
    conditions: [
      {
        field: "facts.reverts",
        quant: "any",
        where: { conditions: [{ window: { measure: "count", op: "gte", value: 1 } }] },
      },
    ],
  }).some((issue) => issue.message.includes("window is not allowed")),
);
check(
  "a quantifier inside a where is rejected",
  validateWhen({
    conditions: [
      { field: "facts.reverts", quant: "any", where: { conditions: [{ field: "a", quant: "any" }] } },
    ],
  }).some((issue) => issue.message.includes("quantifier is not allowed")),
);
check(
  "a window needs a measure",
  validateWhen({ conditions: [{ window: { op: "gte", value: 1 } }] }).some((issue) => issue.path.endsWith(".measure")),
);
check(
  "sum needs an of path",
  validateWhen({ conditions: [{ window: { measure: "sum", op: "gte", value: 1 } }] }).some((issue) => issue.path.endsWith(".of")),
);
check(
  "a span needs a bound",
  validateWhen({ conditions: [{ window: { measure: "count", op: "gte", value: 1, span: {} } }] }).some(
    (issue) => issue.path.endsWith(".span"),
  ),
);
check("an empty condition list is reported", validateWhen({ conditions: [] })[0]?.path === "when.conditions");
check("a bad combinator is reported", validateWhen({ combinator: "xor", conditions: [{ field: "a", op: "eq", value: 1 }] })[0]?.path === "when.combinator");

/* ── Description ─────────────────────────────────────────────────────────── */

section("description");

check(
  "a condition reads like a sentence",
  describeWhen({ conditions: [{ field: "facts.commands.failed", op: "gte", value: 5 }] }) === "facts.commands.failed ≥ 5",
);
check(
  "a flat list joins with and",
  describeWhen({
    conditions: [
      { field: "a", op: "eq", value: 1 },
      { field: "b", op: "gt", value: 2 },
    ],
  }) === "a is 1 and b > 2",
);
check(
  "any joins with or",
  describeWhen({ combinator: "any", conditions: [{ field: "a", op: "eq", value: 1 }, { field: "b", op: "eq", value: 2 }] }) ===
    "a is 1 or b is 2",
);
check(
  "a window is described",
  describeWhen({ conditions: [{ window: { events: { type: ["command"] }, span: { lastMs: 1000 }, measure: "streak", op: "gte", value: 5 } }] }).includes(
    "streak of command",
  ),
);

section("operator catalogue");

check("a string field offers regex", operatorsFor("string").some((operator) => operator.operation === "matches"));
check("a number field offers gt", operatorsFor("number").some((operator) => operator.operation === "gt"));
check("a number field does not offer regex", !operatorsFor("number").some((operator) => operator.operation === "matches"));
check("every kind offers exists", ["string", "number", "boolean", "dateTime", "array", "object"].every((kind) =>
  operatorsFor(kind as never).some((operator) => operator.operation === "exists"),
));
check("a dateTime field offers after", operatorsFor("dateTime").some((operator) => operator.label === "is after"));

/* ── Templates ───────────────────────────────────────────────────────────── */

section("templates");

check("a path renders", renderTemplate("{{facts.commands.failed}} failed", ctx) === "5 failed");
check("a missing path renders empty", renderTemplate("[{{facts.nope}}]", ctx) === "[]");
check("join", renderTemplate('{{facts.files.created|join: ", "}}', ctx) === "company/intro.txt, src/a.ts");
check("count", renderTemplate("{{facts.files.created|count}}", ctx) === "2");
check("plural singular", plural(1, "file") === "1 file");
check("plural plural", plural(2, "file") === "2 files");
check("duration seconds", formatDuration(12_000) === "12s");
check("duration minutes", formatDuration(65_000) === "1m 05s");
check("duration hours", formatDuration(3_930_000) === "1h 05m");
check("duration of a non-number is a dash", renderTemplate("{{facts.nope|duration}}", ctx) === "—");
check("secs converts", renderTemplate("{{live.stalledSeconds|secs}}", ctx) === "1h 06m");
check("flag", renderTemplate("{{facts.ended|flag:done}}", ctx) === "done");
check("bool", renderTemplate("{{live.busy|bool:busy,idle}}", ctx) === "busy");
check("unknown filters leave the value alone", renderTemplate("{{facts.errors.total|nonsense}}", ctx) === "1");
check("row context", renderTemplate("{{vars.row.name}}", { vars: { row: { name: "vite" } } }) === "vite");

/* ── Packs ───────────────────────────────────────────────────────────────── */

section("packs: validation");

check("the default pack is valid", validatePack(DEFAULT_PACK).length === 0);
check("a pack without rules is reported", validatePack({ version: 1 }).length === 1);
check("a wrong version is reported", validatePack({ version: 2, rules: [] })[0]?.path === "version");
check(
  "a duplicate id is reported",
  validatePack({
    version: 1,
    rules: [
      { id: "a", when: one({ field: "x", op: "eq", value: 1 }), emit: { level: "low", title: "t" } },
      { id: "a", when: one({ field: "x", op: "eq", value: 1 }), emit: { level: "low", title: "t" } },
    ],
  }).some((issue) => issue.message === "duplicate rule id"),
);
check(
  "an unknown level is reported",
  validatePack({
    version: 1,
    rules: [{ id: "a", when: one({ field: "x", op: "eq", value: 1 }), emit: { level: "urgent", title: "t" } }],
  })[0]?.path === "rules[0].emit.level",
);
check(
  "a bad phase is reported",
  validatePack({
    version: 1,
    rules: [{ id: "a", phase: "later", when: one({ field: "x", op: "eq", value: 1 }), emit: { level: "low", title: "t" } }],
  })[0]?.path === "rules[0].phase",
);

section("packs: ordering, merging, hashing");

{
  const pack: RulePack = {
    version: 1,
    rules: [
      { id: "low", priority: 0, when: one({ field: "a", op: "eq", value: 1 }), emit: { level: "low", title: "l" } },
      { id: "high", priority: 5, when: one({ field: "a", op: "eq", value: 1 }), emit: { level: "high", title: "h" } },
      { id: "off", enabled: false, when: one({ field: "a", op: "eq", value: 1 }), emit: { level: "high", title: "x" } },
      { id: "live-only", phase: "live", when: one({ field: "a", op: "eq", value: 1 }), emit: { level: "high", title: "y" } },
    ],
  };
  checkEqual(
    "enabled rules come out highest priority first",
    orderedRules(pack).map((rule) => rule.id),
    ["high", "low", "live-only"],
  );
  checkEqual(
    "a phase filter drops the other phase",
    orderedRules(pack, "settled").map((rule) => rule.id),
    ["high", "low"],
  );
}

{
  const merged = mergePacks(DEFAULT_PACK, {
    version: 1,
    rules: [
      {
        id: "run.stalled",
        when: one({ field: "live.stalledSeconds", op: "gte", value: 60 }),
        emit: { level: "high", title: "one minute" },
      },
      { id: "mine", when: one({ field: "facts.ended", op: "eq", value: true }), emit: { level: "low", title: "mine" } },
    ],
  });
  check("a later pack overrides by id", merged.rules.find((rule) => rule.id === "run.stalled")?.emit.level === "high");
  check("and keeps the count", merged.rules.length === DEFAULT_PACK.rules.length + 1);
  check("the hash is stable", hashPack(DEFAULT_PACK) === hashPack(structuredClone(DEFAULT_PACK)));
  check("the hash moves when a rule moves", hashPack(DEFAULT_PACK) !== hashPack(merged));
}

/* ── Evaluation ──────────────────────────────────────────────────────────── */

section("evaluation");

{
  const events = windowEvents();
  const facts = factsOf(events);
  const pack: RulePack = {
    version: 1,
    rules: [
      {
        id: "one",
        when: one({ field: "facts.commands.failed", op: "gte", value: 1 }),
        emit: { level: "medium", title: "{{facts.commands.failed}} failed", evidence: ["facts.failed"] },
      },
    ],
  };
  const result = evaluate(pack, { facts, live: {}, events });
  checkEqual("a matching rule produces one finding", result.findings.length, 1);
  checkEqual("the level is the rule's", result.attention.level, "medium");
  check("the title is rendered", result.findings[0]?.title === "5 failed");
  check("evidence points at the failed commands", result.findings[0]?.evidence.length === 5);
  checkEqual(
    "a bare rule id is namespaced so the report vocabulary stays closed",
    result.findings[0]?.reason,
    "custom.one",
  );
}

{
  const facts = factsOf(windowEvents());
  const pack: RulePack = {
    version: 1,
    rules: [
      { id: "off", when: one({ field: "facts.commands.failed", op: "gte", value: 99 }), emit: { level: "high", title: "x" } },
    ],
  };
  const result = evaluate(pack, { facts, live: {} });
  check("a non-matching rule produces nothing", result.findings.length === 0);
  checkEqual("the verdict is none", result.attention.level, "none");
}

{
  const facts = factsOf(windowEvents());
  const pack: RulePack = {
    version: 1,
    rules: [{ id: "silent", when: one({ field: "facts.commands.failed", op: "gte", value: 1 }), emit: { level: "none", title: "x" } }],
  };
  check("a rule at level none is off", evaluate(pack, { facts, live: {} }).findings.length === 0);
}

{
  // Suppression: the loud rule silences the quiet one, and never itself.
  const facts = factsOf(windowEvents());
  const pack: RulePack = {
    version: 1,
    rules: [
      {
        id: "loud",
        suppresses: ["quiet", "loud"],
        when: one({ field: "facts.commands.failed", op: "gte", value: 1 }),
        emit: { level: "high", title: "loud" },
      },
      { id: "quiet", when: one({ field: "facts.commands.failed", op: "gte", value: 1 }), emit: { level: "low", title: "quiet" } },
    ],
  };
  checkEqual("a suppressed rule is dropped", evaluate(pack, { facts, live: {} }).findings.map((f) => f.ruleId), ["loud"]);
}

{
  // Cooldown lives in the state the caller owns, so replay stays deterministic.
  const facts = factsOf(windowEvents());
  const pack: RulePack = {
    version: 1,
    rules: [
      {
        id: "repeat",
        cooldownMs: 60_000,
        when: one({ field: "facts.commands.failed", op: "gte", value: 1 }),
        emit: { level: "low", title: "again" },
      },
    ],
  };
  const live = { nowMs: 100_000 };
  const first = evaluate(pack, { facts, live }, { state: emptyRuleState() });
  const second = evaluate(pack, { facts, live }, { state: first.state });
  check("the first evaluation fires", first.findings.length === 1);
  check("the second is inside the cooldown", second.findings.length === 0);
  const later = evaluate(pack, { facts, live: { nowMs: 200_000 } }, { state: second.state });
  check("after the cooldown it fires again", later.findings.length === 1);
}

{
  // Fail-open: a throwing rule is reported and the rest still run.
  const facts = factsOf(windowEvents());
  const exploding = {
    version: 1,
    rules: [
      {
        id: "boom",
        when: one({ field: "facts.commands.failed", op: "gte", value: 1 }),
        emit: {
          level: "high",
          title: "x",
          get detail(): string {
            throw new Error("renderer exploded");
          },
        },
      },
      { id: "fine", when: one({ field: "facts.commands.failed", op: "gte", value: 1 }), emit: { level: "low", title: "fine" } },
    ],
  } as unknown as RulePack;
  const result = evaluate(exploding, { facts, live: {} });
  check("the exploding rule is reported", result.errors.length === 1);
  check("the other rule still runs", result.findings.some((finding) => finding.ruleId === "fine"));
}

section("evaluation: phases");

{
  const events = windowEvents();
  const facts = factsOf(events);
  const pack: RulePack = {
    version: 1,
    rules: [
      { id: "live", phase: "live", when: one({ field: "facts.commands.failed", op: "gte", value: 1 }), emit: { level: "low", title: "live" } },
      { id: "settled", phase: "settled", when: one({ field: "facts.commands.failed", op: "gte", value: 1 }), emit: { level: "low", title: "settled" } },
      { id: "both", when: one({ field: "facts.commands.failed", op: "gte", value: 1 }), emit: { level: "low", title: "both" } },
    ],
  };
  checkEqual("live judges live + both", evaluate(pack, { facts, live: {} }, { phase: "live" }).findings.map((f) => f.ruleId).sort(), ["both", "live"]);
  checkEqual("settled judges settled + both", evaluate(pack, { facts, live: {} }, { phase: "settled" }).findings.map((f) => f.ruleId).sort(), ["both", "settled"]);
  checkEqual("no phase judges everything", evaluate(pack, { facts, live: {} }).findings.length, 3);
}

section("evaluation: determinism");

{
  const build = () => {
    resetEventIds();
    const s = session();
    s.agentStart();
    s.command("npm test", 1);
    s.write("src/a.ts", "x");
    s.process({ pid: 3, name: "node" });
    s.agentEnd("completed");
    return s.events;
  };
  const events = build();
  const facts = factsOf(events);
  const a = JSON.stringify(evaluate(DEFAULT_PACK, { facts, live: {}, events, anchor: 99_999 }));
  const b = JSON.stringify(evaluate(DEFAULT_PACK, { facts, live: {}, events, anchor: 99_999 }));
  check("the same inputs produce identical findings", a === b);
  const c = JSON.stringify(evaluate(DEFAULT_PACK, { facts, live: {}, events, anchor: 100_000 }));
  check("moving the anchor changes what a window sees", a !== c || facts.evidence.length < 1);
}

/* ── Sequences ──────────────────────────────────────────────────────────── */

section("sequences: ordering a count cannot see");

/** fail → success → fail, with `gap` thinking events between each step. */
function flapEvents(gap = 1): ChartEvent[] {
  resetEventIds();
  const s = session();
  s.agentStart();
  s.command("npm test", 1);
  for (let i = 0; i < gap; i++) s.thinking(`between ${i}`);
  s.command("npm test", 0);
  for (let i = 0; i < gap; i++) s.thinking(`again ${i}`);
  s.command("npm test", 1);
  s.agentEnd("completed");
  return s.events;
}

const failStep = {
  type: ["command"],
  where: { conditions: [{ field: "payload.exitCode", op: "ne" as const, value: 0 }] },
};
const okStep = {
  type: ["command"],
  where: { conditions: [{ field: "payload.exitCode", op: "eq" as const, value: 0 }] },
};

function seqCtx(events: ChartEvent[], anchor: number) {
  return { facts: factsOf(events), live: {}, events, anchor };
}

{
  const events = flapEvents(1);
  const anchor = events[events.length - 1]!.timestamp;
  const spec = { steps: [failStep, okStep, failStep], gap: { maxEvents: 10 } };
  check("a fail → ok → fail sequence matches", yes(one({ sequence: spec }), seqCtx(events, anchor)));

  const result = runSequence(spec, events, anchor, { matches: (when, item) => matches(when, item) });
  checkEqual("it reports one match", result.count, 1);
  checkEqual("it uses three events", result.ids.length, 3);
  check(
    "the evidence is the three commands",
    result.ids.every((id) => events.find((event) => event.id === id)?.type === "command"),
  );
}

{
  // A count cannot tell this apart from "two failures with a success after".
  const events = flapEvents(1);
  const context = seqCtx(events, events[events.length - 1]!.timestamp);
  const failures = {
    window: {
      events: {
        type: ["command"],
        where: { conditions: [{ field: "payload.exitCode", op: "ne" as const, value: 0 }] },
      },
      measure: "count" as const,
      op: "eq" as const,
      value: 2,
    },
  };
  check("a window counts the two failures", yes(one(failures), context));
  check(
    "but only the sequence sees the success between them",
    yes(one({ sequence: { steps: [failStep, okStep, failStep] } }), context),
  );
  check(
    "a different order does not match",
    no(one({ sequence: { steps: [okStep, failStep, failStep] } }), context),
  );
}

section("sequences: gaps");

{
  const events = flapEvents(10);
  const context = seqCtx(events, events[events.length - 1]!.timestamp);
  check(
    "a wide event gap still matches",
    yes(one({ sequence: { steps: [failStep, okStep, failStep], gap: { maxEvents: 12 } } }), context),
  );
  check(
    "a narrow event gap does not",
    no(one({ sequence: { steps: [failStep, okStep, failStep], gap: { maxEvents: 5 } } }), context),
  );
}

{
  // The fixture spaces events 1s apart, so a 60s gap is wide and 1s is not.
  const events = flapEvents(1);
  const context = seqCtx(events, events[events.length - 1]!.timestamp);
  check(
    "a 60s gap matches",
    yes(one({ sequence: { steps: [failStep, okStep, failStep], gap: { maxMs: 60_000 } } }), context),
  );
  check(
    "a 1s gap does not",
    no(one({ sequence: { steps: [failStep, okStep, failStep], gap: { maxMs: 1_000 } } }), context),
  );
}

section("sequences: repetition and bounds");

{
  // Two flaps in one run: `times: 2` needs both, `times: 3` cannot be met.
  resetEventIds();
  const s = session();
  s.agentStart();
  for (let round = 0; round < 2; round++) {
    s.command("npm test", 1);
    s.thinking("read it");
    s.command("npm test", 0);
    s.thinking("try again");
    s.command("npm test", 1);
    s.thinking("one more");
  }
  s.agentEnd("completed");
  const events = s.events;
  const context = seqCtx(events, events[events.length - 1]!.timestamp);
  const steps = [failStep, okStep, failStep];
  check("one flap matches", yes(one({ sequence: { steps } }), context));
  check("two flaps match times: 2", yes(one({ sequence: { steps, times: 2 } }), context));
  check("three do not", no(one({ sequence: { steps, times: 3 } }), context));
}

{
  // The anchor bounds the scan: a sequence that ends after it never matches.
  const events = flapEvents(1);
  const context = seqCtx(events, events[2]!.timestamp);
  check(
    "an anchor before the sequence ends sees nothing",
    no(one({ sequence: { steps: [failStep, okStep, failStep] } }), context),
  );
}

{
  const events = flapEvents(1);
  const anchor = events[events.length - 1]!.timestamp;
  check(
    "a one-step sequence is refused at runtime",
    throws(() => runSequence({ steps: [failStep] }, events, anchor, { matches: () => true })),
  );
}

section("sequences: validation and description");

{
  check(
    "a one-step sequence is reported",
    validateWhen({ conditions: [{ sequence: { steps: [failStep] } }] }).some((issue) => issue.path.endsWith(".steps")),
  );
  check(
    "a negative gap is reported",
    validateWhen({ conditions: [{ sequence: { steps: [failStep, okStep], gap: { maxEvents: -1 } } }] }).some(
      (issue) => issue.path.endsWith(".gap.maxEvents"),
    ),
  );
  check(
    "times must be a positive integer",
    validateWhen({ conditions: [{ sequence: { steps: [failStep, okStep], times: 0 } }] }).some((issue) =>
      issue.path.endsWith(".times"),
    ),
  );
  check(
    "a window inside a step is refused",
    validateWhen({
      conditions: [
        {
          sequence: {
            steps: [
              failStep,
              { type: ["command"], where: { conditions: [{ window: { measure: "count", op: "gte", value: 1 } }] } },
            ],
          },
        },
      ],
    }).some((issue) => issue.message.includes("field conditions only")),
  );
  check(
    "a sequence inside a where is refused",
    validateWhen({
      conditions: [
        { field: "facts.reverts", quant: "any", where: { conditions: [{ sequence: { steps: [failStep, okStep] } }] } },
      ],
    }).some((issue) => issue.message.includes("sequence is not allowed")),
  );
  check(
    "the description reads as a pattern",
    describeWhen({
      conditions: [{ sequence: { steps: [failStep, okStep, failStep], gap: { maxEvents: 20, maxMs: 600_000 } } }],
    }).includes("sequence command"),
  );
}

section("sequences: evidence and templates");

{
  const events = flapEvents(1);
  const facts = factsOf(events);
  const pack: RulePack = {
    version: 1,
    rules: [
      {
        id: "flap",
        when: one({
          sequence: {
            steps: [
              { ...failStep, as: "failed" },
              { ...okStep, as: "recovered" },
              { ...failStep, as: "brokeAgain" },
            ],
            gap: { maxEvents: 10 },
          },
        }),
        emit: {
          level: "medium",
          title: "{{vars.sequence.count}} flap · first {{vars.sequence.step.failed.id}}",
          evidence: ["sequence.ids"],
        },
      },
    ],
  };
  const result = evaluate(pack, { facts, live: {}, events, anchor: events[events.length - 1]!.timestamp });
  checkEqual("the rule fires once", result.findings.length, 1);
  check("the template reads the match", (result.findings[0]?.title ?? "").startsWith("1 flap · first evt_"));
  checkEqual("the evidence is the three events", result.findings[0]?.evidence.length, 3);
}

section("the example pack");

{
  // The example pack is documentation that runs, so a broken rule in it is a
  // broken doc. Nothing exercised it before, and two `(?i)` regexes had been
  // silently invalid — a rule that could never fire.
  checkEqual("every example rule validates", validatePack(EXAMPLE_PACK), []);
  checkEqual("and its ids are unique", new Set(EXAMPLE_PACK.rules.map((rule) => rule.id)).size, EXAMPLE_PACK.rules.length);

  const claims = EXAMPLE_PACK.rules.find((rule) => rule.id === "example.claims-without-evidence")!;
  // The rule holds a window condition, so it needs the events, not just the facts.
  const runOf = (content: string) => {
    resetEventIds();
    const s = session();
    s.agentStart();
    s.command("ls", 0);
    s.reply(content);
    s.agentEnd("completed");
    return s.events;
  };
  const fires = (content: string) => {
    const events = runOf(content);
    const facts = factsOf(events);
    return evaluate({ version: 1, rules: [claims] }, { facts, live: {}, events, anchor: facts.lastActivityAt }).findings.length > 0;
  };

  check("a reply claiming tests with none run fires", fires("I ran the tests and they all pass."));
  check("the match is case-insensitive", fires("All TESTS pass."));
  check("a reply that does not mention tests is quiet", !fires("I read the file."));
}

finish();
