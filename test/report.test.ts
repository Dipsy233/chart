import { check, checkEqual, finish, section } from "./harness.ts";
import { observe, report, reportText, toChartEvents, validateSpec, checkSpecTemplates, knownFieldFor } from "../src/index.ts";
import { CLASSIC_REPORT } from "../src/report/classic.ts";
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

section("report: filter, row evidence and text sections");

{
  // The three things that made "a custom report" a wish rather than a feature:
  // narrow a table, keep each row's evidence, and render prose.
  const s = session();
  s.agentStart();
  s.read("company/brief.txt", "text", 1, 3);
  s.write("company/intro.txt", "hello");
  s.write("src/a.ts", "x");
  s.write("company/pricing.md", "y");
  s.reply("All done — tests pass.");
  s.agentEnd("completed");
  const observation = observe(s.events)!;

  const spec = {
    id: "filtered",
    title: "Only company/",
    sections: [
      {
        kind: "table" as const,
        title: "company files",
        source: "facts.files.byPath",
        filter: { conditions: [{ field: "path", op: "glob" as const, value: "company/**" }] },
        columns: [{ header: "path", cell: "{{vars.row.path}}" }],
        evidence: "evidence",
      },
      {
        kind: "list" as const,
        title: "all files",
        source: "facts.files.created",
        item: "{{vars.row}}",
      },
      {
        kind: "text" as const,
        title: "the reply",
        source: "facts.response",
      },
    ],
  };
  const rendered = report(observation, spec);

  const table = rendered.sections.find((section) => section.kind === "table");
  checkEqual(
    "a filter narrows a table to matching rows only",
    table?.kind === "table" ? table.rows.map((row) => row[0]) : [],
    ["company/brief.txt", "company/intro.txt", "company/pricing.md"],
  );
  check(
    "each row keeps its evidence ids, index-aligned with the rows",
    table?.kind === "table" && table.evidence?.length === 3 && (table.evidence[0]?.length ?? 0) > 0,
  );
  check(
    "a filter narrows a table: src/ is gone",
    table?.kind === "table" && !table.rows.some((row) => row[0]?.startsWith("src/")),
  );

  const text = rendered.sections.find((section) => section.kind === "text");
  checkEqual("a text section renders a string path as one paragraph", text?.kind === "text" ? text.text : undefined, "All done — tests pass.");

  const list = rendered.sections.find((section) => section.kind === "list");
  check(
    "a list without a filter is unchanged",
    list?.kind === "list" && list.items.length === 3,
  );
}

{
  // A filter's array operators mean what they mean in a rule.
  const s = session();
  s.agentStart();
  s.write("a.ts", "x");
  s.write("b.ts", "y");
  s.agentEnd("completed");
  const spec = {
    id: "tags",
    title: "t",
    sections: [
      {
        kind: "table" as const,
        source: "facts.files.byPath",
        filter: { conditions: [{ field: "path", op: "endsWith" as const, value: "b.ts" }] },
        columns: [{ header: "p", cell: "{{vars.row.path}}" }],
      },
    ],
  };
  const rendered = report(observe(s.events)!, spec);
  checkEqual(
    "a filter uses the same operators a rule does",
    rendered.sections[0]?.kind === "table" ? rendered.sections[0].rows : [],
    [["b.ts"]],
  );
}

{
  // A filter is applied BEFORE sort and limit, so "the biggest 1 under X" works.
  const s = session();
  s.agentStart();
  s.command("a", 0);
  s.command("b", 7);
  s.command("c", 3);
  s.agentEnd("completed");
  const spec = {
    id: "order",
    title: "t",
    sections: [
      {
        kind: "table" as const,
        source: "facts.commandFacts",
        filter: { conditions: [{ field: "exitCode", op: "gt" as const, value: 0 }] },
        sort: { field: "exitCode", direction: "desc" as const },
        limit: 1,
        columns: [{ header: "exit", cell: "{{vars.row.exitCode}}" }],
      },
    ],
  };
  const rendered = report(observe(s.events)!, spec);
  checkEqual(
    "filter runs before sort and limit",
    rendered.sections[0]?.kind === "table" ? rendered.sections[0].rows : [],
    [["7"]],
  );
}

section("report: a findings filter");

{
  const s = session();
  s.agentStart();
  s.command("a", 1);
  s.command("b", 1);
  s.command("c", 1);
  s.agentEnd("completed");
  const spec = {
    id: "f",
    title: "t",
    sections: [
      {
        kind: "findings" as const,
        filter: { conditions: [{ field: "tags", op: "contains" as const, value: "commands" }] },
      },
    ],
  };
  const rendered = report(observe(s.events)!, spec);
  const findings = rendered.sections[0];
  check(
    "a findings filter keeps only matching findings",
    findings?.kind === "findings" && findings.findings.every((findings2) => findings2.tags.includes("commands")),
  );
}

section("report: which pack judged it");

{
  // A report that cannot say who judged it is an assertion, not a document.
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.agentEnd("completed");
  const rendered = report(observe(s.events)!, SETTLED_REPORT);
  checkEqual("the report names the pack that judged it", rendered.judgedBy?.packName, "内置默认规则");
  check("the report carries the judgement's anchor", typeof rendered.judgedBy?.at === "number");
}

section("report: every shipped template resolves");

{
  // The bug this pins: a template check that binds `vars.row` to `{}` reports
  // every `{{vars.row.…}}` in the spec as unresolved — 22 false alarms on the
  // classic report alone. A row template must be checked against a *real* row.
  const s = session();
  s.agentStart();
  s.read("company/brief.txt", "text", 1, 3);
  s.write("company/intro.txt", "hi");
  s.write("src/a.ts", "x");
  s.edit("src/a.ts", "x", "y");
  s.command("npm test", 0);
  s.command("npm run build", 1);
  s.search("grep", "TODO", 4);
  s.process({ pid: 9, name: "vite" });
  s.mcp("fs", "read", false);
  s.change("../outside.txt", "modified", true);
  s.reply("done");
  s.agentEnd("completed");
  const observation = observe(s.events)!;
  const context = { facts: observation.facts, live: {}, vars: { outcome: "", headline: "" } };

  const known = knownFieldFor();
  checkEqual(
    "the classic spec has no unresolved template",
    checkSpecTemplates(CLASSIC_REPORT, context, { known }),
    [],
  );
  checkEqual("the settled spec has none either", checkSpecTemplates(SETTLED_REPORT, context, { known }), []);
  checkEqual("the live spec has none", checkSpecTemplates(LIVE_REPORT, context, { known }), []);

  // A real typo is still caught, and still points at the section that holds it.
  const typo = {
    ...CLASSIC_REPORT,
    sections: [
      {
        kind: "table" as const,
        source: "facts.commandFacts",
        columns: [{ header: "c", cell: "{{vars.row.commandd}}" }],
      },
    ],
  };
  const issues = checkSpecTemplates(typo, context, { known });
  checkEqual("a typo in a row cell is still reported", issues.length, 1);
  checkEqual("and it names the column", issues[0]?.path, "sections[0].columns[0].cell");
  check("and the path inside it", issues[0]?.path.includes("columns[0].cell") === true);
  checkEqual("the expression is the placeholder as written", issues[0]?.expression, "{{vars.row.commandd}}");
}

{
  // The distinction the whole `known` predicate exists for: an absent value is
  // not a typo. `durationMs` is optional on a command, and the run below has a
  // command with no start time — so the field is missing, and must not be
  // reported. The same template with a misspelled field still is.
  const s = session();
  s.agentStart();
  // A shell tool that started and has not ended: `status: "running"`, and
  // genuinely no `durationMs` — the field is optional because of exactly this.
  s.push("tool_start", { toolCallId: "call_run", toolName: "bash", args: { command: "npm test" } });
  const observation = observe(s.events)!;
  const context = { facts: observation.facts, live: {}, vars: { outcome: "", headline: "" } };
  const known = knownFieldFor();

  check(
    "the command really has no duration",
    observation.facts.commandFacts.length === 1 &&
      observation.facts.commandFacts[0]?.status === "running" &&
      observation.facts.commandFacts[0]?.durationMs === undefined,
  );

  const spec = {
    id: "optional",
    title: "t",
    sections: [
      {
        kind: "table" as const,
        source: "facts.commandFacts",
        columns: [
          { header: "took", cell: "{{vars.row.durationMs|duration}}" },
          { header: "tool", cell: "{{vars.row.toolName}}" },
        ],
      },
    ],
  };
  checkEqual(
    "an absent optional field is not reported as a typo",
    checkSpecTemplates(spec, context, { known }),
    [],
  );

  const misspelled = {
    ...spec,
    sections: [{ ...spec.sections[0], columns: [{ header: "t", cell: "{{vars.row.toolNam}}" }] }],
  };
  checkEqual(
    "a misspelled row field still is",
    checkSpecTemplates(misspelled, context, { known }).length,
    1,
  );
}

{
  // `live.elapsedSeconds` is derived by `withLive`, so it is real with an empty
  // `live` — the exact case that made the live report report two false alarms.
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.agentEnd("completed");
  const observation = observe(s.events)!;
  const known = knownFieldFor();
  check("a derived live field is known", known("live.elapsedSeconds", undefined));
  check("a made-up live field is not", !known("live.elapsedSecondz", undefined));
  check(
    "the live spec's stats resolve",
    checkSpecTemplates(LIVE_REPORT, { facts: observation.facts, live: {}, vars: {} }, { known }).length === 0,
  );
}

{
  // A section with no rows renders its `empty` text, so its templates never run
  // and cannot be wrong. Reporting them would be noise on an empty run.
  const s = session();
  s.agentStart();
  s.agentEnd("completed");
  const observation = observe(s.events)!;
  const spec = {
    id: "empty",
    title: "t",
    sections: [
      {
        kind: "table" as const,
        source: "facts.commandFacts",
        columns: [{ header: "c", cell: "{{vars.row.command}}" }],
        empty: "none",
      },
    ],
  };
  checkEqual(
    "a section with no rows reports nothing",
    checkSpecTemplates(spec, { facts: observation.facts, live: {}, vars: {} }),
    [],
  );
}

{
  // A filter decides which row is "first", so the check reads a *kept* row.
  const s = session();
  s.agentStart();
  s.write("src/a.ts", "x");
  s.write("company/b.ts", "y");
  s.agentEnd("completed");
  const observation = observe(s.events)!;
  const spec = {
    id: "filtered",
    title: "t",
    sections: [
      {
        kind: "list" as const,
        source: "facts.files.byPath",
        filter: { conditions: [{ field: "path", op: "glob" as const, value: "company/**" }] },
        item: "{{vars.row.path}}",
      },
    ],
  };
  checkEqual(
    "a filtered section checks a kept row",
    checkSpecTemplates(spec, { facts: observation.facts, live: {}, vars: {} }),
    [],
  );
}

section("report: validating a spec");

{
  checkEqual("a shipped spec validates clean", validateSpec(SETTLED_REPORT), []);
  checkEqual("the live spec validates clean", validateSpec(LIVE_REPORT), []);

  const issues = validateSpec({
    id: "bad",
    title: "",
    sections: [
      { kind: "nope" },
      { kind: "table", source: "facts.files.created", columns: [] },
      { kind: "list", item: "{{vars.row}}" },
      { kind: "stats", rows: [] },
    ],
  });
  const paths = issues.map((issue) => issue.path);
  check("an unknown section kind is reported", paths.includes("sections[0].kind"));
  check("a table with no columns is reported", paths.includes("sections[1].columns"));
  check("a list with no source is reported", paths.includes("sections[2].source"));
  check("a stats section with no rows is reported", paths.includes("sections[3].rows"));
  check("an empty title is reported", paths.includes("title"));
}

{
  // A window or a sequence in a filter is a rule, not a filter: say so.
  const issues = validateSpec({
    id: "w",
    title: "t",
    sections: [
      {
        kind: "table",
        source: "facts.commandFacts",
        filter: { conditions: [{ window: { events: { type: ["command"] }, measure: "count", op: "gte", value: 1 } }] },
        columns: [{ header: "c", cell: "{{vars.row.command}}" }],
      },
    ],
  });
  check(
    "a window inside a filter is rejected with an explanation",
    issues.some((issue) => issue.path.includes("filter") && /belongs in a rule/.test(issue.message)),
  );
}

section("report: the classic layout, as a spec");

{
  // The claim under test: the shipped report is expressible as data. If this
  // spec renders every section, a user can fork it instead of forking a module.
  checkEqual("the classic spec validates clean", validateSpec(CLASSIC_REPORT), []);

  const s = session();
  s.agentStart();
  s.read("company/brief.txt", "text", 1, 3);
  s.write("company/intro.txt", "hi");
  s.write("src/a.ts", "x");
  s.edit("src/a.ts", "x", "y");
  s.command("npm test", 0);
  s.command("npm run build", 1);
  s.search("grep", "TODO", 4);
  s.process({ pid: 9, name: "vite" });
  s.mcp("fs", "read", false);
  s.change("../outside.txt", "modified", true);
  s.reply("done");
  s.agentEnd("completed");
  const observation = observe(s.events)!;
  const rendered = report(observation, CLASSIC_REPORT);

  const kinds = rendered.sections.map((section) => section.kind);
  check("the classic report has a header and a verdict", kinds.includes("header") && kinds.includes("verdict"));
  check("it has the world line", kinds.includes("timeline"));
  check("it has the attention findings", kinds.includes("findings"));
  check("it ends with the reply", kinds.at(-1) === "text");

  const byTitle = (title: string) =>
    rendered.sections.find((section) => "title" in section && section.title === title);

  check("the created list is filtered to writes", (byTitle("Created")?.kind === "list" ? byTitle("Created") : undefined) !== undefined);
  const created = byTitle("Created");
  checkEqual(
    "a filtered list still renders paths",
    created?.kind === "list" ? created.items.map((item) => item.split(" · ")[0]) : [],
    ["company/intro.txt", "src/a.ts"],
  );

  const executions = byTitle("Executions");
  check("the executions table has a row per command", executions?.kind === "table" && executions.rows.length === 2);
  check(
    "every classic row is clickable: evidence is index-aligned",
    executions?.kind === "table" && executions.evidence?.length === executions.rows.length,
  );
  check(
    "that evidence names real events",
    executions?.kind === "table" &&
      (executions.evidence ?? []).every((ids) => ids.every((id) => observation.facts.evidence.includes(id))),
  );

  const response = byTitle("Response");
  checkEqual("the reply renders as a text section", response?.kind === "text" ? response.text : undefined, "done");
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
