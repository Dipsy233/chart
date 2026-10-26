/**
 * A demo you can read: `npm run demo`.
 *
 * The story is the one Chart was designed for — an agent researching a company,
 * leaving deliverables in `company/`, running long, failing twice on the way.
 * Nothing here is special-cased: the events are the same shapes Absence emits,
 * the rules are the default pack plus the examples, and the report is a spec.
 *
 * It also shows the three modes:
 *   settled  — what the rules say about a finished run
 *   live     — what they say while it is still going
 *   replay   — the record, rendered without touching a rule
 */

import { mkdir, writeFile } from "node:fs/promises";
import {
  DEFAULT_PACK,
  EXAMPLE_PACK,
  LIVE_REPORT,
  SETTLED_REPORT,
  mergePacks,
  observe,
  record,
  replayText,
  reportText,
  simulate,
  type ChartEvent,
  type FindingRecord,
} from "../src/index.ts";

// Two hours ago, so `--now` with a real clock reads sensibly.
let clock = Date.now() - 2 * 60 * 60_000;
let counter = 0;

function event(type: ChartEvent["type"], payload: unknown): ChartEvent {
  clock += 4_000 + Math.round(Math.random() * 3_000);
  return { id: `evt_${++counter}`, sessionId: "demo", timestamp: clock, type, payload } as ChartEvent;
}

const events: ChartEvent[] = [
  event("agent_start", { model: "qwen3-4b" }),
  event("message", { role: "user", content: "Research Acme Corp and put everything in company/" }),
  event("thinking", { content: "I should start with their public filings and pricing page." }),
  event("search", { tool: "grep", query: "acme", matches: 12 }),
  event("file_read", { path: "README.md", startLine: 1, endLine: 20, content: "line\n".repeat(20) }),
  event("command", { command: "curl -s https://acme.example/about", stdout: "…", stderr: "", exitCode: 0 }),
  event("file_write", { path: "company/intro.txt", content: "Acme Corp — company profile\n" }),
  event("message", {
    role: "assistant",
    content: "I've written the company profile to company/intro.txt. Next I'll research pricing.",
  }),
  event("command", { command: "curl -s https://acme.example/pricing", stdout: "", stderr: "timeout", exitCode: 28 }),
  event("command", { command: "curl -s https://acme.example/pricing", stdout: "", stderr: "timeout", exitCode: 28 }),
  event("thinking", { content: "The pricing page times out; try the cached copy." }),
  event("file_write", { path: "company/pricing.md", content: "# Pricing\n" }),
  event("file_change", { path: "../secrets/.env", kind: "modified", outside: true }),
  event("process", {
    pid: 8123,
    name: "node",
    commandLine: "node scraper.mjs",
    command: "node scraper.mjs",
    status: "running",
    startedAt: clock - 20_000,
    children: 2,
    kind: "primary",
  }),
  event("agent_end", { reason: "completed" }),
];

const pack = mergePacks(DEFAULT_PACK, EXAMPLE_PACK);
const last = events[events.length - 1]!.timestamp;

// Write the events out so the CLI can be pointed at a real recorded run:
//   npm run rules -- simulate .chart/demo-events.json --report
await mkdir(".chart", { recursive: true });
await writeFile(".chart/demo-events.json", `${JSON.stringify(events, null, 2)}
`, "utf8");

console.log("═══ default pack · settled ═══\n");
const settled = observe(events, { pack: DEFAULT_PACK, phase: "settled" })!;
console.log(reportText(settled, SETTLED_REPORT));

console.log("\n═══ default + user rules · settled ═══\n");
const judged = observe(events, { pack, phase: "settled" })!;
console.log(reportText(judged, SETTLED_REPORT));

console.log("\n═══ live, five minutes after the last event ═══\n");
const live = observe(events, { pack, phase: "live", live: { nowMs: last + 5 * 60_000, busy: true } })!;
console.log(reportText(live, LIVE_REPORT, { nowMs: last + 5 * 60_000, busy: true }));

console.log("\n═══ replay: the record from the settled pass ═══\n");
const recorded: FindingRecord = record(judged, pack);
const replayed = replayText(recorded, judged.facts, SETTLED_REPORT);
console.log(`recorded by pack ${recorded.packHash} at ${new Date(recorded.anchor).toISOString()}`);
console.log(`${replayed.split("\n").length} lines — identical to the settled report above.`);

console.log("\n═══ simulate: a stricter pack, clearly hypothetical ═══\n");
const stricter = structuredClone(pack);
const streakRule = stricter.rules.find((rule) => rule.id === "run.failure-streak");
if (streakRule) streakRule.when.conditions = [{ field: "facts.commands.failed", op: "gte", value: 2 }];
const hypothetical = simulate(events, stricter)!;
console.log(`hypothetical: ${hypothetical.hypothetical === true}`);
console.log(reportText(hypothetical, SETTLED_REPORT).split("\n").slice(0, 8).join("\n"));
