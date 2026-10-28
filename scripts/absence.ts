/**
 * The Absence side of the editor's ＋ dialog.
 *
 * "The current session" means the agent session Absence is observing in
 * `../daze` — not a conversation inside this editor. Chart is a separate
 * process (and a separate origin), and Absence's server sends no CORS headers,
 * so the browser cannot read it directly. This module is the server-side hop:
 * the API host fetches Absence over loopback and hands the editor plain JSON.
 *
 * Two rules, both from the engine's own design:
 *
 *   · **one-shot.** An import is a *snapshot*: the events and the resource
 *     samples are read once, copied, and never polled again. Nothing here keeps
 *     a cursor, a socket or a "last seen" pointer, so an imported session can
 *     never drift back into sync with the agent it came from.
 *   · **read-only.** Only GETs. Chart does not create, resume, prompt or stop an
 *     Absence session; it copies what that session already recorded.
 *
 * Every failure is reported as data (`available: false` + a reason) rather than
 * an exception: Absence simply not running is the normal case, and the dialog
 * says so instead of showing a stack trace.
 */

import type { MetricsFrameLike } from "../src/core/live.ts";

/** Where Absence listens. `--absence` / `ABSENCE_URL` override it. */
export const DEFAULT_ABSENCE_BASE = "http://127.0.0.1:8848";

/** One row of Absence's history, as much of it as the picker needs. */
export interface AbsenceSessionSummary {
  id: string;
  label: string;
  projectPath: string;
  projectName: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  runtime: string;
  /** True when Absence has an event archive — only those can be imported. */
  archived: boolean;
  /** True when Absence still has this session open (probed, not guessed). */
  live?: boolean;
}

export interface AbsenceProbe {
  available: boolean;
  base: string;
  sessions: AbsenceSessionSummary[];
  /** The session Absence is looking at: the live one, else the newest. */
  current?: AbsenceSessionSummary;
  /** Why `sessions` is empty, when it is not simply "no sessions yet". */
  error?: string;
}

export interface AbsenceSnapshot {
  available: true;
  /** The Absence session this was copied from. */
  sessionId: string;
  label: string;
  projectPath: string;
  runtime: string;
  /** When the copy was taken. Never updated afterwards. */
  fetchedAt: number;
  /** Chart events, already converted by the adapter. */
  events: unknown[];
  /** Resource samples rebuilt from Absence's bucketed metric series. */
  metrics: MetricsFrameLike[];
  eventCount: number;
  /** True when the event archive was longer than the import cap. */
  truncated: boolean;
}

const TIMEOUT_MS = 8_000;
/** Pages of 2000 events; a session longer than this is cut, and says so. */
const MAX_EVENT_PAGES = 12;
/** How many sessions the picker offers. Absence has thousands; a list has 20. */
const MAX_LISTED = 20;
/** How many of those are probed for "is Absence still on it?". */
const MAX_LIVE_PROBES = 8;

/* ── transport ──────────────────────────────────────────────────────────── */

async function getJson(base: string, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // keep the status line
      }
      throw new Error(message);
    }
    return text.trim() === "" ? undefined : JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** A message a person can act on, from whatever fetch threw. */
function describe(error: unknown, base: string): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return `Absence 没有在 ${TIMEOUT_MS / 1000} 秒内回应`;
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED" || error.message.includes("ECONNREFUSED")) {
      return `连不上 ${base}（Absence 没在运行？）`;
    }
    return error.message;
  }
  return String(error);
}

/* ── history ────────────────────────────────────────────────────────────── */

interface RawHistoryEntry {
  id?: unknown;
  absenceSessionId?: unknown;
  projectPath?: unknown;
  projectName?: unknown;
  name?: unknown;
  firstPrompt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  messageCount?: unknown;
  runtime?: unknown;
  archived?: unknown;
}

/**
 * Absence's sessions, newest activity first, narrowed to the ones that can
 * actually be imported (an archive with events behind it).
 *
 * Absence merges its own archives with Pi's session files; a Pi-only row has no
 * events in Absence's database, so importing it would produce an empty session.
 * Those stay out of the picker rather than becoming a dead option.
 *
 * The list is capped at {@link MAX_LISTED}: a year of sessions is not a menu.
 * The newest few are also probed for liveness, so 当前会话 means "the one Absence
 * is observing" rather than "the one whose timestamp happens to be biggest".
 */
export async function listAbsenceSessions(base: string): Promise<AbsenceProbe> {
  let raw: unknown;
  try {
    raw = await getJson(base, "/api/sessions/history");
  } catch (error) {
    return { available: false, base, sessions: [], error: describe(error, base) };
  }
  const rows = Array.isArray(raw) ? (raw as RawHistoryEntry[]) : [];
  const sessions: AbsenceSessionSummary[] = [];
  for (const row of rows) {
    const id =
      typeof row.absenceSessionId === "string" && row.absenceSessionId.length > 0
        ? row.absenceSessionId
        : typeof row.id === "string"
          ? row.id
          : undefined;
    if (id === undefined) continue;
    if (row.archived !== true) continue;
    const projectPath = typeof row.projectPath === "string" ? row.projectPath : "";
    const projectName =
      typeof row.projectName === "string" && row.projectName.length > 0
        ? row.projectName
        : projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "—";
    const name = typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : undefined;
    const firstPrompt =
      typeof row.firstPrompt === "string" && row.firstPrompt.trim() !== "" ? row.firstPrompt.trim() : undefined;
    sessions.push({
      id,
      label: name ?? firstPrompt ?? `${projectName} · ${id}`,
      projectPath,
      projectName,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
      messageCount: typeof row.messageCount === "number" ? row.messageCount : 0,
      runtime: typeof row.runtime === "string" ? row.runtime : "unknown",
      archived: true,
    });
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const listed = sessions.slice(0, MAX_LISTED);

  // Which one is Absence *on* right now? Its API answers `GET /api/sessions/:id`
  // with 200 only for a session still open in the store (404 otherwise), so the
  // question is asked rather than inferred from a timestamp. Only the newest few
  // are probed: a live session is by definition the most recently active.
  const probes = await Promise.all(
    listed.slice(0, MAX_LIVE_PROBES).map(async (session) => [session.id, await isLive(base, session.id)] as const),
  );
  const liveIds = new Set(probes.filter(([, live]) => live).map(([id]) => id));
  for (const session of listed) {
    if (liveIds.has(session.id)) session.live = true;
  }

  // Newest live session wins; with none live (Absence was restarted, or the
  // agent finished), the newest archived one is still "the session you were
  // just in", which is what the dialog offers as 当前会话.
  const current = listed.find((session) => session.live) ?? listed[0];
  return { available: true, base, sessions: listed, ...(current ? { current } : {}) };
}

/** Whether Absence still has this session open. Never throws. */
async function isLive(base: string, sessionId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      // Drain the body so the socket is released.
      await response.text();
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/* ── events ─────────────────────────────────────────────────────────────── */

interface RawEventPage {
  events?: unknown;
  nextBefore?: unknown;
  hasMore?: unknown;
}

/**
 * Absence's own newest events for a live session.
 *
 * The archive is written in batches (`FLUSH_MS`), and `readEventsPage` flushes
 * first — but a session that is *running right now* can still be a beat ahead
 * of the last commit. `GET /api/sessions/:id` returns the live in-memory tail
 * for exactly that case. Returns [] for a session Absence no longer holds.
 */
async function liveTail(base: string, sessionId: string): Promise<unknown[]> {
  try {
    const raw = (await getJson(base, `/api/sessions/${encodeURIComponent(sessionId)}`)) as
      | { events?: unknown }
      | undefined;
    return Array.isArray(raw?.events) ? raw.events : [];
  } catch {
    return [];
  }
}

/**
 * Every archived event of one Absence session, oldest first.
 *
 * Absence pages backwards (`?before=<seq>`, newest page first), so the pages are
 * collected and then reversed once. The cap keeps a pathological session from
 * turning into a 200 MB response; `truncated` tells the editor when it bit.
 *
 * For a session Absence still has open, the live tail is merged in afterwards:
 * an import of "the current session" has to include what happened a second ago,
 * not only what the last batch commit wrote. Merging is by event `id`, so an
 * event present in both is counted once.
 */
export async function collectAbsenceEvents(
  base: string,
  sessionId: string,
): Promise<{ events: unknown[]; truncated: boolean }> {
  const pages: unknown[][] = [];
  let before: number | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const query = before === undefined ? "?limit=2000" : `?limit=2000&before=${before}`;
    const raw = (await getJson(
      base,
      `/api/sessions/${encodeURIComponent(sessionId)}/events${query}`,
    )) as RawEventPage | undefined;
    const events = Array.isArray(raw?.events) ? (raw.events as unknown[]) : [];
    pages.push(events);
    const hasMore = raw?.hasMore === true && events.length > 0;
    if (!hasMore) break;
    const next = typeof raw?.nextBefore === "number" ? raw.nextBefore : undefined;
    if (next === undefined) break;
    before = next;
    if (page === MAX_EVENT_PAGES - 1) truncated = true;
  }

  // Pages arrive newest-first; within a page Absence already returns
  // chronological order. Reversing the page list restores the whole stream.
  const archived = pages.reverse().flat();
  const seen = new Set(archived.map((event) => (event as { id?: unknown }).id));
  const tail = (await liveTail(base, sessionId)).filter((event) => {
    const id = (event as { id?: unknown }).id;
    return typeof id !== "string" || !seen.has(id);
  });

  const events = [...archived, ...tail];
  // The live tail can arrive out of order relative to the archive's last page;
  // one sort makes the imported stream read like the run did.
  events.sort((a, b) => {
    const at = (event: unknown) => (event as { timestamp?: unknown }).timestamp;
    const left = typeof at(a) === "number" ? (at(a) as number) : 0;
    const right = typeof at(b) === "number" ? (at(b) as number) : 0;
    return left - right;
  });
  return { events, truncated };
}

/* ── metrics ────────────────────────────────────────────────────────────── */

interface RawSeriesPoint {
  ts?: unknown;
  cpuSeconds?: unknown;
  rssBytes?: unknown;
}
interface RawSeries {
  eggPid?: unknown;
  name?: unknown;
  kind?: unknown;
  status?: unknown;
  points?: unknown;
  avgCpuCoresSession?: unknown;
  avgRssBytesSession?: unknown;
}
interface RawHostPoint {
  ts?: unknown;
  cpuSeconds?: unknown;
  cpuIdleSeconds?: unknown;
  memUsedBytes?: unknown;
  memTotalBytes?: unknown;
  cpuCount?: unknown;
}
interface RawMetricsResponse {
  series?: unknown;
  host?: unknown;
}

/**
 * Absence's bucketed metric series → Chart's frames.
 *
 * The dashboards and the rule engine derive CPU from the same counters, so the
 * import keeps the counters and lets `metricsFromFrames` do the division: a
 * rule that says "one egg above 90% for a minute" then judges the imported
 * session exactly as it would have judged it live. One frame per timestamp; an
 * egg appears in the frames it has points for.
 */
export function framesFromMetrics(raw: RawMetricsResponse | undefined): MetricsFrameLike[] {
  const byTs = new Map<number, MetricsFrameLike>();

  const frameAt = (ts: number): MetricsFrameLike => {
    const found = byTs.get(ts);
    if (found) return found;
    const created: MetricsFrameLike = { ts, eggs: [] };
    byTs.set(ts, created);
    return created;
  };

  const series = Array.isArray(raw?.series) ? (raw.series as RawSeries[]) : [];
  for (const one of series) {
    const eggPid = typeof one.eggPid === "number" ? one.eggPid : undefined;
    if (eggPid === undefined) continue;
    const points = Array.isArray(one.points) ? (one.points as RawSeriesPoint[]) : [];
    const kind = one.kind === "agent" || one.kind === "tool" ? one.kind : "primary";
    const status = one.status === "exited" ? "exited" : "running";
    for (const point of points) {
      if (typeof point.ts !== "number") continue;
      const frame = frameAt(point.ts);
      frame.eggs!.push({
        eggPid,
        name: typeof one.name === "string" ? one.name : `pid ${eggPid}`,
        kind,
        status,
        ...(typeof point.cpuSeconds === "number" ? { cpuSeconds: point.cpuSeconds } : {}),
        ...(typeof point.rssBytes === "number" ? { rssBytes: point.rssBytes } : {}),
        processCount: 1,
        ...(typeof one.avgCpuCoresSession === "number"
          ? { avgCpuCoresSession: one.avgCpuCoresSession }
          : {}),
        ...(typeof one.avgRssBytesSession === "number"
          ? { avgRssBytesSession: one.avgRssBytesSession }
          : {}),
      });
    }
  }

  const hostPoints = Array.isArray(raw?.host) ? (raw.host as RawHostPoint[]) : [];
  for (const point of hostPoints) {
    if (typeof point.ts !== "number") continue;
    const frame = frameAt(point.ts);
    const total = typeof point.memTotalBytes === "number" ? point.memTotalBytes : undefined;
    const used = typeof point.memUsedBytes === "number" ? point.memUsedBytes : undefined;
    frame.host = {
      ...(typeof point.cpuSeconds === "number" ? { cpuSeconds: point.cpuSeconds } : {}),
      ...(typeof point.cpuIdleSeconds === "number" ? { cpuIdleSeconds: point.cpuIdleSeconds } : {}),
      ...(typeof point.cpuCount === "number" ? { cpuCount: point.cpuCount } : {}),
      ...(total !== undefined ? { memTotalBytes: total } : {}),
      ...(total !== undefined && used !== undefined ? { memAvailableBytes: Math.max(0, total - used) } : {}),
    };
  }

  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/* ── the one-shot import ────────────────────────────────────────────────── */

/**
 * Read one session once and return everything the editor needs to own a copy of
 * it. There is no cursor, no subscription and no second call: the caller stores
 * the result and that is the snapshot.
 */
export async function collectAbsenceSnapshot(
  base: string,
  sessionId: string,
  label: string,
): Promise<AbsenceSnapshot> {
  const { events, truncated } = await collectAbsenceEvents(base, sessionId);

  const timestamps = events
    .map((event) => (typeof (event as { timestamp?: unknown }).timestamp === "number"
      ? (event as { timestamp: number }).timestamp
      : undefined))
    .filter((value): value is number => value !== undefined);
  const from = timestamps.length > 0 ? Math.min(...timestamps) - 60_000 : Date.now() - 60 * 60_000;
  const to = timestamps.length > 0 ? Math.max(...timestamps) + 60_000 : Date.now();

  let metrics: MetricsFrameLike[] = [];
  try {
    // One bucket per minute over the session's own span: enough resolution for
    // a "last N minutes" window rule without pulling every 2-second sample.
    const span = Math.max(1, to - from);
    const step = Math.max(2_000, Math.min(60_000, Math.floor(span / 600) || 2_000));
    const raw = (await getJson(
      base,
      `/api/sessions/${encodeURIComponent(sessionId)}/metrics?from=${from}&to=${to}&step=${step}`,
    )) as RawMetricsResponse | undefined;
    metrics = framesFromMetrics(raw);
  } catch {
    // A session recorded before v0.4 has no metrics; the events still import.
    metrics = [];
  }

  return {
    available: true,
    sessionId,
    label,
    projectPath: "",
    runtime: "",
    fetchedAt: Date.now(),
    events,
    metrics,
    eventCount: events.length,
    truncated,
  };
}
