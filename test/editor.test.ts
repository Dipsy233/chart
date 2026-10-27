import { check, checkEqual, finish, section } from "./harness.ts";
import {
  EVENT_FIELDS,
  EVENT_TYPES,
  FACT_FIELDS,
  LIVE_FIELDS,
  allFields,
  eventFields,
  fieldFor,
} from "../src/editor/catalog.ts";
import {
  describeRule,
  effectivePhase,
  isIdTaken,
  newRule,
  operatorsForField,
  impliedPhase,
  phaseFromWhen,
  previewRule,
  removeRule,
  resetPack,
  suggestId,
  upsertRule,
  validateRule,
  withDerivedPhase,
} from "../src/editor/draft.ts";
import type { When } from "../src/regimen/predicate.ts";
import { resolvePath } from "../src/regimen/predicate.ts";
import { DEFAULT_PACK } from "../src/regimen/defaults.ts";
import { CHART_EVENT_TYPES } from "../src/core/events.ts";
import { withLive } from "../src/core/live.ts";
import { buildFacts } from "../src/facts/build.ts";
import { deriveRuns, pickRun } from "../src/facts/runs.ts";
import { resetEventIds, session } from "./fixtures.ts";
import type { ChartEvent } from "../src/core/events.ts";
import type { Rule } from "../src/regimen/rule.ts";

/**
 * The catalogue is a promise to every editor: "these paths exist". A promise is
 * only worth making if it is checked, so the first half of this file walks the
 * whole catalogue against a real reduction.
 */

function richRun(): ChartEvent[] {
  resetEventIds();
  const s = session();
  s.agentStart();
  s.userMessage("research Acme");
  s.thinking("start with the filings");
  s.read("README.md", "line\nline", 1, 2);
  s.search("grep", "acme", 12);
  s.push("tool_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  s.toolUpdate("c1");
  s.push("tool_end", { toolCallId: "c1", toolName: "bash", isError: false });
  s.command("ls", 0);
  s.command("curl -s https://acme.example", 28);
  s.write("company/intro.txt", "hello\nworld");
  s.edit("company/intro.txt", "hello\nworld", "hello there\nworld");
  s.change("company/intro.txt", "modified");
  s.change("../secrets/.env", "modified", true);
  s.process({ pid: 11, name: "node", commandLine: "node scraper.mjs", command: "node scraper.mjs" });
  s.process({ pid: 12, name: "cat", kind: "tool" });
  s.mcp("filesystem", "list_directory");
  s.error("model returned 500");
  s.approval();
  s.reply("I ran the tests and everything passes.");
  s.agentEnd("completed");
  return s.events;
}

section("catalogue: every fact path exists");

{
  const events = richRun();
  const run = pickRun(deriveRuns(events))!;
  const facts = buildFacts(events, run);
  const missing: string[] = [];
  for (const field of FACT_FIELDS) {
    const value = resolvePath(facts, field.path.replace(/^facts\./, ""));
    if (value === undefined || value === null) missing.push(field.path);
  }
  checkEqual("no fact field is a lie", missing, []);
}

{
  const events = richRun();
  const run = pickRun(deriveRuns(events))!;
  const facts = buildFacts(events, run);
  const live = withLive(facts, {
    nowMs: facts.lastActivityAt + 60_000,
    busy: true,
    status: "working",
    metrics: { eggs: [{ pid: 11, name: "node", cpuPercent: 40, cpuSeconds: 12, rssBytes: 1024 }] },
  });
  const missing: string[] = [];
  for (const field of LIVE_FIELDS) {
    const value = resolvePath(live, field.path.replace(/^live\./, ""));
    if (value === undefined || value === null) missing.push(field.path);
  }
  checkEqual("no live field is a lie", missing, []);
}

section("catalogue: every event path exists");

{
  const events = richRun();
  const missing: string[] = [];
  for (const [type, fields] of Object.entries(EVENT_FIELDS)) {
    const sample = events.find((event) => event.type === type);
    if (!sample) {
      missing.push(`(no sample for ${type})`);
      continue;
    }
    for (const field of fields) {
      const value = resolvePath(sample, field.path);
      if (value === undefined || value === null) {
        // An optional field is allowed to be absent; the test still insists it
        // exists on *some* event of that type, below.
        if (field.optional) continue;
        missing.push(`${type}.${field.path}`);
      }
    }
  }
  checkEqual("every event type has a sample", missing.filter((entry) => entry.startsWith("(no sample")).length, 0);
  checkEqual("no event field is a lie", missing.filter((entry) => !entry.startsWith("(no sample")), []);
}

section("catalogue: coverage and lookup");

{
  checkEqual(
    "every event type in the union has an entry",
    CHART_EVENT_TYPES.filter((type) => !EVENT_TYPES.some((info) => info.type === type)),
    [],
  );
  checkEqual(
    "and every entry is a real type",
    EVENT_TYPES.filter((info) => !CHART_EVENT_TYPES.includes(info.type)).map((info) => info.type),
    [],
  );
  checkEqual(
    "every type has payload fields",
    CHART_EVENT_TYPES.filter((type) => (EVENT_FIELDS[type] ?? []).length === 0),
    [],
  );
}

{
  checkEqual("fieldFor finds a fact", fieldFor("facts.commands.failed")?.kind, "number");
  checkEqual("fieldFor finds a live field", fieldFor("live.stalledSeconds")?.kind, "number");
  checkEqual("fieldFor knows array elements", fieldFor("facts.processes.runningAtEnd.name")?.kind, "string");
  check("fieldFor returns nothing for a typo", fieldFor("facts.nope") === undefined);
  checkEqual("allFields groups by root", [...new Set(allFields().map((field) => field.group))].sort(), ["facts", "live"]);
}

{
  const commandFields = eventFields(["command"]).map((field) => field.path);
  check("a command window offers exitCode", commandFields.includes("payload.exitCode"));
  check("and not a message field", !commandFields.includes("payload.role"));
  check("but always offers the common ones", commandFields.includes("type") && commandFields.includes("timestamp"));

  const messageFields = eventFields(["message"]).map((field) => field.path);
  check("a message window offers content", messageFields.includes("payload.content"));
  check("and role", messageFields.includes("payload.role"));

  const all = eventFields(undefined).map((field) => field.path);
  check("no type filter offers everything", all.includes("payload.exitCode") && all.includes("payload.content"));
  check("without duplicates", new Set(all).size === all.length);
}

section("editor: rule helpers");

{
  const rule = newRule("user.test");
  checkEqual("a new rule is valid", validateRule(rule), []);
  check("its id is used", rule.id === "user.test");
  check("it has one condition", rule.when.conditions.length === 1);
  checkEqual("and a description", describeRule(rule), "facts.commands.failed ≥ 1 → medium");
}

{
  const rule = { ...newRule("x"), phase: "live" as const, emit: { level: "high" as const, title: "t" } };
  check("the description names the phase", describeRule(rule).includes("[live]"));
  const off = { ...newRule("y"), emit: { level: "none" as const, title: "t" } };
  check("a rule at level none reads as off", describeRule(off).includes("off"));
}

section("editor: the phase comes from the conditions");

{
  const endedTrue: When = { conditions: [{ field: "facts.ended", op: "eq", value: true }] };
  const endedFalse: When = { conditions: [{ field: "facts.ended", op: "eq", value: false }] };
  const unrelated: When = { conditions: [{ field: "facts.commands.failed", op: "gte", value: 3 }] };

  checkEqual("waiting for the run to end means settled", phaseFromWhen(endedTrue), "settled");
  checkEqual("requiring it to still be running means live", phaseFromWhen(endedFalse), "live");
  checkEqual("saying nothing means both", phaseFromWhen(unrelated), "both");
  check("and implies nothing at all", impliedPhase(unrelated) === undefined);
  checkEqual(
    "ne true is the live form",
    phaseFromWhen({ conditions: [{ field: "facts.ended", op: "ne", value: true }] }),
    "live",
  );
  checkEqual(
    "exists is the settled form",
    phaseFromWhen({ conditions: [{ field: "facts.ended", op: "exists" }] }),
    "settled",
  );
  checkEqual(
    "any does not pin a phase",
    phaseFromWhen({
      combinator: "any",
      conditions: [
        { field: "facts.ended", op: "eq", value: true },
        { field: "facts.errors.total", op: "gt", value: 0 },
      ],
    }),
    "both",
  );

  const base = { ...newRule("user.phase"), when: unrelated };
  checkEqual("a derived settled phase is written", withDerivedPhase({ ...base, when: endedTrue }).phase, "settled");
  checkEqual("a derived live phase is written", withDerivedPhase({ ...base, when: endedFalse }).phase, "live");
  check(
    "an unrelated condition leaves the stored phase alone",
    withDerivedPhase({ ...base, phase: "settled", when: unrelated }).phase === "settled",
  );
  check(
    "and a rule with no phase stays without one",
    withDerivedPhase({ ...base, phase: undefined, when: unrelated }).phase === undefined,
  );
  checkEqual("effectivePhase falls back to both", effectivePhase({ ...base, phase: undefined }), "both");

  // The contradiction the derivation exists to prevent.
  const dead = { ...base, phase: "live" as const, when: endedTrue };
  check(
    "a live rule waiting for the run to end is rejected",
    validateRule(dead).some((issue) => issue.message.includes("can never fire")),
  );
  check(
    "and the same rule with the derived phase is fine",
    validateRule(withDerivedPhase(dead)).every((issue) => !issue.message.includes("can never fire")),
  );
}

{
  checkEqual("suggestId slugifies", suggestId("Five failures in 2 minutes"), "user.five-failures-in-2-minutes");
  checkEqual("suggestId survives junk", suggestId("!!!"), "user.rule");
  check("isIdTaken sees the defaults", isIdTaken(DEFAULT_PACK, "run.stalled"));
  check("and not an unused id", !isIdTaken(DEFAULT_PACK, "user.unused"));
}

{
  const rule = newRule("user.mine");
  const added = upsertRule(DEFAULT_PACK, rule);
  checkEqual("upsert appends a new rule", added.rules.length, DEFAULT_PACK.rules.length + 1);
  check("the original pack is untouched", DEFAULT_PACK.rules.length < added.rules.length);

  const edited = upsertRule(added, { ...rule, emit: { level: "high", title: "changed" } });
  checkEqual("upsert replaces by id", edited.rules.length, added.rules.length);
  checkEqual("and keeps the position", edited.rules[edited.rules.length - 1]?.emit.title, "changed");

  const removed = removeRule(added, "user.mine");
  checkEqual("remove drops it", removed.rules.length, DEFAULT_PACK.rules.length);
}

{
  const pack = resetPack("work");
  checkEqual("reset copies the defaults", pack.rules.length, DEFAULT_PACK.rules.length);
  checkEqual("and names the pack", pack.name, "work");
  pack.rules.length = 0;
  check("reset returns a copy", DEFAULT_PACK.rules.length > 0);
}

section("editor: operator suggestions");

{
  check(
    "a number field offers gte",
    operatorsForField("facts.commands.failed").some((operator) => operator.operation === "gte"),
  );
  check(
    "a string field offers regex",
    operatorsForField("facts.response").some((operator) => operator.operation === "matches"),
  );
  check(
    "a boolean field offers is / is not",
    operatorsForField("facts.ended").some((operator) => operator.operation === "eq"),
  );
  check(
    "an unknown path falls back to the universal operators",
    operatorsForField("facts.whatever").some((operator) => operator.operation === "exists"),
  );
}

section("editor: preview a rule against a run");

{
  const events = richRun();

  const leftover = previewRule(
    DEFAULT_PACK.rules.find((rule) => rule.id === "run.leftover-eggs")!,
    events,
    { anchor: events[events.length - 1]!.timestamp },
  );
  check("preview returns a result", leftover !== undefined);
  check("it fired", leftover?.fired === true);
  check("it is labelled hypothetical", leftover?.hypothetical === true);
  check("it carries evidence", (leftover?.findings[0]?.evidence.length ?? 0) > 0);
  const run = pickRun(deriveRuns(events))!;
  checkEqual("it knows how many events it saw", leftover?.events, run.toIndex - run.fromIndex + 1);
}

{
  const events = richRun();
  const never: Rule = {
    ...newRule("user.never"),
    when: { conditions: [{ field: "facts.commands.failed", op: "gte", value: 99 }] },
  };
  const preview = previewRule(never, events);
  check("a rule that does not match says so", preview?.fired === false);
  checkEqual("and produces no findings", preview?.findings, []);
}

{
  // The editor's killer feature: a half-written rule can be tried on a *live*
  // anchor and on a settled one, from the same record.
  const events = richRun();
  const last = events[events.length - 1]!.timestamp;
  const burst: Rule = {
    ...newRule("user.burst"),
    phase: "live",
    when: {
      conditions: [
        {
          window: {
            events: {
              type: ["command"],
              where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] },
            },
            span: { lastMs: 60_000 },
            measure: "count",
            op: "gte",
            value: 1,
          },
        },
      ],
    },
    emit: { level: "high", title: "{{vars.window.count}} failures recently", evidence: ["window.ids"] },
  };

  const wide = previewRule(burst, events, { anchor: last });
  check("a window rule fires when the span is wide", wide?.fired === true);
  check("and the title is rendered from the window", wide?.findings[0]?.title.includes("failures recently") === true);

  const narrow = previewRule(burst, events, { anchor: last + 10 * 60_000 });
  check("and goes quiet once the burst is outside the span", narrow?.fired === false);
}

{
  // A broken rule is an error in the preview, not a crash.
  const events = richRun();
  const broken: Rule = {
    ...newRule("user.broken"),
    when: { conditions: [{ window: { measure: "sum", op: "gte", value: 1 } }] },
  };
  const preview = previewRule(broken, events);
  check("a broken rule reports an error", (preview?.errors.length ?? 0) === 1);
  check("and does not fire", preview?.fired === false);
}

{
  checkEqual("an empty stream has no run to preview", previewRule(newRule(), []), undefined);
}

finish();
