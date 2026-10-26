/**
 * The default pack — Chart's judgement of a run, before anyone edits anything.
 *
 * This is Absence v0.4's `computeAttention`, expressed as data instead of
 * branches. Same reasons, same levels, same thresholds, same exclusivity, so
 * swapping the engine in changes no verdict. Every number here is what the
 * settings dialog used to expose; now it is a line in a rule the user can edit.
 *
 * Two things to read carefully:
 *
 *   1. **Exclusivity is written into the conditions.** The old code was an
 *      `else if` chain: an unresolved failure at rest outranks the plain failure
 *      count, and the "bare error event" branch is only reachable when neither
 *      fired. Rules run in parallel here, so each rule carries the negation that
 *      made it exclusive in the chain — read `run.commands-failed`.
 *
 *   2. **`phase` is the live/settled split the old code implied.** A leftover
 *      process is only meaningful once the run has settled; a stall is only
 *      meaningful while it is live. The old engine got that from which branch
 *      read which input; now it is a field.
 */

import type { Rule, RulePack } from "./rule.ts";

/** `not needsYou` — still running, and not waiting on the user. */
const stillWorking = (): Rule["when"]["conditions"] => [
  { field: "facts.ended", op: "eq", value: false },
  { field: "live.busy", op: "ne", value: false },
];

export const DEFAULT_PACK: RulePack = {
  version: 1,
  name: "Chart defaults",
  rules: [
    {
      id: "run.agent-stopped",
      name: "Agent stopped with an error",
      description: "The run ended in error rather than finishing its task.",
      source: "default",
      phase: "settled",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.run.status", op: "eq", value: "error" },
        ],
      },
      emit: {
        reason: "agent_stopped",
        level: "high",
        title: "The agent stopped with an error",
        detail: "A run that dies outright is never ordinary; read the last command and the agent's reply.",
        tags: ["run", "failure"],
      },
    },
    {
      id: "run.unresolved-error",
      name: "Unresolved error at rest",
      description:
        "A failure nothing recovered from, on a run that has settled or is visibly waiting for the user.",
      source: "default",
      phase: "settled",
      priority: 10,
      when: {
        conditions: [
          { field: "facts.unresolved", op: "nonEmpty" },
          { field: "facts.ended", op: "eq", value: true },
        ],
      },
      emit: {
        reason: "unresolved_error",
        level: "high",
        title: "{{facts.unresolved|plural:failure}} with no recovery",
        detail: "No later command succeeded and nothing was edited after the failure.",
        tags: ["failure"],
        evidence: ["facts.unresolved"],
      },
    },
    {
      id: "run.unresolved-error-while-waiting",
      name: "Unresolved error while the agent waits",
      description: "The same verdict, for a live run whose agent is blocked on the user.",
      source: "default",
      phase: "live",
      priority: 10,
      when: {
        conditions: [
          { field: "facts.unresolved", op: "nonEmpty" },
          { field: "live.busy", op: "eq", value: false },
        ],
      },
      emit: {
        reason: "unresolved_error",
        level: "high",
        title: "{{facts.unresolved|plural:failure}} with no recovery",
        detail: "No later command succeeded and nothing was edited after the failure.",
        tags: ["failure"],
        evidence: ["facts.unresolved"],
      },
    },
    {
      id: "run.commands-failed-recovered",
      name: "Failed commands, all recovered",
      description: "Five or more failures, but every one of them was followed by success or an edit.",
      source: "default",
      phase: "settled",
      when: {
        conditions: [
          { field: "facts.unresolved", op: "empty" },
          { field: "facts.commands.failed", op: "gte", value: 5 },
        ],
      },
      emit: {
        reason: "command_failed",
        level: "low",
        title: "{{facts.commands.failed|plural:command}} failed in this run",
        tags: ["commands"],
        evidence: ["facts.failed"],
      },
    },
    {
      id: "run.commands-failed-midrun",
      name: "Failed commands over the threshold, mid-run",
      description: "The live half of the count rule: over the bar while the agent is still working.",
      source: "default",
      phase: "live",
      when: {
        conditions: [
          { field: "facts.unresolved", op: "nonEmpty" },
          ...stillWorking(),
          { field: "facts.commands.failed", op: "gte", value: 5 },
        ],
      },
      emit: {
        reason: "command_failed",
        level: "low",
        title: "{{facts.commands.failed|plural:command}} failed so far",
        tags: ["commands"],
        evidence: ["facts.failed"],
      },
    },
    {
      id: "run.error-event",
      name: "A bare error event",
      description:
        "An `error` event with no failed command behind it — the weaker signal, capped at medium by default.",
      source: "default",
      phase: "settled",
      when: {
        conditions: [
          { field: "facts.unresolved", op: "empty" },
          { field: "facts.commands.failed", op: "lt", value: 5 },
          { field: "facts.errors.total", op: "gt", value: 0 },
        ],
      },
      emit: {
        reason: "unresolved_error",
        level: "medium",
        title: "{{facts.errors.total|plural:error}} with no failed command behind {{facts.errors.total|bool:it,them}}",
        detail: "Capped at medium: a bare error event is the weaker of the two failure signals.",
        tags: ["failure"],
        evidence: ["facts.errors.evidence"],
      },
    },
    {
      id: "run.failure-streak",
      name: "Back-to-back failures",
      description:
        "Three commands failed in a row with no success between them: the agent may be flailing. Judged in both phases.",
      source: "default",
      phase: "both",
      when: {
        conditions: [{ field: "facts.failureStreak.count", op: "gte", value: 3 }],
      },
      emit: {
        reason: "command_failure_streak",
        level: "medium",
        title: "{{facts.failureStreak.count}} commands failed back to back",
        tags: ["commands", "loop"],
        evidence: ["facts.failureStreak.evidence"],
      },
    },
    {
      id: "run.stalled",
      name: "No activity for an hour",
      description:
        "Nothing at all for 3600s while the run is live: a hung command or a wedged prompt. Only meaningful live, so `live.stalledSeconds` is absent on a settled run.",
      source: "default",
      phase: "live",
      when: {
        conditions: [{ field: "live.stalledSeconds", op: "gte", value: 3600 }],
      },
      emit: {
        reason: "activity_stalled",
        level: "medium",
        title: "No activity for {{live.stalledSeconds|secs}}",
        detail: "The run is still live but nothing has happened for a long time.",
        tags: ["run", "stall"],
      },
    },
    {
      id: "run.leftover-eggs",
      name: "A process left running",
      description:
        "A primary process the agent laid is still alive after the run ended. Chart reports every one; add a `where` clause on `lifetimeMs` or a name list to skip helpers.",
      source: "default",
      phase: "settled",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.processes.runningAtEnd", quant: "count", op: "gte", value: 1 },
        ],
      },
      emit: {
        reason: "process_left_running",
        level: "high",
        title: "{{facts.processes.runningAtEnd|count|plural:process}} still running after the run",
        detail: "Something the agent laid is alive and unwatched.",
        tags: ["process"],
        evidence: ["facts.processes.runningAtEnd"],
      },
    },
    {
      id: "run.outside-change",
      name: "A change outside the project",
      description:
        "A watcher change outside the project root — rare, never the agent's business, usually explainable. Add an ignore list by narrowing the condition.",
      source: "default",
      phase: "settled",
      when: {
        conditions: [{ field: "facts.outsideChanges", quant: "count", op: "gte", value: 1 }],
      },
      emit: {
        reason: "outside_change",
        level: "low",
        title: "{{facts.outsideChanges|count|plural:change}} outside the project",
        tags: ["files", "outside"],
        evidence: ["facts.outsideChanges"],
      },
    },
    {
      id: "run.file-version-loop",
      name: "A file reverted to an earlier version",
      description: "The agent wrote a path back to a state it already held: it undid its own work.",
      source: "default",
      phase: "settled",
      when: {
        conditions: [{ field: "facts.reverts", quant: "count", op: "gte", value: 1 }],
      },
      emit: {
        reason: "file_version_loop",
        level: "medium",
        title: "{{facts.reverts|count|plural:file}} reverted to an earlier version",
        detail: "A revert means the agent changed a file and then changed it back, or wrote what it started with.",
        tags: ["files", "loop"],
        evidence: ["facts.reverts"],
      },
    },
    {
      id: "run.command-retry-loop",
      name: "The same command kept failing",
      description:
        "One identical command failed twice or more: the agent is stuck, not unlucky. Judged in both phases.",
      source: "default",
      phase: "both",
      when: {
        conditions: [
          {
            field: "facts.retries",
            quant: "count",
            op: "gte",
            value: 1,
            where: { conditions: [{ field: "count", op: "gte", value: 2 }] },
          },
        ],
      },
      emit: {
        reason: "command_retry_loop",
        level: "medium",
        title: "{{facts.retries|count|plural:command}} kept failing",
        tags: ["commands", "loop"],
        evidence: ["facts.retries"],
      },
    },
  ],
};

/** A fresh copy, so a caller can mutate its own pack without touching this one. */
export function defaultPack(): RulePack {
  return structuredClone(DEFAULT_PACK);
}
