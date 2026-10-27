/**
 * A small typed input for a condition's right-hand value.
 *
 * The shape of the value depends on the operator and on the field's kind, and
 * getting that wrong is the most common way a hand-written rule is wrong. So the
 * input adapts:
 *
 *   unary operator        → no input at all
 *   number field          → a number input
 *   boolean field         → a true/false select
 *   in / notIn / between  → a comma-separated list, stored as an array
 *   anything else         → a text input
 */

import type { JsonValue, ScalarOp } from "../../../src/regimen/predicate.ts";
import { isLevel } from "../../../src/core/types.ts";

const UNARY: ReadonlySet<ScalarOp> = new Set<ScalarOp>(["exists", "notExists", "empty", "nonEmpty"]);
const LIST: ReadonlySet<ScalarOp> = new Set<ScalarOp>(["in", "notIn", "between"]);

export function isUnary(op: ScalarOp): boolean {
  return UNARY.has(op);
}

export function ValueInput({
  op,
  kind,
  value,
  choices,
  onChange,
}: {
  op: ScalarOp;
  kind: "string" | "number" | "boolean" | "dateTime" | "array" | "object" | "any";
  value: JsonValue | undefined;
  /** Known values for an enumerated field: a select instead of a text box. */
  choices?: Array<{ value: string; label: string }>;
  onChange: (value: JsonValue | undefined) => void;
}) {
  if (isUnary(op)) return null;

  if (choices && (op === "eq" || op === "ne") && kind === "string") {
    return (
      <select
        className="field grow"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      >
        <option value="">选一个值…</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }

  if (LIST.has(op)) {
    const text = Array.isArray(value) ? value.map((item) => String(item)).join(", ") : "";
    return (
      <input
        className="field"
        value={text}
        placeholder={op === "between" ? "min, max" : "a, b, c"}
        onChange={(event) => {
          const parts = event.target.value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
          if (parts.length === 0) {
            onChange(undefined);
            return;
          }
          onChange(parts.map((part) => (Number.isFinite(Number(part)) && part !== "" ? Number(part) : part)));
        }}
      />
    );
  }

  if (kind === "number" || kind === "dateTime") {
    return (
      <input
        className="field"
        type="number"
        value={typeof value === "number" ? value : value === undefined ? "" : String(value)}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
    );
  }

  if (kind === "boolean") {
    return (
      <select
        className="field"
        value={String(value ?? "")}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? undefined : next === "true");
        }}
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (kind === "object") {
    return (
      <input
        className="field"
        value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)}
        placeholder="{}"
        onChange={(event) => {
          try {
            onChange(event.target.value === "" ? undefined : (JSON.parse(event.target.value) as JsonValue));
          } catch {
            // A half-typed object is not an error until it is saved; keep the text
            // by storing it as a string, which validation will flag if it stays.
            onChange(event.target.value);
          }
        }}
      />
    );
  }

  return (
    <input
      className="field"
      value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
      placeholder={kind === "array" ? "a, b" : "value"}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
    />
  );
}

/** A level select, used by the emit editor. */
export function LevelSelect({ value, onChange }: { value: string; onChange: (level: string) => void }) {
  const levels: Array<{ value: string; label: string }> = [
    { value: "none", label: "无 · 关闭这条规则" },
    { value: "low", label: "提示 · 蓝色，仅记录" },
    { value: "medium", label: "警告 · 琥珀色，值得看一眼" },
    { value: "high", label: "严重 · 红色，需要立刻处理" },
  ];
  return (
    <select
      className="field"
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        if (isLevel(next) || next === "none") onChange(next);
      }}
    >
      {levels.map((level) => (
        <option key={level.value} value={level.value}>
          {level.label}
        </option>
      ))}
    </select>
  );
}
