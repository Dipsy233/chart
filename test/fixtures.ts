/**
 * Event-stream fixtures. One builder, so a test reads like the story it tells:
 *
 *   const s = session("s1");
 *   s.command("npm test", 1);
 *   s.agentEnd("completed");
 *   const facts = factsOf(s.events);
 */

import type { ChartEvent, ChartEventPayloadMap, ChartEventType } from "../src/core/events.ts";
import { buildFacts } from "../src/facts/build.ts";
import { deriveRuns, pickRun } from "../src/facts/runs.ts";
import type { Facts } from "../src/core/types.ts";

let counter = 0;

/** Reset the id sequence so two builds of the same story are byte-identical. */
export function resetEventIds(): void {
  counter = 0;
}

export class Session {
  readonly events: ChartEvent[] = [];
  private clock: number;

  constructor(
    readonly sessionId = "s1",
    startedAt = 1_000,
  ) {
    this.clock = startedAt;
  }

  /** Advance the clock and return the new timestamp. */
  tick(by = 1000): number {
    this.clock += by;
    return this.clock;
  }

  push<K extends ChartEventType>(type: K, payload: ChartEventPayloadMap[K], by = 1000): ChartEvent {
    const event = {
      id: `evt_${++counter}`,
      sessionId: this.sessionId,
      timestamp: this.tick(by),
      type,
      payload,
    } as ChartEvent;
    this.events.push(event);
    return event;
  }

  /* ── The vocabulary tests actually use ───────────────────────────────── */

  agentStart(model = "qwen3-4b"): ChartEvent {
    return this.push("agent_start", { model });
  }

  agentEnd(reason = "completed"): ChartEvent {
    return this.push("agent_end", { reason });
  }

  userMessage(content: string): ChartEvent {
    return this.push("message", { role: "user", content });
  }

  reply(content: string): ChartEvent {
    return this.push("message", { role: "assistant", content });
  }

  /** A shell command with an exit code, the way a `command` event carries it. */
  command(command: string, exitCode = 0): ChartEvent {
    return this.push("command", { command, stdout: "", stderr: "", exitCode });
  }

  /** A shell tool that failed, which emits no `command` event at all. */
  failedTool(command: string): ChartEvent {
    const toolCallId = `call_${counter + 1}`;
    this.push("tool_start", { toolCallId, toolName: "bash", args: { command } });
    return this.push("tool_end", { toolCallId, toolName: "bash", isError: true });
  }

  read(path: string, content: string, startLine = 1, endLine = 1): ChartEvent {
    return this.push("file_read", { path, startLine, endLine, content });
  }

  write(path: string, content: string): ChartEvent {
    return this.push("file_write", { path, content });
  }

  edit(path: string, before: string, after: string): ChartEvent {
    return this.push("file_edit", { path, before, after, diff: `--- a\n+++ b\n-${before}\n+${after}` });
  }

  change(path: string, kind: "created" | "modified" | "deleted", outside = false): ChartEvent {
    return this.push("file_change", outside ? { path, kind, outside } : { path, kind });
  }

  search(tool: string, query: string, matches = 1): ChartEvent {
    return this.push("search", { tool, query, matches });
  }

  error(message: string): ChartEvent {
    return this.push("error", { message });
  }

  thinking(content: string): ChartEvent {
    return this.push("thinking", { content });
  }

  process(options: {
    pid: number;
    name: string;
    commandLine?: string;
    command?: string;
    status?: "running" | "exited";
    startedAt?: number;
    exitedAt?: number;
    children?: number;
    kind?: "primary" | "tool";
  }): ChartEvent {
    return this.push("process", {
      pid: options.pid,
      name: options.name,
      commandLine: options.commandLine ?? options.name,
      command: options.command,
      status: options.status ?? "running",
      startedAt: options.startedAt ?? this.clock,
      exitedAt: options.exitedAt,
      children: options.children ?? 0,
      kind: options.kind ?? "primary",
    });
  }

  approval(id = "ap_1", kind = "command"): ChartEvent {
    return this.push("approval", {
      id,
      kind,
      title: `Allow ${kind}?`,
      detail: "rm -rf dist",
      options: [
        { value: "accept", label: "Yes" },
        { value: "decline", label: "No" },
      ],
    });
  }

  toolUpdate(toolCallId: string, toolName = "bash"): ChartEvent {
    return this.push("tool_update", { toolCallId, toolName, partial: {} });
  }

  mcp(server: string, tool: string, isError = false): ChartEvent {
    return this.push("mcp", {
      server,
      tool,
      toolName: `mcp__${server}__${tool}`,
      toolCallId: `call_${counter + 1}`,
      isError,
    });
  }
}

export function session(sessionId = "s1"): Session {
  return new Session(sessionId);
}

/** The newest run's facts. */
export function factsOf(events: readonly ChartEvent[]): Facts {
  const runs = deriveRuns(events);
  const run = pickRun(runs);
  if (!run) throw new Error("no run in this stream");
  return buildFacts(events, run);
}

/** A settled run whose agent did one command, for tests that need a base. */
export function simpleRun(): ChartEvent[] {
  const s = session();
  s.agentStart();
  s.command("ls", 0);
  s.agentEnd("completed");
  return s.events;
}
