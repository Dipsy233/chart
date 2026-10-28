/**
 * 试跑这一轮 — the answer an editor owes a user, next to the form.
 *
 * The engine could always judge a half-written rule against a real run
 * (`previewRule`), and the CLI has exposed it since day one. The web editor
 * never called it, so the feedback loop was: change something → switch to the
 * report → scrub the tape → guess which rule spoke. This panel closes the loop
 * in place.
 *
 * It is a **simulation**, and it says so: `hypothetical: true` is on the engine's
 * type, so no caller can mistake this for the record. Verdicts are only ever
 * shown here and in the report — never in the conditions themselves.
 *
 * Three things it shows, because three things were missing:
 *
 *   1. **did it fire** — and if not, which condition said no, and what the field
 *      actually held (that number is the whole reason a threshold was "wrong");
 *   2. **why** — every leaf, with `skip` distinguished from `false`, because a
 *      condition `all` short-circuited past was never judged;
 *   3. **wording problems** — a `{{facts.commands.faild}}` typo renders empty,
 *      which looked exactly like a rule that was simply not matching.
 */

import { useMemo } from "react";
import type { ChartEvent } from "../../../src/core/events.ts";
import { previewRule, phaseOf } from "../../../src/index.ts";
import type { Rule } from "../../../src/regimen/rule.ts";
import { zhLevel } from "../lib/plain.ts";

const OUTCOME_LABEL: Record<string, string> = {
  ok: "满足",
  no: "不满足",
  skip: "未判读",
  error: "出错",
};

export function RulePreviewPanel({
  rule,
  events,
  runId,
  runLabel,
  onOpenReport,
}: {
  rule: Rule;
  events: ChartEvent[];
  /** Which run to judge. Absent = the newest one. */
  runId?: string;
  /** A human name for the run, so the panel says what it judged. */
  runLabel?: string;
  onOpenReport?: () => void;
}) {
  const preview = useMemo(() => previewRule(rule, events, { runId }), [rule, events, runId]);

  if (!preview) {
    return (
      <section className="block">
        <header className="block-head">
          <span className="block-title">试跑</span>
        </header>
        <div className="empty tiny">这段事件流里还没有一轮运行，试跑需要一个具体的一轮。</div>
      </section>
    );
  }

  const trace = preview.trace;
  const off = rule.enabled === false || rule.emit.level === "none";

  return (
    <section className="block preview-block">
      <header className="block-head">
        <span className="block-title">试跑{runLabel ? ` · ${runLabel}` : ""}</span>
        <span className="spacer" />
        {onOpenReport ? (
          <button className="btn tiny ghost" onClick={onOpenReport} title="在报告里播放这一轮">
            在报告里看 →
          </button>
        ) : null}
      </header>

      <div className="preview-verdict">
        {off ? (
          <span className="chip off">这条规则是关闭的</span>
        ) : preview.fired ? (
          <>
            <span className={`chip ${preview.findings[0]?.level ?? "low"}`}>
              {zhLevel(preview.findings[0]?.level)}
            </span>
            <span className="preview-say">{preview.findings[0]?.title}</span>
          </>
        ) : trace.matched ? (
          // Matched but no finding: the conditions hold, so something downstream
          // (cooldown, suppression, a level of none) kept it quiet.
          <span className="preview-say">条件都满足，但没有产生判读（冷却 / 压制 / 级别为无？）。</span>
        ) : (
          <span className="preview-say">这一轮不会触发。</span>
        )}
        <span className="spacer" />
        <span className="tiny muted">对 {preview.events} 条事件 · {zhPhase(phaseOf(rule))} · 假设，不记录</span>
      </div>

      <div className="stack" style={{ gap: 4 }}>
        <div className="tiny muted">
          {trace.combinator === "all" ? "需要下面每一条都满足：" : "只要下面任意一条满足："}
        </div>
        {trace.conditions.map((leaf) => {
          const decisive = trace.decisive.includes(leaf.index);
          return (
            <div
              key={leaf.index}
              className={`preview-leaf ${leaf.outcome}${decisive && !off ? " decisive" : ""}`}
              title={leaf.error ?? undefined}
            >
              <span className={`state-dot ${leaf.outcome === "ok" ? "low" : leaf.outcome === "no" ? "high" : "off"}`} />
              <span className="leaf-sentence">{leaf.sentence}</span>
              <span className="spacer" />
              {leaf.actual !== undefined ? (
                <span className="leaf-actual mono" title="这个字段在这一轮里的实际值">
                  {formatActual(leaf.actual)}
                </span>
              ) : null}
              <span className={`leaf-outcome ${leaf.outcome}`}>{OUTCOME_LABEL[leaf.outcome] ?? leaf.outcome}</span>
            </div>
          );
        })}
        <span className="zh-hint">
          「未判读」表示前面的条件已经决定了结果，这一条没有被执行到 —— 它既不算满足，也不算不满足。
        </span>
      </div>

      {preview.templateIssues.length > 0 ? (
        <div className="stack" style={{ gap: 3, marginTop: 6 }}>
          <div className="fired-head" style={{ color: "var(--high)" }}>
            <span>措辞里有 {preview.templateIssues.length} 处取不到值</span>
          </div>
          {preview.templateIssues.map((issue, index) => (
            <div className="issue" key={index}>
              <span className="path mono">{issue.expression}</span>
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {preview.errors.length > 0 ? (
        <div className="stack" style={{ gap: 3, marginTop: 6 }}>
          {preview.errors.map((error, index) => (
            <div className="issue" key={index}>
              <span className="path mono">{error.ruleId}</span>
              <span>{error.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {preview.findings[0]?.detail ? (
        <div className="preview-detail">{preview.findings[0].detail}</div>
      ) : null}
    </section>
  );
}

function zhPhase(phase: string): string {
  switch (phase) {
    case "live":
      return "运行中判读";
    case "settled":
      return "结束后判读";
    default:
      return "全程判读";
  }
}

/** What the field actually held — the number a threshold is usually wrong about. */
function formatActual(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length}]`;
  if (typeof value === "object") return "{…}";
  if (typeof value === "string") return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  return String(value);
}
