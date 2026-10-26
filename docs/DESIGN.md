# Design

Chart is an observation engine, not a workflow engine. This document explains
what that means in code, why the split is drawn where it is, and how to fold the
result back into Absence.

---

## 1. What was wrong with the old report

`apps/web/src/lib/report.ts` (Absence v0.4) is a good reduction and a bad
architecture. Four concrete problems, each with a fix here:

| Problem | Consequence | Chart |
|---|---|---|
| `buildRunFacts(events, run, attentionOptions)` takes the user's thresholds | Changing a setting changes the **facts**, so history cannot be re-judged and two runs are not comparable | `buildFacts(events, run)` — no options, ever |
| Verdicts are computed inside the facts (`loops` filtered by threshold, `runningAtEnd` filtered by an ignore list, `attention` computed at the end) | Measurement and judgement are one blob | facts hold `reverts`, `retries`, `processes.runningAtEnd` **unfiltered**; every threshold lives in a rule |
| The layout is a 1300-line module | A user who wants "the same run, only what touched `company/`" has no path | a report is a **spec**: sections, sources, templates |
| Types are UI types (`LiveReport`, `RunReport`, `RenderLiveOptions`) | The engine cannot run in a server, a CLI, or a test without the web app | engine types only; the host renders |

The headline fix is the first row. **Facts are a pure function of the event
stream.** Everything a user can tune is downstream of that, so a run's facts are
stable forever and a rule can be re-run against them at any time.

---

## 2. Five invariants

Each one is enforced by construction, not by convention.

**I1 · Pure.** No `Date.now()`, no `Math.random()`, no `fs`, no `fetch` anywhere
in `src/`. Time arrives as `live.nowMs`; ids arrive in the events. A grep for
`Date.now` in `src/` returns nothing.

**I2 · Measurement ≠ judgement.** `facts/` may count, pair, diff and fold. It may
not threshold. If a fact looks like a verdict ("this is a loop"), the threshold
belongs to a rule.

**I3 · Determinism.** `(events, pack, live, state) → findings` is a pure
function. `test/defaults.test.ts` pins parity with Absence; `test/regimen.test.ts`
pins byte-identical output for identical input.

**I4 · Evidence or nothing.** Every finding carries event ids, and the evaluator
refuses to emit one with an empty evidence list (it falls back to the run's tail
rather than lying). A report that cannot link a claim to an event is not a report.

**I5 · Fail-open.** A rule that throws is reported in `errors` and skipped. An
observer must never take the run down with it.

---

## 3. Time: aggregates in facts, windows in rules

The first draft of this document said "facts absorb time; rules stay
predicates", on the reasoning that a window in the language would need mutable
state and break replay. That was half right, and the wrong half cost the
feature users actually asked for — *"five failures inside two minutes"* cannot be
expressed by a whole-run aggregate.

The correction: **a window over a finite slice, anchored to an explicit clock, is
still a pure function.** State was never the problem; a *hidden* clock was.

So time is split in two:

| Kind of time | Example | Lives in | Cost |
|---|---|---|---|
| whole-run aggregate | longest streak, total failures per command, reverts per file, process lifetime | **facts** (computed once) | O(n) once per run |
| relative to a moment | "3 failures in the last 10s", "no activity for 2 minutes", "gap between first and last failure" | **window** (computed on demand) | O(n) per evaluation, throttled |

The contract is one line:

```
anchor = context.anchor ?? live.nowMs ?? run.endedAt ?? facts.lastActivityAt
```

Every window is measured against `anchor`. Chart never reads a clock:

- **live**: the host passes a fresh `nowMs` each tick, so windows slide;
- **settled**: the anchor is the run's last moment;
- **simulate**: the anchor is whatever the caller passes, so the answer is
  reproducible.

### The ladder, and where it stops

| Rung | Capability | Example | Cost | Status |
|---|---|---|---|---|
| 0 | aggregate | total failures | none | facts |
| 1 | windowed measure | five failures in two minutes | one scan | `window` |
| 2 | **bounded sequence** | failed → recovered → failed again, within 30 events | one *bounded* scan | `sequence` |
| 3 | event-stream regex | `(fail ok)* fail`, quantifiers on groups | grammar, validation, UI and explanation all expand | rejected |
| 4 | temporal logic | LTL, automata | no longer a rule a human reads | rejected |

Rung 2 is the first rung where *order* matters, and it pays for itself: "the fix
did not hold" is the most common thing a person wants to know about an agent,
and it cannot be expressed by a count (a count cannot see the success in
between) or by a window (a window has no order).

Three guard rails keep it from becoming rung 3:

1. **Steps are a flat list.** A step's `where` holds field conditions only — no
   window, no sequence, no quantifier inside.
2. **Every gap is bounded** (`maxEvents` + `maxMs`), so matching is a bounded
   scan rather than a search.
3. **Leftmost, non-overlapping, counted.** The answer is a number plus event ids,
   never a set of possible alignments.

The consequence worth stating: **"flapping" is a rule, not a fact.** If it were
`facts.flaps`, every new pattern would need a code change — exactly the
"pre-build every interface" trap this project exists to avoid.
`example.flapping` is twelve lines of JSON.

What is still banned: nesting a window inside a window's `where`, a sequence
inside a `where`, and any construct whose answer depends on evaluation order.

The fact layer also keeps the cheap aggregates (`facts.failureStreak`,
`facts.retries`, `facts.reverts`) even though a window could compute them: they
are O(1) to read, and the default pack must stay cheap. A window is the general
escape hatch; a fact is the fast path.

## 4. Why there is no action layer

Chart produces findings. It cannot `allow`, `deny`, `abort`, `pause`, or POST to
a webhook. This is not an oversight; it is the only way to keep three things:

**Replay.** An engine that acts cannot be re-run over history without repeating
the acts. The moment `deny` exists, "what would my new rule have said about
yesterday's run?" becomes a question you must not ask.

**Neutrality.** "It never drives or stops the agent" is a product promise. The
value of an observer is that its verdict is not self-interested. A component
that both observes and enforces is a component whose observations are suspect —
and it inherits every failure mode of enforcement: the model retrying around a
denial, a deadlock on a paused tool call, an outage taking the agent down with it.

**Comparability.** A run judged by rules is a data point. A run steered by rules
is an experiment with a confounding variable. Cross-run baselines (the next
feature) only work on the former.

So when the question is "should Chart block `find /`?", the answer is: no —
Absence already owns the shell (`process/AbsenceShell.ts`) and can block it
there, in five lines, if that is ever wanted. Chart's job is to *notice* and to
*explain*, not to intervene. `docs/RULES.md` has the example rule that reports a
root search; the report says what happened, and the human decides.

---

## 5. Three modes, never confused

This is the part that has to be unambiguous, because it is the difference between
a report you can trust and a report that quietly rewrites the past.

| Mode | Input | Output | Recorded? |
|---|---|---|---|
| **observe** (live) | events | findings, judged now | **yes** |
| **replay** | events + the **recorded** findings | the report as it was | no — read-only |
| **simulate** | events + any pack + an explicit anchor | hypothetical findings | **never**; labelled `hypothetical: true` |

The rule is: **findings are recorded, not recomputed.** A run that had no rule
configured at the time shows no such finding today, no matter what the current
pack says. The record stores the findings plus `packHash` (a content hash of the
pack that judged them), so "why did this say high?" is always answerable.

Facts, by contrast, *are* recomputed on replay — safely, and only because
`buildFacts(events, run)` takes no options. That decision was made in §1 for
another reason and turned out to be what makes a faithful replay possible at all.

`simulate` exists for exactly one purpose: the rule editor's "what would this
have said?" button. It is a hypothetical, and the type system says so.

### The record is a hash chain

Because findings are recorded rather than recomputed, the record is the most
attackable part of the system: if it can be edited quietly, every past report is
a lie and nothing notices.

So each record carries the digest of the previous one plus its own content
(`src/regimen/record.ts`). Editing a record, reordering two, inserting a forged
one or deleting one breaks the chain from that point, and `verifyChain` says
where. Changing a verdict after the fact is caught by the same mechanism, because
the verdict is part of the digested body.

The strength is worth being honest about: a 128-bit non-cryptographic digest over
canonical JSON. It detects corruption and casual tampering, not an attacker who
can rewrite the whole log — that needs a keyed HMAC and a key the log cannot
reach. The point is that silence stops being an option: a doctored report leaves
a broken chain, and `packHash` names the pack that judged it.

This is borrowed from the reference-monitor literature (`docs/PRIOR-ART.md`),
where an append-only hash-chained audit log is the norm — and where the posture is
the opposite of ours on one point: they *fail closed* on audit (no log, no
action), while a rule engine must *fail open* (a broken rule must not hide the
run). Chart keeps fail-open for rules and takes the chain for the record.

## 6. The three contracts

### 6.1 Facts

A plain object (`src/core/types.ts`). Paths are public API: `facts.commands.failed`,
`facts.files.created`, `facts.processes.runningAtEnd`, `facts.failureStreak.count`,
`facts.reverts[*].count`. Rules and report specs both address facts by path, so a
field rename is a breaking change for user packs — treat the fact schema as a
versioned surface.

### 6.2 Rules

```ts
interface Rule {
  id: string;
  phase?: "live" | "settled" | "both";   // default "both"
  priority?: number;                      // higher first; ties keep file order
  when: { combinator?: "all" | "any"; conditions: Condition[] };  // flat
  emit: { level, title, detail?, tags?, evidence?, reason? };
  cooldownMs?: number;    // live only; state is the caller's
  suppresses?: string[];  // ids this rule silences when it fires
  enabled?: boolean;
}

type Condition =
  | { field: string; op: ScalarOp; value?: JsonValue }                 // compare
  | { field: string; quant: "any"|"all"|"none"|"count"; … }            // quantify
  | { window: WindowSpec };                                            // scan the stream
```

`Condition` is the whole language: three leaf forms, one level. A `where` filter
holds only the first form, so nothing can nest.

Evaluation is **all-match**, not first-match: this is a lens, not a firewall, so
every matching rule contributes a finding and the verdict is the loudest of them.
`level: "none"` means the rule is off (Absence's "silent"), which is how a user
disables a default without deleting it.

### 6.3 Reports

A spec is a list of sections; a section is a source path plus a template. The
renderer returns `RenderedReport` — a document model of strings and arrays. The
host owns styling. `renderText()` is a convenience for CLI and tests.

---

## 7. Parity with Absence v0.4

The default pack is `computeAttention`, rewritten as data. The `else if` chain
became predicates with the exclusivity written into them, because rules run in
parallel:

| Absence branch | Chart rule | phase |
|---|---|---|
| `ended && runError` → `agent_stopped` | `run.agent-stopped` | settled |
| `unresolved > 0 && needsYou && ended` → `unresolved_error` | `run.unresolved-error` | settled |
| `unresolved > 0 && needsYou && !ended` (busy false) | `run.unresolved-error-while-waiting` | live |
| `unresolved == 0 && failed >= 5` → `command_failed` | `run.commands-failed-recovered` | settled |
| `unresolved > 0 && !needsYou && failed >= 5` → `command_failed` | `run.commands-failed-midrun` | live |
| `unresolved == 0 && failed < 5 && errors > 0` → capped medium | `run.error-event` | settled |
| `streak >= 3` | `run.failure-streak` | both |
| `stalled >= 3600` | `run.stalled` | live |
| `ended && leftovers > 0` | `run.leftover-eggs` | settled |
| `outside > 0` | `run.outside-change` | settled |
| `reverts >= 1` | `run.file-version-loop` | settled |
| `retries >= 2` | `run.command-retry-loop` | both |

`needsYou` is `ended || busy === false`; the two unresolved rules are that
predicate split across the two phases. The old `else if` chain's *ordering* is
written into the conditions instead of implied by control flow — read
`run.commands-failed-midrun`, which carries `ended == false` and `busy != false`
so it can never speak at the same time as the unresolved rule.

`test/defaults.test.ts` is the parity suite: every branch, including the
exclusivity (five unresolved failures must produce `unresolved_error` and *not*
`command_failed`) and the cap (a bare error event is medium even though
`unresolved_error` defaults to high).

One difference is intentional and worth knowing: Absence filters `loops` and
`runningAtEnd` by the user's thresholds *inside* the builder, so its facts change
with settings. Chart keeps them raw and filters in rules. That is the point of
the whole exercise, but it means `facts.processes.runningAtEnd` may be larger
than what Absence would have reported.

---

## 8. Folding it into Absence

Four phases, each shippable.

**Phase 1 — side by side (no user-visible change).**
Add `packages/chart` (or `apps/chart`) to the workspace. In `apps/web`, compute
both verdicts on every settled run and assert they agree; add
`scripts/checks/check-parity.ts` that replays archived sessions through both.
Nothing renders differently. This is the phase that finds the edge cases.

**Phase 2 — the report reads Chart.**
Point `ReportOverlay` at `renderReport(SETTLED_REPORT, …)` and the chime hook at
`attention.level`. Keep `renderRun` around for one release as a fallback.
The live view switches to `LIVE_REPORT`.

**Phase 3 — delete the old engine.**
Remove `computeAttention`, `loopAttentionFor`, `countsAsLeftoverProcess`,
`ignoredOutsidePath`, `renderLive`, `renderRun` and the `ReportAttentionOptions`
type. `buildRunFacts` collapses into Chart's `buildFacts`. `types/report.ts`
keeps only what the UI genuinely needs.

**Phase 4 — settings become rules.**
The REPORT WARN pane's five groups are the default pack's five sections. Store
packs as files next to `apps/server/src/process/egg-filters/` (same profile
pattern: `rules/<name>.json` + `active.json`), and give the pane a JSON editor
(Monaco is already in the app) plus a **dry-run against the selected run** button
— that button is what makes custom rules usable rather than mysterious.

Two things stay in Absence, not Chart: the **delivery** of a finding (chime,
notification, desktop tray) and the **UI** that renders the document model.
Chart deliberately has neither.

---

## 9. Where the next value is

Ranked by what only a pure observer can do (see the project discussion):

1. **Claim vs reality.** The transcript says "I ran the tests"; the command
   record does not. `example.claims-without-evidence` is a first cut. This needs
   no new engine — only more facts (the reply's claims, cross-referenced with
   commands) and is impossible for a SaaS tracer that only sees the agent's own
   telemetry.
2. **Cross-run baselines.** "This run took 3× the median for this task type."
   Needs a second layer: `facts` per run → an aggregate over runs → a fact
   (`baseline.durationRatio`) that rules can read. Still pure, still replayable.
3. **Metrics windows.** `live.metrics` is a snapshot today. A `facts.metrics`
   with per-egg peak/mean would let rules express "burned CPU for a minute"
   without a clock in the language.
4. **Report diffing.** Two `RenderedReport`s for two runs of the same task; a
   structural diff is a one-page "what changed this time" — again only possible
   because the document is data.

All four are additive. None requires an action layer.
