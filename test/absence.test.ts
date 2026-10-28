import { createServer, type Server } from "node:http";
import { check, checkEqual, finish, section } from "./harness.ts";
import {
  collectAbsenceSnapshot,
  framesFromMetrics,
  listAbsenceSessions,
} from "../scripts/absence.ts";
import type { AbsenceLikeEvent } from "../src/adapters/absence.ts";
import { buildFacts } from "../src/facts/build.ts";
import { toChartEvents } from "../src/adapters/absence.ts";
import type { MetricsFrameLike } from "../src/core/live.ts";

/**
 * The Absence hop, against a fake Absence.
 *
 * The real server is another project's process and may not be running, so these
 * checks stand one up in-process with the three endpoints Chart reads. That
 * keeps the contract — the paths, the paging, the shapes — pinned to what Chart
 * actually depends on, which is the part that can silently drift.
 *
 * The behaviour that matters most is the *snapshot*: read once, no cursor, no
 * follow-up call, and the result is a value the caller owns.
 */

const EVENTS: AbsenceLikeEvent[] = [
  { id: "e1", sessionId: "sess_a", timestamp: 1_000, type: "agent_start", payload: { model: "m" } },
  { id: "e2", sessionId: "sess_a", timestamp: 2_000, type: "message", payload: { role: "user", content: "hi" } },
  {
    id: "e3",
    sessionId: "sess_a",
    timestamp: 3_000,
    type: "command",
    payload: { command: "npm test", stdout: "", stderr: "boom", exitCode: 1 },
  },
  { id: "e4", sessionId: "sess_a", timestamp: 4_000, type: "agent_end", payload: { reason: "completed" } },
];

/** Events Absence holds only in memory — a live session a beat ahead of disk. */
const LIVE_TAIL: AbsenceLikeEvent[] = [
  { id: "e5", sessionId: "sess_live", timestamp: 5_000, type: "thinking", payload: { content: "hmm" } },
];

interface FakeOptions {
  /** Answer 200 only for this id on `GET /api/sessions/:id` (a live session). */
  liveId?: string;
  /** How many events one page holds, to exercise the paging loop. */
  pageSize?: number;
}

let requests: string[] = [];

function fakeAbsence(options: FakeOptions = {}): Server {
  const pageSize = options.pageSize ?? 2;
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}${url.search}`);

    const json = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    if (url.pathname === "/api/sessions/history") {
      return json(200, [
        {
          id: "pi:one",
          piSessionFile: "/x/one.jsonl",
          projectPath: "/p/chart",
          projectName: "chart",
          createdAt: 1,
          updatedAt: 9,
          messageCount: 3,
          runtime: "pi",
          archived: false,
        },
        {
          id: "sess_a",
          absenceSessionId: "sess_a",
          projectPath: "/p/mock-test",
          projectName: "mock-test",
          createdAt: 1_000,
          updatedAt: 4_000,
          messageCount: 2,
          runtime: "mock",
          archived: true,
        },
        {
          id: "sess_b",
          absenceSessionId: "sess_b",
          projectPath: "/p/daze-demo",
          projectName: "daze-demo",
          createdAt: 2_000,
          updatedAt: 6_000,
          messageCount: 1,
          runtime: "mock",
          archived: true,
          firstPrompt: "Run the demo",
        },
      ]);
    }

    const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (eventsMatch) {
      const id = eventsMatch[1]!;
      const source = id === "sess_live" ? LIVE_TAIL : EVENTS;
      // Absence's cursor is the event's `seq` (1-based position in the store),
      // not its timestamp: `before` is exclusive and pages walk backwards.
      const before = url.searchParams.get("before");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? pageSize), pageSize);
      const stop = before === null ? source.length : Math.max(0, Math.min(source.length, Number(before) - 1));
      const start = Math.max(0, stop - limit);
      const page = source.slice(start, stop);
      return json(200, {
        events: page,
        hasMore: start > 0,
        ...(start > 0 ? { nextBefore: start + 1 } : {}),
      });
    }

    const metricsMatch = /^\/api\/sessions\/([^/]+)\/metrics$/.exec(url.pathname);
    if (metricsMatch) {
      return json(200, {
        from: 0,
        to: 10_000,
        step: 2_000,
        series: [
          {
            eggPid: 4242,
            name: "node",
            kind: "primary",
            status: "running",
            avgCpuCoresSession: 1.5,
            avgRssBytesSession: 100 * 1024 * 1024,
            firstTs: 2_000,
            lastTs: 4_000,
            points: [
              { ts: 2_000, cpuSeconds: 10, rssBytes: 50 * 1024 * 1024 },
              { ts: 4_000, cpuSeconds: 20, rssBytes: 60 * 1024 * 1024 },
            ],
          },
        ],
        host: [
          { ts: 2_000, cpuSeconds: 100, cpuIdleSeconds: 900, memUsedBytes: 4_000, memTotalBytes: 8_000, cpuCount: 8 },
        ],
      });
    }

    const oneMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (oneMatch) {
      const id = oneMatch[1]!;
      if (options.liveId && id === options.liveId) {
        return json(200, { session: { id }, events: id === "sess_live" ? LIVE_TAIL : [] });
      }
      return json(404, { error: "session not found" });
    }

    return json(404, { error: `no fake for ${url.pathname}` });
  });
}

const server = fakeAbsence({ liveId: "sess_live" });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

try {
  section("absence: the history list");

  {
    requests = [];
    const probe = await listAbsenceSessions(base);
    check("the probe is available", probe.available === true);
    checkEqual("only archived sessions are offered", probe.sessions.map((session) => session.id), [
      "sess_b",
      "sess_a",
    ]);
    check("newest first", probe.sessions[0]?.id === "sess_b");
    check(
      "a first prompt becomes the label",
      probe.sessions[0]?.label === "Run the demo",
      probe.sessions[0]?.label,
    );
    check(
      "a session without one falls back to project + id",
      probe.sessions[1]?.label === "mock-test · sess_a",
      probe.sessions[1]?.label,
    );
    check(
      "a pi-only row is not offered",
      !probe.sessions.some((session) => session.id === "pi:one"),
    );
    check(
      "the list is not probed for liveness when nothing is live",
      probe.current?.id === "sess_b" && !probe.sessions.some((session) => session.live),
    );
    check("the probe asked for history", requests.some((line) => line.startsWith("GET /api/sessions/history")));
  }

  section("absence: a live session is the current one");

  {
    // The fake reports `sess_live` as open, but it is not in the history list;
    // liveness is probed for the listed rows only, so the newest wins here.
    const probe = await listAbsenceSessions(base);
    check("no phantom session is invented", !probe.sessions.some((session) => session.id === "sess_live"));
    check("the newest archived row is still the current one", probe.current?.id === "sess_b");
  }

  section("absence: paging is collected oldest-first exactly once");

  {
    const snapshot = await collectAbsenceSnapshot(base, "sess_a", "mock-test");
    check("the snapshot is available", snapshot.available === true);
    checkEqual("every event arrives", snapshot.events.map((event) => (event as { id: string }).id), [
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    check("nothing is truncated", snapshot.truncated === false);
    check("a label is carried through", snapshot.label === "mock-test");
    check("it is stamped when it was taken", typeof snapshot.fetchedAt === "number" && snapshot.fetchedAt > 0);
    check(
      "the pages were walked with a cursor",
      requests.some((line) => line.includes("before=")),
      requests.join(" | "),
    );
  }

  section("absence: a live tail is merged, and merged once");

  {
    // `sess_live` has its events only in memory: the archive page is empty and
    // `GET /api/sessions/:id` carries the stream. A copy of "the current
    // session" has to include them, or an import made mid-run is empty.
    const snapshot = await collectAbsenceSnapshot(base, "sess_live", "live one");
    checkEqual(
      "the live tail is imported",
      snapshot.events.map((event) => (event as { id: string }).id),
      ["e5"],
    );

    // A session with the same event in both places must not double-count it.
    const again = await collectAbsenceSnapshot(base, "sess_a", "mock-test");
    const ids = again.events.map((event) => (event as { id: string }).id);
    checkEqual("no duplicate ids", ids, [...new Set(ids)]);
  }

  section("absence: the import is a snapshot, not a subscription");

  {
    const before = requests.length;
    const snapshot = await collectAbsenceSnapshot(base, "sess_a", "mock-test");
    // One import = history + events pages + metrics + maybe one live probe.
    // The point is that it *ends*: no socket, no polling loop, no cursor kept.
    const made = requests.slice(before);
    checkEqual(
      "an import makes a bounded number of GETs",
      made.filter((line) => !line.includes("before=")).map(
        (line) => line.replace(/\?.*$/, ""),
      ),
      [
        "GET /api/sessions/sess_a/events",
        "GET /api/sessions/sess_a",
        "GET /api/sessions/sess_a/metrics",
      ],
    );
    check("only GETs", made.every((line) => line.startsWith("GET ")), made.join(" | "));
    check("the copy is a plain array the caller owns", Array.isArray(snapshot.events));
  }

  section("absence: metrics become frames the engine can judge");

  {
    const frames = framesFromMetrics({
      series: [
        {
          eggPid: 7,
          name: "node",
          kind: "primary",
          status: "running",
          avgCpuCoresSession: 0.5,
          avgRssBytesSession: 10,
          points: [
            { ts: 1_000, cpuSeconds: 1, rssBytes: 100 },
            { ts: 3_000, cpuSeconds: 3, rssBytes: 300 },
          ],
        },
      ],
      host: [{ ts: 1_000, cpuSeconds: 10, cpuIdleSeconds: 90, memUsedBytes: 400, memTotalBytes: 1_000, cpuCount: 8 }],
    });
    checkEqual("one frame per timestamp", frames.map((frame) => frame.ts), [1_000, 3_000]);
    checkEqual("the egg rides in its frames", frames[0]?.eggs?.map((egg) => egg.eggPid), [7]);
    check("cpu counters are kept, not turned into rates", frames[1]?.eggs?.[0]?.cpuSeconds === 3);
    check(
      "the host's memory is reported as available, the way Chart reads it",
      frames[0]?.host?.memAvailableBytes === 600,
      String(frames[0]?.host?.memAvailableBytes),
    );
    check(
      "session averages survive the trip",
      frames[0]?.eggs?.[0]?.avgCpuCoresSession === 0.5,
    );
    checkEqual("an empty response is no frames", framesFromMetrics(undefined), []);
  }

  section("absence: an imported session judges like a native one");

  {
    const snapshot = await collectAbsenceSnapshot(base, "sess_a", "mock-test");
    const chartEvents = toChartEvents(snapshot.events as AbsenceLikeEvent[]);
    checkEqual("the adapter accepts every event", chartEvents.length, 4);
    const facts = buildFacts(chartEvents, {
      id: "run_1",
      startedAt: 1_000,
      endedAt: 4_000,
      durationMs: 3_000,
      status: "completed",
      fromIndex: 0,
      toIndex: 3,
    });
    checkEqual("the failed command is counted", facts.commands.failed, 1);
    check("the run is closed", facts.ended === true);
  }

  section("absence: unreachable is data, not an exception");

  {
    const dead = await listAbsenceSessions("http://127.0.0.1:9");
    checkEqual("the probe reports unavailable", dead.available, false);
    check("with a reason", typeof dead.error === "string" && dead.error.length > 0);
    checkEqual("and no sessions", dead.sessions, []);
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

finish();

/** Keep the unused import honest under `noUnusedLocals`. */
export type { MetricsFrameLike };
