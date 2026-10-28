#!/usr/bin/env tsx
/**
 * The rules API — one HTTP surface over the packs on disk.
 *
 * The editor is a browser app, so "let an AI edit the rules" needs a seam that
 * is not `localStorage`. This is that seam: the same `PackStore` + `fsPackIO`
 * the CLI uses, behind JSON endpoints. Point the Vite dev server at it (it
 * proxies `/api`) and the browser editor reads and writes the same files an agent
 * edits with `curl`; run it with `--static web/dist` and it also serves the
 * built editor, so one port is the whole product.
 *
 * Design rules, matching the engine:
 *
 *   · a pack is **validated before it is written** (422 + issues), unless the
 *     caller asks for `?force=1` — the editor needs that for half-typed rules;
 *   · names are slugs (the store enforces it), so a path cannot escape the dir;
 *   · every response is JSON, pretty-printed, because the other reader is a
 *     model;
 *   · mutations return the **whole pack**, so a caller never has to re-read to
 *     know the new state.
 *
 *   npm run api                       # http://127.0.0.1:5175
 *   npm run api -- --port 5180 --dir .chart/rules
 *   npm run serve                     # build the editor, serve it + the API
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PACK,
  EVENT_FIELDS,
  EVENT_TYPES,
  LEVELS,
  OPERATOR_CATALOG,
  PackInvalidError,
  PackStore,
  WINDOW_MEASURES,
  allFields,
  parsePack,
  removeRule,
  upsertRule,
  validatePack,
  type Rule,
  type RulePack,
} from "../src/index.ts";
import { QUANTS } from "../src/regimen/predicate.ts";
import { fsPackIO } from "../src/store/fs.ts";
import {
  DEFAULT_ABSENCE_BASE,
  collectAbsenceSnapshot,
  listAbsenceSessions,
} from "./absence.ts";

export interface ApiOptions {
  /** Where the packs live. Created on first write. */
  dir: string;
  /** Optional directory of static files (the built editor) to serve at `/`. */
  staticDir?: string;
  /**
   * Where Absence's server is. The editor's ＋ dialog imports a snapshot of the
   * agent session running there; without a reachable server it just says so.
   */
  absenceBase?: string;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, PATCH, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "86400",
};

const MAX_BODY = 2 * 1024 * 1024;

/* ── the server ─────────────────────────────────────────────────────────── */

export function createApiServer(options: ApiOptions): Server {
  const dir = resolve(options.dir);
  const staticDir = options.staticDir ? resolve(options.staticDir) : undefined;
  const absenceBase = options.absenceBase ?? DEFAULT_ABSENCE_BASE;
  const store = new PackStore(fsPackIO({ dir }), DEFAULT_PACK);

  return createServer((req, res) => {
    void handle(req, res, { dir, staticDir, store, absenceBase }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    });
  });
}

interface Context {
  dir: string;
  staticDir?: string;
  store: PackStore;
  absenceBase: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    await serveStatic(url.pathname, res, context.staticDir);
    return;
  }

  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  // parts[0] is "api"
  const [, resource, name, sub, ruleId, action] = parts;

  try {
    /* ── health + catalog ──────────────────────────────────── */
    if (resource === "health" && method === "GET") {
      return json(res, 200, {
        ok: true,
        version: 1,
        dir: context.dir,
        endpoints: [
          "GET    /api/health",
          "GET    /api/catalog",
          "GET    /api/packs",
          "GET    /api/packs/:name",
          "PUT    /api/packs/:name[?force=1]",
          "DELETE /api/packs/:name",
          "POST   /api/packs/:name/activate",
          "GET    /api/active",
          "PUT    /api/active",
          "DELETE /api/active",
          "GET    /api/packs/:name/rules",
          "GET    /api/packs/:name/rules/:id",
          "PUT    /api/packs/:name/rules/:id",
          "PATCH  /api/packs/:name/rules/:id",
          "DELETE /api/packs/:name/rules/:id",
          "POST   /api/packs/:name/rules/:id/move",
          "GET    /api/absence/sessions",
          "GET    /api/absence/sessions/:id/snapshot",
        ],
      });
    }

    /* ── absence: the agent session being observed ─────────── */
    //
    // Chart does not drive Absence; these two routes only *read* it, over the
    // loopback. The editor's ＋ dialog uses them to take one copy of a real
    // session (see scripts/absence.ts). Both answer 200 with `available: false`
    // when Absence is not running, so the dialog can explain rather than fail.
    if (resource === "absence" && name === "sessions") {
      if (method !== "GET") return json(res, 405, { error: `${method} not allowed on /api/absence/sessions` });
      // parts is [api, absence, sessions, :id, snapshot] here, so `sub` carries
      // the session id and `ruleId` the verb.
      if (sub !== undefined) {
        const id = sub;
        if (ruleId !== "snapshot") {
          return json(res, 404, { error: `no route for ${method} ${url.pathname}` });
        }
        const probe = await listAbsenceSessions(context.absenceBase);
        if (!probe.available) {
          return json(res, 200, { available: false, base: probe.base, error: probe.error });
        }
        const found = probe.sessions.find((session) => session.id === id);
        if (!found) return json(res, 404, { available: true, error: `no Absence session "${id}"` });
        const snapshot = await collectAbsenceSnapshot(context.absenceBase, id, found.label);
        return json(res, 200, {
          ...snapshot,
          projectPath: found.projectPath,
          runtime: found.runtime,
        });
      }
      return json(res, 200, await listAbsenceSessions(context.absenceBase));
    }

    if (resource === "catalog" && method === "GET") {
      return json(res, 200, {
        fields: allFields(),
        eventTypes: EVENT_TYPES,
        eventFields: EVENT_FIELDS,
        operators: OPERATOR_CATALOG,
        windowMeasures: WINDOW_MEASURES,
        quants: QUANTS,
        levels: LEVELS,
        phases: ["live", "settled", "both"],
        combinators: ["all", "any"],
        evidence: [
          "facts.failed",
          "facts.unresolved",
          "facts.failureStreak.evidence",
          "facts.errors.evidence",
          "facts.processes.runningAtEnd",
          "facts.outsideChanges",
          "facts.reverts",
          "facts.retries",
          "facts.files.created",
          "facts.files.modified",
          "facts.files.deleted",
          "window.ids",
          "facts.evidence",
        ],
      });
    }

    /* ── active pointer ────────────────────────────────────── */
    if (resource === "active") {
      if (method === "GET") return json(res, 200, { active: (await context.store.activeName()) ?? null });
      if (method === "PUT" || method === "POST") {
        const body = await readJson(req);
        const active = typeof body === "object" && body !== null ? (body as { active?: unknown }).active : undefined;
        if (active !== null && typeof active !== "string") {
          return json(res, 400, { error: "body must be { active: string | null }" });
        }
        if (active === null) await context.store.deactivate();
        else await context.store.activate(active);
        return json(res, 200, { active: (await context.store.activeName()) ?? null });
      }
      if (method === "DELETE") {
        await context.store.deactivate();
        return json(res, 200, { active: null });
      }
    }

    /* ── packs ─────────────────────────────────────────────── */
    if (resource === "packs" && name === undefined) {
      if (method === "GET") return json(res, 200, await context.store.list());
      return json(res, 405, { error: `${method} not allowed on /api/packs` });
    }

    if (resource === "packs" && name !== undefined) {
      if (sub === undefined) {
        if (method === "GET") {
          const pack = await context.store.load(name);
          return json(res, 200, pack);
        }
        if (method === "PUT" || method === "POST") {
          const body = await readJson(req);
          const pack = parsePack(JSON.stringify(body));
          const force = url.searchParams.get("force") === "1";
          const issues = await context.store.save(name, pack, { force });
          return json(res, 200, { pack, issues });
        }
        if (method === "DELETE") {
          await context.store.remove(name);
          return json(res, 200, { removed: name, active: (await context.store.activeName()) ?? null });
        }
      }

      if (sub === "activate" && method === "POST") {
        await context.store.activate(name);
        return json(res, 200, { active: name });
      }

      /* ── rules ───────────────────────────────────────────── */
      if (sub === "rules") {
        if (ruleId === undefined) {
          const pack = await context.store.load(name);
          if (method === "GET") return json(res, 200, pack.rules);
          if (method === "POST" || method === "PUT") {
            const body = await readJson(req);
            const rule = normalizeRule(body);
            if (!rule) return json(res, 400, { error: "body must be a rule with an id" });
            const next = upsertRule(pack, rule);
            const issues = await context.store.save(name, next, { force: true });
            return json(res, 200, { pack: next, rule, issues });
          }
        }

        if (ruleId !== undefined) {
          const pack = await context.store.load(name);
          const current = pack.rules.find((candidate) => candidate.id === ruleId);

          // `move` is a POST, so it has to be answered before the PUT/POST rule
          // replacement below — otherwise the body is read as a rule.
          if (action === "move" && (method === "POST" || method === "PATCH")) {
            if (!current) return json(res, 404, { error: `no rule "${ruleId}" in "${name}"` });
            const body = await readJson(req);
            const index = typeof body === "object" && body !== null ? Number((body as { index?: unknown }).index) : NaN;
            if (!Number.isInteger(index)) return json(res, 400, { error: "body must be { index: number }" });
            const rules = [...pack.rules];
            const from = rules.findIndex((rule) => rule.id === ruleId);
            const [moved] = rules.splice(from, 1);
            if (!moved) return json(res, 404, { error: `no rule "${ruleId}" in "${name}"` });
            rules.splice(Math.max(0, Math.min(index, rules.length)), 0, moved);
            const next = { ...pack, rules };
            const issues = await context.store.save(name, next, { force: true });
            return json(res, 200, { pack: next, issues });
          }

          if (method === "GET") {
            if (!current) return json(res, 404, { error: `no rule "${ruleId}" in "${name}"` });
            return json(res, 200, current);
          }

          if (method === "PUT" || method === "POST") {
            const body = await readJson(req);
            const rule = normalizeRule(body);
            if (!rule) return json(res, 400, { error: "body must be a rule" });
            if (rule.id !== ruleId) {
              return json(res, 400, { error: `body id "${rule.id}" does not match path id "${ruleId}"` });
            }
            const next = upsertRule(pack, rule);
            const issues = await context.store.save(name, next, { force: true });
            return json(res, 200, { pack: next, rule, issues });
          }

          if (method === "PATCH") {
            if (!current) return json(res, 404, { error: `no rule "${ruleId}" in "${name}"` });
            const body = await readJson(req);
            const merged = mergeRule(current, body);
            const next = { ...pack, rules: pack.rules.map((rule) => (rule.id === ruleId ? merged : rule)) };
            const issues = await context.store.save(name, next, { force: true });
            return json(res, 200, { pack: next, rule: merged, issues });
          }

          if (method === "DELETE") {
            if (!current) return json(res, 404, { error: `no rule "${ruleId}" in "${name}"` });
            const next = removeRule(pack, ruleId);
            const issues = await context.store.save(name, next, { force: true });
            return json(res, 200, { pack: next, removed: ruleId, issues });
          }
        }
      }
    }

    return json(res, 404, { error: `no route for ${method} ${url.pathname}` });
  } catch (error) {
    if (error instanceof PackInvalidError) {
      return json(res, 422, { error: "pack is invalid", pack: error.packName, issues: error.issues });
    }
    if (isMissing(error)) {
      return json(res, 404, { error: `no pack "${name ?? ""}"` });
    }
    if (error instanceof SyntaxError) {
      return json(res, 400, { error: `body is not valid JSON: ${error.message}` });
    }
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

/* ── rule helpers ───────────────────────────────────────────────────────── */

function normalizeRule(body: unknown): Rule | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Rule;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) return undefined;
  if (candidate.when === undefined) return undefined;
  if (candidate.emit === undefined) return undefined;
  return candidate;
}

/**
 * Shallow merge, except `emit` and `when` which merge one level deeper.
 *
 * `PATCH {"emit":{"tags":["run"]}}` must not drop the title, and a model editing
 * one condition should not have to resend the whole rule to keep the rest.
 */
function mergeRule(current: Rule, patch: unknown): Rule {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return current;
  const body = patch as Partial<Rule>;
  const { id: _ignoredId, emit, when, ...rest } = body;
  return {
    ...current,
    ...rest,
    when: when ? { ...current.when, ...when } : current.when,
    emit: emit ? { ...current.emit, ...emit } : current.emit,
  };
}

/* ── transport ──────────────────────────────────────────────────────────── */

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    ...CORS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY) throw new SyntaxError("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

/* ── static files (the built editor) ────────────────────────────────────── */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

async function serveStatic(pathname: string, res: ServerResponse, staticDir?: string): Promise<void> {
  if (!staticDir) {
    return json(res, 404, { error: "the API is running without --static; the editor is served by Vite" });
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(join(staticDir, requested));
  if (safe !== staticDir && !safe.startsWith(staticDir + sep)) {
    return json(res, 403, { error: "path escapes the static directory" });
  }

  try {
    const body = await readFile(safe);
    const type = MIME[extname(safe).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": body.length });
    res.end(body);
    return;
  } catch {
    // SPA fallback: an unknown path without an extension is the editor's route.
    if (extname(requested) === "") {
      try {
        const body = await readFile(join(staticDir, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"]!, "content-length": body.length });
        res.end(body);
        return;
      } catch {
        // fall through
      }
    }
    return json(res, 404, { error: `not found: ${pathname}` });
  }
}

/* ── the CLI host ───────────────────────────────────────────────────────── */

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  const flags = parseFlags(process.argv.slice(2));
  const port = Number(typeof flags["port"] === "string" ? flags["port"] : (process.env.CHART_API_PORT ?? 5175));
  const dir = resolve(
    typeof flags["dir"] === "string" ? flags["dir"] : (process.env.CHART_RULES_DIR ?? ".chart/rules"),
  );
  const staticDir = typeof flags["static"] === "string" ? flags["static"] : undefined;
  const absenceBase =
    (typeof flags["absence"] === "string" ? flags["absence"] : undefined) ??
    process.env.ABSENCE_URL ??
    DEFAULT_ABSENCE_BASE;
  const server = createApiServer({ dir, staticDir, absenceBase });
  server.listen(port, "127.0.0.1", () => {
    console.log(`chart rules API — http://127.0.0.1:${port}`);
    console.log(`  packs  : ${dir}`);
    console.log(`  absence: ${absenceBase}`);
    if (staticDir) console.log(`  editor : ${resolve(staticDir)}`);
    console.log(`  health : curl -s http://127.0.0.1:${port}/api/health`);
    console.log(`  docs   : docs/API.md`);
  });
}
