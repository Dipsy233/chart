/**
 * The verdict a run gets, from measurements only.
 *
 * Absence computes this inside its fact builder; here it is a separate, pure
 * derivation so the facts stay a pure record of what happened. It uses no user
 * setting — every input is a count or a status — so a replayed run always gets
 * the same outcome.
 */

import type { Facts, RunOutcome } from "../core/types.ts";

export function deriveOutcome(facts: Facts): RunOutcome {
  if (facts.run.status === "interrupted") return "stopped";
  if (facts.run.status === "error") return "failed";
  if (facts.unresolved.length > 0) return "failed";
  if (facts.commands.failed > 0) return "completed_with_warnings";
  const changed =
    facts.files.created.length +
    facts.files.modified.length +
    facts.files.deleted.length +
    facts.files.observed.length;
  if (changed === 0) return "no_change";
  return "completed";
}

/** One sentence for the outcome, in the observer's voice. */
export function outcomeHeadline(facts: Facts, outcome: RunOutcome): string {
  switch (outcome) {
    case "failed":
      return facts.run.status === "error"
        ? "The agent stopped with an error."
        : "The run left failures nothing recovered from.";
    case "stopped":
      return "The agent stopped before finishing.";
    case "no_change":
      return "No project changes were made.";
    case "completed_with_warnings":
      return "The agent completed, with warnings.";
    case "completed":
      if (facts.recoveries.length > 0) return "The agent completed after recovering from an error.";
      return "The agent completed the run.";
  }
}
