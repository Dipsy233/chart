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
| `findings` | `title?`, `minLevel?`, `tags?`, `limit?`, `empty?`, `filter?` | Findings, loudest first |
| `stats` | `title?`, `rows: [{label, value}]` | A label/value list |
| `table` | `source`, `columns`, `sort?`, `limit?`, `empty?`, `filter?`, `evidence?` | Rows from an array |
| `list` | `source`, `item`, `limit?`, `empty?`, `filter?`, `evidence?` | One line per element |
| `text` | `source`, `item?`, `limit?`, `empty?`, `filter?`, `evidence?`, `style?` | A paragraph, or one line per element |
| `timeline` | `limit?`, `empty?` | The run's world line |
| `evidence` | `limit?` | Event ids, for the audit trail |

`table.columns[].width` is a hint (`auto` / `narrow` / `wide`); Chart does not
render, so the host decides what to do with it.

`table.sort` is `{ field, direction }` and is applied **before** `limit`.

## `filter` — narrowing a section

A `filter` is a plain `When` — the same shape a rule's `where` uses — evaluated
by the same `matches()` against one element of the `source` array. It is applied
**before** `sort` and `limit`, so a report can say “the ten biggest files under
`company/`”.

```jsonc
{ "kind": "table",
  "source": "facts.files.byPath",
  "filter": { "conditions": [{ "field": "path", "op": "glob", "value": "company/**" }] },
  "columns": [{ "header": "path", "cell": "{{vars.row.path}}" }],
  "evidence": "evidence" }
```

Two leaf kinds are rejected by validation: a `window` and a `sequence` need the
event stream or ordering, which is a *rule's* job, not a row's. The message says
so (`"belongs in a rule"`) rather than silently ignoring it.

A `findings` section's filter reads the **finding**, so
`{ "field": "tags", "op": "contains", "value": "commands" }` keeps only the
findings tagged `commands`.

## `evidence` — keeping rows clickable

A `table` / `list` / `text` section names where to collect each row's event ids,
as a path under `vars.row`:

```jsonc
{ "kind": "list", "source": "facts.files.created", "item": "{{vars.row}}",
  "evidence": "evidence" }
```

`RenderedSection.evidence` is then a `string[][]`, **index-aligned with the
rows**, and the host turns it into links. Without it a row is text, so a click
cannot reach the event that proves it — which is why the shipped Absence report
could not be expressed as a spec until this existed.

A row that produces no ids gets an empty array rather than a made-up one.

## `text` — prose

A `text` section reads a **string** path and renders it as a paragraph
(`facts.response`, `facts.firstPrompt`), or an **array** and renders `item` once
per element (`facts.text.thoughts`, `facts.text.replies`). `style` is
`paragraph` (default) or `code`.

## Validating a spec

`validateSpec(spec)` returns every problem with a path into the spec, the way
`validatePack` does for a pack. Rendering stays fail-open — an unknown path
renders empty so a report can never fail a run — but that is exactly why an
editor needs validation: a typo'd `source` renders “nothing to show” forever.

`checkTemplate(template, context)` is the other half: it reports placeholders
that do not resolve, and filters that do not exist. Rendering stays silent;
the *editor* is where a typo becomes a red line.

## Which pack judged it

`RenderedReport.judgedBy` carries `{ packName?, packHash?, at, replayed? }` when
the caller knows. A report whose verdict came from a hash-chained record must be
able to say *which* pack produced it — otherwise a report of last week reads as
if today's rules had judged it, and `packHash` is a field nobody ever sees.

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
- `CLASSIC_REPORT` — Absence's original report layout, section for section, as
  data. It is the **default**, and it exists to prove a claim: **every section of
  the shipped report is expressible as a spec**, so forking it is editing JSON
  rather than forking a module. Its four file lists (modified / created /
  observed / deleted) are one `facts.files.byPath` source with four different
  `filter`s.

All three are ordinary specs. There is no built-in layout that a custom one
cannot reach.

**They are English, and that is deliberate.** A spec is data — read by a CLI, a
diff, a person opening the JSON, and whoever you send it to. Prose for the user
belongs to the *host*: the editor's `ReportDocument` translates section titles
and the outcome headline. Two shipped specs differing only in the language of
their titles would be one spec and a copy.

## Guidance

- **`minLevel: "low"` is the right default.** A report is for a human; `none`
  never exists as a finding, and `low` is the quietest useful cut.
- **`limit` everything that can grow.** Commands and files can be hundreds.
- **`evidence` last.** It is the audit trail, not the summary.
- **One report per question.** "Can I trust this run?" and "what did it produce?"
  are different documents; write two specs rather than one long one.
- **Render, then diff.** Because the output is data, two runs' reports can be
  diffed structurally — a one-page "what changed this time".
