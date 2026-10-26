/**
 * Packs on disk — the same shape Absence uses for egg-filters and avatar skins:
 *
 *   <dir>/active.json        { "active": "work" }
 *   <dir>/work.json          a RulePack
 *   <dir>/personal.json      another
 *
 * The store is filesystem-agnostic: it talks to a `PackIO`, so the CLI uses
 * `fsPackIO` (Node) and a web app can use an HTTP adapter later. That keeps the
 * engine embeddable and keeps `node:fs` out of the browser bundle.
 *
 * Two rules the store enforces so a user cannot lose work:
 *
 *   · a pack is **validated before it is written** — a rule with a typo in an
 *     operator is rejected at save time, not discovered as a silent no-op weeks
 *     later;
 *   · names are a strict slug, so `../../etc/passwd` is not a pack name.
 */

import { DEFAULT_PACK } from "../regimen/defaults.ts";
import { hashPack, validatePack, type RulePack, type RuleIssue } from "../regimen/rule.ts";
import { appliesInPhase } from "../regimen/rule.ts";

export interface PackIO {
  /** Every pack name in the directory (without `.json`). */
  list(): Promise<string[]>;
  /** The raw JSON text of one pack. Throws when it does not exist. */
  read(name: string): Promise<string>;
  /** Write one pack. Implementations should be atomic (tmp + rename). */
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** The active pack's name, or undefined when nothing is active. */
  readActive(): Promise<string | undefined>;
  writeActive(name: string | undefined): Promise<void>;
}

export const PACK_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function assertPackName(name: string): void {
  if (!PACK_NAME_RE.test(name)) {
    throw new Error(`invalid pack name "${name}" — use letters, digits, dot, dash or underscore (1–64 chars)`);
  }
  if (name === "active") throw new Error(`"active" is reserved for the pointer file`);
}

export interface PackSummary {
  name: string;
  /** Whether this is the active pack. */
  active: boolean;
  rules: number;
  enabled: number;
  live: number;
  settled: number;
  /** Content hash, so two packs can be compared without loading both. */
  hash: string;
  /** Problems found while loading. An invalid pack is listed, not hidden. */
  issues: RuleIssue[];
}

export class PackStore {
  constructor(
    private readonly io: PackIO,
    private readonly fallback: RulePack = DEFAULT_PACK,
  ) {}

  /** Every pack, with a summary. Invalid packs appear with their issues. */
  async list(): Promise<PackSummary[]> {
    const names = (await this.io.list()).sort((a, b) => a.localeCompare(b));
    const active = await this.io.readActive();
    const summaries: PackSummary[] = [];
    for (const name of names) {
      let pack: RulePack | undefined;
      let issues: RuleIssue[] = [];
      try {
        pack = parsePack(await this.io.read(name));
        issues = validatePack(pack);
      } catch (error) {
        issues = [{ ruleId: "", path: "", message: messageOf(error) }];
      }
      summaries.push({
        name,
        active: name === active,
        rules: pack?.rules.length ?? 0,
        enabled: pack?.rules.filter((rule) => rule.enabled !== false).length ?? 0,
        live: pack?.rules.filter((rule) => appliesInPhase(rule, "live")).length ?? 0,
        settled: pack?.rules.filter((rule) => appliesInPhase(rule, "settled")).length ?? 0,
        hash: pack ? hashPack(pack) : "",
        issues,
      });
    }
    return summaries;
  }

  /**
   * Load a pack by name, the active pack, or the fallback.
   *
   * A named pack that does not exist throws: silently falling back to the
   * defaults would make `chart rules show typo` look like a success.
   */
  async load(name?: string): Promise<RulePack> {
    const target = name ?? (await this.io.readActive());
    if (!target) return structuredClone(this.fallback);
    assertPackName(target);
    return parsePack(await this.io.read(target));
  }

  /** Load the active pack, or the fallback when none is active. */
  async loadActive(): Promise<RulePack> {
    return this.load();
  }

  /**
   * Validate and write. Returns the issues it *found* — an empty array means the
   * pack is on disk. With `force`, an invalid pack is written anyway and its
   * issues are returned so a CLI can warn.
   */
  async save(name: string, pack: RulePack, options: { force?: boolean } = {}): Promise<RuleIssue[]> {
    assertPackName(name);
    const issues = validatePack(pack);
    if (issues.length > 0 && !options.force) {
      throw new PackInvalidError(name, issues);
    }
    await this.io.write(name, serializePack(pack));
    return issues;
  }

  /** Create a pack from the defaults (or another pack), then activate it. */
  async create(name: string, from?: RulePack): Promise<RulePack> {
    const pack = structuredClone(from ?? this.fallback);
    if (pack.name === DEFAULT_PACK.name) pack.name = name;
    await this.save(name, pack);
    await this.activate(name);
    return pack;
  }

  async remove(name: string): Promise<void> {
    assertPackName(name);
    await this.io.remove(name);
    if ((await this.io.readActive()) === name) await this.io.writeActive(undefined);
  }

  /** Point `active.json` at a pack. Throws when the pack is missing or invalid. */
  async activate(name: string): Promise<void> {
    assertPackName(name);
    const pack = parsePack(await this.io.read(name));
    const issues = validatePack(pack);
    if (issues.length > 0) throw new PackInvalidError(name, issues);
    await this.io.writeActive(name);
  }

  /** Clear the pointer, so the built-in defaults are used again. */
  async deactivate(): Promise<void> {
    await this.io.writeActive(undefined);
  }

  async activeName(): Promise<string | undefined> {
    return this.io.readActive();
  }
}

export class PackInvalidError extends Error {
  constructor(
    readonly packName: string,
    readonly issues: RuleIssue[],
  ) {
    super(
      [
        `pack "${packName}" has ${issues.length} problem${issues.length === 1 ? "" : "s"}:`,
        ...issues.map((issue) => `  ${issue.path || "(pack)"}: ${issue.message}`),
      ].join("\n"),
    );
    this.name = "PackInvalidError";
  }
}

/** Parse and shape-check a pack. Throws on JSON that is not an object. */
export function parsePack(text: string): RulePack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${messageOf(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("a pack must be a JSON object");
  }
  const candidate = parsed as Partial<RulePack>;
  if (candidate.version !== 1) throw new Error("a pack must declare `version: 1`");
  if (!Array.isArray(candidate.rules)) throw new Error("a pack must have a `rules` array");
  return candidate as RulePack;
}

/** Stable on-disk formatting: 2-space JSON, one trailing newline. */
export function serializePack(pack: RulePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
