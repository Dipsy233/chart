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
import type { MetricsFrameLike } from "../../../src/core/live.ts";

export interface Demo {
  id: string;
  /** Shown in 监护对象. Chinese: this is the ward, not a log file. */
  label: string;
  /** One line about what the session shows. */
  description: string;
  build: () => ChartEvent[];
  /**
   * Resource samples for the session, oldest → newest.
   *
   * The real host streams these on their own channel (Absence samples every 5s);
   * the editor keeps a handful so the CPU / memory rules have something to judge.
   * Omitted = no sampler, and every `live.metrics.*` path stays absent — which is
   * what a rule has to survive anyway.
   */
  metrics?: () => MetricsFrameLike[];
}

/**
 * A synthetic sampler for a demo: a few 5-second frames with plausible numbers.
 *
 * `cores` is CPU seconds burned per frame per egg (so a rate is derived exactly
 * the way the real sampler derives it), `rss` is MiB, and the host is a machine
 * with a fixed core count and memory.
 */
function metricsBuilder(start: number, specs: Array<{
  at: number;
  eggs: Array<{ pid: number; name: string; kind?: "agent" | "primary" | "tool"; status?: "running" | "exited"; cores: number; rssMiB: number }>;
  hostCpu?: number;
  hostMemPercent?: number;
}>): MetricsFrameLike[] {
  const cpuCount = 8;
  const memTotal = 16 * 1024 * 1024 * 1024;
  // Cumulative counters, accumulated across frames like a real sampler. CPU is
  // integrated over the *elapsed* time between frames, so a rate derived later
  // equals `cores` exactly, however far apart the samples are.
  const cpuTotals = new Map<number, number>();
  const lastTs = new Map<number, number>();
  let hostCpu = 0;
  let hostIdle = 0;
  let previousTs = specs.length > 0 ? Math.floor((start + specs[0]!.at) / 5000) * 5000 : start;
  return specs.map((spec, index) => {
    const ts = Math.floor((start + spec.at) / 5000) * 5000;
    const elapsed = Math.max(0, (ts - previousTs) / 1000);
    previousTs = ts;
    const eggs = spec.eggs.map((egg) => {
      const before = cpuTotals.get(egg.pid) ?? 0;
      const span = index === 0 ? 0 : elapsed || Math.max(0, (ts - (lastTs.get(egg.pid) ?? ts)) / 1000);
      const after = before + egg.cores * span;
      cpuTotals.set(egg.pid, after);
      lastTs.set(egg.pid, ts);
      return {
        eggPid: egg.pid,
        name: egg.name,
        ...(egg.kind ? { kind: egg.kind } : {}),
        status: egg.status ?? "running",
        cpuSeconds: after,
        rssBytes: egg.rssMiB * 1024 * 1024,
        processCount: 1,
        // Session average, as the real sampler keeps it.
        avgCpuCoresSession: index === 0 ? egg.cores : (before + egg.cores) / 2,
        avgRssBytesSession: egg.rssMiB * 1024 * 1024,
      };
    });
    const cpuPercent = spec.hostCpu ?? 20;
    hostCpu += (cpuPercent / 100) * cpuCount * elapsed;
    hostIdle += (1 - cpuPercent / 100) * cpuCount * elapsed;
    return {
      ts,
      eggs,
      host: {
        cpuSeconds: hostCpu,
        cpuIdleSeconds: hostIdle,
        cpuCount,
        memTotalBytes: memTotal,
        memAvailableBytes: memTotal * (1 - (spec.hostMemPercent ?? 45) / 100),
        load1: 1.2,
      },
    };
  });
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
  const start = Date.now() - 2 * 60 * 60_000;
  const s = sessionBuilder("research", start);
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
  const start = Date.now() - 30 * 60_000;
  const s = sessionBuilder("flail", start);
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
  const start = Date.now() - 3 * 60 * 60_000;
  const s = sessionBuilder("session", start);
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
    // The scraper the agent left running is the hot one: 2.4 cores for a minute.
    metrics: () =>
      metricsBuilder(Date.now() - 2 * 60 * 60_000, [
        { at: 5_000, eggs: [{ pid: 8123, name: "node", cores: 0.2, rssMiB: 120 }], hostCpu: 18, hostMemPercent: 44 },
        { at: 30_000, eggs: [{ pid: 8123, name: "node", cores: 1.1, rssMiB: 480 }], hostCpu: 42, hostMemPercent: 48 },
        { at: 60_000, eggs: [{ pid: 8123, name: "node", cores: 2.4, rssMiB: 1150 }], hostCpu: 88, hostMemPercent: 51 },
      ]),
  },
  {
    id: "flailing",
    label: "反复失败 · 五次后修复",
    description: "两分钟内连败五次，改完代码才跑通 —— 用来看时间窗口怎么滑。",
    build: flailingEvents,
    // A test run: bursty CPU that settles once the fix lands, and a machine
    // whose memory is nearly gone the whole time.
    metrics: () =>
      metricsBuilder(Date.now() - 30 * 60_000, [
        { at: 5_000, eggs: [{ pid: 7001, name: "node", cores: 3.8, rssMiB: 640 }], hostCpu: 72, hostMemPercent: 93 },
        { at: 40_000, eggs: [{ pid: 7001, name: "node", cores: 4.2, rssMiB: 720 }], hostCpu: 81, hostMemPercent: 94 },
        { at: 90_000, eggs: [{ pid: 7001, name: "node", cores: 0.6, rssMiB: 300 }], hostCpu: 24, hostMemPercent: 90 },
      ]),
  },
  {
    id: "session",
    label: "多轮会话 · 三轮事件",
    description: "同一段会话里的三轮：一轮没恢复、一轮恢复成功、一轮留下进程。",
    build: sessionEvents,
    // Quiet: the same pack says nothing about resources here.
    metrics: () =>
      metricsBuilder(Date.now() - 3 * 60 * 60_000, [
        { at: 5_000, eggs: [{ pid: 9311, name: "node", cores: 0.15, rssMiB: 90 }], hostCpu: 12, hostMemPercent: 38 },
        { at: 45_000, eggs: [{ pid: 9311, name: "node", cores: 0.2, rssMiB: 95 }], hostCpu: 14, hostMemPercent: 39 },
      ]),
  },
];
