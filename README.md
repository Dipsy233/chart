# Chart

A **zero-intrusion observation engine** for AI agents. Its rule engine is called
**Regimen**.

Chart reads an agent's event stream and answers one question, over and over:
*what happened, and is any of it worth a human's attention?* It does not drive
the agent, block a command, pause a run, or call anything on the network. It
observes, reduces, and reports.

```
events ──▶ facts ──▶ findings ──▶ report
         (measure)   (Regimen)    (spec)
```

Two passes judge a run: **live** (each event, anchored at *now*) and **settled**
(once, after `agent_end`, with the run's totals). Three modes never mix: observe
(judged and recorded), replay (the record, faithfully), simulate (a hypothetical,
labelled).

This repository is a from-scratch extraction of the report engine that ships
inside [Absence](../daze). It is designed to be embedded back into Absence, and
to be usable without it.

## Why a second engine

Absence's report mixes **measurement** with **judgement**: the user's thresholds
are passed *into* the fact builder, so changing a setting changes the facts, and
a run's history can never be re-judged. The layout is also hard-coded, and the
types are UI types.

Chart splits the three apart, and the split is enforced in code:

| Layer | Owns | Must never |
|---|---|---|
| **Facts** | What the observer saw: commands, files, processes, loops, streaks, totals | contain a threshold, a clock, or an opinion |
| **Findings** | One rule firing once, with evidence | be produced by anything but a pure predicate |
| **Report** | A document model rendered from a spec | know how it will be styled |

The payoff: a run's facts are stable forever, so a rule is a *lens* you can point
at any run — and a report of a past run is rendered from the **findings that were
recorded then**, not from today's rules.

## Try it

```bash
./start-chart.sh          # installs what is missing, then starts the editor
./start-chart.sh api      # the rules API on http://127.0.0.1:5175 (for agents)
./start-chart.sh serve    # build the editor, serve it + the API on one port
./start-chart.sh check    # the 477 assertions
./start-chart.sh demo     # a real report, plus .chart/demo-events.json for the CLI
./start-chart.sh rules list
```

On Windows, `start-chart.bat` takes the same arguments (`start`, `open`,
`check`, `demo`, `rules`, `api`, `serve`, `build`).

The same things as npm scripts, if you prefer:

```bash
npm install
npm run check    # facts, conditions, windows, phases, parity, modes, store, editor, api
npm run demo
npm run rules -- list          # rule packs on disk
npm run rules -- create work   # copy the defaults into an editable pack
npm run web:install && npm run web    # the editor on http://localhost:5174
npm run api                    # the rules API on http://127.0.0.1:5175
npm run serve                  # the editor + the API on one port
```

## Use it

```ts
import {
  toChartEvents,
  observe,
  replay,
  reportText,
  DEFAULT_PACK,
  SETTLED_REPORT,
  mergePacks,
  EXAMPLE_PACK,
} from "chart";

// 1. Absence events → Chart events (the only place the two projects meet).
const events = toChartEvents(absenceEvents);

// 2. Reduce the newest run and judge it.
const pack = mergePacks(DEFAULT_PACK, EXAMPLE_PACK);
const observation = observe(events, { pack, live: { nowMs: Date.now(), busy: true } });

// 3. Render a report spec.
console.log(reportText(observation!, SETTLED_REPORT));

// 4. Re-judge an old run with new rules — no side effects, no new run needed.
const whatIf = replay(events, pack);
```

A rule, in full — flat conditions, one combinator, no nesting:

```jsonc
{
  "id": "example.five-failures-in-two-minutes",
  "name": "Five failures inside two minutes",
  "when": {
    "combinator": "all",
    "conditions": [
      { "field": "facts.ended", "op": "eq", "value": false },
      { "window": {
          "events": { "type": ["command"],
                      "where": { "conditions": [{ "field": "payload.exitCode", "op": "ne", "value": 0 }] } },
          "span": { "lastMs": 120000 },
          "measure": "count", "op": "gte", "value": 5 } }
    ]
  },
  "emit": {
    "level": "high",
    "title": "{{vars.window.count}} failures in the last 2 minutes",
    "tags": ["commands"],
    "evidence": ["window.ids"]
  }
}
```

`(A and B) or C` is two rules. Three leaf conditions — compare, quantify, scan the
stream — and that is the whole language.

A report, in full:

```jsonc
{
  "id": "deliverables",
  "title": "Deliverables for {{facts.run.id}}",
  "sections": [
    { "kind": "verdict" },
    { "kind": "findings", "minLevel": "low", "tags": ["deliverable"] },
    { "kind": "list", "title": "Created", "source": "facts.files.created", "item": "{{vars.row}}" }
  ]
}
```

Both are data. Nothing is executed: no `eval`, no plugin loading, no network.

`web/` is a React editor + simulator with three views, switched from the top
bar. The bar does two things only — switch views, and pick the **监护对象** (the
session being observed).

- **监护报告** — four columns: the runs in the session, the events of the
  selected run, the report, and the pack that judges it. The report is a
  **playback**: play / pause, step, scrub, 0.5×–4×. Each frame reveals one more
  event and re-judges the prefix, so a verdict is watched into existence instead
  of appearing fully formed. The final frame is the settled run. The right column
  names the pack and the rules it fired (and the ones still 待判读).
- **规则编辑** — packs | rules | the rule. In the packs column the **dot in
  front of a pack is the switch**: click it to make that pack 生效 (it fills
  green), click the row itself to open the pack — there is no 设为生效 button and
  no ✓. Creating or deleting a pack asks in an in-page dialog, not a browser
  prompt. Rule cards are a fixed height and
  reorder with a grip on the left (press, drag, the list opens a slot); the
  attention level is the card's frame colour, not a chip inside it, and the id
  gets its own line. The rule panel is three numbered blocks: **信息** (name,
  description, tags, priority), **规则** (a plain-language reading, a preset
  palette, and catalogue-driven condition rows: compare / quantify / window /
  sequence), and **报告** (level, title with an insert-data menu, detail,
  evidence). **判读时机 is derived, not chosen**: no `facts.ended` condition means
  `both`, `ended = true` means `settled`, `ended = false` means `live` — there is
  no `phase` field to set. Id, cooldown and suppression hide under 更多设置.
- **事件流** — runs | events | the event. Pick the round, pick the event, edit
  it: type, time, the payload fields that matter for that type, and the raw JSON.
  Cards reorder with the same grip; adding an event inserts before a trailing
  `agent_end`.

Judgement lives in the report and nowhere else: the editor and the event stream
edit data, and only the report panel runs the pack. The editor also brings its
own Chinese report spec (`web/src/lib/reports.ts`) — a spec is data, so this is
not a renderer fork.

See `web/README.md`.

## Let an agent edit the rules

The editor is a browser app, so it needs a seam that is not `localStorage`. That
seam is `scripts/api.ts`: the same `PackStore` + `fsPackIO` the CLI uses, behind
JSON endpoints on `127.0.0.1:5175`.

```bash
npm run api                       # http://127.0.0.1:5175, packs in .chart/rules
curl -s localhost:5175/api/catalog | jq '.fields[] | select(.path|startswith("facts.commands"))'
curl -s localhost:5175/api/packs/work/rules/run.failure-streak | jq
```

The loop an agent runs is: **read the catalog** (every field, operator, event
type, window measure, level), **read the pack**, **PATCH or POST one rule**,
**read the result**. Mutations return the new pack, so there is no re-read; an
invalid rule is a `422` with paths into it (`rules[0].when.conditions[1].op`),
not a silent no-op. There is no `eval` and no network call in the engine — the API
only moves JSON.

```bash
# add a rule without touching the rest
curl -s -X POST localhost:5175/api/packs/work/rules -H 'content-type: application/json' -d '{
  "id": "user.burst", "name": "两分钟内连败三次",
  "when": { "combinator": "all", "conditions": [
    { "field": "facts.ended", "op": "eq", "value": false },
    { "window": {
      "events": { "type": ["command"], "where": { "conditions": [ { "field": "payload.exitCode", "op": "ne", "value": 0 } ] } },
      "span": { "lastMs": 120000 }, "measure": "count", "op": "gte", "value": 3 } } ] },
  "emit": { "level": "high", "title": "最近两分钟连败", "tags": ["commands"], "evidence": ["facts.failed"] }
}' | jq '.issues'

# change one field, then reorder
curl -s -X PATCH localhost:5175/api/packs/work/rules/user.burst -d '{"emit":{"level":"medium"}}' | jq '.rule.emit.level'
curl -s -X POST localhost:5175/api/packs/work/rules/user.burst/move -d '{"index":0}'
```

The editor uses the same API when it is running (Vite proxies `/api`), so a rule
edited in the browser is the file an agent edits with `curl`. When the API is not
running the editor falls back to `localStorage` and the top bar says
**浏览器** instead of **磁盘 · API**. Full reference: `docs/API.md`.

Rules live in **packs on disk** (`<dir>/work.json` + `active.json`), the same
layout Absence uses for egg-filters. The store validates before it writes,
writes atomically, and refuses path-traversal names. `chart/editor` holds the
model a UI needs — a catalogue of every addressable field, the operators valid
for each, and a **preview** that runs a half-written rule against the selected
run. `chart/store/fs` is a Node subpath, so a browser bundle never sees
`node:fs`. See `docs/EDITOR.md`.

## Layout

```
src/
  core/      events, types, live context        — Chart's own vocabulary
  facts/     build.ts runs.ts diff.ts glob.ts   — pure reduction of a run
  regimen/   predicate window rule evaluate     — the rule engine
             defaults.ts  examples.ts           — the shipped pack, and samples
  report/    spec render defaults verdict       — specs and the renderer
  store/     packStore.ts fs.ts                 — packs on disk (validated, atomic)
  editor/    catalog.ts draft.ts                — the model a rule editor needs
  adapters/  absence.ts                         — the only Absence-aware file
test/        facts regimen defaults report      — 477 checks, one harness
             store editor api
scripts/     check.ts demo.ts chart.ts api.ts    — chart.ts and api.ts are the hosts
web/         React editor + simulator           — dev tool, not published
docs/        DESIGN.md RULES.md REPORTS.md EDITOR.md API.md
```

No runtime dependencies. `typescript` and `tsx` are dev-only.

## Status

Done and tested:

- event → run grouping (driven and observed streams)
- facts: commands (including failed shell tools with no `command` event), files
  (created/modified/deleted/observed, reverts, external changes), processes
  (with lifetimes measured against the run end), MCP, errors, recoveries,
  streaks, retries, outside changes, knowledge, timeline, phases
- Regimen: flat conditions (23 operators incl. negations), collection
  quantifiers, **event windows** (`count`/`streak`/`gapMs`/`sum`/`max`/`min`/
  `avg`/`distinct` with `lastMs`/`nextMs` spans), a derived `live`/`settled`/`both`
  phase (a `facts.ended` condition, not a field), an operator catalogue for
  editors, validation with paths, templates, priority, suppression, cooldowns,
  fail-open errors
- **resources as conditions**: `live.metrics` carries the host's sampler as a
  snapshot — per-egg `cpuPercent`/`cpuSeconds`/`rssBytes`/`processCount` plus
  session averages, the whole `agent` tree, and the `host`'s CPU/memory/load.
  `metricsFromFrames` does the counter→rate derivation Absence's dashboard does,
  so a rule and a chart never disagree about what 90% meant; `metricsAt` makes
  playback show the resources of the scrubbed moment, not of the session end.
  Templates gained `percent`, `bytes` and `round` for these numbers.
- three modes: `observe` / `record` + `replayReport` (recorded findings, no
  re-judging) / `simulate` (hypothetical, labelled)
- packs on disk: `PackStore` (validate-before-write, atomic, slug names, a
  broken pack is listed with its issues) + a `PackIO` seam so the browser never
  imports `node:fs`
- the editor model: a checked catalogue of every addressable field and event
  payload, per-type operator suggestions, rule validation with paths,
  `describeRule`, and `previewRule` (simulate one rule against the selected run)
- the CLI host: `chart rules list|show|create|activate|delete|validate|format|
  preview|simulate|fields`
- the rules API (`scripts/api.ts`): packs over HTTP, validated before write,
  `PATCH`/`POST`/`move` per rule, a `/api/catalog` of the whole language, and
  `--static` to serve the built editor on the same port
- a visual editor (`web/`): a four-column **report** with playback (play, step,
  scrub, speed) that judges each revealed prefix; a **rules** editor with
  drag-to-reorder cards and three blocks (信息 / 规则 / 报告), presets, and a
  catalogue-driven condition builder; and an **events** editor with a detail
  panel for one event. Judgement is confined to the report panel.
- the default pack, byte-for-byte equivalent to Absence v0.4's attention rules
  (the display strings are translated; reasons, levels, thresholds and phases are
  unchanged)
- report specs: header, verdict, findings, stats, table (sort/limit), list,
  timeline, evidence — plus a plain-text renderer
- the Absence adapter

Deliberately deferred (see `docs/DESIGN.md`): cross-run baselines, a metrics
fact layer, and sequence correlation as facts (`facts.flaps`) rather than as
nesting.

## Folding it back into Absence

`docs/DESIGN.md` has the phase plan. The short version:

1. Add Chart as a workspace package, run both engines side by side, assert they
   agree on real sessions (`check:parity`).
2. Point the report overlay and the chime hook at Chart's findings, and persist
   a `FindingRecord` per run (findings + `packHash`) next to the events.
3. Delete `apps/web/src/lib/report.ts`'s attention half and
   `apps/web/src/types/report.ts`'s report types.
4. Replace the REPORT WARN pane with a rules pane built on `chart/editor`, backed
   by `PackStore` over an HTTP `PackIO` (the server side is `fsPackIO`, next to
   `egg-filters/`). Keep Monaco for the raw-JSON escape hatch; the row builder is
   the primary path.

**Status: all four phases have landed in Absence** — side by side first (the
parity run: 534/534 runs identical after one recovery-detection fix), then the
report and chimes pointed at Chart, a hash-chained `FindingRecord` persisted
per settled run, the old engine deleted, and the REPORT WARN pane replaced by
a rules pane over `PackStore` + `fsPackIO`. The integration side is documented
in Absence's `docs/CHART.md`.
