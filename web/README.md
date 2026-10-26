# Chart · Regimen editor (web)

A visual rule editor, a readable run report, and an event-stream simulator — in
the browser. It imports `../src` directly: no build step between the engine and
the UI that shows it.

```bash
npm install
npm run dev      # http://localhost:5174
```

## Three views, one state

The top bar switches between them; everything else (the run, the pack, the phase,
the anchor) is shared, so a rule you edit is the rule the report judges with.

| View | What it is |
|---|---|
| **Report** | The run, as a document. Verdict, findings, at-a-glance numbers, command/file/process tables, what the agent learned, the world line, evidence. |
| **Rules** | Packs on the left, rules in the middle, the selected rule on the right, and a **findings strip** underneath so an edit has feedback without a full report. |
| **Events** | The event stream as a form: add, edit, reorder, retime, and watch the verdict move. |

### Why the report is its own view

Editing a rule and reading a report are different tasks with different reading
habits: one wants density and controls, the other wants prose and space. Sharing
a screen made both worse — the report was squeezed into a 340px column while the
editor had three. The strip under the Rules view keeps the feedback loop (you see
what fires) without pretending to be the report.

Typography follows the same split: **sans for prose**, **monospace for
identifiers** (paths, ids, commands, event names). The earlier pass was
monospace everywhere, which is why it read like a log file.

## Report view

- The verdict is a large coloured word, not a chip: `high` / `medium` / `low`.
- Findings are cards with a coloured spine, a sentence, an optional second
  sentence, and the evidence ids in monospace.
- Stats are a two-column list (`commands · 1 ok / 3 failed`), not a table.
- Tables are for things with rows: commands, files, processes, what was read.
- The world line is a timeline with relative offsets, action, subject, effect.
- A slim bar above the document says which pack judged it and at which anchor —
  the answer to "why does it say high?".

## Rules view

```
┌ packs ────────┬ rules ────────────────┬ the selected rule ───────────────┐
│ ● work        │ run.agent-stopped     │ id · enabled · phase · level     │
│   defaults    │ run.unresolved-error  │ reads as: <one sentence>         │
│ + import      │ user.rule-13          │ conditions: compare/quant/window │
│   export      │ +                     │ what it says: title/detail/tags  │
│               │                       │ ▶ preview on this run            │
├───────────────┴───────────────────────┴──────────────────────────────────┤
│ high  1 failure with no recovery   medium  3 commands failed back to back│
└──────────────────────────────────────────────────────────────────────────┘
```

The condition editor is driven by the catalogue, not hard-coded:

- the field dropdown lists **every** addressable path (facts and live), with
  array elements hinted;
- the operator dropdown shows only the operators valid for that field's type
  (number → gt/gte/between; string → regex/glob; every kind → exists/empty);
- `window` offers the 17 event types as toggle chips, and the `where` sub-rows
  offer only the payload fields of the types you picked (pick `command` and you
  get `payload.exitCode`);
- there is **no "add group"**: `(A and B) or C` is a second rule, and the panel
  says so once.

**Preview on this run** is the "execute step" affordance: it judges *this* rule
against the selected run at the current anchor and shows the finding inline.
Move the anchor to `+5m` and a window rule goes quiet — the sliding window is
visible, not theoretical.

## Events view

The stream is a form, not a JSON blob:

```
 1  [agent_start ▾]  +0.0s    ▲ ▼ ⧉ { } ✕
    timestamp  [11:36:58]   model  [qwen3-4b]
 6  [command ▾]      +18.2s
    timestamp  [11:37:14]   command [curl -s …/pricing]
    exitCode   [28]         stdout  []   stderr [timeout]
```

- **add** bar at the bottom: one button per event type. A new event is inserted
  *before* a trailing `agent_end` — anything after it belongs to no run and would
  be silently ignored.
- **auto-time** re-spaces everything 5s apart; **shift to now** makes the stream
  current; **renumber** rewrites ids as `evt_1…` so evidence stays readable.
- Per card: type, timestamp (`HH:MM:SS`), the payload fields the catalogue says
  matter for that type, `{ }` to edit the raw JSON, duplicate, delete, reorder.
- The right panel answers "so what?" — events, span, run id, verdict, the facts
  the rules will read (commands, streak, files, processes, unresolved, outside),
  and the findings. Click a finding to jump to its rule.

That loop — add a failing command, watch `commands` and `streak` move, see a new
finding appear, open the report — is the simulator.

## Two demos

- **research run** — two deliverables, a flaky endpoint hit twice, a file written
  outside the project, a process left running.
- **flailing run** — five failures inside two minutes, then a recovery. Switch to
  it to watch a window rule fire and the streak rule agree.

## Why no node canvas

n8n's canvas draws edges because data flows between nodes. A rule engine has no
edges: a rule is a flat list of conditions producing one finding. Drawing wires
would be a lie. This is n8n's *other* UI — the NDV condition builder it uses for
IF and Filter — which is the honest analogue, plus the canvas's one good idea,
**execute step**, as *preview on this run*.

## Not part of the library

`web/` is a dev tool: not a workspace of the package, not published, and nothing
in `src/` imports it. `chart` stays dependency-free; React and Vite live only
here. Packs persist in `localStorage` behind the same `PackIO` interface the CLI's
`fsPackIO` implements, so `export` produces a file you can drop into
`.chart/rules/`.
