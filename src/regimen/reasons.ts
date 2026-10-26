/**
 * The reason vocabulary — a closed set, on purpose.
 *
 * A finding's `reason` is the machine-readable key: it is what a report shows
 * next to a level, what the chime hook reads, and what makes two runs comparable
 * across time and across pack versions ("last time this didn't fire — why?").
 * If any rule could invent a reason, none of that would hold.
 *
 * So the reserved set below is **closed**: it is exactly Absence's
 * `AttentionReason` union, because Chart's default pack reproduces Absence's
 * verdicts and a shared vocabulary is what lets the parity check compare them.
 *
 * User rules still need their own keys, so the rule is:
 *
 *   · a reserved slug (`command_failed`), or
 *   · a namespaced slug (`user.flapping`, `my-pack.flapping`) — at least one
 *     dot, lower-case, so it can never collide with a reserved name.
 *
 * This is the ACS "reserved reasons" idea: the engine owns the vocabulary,
 * the user extends it in their own namespace.
 */

/** The reserved reasons. Changing this list is a breaking change for reports. */
export const RESERVED_REASONS = [
  "agent_stopped",
  "unresolved_error",
  "command_failed",
  "command_failure_streak",
  "activity_stalled",
  "process_left_running",
  "outside_change",
  "file_version_loop",
  "command_retry_loop",
  "agent_waiting",
  "no_progress",
  "external_change",
] as const;

export type ReservedReason = (typeof RESERVED_REASONS)[number];

/** What each reserved reason means, for a UI that has to explain a verdict. */
export const REASON_LABELS: Record<ReservedReason, string> = {
  agent_stopped: "The run ended in error rather than finishing its task.",
  unresolved_error: "A failure nothing recovered from.",
  command_failed: "Commands failed in this run.",
  command_failure_streak: "Commands failed back to back with no success between them.",
  activity_stalled: "Nothing happened for a long time while the run was live.",
  process_left_running: "A process the agent laid is still alive after the run.",
  outside_change: "A watched change outside the project root.",
  file_version_loop: "A file went back to a state it already had.",
  command_retry_loop: "One identical command kept failing.",
  agent_waiting: "The runtime is blocked on the user.",
  no_progress: "Activity, but nothing changed.",
  external_change: "Something other than the agent changed a file.",
};

const NAMESPACED = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Whether a string is one of the reserved reasons. */
export function isReservedReason(value: string): value is ReservedReason {
  return (RESERVED_REASONS as readonly string[]).includes(value);
}

/** Whether a string is a namespaced user reason (`user.flapping`). */
export function isNamespacedReason(value: string): boolean {
  return !isReservedReason(value) && NAMESPACED.test(value);
}

/** Whether a rule may use this string as its `emit.reason`. */
export function isValidReason(value: string): boolean {
  return isReservedReason(value) || isNamespacedReason(value);
}

/** The reason a rule reports: its own, or its id when it does not name one. */
export function reasonFor(rule: { id: string; emit: { reason?: string } }): string {
  return rule.emit.reason ?? rule.id;
}

/**
 * The stable machine key for a finding.
 *
 * Reserved reasons pass through; a namespaced one keeps its namespace; anything
 * else (a bare rule id like `run.agent-stopped`) is namespaced under `custom.`
 * so a report never contains an unclassified key.
 */
export function normalizeReason(value: string): string {
  if (isReservedReason(value)) return value;
  if (isNamespacedReason(value)) return value;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom.${slug || "unnamed"}`;
}
