/**
 * `{{path}}` templates — how a rule says *what happened* without running code.
 *
 *   "{{facts.commands.failed}} commands failed in {{facts.run.id}}"
 *   "{{facts.processes.runningAtEnd|count}} eggs left running"
 *   "{{facts.files.modified|join: \", \"}}"
 *
 * Filters are a fixed, tiny set. A template cannot call a function, cannot
 * reach the network, and cannot read anything the context does not already
 * hold — the same guarantees as the predicate language, for the same reason.
 */

import { resolvePath } from "./predicate.ts";

export type TemplateValue = unknown;

export interface TemplateContext {
  facts?: unknown;
  live?: unknown;
  session?: unknown;
  /** Values from the finding being rendered (title/detail are not self-referential). */
  rule?: unknown;
  /** Extra named values the renderer injects (counts, names…). */
  vars?: Record<string, unknown>;
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Render one template against a context. Unknown paths render as an empty string. */
export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(PLACEHOLDER, (_match, expression: string) => {
    const { path, filters } = parseExpression(expression);
    const value = lookup(path, context);
    return applyFilters(value, filters);
  });
}

/** Whether a template contains at least one placeholder. */
export function isTemplate(value: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(value);
}

interface Filter {
  name: string;
  arg?: string;
}

function parseExpression(expression: string): { path: string; filters: Filter[] } {
  const parts = splitTopLevel(expression, "|");
  const path = (parts.shift() ?? "").trim();
  const filters: Filter[] = [];
  for (const raw of parts) {
    const text = raw.trim();
    const colon = text.indexOf(":");
    if (colon === -1) {
      filters.push({ name: text });
    } else {
      filters.push({ name: text.slice(0, colon).trim(), arg: unquote(text.slice(colon + 1).trim()) });
    }
  }
  return { path, filters };
}

/** Split on a separator, ignoring separators inside quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === separator) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function unquote(text: string): string {
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function lookup(path: string, context: TemplateContext): TemplateValue {
  if (path === "" || path === ".") return context;
  if (path.startsWith("vars.")) return resolvePath(context.vars, path.slice("vars.".length));
  return resolvePath(context, path);
}

function applyFilters(value: TemplateValue, filters: Filter[]): string {
  let current = value;
  for (const filter of filters) {
    switch (filter.name) {
      case "count":
        current = Array.isArray(current) ? current.length : 0;
        break;
      case "keys":
        current = current && typeof current === "object" && !Array.isArray(current) ? Object.keys(current) : [];
        break;
      case "join": {
        const list = Array.isArray(current) ? current : [];
        current = list.map((item) => stringify(item)).join(filter.arg ?? ", ");
        break;
      }
      case "first":
        current = Array.isArray(current) ? current[0] : current;
        break;
      case "last":
        current = Array.isArray(current) ? current[current.length - 1] : current;
        break;
      case "duration":
        current = typeof current === "number" ? formatDuration(current) : "—";
        break;
      case "secs":
        current = typeof current === "number" ? formatDuration(current * 1000) : "—";
        break;
      case "flag":
        current = current === true ? (filter.arg ?? "yes") : "";
        break;
      case "bool": {
        const [on, off] = (filter.arg ?? "true,false").split(",");
        current = current === true ? (on ?? "true") : (off ?? "false");
        break;
      }
      case "plural":
        current = plural(Array.isArray(current) ? current.length : Number(current) || 0, filter.arg ?? "");
        break;
      case "lines":
        current = typeof current === "string" ? current.split("\n").length : 0;
        break;
      case "upper":
        current = stringify(current).toUpperCase();
        break;
      case "lower":
        current = stringify(current).toLowerCase();
        break;
      case "short":
        current = shortenPath(stringify(current));
        break;
      case "percent":
        // `86.36363636` is what a sampler actually reports; a report says 86%.
        current = typeof current === "number" ? formatPercent(current, filter.arg) : "—";
        break;
      case "bytes":
        current = typeof current === "number" ? formatBytes(current) : "—";
        break;
      case "round":
        current = typeof current === "number" ? formatNumber(current, filter.arg) : stringify(current);
        break;
      default:
        // Unknown filter: leave the value alone rather than failing the render.
        break;
    }
  }
  return stringify(current);
}

function stringify(value: TemplateValue): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).filter(Boolean).join(", ");
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/** `1 file` / `3 files` — the one grammar every report needs. */
export function plural(count: number, word: string): string {
  if (!word) return String(count);
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** `1h 04m`, `12s`, `340ms` — durations as a human reads them. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** `86%`, `12.5%`, `0%` — the precision a percentage deserves. */
export function formatPercent(percent: number, digits?: string): string {
  if (!Number.isFinite(percent)) return "—";
  const places = digits !== undefined ? Number(digits) : percent >= 10 ? 0 : 1;
  return `${percent.toFixed(Number.isFinite(places) ? Math.max(0, Math.min(4, places)) : 0)}%`;
}

/** `1.2 GiB`, `512 MiB`, `0 B` — binary units, the way a process table reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A number with a fixed number of decimals (default: as many as it needs, up to 2). */
export function formatNumber(value: number, digits?: string): string {
  if (!Number.isFinite(value)) return "—";
  if (digits === undefined) return String(Math.round(value * 100) / 100);
  const places = Number(digits);
  return value.toFixed(Number.isFinite(places) ? Math.max(0, Math.min(6, places)) : 0);
}

/** Keep the tail of a path — the part a human recognises. */
export function shortenPath(path: string, segments = 2): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}
