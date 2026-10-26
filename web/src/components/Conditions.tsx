/**
 * The condition rows — the n8n IF/Filter shape, one level deep.
 *
 * There is deliberately no "add group" button: `(A and B) or C` is two rules.
 * The UI says so once, in the empty state, and then never offers the trap.
 */

import { EVENT_TYPES, allFields, eventFields, fieldFor } from "../../../src/editor/catalog.ts";
import { operatorsForField } from "../../../src/editor/draft.ts";
import { WINDOW_MEASURES, type WindowSpec } from "../../../src/regimen/window.ts";
import type { SequenceSpec } from "../../../src/regimen/sequence.ts";
import type { Condition, JsonValue, ScalarOp, When } from "../../../src/regimen/predicate.ts";
import { ValueInput, isUnary } from "./ValueInput.tsx";

/* ── one flat list of conditions ─────────────────────────────────────────── */

export function ConditionList({
  when,
  onChange,
  eventMode,
}: {
  when: When;
  onChange: (when: When) => void;
  /** Inside a window's `where` or a quantifier's `where`: field conditions only. */
  eventMode?: boolean;
}) {
  const combinator = when.combinator ?? "all";

  const update = (index: number, next: Condition) => {
    const conditions = [...when.conditions];
    conditions[index] = next;
    onChange({ ...when, conditions });
  };

  const remove = (index: number) => {
    onChange({ ...when, conditions: when.conditions.filter((_, i) => i !== index) });
  };

  const add = (kind: "field" | "quant" | "window" | "sequence") => {
    onChange({ ...when, conditions: [...when.conditions, blankCondition(kind)] });
  };

  return (
    <div className="stack">
      <div className="row">
        <select
          className="field"
          style={{ width: 74 }}
          value={combinator}
          onChange={(event) => onChange({ ...when, combinator: event.target.value as "all" | "any" })}
        >
          <option value="all">all of</option>
          <option value="any">any of</option>
        </select>
        <span className="tiny muted">
          {when.conditions.length} condition{when.conditions.length === 1 ? "" : "s"}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {eventMode ? null : (
          <>
            <button className="btn tiny" onClick={() => add("field")}>
              + compare
            </button>
            <button className="btn tiny" onClick={() => add("quant")}>
              + quantify
            </button>
            <button className="btn tiny" onClick={() => add("window")}>
              + window
            </button>
            <button className="btn tiny" onClick={() => add("sequence")}>
              + sequence
            </button>
          </>
        )}
        {eventMode ? (
          <button className="btn tiny" onClick={() => add("field")}>
            + condition
          </button>
        ) : null}
      </div>

      {when.conditions.length === 0 ? (
        <div className="empty tiny">No conditions. A rule with none never fires.</div>
      ) : null}

      {when.conditions.map((condition, index) => (
        <ConditionRow
          key={index}
          condition={condition}
          onChange={(next) => update(index, next)}
          onRemove={() => remove(index)}
          eventMode={eventMode}
        />
      ))}
    </div>
  );
}

function blankCondition(kind: "field" | "quant" | "window" | "sequence"): Condition {
  if (kind === "sequence") {
    return {
      sequence: {
        steps: [
          { type: ["command"], where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] }, as: "failed" },
          { type: ["command"], where: { conditions: [{ field: "payload.exitCode", op: "eq", value: 0 }] }, as: "recovered" },
          { type: ["command"], where: { conditions: [{ field: "payload.exitCode", op: "ne", value: 0 }] }, as: "brokeAgain" },
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
  onChange,
  onRemove,
  eventMode,
}: {
  condition: Condition;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  eventMode?: boolean;
}) {
  if ("window" in condition) {
    return <WindowRow spec={condition.window} onChange={(window) => onChange({ window })} onRemove={onRemove} />;
  }

  if ("quant" in condition) {
    return <QuantRow condition={condition} onChange={onChange} onRemove={onRemove} />;
  }

  if ("sequence" in condition) {
    return <SequenceRow spec={condition.sequence} onChange={(sequence) => onChange({ sequence })} onRemove={onRemove} />;
  }

  return <FieldRow condition={condition} onChange={onChange} onRemove={onRemove} eventMode={eventMode} />;
}

/* ── field comparison ────────────────────────────────────────────────────── */

function FieldRow({
  condition,
  onChange,
  onRemove,
  eventMode,
}: {
  condition: Extract<Condition, { field: string; op: ScalarOp }>;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  eventMode?: boolean;
}) {
  const fields = eventMode ? eventFields(undefined) : allFields();
  const info = eventMode ? eventFields(undefined).find((field) => field.path === condition.field) : fieldFor(condition.field);
  const kind = info?.kind ?? "any";
  const operators = eventMode
    ? eventOperatorsFor(condition.field)
    : operatorsForField(condition.field);

  return (
    <div className="cond">
      <div className="cond-head">
        <span className="kind">compare</span>
        <span className="spacer" />
        <button className="btn tiny danger" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="row">
        <select
          className="field"
          value={condition.field}
          onChange={(event) => {
            const next = event.target.value;
            const nextInfo = fields.find((field) => field.path === next);
            const nextOperators = eventMode ? eventOperatorsFor(next) : operatorsForField(next);
            const keep = nextOperators.some((operator) => operator.operation === condition.op);
            onChange({
              field: next,
              op: keep ? condition.op : (nextOperators[0]?.operation ?? "eq"),
              value: nextInfo?.kind === "boolean" ? true : condition.value,
            } as Condition);
          }}
        >
          {fields.map((field) => (
            <option key={field.path} value={field.path}>
              {field.path}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <select
          className="field"
          style={{ width: 150 }}
          value={condition.op}
          onChange={(event) => onChange({ ...condition, op: event.target.value as ScalarOp })}
        >
          {operators.map((operator) => (
            <option key={`${operator.type}:${operator.operation}`} value={operator.operation}>
              {operator.label}
            </option>
          ))}
        </select>
        <ValueInput
          op={condition.op}
          kind={kind}
          value={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
        />
      </div>
    </div>
  );
}

/** Operators for an event field: string-ish, number-ish, boolean, or universal. */
function eventOperatorsFor(path: string) {
  const info = eventFields(undefined).find((field) => field.path === path);
  return operatorsForField(`event:${info?.kind ?? "string"}`).length > 0
    ? operatorsFor(info?.kind ?? "string")
    : operatorsFor("string");
}

function operatorsFor(kind: "string" | "number" | "boolean" | "dateTime" | "array" | "object" | "any") {
  const field = kind === "number" || kind === "dateTime" ? "facts.commands.failed" : "facts.response";
  const operators = operatorsForField(field);
  if (kind === "boolean") {
    return operatorsForField("facts.ended");
  }
  return operators;
}

/* ── quantifier ──────────────────────────────────────────────────────────── */

function QuantRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: Extract<Condition, { quant: unknown }>;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
}) {
  const info = fieldFor(condition.field);
  return (
    <div className="cond quant">
      <div className="cond-head">
        <span className="kind">quantify</span>
        <span className="spacer" />
        <button className="btn tiny danger" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="row">
        <select
          className="field"
          value={condition.field}
          onChange={(event) => onChange({ ...condition, field: event.target.value })}
        >
          {allFields()
            .filter((field) => field.kind === "array" || field.kind === "object")
            .map((field) => (
              <option key={field.path} value={field.path}>
                {field.path}
              </option>
            ))}
        </select>
      </div>
      <div className="row">
        <select
          className="field"
          style={{ width: 90 }}
          value={condition.quant}
          onChange={(event) => onChange({ ...condition, quant: event.target.value as never })}
        >
          <option value="any">any</option>
          <option value="all">all</option>
          <option value="none">none</option>
          <option value="count">count</option>
        </select>
        {condition.quant === "count" ? (
          <>
            <select
              className="field"
              style={{ width: 90 }}
              value={condition.op ?? "gte"}
              onChange={(event) => onChange({ ...condition, op: event.target.value as ScalarOp })}
            >
              {operatorsForField("facts.commands.failed").map((operator) => (
                <option key={operator.operation} value={operator.operation}>
                  {operator.label}
                </option>
              ))}
            </select>
            <input
              className="field"
              type="number"
              style={{ width: 70 }}
              value={typeof condition.value === "number" ? condition.value : 1}
              onChange={(event) => onChange({ ...condition, value: Number(event.target.value) })}
            />
          </>
        ) : null}
      </div>
      {info?.element ? (
        <div className="subrows">
          <span className="tiny muted">where the element…</span>
          <ConditionList
            when={condition.where ?? { conditions: [] }}
            eventMode={false}
            onChange={(where) => onChange({ ...condition, where })}
          />
          <div className="tiny muted">
            element fields: {info.element.map((field) => field.path).join(", ")}
          </div>
        </div>
      ) : (
        <div className="tiny muted">Pick an array field to filter its elements.</div>
      )}
    </div>
  );
}

/* ── sequence ────────────────────────────────────────────────────────────── */

function SequenceRow({
  spec,
  onChange,
  onRemove,
}: {
  spec: SequenceSpec;
  onChange: (spec: SequenceSpec) => void;
  onRemove: () => void;
}) {
  const gap = spec.gap ?? {};
  return (
    <div className="cond sequence" style={{ borderLeft: "2px solid rgba(232,169,74,.5)" }}>
      <div className="cond-head">
        <span className="kind">sequence · ordered steps</span>
        <span className="spacer" />
        <button className="btn tiny danger" onClick={onRemove}>
          ✕
        </button>
      </div>

      {spec.steps.map((step, index) => (
        <div key={index} className="subrows">
          <div className="row">
            <span className="tiny muted" style={{ width: 46 }}>
              step {index + 1}
            </span>
            <select
              className="field"
              style={{ width: 120 }}
              value={Array.isArray(step.type) ? step.type[0] ?? "" : (step.type ?? "")}
              onChange={(event) => {
                const next = spec.steps.map((candidate, position) =>
                  position === index
                    ? { ...candidate, type: event.target.value ? [event.target.value] : undefined }
                    : candidate,
                );
                onChange({ ...spec, steps: next });
              }}
            >
              <option value="">any event</option>
              {EVENT_TYPES.map((info) => (
                <option key={info.type} value={info.type}>
                  {info.label}
                </option>
              ))}
            </select>
            <input
              className="field"
              style={{ width: 90 }}
              placeholder="label"
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
            <span className="spacer" style={{ flex: 1 }} />
            <button
              className="btn tiny danger"
              disabled={spec.steps.length <= 2}
              onClick={() => onChange({ ...spec, steps: spec.steps.filter((_, position) => position !== index) })}
            >
              −
            </button>
          </div>
          <ConditionList
            when={step.where ?? { conditions: [] }}
            eventMode
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
      ))}

      <div className="row">
        <button
          className="btn tiny"
          onClick={() => onChange({ ...spec, steps: [...spec.steps, { type: ["command"] }] })}
        >
          + step
        </button>
        <span className="tiny muted" style={{ marginLeft: 10 }}>
          gap ≤
        </span>
        <input
          className="field"
          type="number"
          style={{ width: 70 }}
          value={gap.maxEvents ?? 500}
          onChange={(event) => onChange({ ...spec, gap: { ...gap, maxEvents: Number(event.target.value) } })}
        />
        <span className="tiny muted">events</span>
        <input
          className="field"
          type="number"
          style={{ width: 80 }}
          value={Math.round((gap.maxMs ?? 3_600_000) / 1000)}
          onChange={(event) =>
            onChange({ ...spec, gap: { ...gap, maxMs: Number(event.target.value) * 1000 } })
          }
        />
        <span className="tiny muted">seconds</span>
        <span className="tiny muted" style={{ marginLeft: 10 }}>
          times
        </span>
        <input
          className="field"
          type="number"
          style={{ width: 60 }}
          value={spec.times ?? 1}
          onChange={(event) => onChange({ ...spec, times: Math.max(1, Number(event.target.value)) })}
        />
      </div>
    </div>
  );
}

/* ── window ──────────────────────────────────────────────────────────────── */

function WindowRow({
  spec,
  onChange,
  onRemove,
}: {
  spec: WindowSpec;
  onChange: (spec: WindowSpec) => void;
  onRemove: () => void;
}) {
  const types = normalizeTypes(spec.events?.type);
  const spanKind =
    spec.span?.lastMs !== undefined && spec.span?.nextMs !== undefined
      ? "both"
      : spec.span?.lastMs !== undefined
        ? "last"
        : spec.span?.nextMs !== undefined
          ? "next"
          : "none";

  const setSpan = (kind: string, amount: number) => {
    if (kind === "none") return onChange({ ...spec, span: undefined });
    if (kind === "last") return onChange({ ...spec, span: { lastMs: amount } });
    if (kind === "next") return onChange({ ...spec, span: { nextMs: amount } });
    onChange({ ...spec, span: { lastMs: amount, nextMs: amount } });
  };

  const spanAmount = spec.span?.lastMs ?? spec.span?.nextMs ?? 120_000;

  return (
    <div className="cond window">
      <div className="cond-head">
        <span className="kind">window · scan the stream</span>
        <span className="spacer" />
        <button className="btn tiny danger" onClick={onRemove}>
          ✕
        </button>
      </div>

      <div className="row">
        <span className="tiny muted" style={{ width: 52 }}>
          events
        </span>
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          {EVENT_TYPES.map((info) => {
            const on = types.includes(info.type);
            return (
              <button
                key={info.type}
                className={`btn tiny${on ? " on" : ""}`}
                title={info.hint}
                onClick={() => {
                  const next = on ? types.filter((type) => type !== info.type) : [...types, info.type];
                  onChange({
                    ...spec,
                    events: { ...spec.events, type: next.length > 0 ? next : undefined },
                  });
                }}
              >
                {info.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="row">
        <span className="tiny muted" style={{ width: 52 }}>
          span
        </span>
        <select
          className="field"
          style={{ width: 110 }}
          value={spanKind}
          onChange={(event) => setSpan(event.target.value, spanAmount)}
        >
          <option value="none">whole run</option>
          <option value="last">last …</option>
          <option value="next">next …</option>
          <option value="both">± …</option>
        </select>
        {spanKind !== "none" ? (
          <>
            <input
              className="field"
              type="number"
              style={{ width: 80 }}
              value={Math.round(spanAmount / 1000)}
              onChange={(event) => setSpan(spanKind, Math.max(0, Number(event.target.value)) * 1000)}
            />
            <span className="tiny muted">seconds around the anchor</span>
          </>
        ) : (
          <span className="tiny muted">the anchor is the whole run</span>
        )}
      </div>

      <div className="row">
        <span className="tiny muted" style={{ width: 52 }}>
          measure
        </span>
        <select
          className="field"
          style={{ width: 110 }}
          value={spec.measure}
          onChange={(event) => onChange({ ...spec, measure: event.target.value as never })}
        >
          {WINDOW_MEASURES.map((measure) => (
            <option key={measure} value={measure}>
              {measure}
            </option>
          ))}
        </select>
        {["sum", "max", "min", "avg", "distinct"].includes(spec.measure) ? (
          <input
            className="field"
            placeholder="payload.exitCode"
            value={spec.of ?? ""}
            onChange={(event) => onChange({ ...spec, of: event.target.value || undefined })}
          />
        ) : null}
        <select
          className="field"
          style={{ width: 110 }}
          value={spec.op}
          onChange={(event) => onChange({ ...spec, op: event.target.value as ScalarOp })}
        >
          {operatorsForField("facts.commands.failed").map((operator) => (
            <option key={operator.operation} value={operator.operation}>
              {operator.label}
            </option>
          ))}
        </select>
        <input
          className="field"
          type="number"
          style={{ width: 70 }}
          value={typeof spec.value === "number" ? spec.value : 0}
          onChange={(event) => onChange({ ...spec, value: Number(event.target.value) })}
        />
      </div>

      <div className="subrows">
        <span className="tiny muted">
          only events that match (fields: {eventFields(types).map((field) => field.path.replace(/^payload\./, "")).join(", ")})
        </span>
        <ConditionList
          when={spec.events?.where ?? { conditions: [] }}
          eventMode
          onChange={(where) =>
            onChange({ ...spec, events: { ...spec.events, where: where.conditions.length > 0 ? where : undefined } })
          }
        />
      </div>
    </div>
  );
}

function normalizeTypes(type: string | string[] | undefined): string[] {
  if (type === undefined) return [];
  return Array.isArray(type) ? type : [type];
}
