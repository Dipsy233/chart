/**
 * The rule panel: identity, phase, the condition list, what it says, and the
 * preview button.
 *
 * The preview is the important part. It runs *this* rule against the selected run
 * and shows the answer inline, so a half-written rule is testable before it is
 * saved — the same affordance n8n gives with "execute step".
 */

import { useEffect, useMemo, useState } from "react";
import { describeRule, isIdTaken, previewRule, suggestId, validateRule } from "../../../src/editor/draft.ts";
import type { Rule, RulePack } from "../../../src/regimen/rule.ts";
import type { ChartEvent } from "../../../src/core/events.ts";
import type { AttentionLevel } from "../../../src/core/types.ts";
import { ConditionList } from "./Conditions.tsx";
import { LevelSelect } from "./ValueInput.tsx";

export function RuleEditor({
  rule,
  pack,
  events,
  anchor,
  fired,
  onChange,
  onDelete,
  onDuplicate,
}: {
  rule: Rule;
  pack: RulePack;
  events: readonly ChartEvent[];
  anchor: number | undefined;
  fired: boolean;
  onChange: (rule: Rule) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const issues = useMemo(() => validateRule(rule), [rule]);
  const [preview, setPreview] = useState<ReturnType<typeof previewRule>>(undefined);

  // A stale preview is worse than none: clear it when the rule changes.
  useEffect(() => {
    setPreview(undefined);
  }, [rule]);

  const level = rule.emit.level as AttentionLevel;

  return (
    <div className="rule-editor stack" style={{ gap: 12 }}>
      {/* ── identity ─────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row">
          <span className="label">rule id</span>
          <input
            className="field"
            value={rule.id}
            onChange={(event) => {
              const next = event.target.value.trim();
              onChange({ ...rule, id: next });
            }}
            onBlur={() => {
              if (rule.id.trim().length === 0) onChange({ ...rule, id: suggestId(rule.name ?? "rule") });
            }}
          />
          <button
            className={`btn tiny${rule.enabled === false ? "" : " on"}`}
            title="Enable or disable this rule without deleting it"
            onClick={() => onChange({ ...rule, enabled: rule.enabled === false ? true : false })}
          >
            {rule.enabled === false ? "disabled" : "enabled"}
          </button>
        </div>
        {isIdTaken(pack, rule.id) ? (
          <div className="issue">
            <span className="path">id</span>
            <span>another rule already uses this id — saving will replace it</span>
          </div>
        ) : null}

        <div className="row">
          <span className="label">name</span>
          <input
            className="field"
            value={rule.name ?? ""}
            placeholder="what this rule is about"
            onChange={(event) => onChange({ ...rule, name: event.target.value })}
          />
        </div>

        <div className="grid3">
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">phase</span>
            <select
              className="field"
              value={rule.phase ?? "both"}
              onChange={(event) => onChange({ ...rule, phase: event.target.value as never })}
            >
              <option value="both">both</option>
              <option value="live">live (now)</option>
              <option value="settled">settled (after the run)</option>
            </select>
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">level</span>
            <LevelSelect value={rule.emit.level} onChange={(next) => onChange({ ...rule, emit: { ...rule.emit, level: next as never } })} />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">priority</span>
            <input
              className="field"
              type="number"
              value={rule.priority ?? 0}
              onChange={(event) => onChange({ ...rule, priority: Number(event.target.value) })}
            />
          </label>
        </div>

        <div className="row tiny muted">
          <span>reads as</span>
          <span style={{ color: "var(--accent)" }}>{describeRule(rule)}</span>
          {fired ? <span className="chip live">fired</span> : null}
        </div>
      </div>

      {/* ── conditions ───────────────────────────────────────── */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row">
          <span className="label">conditions</span>
          <span className="tiny muted">flat list · need (A and B) or C? add a second rule</span>
        </div>
        <ConditionList when={rule.when} onChange={(when) => onChange({ ...rule, when })} />
      </div>

      {/* ── emit ─────────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">what it says</span>
        <input
          className="field"
          value={rule.emit.title}
          placeholder="title — {{facts.commands.failed}} failed"
          onChange={(event) => onChange({ ...rule, emit: { ...rule.emit, title: event.target.value } })}
        />
        <input
          className="field"
          value={rule.emit.detail ?? ""}
          placeholder="detail (optional)"
          onChange={(event) =>
            onChange({ ...rule, emit: { ...rule.emit, detail: event.target.value || undefined } })
          }
        />
        <div className="grid2">
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">tags</span>
            <input
              className="field"
              value={(rule.emit.tags ?? []).join(", ")}
              placeholder="commands, security"
              onChange={(event) =>
                onChange({
                  ...rule,
                  emit: {
                    ...rule.emit,
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">evidence</span>
            <input
              className="field"
              value={(rule.emit.evidence ?? []).join(", ")}
              placeholder="facts.failed, window.ids"
              onChange={(event) =>
                onChange({
                  ...rule,
                  emit: {
                    ...rule.emit,
                    evidence: event.target.value
                      .split(",")
                      .map((path) => path.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </label>
        </div>
        <div className="grid2">
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">cooldown (ms)</span>
            <input
              className="field"
              type="number"
              value={rule.cooldownMs ?? 0}
              onChange={(event) =>
                onChange({ ...rule, cooldownMs: Number(event.target.value) || undefined })
              }
            />
          </label>
          <label className="stack" style={{ gap: 2 }}>
            <span className="label">suppresses</span>
            <input
              className="field"
              value={(rule.suppresses ?? []).join(", ")}
              placeholder="run.unresolved-error"
              onChange={(event) =>
                onChange({
                  ...rule,
                  suppresses: event.target.value
                    .split(",")
                    .map((id) => id.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
        {level === "none" ? (
          <div className="tiny muted">level “none” means this rule is off.</div>
        ) : null}
      </div>

      {/* ── issues ───────────────────────────────────────────── */}
      {issues.length > 0 ? (
        <div className="stack" style={{ gap: 2 }}>
          <span className="label" style={{ color: "var(--ember)" }}>
            {issues.length} problem{issues.length === 1 ? "" : "s"}
          </span>
          {issues.map((issue, index) => (
            <div className="issue" key={index}>
              <span className="path">{issue.path}</span>
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── preview ──────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row">
          <button
            className="btn primary"
            disabled={events.length === 0}
            onClick={() => setPreview(previewRule(rule, events, { anchor }))}
          >
            ▶ preview on this run
          </button>
          <span className="tiny muted">
            {anchor === undefined ? "anchor: run end" : `anchor: ${new Date(anchor).toLocaleString()}`}
          </span>
        </div>

        {preview === undefined ? null : preview === undefined || preview.errors.length > 0 ? (
          <div className="stack" style={{ gap: 2 }}>
            {preview.errors.map((error, index) => (
              <div className="issue" key={index}>
                <span className="path">error</span>
                <span>{error.message}</span>
              </div>
            ))}
          </div>
        ) : preview.fired ? (
          <div className="stack" style={{ gap: 4 }}>
            {preview.findings.map((finding, index) => (
              <div className={`finding ${finding.level}`} key={index}>
                <div className="title">{finding.title}</div>
                {finding.detail ? <div className="detail">{finding.detail}</div> : null}
                <div className="ev">
                  {finding.evidence.length} evidence event(s): {finding.evidence.slice(0, 5).join(", ")}
                </div>
              </div>
            ))}
            <div className="tiny muted">simulated — nothing was recorded</div>
          </div>
        ) : (
          <div className="empty tiny">the rule did not fire on this run</div>
        )}
      </div>

      {/* ── actions ──────────────────────────────────────────── */}
      <div className="row">
        <button className="btn tiny" onClick={onDuplicate}>
          duplicate
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn tiny danger" onClick={onDelete}>
          delete rule
        </button>
      </div>
    </div>
  );
}
