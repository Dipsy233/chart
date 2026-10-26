/**
 * Facts — what the observer saw, with no opinion about it.
 *
 * This is a faithful port of Absence's `buildRunFacts`, with three deliberate
 * changes that are the reason Chart exists:
 *
 *   1. No options. Absence passes the user's thresholds *into* the builder, so
 *      changing a setting changes the facts and history cannot be re-judged.
 *      Here thresholds are absent by construction.
 *   2. Raw counters instead of verdicts. Absence emits `loops` already filtered
 *      by the user's thresholds and `runningAtEnd` already filtered by the
 *      leftover-egg ignore list. Chart keeps `reverts`, `retries` and every
 *      running primary, and lets a rule decide what is worth a look.
 *   3. `lifetimeMs` is measured against the run end, never the wall clock, so
 *      the same stream always produces the same numbers.
 *
 * Everything else — pairing shell tool calls with `command` events, detecting
 * reverts by comparing full-file versions, deciding a watcher change is
 * "observed" only when the agent did not write the path itself — is Absence's
 * logic, kept because it was hard-won.
 */

import type { ChartEvent } from "../core/events.ts";
import { eventPath } from "../core/events.ts";
import type {
  CommandFact,
  Facts,
  FileFact,
  McpUsageFact,
  OutsideChangeFact,
  Phase,
  PhaseType,
  ProcessFact,
  ReadKnowledge,
  Recovery,
  RetryFact,
  RevertFact,
  Run,
  SearchKnowledge,
  TimelineKind,
  TimelineNode,
} from "../core/types.ts";
import { countDiff, firstLine, lineCount } from "./diff.ts";

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

type PhaseSignalKind = "read" | "search" | "write" | "cmd-success" | "cmd-fail";

interface BuiltCommand extends CommandFact {
  /** Position in the run's slice; a recovery must have activity after the failure. */
  sliceIndex: number;
}

interface PendingTool {
  toolName: string;
  command: string;
  at: number;
  eventId: string;
  sliceIndex: number;
}

interface WatcherChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  eventId: string;
  at: number;
}

/** An ordered, de-duplicated string set that also supports removal (deletes). */
function orderedSet() {
  const map = new Map<string, true>();
  return {
    add(value: string) {
      map.set(value, true);
    },
    delete(value: string) {
      map.delete(value);
    },
    has(value: string) {
      return map.has(value);
    },
    keys(): string[] {
      return [...map.keys()];
    },
    size(): number {
      return map.size;
    },
  };
}

/**
 * Build the facts for one run.
 *
 * `events` is the session's full stream and `run` points into it, so paths seen
 * before the run can be told apart from paths created by it. `allEvents` is only
 * read before `run.fromIndex`.
 */
export function buildFacts(events: readonly ChartEvent[], run: Run): Facts {
  const slice = events.slice(run.fromIndex, run.toIndex + 1);
  const runEnd = run.endedAt ?? lastTimestamp(slice) ?? run.startedAt;

  // `created` means "new here": seed with every path seen before this run so a
  // second run that writes a file an earlier run read is a modification.
  const known = new Set<string>();
  for (let i = 0; i < run.fromIndex && i < events.length; i++) {
    const path = eventPath(events[i]!);
    if (path) known.add(path);
  }

  const read = orderedSet();
  const created = orderedSet();
  const modified = orderedSet();
  const deleted = orderedSet();
  const observed = orderedSet();
  const byPath = new Map<string, FileFact>();
  const file = (path: string, at: number): FileFact => {
    let fact = byPath.get(path);
    if (!fact) {
      fact = {
        path,
        firstSeenAt: at,
        lastSeenAt: at,
        read: false,
        agentWrite: false,
        agentEdit: false,
        externalChange: false,
        additions: 0,
        deletions: 0,
        evidence: [],
      };
      byPath.set(path, fact);
    }
    fact.lastSeenAt = at;
    return fact;
  };

  const watcher: WatcherChange[] = [];
  const agentChanged = new Set<string>();
  /** Whether the write at this event id created the path (vs rewrote it). */
  const writeCreated = new Map<string, boolean>();
  const evidence: string[] = [];
  const signals: { kind: PhaseSignalKind; eventId: string; at: number }[] = [];

  // What the agent learned: reads merged per path, plus every search.
  const readRanges = new Map<string, { start: number; end: number; evidence: string[] }>();
  const searches: SearchKnowledge[] = [];

  const commands: BuiltCommand[] = [];
  const openTools = new Map<string, PendingTool>();
  const unclaimedEnds: BuiltCommand[] = [];
  const errorEvidence: string[] = [];
  /** Eggs, folded per pid like the file facts: laid once, then updated. */
  const processByPid = new Map<number, ProcessFact>();
  /** MCP calls, folded per server: what the agent reached outside the project. */
  const mcpByServer = new Map<string, McpUsageFact>();

  let reads = 0;
  let edits = 0;
  let writes = 0;
  let additions = 0;
  let deletions = 0;
  let response: string | undefined;

  // Revert detection: the agent's known lines mirror the file store's read
  // accumulator (the v0 state); full contents are the v1..vN states a write or
  // edit produced. A new state equal to an earlier one is a revert.
  const knownLines = new Map<string, Record<number, string>>();
  const fullVersions = new Map<string, { content: string; eventId: string }[]>();
  const reverts = new Map<string, { path: string; count: number; evidence: string[] }>();
  const retries = new Map<string, { count: number; command: string; evidence: string[] }>();
  const worstStreak: { count: number; evidence: string[] } = { count: 0, evidence: [] };
  const currentStreak: { count: number; evidence: string[] } = { count: 0, evidence: [] };
  const noteStreak = (failed: boolean, eventId: string): void => {
    if (failed) {
      currentStreak.count++;
      currentStreak.evidence.push(eventId);
      if (currentStreak.count > worstStreak.count) {
        worstStreak.count = currentStreak.count;
        worstStreak.evidence = [...currentStreak.evidence];
      }
    } else {
      currentStreak.count = 0;
      currentStreak.evidence = [];
    }
  };
  const outsideChanges = new Map<string, { count: number; evidence: string[] }>();

  for (let i = 0; i < slice.length; i++) {
    const event = slice[i]!;
    evidence.push(event.id);

    switch (event.type) {
      case "file_read": {
        const { path, startLine, endLine, content } = event.payload;
        reads++;
        read.add(path);
        deleted.delete(path);
        const lines = knownLines.get(path) ?? {};
        content.split("\n").forEach((line, index) => {
          lines[startLine + index] = line;
        });
        knownLines.set(path, lines);
        const fact = file(path, event.timestamp);
        fact.read = true;
        fact.evidence.push(event.id);
        known.add(path);
        const range = readRanges.get(path);
        if (range) {
          range.start = Math.min(range.start, startLine);
          range.end = Math.max(range.end, endLine);
          range.evidence.push(event.id);
        } else {
          readRanges.set(path, { start: startLine, end: endLine, evidence: [event.id] });
        }
        signals.push({ kind: "read", eventId: event.id, at: event.timestamp });
        break;
      }
      case "file_write": {
        const { path, content } = event.payload;
        writes++;
        deleted.delete(path);
        agentChanged.add(path);
        noteFileVersion(path, content, event.id, knownLines, fullVersions, reverts);
        const isNew = !known.has(path);
        writeCreated.set(event.id, isNew);
        if (isNew) {
          created.add(path);
          additions += lineCount(content);
        } else {
          modified.add(path);
        }
        known.add(path);
        const fact = file(path, event.timestamp);
        fact.agentWrite = true;
        fact.evidence.push(event.id);
        signals.push({ kind: "write", eventId: event.id, at: event.timestamp });
        break;
      }
      case "file_edit": {
        const { path, after, diff } = event.payload;
        edits++;
        deleted.delete(path);
        agentChanged.add(path);
        modified.add(path);
        known.add(path);
        noteFileVersion(path, after, event.id, knownLines, fullVersions, reverts);
        const counts = countDiff(diff);
        additions += counts.added;
        deletions += counts.removed;
        const fact = file(path, event.timestamp);
        fact.agentEdit = true;
        fact.additions += counts.added;
        fact.deletions += counts.removed;
        fact.evidence.push(event.id);
        signals.push({ kind: "write", eventId: event.id, at: event.timestamp });
        break;
      }
      case "file_change":
        watcher.push({
          path: event.payload.path,
          kind: event.payload.kind,
          eventId: event.id,
          at: event.timestamp,
        });
        if (event.payload.outside) {
          const outside = outsideChanges.get(event.payload.path) ?? { count: 0, evidence: [] };
          outside.count++;
          outside.evidence.push(event.id);
          outsideChanges.set(event.payload.path, outside);
        }
        break;
      case "search":
        searches.push({
          tool: event.payload.tool,
          query: event.payload.query,
          scope: event.payload.scope,
          matches: event.payload.matches,
          evidence: [event.id],
        });
        signals.push({ kind: "search", eventId: event.id, at: event.timestamp });
        break;
      case "message":
        if (event.payload.role === "assistant" && event.payload.content.trim().length > 0) {
          response = event.payload.content;
        }
        break;
      case "error":
        errorEvidence.push(event.id);
        break;
      case "tool_start": {
        if (SHELL_TOOLS.has(event.payload.toolName)) {
          const args = (event.payload.args ?? {}) as { command?: unknown };
          openTools.set(event.payload.toolCallId, {
            toolName: event.payload.toolName,
            command: String(args.command ?? ""),
            at: event.timestamp,
            eventId: event.id,
            sliceIndex: i,
          });
        }
        break;
      }
      case "tool_end": {
        const id = event.payload.toolCallId;
        const start = openTools.get(id);
        if (!start || !SHELL_TOOLS.has(event.payload.toolName)) break;
        openTools.delete(id);
        if (event.payload.isError) {
          // A tool-level failure emits no `command` event at all, so this is
          // the only place a failed shell command is visible.
          commands.push({
            eventId: event.id,
            toolCallId: id,
            toolName: start.toolName,
            command: start.command,
            startedAt: start.at,
            endedAt: event.timestamp,
            durationMs: event.timestamp - start.at,
            status: "failed",
            evidence: [start.eventId, event.id],
            sliceIndex: i,
          });
          signals.push({ kind: "cmd-fail", eventId: event.id, at: event.timestamp });
          noteStreak(true, event.id);
        } else {
          unclaimedEnds.push({
            eventId: event.id,
            toolCallId: id,
            toolName: start.toolName,
            command: start.command,
            startedAt: start.at,
            endedAt: event.timestamp,
            durationMs: event.timestamp - start.at,
            status: "unknown",
            evidence: [start.eventId, event.id],
            sliceIndex: i,
          });
        }
        break;
      }
      case "mcp": {
        const { server, tool, isError } = event.payload;
        const usage = mcpByServer.get(server) ?? { server, calls: 0, failed: 0, tools: [], evidence: [] };
        usage.calls += 1;
        if (isError) usage.failed += 1;
        if (!usage.tools.includes(tool)) usage.tools.push(tool);
        usage.evidence.push(event.id);
        mcpByServer.set(server, usage);
        break;
      }
      case "command": {
        const exitCode = event.payload.exitCode;
        const status = exitCode === 0 ? "success" : "failed";
        const end = unclaimedEnds.pop();
        commands.push(
          end
            ? {
                ...end,
                eventId: event.id,
                command: event.payload.command,
                exitCode,
                status,
                evidence: [...end.evidence, event.id],
                sliceIndex: i,
              }
            : {
                eventId: event.id,
                toolName: "shell",
                command: event.payload.command,
                exitCode,
                status,
                evidence: [event.id],
                sliceIndex: i,
              },
        );
        signals.push({
          kind: status === "success" ? "cmd-success" : "cmd-fail",
          eventId: event.id,
          at: event.timestamp,
        });
        noteStreak(status === "failed", event.id);
        if (status === "failed") {
          const key = event.payload.command.trim();
          const seen = retries.get(key) ?? { count: 0, command: key, evidence: [] };
          seen.count++;
          seen.evidence.push(event.id);
          retries.set(key, seen);
        }
        break;
      }
      case "process": {
        const {
          pid,
          name,
          commandLine,
          command,
          startedAt,
          exitedAt,
          children,
          status,
          kind,
          kindReason,
        } = event.payload;
        const fact: ProcessFact = processByPid.get(pid) ?? {
          pid,
          name,
          commandLine,
          startedAt,
          children,
          running: false,
          kind: kind ?? "primary",
          kindReason,
          lifetimeMs: 0,
          evidence: [],
        };
        fact.name = name;
        fact.commandLine = commandLine;
        if (kind !== undefined) fact.kind = kind;
        if (kindReason !== undefined) fact.kindReason = kindReason;
        if (command !== undefined) fact.command = command;
        if (exitedAt !== undefined) fact.exitedAt = exitedAt;
        fact.children = children;
        fact.running = status === "running";
        fact.lifetimeMs = Math.max(0, (fact.exitedAt ?? runEnd) - fact.startedAt);
        fact.evidence.push(event.id);
        processByPid.set(pid, fact);
        break;
      }
      default:
        break;
    }
  }

  // A shell tool that started but never ended is still running.
  for (const [toolCallId, start] of openTools) {
    commands.push({
      eventId: start.eventId,
      toolCallId,
      toolName: start.toolName,
      command: start.command,
      startedAt: start.at,
      status: "running",
      evidence: [start.eventId],
      sliceIndex: start.sliceIndex,
    });
  }
  for (const end of unclaimedEnds) commands.push(end);

  // Second pass: a watcher change is "observed" only when the agent did not
  // write or edit that path itself (the watcher fires for the agent's writes too).
  for (const change of watcher) {
    const fact = file(change.path, change.at);
    fact.evidence.push(change.eventId);
    if (change.kind === "deleted") {
      read.delete(change.path);
      created.delete(change.path);
      modified.delete(change.path);
      observed.delete(change.path);
      deleted.add(change.path);
      continue;
    }
    if (!agentChanged.has(change.path)) {
      observed.add(change.path);
      deleted.delete(change.path);
      fact.externalChange = true;
    }
  }

  const commandFacts: CommandFact[] = commands.map(({ sliceIndex: _sliceIndex, ...fact }) => fact);
  const counts = { total: 0, running: 0, succeeded: 0, failed: 0, unknown: 0 };
  for (const command of commands) {
    counts.total++;
    if (command.status === "running") counts.running++;
    else if (command.status === "success") counts.succeeded++;
    else if (command.status === "failed") counts.failed++;
    else counts.unknown++;
  }

  const recoveries = findRecoveries(commands, slice);
  const failedIds = commands.filter((command) => command.status === "failed").map((command) => command.eventId);
  const recovered = new Set(recoveries.map((recovery) => recovery.failedCommandId));
  const unresolved = failedIds.filter((id) => !recovered.has(id));

  const phases = buildPhases(signals);
  const processFacts = [...processByPid.values()];
  const primary = processFacts.filter((fact) => fact.kind === "primary");
  const runningAtEnd = primary.filter((fact) => fact.running);
  const lastActivityAt = slice.length > 0 ? slice[slice.length - 1]!.timestamp : run.startedAt;

  return {
    sessionId: slice[0]?.sessionId ?? "",
    run,
    files: {
      read: read.keys(),
      created: created.keys(),
      modified: modified.keys(),
      deleted: deleted.keys(),
      observed: observed.keys(),
      byPath: Object.fromEntries(byPath),
    },
    commands: counts,
    commandFacts,
    failed: commands.filter((command) => command.status === "failed").map(({ sliceIndex: _i, ...fact }) => fact),
    mcp: {
      calls: [...mcpByServer.values()].reduce((sum, usage) => sum + usage.calls, 0),
      failed: [...mcpByServer.values()].reduce((sum, usage) => sum + usage.failed, 0),
      servers: Object.fromEntries(mcpByServer),
    },
    processes: {
      all: processFacts,
      primary,
      runningAtEnd,
      tools: processFacts.length - primary.length,
      byPid: Object.fromEntries(primary.map((fact) => [fact.pid, fact])),
    },
    errors: { total: errorEvidence.length, evidence: errorEvidence },
    changes: { additions, deletions },
    counts: { reads, searches: searches.length, edits, writes },
    knowledge: {
      reads: [...readRanges.entries()].map(
        ([path, range]): ReadKnowledge => ({
          path,
          startLine: range.start,
          endLine: range.end,
          evidence: range.evidence,
        }),
      ),
      searches,
    },
    phases,
    currentPhase: phases.length > 0 ? phases[phases.length - 1]!.type : "investigating",
    recoveries,
    reverts: [...reverts.values()].map(
      (entry): RevertFact => ({ path: entry.path, count: entry.count, evidence: entry.evidence }),
    ),
    retries: [...retries.values()].map(
      (entry): RetryFact => ({ command: entry.command, count: entry.count, evidence: entry.evidence }),
    ),
    failureStreak: worstStreak,
    outsideChanges: [...outsideChanges.entries()].map(
      ([path, seen]): OutsideChangeFact => ({ path, count: seen.count, evidence: seen.evidence }),
    ),
    timeline: buildTimeline(slice, run, commandFacts, agentChanged, writeCreated),
    unresolved,
    ended: run.status !== "running" || run.endedAt !== undefined,
    lastActivityAt,
    evidence,
    response,
  };
}

function lastTimestamp(slice: readonly ChartEvent[]): number | undefined {
  return slice.length > 0 ? slice[slice.length - 1]!.timestamp : undefined;
}

/**
 * Record a full-file version the agent produced and flag a *revert*: the new
 * state equals a state the agent already held — the v0 read snapshot, or an
 * earlier full version. That is the v2 ≡ v0 shape: the agent changed the file,
 * then changed it back, or wrote what it started with. Pure text comparison.
 *
 * A partial read only counts as "the same" when it is whole-file: v0 is never
 * diffed against full versions.
 */
function noteFileVersion(
  path: string,
  content: string,
  eventId: string,
  knownLines: Map<string, Record<number, string>>,
  fullVersions: Map<string, { content: string; eventId: string }[]>,
  reverts: Map<string, { path: string; count: number; evidence: string[] }>,
): void {
  const versions = fullVersions.get(path) ?? [];
  const known = knownLines.get(path);
  const contiguousRead =
    known !== undefined && Object.keys(known).length > 0 ? isContiguous(Object.keys(known).map(Number)) : false;
  const readText = contiguousRead ? renderKnownLines(known!) : undefined;

  const matchesEarlier =
    (readText !== undefined && readText === content) || versions.some((version) => version.content === content);

  if (matchesEarlier) {
    const entry = reverts.get(path) ?? { path, count: 0, evidence: [] };
    entry.count++;
    entry.evidence.push(eventId);
    reverts.set(path, entry);
  }

  versions.push({ content, eventId });
  fullVersions.set(path, versions);
}

/** Whether sorted line numbers form one run with no holes. */
function isContiguous(lines: number[]): boolean {
  if (lines.length === 0) return false;
  const sorted = [...lines].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! !== sorted[i - 1]! + 1) return false;
  }
  return true;
}

/** Rebuild the text a contiguous set of known lines represents. */
function renderKnownLines(lines: Record<number, string>): string {
  const numbers = Object.keys(lines)
    .map(Number)
    .sort((a, b) => a - b);
  return numbers.map((n) => lines[n] ?? "").join("\n");
}

/**
 * A failure is recovered when **activity happens after it** and a later command
 * succeeds. Ported verbatim from Absence, including two details that are easy to
 * get wrong and that a parity run over the archive caught:
 *
 *   · a success only recovers a failure when at least two events separate them
 *     (`sliceIndex` distance ≥ 2) — a success immediately after a failure, with
 *     nothing in between, is the same action retried, not a recovery;
 *   · one success recovers **one** failure, the most recent one still pending.
 *
 * Getting either wrong makes Chart quietly report fewer unresolved failures than
 * Absence, which is exactly the sort of drift the parity harness exists to find.
 */
function findRecoveries(commands: BuiltCommand[], slice: readonly ChartEvent[]): Recovery[] {
  const recoveries: Recovery[] = [];
  const pending: number[] = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    if (command.status === "failed") {
      pending.push(index);
      continue;
    }
    if (command.status !== "success") continue;
    for (let q = pending.length - 1; q >= 0; q--) {
      const failureIndex = pending[q]!;
      const failure = commands[failureIndex]!;
      if (command.sliceIndex - failure.sliceIndex < 2) continue; // no activity between
      const between = slice.slice(failure.sliceIndex + 1, command.sliceIndex);
      recoveries.push({
        failedCommandId: failure.eventId,
        successfulCommandId: command.eventId,
        recoveryEvents: between.map((event) => event.id),
        hadEdit: between.some((event) => event.type === "file_write" || event.type === "file_edit"),
      });
      pending.splice(q, 1);
      break;
    }
  }
  return recoveries;
}

/** A coarse phase per stretch of activity — an interpretation, but a cheap one. */
function buildPhases(signals: { kind: PhaseSignalKind; eventId: string; at: number }[]): Phase[] {
  const phases: Phase[] = [];
  const phaseOf = (kind: PhaseSignalKind): PhaseType => {
    switch (kind) {
      case "read":
      case "search":
        return "investigating";
      case "write":
        return "implementing";
      case "cmd-success":
        return "verifying";
      case "cmd-fail":
        return "recovering";
    }
  };
  for (const signal of signals) {
    const type = phaseOf(signal.kind);
    if (phases.length > 0 && phases[phases.length - 1]!.type === type) continue;
    phases.push({ type, at: signal.at, eventId: signal.eventId });
  }
  return phases;
}

/**
 * The run as an ordered world line: one node per activity, in the order it
 * happened, each carrying what it caused. Consecutive thoughts collapse into the
 * one they are — a hundred nodes for one idea would not be a world line.
 */
function buildTimeline(
  slice: readonly ChartEvent[],
  run: Run,
  commandFacts: CommandFact[],
  agentChanged: Set<string>,
  writeCreated: Map<string, boolean>,
): TimelineNode[] {
  const commandByEvent = new Map(commandFacts.map((command) => [command.eventId, command]));
  const nodes: TimelineNode[] = [];
  const push = (event: ChartEvent, kind: TimelineKind, action: string, subject: string, effects: string[]) =>
    nodes.push({
      eventId: event.id,
      kind,
      at: event.timestamp,
      offsetMs: Math.max(0, event.timestamp - run.startedAt),
      action,
      subject,
      effects,
    });

  for (const event of slice) {
    switch (event.type) {
      case "agent_start":
        push(event, "start", "START", event.payload.model, []);
        break;

      case "thinking": {
        const subject = firstLine(event.payload.content);
        const last = nodes[nodes.length - 1];
        if (last?.kind === "think") {
          last.eventId = event.id;
          last.at = event.timestamp;
          last.offsetMs = Math.max(0, event.timestamp - run.startedAt);
          last.subject = subject;
        } else {
          push(event, "think", "THINK", subject, []);
        }
        break;
      }

      case "file_read": {
        const { path, startLine, endLine } = event.payload;
        push(event, "read", "READ", path, [`lines ${startLine}–${endLine} into context`]);
        break;
      }

      case "search": {
        const { tool, query, scope, matches } = event.payload;
        push(event, "search", "SEARCH", `${tool} ${query}`, [
          `${matches} hit${matches === 1 ? "" : "s"}${scope ? ` in ${scope}` : ""}`,
        ]);
        break;
      }

      case "file_edit": {
        const { added, removed } = countDiff(event.payload.diff);
        push(event, "edit", "EDIT", event.payload.path, [`changed +${added} −${removed} lines`]);
        break;
      }

      case "file_write": {
        const { path, content } = event.payload;
        const lines = lineCount(content);
        const isNew = writeCreated.get(event.id) === true;
        push(event, "write", isNew ? "CREATE" : "WRITE", path, [
          isNew ? `created ${lines} line${lines === 1 ? "" : "s"}` : `rewrote ${lines} lines`,
        ]);
        break;
      }

      case "file_change": {
        const { path, kind, outside } = event.payload;
        push(event, "observe", outside ? "OUTSIDE" : kind === "deleted" ? "REMOVE" : "CHANGE", path, [
          outside
            ? "changed outside the project"
            : kind === "deleted"
              ? "deleted on disk"
              : agentChanged.has(path)
                ? "the agent's write landed on disk"
                : "changed outside the agent",
        ]);
        break;
      }

      case "tool_start":
      case "command":
      case "tool_end": {
        const command = commandByEvent.get(event.id);
        if (!command) break;
        push(event, "run", "RUN", command.command || "(shell)", [commandEffect(command)]);
        break;
      }

      case "process": {
        const { kind } = event.payload;
        if (kind === "tool") break;
        const { pid, name, commandLine, command, status, children, startedAt, exitedAt } = event.payload;
        const livedSeconds = Math.max(0, Math.round(((exitedAt ?? startedAt) - startedAt) / 1000));
        push(
          event,
          "process",
          status === "running" ? "LAID" : "DIED",
          name,
          status === "running"
            ? [`pid ${pid}${children > 0 ? ` +${children}` : ""}`, command ?? commandLine]
            : [`pid ${pid}`, `exited after ${livedSeconds}s`],
        );
        break;
      }

      case "error":
        push(event, "error", "ERROR", event.payload.message, []);
        break;

      case "agent_end":
        push(event, "end", "END", event.payload.reason, []);
        break;

      default:
        break;
    }
  }

  return nodes;
}

/** What the observer can say about a command's effect, without reading it. */
function commandEffect(command: CommandFact): string {
  if (command.status === "running") return "process still running";
  if (command.status === "failed") {
    return command.exitCode !== undefined ? `failed · exit ${command.exitCode}` : "failed, no output captured";
  }
  if (command.status === "success") return `exit ${command.exitCode}`;
  return "outcome unknown";
}
