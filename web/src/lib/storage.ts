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
import { validateSpec } from "../../../src/report/validate.ts";
import type { ReportSpec } from "../../../src/report/spec.ts";

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

/* ── report specs ───────────────────────────────────────────────────────── */

/**
 * Report specs live beside the packs, for the same reason and in the same shape.
 *
 * A spec is data (see `docs/REPORTS.md`), so "the user can customise the report"
 * is a storage question, not a renderer one: one JSON per spec plus a pointer to
 * the one the report view renders. The store is deliberately *not* the pack
 * store — a report and a rule are different kinds of document, and conflating
 * them would make "which report does this pack use?" a question nobody asked.
 *
 * `chart:reports` / `chart:report-active`, mirroring `chart:packs` /
 * `chart:active`, so export/import is the same straight copy.
 */
const REPORTS_KEY = "chart:reports";
const REPORT_ACTIVE_KEY = "chart:report-active";

export interface ReportSummary {
  name: string;
  /** The spec's own `id`, when it parses. */
  id?: string;
  title?: string;
  sections: number;
  active: boolean;
  /** Problems found while loading. A broken spec is listed, not hidden. */
  issues: string[];
}

function readReports(): Record<string, string> {
  try {
    const raw = localStorage.getItem(REPORTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeReports(reports: Record<string, string>): void {
  localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
}

/** Every stored spec, with a summary. Broken specs appear with their issues. */
export function listReports(): ReportSummary[] {
  const reports = readReports();
  const active = localStorage.getItem(REPORT_ACTIVE_KEY) ?? undefined;
  return Object.entries(reports)
    .map(([name, text]) => {
      const issues: string[] = [];
      let parsed: ReportSpec | undefined;
      try {
        parsed = parseSpec(text);
        for (const issue of validateSpec(parsed)) issues.push(`${issue.path}: ${issue.message}`);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
      return {
        name,
        ...(parsed?.id ? { id: parsed.id } : {}),
        ...(parsed?.title ? { title: parsed.title } : {}),
        sections: parsed?.sections.length ?? 0,
        active: name === active,
        issues,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readReport(name: string): ReportSpec | undefined {
  const text = readReports()[name];
  if (text === undefined) return undefined;
  return parseSpec(text);
}

export function activeReportName(): string | undefined {
  return localStorage.getItem(REPORT_ACTIVE_KEY) ?? undefined;
}

/** Write a spec, validating first. Returns the issues it found (empty = saved). */
export function saveReport(name: string, spec: ReportSpec): string[] {
  const issues = validateSpec(spec).map((issue) => `${issue.path}: ${issue.message}`);
  if (issues.length > 0) return issues;
  const reports = readReports();
  reports[name] = `${JSON.stringify(spec, null, 2)}\n`;
  writeReports(reports);
  return [];
}

export function removeReport(name: string): void {
  const reports = readReports();
  delete reports[name];
  writeReports(reports);
  if (localStorage.getItem(REPORT_ACTIVE_KEY) === name) localStorage.removeItem(REPORT_ACTIVE_KEY);
}

export function setActiveReport(name: string | undefined): void {
  if (!name) localStorage.removeItem(REPORT_ACTIVE_KEY);
  else localStorage.setItem(REPORT_ACTIVE_KEY, name);
}

/** Parse a spec's JSON text, shape-checked the way `parsePack` does a pack. */
export function parseSpec(text: string): ReportSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("a report spec must be a JSON object");
  }
  const candidate = parsed as Partial<ReportSpec>;
  if (!Array.isArray(candidate.sections)) throw new Error("a report spec must have a `sections` array");
  return candidate as ReportSpec;
}

/** Download a spec as a file, so it can be shared or committed. */
export function downloadReport(name: string, spec: ReportSpec): void {
  downloadPack(name, `${JSON.stringify(spec, null, 2)}\n`);
}
