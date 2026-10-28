# Contributing

## Commit messages

The subject line is `type(scope): what changed`, in the imperative, lower case
after the colon. A body explains *why* — the bug, the mistake, the thing that was
wrong before — because the diff already says what.

### Types

| Type | For |
|---|---|
| `feat` | a new capability, in the engine or the UI |
| `fix` | a defect: something that was wrong and now is not |
| `refactor` | same behaviour, better structure |
| `docs` | documentation only |
| `test` | checks only |
| `chore` | tooling, dependencies, housekeeping |
| **`ui`** | **presentation, layout, wording, controls — see below** |

### `ui` — the catch-all for presentation work

**From here on, anything that changes how the editor looks, reads or responds is
`ui`,** not `feat` or `fix`. That covers layout, spacing, colours, control shape
and placement, copy, and the wording of a label or hint.

The reason is that these changes are not features and are not defects: the
capability already existed and the defect was often just introduced by the
previous presentation change. Filing them as `feat` inflates the log with
"added a button", and filing them as `fix` pretends a bug existed where the
truth is usually "the first version of the layout was wrong". `ui` says exactly
what happened.

Use a scope when it helps: `ui(web)`, `ui(report)`, `ui(rules)`.

```
ui(web): the ✕ is a column, not an overlay
ui(web): 监护报告 only displays
ui: one built-in report, no example pack
```

`fix` is still right when the change repairs behaviour rather than appearance —
a wrong number, a lost edit, a control that does not do what it says. The line:
**if the user would notice by looking, it is `ui`; if they would notice by
doing, it is `fix`.**

### Two things a commit message must carry

- **The mistake, not just the repair.** "`height: 100%` only resolves against a
  definite parent height" is worth more than "fixed the button".
- **The measurement.** This project's UI work is verified in a browser; say what
  was measured (`card 96 / ✕ 82 / grip 82`) so the next person can re-check it.

## Checks

`npm run check` must pass. A UI change does not need a new engine check, but it
does need to be looked at: start `npm run web`, and state in the commit what you
saw.
