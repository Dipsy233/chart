import { check, checkEqual, finish, section } from "./harness.ts";
import { observe, report, reportText, toChartEvents } from "../src/index.ts";
import { LIVE_REPORT, SETTLED_REPORT } from "../src/report/defaults.ts";
import { deriveOutcome } from "../src/report/verdict.ts";
import { factsOf, session, simpleRun } from "./fixtures.ts";

section("verdict");

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.write("src/a.ts", "x");
  s.agentEnd("completed");
  checkEqual("a clean run completed", deriveOutcome(factsOf(s.events)), "completed");
}

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.agentEnd("aborted");
  checkEqual("an aborted run stopped", deriveOutcome(factsOf(s.events)), "stopped");
}

{
  const s = session();
  s.agentStart();
  s.agentEnd("error");
  checkEqual("an error run failed", deriveOutcome(factsOf(s.events)), "failed");
}

{
  const s = session();
  s.agentStart();
  s.command("false", 1);
  s.agentEnd("completed");
  checkEqual("an unresolved failure failed", deriveOutcome(factsOf(s.events)), "failed");
}

{
  const s = session();
  s.agentStart();
  s.command("false", 1);
  s.thinking("read it"); // activity between failure and success = a real recovery
  s.command("true", 0);
  s.write("a.ts", "x");
  s.agentEnd("completed");
  checkEqual("a recovered failure warns", deriveOutcome(factsOf(s.events)), "completed_with_warnings");
}

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.agentEnd("completed");
  checkEqual("a run that changed nothing is no_change", deriveOutcome(factsOf(s.events)), "no_change");
}

section("observe");

{
  const observation = observe(simpleRun());
  check("observe returns an observation", observation !== undefined);
  check("it carries facts", observation?.facts.commands.total === 1);
  check("it carries a verdict", observation?.attention.level === "none");
  checkEqual("its findings are empty", observation?.findings, []);
  checkEqual("its errors are empty", observation?.errors, []);
}

{
  check("an empty stream has no run", observe([]) === undefined);
}

{
  // Live: elapsed and stalled are derived from the clock argument, not read.
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  const events = s.events;
  const facts = factsOf(events);
  const nowMs = facts.lastActivityAt + 5_000;
  const observation = observe(events, { live: { nowMs, busy: true } });
  checkEqual("elapsed is measured from the run start", observation?.facts.run.startedAt !== undefined, true);
  check("stalled seconds are derived", (observation?.attention.level ?? "") === "none");
}

{
  // Judging the same stream twice gives the same answer, always.
  const events = simpleRun();
  const a = JSON.stringify(observe(events)?.findings);
  const b = JSON.stringify(observe(events)?.findings);
  check("judging is deterministic", a === b);
}

section("report: settled");

{
  const s = session();
  s.agentStart();
  s.read("company/brief.txt", "text", 1, 3);
  s.write("company/intro.txt", "hello");
  s.command("npm test", 0);
  s.command("npm run build", 1);
  s.process({ pid: 9, name: "vite" });
  s.reply("done");
  s.agentEnd("completed");
  const observation = observe(s.events)!;
  const rendered = report(observation, SETTLED_REPORT);

  checkEqual("the report keeps its id", rendered.id, "settled");
  check("the title names the run and the outcome", rendered.title.includes(observation.run.id));
  check("there is a header", rendered.sections.some((section) => section.kind === "header"));
  check("there is a verdict", rendered.sections.some((section) => section.kind === "verdict"));

  const verdict = rendered.sections.find((section) => section.kind === "verdict");
  checkEqual("the verdict carries the level", verdict?.kind === "verdict" ? verdict.level : "", "high");

  const commands = rendered.sections.find((section) => section.kind === "table" && section.title === "Commands");
  check("the commands table has a row per command", commands?.kind === "table" && commands.rows.length === 2);
  check(
    "a row renders its columns",
    commands?.kind === "table" && commands.rows[0]?.length === 4,
  );

  const files = rendered.sections.find((section) => section.kind === "table" && section.title === "Files");
  check("the files table is keyed by path", files?.kind === "table" && files.rows.length === 2);

  const processes = rendered.sections.find((section) => section.kind === "table" && section.title === "Processes");
  check("the process table lists the egg", processes?.kind === "table" && processes.rows.length === 1);

  const timeline = rendered.sections.find((section) => section.kind === "timeline");
  check("the timeline has nodes", timeline?.kind === "timeline" && timeline.nodes.length > 0);

  const text = reportText(observation, SETTLED_REPORT);
  check("the text render includes the outcome", text.includes("completed"));
  check("the text render includes a finding", text.includes("still running"));
}

section("report: live");

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  const observation = observe(s.events, { live: { nowMs: s.events[s.events.length - 1]!.timestamp + 1000 } })!;
  const rendered = report(observation, LIVE_REPORT, { nowMs: s.events[s.events.length - 1]!.timestamp + 1000 });
  check("the live report renders", rendered.sections.length > 0);
  const stats = rendered.sections.find((section) => section.kind === "stats");
  check("the live stats render", stats?.kind === "stats" && stats.rows.length > 0);
}

section("report: a user spec");

{
  // The point of specs: a report nobody shipped, written as data.
  const spec = {
    id: "deliverables",
    title: "Deliverables for {{facts.run.id}}",
    sections: [
      { kind: "header" as const, title: "Only the deliverables" },
      {
        kind: "list" as const,
        title: "Created",
        source: "facts.files.created",
        item: "{{vars.row}}",
        empty: "nothing yet",
      },
      {
        kind: "table" as const,
        title: "Findings tagged deliverable",
        source: "facts.files.created",
        columns: [{ header: "path", cell: "{{vars.row}}" }],
        limit: 5,
      },
    ],
  };
  const s = session();
  s.agentStart();
  s.write("company/intro.txt", "x");
  s.write("company/pricing.md", "y");
  s.agentEnd("completed");
  const rendered = report(observe(s.events)!, spec);
  checkEqual("a custom title renders", rendered.title, `Deliverables for run_1`);
  const list = rendered.sections.find((section) => section.kind === "list");
  checkEqual("a custom list renders its items", list?.kind === "list" ? list.items : [], [
    "company/intro.txt",
    "company/pricing.md",
  ]);
}

section("report: sorting and limits");

{
  const spec = {
    id: "sorted",
    title: "t",
    sections: [
      {
        kind: "table" as const,
        source: "facts.commandFacts",
        sort: { field: "exitCode" as const, direction: "desc" as const },
        limit: 1,
        columns: [{ header: "cmd", cell: "{{vars.row.exitCode}}" }],
      },
    ],
  };
  const s = session();
  s.agentStart();
  s.command("a", 0);
  s.command("b", 2);
  s.agentEnd("completed");
  const rendered = report(observe(s.events)!, spec);
  const table = rendered.sections[0];
  checkEqual("the limit and the sort both apply", table?.kind === "table" ? table.rows : [], [["2"]]);
}

section("adapter: Absence events");

{
  const absenceLike = [
    {
      id: "evt_1",
      sessionId: "s1",
      timestamp: 1000,
      type: "agent_start",
      payload: { model: "m" },
    },
    {
      id: "evt_2",
      sessionId: "s1",
      timestamp: 2000,
      type: "process",
      // Absence's older archives omit `children`; the adapter fills it.
      payload: { pid: 5, name: "node", commandLine: "node", status: "running", startedAt: 2000 },
    },
    { id: "evt_3", sessionId: "s1", timestamp: 3000, type: "not-a-real-event", payload: {} },
  ];
  const events = toChartEvents(absenceLike);
  checkEqual("unknown event types are dropped", events.length, 2);
  const observation = observe(events);
  check("the adapted stream reduces", observation?.facts.processes.primary.length === 1);
  checkEqual("the missing children field became 0", observation?.facts.processes.primary[0]?.children, 0);
}

finish();
