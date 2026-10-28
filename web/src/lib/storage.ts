/**
 * A `PackIO` over localStorage.
 *
 * The editor has no server, so packs live in the browser. The shape is the same
 * one `fsPackIO` implements — one JSON text per pack plus an active pointer — so
 * export/import is a straight copy and moving to a real backend later means
 * swapping this object, not rewriting the UI.
 */

import type { ChartEvent } from "../../../src/core/events.ts";
import type { MetricsFrameLike } from "../../../src/core/live.ts";
import type { PackIO } from "../../../src/store/packStore.ts";

const PACKS_KEY = "chart:packs";
const ACTIVE_KEY = "chart:active";

function readPacks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PACKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writePacks(packs: Record<string, string>): void {
  localStorage.setItem(PACKS_KEY, JSON.stringify(packs));
}

export function localStoragePackIO(): PackIO {
  return {
    async list() {
      return Object.keys(readPacks());
    },
    async read(name) {
      const text = readPacks()[name];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
      return text;
    },
    async write(name, text) {
      const packs = readPacks();
      packs[name] = text;
      writePacks(packs);
    },
    async remove(name) {
      const packs = readPacks();
      delete packs[name];
      writePacks(packs);
    },
    async readActive() {
      const value = localStorage.getItem(ACTIVE_KEY);
      return value && value.length > 0 ? value : undefined;
    },
    async writeActive(name) {
      if (!name) localStorage.removeItem(ACTIVE_KEY);
      else localStorage.setItem(ACTIVE_KEY, name);
    },
  };
}

/** Download a pack as a file, so it can be dropped into `.chart/rules/`. */
/* ── simulated sessions ─────────────────────────────────────────────────── */

/**
 * A session the user created in the 事件会话 column: a name and a stream.
 *
 * A session is either built by hand (empty at first, then edited event by
 * event) or an **import** of an Absence session — the agent that was actually
 * running in `../daze`. An import is a one-shot copy: the events and the
 * resource samples are read once, at the click, and stored here. Nothing polls
 * Absence afterwards, so the copy can never drift back into sync with the agent
 * it came from.
 */
export interface StoredSession {
  id: string;
  name: string;
  events: ChartEvent[];
  /** Resource samples, frozen with the events when the session was imported. */
  metrics?: MetricsFrameLike[];
  /** Set on an import: the Absence session it was copied from, and when. */
  importedFrom?: {
    sessionId: string;
    label: string;
    projectPath?: string;
    fetchedAt: number;
    /** The archive was longer than the import cap. */
    truncated?: boolean;
  };
}

const SESSIONS_KEY = "regimen.user-sessions.v1";

export function loadUserSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredSession[];
    return Array.isArray(parsed)
      ? parsed
          .filter((s) => s && typeof s.id === "string" && typeof s.name === "string" && Array.isArray(s.events))
          .map((s) => ({
            ...s,
            ...(Array.isArray(s.metrics) ? { metrics: s.metrics } : {}),
            // A row written by the earlier build pointed at another editor
            // session; keep the provenance readable rather than dropping it.
            ...(s.importedFrom ? { importedFrom: s.importedFrom } : {}),
          }))
      : [];
  } catch {
    return [];
  }
}

/** Persist the sessions; `false` when the browser refused (quota / private mode). */
export function saveUserSessions(sessions: readonly StoredSession[]): boolean {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    return true;
  } catch {
    // private mode / quota. Saying so beats a silent no-op: an imported Absence
    // session can be large, and the dialog has to be able to stay open.
    return false;
  }
}

export function downloadPack(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Copy text to the clipboard, with a fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/* ── the HTTP backend ────────────────────────────────────────────────────── */

/**
 * When `npm run api` is running (or the editor is served by it with `--static`),
 * packs live on disk and the browser talks to `/api`. That is the mode an agent
 * shares: it edits `.chart/rules/*.json` with `curl`, the editor reads the same
 * files. Without the API the editor falls back to `localStorage`, so it always
 * works — just not shared.
 */
export type Backend = "api" | "local";

let resolved: { kind: Backend; io: PackIO } | undefined;

async function resolveBackend(): Promise<{ kind: Backend; io: PackIO }> {
  if (resolved) return resolved;
  try {
    const response = await fetch("/api/health", { headers: { accept: "application/json" } });
    if (response.ok) {
      const body = (await response.json()) as { ok?: unknown };
      if (body.ok === true) {
        resolved = { kind: "api", io: httpPackIO() };
        return resolved;
      }
    }
  } catch {
    // No API (or no proxy): local storage it is.
  }
  resolved = { kind: "local", io: localStoragePackIO() };
  return resolved;
}

/** Which backend the editor settled on; `undefined` until the first call. */
export function currentBackend(): Backend | undefined {
  return resolved?.kind;
}

/** Probe once, so the UI can label the backend before the first edit. */
export async function backendKind(): Promise<Backend> {
  return (await resolveBackend()).kind;
}

/** A `PackIO` that delegates to the first backend that answers. */
export function adaptivePackIO(): PackIO {
  return {
    async list() {
      return (await resolveBackend()).io.list();
    },
    async read(name) {
      return (await resolveBackend()).io.read(name);
    },
    async write(name, text) {
      return (await resolveBackend()).io.write(name, text);
    },
    async remove(name) {
      return (await resolveBackend()).io.remove(name);
    },
    async readActive() {
      return (await resolveBackend()).io.readActive();
    },
    async writeActive(name) {
      return (await resolveBackend()).io.writeActive(name);
    },
  };
}

function httpPackIO(): PackIO {
  const base = "/api";

  const failure = async (response: Response, name: string): Promise<never> => {
    let message = `${name}: HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown; issues?: unknown[] };
      if (typeof body.error === "string") message = body.error;
      if (Array.isArray(body.issues) && body.issues.length > 0) {
        message = `${message} — ${body.issues
          .map((issue) => {
            const item = issue as { path?: string; message?: string };
            return `${item.path ?? ""} ${item.message ?? ""}`.trim();
          })
          .join("; ")}`;
      }
    } catch {
      // keep the status line
    }
    throw new Error(message);
  };

  return {
    async list() {
      const response = await fetch(`${base}/packs`);
      if (!response.ok) await failure(response, "list packs");
      const packs = (await response.json()) as Array<{ name: string }>;
      return packs.map((pack) => pack.name);
    },

    async read(name) {
      const response = await fetch(`${base}/packs/${encodeURIComponent(name)}`);
      if (response.status === 404) {
        throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
      }
      if (!response.ok) await failure(response, name);
      return JSON.stringify(await response.json(), null, 2);
    },

    async write(name, text) {
      // `force` because the editor saves half-typed rules on every keystroke; the
      // store still validates and reports issues, it just does not block.
      const response = await fetch(`${base}/packs/${encodeURIComponent(name)}?force=1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: text,
      });
      if (!response.ok) await failure(response, name);
    },

    async remove(name) {
      const response = await fetch(`${base}/packs/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!response.ok) await failure(response, name);
    },

    async readActive() {
      const response = await fetch(`${base}/active`);
      if (!response.ok) return undefined;
      const body = (await response.json()) as { active?: unknown };
      return typeof body.active === "string" && body.active.length > 0 ? body.active : undefined;
    },

    async writeActive(name) {
      const response = name
        ? await fetch(`${base}/active`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ active: name }),
          })
        : await fetch(`${base}/active`, { method: "DELETE" });
      if (!response.ok) await failure(response, "active");
    },
  };
}
