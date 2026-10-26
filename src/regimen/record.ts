/**
 * The record — what was judged, by whom, and in what order.
 *
 * A finding is not recomputed on replay (see docs/DESIGN.md §5), which means the
 * record is the thing a report is rendered from. That makes the record the most
 * attackable part of the system: if it can be edited quietly, every past report
 * is a lie and there is no way to notice.
 *
 * So records are **hash-chained**. Each one carries the digest of the previous
 * record plus its own content, so editing, reordering, inserting or deleting a
 * record breaks the chain from that point on. `verifyChain` walks a log and says
 * where it first fails.
 *
 * Be honest about the strength: this is a 128-bit non-cryptographic digest over
 * the record's canonical JSON. It detects accidental corruption and casual
 * tampering, not an attacker who can rewrite the whole log (that needs a keyed
 * HMAC and a key the log cannot reach). The point is that silence stops being an
 * option: a doctored report leaves a broken chain.
 *
 * No dependencies and no `crypto` import — this has to run in a browser, a Node
 * CLI and a test with the same answer.
 */

import type { Attention, Finding } from "../core/types.ts";
import type { RuleError } from "./evaluate.ts";
import type { RulePack, RulePhase } from "./rule.ts";
import { hashPack } from "./rule.ts";

export interface FindingRecord {
  runId: string;
  phase: RulePhase;
  /** Content hash of the pack that produced these findings. */
  packHash: string;
  packName?: string;
  /** The clock the judgement was anchored to. */
  anchor: number;
  findings: Finding[];
  attention: Attention;
  errors: RuleError[];
  /** Digest of the previous record in this session's log; absent for the first. */
  prev?: string;
  /** Digest of this record (content + `prev`). */
  digest: string;
}

/** Everything a record holds except its own digest. */
export type FindingRecordBody = Omit<FindingRecord, "digest">;

/**
 * A 128-bit digest of a record body, as 32 hex characters.
 *
 * Four FNV-1a lanes with different offsets, over the canonical JSON, with the
 * length mixed in so a truncation cannot collide with a shorter record.
 */
export function digestOf(body: FindingRecordBody): string {
  const json = canonicalJson(body);
  const lanes = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9];
  const out = lanes.map((seed) => {
    let hash = seed >>> 0;
    for (let i = 0; i < json.length; i++) {
      hash ^= json.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= json.length;
    return hash >>> 0;
  });
  return out.map((lane) => lane.toString(16).padStart(8, "0")).join("");
}

/**
 * Key-sorted JSON, so two records that mean the same thing hash the same.
 * (A plain `JSON.stringify` depends on insertion order, which a round trip
 * through a JSON file does not preserve.)
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

/**
 * Seal a body into a record, linking it to the previous one.
 *
 * Call this when the judgement happens — the point of the record is that it
 * captured the rules *then*, not the rules now.
 */
export function makeRecord(body: Omit<FindingRecordBody, "prev">, previous?: FindingRecord): FindingRecord {
  const withPrev: FindingRecordBody = previous ? { ...body, prev: previous.digest } : { ...body };
  return { ...withPrev, digest: digestOf(withPrev) };
}

export interface ChainCheck {
  ok: boolean;
  /** Index of the first record that fails, when `ok` is false. */
  brokenAt?: number;
  reason?: string;
  length: number;
}

/** Walk a log and verify every link and every digest. */
export function verifyChain(records: readonly FindingRecord[]): ChainCheck {
  let previous: FindingRecord | undefined;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const { digest, ...body } = record;
    const expected = digestOf(body);
    if (digest !== expected) {
      return { ok: false, brokenAt: index, reason: "content does not match its digest", length: records.length };
    }
    if (previous) {
      if (body.prev !== previous.digest) {
        return { ok: false, brokenAt: index, reason: "prev does not match the previous record", length: records.length };
      }
    } else if (body.prev !== undefined) {
      return { ok: false, brokenAt: index, reason: "the first record claims a predecessor", length: records.length };
    }
    previous = record;
  }
  return { ok: true, length: records.length };
}

/**
 * Build a record body from an evaluation. Kept here so a host does not have to
 * know the shape: `observe` → `recordOf(observation, pack)` → `makeRecord`.
 */
export function recordBody(input: {
  runId: string;
  phase: RulePhase;
  anchor: number;
  findings: Finding[];
  attention: Attention;
  errors: RuleError[];
  pack: RulePack;
}): Omit<FindingRecordBody, "prev"> {
  return {
    runId: input.runId,
    phase: input.phase,
    packHash: hashPack(input.pack),
    ...(input.pack.name ? { packName: input.pack.name } : {}),
    anchor: input.anchor,
    findings: input.findings,
    attention: input.attention,
    errors: input.errors,
  };
}
