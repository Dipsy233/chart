/**
 * A demo run to judge — the same story the CLI demo tells, so the editor has
 * something real to point at on first load.
 *
 * It is deliberately ordinary: a research task, two deliverables, one flaky
 * endpoint hit twice, one file written outside the project, one process left
 * running. That is enough for every default rule to have an opinion.
 */

import type { ChartEvent } from "../../../src/core/events.ts";

export function demoEvents(): ChartEvent[] {
  let clock = Date.now() - 2 * 60 * 60_000;
  let counter = 0;

  const event = (type: ChartEvent["type"], payload: unknown): ChartEvent => {
    clock += 4_000 + Math.round(Math.random() * 3_000);
    return { id: `evt_${++counter}`, sessionId: "demo", timestamp: clock, type, payload } as ChartEvent;
  };

  return [
    event("agent_start", { model: "qwen3-4b" }),
    event("message", { role: "user", content: "Research Acme Corp and put everything in company/" }),
    event("thinking", { content: "I should start with their public filings and pricing page." }),
    event("search", { tool: "grep", query: "acme", matches: 12 }),
    event("file_read", { path: "README.md", startLine: 1, endLine: 20, content: "line\n".repeat(20) }),
    event("command", { command: "curl -s https://acme.example/about", stdout: "…", stderr: "", exitCode: 0 }),
    event("file_write", { path: "company/intro.txt", content: "Acme Corp — company profile\n" }),
    event("message", {
      role: "assistant",
      content: "I've written the company profile to company/intro.txt. Next I'll research pricing.",
    }),
    event("command", {
      command: "curl -s https://acme.example/pricing",
      stdout: "",
      stderr: "timeout",
      exitCode: 28,
    }),
    event("command", {
      command: "curl -s https://acme.example/pricing",
      stdout: "",
      stderr: "timeout",
      exitCode: 28,
    }),
    event("thinking", { content: "The pricing page times out; try the cached copy." }),
    event("file_write", { path: "company/pricing.md", content: "# Pricing\n" }),
    event("file_change", { path: "../secrets/.env", kind: "modified", outside: true }),
    event("process", {
      pid: 8123,
      name: "node",
      commandLine: "node scraper.mjs",
      command: "node scraper.mjs",
      status: "running",
      startedAt: clock - 20_000,
      children: 2,
      kind: "primary",
    }),
    event("agent_end", { reason: "completed" }),
  ];
}

/**
 * A second story: the agent flails. Five failures inside two minutes, then a
 * recovery, then a stall — so a user can see a window rule fire and slide.
 */
export function flailingEvents(): ChartEvent[] {
  let clock = Date.now() - 30 * 60_000;
  let counter = 0;
  const event = (type: ChartEvent["type"], payload: unknown, step = 8_000): ChartEvent => {
    clock += step;
    return { id: `evt_${++counter}`, sessionId: "flail", timestamp: clock, type, payload } as ChartEvent;
  };

  const events: ChartEvent[] = [
    event("agent_start", { model: "qwen3-4b" }),
    event("message", { role: "user", content: "make the test suite pass" }),
    event("file_read", { path: "src/index.ts", startLine: 1, endLine: 40, content: "x\n".repeat(40) }),
  ];
  for (let i = 0; i < 5; i++) {
    events.push(
      event("command", { command: "npm test", stdout: "", stderr: `failure ${i}`, exitCode: 1 }, 20_000),
    );
  }
  events.push(event("thinking", { content: "The same assertion keeps failing. Let me read the fixture." }));
  events.push(event("file_edit", {
    path: "src/index.ts",
    before: "expect(a).toBe(1)",
    after: "expect(a).toBe(2)",
    diff: "--- a/src/index.ts\n+++ b/src/index.ts\n-expect(a).toBe(1)\n+expect(a).toBe(2)",
  }));
  events.push(event("command", { command: "npm test", stdout: "ok", stderr: "", exitCode: 0 }, 30_000));
  events.push(event("agent_end", { reason: "completed" }, 30_000));
  return events;
}

export const DEMOS: Array<{ id: string; label: string; build: () => ChartEvent[] }> = [
  { id: "research", label: "research run (deliverables)", build: demoEvents },
  { id: "flailing", label: "flailing run (5 failures, then fixed)", build: flailingEvents },
];
