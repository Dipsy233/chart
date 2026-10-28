# Chart · the rules API

A small HTTP surface over the packs on disk, so an **agent** can edit rules with
`curl` instead of a browser. It is the same `PackStore` + `fsPackIO` the CLI uses,
so there is one implementation of "what a valid pack is".

```bash
npm run api                       # http://127.0.0.1:5175, packs in .chart/rules
npm run api -- --port 5180 --dir .chart/rules
npm run serve                     # build the editor, then serve editor + API on one port
```

The Vite dev server proxies `/api` to `127.0.0.1:5175`, so the browser editor can
use the API too (see `web/vite.config.ts`); with no proxy the editor falls back to
`localStorage` and still works.

## Why an API and not just files

Files are already the source of truth — a model can `cat` a pack and rewrite it.
The API adds the three things a file cannot:

- **validation before writing**: a typo in an operator is a `422` with paths into
  the rule, not a silent no-op discovered a week later;
- **concurrency-friendly mutations**: `PATCH` one rule, `move` one rule, `POST`
  one rule — without rewriting the whole pack and racing another writer;
- **discovery**: `GET /api/catalog` is the whole rule language as data (fields,
  operators, event types, window measures, levels, phases), so a model does not
  have to be told what `facts.commands.failed` is.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/health` | liveness + the endpoint list |
| `GET` | `/api/catalog` | every addressable field, operator, event type, window measure, level, phase |
| `GET` | `/api/packs` | summaries: rules, enabled, live, settled, hash, issues |
| `GET` | `/api/packs/:name` | the whole pack |
| `PUT` | `/api/packs/:name` | replace a pack (validated; `?force=1` writes invalid packs too) |
| `DELETE` | `/api/packs/:name` | remove a pack (clears the pointer if it was active) |
| `POST` | `/api/packs/:name/activate` | make it the active pack |
| `GET` | `/api/active` | `{ active: string \| null }` |
| `PUT` | `/api/active` | `{ "active": "work" }` or `{ "active": null }` |
| `DELETE` | `/api/active` | back to the built-in defaults |
| `GET` | `/api/packs/:name/rules` | the rule array |
| `POST` | `/api/packs/:name/rules` | add a rule (or replace by id) |
| `GET` | `/api/packs/:name/rules/:id` | one rule |
| `PUT` | `/api/packs/:name/rules/:id` | replace one rule (body id must match the path) |
| `PATCH` | `/api/packs/:name/rules/:id` | merge: top-level, plus one level into `when` and `emit` |
| `DELETE` | `/api/packs/:name/rules/:id` | remove one rule |
| `POST` | `/api/packs/:name/rules/:id/move` | `{ "index": 0 }` — evaluation order |
| `GET` | `/api/absence/sessions` | Absence's importable sessions (see below) |
| `GET` | `/api/absence/sessions/:id/snapshot` | a one-shot copy of one Absence session |

Every mutation returns `{ pack, rule?, issues }` — the **new state**, so a caller
never has to re-read. Validation failures are `422` with `issues[]`, each carrying
the path into the rule (`rules[0].when.conditions[1].op`).

`PUT` on a pack validates strictly. `?force=1` writes an invalid pack anyway and
returns its issues; that exists for the editor, which must be able to save a
half-typed rule without blocking the user.

## Absence: the agent session being observed

Two read-only routes bridge to Absence — the observation engine in the sibling
`../daze` checkout — so the editor's ＋ dialog can add **the session Absence is
watching**. Absence sends no CORS headers and lives on another origin, so the
browser cannot call it; the API host reads it over the loopback instead.

```bash
curl -s localhost:5175/api/absence/sessions | jq '.sessions[] | {id, label, live}'
curl -s localhost:5175/api/absence/sessions/sess_abc/snapshot | jq '{eventCount, truncated}'
```

Both always answer `200`. Absence not running is the normal case, not a failure:

```jsonc
{ "available": false, "base": "http://127.0.0.1:8848",
  "sessions": [], "error": "连不上 http://127.0.0.1:8848（Absence 没在运行？）" }
```

Absence's address is `--absence <url>` on `npm run api`, or `ABSENCE_URL`, or
`http://127.0.0.1:8848`.

**The snapshot is a one-shot read.** No cursor is kept, nothing is polled, and no
socket is opened: one call fetches the history row, every archived event page,
the live session's in-memory tail (merged by event id, so a copy taken mid-run
includes the last second), and the bucketed metric series. The response is a
value the caller owns — `{ events, metrics, eventCount, truncated }` — with
events already valid Absence events, ready for `toChartEvents`.

`truncated: true` means the archive was longer than the import cap (12 pages of
2000 events) and the copy is the newest part.

## For an agent

The loop is: read the catalog, read the pack, patch or add a rule, read the
result. A rule is data; nothing is executed.

```bash
# what can a rule address?
curl -s localhost:5175/api/catalog | jq '.fields[] | select(.path|startswith("facts.commands"))'

# the pack, and one rule
curl -s localhost:5175/api/packs/work | jq '.rules[].id'
curl -s localhost:5175/api/packs/work/rules/run.failure-streak | jq

# add a rule: five failures in two minutes, high, with evidence
curl -s -X POST localhost:5175/api/packs/work/rules \
  -H 'content-type: application/json' -d '{
    "id": "user.burst",
    "name": "五分钟内连续失败",
    "description": "代理在两分钟内连败三次以上",
    "phase": "live",
    "when": { "combinator": "all", "conditions": [
      { "window": {
          "events": { "type": ["command"],
                      "where": { "conditions": [ { "field": "payload.exitCode", "op": "ne", "value": 0 } ] } },
          "span": { "lastMs": 120000 },
          "measure": "count", "op": "gte", "value": 3 } } ] },
    "emit": { "level": "high", "title": "最近两分钟有 {{facts.failureStreak.count}} 条命令失败",
              "tags": ["commands"], "evidence": ["facts.failed"] }
  }' | jq '.issues'

# change one field without resending the rule
curl -s -X PATCH localhost:5175/api/packs/work/rules/user.burst \
  -H 'content-type: application/json' \
  -d '{"emit":{"level":"medium","tags":["commands","live"]},"description":"连败三次"}' | jq '.rule.emit'

# reorder, then make the pack active
curl -s -X POST localhost:5175/api/packs/work/rules/user.burst/move -d '{"index":0}'
curl -s -X POST localhost:5175/api/packs/work/activate

# distribute: the whole pack as JSON, and back in again
curl -s localhost:5175/api/packs/work > work.json
curl -s -X PUT localhost:5175/api/packs/imported \
  -H 'content-type: application/json' --data-binary @work.json | jq '.issues'
```

A model editing rules should keep three promises, because they are what makes a
report trustworthy:

1. **edit packs, not records** — a report already read was rendered from the
   findings recorded then; new rules only affect future runs;
2. **never invent fields** — `GET /api/catalog` is the closed list; an unknown
   path is a typo, not an extension;
3. **do not nest** — `(A and B) or C` is two rules. The language has one level on
   purpose; the API's validation will reject anything else.

## Security

The server binds `127.0.0.1` and has no auth: it is a local tool, like the CLI.
It refuses path-traversal pack names (the store's slug rule), caps bodies at 2 MB,
and serves static files only from `--static` with a containment check. Do not
expose it to a network without putting auth in front of it.
