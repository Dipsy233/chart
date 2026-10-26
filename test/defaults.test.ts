import { check, checkEqual, finish, section } from "./harness.ts";
import { observe, record, replayText, simulate } from "../src/index.ts";
import { DEFAULT_PACK } from "../src/regimen/defaults.ts";
import { SETTLED_REPORT } from "../src/report/defaults.ts";
import { deriveOutcome } from "../src/report/verdict.ts";
import { factsOf, session } from "./fixtures.ts";
import type { ChartEvent } from "../src/core/events.ts";

/**
 * Parity: the default pack must reproduce Absence v0.4's `computeAttention`.
 * Each block below is one branch of that function, with the same expectation.
 *
 * The old function took `ended` and `busy` as inputs; Chart splits that into
 * phases, so a settled run is judged with `phase: "settled"` and a live one with
 * `phase: "live"`.
 */

function settled(events: readonly ChartEvent[]) {
  return observe(events, { phase: "settled" })!;
}
function live(events: readonly ChartEvent[], busy: boolean | undefined = true) {
  return observe(events, { phase: "live", live: busy === undefined ? {} : { busy } })!;
}
const reasons = (observation: { attention: { reasons: string[] } }) => observation.attention.reasons.slice().sort();

section("defaults: a clean run");

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.write("src/a.ts", "x");
  s.agentEnd("completed");
  checkEqual("a clean run needs nothing", reasons(settled(s.events)), []);
  checkEqual("its level is none", settled(s.events).attention.level, "none");
}

section("defaults: agent stopped");

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.agentEnd("error");
  check("an error end raises agent_stopped", reasons(settled(s.events)).includes("agent_stopped"));
  checkEqual("at high", settled(s.events).attention.level, "high");
}

section("defaults: unresolved failures");

{
  // One unresolved failure, successes in between so the streak stays at 1.
  const s = session();
  s.agentStart();
  s.command("false 1", 1);
  s.command("true", 0);
  s.command("false 2", 1);
  s.command("true", 0);
  s.command("false 3", 1);
  s.agentEnd("completed");
  checkEqual("an unresolved failure at rest is the reason", reasons(settled(s.events)), ["unresolved_error"]);
  checkEqual("at high", settled(s.events).attention.level, "high");
  check(
    "the count rule stays quiet under its threshold",
    !settled(s.events).findings.some((finding) => finding.ruleId === "run.commands-failed-recovered"),
  );
}

{
  // Five failures, each recovered by a later success → command_failed at low.
  const s = session();
  s.agentStart();
  for (let i = 0; i < 5; i++) {
    s.command(`false ${i}`, 1);
    s.thinking(`failure ${i}: read the output`);
    s.command(`true ${i}`, 0);
  }
  s.agentEnd("completed");
  checkEqual("recovered failures are a count, not an unresolved error", reasons(settled(s.events)), ["command_failed"]);
  checkEqual("at low", settled(s.events).attention.level, "low");
}

{
  const s = session();
  s.agentStart();
  for (let i = 0; i < 4; i++) {
    s.command(`false ${i}`, 1);
    s.thinking(`failure ${i}: read the output`);
    s.command(`true ${i}`, 0);
  }
  s.agentEnd("completed");
  checkEqual("four failures stay under the threshold", reasons(settled(s.events)), []);
}

{
  const s = session();
  s.agentStart();
  s.command("false", 1);
  checkEqual("one unresolved failure mid-run is not worth interrupting", reasons(live(s.events)), []);
}

{
  // Unresolved failures while busy but over the threshold → command_failed at low.
  const s = session();
  s.agentStart();
  for (let i = 0; i < 5; i++) {
    s.command(`false ${i}`, 1);
    s.thinking(`failure ${i}: read the output`);
    s.command(`true ${i}`, 0);
  }
  s.command("false last", 1);
  checkEqual("over the threshold mid-run it is a count", reasons(live(s.events)), ["command_failed"]);
  checkEqual("at low", live(s.events).attention.level, "low");
}

{
  // An agent visibly waiting (busy false) is `needsYou`, even mid-run.
  const s = session();
  s.agentStart();
  s.command("false", 1);
  checkEqual("a waiting agent reports the unresolved failure", reasons(live(s.events, false)), ["unresolved_error"]);
}

section("defaults: bare error event");

{
  const s = session();
  s.agentStart();
  s.error("model returned 500");
  s.agentEnd("completed");
  checkEqual("a bare error is the reason", reasons(settled(s.events)), ["unresolved_error"]);
  checkEqual("capped at medium", settled(s.events).attention.level, "medium");
}

{
  // With failures over the threshold the bare-error branch must not fire too.
  const s = session();
  s.agentStart();
  s.error("model returned 500");
  for (let i = 0; i < 5; i++) {
    s.command(`false ${i}`, 1);
    s.thinking(`failure ${i}: read the output`);
    s.command(`true ${i}`, 0);
  }
  s.agentEnd("completed");
  checkEqual("the count branch wins over the bare error", reasons(settled(s.events)), ["command_failed"]);
}

section("defaults: streak");

{
  const s = session();
  s.agentStart();
  // Three failures in a row (the streak), then three recoveries — one success
  // recovers one pending failure, so three successes are needed to clear them.
  for (let i = 0; i < 3; i++) s.command(`false ${i}`, 1);
  for (let i = 0; i < 3; i++) {
    s.thinking(`read failure ${i}`);
    s.command(`true ${i}`, 0);
  }
  s.agentEnd("completed");
  check("three in a row raise the streak", reasons(settled(s.events)).includes("command_failure_streak"));
  check(
    "the streak is medium when nothing is left unresolved",
    settled(s.events).attention.level === "medium",
    settled(s.events).attention.level,
  );
}

{
  // The streak rule is `both`: it fires mid-run too.
  const s = session();
  s.agentStart();
  for (let i = 0; i < 3; i++) s.command(`false ${i}`, 1);
  check("the streak fires while live", reasons(live(s.events)).includes("command_failure_streak"));
}

section("defaults: stall");

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  const events = s.events;
  const facts = factsOf(events);
  const last = facts.lastActivityAt;
  check(
    "an hour of silence stalls",
    reasons(observe(events, { phase: "live", live: { nowMs: last + 3600_000 } })!).includes("activity_stalled"),
  );
  check(
    "half an hour does not",
    !reasons(observe(events, { phase: "live", live: { nowMs: last + 1800_000 } })!).includes("activity_stalled"),
  );
  check("a settled run never stalls", !reasons(settled(events)).includes("activity_stalled"));
}

section("defaults: leftover eggs");

{
  const s = session();
  s.agentStart();
  s.process({ pid: 11, name: "vite" });
  s.agentEnd("completed");
  check("a process still alive at the end is reported", reasons(settled(s.events)).includes("process_left_running"));
}

{
  const s = session();
  s.agentStart();
  s.process({ pid: 11, name: "vite", status: "exited", exitedAt: 2_000 });
  s.agentEnd("completed");
  check("an exited process is not", !reasons(settled(s.events)).includes("process_left_running"));
}

{
  const s = session();
  s.agentStart();
  s.process({ pid: 11, name: "vite" });
  check("a running egg mid-run is the whole point, not a leftover", !reasons(live(s.events)).includes("process_left_running"));
}

section("defaults: outside change");

{
  const s = session();
  s.agentStart();
  s.change("../other/config.json", "modified", true);
  s.agentEnd("completed");
  check("an outside change is low", reasons(settled(s.events)).includes("outside_change"));
  checkEqual("level low", settled(s.events).attention.level, "low");
}

section("defaults: loops");

{
  const s = session();
  s.agentStart();
  s.read("src/a.ts", "hello", 1, 1);
  s.write("src/a.ts", "hello");
  s.agentEnd("completed");
  check("a file revert is a loop", reasons(settled(s.events)).includes("file_version_loop"));
}

{
  const s = session();
  s.agentStart();
  s.command("npm test", 1);
  s.command("npm test", 1);
  s.thinking("read the failure");
  s.command("true", 0);
  s.agentEnd("completed");
  check("the same command failing twice is a loop", reasons(settled(s.events)).includes("command_retry_loop"));
}

{
  const s = session();
  s.agentStart();
  s.command("npm test", 1);
  s.command("true", 0);
  s.agentEnd("completed");
  check("one failure is not a loop", !reasons(settled(s.events)).includes("command_retry_loop"));
}

section("defaults: level is the loudest finding");

{
  const s = session();
  s.agentStart();
  s.command("npm test", 1);
  s.command("npm test", 1);
  s.thinking("read the failure");
  s.command("true", 0);
  s.thinking("try again");
  s.command("true", 0);
  s.change("../x", "modified", true);
  s.agentEnd("completed");
  check("medium outranks low", settled(s.events).attention.level === "medium");
  check("both reasons are kept", reasons(settled(s.events)).length >= 2);
}

section("defaults: evidence");

{
  const s = session();
  s.agentStart();
  s.command("false", 1);
  s.agentEnd("completed");
  const observation = settled(s.events);
  const finding = observation.findings.find((candidate) => candidate.ruleId === "run.unresolved-error");
  check("every finding carries evidence", (finding?.evidence.length ?? 0) > 0);
  check(
    "the evidence is a real event id from the run",
    finding?.evidence.every((id) => observation.facts.evidence.includes(id)) === true,
  );
}

section("defaults: no window in the shipped pack");

{
  // The defaults deliberately stay on facts: they must be O(1) per evaluation.
  const withWindows = DEFAULT_PACK.rules.filter((rule) =>
    JSON.stringify(rule.when).includes('"window"'),
  );
  checkEqual("the default pack uses no windows", withWindows.map((rule) => rule.id), []);
}

section("modes: record, replay, simulate");

{
  const s = session();
  s.agentStart();
  s.command("npm test", 1);
  s.command("npm test", 1);
  s.command("true", 0);
  s.agentEnd("completed");

  const judged = settled(s.events);
  const recorded = record(judged, DEFAULT_PACK);

  check("the record names the pack", recorded.packHash.length === 8);
  checkEqual("the record keeps the phase", recorded.phase, "settled");
  checkEqual("the record keeps the findings", recorded.findings.length, judged.findings.length);

  // A replay is the record, rendered. It never consults a pack.
  const text = replayText(recorded, judged.facts, SETTLED_REPORT);
  check("the replay renders the recorded findings", text.includes("kept failing"));

  // A simulation re-judges, and says so.
  const stricter = structuredClone(DEFAULT_PACK);
  const rule = stricter.rules.find((candidate) => candidate.id === "run.command-retry-loop");
  if (rule) rule.when.conditions = [{ field: "facts.retries", quant: "count", op: "gte", value: 99 }];
  const hypothetical = simulate(s.events, stricter)!;
  check("a simulation is labelled hypothetical", hypothetical.hypothetical === true);
  check("and it really does re-judge", !hypothetical.findings.some((finding) => finding.ruleId === "run.command-retry-loop"));
  check("while the record still has it", recorded.findings.some((finding) => finding.ruleId === "run.command-retry-loop"));
  check("an observation is not labelled hypothetical", judged.hypothetical === undefined);
}

section("verdict");

{
  const cases: Array<[string, () => ChartEvent[], string]> = [
    ["a clean run completed", () => { const s = session(); s.agentStart(); s.command("ls", 0); s.write("a.ts", "x"); s.agentEnd("completed"); return s.events; }, "completed"],
    ["an aborted run stopped", () => { const s = session(); s.agentStart(); s.command("ls", 0); s.agentEnd("aborted"); return s.events; }, "stopped"],
    ["an error run failed", () => { const s = session(); s.agentStart(); s.agentEnd("error"); return s.events; }, "failed"],
    ["an unresolved failure failed", () => { const s = session(); s.agentStart(); s.command("false", 1); s.agentEnd("completed"); return s.events; }, "failed"],
    ["a recovered failure warns", () => { const s = session(); s.agentStart(); s.command("false", 1); s.thinking("read it"); s.command("true", 0); s.write("a.ts", "x"); s.agentEnd("completed"); return s.events; }, "completed_with_warnings"],
    ["no changes is its own outcome", () => { const s = session(); s.agentStart(); s.command("ls", 0); s.agentEnd("completed"); return s.events; }, "no_change"],
  ];
  for (const [label, build, expected] of cases) {
    checkEqual(label, deriveOutcome(factsOf(build())), expected);
  }
}

finish();
