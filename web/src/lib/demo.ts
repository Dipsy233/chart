/**
 * The runs the editor opens with.
 *
 * Each demo is a whole session, and a session may hold several runs — the report
 * panel simulates one run at a time, so the run list has something to select.
 * The stories are deliberately ordinary: a research task with deliverables, a
 * flailing test run, and a three-round session where the same pack has a
 * different opinion about each round.
 */

import type { ChartEvent } from "../../../src/core/events.ts";

export interface Demo {
  id: string;
  /** Shown in 监护对象. Chinese: this is the ward, not a log file. */
  label: string;
  /** One line about what the session shows. */
  description: string;
  build: () => ChartEvent[];
}

function sessionBuilder(id: string, start: number) {
  let clock = start;
  let counter = 0;
  return {
    at: () => clock,
    event(type: ChartEvent["type"], payload: unknown, step = 5_000): ChartEvent {
      clock += step;
      return { id: `${id}_${++counter}`, sessionId: id, timestamp: clock, type, payload } as ChartEvent;
    },
  };
}

/**
 * A research task: two deliverables, a flaky endpoint hit twice, a file written
 * outside the project, a process left running.
 */
export function demoEvents(): ChartEvent[] {
  const s = sessionBuilder("research", Date.now() - 2 * 60 * 60_000);
  return [
    s.event("agent_start", { model: "qwen3-4b" }, 0),
    s.event("message", { role: "user", content: "调研 Acme 公司，把结果放进 company/ 目录" }),
    s.event("thinking", { content: "先从公开资料和定价页开始。" }),
    s.event("search", { tool: "grep", query: "acme", matches: 12 }),
    s.event("file_read", { path: "README.md", startLine: 1, endLine: 20, content: "line\n".repeat(20) }),
    s.event("command", { command: "curl -s https://acme.example/about", stdout: "…", stderr: "", exitCode: 0 }),
    s.event("file_write", { path: "company/intro.txt", content: "Acme Corp — 公司简介\n" }),
    s.event("message", {
      role: "assistant",
      content: "已经把公司简介写入 company/intro.txt，接下来查定价。",
    }),
    s.event("command", {
      command: "curl -s https://acme.example/pricing",
      stdout: "",
      stderr: "timeout",
      exitCode: 28,
    }),
    s.event("command", {
      command: "curl -s https://acme.example/pricing",
      stdout: "",
      stderr: "timeout",
      exitCode: 28,
    }),
    s.event("thinking", { content: "定价页超时，改用缓存副本。" }),
    s.event("file_write", { path: "company/pricing.md", content: "# 定价\n" }),
    s.event("file_change", { path: "../secrets/.env", kind: "modified", outside: true }),
    s.event("process", {
      pid: 8123,
      name: "node",
      commandLine: "node scraper.mjs",
      command: "node scraper.mjs",
      status: "running",
      startedAt: s.at() - 20_000,
      children: 2,
      kind: "primary",
    }),
    s.event("agent_end", { reason: "completed" }),
  ];
}

/**
 * The agent flails: five failures inside two minutes, then an edit and a
 * success. A window rule fires while the streak builds, then goes quiet.
 */
export function flailingEvents(): ChartEvent[] {
  const s = sessionBuilder("flail", Date.now() - 30 * 60_000);
  const events: ChartEvent[] = [
    s.event("agent_start", { model: "qwen3-4b" }, 0),
    s.event("message", { role: "user", content: "把测试全部跑通" }),
    s.event("file_read", { path: "src/index.ts", startLine: 1, endLine: 40, content: "x\n".repeat(40) }),
  ];
  for (let i = 0; i < 5; i++) {
    events.push(s.event("command", { command: "npm test", stdout: "", stderr: `failure ${i}`, exitCode: 1 }, 20_000));
  }
  events.push(s.event("thinking", { content: "同一条断言一直失败，先读 fixture。" }));
  events.push(
    s.event("file_edit", {
      path: "src/index.ts",
      before: "expect(a).toBe(1)",
      after: "expect(a).toBe(2)",
      diff: "--- a/src/index.ts\n+++ b/src/index.ts\n-expect(a).toBe(1)\n+expect(a).toBe(2)",
    }),
  );
  events.push(s.event("command", { command: "npm test", stdout: "ok", stderr: "", exitCode: 0 }, 30_000));
  events.push(s.event("agent_end", { reason: "completed" }, 30_000));
  return events;
}

/**
 * Three rounds in one session. Round 1 leaves an unresolved failure (high),
 * round 2 recovers from it (quiet), round 3 leaves a process behind (low) —
 * the same pack, three different reports.
 */
export function sessionEvents(): ChartEvent[] {
  const s = sessionBuilder("session", Date.now() - 3 * 60 * 60_000);
  const events: ChartEvent[] = [];

  // ── round 1: the pricing page times out and nothing recovers it ──────────
  events.push(s.event("agent_start", { model: "qwen3-4b" }, 0));
  events.push(s.event("message", { role: "user", content: "先查 Acme 的定价" }));
  events.push(s.event("thinking", { content: "直接抓定价页。" }));
  events.push(
    s.event("command", {
      command: "curl -s https://acme.example/pricing",
      stdout: "",
      stderr: "timeout",
      exitCode: 28,
    }),
  );
  events.push(s.event("message", { role: "assistant", content: "定价页请求超时，暂时拿不到。" }));
  events.push(s.event("agent_end", { reason: "completed" }, 10_000));

  // ── round 2: the user pushes again, the retry succeeds ───────────────────
  events.push(s.event("message", { role: "user", content: "再试一次，用缓存" }, 45_000));
  events.push(
    s.event("command", {
      command: "curl -s https://acme.example/pricing",
      stdout: "",
      stderr: "timeout",
      exitCode: 28,
    }),
  );
  events.push(
    s.event("command", {
      command: "curl -s https://acme.example/pricing.cached",
      stdout: "<html>…</html>",
      stderr: "",
      exitCode: 0,
    }),
  );
  events.push(s.event("file_write", { path: "company/pricing.md", content: "# 定价\n\n缓存副本。\n" }));
  events.push(s.event("message", { role: "assistant", content: "拿到缓存副本，已写入 company/pricing.md。" }));
  events.push(s.event("agent_end", { reason: "completed" }, 10_000));

  // ── round 3: a new task, and a scraper left running ──────────────────────
  events.push(s.event("message", { role: "user", content: "顺手起个抓取进程，稍后再收" }, 60_000));
  events.push(s.event("thinking", { content: "先起进程，任务完成后再处理。" }));
  events.push(
    s.event("process", {
      pid: 9311,
      name: "node",
      commandLine: "node scraper.mjs",
      command: "node scraper.mjs",
      status: "running",
      startedAt: s.at(),
      children: 1,
      kind: "primary",
    }),
  );
  events.push(s.event("file_write", { path: "company/notes.md", content: "- 抓取进程已启动\n" }));
  events.push(s.event("message", { role: "assistant", content: "抓取进程已启动，记录写在 company/notes.md。" }));
  events.push(s.event("agent_end", { reason: "completed" }, 10_000));

  return events;
}

export const DEMOS: Demo[] = [
  {
    id: "research",
    label: "研究任务 · 两个交付物",
    description: "一次调研：交付了两个文件，定价页两次超时，还留了个进程在后台。",
    build: demoEvents,
  },
  {
    id: "flailing",
    label: "反复失败 · 五次后修复",
    description: "两分钟内连败五次，改完代码才跑通 —— 用来看时间窗口怎么滑。",
    build: flailingEvents,
  },
  {
    id: "session",
    label: "多轮会话 · 三轮事件",
    description: "同一段会话里的三轮：一轮没恢复、一轮恢复成功、一轮留下进程。",
    build: sessionEvents,
  },
];
