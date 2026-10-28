/**
 * The rule panel — the main editing surface.
 *
 * Three numbered blocks, in the order a rule is thought about:
 *
 *   1 信息   what this rule is called, what it is for
 *   2 规则   the conditions: the only part that needs the rule language
 *   3 报告   what the report says when it fires, and what evidence it points at
 *
 * Nothing here runs the rule. The report panel is the only place a judgement is
 * shown, so an edit never produces a verdict next to the form: the rule is data,
 * the report is the answer.
 *
 * The plain-language reading sits above the conditions, so the controls and the
 * sentence cannot drift apart. Everything a beginner never needs (id, priority,
 * cooldown, suppression, reason) is in a collapsed "更多设置".
 *
 * `phase` is not a control and not a field: "only judge this once the run has
 * ended" is already a condition (`facts.ended = true`), and the engine derives
 * the phase from it. The panel shows the derived answer as a reading.
 */

import { useMemo, useRef, useState } from "react";
import type { ChartEvent } from "../../../src/core/events.ts";
import { phaseFromWhen, suggestId, validateRule, withDerivedPhase } from "../../../src/editor/draft.ts";
import type { Rule, RulePack } from "../../../src/regimen/rule.ts";
import type { AttentionLevel } from "../../../src/core/types.ts";
import { ConditionList } from "./Conditions.tsx";
import { RulePreviewPanel } from "./RulePreviewPanel.tsx";
import { describeRuleZh, EVIDENCE_CHOICES, TEMPLATE_VARS, zhEvidence, zhLevel } from "../lib/plain.ts";
import { TagChips } from "./TagChips.tsx";
import { JsonDialog } from "./JsonDialog.tsx";

const LEVELS: Array<{ value: AttentionLevel | "none"; label: string; hint: string }> = [
  { value: "none", label: "无", hint: "等于关闭这条规则" },
  { value: "low", label: "提示", hint: "蓝色，只记一笔" },
  { value: "medium", label: "警告", hint: "琥珀色，值得看一眼" },
  { value: "high", label: "严重", hint: "红色，需要处理" },
];

export function RuleEditor({
  rule,
  pack,
  readOnly,
  onFork,
  onChange,
  onDuplicate,
  onOpenReport,
  onNotify,
  events,
  runId,
  runLabel,
}: {
  rule: Rule;
  pack: RulePack;
  readOnly?: boolean;
  onFork?: () => void;
  onChange: (rule: Rule) => void;
  /** Deleting lives on the card in the list, not here — one place per action. */
  onDuplicate: () => void;
  onOpenReport: () => void;
  /** A toast hook, used by the JSON dialog. */
  onNotify?: (text: string, tone?: "info" | "error") => void;
  /** The stream to try the rule against. The 试跑 panel is the whole point. */
  events: ChartEvent[];
  /** Which run to preview; absent = the newest. */
  runId?: string;
  runLabel?: string;
}) {
  const issues = useMemo(() => validateRule(rule), [rule]);
  const [jsonOpen, setJsonOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const enabled = rule.enabled !== false;
  const level = rule.emit.level;

  const patchEmit = (patch: Partial<Rule["emit"]>) => onChange({ ...rule, emit: { ...rule.emit, ...patch } });

  // Every condition edit re-derives the legacy `phase` field: "when is this
  // judged" is answered by the conditions themselves, so there is no second
  // control to keep in sync.
  const patchWhen = (when: Rule["when"]) => onChange(withDerivedPhase({ ...rule, when }));
  const derivedPhase = phaseFromWhen(rule.when);

  const insertVariable = (expression: string) => {
    const input = titleRef.current;
    const text = rule.emit.title;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const next = `${text.slice(0, start)}{{${expression}}}${text.slice(end)}`;
    patchEmit({ title: next });
    requestAnimationFrame(() => {
      if (!input) return;
      const position = start + expression.length + 4;
      input.focus();
      input.setSelectionRange(position, position);
    });
  };

  const evidence = rule.emit.evidence ?? [];
  const toggleEvidence = (path: string) => {
    patchEmit({
      evidence: evidence.includes(path) ? evidence.filter((candidate) => candidate !== path) : [...evidence, path],
    });
  };
  const customEvidence = evidence.filter((path) => !EVIDENCE_CHOICES.some((choice) => choice.path === path));

  return (
    <div className="col rule-main">
      <div className="pane-head">
        <span>编辑规则</span>
        <span className="spacer" />
        <button className="btn tiny" onClick={() => setJsonOpen(true)} title="看这条规则的原生 JSON，可复制或替换">
          {"{ }"} JSON
        </button>
        <button className="btn tiny" onClick={onDuplicate} title="复制一条一样的规则">
          复制
        </button>
      </div>

      <div className="rule-split">
        <div className="pane-body rule-editor">
          {readOnly ? (
          <div className="notice">
            <span>这是内置默认规则包，改动不会保存。要留住修改，先复制成自己的规则包。</span>
            <span className="spacer" />
            {onFork ? (
              <button className="btn tiny primary" onClick={onFork}>
                复制成可编辑规则包
              </button>
            ) : null}
          </div>
        ) : null}

        {/* ── 1 信息 ─────────────────────────────────────────── */}
        <section className="block">
          <header className="block-head">
            <span className="block-no">1</span>
            <span className="block-title">信息</span>
            <span className="block-hint">这条规则叫什么、用来干什么</span>
            <span className="spacer" />
            <button
              className={`switch${enabled ? " on" : ""}`}
              onClick={() => onChange({ ...rule, enabled: !enabled })}
              title={enabled ? "停用后规则还在，只是不再判读" : "启用这条规则"}
            >
              <span className="knob" />
              {enabled ? "启用中" : "已停用"}
            </button>
          </header>

          <label className="stack" style={{ gap: 4 }}>
            <span className="label">名称</span>
            <input
              className="field big"
              value={rule.name ?? ""}
              placeholder="一句话说清这条规则管什么，比如：测试连败"
              onChange={(event) => onChange({ ...rule, name: event.target.value })}
            />
          </label>

          <label className="stack" style={{ gap: 4 }}>
            <span className="label">描述</span>
            <textarea
              className="field"
              rows={2}
              value={rule.description ?? ""}
              placeholder="为什么需要这条规则?写给半年后的自己看。"
              onChange={(event) => onChange({ ...rule, description: event.target.value || undefined })}
            />
          </label>

          {/* Not a <label>: a label forwards every click to its first button, so
              clicking the tag text would delete it. */}
          <div className="stack" style={{ gap: 4 }}>
            <span className="label">标签 tags</span>
            <TagChips tags={rule.emit.tags ?? []} onChange={(tags) => patchEmit({ tags })} />
            <span className="zh-hint">报告里可以按标签筛选。卡片上显示所有标签，超出部分截断。</span>
          </div>

          <div className="stack" style={{ gap: 4 }}>
            <span className="label">优先级</span>
            <input
              className="field"
              type="number"
              value={rule.priority ?? 0}
              onChange={(event) => onChange({ ...rule, priority: Number(event.target.value) })}
            />
            <span className="zh-hint">数字大的先判读，一般不用改。</span>
          </div>

          <div className="stack" style={{ gap: 3 }}>
            <span className="label">判读时机</span>
            <span className="derived-phase">
              <span className={`chip ${derivedPhase}`}>
                {derivedPhase === "live" ? "运行中" : derivedPhase === "settled" ? "结束后" : "全程"}
              </span>
              <span className="zh-hint">
                {derivedPhase === "live"
                  ? "条件要求「这一轮还没结束」，所以只会在运行中判读。"
                  : derivedPhase === "settled"
                    ? "条件要求「这一轮已结束」，所以只在运行结束后判读。"
                    : "条件里没有提到「这一轮是否已结束」，运行中和结束后都会判读。"}
              </span>
            </span>
            <span className="zh-hint">
              由「规则」里的条件自动决定：加一条「这一轮是否已结束 = 是」就是结束后判读，= 否 就是运行中判读。
            </span>
          </div>

          <details className="adv">
            <summary>更多设置(id / 冷却 / 压制 / 机器键)</summary>
            <div className="stack" style={{ gap: 8, marginTop: 8 }}>
              <div className="grid2">
                <label className="stack" style={{ gap: 3 }}>
                  <span className="label">规则 id</span>
                  <input
                    className="field mono"
                    value={rule.id}
                    onChange={(event) => onChange({ ...rule, id: event.target.value.trim() })}
                    onBlur={() => {
                      if (rule.id.trim().length === 0) onChange({ ...rule, id: suggestId(rule.name ?? "rule") });
                    }}
                  />
                </label>
                <label className="stack" style={{ gap: 3 }}>
                  <span className="label">冷却(毫秒)</span>
                  <input
                    className="field mono"
                    type="number"
                    value={rule.cooldownMs ?? 0}
                    onChange={(event) => onChange({ ...rule, cooldownMs: Number(event.target.value) || undefined })}
                  />
                </label>
              </div>
              <label className="stack" style={{ gap: 3 }}>
                <span className="label">压制哪些规则(逗号分隔的 id)</span>
                <input
                  className="field mono"
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
              <label className="stack" style={{ gap: 3 }}>
                <span className="label">机器键 reason(可留空)</span>
                <input
                  className="field mono"
                  value={rule.emit.reason ?? ""}
                  placeholder={`user.${rule.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
                  onChange={(event) => patchEmit({ reason: event.target.value || undefined })}
                />
              </label>
              {pack.rules.filter((candidate) => candidate.id === rule.id).length > 1 ? (
                <div className="issue">
                  <span className="path">id</span>
                  <span>这个 id 和另一条规则重复了 —— 保存时会覆盖它</span>
                </div>
              ) : null}
            </div>
          </details>
        </section>

        {/* ── 2 规则 ─────────────────────────────────────────── */}
        <section className="block">
          <header className="block-head">
            <span className="block-no">2</span>
            <span className="block-title">规则</span>
            <span className="block-hint">什么情况下触发</span>
          </header>

          <div className="reading">
            <span className="tag">人话版</span>
            这条规则的意思是：<b>{describeRuleZh(rule)}</b>
          </div>

          <ConditionList when={rule.when} onChange={patchWhen} />
        </section>

        {/* ── 试跑: the loop closed, in place ───────────────── */}
        <RulePreviewPanel
          rule={rule}
          events={events}
          runId={runId}
          runLabel={runLabel}
          onOpenReport={onOpenReport}
        />

        {/* ── 3 报告 ─────────────────────────────────────────── */}
        <section className="block">
          <header className="block-head">
            <span className="block-no">3</span>
            <span className="block-title">报告</span>
            <span className="block-hint">触发后，报告里出现什么</span>
            <span className="spacer" />
            <button className="btn tiny" onClick={onOpenReport} title="到报告面板里看这条规则在当前这一轮上的效果">
              在报告中查看 →
            </button>
          </header>

          <div className="stack" style={{ gap: 5 }}>
            <span className="label">提醒级别</span>
            <div className="level-picker">
              {LEVELS.map((option) => (
                <button
                  key={option.value}
                  className={`level-btn ${option.value}${level === option.value ? " on" : ""}`}
                  onClick={() => patchEmit({ level: option.value })}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="zh-hint">
              {level === "none"
                ? "级别「无」等于关闭这条规则：它仍然存在，但不会在报告里出现。"
                : `报告里的这一条会显示为「${zhLevel(level)}」,并影响整轮的结论。`}
            </span>
          </div>

          <div className="stack" style={{ gap: 5 }}>
            <span className="label">报告标题</span>
            <div className="row">
              <input
                ref={titleRef}
                className="field grow"
                value={rule.emit.title}
                placeholder="例如：连续 {{facts.failureStreak.count}} 条命令失败"
                onChange={(event) => patchEmit({ title: event.target.value })}
              />
              <select
                className="field"
                style={{ width: 132 }}
                value=""
                onChange={(event) => {
                  if (event.target.value) insertVariable(event.target.value);
                }}
                title="把数据插进标题"
              >
                <option value="">插入数据…</option>
                {TEMPLATE_VARS.map((variable) => (
                  <option key={variable.expr} value={variable.expr}>
                    {variable.label}
                  </option>
                ))}
              </select>
            </div>
            <span className="zh-hint">
              双大括号里的内容会在报告里被替换成真实数字，比如 {"{{facts.commands.failed}}"} 会变成 5。
            </span>
          </div>

          <label className="stack" style={{ gap: 5 }}>
            <span className="label">补充说明(可选)</span>
            <textarea
              className="field"
              rows={2}
              value={rule.emit.detail ?? ""}
              placeholder="第二句话：解释为什么值得看一眼，或者建议怎么处理。"
              onChange={(event) => patchEmit({ detail: event.target.value || undefined })}
            />
          </label>

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">附带证据</span>
            <div className="chips">
              {EVIDENCE_CHOICES.map((choice) => {
                const on = evidence.includes(choice.path);
                return (
                  <button
                    key={choice.path}
                    className={`chip-btn${on ? " on" : ""}`}
                    title={`${choice.hint ?? ""}\n${choice.path}`}
                    onClick={() => toggleEvidence(choice.path)}
                  >
                    {on ? "✓ " : ""}
                    {choice.label}
                  </button>
                );
              })}
            </div>
            <input
              className="field mono"
              value={customEvidence.join(", ")}
              placeholder="自定义证据路径，逗号分隔(留空则使用默认)"
              onChange={(event) => {
                const custom = event.target.value
                  .split(",")
                  .map((path) => path.trim())
                  .filter(Boolean);
                const kept = evidence.filter((path) => EVIDENCE_CHOICES.some((choice) => choice.path === path));
                patchEmit({ evidence: [...kept, ...custom] });
              }}
            />
            <span className="zh-hint">
              报告里的「证据事件」就是这些位置指向的事件 id。{evidence.length > 0 ? `当前：${evidence.map(zhEvidence).join("、")}` : "当前没有指定，会使用整轮事件。"}
            </span>
          </div>
        </section>

        {/* ── issues ─────────────────────────────────────────── */}
        {issues.length > 0 ? (
          <section className="block issues-block">
            <header className="block-head">
              <span className="block-title" style={{ color: "var(--high)" }}>
                有 {issues.length} 处需要处理
              </span>
            </header>
            {issues.map((issue, index) => (
              <div className="issue" key={index}>
                <span className="path">{issue.path}</span>
                <span>{issue.message}</span>
              </div>
            ))}
          </section>
        ) : null}
        </div>

        {/* ── the rule as data, next to the form ─────────────── */}
        <div className="rule-json-col">
          <div className="json-col-head">
            <span>原生 JSON</span>
            <span className="spacer" />
            <span className="tiny muted">{rule.id}</span>
            <button className="btn tiny ghost" onClick={() => setJsonOpen(true)} title="放大编辑 / 复制">
              放大
            </button>
          </div>
          <pre className="rule-json mono">{JSON.stringify(rule, null, 2)}</pre>
          <div className="json-col-foot">
            <span className="zh-hint">
              {issues.length > 0 ? `${issues.length} 处问题，见左侧` : "这份 JSON 就是保存的内容，可直接分发。"}
            </span>
          </div>
        </div>
      </div>

      {jsonOpen ? (
        <JsonDialog
          title="规则 JSON"
          subtitle={rule.id}
          value={rule}
          onClose={() => setJsonOpen(false)}
          onCopied={(ok) => onNotify?.(ok ? "已复制规则 JSON" : "复制失败，请手动选择文本", ok ? "info" : "error")}
          onApply={(parsed) => {
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              onNotify?.("规则必须是一个 JSON 对象", "error");
              return;
            }
            const next = parsed as Rule;
            if (typeof next.id !== "string" || next.id.trim().length === 0) {
              onNotify?.("规则需要 id", "error");
              return;
            }
            onChange(next);
            setJsonOpen(false);
          }}
        />      ) : null}
    </div>
  );
}
