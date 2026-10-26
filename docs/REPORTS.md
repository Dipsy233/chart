# Reports

A report is a spec: a list of sections, each with a source path and templates.
Rendering is pure — `(spec, context) → RenderedReport` — and returns a document
model, not HTML.

A spec renders in two situations, and they must not be confused:

- `report(observation, spec)` — from a judgement just made;
- `replayReport(recorded, facts, spec)` — from a **record** (findings + pack hash).
  It does not evaluate anything, so a past run shows what was reported then.

```jsonc
{
  "id": "deliverables",
  "title": "Deliverables for {{facts.run.id}}",
  "description": "Only the files this run produced.",
  "for": "settled",
  "sections": [
    { "kind": "verdict" },
    { "kind": "findings", "minLevel": "low", "tags": ["deliverable"], "empty": "nothing yet" },
    { "kind": "list", "title": "Created", "source": "facts.files.created", "item": "{{vars.row}}" },
    {
      "kind": "table",
      "title": "Commands",
      "source": "facts.commandFacts",
      "columns": [
        { "header": "command", "cell": "{{vars.row.command|short}}", "width": "wide" },
        { "header": "exit", "cell": "{{vars.row.exitCode}}", "width": "narrow" }
      ],
      "limit": 20,
      "empty": "no commands"
    }
  ]
}
```

## Sections

| `kind` | Fields | Renders |
|---|---|---|
| `header` | `title`, `subtitle?` | A title block |
| `verdict` | `title?`, `showFindings?` | Level, outcome, reasons, and (by default) the findings |
| `findings` | `title?`, `minLevel?`, `tags?`, `limit?`, `empty?` | Findings, loudest first |
| `stats` | `title?`, `rows: [{label, value}]` | A label/value list |
| `table` | `source`, `columns`, `sort?`, `limit?`, `empty?` | Rows from an array |
| `list` | `source`, `item`, `limit?`, `empty?` | One line per element |
| `timeline` | `limit?`, `empty?` | The run's world line |
| `evidence` | `limit?` | Event ids, for the audit trail |

`table.columns[].width` is a hint (`auto` / `narrow` / `wide`); Chart does not
render, so the host decides what to do with it.

`table.sort` is `{ field, direction }` and is applied **before** `limit`.

## Template context

| Path | Holds |
|---|---|
| `facts.*` | The run's facts (see `docs/RULES.md` for the paths) |
| `live.*` | `nowMs`, `busy`, `status`, `elapsedSeconds`, `stalledSeconds`, `metrics` |
| `session.*` | Whatever the host passed: `id`, `project` |
| `vars.outcome`, `vars.headline` | The derived outcome and its sentence |
| `vars.row` | Inside a `table` or `list`, the current element |

A string element is `{{vars.row}}`; an object is `{{vars.row.command}}`.

## Shipped specs

- `LIVE_REPORT` — header, verdict, findings, six stats. For a run in flight.
- `SETTLED_REPORT` — header, verdict, findings, stats, commands, files,
  processes, knowledge, world line, evidence. For a run at rest.

Both are ordinary specs. There is no built-in layout that a custom one cannot
reach.

## Guidance

- **`minLevel: "low"` is the right default.** A report is for a human; `none`
  never exists as a finding, and `low` is the quietest useful cut.
- **`limit` everything that can grow.** Commands and files can be hundreds.
- **`evidence` last.** It is the audit trail, not the summary.
- **One report per question.** "Can I trust this run?" and "what did it produce?"
  are different documents; write two specs rather than one long one.
- **Render, then diff.** Because the output is data, two runs' reports can be
  diffed structurally — a one-page "what changed this time".
