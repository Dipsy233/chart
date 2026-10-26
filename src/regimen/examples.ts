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
      phase: "settled",
      when: {
        combinator: "any",
        conditions: [
          {
            field: "facts.files.byPath",
            quant: "count",
            op: "gte",
            value: 1,
            where: { conditions: [{ field: "path", op: "glob", value: "**/.env*" }] },
          },
          {
            field: "facts.commandFacts",
            quant: "any",
            where: { conditions: [{ field: "command", op: "matches", value: "\\b(printenv|env)\\b" }] },
          },
        ],
      },
      emit: {
        level: "high",
        title: "An env file was touched",
        detail: "Either a .env path was read or written, or the shell printed the environment.",
        tags: ["security"],
        evidence: ["facts.files.byPath", "facts.commandFacts"],
      },
    },
    {
      id: "example.deliverable",
      name: "A deliverable landed",
      description:
        "A report the user asked for appeared in the output folder — tell them they can read it while the agent keeps working.",
      source: "user",
      phase: "both",
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
      phase: "both",
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
      phase: "live",
      when: {
        conditions: [
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
      phase: "settled",
      when: {
        conditions: [
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
      phase: "settled",
      when: {
        conditions: [
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
      phase: "live",
      when: {
        conditions: [
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
  ],
};

export function examplePack(): RulePack {
  return structuredClone(EXAMPLE_PACK);
}
