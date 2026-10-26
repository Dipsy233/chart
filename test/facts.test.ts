import { check, checkEqual, finish, section } from "./harness.ts";
import { deriveRuns, pickRun } from "../src/facts/runs.ts";
import { matchGlob } from "../src/facts/glob.ts";
import { factsOf, resetEventIds, session } from "./fixtures.ts";

section("runs");

{
  const s = session();
  s.userMessage("do it");
  s.command("ls", 0);
  s.agentEnd("completed");
  s.userMessage("again");
  s.command("ls", 0);
  const runs = deriveRuns(s.events);
  check("each prompt opens its own run", runs.length === 2);
  checkEqual("the run's status is completed", runs[0]?.status, "completed");
  check("indices cover the run", runs[0]?.fromIndex === 0 && runs[0]?.toIndex === 2);
  check("the newest run is still open", runs[1]?.status === "running");
}

{
  const s = session();
  s.userMessage("first");
  s.userMessage("second");
  const runs = deriveRuns(s.events);
  check("a new prompt interrupts the previous run", runs[0]?.status === "interrupted");
  check("the second run is still open", runs[1]?.status === "running");
}

{
  // An observed session has nobody to send it a prompt: activity opens the run.
  const s = session();
  s.command("ls", 0);
  s.agentEnd("completed");
  const runs = deriveRuns(s.events);
  check("an observed stream opens a run from activity", runs.length === 1);
  check("the opening event is the first activity", runs[0]?.fromIndex === 0);
}

{
  const s = session();
  s.agentStart();
  s.agentEnd("error");
  const runs = deriveRuns(s.events);
  checkEqual("an error end marks the run as error", runs[0]?.status, "error");
}

{
  const s = session();
  s.agentStart();
  s.agentEnd("aborted");
  const runs = deriveRuns(s.events);
  checkEqual("an aborted end marks the run interrupted", runs[0]?.status, "interrupted");
}

section("facts: commands");

{
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.command("npm test", 1);
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("counts add up", facts.commands, { total: 2, running: 0, succeeded: 1, failed: 1, unknown: 0 });
  check("a failed command is listed", facts.failed.length === 1);
  checkEqual("its exit code survives", facts.failed[0]?.exitCode, 1);
  check("it is unresolved when nothing recovered it", facts.unresolved.length === 1);
  check("the run has ended", facts.ended);
}

{
  const s = session();
  s.agentStart();
  s.command("npm test", 1);
  // Absence only counts a recovery when activity separates the two: a success
  // immediately after a failure is the same action retried.
  s.thinking("look at the failure, then try a different flag");
  s.command("npm test -- --fix", 0);
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("a later success recovers the failure", facts.unresolved.length === 0);
  check("the recovery is recorded", facts.recoveries.length === 1);
}

{
  const s = session();
  s.agentStart();
  s.failedTool("npm run build");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("a failed shell tool with no command event still counts", facts.commands.failed, 1);
  checkEqual("the command text comes from the tool args", facts.failed[0]?.command, "npm run build");
}

{
  const s = session();
  s.agentStart();
  s.command("sleep 1", 0);
  const facts = factsOf(s.events);
  check("a run with no agent_end has not ended", facts.ended === false);
}

section("facts: streak and retries");

{
  const s = session();
  s.agentStart();
  for (let i = 0; i < 3; i++) s.command("false", 1);
  s.command("true", 0);
  s.command("false", 1);
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("the longest streak is remembered", facts.failureStreak.count, 3);
  check("the streak keeps its evidence", facts.failureStreak.evidence.length === 3);
  checkEqual("the repeated command is counted", facts.retries.find((r) => r.command === "false")?.count, 4);
}

section("facts: files");

{
  const s = session();
  s.agentStart();
  s.write("src/new.ts", "one\ntwo");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("a first write creates the path", facts.files.created.includes("src/new.ts"));
  checkEqual("its lines are counted", facts.changes.additions, 2);
}

{
  const s = session();
  s.agentStart();
  s.read("src/a.ts", "hello", 1, 1);
  s.write("src/a.ts", "hello");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("writing back what was read is a revert", facts.reverts.length === 1);
  checkEqual("the revert count is one", facts.reverts[0]?.count, 1);
}

{
  const s = session();
  s.agentStart();
  s.read("src/a.ts", "hello", 1, 1);
  s.write("src/a.ts", "hello world");
  s.write("src/a.ts", "hello");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("a version returning to an earlier one is a revert", facts.reverts[0]?.count, 1);
}

{
  const s = session();
  s.agentStart();
  s.read("src/a.ts", "line1\nline2", 1, 2);
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("a read is knowledge", facts.knowledge.reads[0]?.path === "src/a.ts");
  check("a read is not a change", facts.files.created.length === 0 && facts.files.modified.length === 0);
}

{
  const s = session();
  s.agentStart();
  s.change("src/a.ts", "modified");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("a watcher change with no agent write is observed", facts.files.observed.includes("src/a.ts"));
  check("it is flagged as external", facts.files.byPath["src/a.ts"]?.externalChange === true);
}

{
  const s = session();
  s.agentStart();
  s.write("src/a.ts", "x");
  s.change("src/a.ts", "modified");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("a watcher change matching the agent's write is not observed", facts.files.observed.length === 0);
}

{
  const s = session();
  s.agentStart();
  s.change("../outside/secret.txt", "modified", true);
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  check("an outside change is a fact on its own", facts.outsideChanges.length === 1);
  checkEqual("its path is kept", facts.outsideChanges[0]?.path, "../outside/secret.txt");
}

{
  // A path an earlier run touched is a modification, not a creation.
  const s = session();
  s.userMessage("first");
  s.write("src/a.ts", "one");
  s.agentEnd("completed");
  s.userMessage("second");
  s.write("src/a.ts", "two");
  const runs = deriveRuns(s.events);
  const second = pickRun(s.events.length > 0 ? runs : runs, runs[1]?.id);
  check("the second run exists", second !== undefined);
  const { buildFacts } = await import("../src/facts/build.ts");
  const facts = buildFacts(s.events, second!);
  check("a rewrite of an earlier path is a modification", facts.files.modified.includes("src/a.ts"));
  check("it is not created again", !facts.files.created.includes("src/a.ts"));
}

section("facts: processes");

{
  const s = session();
  s.agentStart();
  s.process({ pid: 42, name: "vite", command: "npm run dev", startedAt: 1_100 });
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("a running primary is a leftover", facts.processes.runningAtEnd.length, 1);
  check("its lifetime is measured against the run end", (facts.processes.primary[0]?.lifetimeMs ?? 0) > 0);
}

{
  const s = session();
  s.agentStart();
  s.process({ pid: 42, name: "vite", startedAt: 1_100, status: "exited", exitedAt: 5_000 });
  s.process({ pid: 43, name: "cat", kind: "tool" });
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("an exited process is not a leftover", facts.processes.runningAtEnd.length, 0);
  checkEqual("tools are counted, not listed as primaries", facts.processes.tools, 1);
  checkEqual("only primaries are indexed by pid", Object.keys(facts.processes.byPid), ["42"]);
}

section("facts: errors, mcp, response");

{
  const s = session();
  s.agentStart();
  s.error("model returned 500");
  s.mcp("filesystem", "list_directory");
  s.mcp("filesystem", "read_file", true);
  s.reply("done");
  s.agentEnd("completed");
  const facts = factsOf(s.events);
  checkEqual("errors are counted", facts.errors.total, 1);
  checkEqual("mcp calls are folded per server", facts.mcp.servers["filesystem"]?.calls, 2);
  checkEqual("mcp failures are counted", facts.mcp.failed, 1);
  checkEqual("the reply is kept", facts.response, "done");
}

section("facts: determinism");

{
  const build = () => {
    resetEventIds();
    const s = session();
    s.agentStart();
    s.read("a.ts", "x", 1, 1);
    s.write("a.ts", "y");
    s.command("npm test", 1);
    s.process({ pid: 7, name: "node" });
    s.agentEnd("completed");
    return s.events;
  };
  const first = JSON.stringify(factsOf(build()));
  const second = JSON.stringify(factsOf(build()));
  check("the same stream produces byte-identical facts", first === second);
}

section("globs: fnmatch");

{
  // The same matcher serves paths and arbitrary strings, so it carries the
  // fnmatch features a rule like `mcp__filesystem__*` needs.
  check("a star stays inside a segment", matchGlob("src/*.ts", "src/a.ts") && !matchGlob("src/*.ts", "src/x/a.ts"));
  check("a double star crosses segments", matchGlob("src/**/a.ts", "src/x/y/a.ts"));
  check("a bare pattern matches the file name", matchGlob("*.log", "deep/dir/app.log"));
  check("a question mark is one character", matchGlob("a?c", "abc") && !matchGlob("a?c", "ac"));
  check("a character class matches", matchGlob("npm [run] *", "npm r test"));
  check("a negated class matches", matchGlob("[!a]bc", "xbc") && !matchGlob("[!a]bc", "abc"));
  check("a class range matches", matchGlob("v[0-9]", "v7") && !matchGlob("v[0-9]", "vx"));
  check("a literal ] in a class is a member", matchGlob("a[]]b", "a]b"));
  check("a backslash escapes a star", matchGlob("a\\*b", "a*b") && !matchGlob("a\\*b", "axb"));
  check("an unterminated class is literal", matchGlob("a[b", "a[b"));
  check("a glob over a tool name", matchGlob("mcp__filesystem__*", "mcp__filesystem__read_file"));
}

finish();
