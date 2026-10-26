# Editing rules

A rule is JSON, so "editing rules" could just mean "editing a file". This
document is about the two things a *product* needs on top of that: somewhere for
the packs to live, and a model an editor can be built on without putting rule
logic in the UI.

---

## 1. Where packs live

The layout is the one Absence already uses for egg-filters and avatar skins:

```
<dir>/active.json     { "active": "work" }
<dir>/work.json       a RulePack
<dir>/personal.json   another
```

`<dir>` is `--dir`, `$CHART_RULES_DIR`, or `.chart/rules`. Nothing is required to
exist: no directory, no pointer means the built-in defaults are in use.

```ts
import { PackStore } from "chart";
import { fsPackIO } from "chart/store/fs";

const store = new PackStore(fsPackIO({ dir: ".chart/rules" }));

await store.list();                 // summaries: rules, phases, hash, issues
await store.load();                 // the active pack, or the defaults
await store.create("work");         // copy the defaults, then activate
await store.save("work", pack);     // validate, then write (atomic)
await store.activate("work");       // refuses an invalid pack
await store.deactivate();           // back to the built-in defaults
```

Three guarantees the store makes, because losing a rule file is worse than
refusing an edit:

- **validated before written** — a typo in an operator is a save-time error, not
  a silent no-op discovered weeks later;
- **atomic writes** — temp file + rename, so a crash cannot leave half a pack;
- **slug-only names** — `../etc/passwd` is not a pack name, and `active` is
  reserved for the pointer.

A pack that fails to parse is **listed with its issues** rather than hidden, so
a broken file is visible in the UI instead of silently ignored.

`PackStore` talks to a `PackIO`, not to `node:fs`. The Node adapter is a subpath
export (`chart/store/fs`) so a browser bundle never pulls in `node:fs`; a web app
implements `PackIO` over HTTP in about twenty lines.

---

## 2. The editor model

`chart/editor` is everything a rule editor needs that is not a UI. The point is
that a React pane, a TUI and the CLI all share it, so the three cannot drift.

```ts
import {
  allFields, eventFields, fieldFor,      // the catalogue: what a rule may address
  operatorsForField,                     // the operators valid for that field
  newRule, validateRule, describeRule,   // the boring half
  previewRule, upsertRule, removeRule,   // the useful half
  suggestId, isIdTaken,
} from "chart";
```

### The catalogue

`allFields()` returns every addressable path with a type and a label:

```ts
{ path: "facts.commands.failed", kind: "number", label: "commands failed", group: "facts" }
{ path: "facts.processes.runningAtEnd", kind: "array", label: "processes still running at the end",
  element: [{ path: "name", kind: "string", … }, { path: "lifetimeMs", kind: "number", … }] }
```

`eventFields(["command"])` does the same for the events a window may scan, so a
window builder can offer `payload.exitCode` but not `payload.role`.

`test/editor.test.ts` walks the whole catalogue against a real `Facts` object and
a real event of every type, and fails if any path does not resolve. The catalogue
is therefore a promise that is checked, not a comment that rots.

### The operator picker

`operatorsForField("facts.commands.failed")` returns only what makes sense for a
number (equals, gt, gte, lt, lte, between, in, notIn, exists…), the way n8n's
condition builder does. An unknown path returns every distinct operation once.

### The preview button

```ts
const preview = previewRule(rule, events, { anchor: nowMs });
// { fired, findings, errors, hypothetical: true, events: 21 }
```

This is what makes custom rules usable rather than mysterious. Because judging is
a pure function of the record, a half-written rule can be run against the
**selected run** and the answer shown immediately — including on a live anchor
(`nowMs`) and a settled one, from the same record. It is a simulation: it never
writes a record and never reads one, and it is typed `hypothetical: true` so no
caller can mistake it for a replay.

A broken rule comes back as `errors`, not an exception: the editor shows a red
line instead of dying.

---

## 3. Building the pane

The pane Absence needs (and that this model was shaped for):

```
┌ packs ──────────┬ rules ────────────────────────┬ rule ─────────────────────┐
│ ● work          │ run.agent-stopped    high     │ id    [user.burst      ]  │
│   personal      │ run.unresolved-error high     │ phase [live ▾]            │
│                 │ run.commands-failed  low      │ level [high ▾]            │
│ + new name      │ user.burst           high  ●  │ ── conditions ─────────── │
│                 │                               │ [all ▾]                   │
│                 │                               │ facts.commands.failed ≥ 5 │
│                 │                               │ window  command  last 2m  │
│                 │                               │         count    ≥ 5      │
│                 │                               │ + add condition           │
│                 │                               │ ── says ───────────────── │
│                 │                               │ title  [ …            ]   │
│                 │                               │ ── preview ────────────── │
│                 │                               │ ▶ run against this run    │
│                 │                               │   HIGH 5 failures in 2m   │
└─────────────────┴───────────────────────────────┴───────────────────────────┘
```

The pieces, and where each comes from:

| UI piece | Data source |
|---|---|
| pack list, `●` active marker, health | `store.list()` |
| rule list with level/phase | `pack.rules` + `describeRule` |
| field picker | `allFields()` / `eventFields(types)` |
| operator picker | `operatorsForField(path)` |
| condition rows (compare / quantify / window) | the three `Condition` shapes |
| "add condition" | push onto `when.conditions` — **never** nest |
| validation underlines | `validateRule(rule)` → `issue.path` |
| preview | `previewRule(rule, events, { anchor })` |
| save | `store.save(name, upsertRule(pack, rule))` |

Two UI rules worth writing down, because they are what keeps the language honest:

1. **Never offer a way to nest.** If a user needs `(A and B) or C`, the answer is
   "add a second rule" — the UI should say so in one line, not grow a tree editor.
2. **Show the sentence.** `describeRule(rule)` next to every rule makes the
   difference between a list of JSON blobs and a list of intentions.

Monaco is the right editor for the raw-JSON escape hatch (Absence already has it),
but the row builder is the primary path: most users should never type `facts.`.

---

## 4. The CLI (the reference host)

`npm run rules -- <command>` is a complete host in ~400 lines, and doubles as the
acceptance test for the store and the editor model.

```bash
npm run rules -- list
npm run rules -- create work
npm run rules -- show work
npm run rules -- validate work
npm run rules -- activate work
npm run rules -- fields --type command

# judge a recorded run with a pack
npm run rules -- simulate .chart/demo-events.json --phase settled --report

# try one rule against that run, without saving it
npm run rules -- preview work run.leftover-eggs .chart/demo-events.json
```

`npm run demo` writes `.chart/demo-events.json`, so the two commands above work
out of the box.

---

## 5. What the record means for the editor

The editor edits **packs**, and packs only affect *future* judgements. Editing a
rule never changes a report you have already read:

- the report of a past run is rendered from the `FindingRecord` written at the
  time (findings + `packHash`);
- `previewRule` is explicitly a hypothetical and never writes a record;
- so "the rule was not configured then" stays true forever, which is the property
  that makes the report trustworthy.

`packHash` is on every record, so a report can always name the exact pack that
judged it — and `store.list()` shows the same hash, so a UI can answer "is this
report from the pack I am looking at?"
