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
import type { When } from "../regimen/predicate.ts";

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

/**
 * A row filter: the same flat field conditions a rule uses, evaluated against
 * one element of a `source` array.
 *
 * This is the one thing that turned "a custom report" from a wish into a
 * feature: without it a `table` shows every file the run touched, and a user who
 * wants "only what changed under `company/`" has no way to say so. It is a
 * `When`, not a new language — `matches()` already knows how to apply it, so a
 * filter and a rule's `where` mean exactly the same thing.
 *
 * Only field conditions are meaningful here (a window needs the event stream, a
 * sequence needs order); the renderer rejects the other two at validation time.
 */
export type SectionFilter = When;

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
      /** Narrow the findings the section shows (applied after level and tags). */
      filter?: SectionFilter;
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
      /** Only rows whose element matches. Applied before `sort` and `limit`. */
      filter?: SectionFilter;
      /**
       * Where each row's evidence ids come from: a path under `vars.row`, e.g.
       * `evidence`. The host turns them into clickable links, so a row in a
       * custom report still jumps to the event that proves it.
       */
      evidence?: string;
    }
  | {
      kind: "list";
      title?: string;
      source: string;
      item: string;
      limit?: number;
      empty?: string;
      /** Only elements that match. Applied before `limit`. */
      filter?: SectionFilter;
      /** Per-item click target: `{{vars.row.evidence}}`-style, resolved the same way. */
      evidence?: string;
    }
  | {
      /**
       * Free text: a paragraph from a string path, or one line per element.
       *
       * This is what makes `facts.response`, `facts.firstPrompt` and the
       * transcript (`facts.text.*`) renderable — the classic report shows all
       * three, and it could not be expressed as a spec without this section.
       */
      kind: "text";
      title?: string;
      source: string;
      /** Optional template rendering one element when `source` is an array. */
      item?: string;
      limit?: number;
      empty?: string;
      filter?: SectionFilter;
      evidence?: string;
      /** `paragraph` (default) or `code` — a hint for the host's styling. */
      style?: "paragraph" | "code";
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
      /** Per-row event ids, index-aligned with `rows`. Absent when the spec asked for none. */
      evidence?: string[][];
      empty?: string;
    }
  | {
      kind: "list";
      title?: string;
      items: string[];
      /** Per-item event ids, index-aligned with `items`. */
      evidence?: string[][];
      empty?: string;
    }
  | {
      kind: "text";
      title?: string;
      /** One paragraph, when the source was a string. */
      text?: string;
      /** One line per element, when the source was an array. */
      items: string[];
      evidence?: string[][];
      style?: "paragraph" | "code";
      empty?: string;
    }
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
  /**
   * Which pack judged this run, when the caller knows.
   *
   * A report whose verdict came from a hash-chained record must be able to say
   * *which* pack produced it — "judged by `default` (a1b2c3d4) at 14:03" is the
   * difference between a document and an assertion. The renderer never invents
   * this; it is threaded through from the observation or the record.
   */
  judgedBy?: { packName?: string; packHash?: string; at?: number; replayed?: boolean };
}
