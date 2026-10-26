import { check, checkEqual, finish, section } from "./harness.ts";
import {
  RESERVED_REASONS,
  isNamespacedReason,
  isReservedReason,
  isValidReason,
  normalizeReason,
} from "../src/regimen/reasons.ts";
import { canonicalJson, digestOf, makeRecord, verifyChain, type FindingRecord } from "../src/regimen/record.ts";
import { validatePack, type RulePack } from "../src/regimen/rule.ts";
import { observe, record } from "../src/index.ts";
import { DEFAULT_PACK } from "../src/regimen/defaults.ts";
import { resetEventIds, session } from "./fixtures.ts";
import type { ChartEvent } from "../src/core/events.ts";

/* ── Reasons: a closed vocabulary ────────────────────────────────────────── */

section("reasons: reserved");

check("the reserved set matches Absence's reason union", RESERVED_REASONS.length === 12);
check("a reserved reason is recognised", isReservedReason("command_failed"));
check("an unknown slug is not reserved", !isReservedReason("my_reason"));
check("a reserved reason is valid", isValidReason("command_failed"));

section("reasons: namespaced");

check("a namespaced reason is recognised", isNamespacedReason("user.flapping"));
check("a two-part namespace is recognised", isNamespacedReason("my-pack.flapping"));
check("a namespaced reason is valid", isValidReason("user.flapping"));
check("a bare word is not namespaced", !isNamespacedReason("flapping"));
check("an upper-case namespace is not", !isNamespacedReason("User.flapping"));
check("a trailing dot is not", !isNamespacedReason("user."));
check("a reserved reason is never namespaced", !isNamespacedReason("command_failed"));

section("reasons: normalisation");

checkEqual("a reserved reason passes through", normalizeReason("command_failed"), "command_failed");
checkEqual("a namespaced reason passes through", normalizeReason("user.flapping"), "user.flapping");
checkEqual("a bare rule id is namespaced", normalizeReason("run.agent-stopped"), "run.agent-stopped");
checkEqual("a bare word is namespaced under custom", normalizeReason("flapping"), "custom.flapping");
checkEqual("junk is slugified", normalizeReason("My Rule!"), "custom.my-rule");
checkEqual("an empty string still yields a key", normalizeReason("!!!"), "custom.unnamed");

section("reasons: a rule may not invent one");

{
  const pack = (reason: string): RulePack => ({
    version: 1,
    rules: [
      {
        id: "x",
        when: { conditions: [{ field: "facts.ended", op: "eq", value: true }] },
        emit: { level: "low", title: "t", reason },
      },
    ],
  });
  check("a reserved reason is accepted", validatePack(pack("command_failed")).length === 0);
  check("a namespaced reason is accepted", validatePack(pack("user.mine")).length === 0);
  check(
    "an invented reason is rejected",
    validatePack(pack("Flapping")).some((issue) => issue.path === "rules[0].emit.reason"),
  );
  check("the default pack only uses reserved reasons", DEFAULT_PACK.rules.every((rule) => !rule.emit.reason || isValidReason(rule.emit.reason)));
}

/* ── The record: a hash chain ────────────────────────────────────────────── */

function eventsFor(failures: number): ChartEvent[] {
  resetEventIds();
  const s = session();
  s.agentStart();
  for (let i = 0; i < failures; i++) s.command(`false ${i}`, 1);
  s.agentEnd("completed");
  return s.events;
}

section("record: digests");

{
  const body = { runId: "run_1", phase: "settled" as const, packHash: "abcd1234", anchor: 1, findings: [], attention: { level: "none" as const, reasons: [], evidence: [], findings: [] }, errors: [] };
  check("a digest is 32 hex characters", /^[0-9a-f]{32}$/.test(digestOf(body)));
  check("the same body digests the same", digestOf(body) === digestOf(structuredClone(body)));
  check(
    "key order does not change the digest",
    digestOf(body) === digestOf({ ...body, errors: [], findings: [] }),
  );
  check("a changed field changes the digest", digestOf({ ...body, anchor: 2 }) !== digestOf(body));
  check("canonical JSON sorts keys", canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}');
}

section("record: linking");

{
  const first = makeRecord({
    runId: "run_1",
    phase: "settled",
    packHash: "p1",
    anchor: 1,
    findings: [],
    attention: { level: "none", reasons: [], evidence: [], findings: [] },
    errors: [],
  });
  const second = makeRecord(
    {
      runId: "run_2",
      phase: "settled",
      packHash: "p1",
      anchor: 2,
      findings: [],
      attention: { level: "none", reasons: [], evidence: [], findings: [] },
      errors: [],
    },
    first,
  );
  check("the first record has no prev", first.prev === undefined);
  checkEqual("the second points at the first", second.prev, first.digest);
  checkEqual("both verify", verifyChain([first, second]).ok, true);
  checkEqual("the chain reports its length", verifyChain([first, second]).length, 2);
}

section("record: tamper evidence");

{
  const make = (runId: string, anchor: number): FindingRecord =>
    makeRecord({
      runId,
      phase: "settled",
      packHash: "p1",
      anchor,
      findings: [],
      attention: { level: "none", reasons: [], evidence: [], findings: [] },
      errors: [],
    });

  const a = make("run_1", 1);
  const b = makeRecord(
    {
      runId: "run_2",
      phase: "settled",
      packHash: "p1",
      anchor: 2,
      findings: [],
      attention: { level: "none", reasons: [], evidence: [], findings: [] },
      errors: [],
    },
    a,
  );
  const c = makeRecord(
    {
      runId: "run_3",
      phase: "settled",
      packHash: "p1",
      anchor: 3,
      findings: [],
      attention: { level: "none", reasons: [], evidence: [], findings: [] },
      errors: [],
    },
    b,
  );

  // Editing a record's content.
  const edited = { ...b, anchor: 99 };
  const editedCheck = verifyChain([a, edited, c]);
  check("an edited record is caught", !editedCheck.ok);
  checkEqual("and the break is at its index", editedCheck.brokenAt, 1);

  // Reordering two records.
  const swapped = verifyChain([a, c, b]);
  check("a reordered log is caught", !swapped.ok);

  // Deleting one.
  const removed = verifyChain([a, c]);
  check("a removed record is caught", !removed.ok);
  check("and the reason names the link", (removed.reason ?? "").includes("prev"));

  // Inserting a forged record.
  const forged = make("run_2b", 2);
  const inserted = verifyChain([a, forged, b, c]);
  check("an inserted record is caught", !inserted.ok);

  // Relabelling a level after the fact.
  const relabelled = {
    ...b,
    attention: { ...b.attention, level: "high" as const },
  };
  check("a changed verdict is caught", !verifyChain([a, relabelled, c]).ok);

  check("an empty log verifies", verifyChain([]).ok);
}

section("record: from an observation");

{
  const events = eventsFor(5);
  const observation = observe(events, { phase: "settled" })!;
  const first = record(observation, DEFAULT_PACK);
  const second = record(observation, DEFAULT_PACK, first);

  check("the record names the run", first.runId === observation.run.id);
  checkEqual("the record keeps the findings", first.findings.length, observation.findings.length);
  check("the record carries a pack hash", /^[0-9a-f]{8}$/.test(first.packHash));
  checkEqual("a second record links to the first", second.prev, first.digest);
  checkEqual("the pair verifies", verifyChain([first, second]).ok, true);
  check("the digest is stable across rebuilds", record(observe(eventsFor(5), { phase: "settled" })!, DEFAULT_PACK).digest === first.digest);
}

finish();
