/**
 * Report specs — a report is data, not code.
 *
 * Absence's report is a 1300-line module that hard-codes one layout, so a user
 * who wants "the same run, but only what touched `company/`" has no path. Here a
 * report is a list of sections, and a section is a source path plus a template.
 * Nothing is executed: no expressions, no callbacks, no plugin loading.
 *
 * The renderer returns a document model (`RenderedReport`), not HTML or React.
 * Chart has no opinion about how a report looks; that belongs to the host.
 */

import type { AttentionLevel } from "../core/types.ts";

export interface ReportSpec {
  id: string;
  /** Shown by the host as the report's title. */
  title: string;
  /** Optional one-line description for a spec picker. */
  description?: string;
  /** Which verdict the spec is meant for. */
  for?: "live" | "settled" | "any";
  sections: ReportSection[];
}

export type ReportSection =
  | { kind: "header"; title: string; subtitle?: string }
  | { kind: "verdict"; title?: string; showFindings?: boolean }
  | {
      kind: "findings";
      title?: string;
      minLevel?: AttentionLevel;
      tags?: string[];
      limit?: number;
      empty?: string;
    }
  | { kind: "stats"; title?: string; rows: Array<{ label: string; value: string }> }
  | {
      kind: "table";
      title?: string;
      /** A path into the context that resolves to an array. */
      source: string;
      columns: Array<{ header: string; cell: string; width?: "auto" | "narrow" | "wide" }>;
      limit?: number;
      empty?: string;
      /** Sort by a row field, ascending or descending. */
      sort?: { field: string; direction: "asc" | "desc" };
    }
  | {
      kind: "list";
      title?: string;
      source: string;
      item: string;
      limit?: number;
      empty?: string;
    }
  | { kind: "timeline"; title?: string; limit?: number; empty?: string }
  | { kind: "evidence"; title?: string; limit?: number };

export type RenderedSection =
  | { kind: "header"; title: string; subtitle?: string }
  | {
      kind: "verdict";
      level: AttentionLevel;
      outcome: string;
      reasons: string[];
      findings: Array<{ ruleId: string; level: AttentionLevel; title: string; detail?: string }>;
    }
  | {
      kind: "findings";
      title: string;
      findings: Array<{
        ruleId: string;
        level: AttentionLevel;
        title: string;
        detail?: string;
        tags: string[];
        evidence: string[];
      }>;
      empty?: string;
    }
  | { kind: "stats"; title?: string; rows: Array<{ label: string; value: string }> }
  | {
      kind: "table";
      title?: string;
      columns: Array<{ header: string; width?: "auto" | "narrow" | "wide" }>;
      rows: string[][];
      empty?: string;
    }
  | { kind: "list"; title?: string; items: string[]; empty?: string }
  | {
      kind: "timeline";
      title?: string;
      nodes: Array<{ action: string; subject: string; offsetMs: number; effects: string[]; eventId: string }>;
      empty?: string;
    }
  | { kind: "evidence"; title?: string; ids: string[] };

export interface RenderedReport {
  id: string;
  title: string;
  sections: RenderedSection[];
}
