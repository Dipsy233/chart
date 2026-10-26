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
./start-chart.sh check    # the 358 assertions
./start-chart.sh demo     # a real report, plus .chart/demo-events.json for the CLI
./start-chart.sh rules list
```

On Windows, `start-chart.bat` takes the same arguments (`start`, `open`,
`check`, `demo`, `rules`, `build`).

The same things as npm scripts, if you prefer:

```bash
npm install
npm run check    # facts, conditions, windows, phases, parity, modes, store, editor
npm run demo
npm run rules -- list          # rule packs on disk
npm run rules -- create work   # copy the defaults into an editable pack
npm run web:install && npm run web    # the editor on http://localhost:5174
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
  "phase": "live",
  "when": {
    "combinator": "all",
    "conditions": [
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

`web/` is a React editor + simulator with three views, switched from the top bar:

- **Report** — the run as a document (verdict, findings, stats, tables, world
  line, evidence), sans-serif prose and monospace identifiers.
- **Rules** — packs | rules | the selected rule, with a findings strip underneath
  so an edit has feedback without a full report. Catalogue-driven condition
  builder (compare / quantify / window) and a **preview on this run** button.
- **Events** — the event stream as a form: add, edit, retime, reorder, and watch
  the facts and findings move.

See `web/README.md`.

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
test/        facts regimen defaults report      — 358 checks, one harness
             store editor
scripts/     check.ts demo.ts chart.ts          — chart.ts is the CLI host
web/         React editor + simulator           — dev tool, not published
docs/        DESIGN.md RULES.md REPORTS.md EDITOR.md
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
  `avg`/`distinct` with `lastMs`/`nextMs` spans), `live`/`settled`/`both` phases,
  an operator catalogue for editors, validation with paths, templates, priority,
  suppression, cooldowns, fail-open errors
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
- a visual editor (`web/`): three views — the run **Report** as a document, the
  **Rules** editor with a live findings strip, and an **Events** form that edits
  the stream and shows what it adds up to
- the default pack, byte-for-byte equivalent to Absence v0.4's attention rules
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
