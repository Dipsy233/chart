/**
 * Illustrative user rules — not part of the default pack, and not evaluated
 * unless a caller opts in. They are the examples the rule reference documents,
 * and what the checks exercise when they need rules the defaults lack.
 *
 * Every one is a *lens*, not an action: Chart has no `allow`, `deny`, `abort`
 * or webhook. That is the design (see docs/DESIGN.md), and it is why these can
 * be judged against last week's recorded runs.
 */

import type { RulePack } from "./rule.ts";

export const EXAMPLE_PACK: RulePack = {
  version: 1,
  name: "Examples",
  rules: [
    {
      id: "example.env-touched",
      name: "The agent touched an env file",
      description: "Credentials live in .env; reading or rewriting one is usually the start of an incident.",
      source: "user",
      when: {
        combinator: "all",
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          {
            field: "facts.files.byPath",
            quant: "count",
            op: "gte",
            value: 1,
            where: { conditions: [{ field: "path", op: "glob", value: "**/.env*" }] },
          },
        ],
      },
      emit: {
        level: "high",
        title: "An env file was touched",
        detail: "A .env path was read or written.",
        tags: ["security"],
        evidence: ["facts.files.byPath"],
      },
    },
    {
      // The same idea through the shell. Two rules, not one `any` with an `ended`
      // gate: `(A or B) and C` is always two rules in a flat language, and keeping
      // it that way is what makes each of these readable as one sentence.
      id: "example.env-printed",
      name: "The agent printed the environment",
      description: "`printenv` / `env` dumps every credential in the shell to the transcript.",
      source: "user",
      when: {
        combinator: "all",
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          {
            field: "facts.commandFacts",
            quant: "any",
            where: { conditions: [{ field: "command", op: "matches", value: "\\b(printenv|env)\\b" }] },
          },
        ],
      },
      emit: {
        level: "high",
        title: "The shell printed the environment",
        detail: "Either a .env path was read or written, or the shell printed the environment.",
        tags: ["security"],
        evidence: ["facts.commandFacts"],
      },
    },
    {
      id: "example.deliverable",
      name: "A deliverable landed",
      description:
        "A report the user asked for appeared in the output folder — tell them they can read it while the agent keeps working.",
      source: "user",
      when: {
        combinator: "any",
        conditions: [
          { field: "facts.files.created", op: "glob", value: "company/**/*.txt" },
          { field: "facts.files.created", op: "glob", value: "company/**/*.md" },
        ],
      },
      emit: {
        level: "low",
        title: 'A deliverable is ready to read: {{facts.files.created|join: ", "}}',
        detail: "The agent is still working; this is a checkpoint, not the end of the run.",
        tags: ["deliverable"],
        evidence: ["facts.files.created"],
      },
    },
    {
      id: "example.root-search",
      name: "Searching from the filesystem root",
      description: "`find /` walks the whole machine. Observed only — Chart never blocks it.",
      source: "user",
      when: {
        conditions: [
          {
            window: {
              events: {
                type: ["command"],
                where: {
                  conditions: [
                    { field: "payload.command", op: "matches", value: "^\\s*(find|du|grep|rg)\\s+/(\\s|$)" },
                  ],
                },
              },
              measure: "count",
              op: "gte",
              value: 1,
            },
          },
        ],
      },
      emit: {
        level: "medium",
        title: "The agent searched from /",
        detail: "Wide, slow, and usually a mistake. Chart reports it; it does not stop it.",
        tags: ["security", "commands"],
        evidence: ["window.ids"],
      },
    },
    {
      id: "example.five-failures-in-two-minutes",
      name: "Five failures inside two minutes",
      description:
        "The classic: a burst of failures is a stuck agent, while the same five spread over an hour is a normal afternoon.",
      source: "user",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: false },
          {
            window: {
              events: {
                type: ["command"],
                where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] },
              },
              span: { lastMs: 120_000 },
              measure: "count",
              op: "gte",
              value: 5,
            },
          },
        ],
      },
      emit: {
        level: "high",
        title: "{{vars.window.count}} commands failed in the last 2 minutes",
        detail: "A burst, not bad luck. The agent is probably stuck on the same obstacle.",
        tags: ["commands"],
        evidence: ["window.ids"],
      },
    },
    {
      id: "example.flapping",
      name: "The fix did not hold",
      description:
        "The same command failed, then succeeded, then failed again inside ten minutes: a sequence a count cannot see, because a count cannot notice the success in between. This is what `sequence` is for — and why \"flapping\" is a rule, not a fact the engine has to know about.",
      source: "user",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          {
            sequence: {
              steps: [
                {
                  type: ["command"],
                  where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] },
                  as: "failed",
                },
                {
                  type: ["command"],
                  where: { conditions: [{ field: "payload.exitCode", op: "eq", value: 0 }] },
                  as: "recovered",
                },
                {
                  type: ["command"],
                  where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] },
                  as: "brokeAgain",
                },
              ],
              gap: { maxEvents: 30, maxMs: 600_000 },
            },
          },
        ],
      },
      emit: {
        level: "medium",
        title: "A failure came back after a success",
        detail:
          "Failed, recovered, then failed again within ten minutes and thirty events: the fix did not hold.",
        tags: ["commands", "loop"],
        evidence: ["sequence.ids"],
      },
    },
    {
      id: "example.claims-without-evidence",
      name: "The agent says it did something the observer cannot see",
      description:
        "The reply mentions tests, but no test-shaped command ran. Only an observer holding both the transcript and the OS record can offer this.",
      source: "user",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: true },
          { field: "facts.response", op: "matches", value: "(?i)\\b(tests?|test suite|specs?)\\b" },
          {
            window: {
              events: {
                type: ["command"],
                where: {
                  conditions: [
                    {
                      field: "payload.command",
                      op: "matches",
                      value: "(?i)\\b(test|vitest|jest|pytest|go test|cargo test|npm run test)\\b",
                    },
                  ],
                },
              },
              measure: "count",
              op: "eq",
              value: 0,
            },
          },
        ],
      },
      emit: {
        level: "medium",
        title: "The reply mentions tests, but no test command ran",
        detail: "The transcript claims it; the command record does not show it.",
        tags: ["claims", "trust"],
        evidence: ["window.ids"],
      },
    },
    {
      id: "example.cpu-hot",
      name: "An egg is burning CPU",
      description:
        "Needs a metrics snapshot in the live context. Sustained CPU above 90% for a minute is what a laptop user wants to hear about.",
      source: "user",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: false },
          {
            field: "live.metrics.eggs",
            quant: "any",
            where: { conditions: [{ field: "cpuPercent", op: "gte", value: 90 }] },
          },
          { field: "live.elapsedSeconds", op: "gte", value: 60 },
        ],
      },
      emit: {
        level: "low",
        title: "A process the agent laid is using a lot of CPU",
        detail: "Reported from the sampler's snapshot; Chart never throttles it.",
        tags: ["resources"],
        evidence: ["facts.processes.primary"],
      },
    },
    {
      id: "example.memory-hog",
      name: "An egg is eating memory",
      description:
        "RSS is a gauge, so this is a level check, not a rate: 1 GiB in one process the agent started is worth a look.",
      source: "user",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: false },
          {
            field: "live.metrics.eggs",
            quant: "any",
            where: {
              conditions: [
                { field: "rssBytes", op: "gte", value: 1024 * 1024 * 1024 },
                { field: "status", op: "eq", value: "running" },
              ],
            },
          },
        ],
      },
      emit: {
        level: "medium",
        title: "A running process is holding more than 1 GiB",
        detail: "Bytes, not a percentage: a leak on a 64 GiB machine is still a leak.",
        tags: ["resources", "memory"],
        evidence: ["facts.processes.primary"],
      },
    },
    {
      // The host is a *different* subject from the eggs: 85% of the machine is
      // an incident even when no single egg is hot, and a rule that says "host"
      // must not be written as "any egg".
      id: "example.host-saturated",
      name: "The machine itself is saturated",
      description:
        "Host CPU and memory come from the same sampler, so a run can be told its laptop was already busy before it started.",
      source: "user",
      when: {
        combinator: "any",
        conditions: [
          { field: "live.metrics.host.cpuPercent", op: "gte", value: 85 },
          { field: "live.metrics.host.memPercent", op: "gte", value: 92 },
        ],
      },
      emit: {
        level: "low",
        title: "The host was at {{live.metrics.host.cpuPercent|percent}} CPU / {{live.metrics.host.memPercent|percent}} memory",
        detail: "A slow run on a saturated machine is not the agent's fault — but it is worth knowing.",
        tags: ["resources", "host"],
        evidence: ["facts.evidence"],
      },
    },
    {
      // Averages, not the instantaneous sample: a burst is `cpuPercent`, a
      // process that has been hot for the whole session is `avgCpuPercent`.
      id: "example.sustained-load",
      name: "One process has been hot all session",
      description:
        "`avgCpuPercent` is the session-to-date average the sampler maintains, so this cannot be a one-frame spike.",
      source: "user",
      when: {
        conditions: [
          { field: "facts.ended", op: "eq", value: false },
          { field: "live.elapsedSeconds", op: "gte", value: 120 },
          {
            field: "live.metrics.eggs",
            quant: "any",
            where: { conditions: [{ field: "avgCpuPercent", op: "gte", value: 50 }] },
          },
        ],
      },
      emit: {
        level: "medium",
        title: "A process has averaged {{live.metrics.eggs.0.avgCpuPercent|percent}} CPU for this session",
        detail: "Sustained load, not a spike — the difference between a busy build and a runaway loop.",
        tags: ["resources"],
        evidence: ["facts.processes.primary"],
      },
    },
  ],
};

export function examplePack(): RulePack {
  return structuredClone(EXAMPLE_PACK);
}
