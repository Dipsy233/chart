/**
 * The condition editor — the "规则" half of a rule.
 *
 * Four kinds of condition, one level deep, never nested:
 *
 *   compare   a field against a threshold          facts.commands.failed ≥ 3
 *   quantify  a list: any / all / none / count     processes.runningAtEnd count ≥ 1
 *   window    events around the anchor             failures in the last 2m ≥ 3
 *   sequence  events in order, within a gap        fail → pass → fail
 *
 * The pickers come from the catalogue, not from a hard-coded list: the field menu
 * is every addressable path grouped by subject, the operator menu is only what
 * that field's type accepts, and a window's `where` only offers payload fields of
 * the event types you selected. There is no "add group" button — `(A and B) or C`
 * is two rules, and the panel says so once.
 *
 * A preset palette sits on top of the empty state. Most rules anyone writes are
 * one of ten shapes, and picking the shape is faster than assembling it.
 */

import { useState } from "react";
import { EVENT_TYPES, allFields, eventFields, type FieldInfo } from "../../../src/editor/catalog.ts";
import {
  operatorsFor,
  type Condition,
  type ScalarOp,
  type ValueKind,
  type When,
} from "../../../src/regimen/predicate.ts";
import { WINDOW_MEASURES, type WindowSpec } from "../../../src/regimen/window.ts";
import type { SequenceSpec } from "../../../src/regimen/sequence.ts";
import {
  CONDITION_PRESETS,
  fieldGroup,
  valueChoices,
  zhEventLabel,
  zhField,
  zhMeasure,
  zhOp,
  zhPayload,
} from "../lib/plain.ts";
import { ValueInput } from "./ValueInput.tsx";

type Kind = "field" | "quant" | "window" | "sequence";

const KIND_LABEL: Record<Kind, string> = {
  field: "比较",
  quant: "统计",
  window: "时间窗口",
  sequence: "顺序步骤",
};

const KIND_HINT: Record<Kind, string> = {
  field: "拿一个数字或一段文字，和阈值比一比",
  quant: "对一个列表做统计：有几个、有没有、是不是每一项都满足",
  window: "只看锚点前后一段时间里的事件，而不是整轮的总数",
  sequence: "事件按先后顺序出现才算，比如 失败 → 成功 → 又失败",
};

/* ── the list ────────────────────────────────────────────────────────────── */

export function ConditionList({
  when,
  onChange,
  eventMode,
  fields,
  palette = true,
}: {
  when: When;
  onChange: (when: When) => void;
  /** Inside a window's `where` or a sequence step: field conditions only. */
  eventMode?: boolean;
  /** The fields this list may address (event payload, array element, …). */
  fields?: FieldInfo[];
  /** The preset palette and the four "add" buttons. */
  palette?: boolean;
}) {
  const [showPresets, setShowPresets] = useState(false);
  const combinator = when.combinator ?? "all";

  const update = (index: number, next: Condition) => {
    const conditions = [...when.conditions];
    conditions[index] = next;
    onChange({ ...when, conditions });
  };
  const remove = (index: number) => {
    onChange({ ...when, conditions: when.conditions.filter((_, i) => i !== index) });
  };
  const add = (condition: Condition) => {
    onChange({ ...when, conditions: [...when.conditions, condition] });
    setShowPresets(false);
  };

  const empty = when.conditions.length === 0;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <div className="segmented">
          <button
            className={combinator === "all" ? "on" : ""}
            onClick={() => onChange({ ...when, combinator: "all" })}
            title="下面每一条都成立，才触发"
          >
            全部满足
          </button>
          <button
            className={combinator === "any" ? "on" : ""}
            onClick={() => onChange({ ...when, combinator: "any" })}
            title="下面任意一条成立，就触发"
          >
            任一满足
          </button>
        </div>
        <span className="zh-hint">
          {combinator === "all" ? "下面每一条都成立，规则才触发" : "下面任意一条成立，规则就触发"}
        </span>
        <span className="spacer" />
        <span className="tiny muted">{when.conditions.length} 个条件</span>
      </div>

      {empty && palette ? (
        <div className="preset-grid">
          {CONDITION_PRESETS.map((preset) => (
            <button key={preset.id} className="preset" onClick={() => add(preset.build())} title={preset.hint}>
              <span className="preset-label">{preset.label}</span>
              <span className="preset-hint">{preset.hint}</span>
            </button>
          ))}
        </div>
      ) : null}

      {when.conditions.map((condition, index) => (
        <ConditionRow
          key={index}
          condition={condition}
          fields={fields}
          onChange={(next) => update(index, next)}
          onRemove={() => remove(index)}
          eventMode={eventMode}
        />
      ))}

      {empty && !palette ? <div className="empty tiny">这一步没有附加条件，匹配该类型的任意事件。</div> : null}

      {palette ? (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="tiny muted">再加一条</span>
          <button className="btn tiny" onClick={() => add(blankCondition("field"))}>
            ＋比较
          </button>
          <button className="btn tiny" onClick={() => add(blankCondition("quant"))}>
            ＋统计
          </button>
          <button className="btn tiny" onClick={() => add(blankCondition("window"))}>
            ＋时间窗口
          </button>
          <button className="btn tiny" onClick={() => add(blankCondition("sequence"))}>
            ＋顺序步骤
          </button>
          <button
            className={`btn tiny${showPresets ? " on" : ""}`}
            onClick={() => setShowPresets((open) => !open)}
            title="从常见场景里挑一条，省得自己拼"
          >
            ＋常用条件
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="btn tiny" onClick={() => add(blankCondition("field"))}>
            ＋条件
          </button>
        </div>
      )}

      {showPresets ? (
        <div className="preset-grid">
          {CONDITION_PRESETS.map((preset) => (
            <button key={preset.id} className="preset" onClick={() => add(preset.build())} title={preset.hint}>
              <span className="preset-label">{preset.label}</span>
              <span className="preset-hint">{preset.hint}</span>
            </button>
          ))}
        </div>
      ) : null}

      {!eventMode && !empty ? (
        <div className="zh-hint">
          需要「A 而且 B,或者 C」?拆成两条规则 —— 规则语言只有一层，不提供嵌套。
        </div>
      ) : null}
    </div>
  );
}

function blankCondition(kind: Kind): Condition {
  if (kind === "sequence") {
    return {
      sequence: {
        steps: [
          { type: ["command"], where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] }, as: "失败" },
          { type: ["command"], where: { conditions: [{ field: "payload.exitCode", op: "eq", value: 0 }] }, as: "恢复" },
        ],
        gap: { maxEvents: 30, maxMs: 600_000 },
      },
    };
  }
  if (kind === "window") {
    return {
      window: {
        events: { type: ["command"] },
        span: { lastMs: 120_000 },
        measure: "count",
        op: "gte",
        value: 1,
      },
    };
  }
  if (kind === "quant") {
    return { field: "facts.processes.runningAtEnd", quant: "count", op: "gte", value: 1 };
  }
  return { field: "facts.commands.failed", op: "gte", value: 1 };
}

/* ── one row ─────────────────────────────────────────────────────────────── */

function ConditionRow({
  condition,
  fields,
  onChange,
  onRemove,
  eventMode,
}: {
  condition: Condition;
  fields?: FieldInfo[];
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  eventMode?: boolean;
}) {
  const kind: Kind = "window" in condition ? "window" : "quant" in condition ? "quant" : "sequence" in condition ? "sequence" : "field";

  return (
    <div className={`cond ${kind}`}>
      <div className="cond-head">
        <span className="kind">{KIND_LABEL[kind]}</span>
        <span className="kind-hint">{KIND_HINT[kind]}</span>
        <span className="spacer" />
        <button className="btn tiny ghost danger" title="删掉这个条件" onClick={onRemove}>
          ✕
        </button>
      </div>

      {"window" in condition ? (
        <WindowRow spec={condition.window} onChange={(window) => onChange({ window })} />
      ) : "quant" in condition ? (
        <QuantRow condition={condition} onChange={onChange} />
      ) : "sequence" in condition ? (
        <SequenceRow spec={condition.sequence} onChange={(sequence) => onChange({ sequence })} />
      ) : (
        <FieldRow condition={condition} fields={fields} eventMode={eventMode} onChange={onChange} />
      )}
    </div>
  );
}

/* ── compare ─────────────────────────────────────────────────────────────── */

function FieldRow({
  condition,
  fields,
  eventMode,
  onChange,
}: {
  condition: Extract<Condition, { field: string; op: ScalarOp }>;
  fields?: FieldInfo[];
  eventMode?: boolean;
  onChange: (condition: Condition) => void;
}) {
  const options = fields ?? (eventMode ? eventFields(undefined) : allFields());
  const info = findField(options, condition.field);
  const kind: ValueKind = info?.kind ?? "any";
  const operators = operatorsFor(kind);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="cond-row">
        <FieldSelect
          value={condition.field}
          fields={options}
          grouped={!eventMode && !fields}
          onChange={(next) => {
            const nextInfo = findField(options, next);
            const nextOperators = operatorsFor(nextInfo?.kind ?? "any");
            const keep = nextOperators.some((operator) => operator.operation === condition.op);
            onChange({
              field: next,
              op: keep ? condition.op : (nextOperators[0]?.operation ?? "eq"),
              value: nextInfo?.kind === "boolean" ? true : condition.value,
            } as Condition);
          }}
        />
        <select
          className="field op"
          value={condition.op}
          onChange={(event) => onChange({ ...condition, op: event.target.value as ScalarOp })}
        >
          {operators.map((operator) => (
            <option key={`${operator.type}:${operator.operation}`} value={operator.operation}>
              {zhOp(operator.operation)}
            </option>
          ))}
        </select>
        <ValueInput
          op={condition.op}
          kind={kind}
          value={condition.value}
          choices={valueChoices(condition.field)}
          onChange={(value) => onChange({ ...condition, value })}
        />
      </div>
      <span className="field-path">{condition.field}</span>
    </div>
  );
}

/* ── quantify ────────────────────────────────────────────────────────────── */

function QuantRow({
  condition,
  onChange,
}: {
  condition: Extract<Condition, { quant: unknown }>;
  onChange: (condition: Condition) => void;
}) {
  const lists = allFields().filter((field) => field.kind === "array" || field.kind === "object");
  const info = lists.find((field) => field.path === condition.field);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="cond-row">
        <FieldSelect
          value={condition.field}
          fields={lists}
          grouped
          onChange={(next) => onChange({ ...condition, field: next, where: undefined })}
        />
        <select
          className="field op"
          value={condition.quant}
          onChange={(event) => onChange({ ...condition, quant: event.target.value as never })}
        >
          <option value="count">项数</option>
          <option value="any">其中任一项</option>
          <option value="all">每一项都</option>
          <option value="none">没有任何一项</option>
        </select>
        {condition.quant === "count" ? (
          <>
            <select
              className="field op"
              value={condition.op ?? "gte"}
              onChange={(event) => onChange({ ...condition, op: event.target.value as ScalarOp })}
            >
              {operatorsFor("number").map((operator) => (
                <option key={operator.operation} value={operator.operation}>
                  {zhOp(operator.operation)}
                </option>
              ))}
            </select>
            <input
              className="field num"
              type="number"
              value={typeof condition.value === "number" ? condition.value : 1}
              onChange={(event) => onChange({ ...condition, value: Number(event.target.value) })}
            />
          </>
        ) : (
          <span className="zh-hint">满足下面条件的项</span>
        )}
      </div>
      <span className="field-path">{condition.field}</span>

      {info?.element ? (
        <div className="subrows">
          <span className="zh-hint">其中每一项要满足…</span>
          <ConditionList
            when={condition.where ?? { conditions: [] }}
            fields={info.element}
            palette={false}
            onChange={(where) => onChange({ ...condition, where: where.conditions.length > 0 ? where : undefined })}
          />
        </div>
      ) : (
        <div className="zh-hint">选一个列表字段，就能进一步筛选其中的每一项。</div>
      )}
    </div>
  );
}

/* ── sequence ────────────────────────────────────────────────────────────── */

function SequenceRow({ spec, onChange }: { spec: SequenceSpec; onChange: (spec: SequenceSpec) => void }) {
  const gap = spec.gap ?? {};
  return (
    <div className="stack" style={{ gap: 8 }}>
      {spec.steps.map((step, index) => {
        const types = step.type === undefined ? [] : Array.isArray(step.type) ? step.type : [step.type];
        return (
          <div key={index} className="subrows">
            <div className="cond-row">
              <span className="step-no">第 {index + 1} 步</span>
              <select
                className="field"
                value={types[0] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    steps: spec.steps.map((candidate, position) =>
                      position === index
                        ? { ...candidate, type: event.target.value ? [event.target.value] : undefined }
                        : candidate,
                    ),
                  })
                }
              >
                <option value="">任意事件</option>
                {EVENT_TYPES.map((info) => (
                  <option key={info.type} value={info.type}>
                    {zhEventLabel(info.type)}
                  </option>
                ))}
              </select>
              <input
                className="field"
                placeholder="给这一步起名(可选)"
                value={step.as ?? ""}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    steps: spec.steps.map((candidate, position) =>
                      position === index ? { ...candidate, as: event.target.value || undefined } : candidate,
                    ),
                  })
                }
              />
              <span className="spacer" />
              <button
                className="btn tiny ghost danger"
                disabled={spec.steps.length <= 2}
                title="删掉这一步"
                onClick={() => onChange({ ...spec, steps: spec.steps.filter((_, position) => position !== index) })}
              >
                −
              </button>
            </div>
            <ConditionList
              when={step.where ?? { conditions: [] }}
              fields={eventFields(types.length > 0 ? types : undefined)}
              eventMode
              palette={false}
              onChange={(where) =>
                onChange({
                  ...spec,
                  steps: spec.steps.map((candidate, position) =>
                    position === index
                      ? { ...candidate, where: where.conditions.length > 0 ? where : undefined }
                      : candidate,
                  ),
                })
              }
            />
          </div>
        );
      })}

      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <button className="btn tiny" onClick={() => onChange({ ...spec, steps: [...spec.steps, { type: ["command"] }] })}>
          ＋加一步
        </button>
        <span className="zh-hint">步与步之间 ≤</span>
        <input
          className="field num"
          type="number"
          value={gap.maxEvents ?? 500}
          onChange={(event) => onChange({ ...spec, gap: { ...gap, maxEvents: Number(event.target.value) } })}
        />
        <span className="zh-hint">个事件，或 ≤</span>
        <input
          className="field num"
          type="number"
          value={Math.round((gap.maxMs ?? 3_600_000) / 1000)}
          onChange={(event) => onChange({ ...spec, gap: { ...gap, maxMs: Number(event.target.value) * 1000 } })}
        />
        <span className="zh-hint">秒</span>
        <span className="spacer" />
        <span className="zh-hint">整段出现</span>
        <input
          className="field num"
          type="number"
          value={spec.times ?? 1}
          onChange={(event) => onChange({ ...spec, times: Math.max(1, Number(event.target.value)) })}
        />
        <span className="zh-hint">次</span>
      </div>
    </div>
  );
}

/* ── window ──────────────────────────────────────────────────────────────── */

function WindowRow({ spec, onChange }: { spec: WindowSpec; onChange: (spec: WindowSpec) => void }) {
  const types = normalizeTypes(spec.events?.type);
  const spanKind =
    spec.span?.lastMs !== undefined && spec.span?.nextMs !== undefined
      ? "both"
      : spec.span?.lastMs !== undefined
        ? "last"
        : spec.span?.nextMs !== undefined
          ? "next"
          : "none";
  const spanAmount = spec.span?.lastMs ?? spec.span?.nextMs ?? 120_000;
  const setSpan = (kind: string, amount: number) => {
    if (kind === "none") return onChange({ ...spec, span: undefined });
    if (kind === "last") return onChange({ ...spec, span: { lastMs: amount } });
    if (kind === "next") return onChange({ ...spec, span: { nextMs: amount } });
    onChange({ ...spec, span: { lastMs: amount, nextMs: amount } });
  };
  const needsField = ["sum", "max", "min", "avg", "distinct"].includes(spec.measure);
  const eventFieldList = eventFields(types.length > 0 ? types : undefined);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="cond-row">
        <span className="cond-key">事件</span>
        <div className="chips">
          {EVENT_TYPES.map((info) => {
            const on = types.includes(info.type);
            return (
              <button
                key={info.type}
                className={`chip-btn${on ? " on" : ""}`}
                title={info.hint}
                onClick={() => {
                  const next = on ? types.filter((type) => type !== info.type) : [...types, info.type];
                  onChange({ ...spec, events: { ...spec.events, type: next.length > 0 ? next : undefined } });
                }}
              >
                {zhEventLabel(info.type)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cond-row">
        <span className="cond-key">范围</span>
        <select className="field op" value={spanKind} onChange={(event) => setSpan(event.target.value, spanAmount)}>
          <option value="none">整轮运行</option>
          <option value="last">锚点往前</option>
          <option value="next">锚点往后</option>
          <option value="both">锚点前后各</option>
        </select>
        {spanKind !== "none" ? (
          <>
            <input
              className="field num"
              type="number"
              value={Math.round(spanAmount / 1000)}
              onChange={(event) => setSpan(spanKind, Math.max(0, Number(event.target.value)) * 1000)}
            />
            <span className="zh-hint">秒</span>
          </>
        ) : (
          <span className="zh-hint">不按时间切，看整轮</span>
        )}
      </div>

      <div className="cond-row">
        <span className="cond-key">统计</span>
        <select
          className="field op"
          value={spec.measure}
          onChange={(event) => onChange({ ...spec, measure: event.target.value as never })}
        >
          {WINDOW_MEASURES.map((measure) => (
            <option key={measure} value={measure}>
              {zhMeasure(measure)}
            </option>
          ))}
        </select>
        {needsField ? (
          <select
            className="field"
            value={spec.of ?? ""}
            onChange={(event) => onChange({ ...spec, of: event.target.value || undefined })}
            title="要拿来做统计的字段"
          >
            <option value="">选字段…</option>
            {eventFieldList.map((field) => (
              <option key={field.path} value={field.path}>
                {zhPayload(field.path)}
              </option>
            ))}
          </select>
        ) : null}
        <select
          className="field op"
          value={spec.op}
          onChange={(event) => onChange({ ...spec, op: event.target.value as ScalarOp })}
        >
          {operatorsFor("number").map((operator) => (
            <option key={operator.operation} value={operator.operation}>
              {zhOp(operator.operation)}
            </option>
          ))}
        </select>
        <input
          className="field num"
          type="number"
          value={typeof spec.value === "number" ? spec.value : 0}
          onChange={(event) => onChange({ ...spec, value: Number(event.target.value) })}
        />
      </div>

      <div className="subrows">
        <span className="zh-hint">只统计满足下面条件的事件</span>
        <ConditionList
          when={spec.events?.where ?? { conditions: [] }}
          fields={eventFieldList}
          eventMode
          palette={false}
          onChange={(where) =>
            onChange({ ...spec, events: { ...spec.events, where: where.conditions.length > 0 ? where : undefined } })
          }
        />
      </div>
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

function FieldSelect({
  value,
  fields,
  grouped,
  onChange,
}: {
  value: string;
  fields: FieldInfo[];
  grouped?: boolean;
  onChange: (path: string) => void;
}) {
  if (!grouped) {
    return (
      <select className="field grow" value={value} onChange={(event) => onChange(event.target.value)}>
        {fields.map((field) => (
          <option key={field.path} value={field.path}>
            {fieldLabel(field.path)}
          </option>
        ))}
      </select>
    );
  }

  const groups = new Map<string, FieldInfo[]>();
  for (const field of fields) {
    const group = fieldGroup(field.path);
    const list = groups.get(group) ?? [];
    list.push(field);
    groups.set(group, list);
  }
  return (
    <select className="field grow" value={value} onChange={(event) => onChange(event.target.value)}>
      {[...groups.entries()].map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((field) => (
            <option key={field.path} value={field.path}>
              {fieldLabel(field.path)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function fieldLabel(path: string): string {
  if (path.startsWith("facts.") || path.startsWith("live.")) return zhField(path);
  return zhPayload(path);
}

function findField(fields: FieldInfo[], path: string): FieldInfo | undefined {
  return fields.find((field) => field.path === path);
}

function normalizeTypes(type: string | string[] | undefined): string[] {
  if (type === undefined) return [];
  return Array.isArray(type) ? type : [type];
}
