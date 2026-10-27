#!/usr/bin/env tsx
/**
 * `chart rules …` — the pack store, from a terminal.
 *
 * This is the reference host for the editor model: everything a UI would do
 * (list packs, validate, activate, preview a rule against a recorded run) is one
 * command here, and the logic lives in `src/store` and `src/editor`, not in this
 * file.
 *
 *   npm run rules -- list
 *   npm run rules -- show work
 *   npm run rules -- create work
 *   npm run rules -- activate work
 *   npm run rules -- validate work
 *   npm run rules -- preview work run.user.flailing events.json
 *   npm run rules -- simulate events.json --pack work --report
 *
 * The store directory is `--dir`, `$CHART_RULES_DIR`, or `.chart/rules`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_PACK,
  LIVE_REPORT,
  SETTLED_REPORT,
  PackInvalidError,
  PackStore,
  eventFields,
  observe,
  parsePack,
  phaseOf,
  previewRule,
  reportText,
  serializePack,
  toChartEvents,
  validatePack,
  describeSequence,
  type ChartEvent,
  type RulePack,
} from "../src/index.ts";
import { fsPackIO } from "../src/store/fs.ts";

/* ── argv ───────────────────────────────────────────────────────────────── */

interface Args {
  command: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      command.push(arg);
    }
  }
  return { command, flags };
}

const args = parseArgs(process.argv.slice(2));
const dir = resolve(
  typeof args.flags["dir"] === "string" ? args.flags["dir"] : process.env.CHART_RULES_DIR ?? ".chart/rules",
);
const store = new PackStore(fsPackIO({ dir }));

/* ── output ─────────────────────────────────────────────────────────────── */

const paint = {
  dim: (text: string) => `\u001b[2m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  red: (text: string) => `\u001b[31m${text}\u001b[0m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[0m`,
  green: (text: string) => `\u001b[32m${text}\u001b[0m`,
  cyan: (text: string) => `\u001b[36m${text}\u001b[0m`,
};

function fail(message: string): never {
  console.error(paint.red(message));
  process.exit(1);
}

async function loadPack(name?: string): Promise<RulePack> {
  try {
    return await store.load(name);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function readEvents(path: string): Promise<ChartEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return fail(`cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Accept a bare array, an Absence archive object, or `{ events: [...] }`.
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { events?: unknown }).events as unknown[] | undefined);
  if (!Array.isArray(list)) return fail(`${path} does not contain an array of events`);
  return toChartEvents(list as never);
}

/* ── commands ───────────────────────────────────────────────────────────── */

async function cmdList() {
  const packs = await store.list();
  const active = await store.activeName();
  if (packs.length === 0) {
    console.log(paint.dim(`no packs in ${dir} — the built-in defaults are in use`));
    console.log(paint.dim(`create one with: npm run rules -- create work`));
    return;
  }
  console.log(paint.dim(dir));
  for (const pack of packs) {
    const marker = pack.active ? paint.green("●") : " ";
    const name = pack.active ? paint.bold(pack.name) : pack.name;
    const counts = `${pack.enabled}/${pack.rules} rules · ${pack.live} live · ${pack.settled} settled`;
    const health =
      pack.issues.length === 0 ? paint.dim("valid") : paint.red(`${pack.issues.length} issue(s)`);
    console.log(`${marker} ${name.padEnd(20)} ${paint.dim(counts)}  ${health}  ${paint.dim(pack.hash)}`);
  }
  if (!active) console.log(paint.dim("\nno active pack — the built-in defaults are in use"));
}

async function cmdShow(name: string | undefined) {
  const pack = await loadPack(name);
  console.log(paint.bold(pack.name ?? "pack"));
  console.log(paint.dim(`${pack.rules.length} rules`));
  for (const rule of pack.rules) {
    const off = rule.enabled === false || rule.emit.level === "none";
    const level = off ? paint.dim("off") : paint.cyan(rule.emit.level);
    const declared = phaseOf(rule);
    const phase = declared !== "both" ? paint.dim(` [${declared}]`) : "";
    console.log(`\n  ${off ? paint.dim(rule.id) : rule.id}  ${level}${phase}`);
    console.log(`    ${paint.dim("when")} ${describeConditions(rule)}`);
    console.log(`    ${paint.dim("says")} ${rule.emit.title}`);
  }
}

function describeConditions(rule: RulePack["rules"][number]): string {
  const combinator = rule.when.combinator === "any" ? "or" : "and";
  return rule.when.conditions
    .map((condition) => {
      if ("window" in condition) {
        const spec = condition.window;
        const types = spec.events?.type;
        const subject = Array.isArray(types) ? types.join("/") : (types ?? "any event");
        const span = spec.span?.lastMs !== undefined ? ` in ${spec.span.lastMs}ms` : "";
        return `${spec.measure} of ${subject}${span} ${spec.op} ${String(spec.value ?? "")}`;
      }
      if ("sequence" in condition) {
        return describeSequence(condition.sequence);
      }
      if ("quant" in condition) {
        return `${condition.quant} ${condition.field} ${condition.op ?? ""} ${String(condition.value ?? "")}`.trim();
      }
      return `${condition.field} ${condition.op} ${JSON.stringify(condition.value ?? null)}`;
    })
    .join(` ${combinator} `);
}

async function cmdCreate(name: string | undefined) {
  if (!name) return fail("usage: rules create <name>");
  const pack = await store.create(name);
  console.log(paint.green(`created and activated "${name}" with ${pack.rules.length} rules`));
  console.log(paint.dim(`${dir}/${name}.json`));
}

async function cmdActivate(name: string | undefined) {
  if (!name) return fail("usage: rules activate <name>");
  try {
    await store.activate(name);
  } catch (error) {
    if (error instanceof PackInvalidError) {
      console.error(paint.red(error.message));
      return fail("refusing to activate an invalid pack");
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
  console.log(paint.green(`active pack: ${name}`));
}

async function cmdDelete(name: string | undefined) {
  if (!name) return fail("usage: rules delete <name>");
  await store.remove(name);
  console.log(paint.green(`deleted "${name}"`));
}

async function cmdValidate(target: string | undefined) {
  if (!target) return fail("usage: rules validate <name|file.json>");
  let pack: RulePack;
  try {
    pack = target.endsWith(".json")
      ? parsePack(await readFile(target, "utf8"))
      : parsePack(await fsPackIO({ dir }).read(target));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const issues = validatePack(pack);
  if (issues.length === 0) {
    console.log(paint.green(`✓ ${pack.rules.length} rules, no problems`));
    return;
  }
  for (const issue of issues) {
    console.log(`${paint.red("✗")} ${paint.bold(issue.path)}: ${issue.message}`);
  }
  process.exitCode = 1;
}

async function cmdFormat(target: string | undefined) {
  if (!target) return fail("usage: rules format <file.json>");
  const pack = parsePack(await readFile(target, "utf8"));
  const issues = validatePack(pack);
  process.stdout.write(serializePack(pack));
  if (issues.length > 0) {
    console.error(paint.yellow(`\n${issues.length} problem(s) — run \`validate\` for details`));
    process.exitCode = 1;
  }
}

async function cmdPreview(packName: string | undefined, ruleId: string | undefined, eventsPath: string | undefined) {
  if (!ruleId || !eventsPath) return fail("usage: rules preview <pack> <rule-id> <events.json>");
  const pack = await loadPack(packName);
  const rule = pack.rules.find((candidate) => candidate.id === ruleId);
  if (!rule) return fail(`no rule "${ruleId}" in pack "${packName ?? "active"}"`);
  const events = await readEvents(eventsPath);
  const preview = previewRule(rule, events, {
    anchor: typeof args.flags["now"] === "string" ? Date.parse(args.flags["now"]) : undefined,
  });
  if (!preview) return fail("no run in that event file");

  console.log(paint.bold(rule.id));
  console.log(paint.dim(`simulated against ${preview.events} events — hypothetical, not recorded`));
  if (preview.errors.length > 0) {
    for (const error of preview.errors) console.log(paint.red(`✗ ${error.message}`));
    process.exitCode = 1;
  }
  if (!preview.fired) {
    console.log(paint.yellow("the rule did not fire"));
    return;
  }
  for (const finding of preview.findings) {
    console.log(`\n  ${paint.cyan(finding.level.toUpperCase())} ${finding.title}`);
    if (finding.detail) console.log(`    ${paint.dim(finding.detail)}`);
    console.log(`    ${paint.dim(`${finding.evidence.length} evidence event(s): ${finding.evidence.slice(0, 4).join(", ")}`)}`);
  }
}

async function cmdSimulate(eventsPath: string | undefined) {
  if (!eventsPath) return fail("usage: rules simulate <events.json> [--pack name] [--report]");
  const events = await readEvents(eventsPath);
  const pack = typeof args.flags["pack"] === "string" ? await loadPack(args.flags["pack"]) : await store.loadActive();
  const phase = args.flags["phase"] === "live" ? "live" : args.flags["phase"] === "settled" ? "settled" : undefined;
  const now = typeof args.flags["now"] === "string" ? Date.parse(args.flags["now"]) : undefined;
  const observation = observe(events, { pack, phase, live: now === undefined ? {} : { nowMs: now } });
  if (!observation) return fail("no run in that event file");

  if (args.flags["report"] === true) {
    const spec = phase === "live" ? LIVE_REPORT : SETTLED_REPORT;
    console.log(reportText(observation, spec, now === undefined ? {} : { nowMs: now }));
    return;
  }
  console.log(paint.bold(`${observation.run.id} → ${observation.attention.level.toUpperCase()}`));
  if (observation.findings.length === 0) console.log(paint.dim("nothing needs a look"));
  for (const finding of observation.findings) {
    console.log(`  ${paint.cyan(finding.level)} ${finding.title}`);
  }
  if (observation.errors.length > 0) {
    for (const error of observation.errors) console.log(paint.red(`✗ ${error.ruleId}: ${error.message}`));
  }
}

async function cmdFields() {
  const type = typeof args.flags["type"] === "string" ? [args.flags["type"]] : undefined;
  for (const field of eventFields(type)) {
    console.log(`${field.path.padEnd(34)} ${paint.dim(field.kind.padEnd(9))} ${field.label}`);
  }
}

function cmdHelp() {
  console.log(`${paint.bold("chart rules")} — rule packs on disk

  list                          every pack, with counts and health
  show [name]                   print a pack (default: the active one)
  create <name>                 copy the defaults into a new pack and activate it
  activate <name>               make a pack active
  deactivate                    fall back to the built-in defaults
  delete <name>                 remove a pack
  validate <name|file.json>     validate a pack or a file
  format <file.json>            re-serialize a file in the canonical shape
  preview <pack> <rule> <events.json>   simulate one rule against a recorded run
  simulate <events.json>        judge a run with a pack  [--pack name] [--phase live|settled] [--now ISO] [--report]
  fields [--type command]       the fields a window may address

  --dir <path>                  store directory (default: $CHART_RULES_DIR or .chart/rules)`);
}

/* ── dispatch ───────────────────────────────────────────────────────────── */

const [verb, ...rest] = args.command;
switch (verb) {
  case "list":
    await cmdList();
    break;
  case "show":
    await cmdShow(rest[0]);
    break;
  case "create":
    await cmdCreate(rest[0]);
    break;
  case "activate":
    await cmdActivate(rest[0]);
    break;
  case "deactivate":
    await store.deactivate();
    console.log(paint.green("using the built-in defaults"));
    break;
  case "delete":
    await cmdDelete(rest[0]);
    break;
  case "validate":
    await cmdValidate(rest[0]);
    break;
  case "format":
    await cmdFormat(rest[0]);
    break;
  case "preview":
    await cmdPreview(rest[0], rest[1], rest[2]);
    break;
  case "simulate":
    await cmdSimulate(rest[0]);
    break;
  case "fields":
    await cmdFields();
    break;
  default:
    cmdHelp();
    if (verb !== undefined) process.exitCode = 1;
}
