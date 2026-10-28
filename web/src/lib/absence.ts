/**
 * Reading Absence from the editor.
 *
 * "Add the current session" means the agent session Absence is observing in
 * `../daze` — not a conversation inside this editor. The browser cannot call
 * Absence directly (different origin, and its server sends no CORS headers), so
 * these two calls go to Chart's own API, which reads Absence over the loopback
 * and answers with plain JSON (see `scripts/absence.ts`).
 *
 * The import is **one-shot**: `fetchAbsenceSnapshot` is called once, when the
 * dialog's 导入 button is pressed. There is no polling, no socket and no
 * "latest" pointer afterwards, so the imported session is a photograph of the
 * agent at that moment and never syncs again.
 */

import { toChartEvents, type AbsenceLikeEvent, type ChartEvent } from "../../../src/index.ts";
import type { MetricsFrameLike } from "../../../src/core/live.ts";

/** One row of Absence's history, as the picker shows it. */
export interface AbsenceSessionSummary {
  id: string;
  label: string;
  projectPath: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  runtime: string;
  /** Absence still has this session open — it is the one being observed. */
  live?: boolean;
}

export interface AbsenceSessionsResult {
  available: boolean;
  base?: string;
  /** Why it is unavailable, or why the list is empty, in words a person can act on. */
  error?: string;
  sessions: AbsenceSessionSummary[];
  /** The newest session — what Absence is looking at right now. */
  current?: AbsenceSessionSummary;
}

export interface AbsenceSnapshotResult {
  available: boolean;
  error?: string;
  sessionId?: string;
  label?: string;
  projectPath?: string;
  runtime?: string;
  fetchedAt?: number;
  events: ChartEvent[];
  metrics: MetricsFrameLike[];
  /** The archive was longer than the import cap; the copy is the newest part. */
  truncated?: boolean;
}

/** Why `fetch` failed, said the way the dialog needs to hear it. */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
    return "读不到 Chart 的 rules API —— 用 npm run api 启动它，再回来";
  }
  return message;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  const text = await response.text();
  let body: unknown;
  try {
    body = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    // The dev server's proxy answers HTML when the API is not running.
    throw new Error("rules API 没有在运行（npm run api）");
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | undefined)?.error;
    throw new Error(typeof error === "string" ? error : `HTTP ${response.status}`);
  }
  return body;
}

/** Absence's importable sessions, newest first. Never throws. */
export async function fetchAbsenceSessions(): Promise<AbsenceSessionsResult> {
  try {
    const body = (await getJson("/api/absence/sessions")) as
      | {
          available?: unknown;
          base?: unknown;
          error?: unknown;
          sessions?: unknown;
        }
      | undefined;
    const sessions = Array.isArray(body?.sessions) ? (body.sessions as AbsenceSessionSummary[]) : [];
    const available = body?.available === true;
    // 当前会话 is the live one Absence reports, not simply the newest row.
    const current = sessions.find((session) => session.live) ?? sessions[0];
    return {
      available,
      ...(typeof body?.base === "string" ? { base: body.base } : {}),
      ...(available
        ? {}
        : { error: typeof body?.error === "string" ? body.error : "Absence 没有在运行" }),
      sessions,
      ...(current ? { current } : {}),
    };
  } catch (error) {
    return { available: false, error: explain(error), sessions: [] };
  }
}

/**
 * One copy of one Absence session.
 *
 * Called exactly once per import. Events arrive as Absence's own JSON and are
 * converted here with the engine's adapter, so the editor never invents a
 * payload shape the engine would not accept.
 */
export async function fetchAbsenceSnapshot(sessionId: string): Promise<AbsenceSnapshotResult> {
  try {
    const body = (await getJson(
      `/api/absence/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    )) as
      | {
          available?: unknown;
          error?: unknown;
          events?: unknown;
          metrics?: unknown;
          fetchedAt?: unknown;
          label?: unknown;
          projectPath?: unknown;
          runtime?: unknown;
          truncated?: unknown;
        }
      | undefined;

    if (body?.available !== true) {
      return {
        available: false,
        error: typeof body?.error === "string" ? body.error : "Absence 没有回应",
        events: [],
        metrics: [],
      };
    }

    const raw = Array.isArray(body.events) ? (body.events as AbsenceLikeEvent[]) : [];
    return {
      available: true,
      sessionId,
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.projectPath === "string" ? { projectPath: body.projectPath } : {}),
      ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      ...(typeof body.fetchedAt === "number" ? { fetchedAt: body.fetchedAt } : {}),
      events: toChartEvents(raw),
      metrics: Array.isArray(body.metrics) ? (body.metrics as MetricsFrameLike[]) : [],
      ...(body.truncated === true ? { truncated: true } : {}),
    };
  } catch (error) {
    return { available: false, error: explain(error), events: [], metrics: [] };
  }
}
