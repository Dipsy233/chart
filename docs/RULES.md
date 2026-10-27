# Regimen — the rule language

A rule is JSON. It has a **flat** list of conditions, a verdict, and the words to
say. Nothing is executed.

```jsonc
{
  "id": "user.flailing",
  "name": "Five failures inside two minutes",
  "priority": 10,
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
    "title": "{{vars.window.count}} commands failed in the last 2 minutes",
    "tags": ["commands"],
    "evidence": ["window.ids"]
  }
}
```

## Flat, on purpose

`(A and B) or C` is **two rules**, not nested logic. That is the firewall/WAF
shape, and it is what makes a rule explainable in one sentence, orderable in a
UI, diffable in git, and validatable without running it. n8n's IF/Filter node is
flat for the same reason (`{ combinator, conditions: [...] }`); to nest it you
chain nodes, which is the same advice in a different costume.

Negation is an operator (`ne`, `notContains`, `notExists`, …), never a
combinator, so a tree cannot be built by accident.

## Fields

| Field | Meaning |
|---|---|
| `id` | Stable, unique. Used in `suppresses` and as the finding's `reason` by default. |
| `name`, `description` | For the editor. Never evaluated. |
| `phase` | **Derived, not declared** — see [Phases](#phases). No `facts.ended` condition means `both`. A legacy `phase` field is honoured only when the conditions say nothing, and rejected when it contradicts them. |
| `priority` | Higher evaluates first. Ties keep the order in the file. |
| `when` | `{ combinator?, conditions[] }`. Required. |
| `emit.level` | `none` / `low` / `medium` / `high`. `none` switches the rule **off**. |
| `emit.title` | One line. Templates allowed. Required. |
| `emit.detail` | Optional second line. |
| `emit.tags` | Free-form labels, used by report sections to filter. |
| `emit.evidence` | Paths to collect event ids from. Defaults to `facts.evidence`. |
| `emit.reason` | Slug for `Attention.reasons`. Defaults to `id`. |
| `cooldownMs` | After firing, stay quiet this long. Live only. |
| `suppresses` | Rule ids this rule silences when it fires. Never itself. |
| `enabled` | `false` keeps the rule in the pack but skips it. |

Evaluation is **all-match**: every matching rule contributes a finding, and
`Attention.level` is the loudest. It is a lens, not a firewall — the only
firewall-like behaviour is `suppresses`.

## Phases

| Phase | When | Anchor | Typical rules |
|---|---|---|---|
| `live` | every event (throttled) | `now` | stalls, bursts, "a deliverable landed" |
| `settled` | once, after `agent_end` | the run's last moment | leftover processes, totals, loops |
| `both` | either | — | streaks, repeated failures |

A rule that only makes sense settled (a leftover process) or only live (a stall)
**says so in its conditions**:

| Condition | Phase | Meaning |
|---|---|---|
| *(none about `facts.ended`)* | `both` | judged throughout |
| `facts.ended eq true` | `settled` | only once the run has ended |
| `facts.ended eq false` | `live` | only while it is still running |

`ne` / `exists` / `notExists` work the same way (`ne true` is the live form,
`exists` the settled one). A `combinator: "any"` block pins nothing, because its
other branches still work mid-run.

This used to be a `phase` field, which meant "only after the run ended" could be
said two ways — and a `phase: "live"` rule gated on `facts.ended` could never
fire at all. There is now one way, and `validatePack` rejects a pack where a
legacy `phase` field disagrees with the conditions. `phaseOf(rule)` is the one
function that answers the question.

## Conditions

Three kinds, one level deep.

### 1. Field comparison

```jsonc
{ "field": "facts.commands.failed", "op": "gte", "value": 5 }
```

`field` is a dot path: `facts.*`, `live.*`, `session.*`. Inside a `where` it is
relative to the array element. A missing path never matches a comparison.

| Op | Meaning |
|---|---|
| `eq`, `ne` | equality / inequality (deep for arrays and objects) |
| `gt`, `gte`, `lt`, `lte` | ordering; numeric when both sides are numbers, string otherwise |
| `between` | `value` is `[min, max]`, inclusive |
| `in`, `notIn` | `value` is an array of candidates |
| `contains`, `notContains` | substring (string) or membership (array) |
| `startsWith`, `endsWith` (+ `not*`) | string prefixes/suffixes |
| `matches`, `notMatches` | RegExp, unanchored; pattern ≤ 256 chars, input ≤ 4 KiB. A leading `(?i)` means case-insensitive (JS has no inline flags) |
| `glob`, `notGlob` | fnmatch: `*` within a segment, `**` across, `?` one char, `[abc]` / `[!abc]` a class, `\` escapes. A bare pattern also matches the file name. Works on any string, not just paths |
| `exists`, `notExists` | the path resolves to something that is not null/undefined |
| `empty`, `nonEmpty` | `""`, `[]`, `{}` / their negation |

**Arrays match element-wise.** `{ "field": "facts.files.created", "op": "glob",
"value": "company/**" }` is true when *any* created path matches.

### 2. Collection quantifier

```jsonc
{ "field": "facts.processes.runningAtEnd",
  "quant": "any",
  "where": { "conditions": [
    { "field": "name", "op": "eq", "value": "vite" },
    { "field": "lifetimeMs", "op": "gte", "value": 30000 } ] } }
```

`quant` is `any`, `all`, `none`, or `count`. `count` compares the number of
matching elements using `op`/`value`.

A `where` is a flat list of **field conditions only** — no windows, no nested
quantifiers. That is the guard that keeps the language flat.

### 3. Window — a query over the event stream

```jsonc
{ "window": {
    "events": { "type": ["command"],            // narrow the stream
                "where": { "conditions": [ … ] } },   // then filter it
    "span":   { "lastMs": 120000 },             // …and cut it around the anchor
    "measure": "streak", "op": "gte", "value": 5 } }
```

`events.type` may be one type or a list. `where` is a flat field-condition list
resolved against **the event** (`type`, `timestamp`, `payload.*`, `id`).

**Span.** `lastMs` = the N ms before the anchor (implies an upper bound of the
anchor); `nextMs` = the N ms after it; both = a closed interval. No span = the
whole run.

**Measures.**

| `measure` | Value | `of` |
|---|---|---|
| `count` | number of selected events | — |
| `streak` | longest run of consecutive matches | — |
| `gapMs` | last timestamp − first timestamp | — |
| `sum`, `max`, `min`, `avg` | over a numeric field | required, e.g. `payload.exitCode` |
| `distinct` | number of distinct values | optional, defaults to `type` |

**Streak semantics** (pinned by the checks): `events.type` defines the stream
being considered; a same-type event that fails `where` **breaks** the streak; a
different type is ignored entirely. That is what "consecutive failures" means —
one success in between ends the run.

**Windows do not nest**, and neither does anything else: `sequence` below is the
one ordering primitive, and `docs/DESIGN.md` §3 explains why the ladder stops
there.

### 4. Sequence — ordered steps with bounded gaps

A count cannot see order: `facts.retries` says "this command failed three times"
whether or not a success came in between. A sequence says it:

```jsonc
{ "sequence": {
    "steps": [
      { "type": ["command"], "where": { "conditions": [{ "field": "payload.exitCode", "op": "ne", "value": 0 }] }, "as": "failed" },
      { "type": ["command"], "where": { "conditions": [{ "field": "payload.exitCode", "op": "eq", "value": 0 }] }, "as": "recovered" },
      { "type": ["command"], "where": { "conditions": [{ "field": "payload.exitCode", "op": "ne", "value": 0 }] }, "as": "brokeAgain" }
    ],
    "gap": { "maxEvents": 30, "maxMs": 600000 },
    "times": 1,
    "span": { "lastMs": 3600000 }
  } }
```

| Field | Meaning |
|---|---|
| `steps` | Two or more, **in order**. `type` narrows, `where` filters, `as` names the step for templates. |
| `gap` | Bounds **between consecutive steps**: `maxEvents` (default 500) and `maxMs` (default 1 hour). |
| `times` | How many non-overlapping matches to require. Default 1. |
| `span.lastMs` | Only look this far back from the anchor. |

**Gaps are not optional in practice.** An agent always puts a `thinking` or a
`read` between two commands, so a strictly adjacent pattern would never match.
That is why the default gap is wide, and why the editor asks for it explicitly.

Matching is **leftmost, non-overlapping, and counted**, so the result is a number
and a list of event ids — never a set of possible alignments. The bounds make it
a bounded scan, not a search.

Templates read the match:

```
{{vars.sequence.count}}                  how many matches
{{vars.sequence.ids}}                    every event id used
{{vars.sequence.step.failed.id}}         the first match's `failed` step
{{vars.sequence.step.failed.timestamp}}
```

Evidence: `"evidence": ["sequence.ids"]` or `["sequence.step.brokeAgain"]`.

**What it is for.** "The fix did not hold" — fail, recover, break again — is a
sequence, not a fact. That distinction matters: a fact would have to be coded for
every new pattern, while a sequence is data a user writes. `example.flapping` in
`src/regimen/examples.ts` is exactly this rule.

**What it is not.** It is not a regular expression over events: steps are a flat
list, and a step's `where` may not contain a window, a sequence or a quantifier.
The ladder stops here on purpose (`docs/DESIGN.md` §3).

### What a window can see

| You want to match… | Write |
|---|---|
| the user's input | `type: ["message"]` + `payload.role eq "user"` + `payload.content matches "…"` |
| the agent's output | `type: ["message"]` + `payload.role eq "assistant"` + `payload.content matches "…"` |
| its thinking | `type: ["thinking"]` + `payload.content matches "…"` |
| a command | `type: ["command"]` + `payload.command` / `payload.exitCode` / `payload.stderr` |
| a file change | `type: ["file_write","file_edit","file_change"]` + `payload.path glob "…"` / `payload.diff matches "…"` |
| a tool call | `type: ["tool_start","tool_end"]` + `payload.toolName` / `payload.args` / `payload.isError` |
| a process | `type: ["process"]` + `payload.name` / `payload.commandLine` / `payload.kind` |
| an MCP call | `type: ["mcp"]` + `payload.server` / `payload.tool` / `payload.isError` |
| a moment in time | `timestamp` (`gte`, `between`, …) |
| resources | `live.metrics.eggs[*].cpuPercent` — a snapshot, not an event |

## Templates

`emit.title`, `emit.detail`, and report cells are templates.

```
{{facts.commands.failed}} commands failed
{{facts.files.created|count}} files · {{facts.files.created|join: ", "}}
{{vars.window.count}} failures in {{vars.window.gapMs|duration}}
```

| Filter | Effect |
|---|---|
| `count` | length of an array |
| `keys` | object keys |
| `join: ", "` | join an array |
| `first`, `last` | array ends |
| `duration` | ms → `1h 05m` / `12s`; `—` when not a number |
| `secs` | seconds → the same formatting |
| `plural: file` | `1 file` / `3 files` |
| `flag: write` | the label when `true`, empty otherwise |
| `bool: running,stopped` | one of two labels |
| `lines` | line count of a string |
| `upper`, `lower` | case |
| `short` | last two path segments |

`vars.window` holds the numbers from the windows a rule ran: `count`, `streak`,
`gapMs`, `selected`, `ids`, plus `0.count`, `1.count`… when there are several.

An unknown path renders empty; an unknown filter is a no-op. A template can
never fail the run.

## Reasons: a closed vocabulary

A finding's `reason` is the machine-readable key — what a report shows, what the
chime hook reads, what makes two runs comparable across pack versions. So it is
**closed**:

- a **reserved** slug, from Absence's own vocabulary: `command_failed`,
  `unresolved_error`, `command_failure_streak`, `activity_stalled`,
  `agent_stopped`, `process_left_running`, `outside_change`,
  `file_version_loop`, `command_retry_loop`, `agent_waiting`, `no_progress`,
  `external_change`;
- or a **namespaced** slug: `user.flapping`, `my-pack.flapping` — at least one
  dot, lower case, so it can never collide with a reserved name.

A rule that names nothing gets its id, normalised: `run.agent-stopped` is already
namespaced, and a bare `flap` becomes `custom.flap`. Validation rejects anything
else, so a report never contains an unclassified key.

`REASON_LABELS` carries a sentence for each reserved reason, for a UI that has to
explain a verdict.

## Evidence

Every finding carries event ids. `emit.evidence` names where to collect them:

- `facts.failed`, `facts.unresolved`, `facts.reverts` — arrays of ids, or arrays
  of objects with an `evidence` array
- `window.ids` — the events the window selected
- default: `facts.evidence` (the run's tail)

## Operator catalogue

`OPERATOR_CATALOG` groups operators by value kind (`string`, `number`,
`boolean`, `dateTime`, `array`, `object`) the way n8n's condition builder does,
so an editor can show five relevant operators instead of all 22:

```ts
operatorsFor("number")  // equals, gt, gte, lt, lte, between, in, notIn, exists…
operatorsFor("string")  // equals, contains, regex, glob, startsWith, exists…
```

## Examples

**A deliverable landed, agent still working.** Non-blocking by construction: a
finding is data, it does not touch the run.

```jsonc
{
  "id": "example.deliverable",
  "when": { "combinator": "any", "conditions": [
    { "field": "facts.files.created", "op": "glob", "value": "company/**/*.txt" },
    { "field": "facts.files.created", "op": "glob", "value": "company/**/*.md" }
  ]},
  "emit": {
    "level": "low",
    "title": "Ready to read: {{facts.files.created|join: \", \"}}",
    "tags": ["deliverable"],
    "evidence": ["facts.files.created"]
  }
}
```

**Five failures inside two minutes.** The window makes "a burst" a first-class
idea; `facts.commands.failed` could never tell a burst from an afternoon.

```jsonc
{ "id": "example.five-failures-in-two-minutes",
  "when": { "conditions": [
    { "field": "facts.ended", "op": "eq", "value": false },
    { "window": {
    "events": { "type": ["command"], "where": { "conditions": [
      { "field": "payload.exitCode", "op": "ne", "value": 0 }] } },
    "span": { "lastMs": 120000 },
    "measure": "count", "op": "gte", "value": 5 } }] },
  "emit": { "level": "high", "title": "{{vars.window.count}} failures in 2 minutes",
            "evidence": ["window.ids"] } }
```

**Root search.** Chart reports it; it never blocks it.

```jsonc
{ "id": "example.root-search",
  "when": { "conditions": [{ "window": {
    "events": { "type": ["command"], "where": { "conditions": [
      { "field": "payload.command", "op": "matches", "value": "^\\s*(find|du|grep)\\s+/(\\s|$)" }] } },
    "measure": "count", "op": "gte", "value": 1 } }] },
  "emit": { "level": "medium", "title": "The agent searched from /",
            "evidence": ["window.ids"] } }
```

**Switch a default off, or narrow it.** Two ways, no copying:

```jsonc
// off
{ "id": "run.outside-change", "enabled": false,
  "when": { "conditions": [{ "field": "facts.ended", "op": "exists" }] },
  "emit": { "level": "none", "title": "off" } }

// or narrow it to .env files only
{ "id": "run.outside-change",
  "when": { "conditions": [{ "field": "facts.outsideChanges", "quant": "any",
            "where": { "conditions": [{ "field": "path", "op": "glob", "value": "**/.env" }] } }] },
  "emit": { "level": "medium", "title": "A .env changed outside the project",
            "evidence": ["facts.outsideChanges"] } }
```

`mergePacks(DEFAULT_PACK, myPack)` applies either one by id.

## Pitfalls

- **`level: "none"` means off**, not silent-but-present. Absence's "silent" drops
  the reason from the report entirely; Chart keeps that meaning so the default
  pack stays byte-identical.
- **Arrays match element-wise** for every operator except `eq`. For "exactly
  two", use `count`.
- **A window needs `context.events`.** A host that forgets it gets a rule error
  (fail-open), not a silent `false`.
- **Cooldowns need state.** `evaluate(pack, ctx, { state })` returns the next
  state; pass it back on the next live tick. A simulation starts empty, so it
  shows every finding once.
- **A throwing rule is skipped, not fatal.** It appears in `Evaluation.errors`.
  A rule that silently never matches is a validation problem — run
  `validatePack` before saving.
- **Windows cost O(n).** The defaults deliberately use none; user rules that do
  should be throttled (Absence uses 500 ms).
