/**
 * The event detail panel — the third column of the event view.
 *
 * An event is a form, not a blob of JSON: the type, the time, and the payload
 * fields the catalogue says matter for that type. The raw payload stays one
 * disclosure away, for anything the form does not cover. Reordering lives on
 * the cards' drag grip — a ±1 pair of buttons here could not agree with the
 * scope filter about what "one position" means.
 *
 * No judgement appears here. Facts and findings belong to the report panel; this
 * panel is only about the record itself.
 */

import { useEffect, useRef, useState } from "react";
import { EVENT_TYPES, EVENT_FIELDS } from "../../../src/editor/catalog.ts";
import type { ChartEvent, ChartEventType } from "../../../src/core/events.ts";
import { defaultPayload, fieldsFor, getPath, renumber, setPath } from "../lib/events.ts";
import { formatSpan } from "../lib/runs.ts";
import { zhEventLabel, zhPayload } from "../lib/plain.ts";

export function EventDetail({
  events,
  index,
  runLabel,
  position,
  onChange,
  onSelect,
}: {
  events: ChartEvent[];
  index: number | undefined;
  runLabel?: string;
  /** Where this event sits in the current scope, for the header. */
  position?: { index: number; total: number };
  onChange: (events: ChartEvent[]) => void;
  onSelect: (index: number | undefined) => void;
}) {
  const event = index === undefined ? undefined : events[index];
  const [raw, setRaw] = useState("");
  // While the raw editor has focus it owns the text; otherwise it follows the
  // form, so editing a payload field is visible in the JSON immediately.
  const rawFocused = useRef(false);

  useEffect(() => {
    if (rawFocused.current) return;
    setRaw(event ? JSON.stringify(event.payload, null, 2) : "");
  }, [event?.id, event?.payload, index]);

  if (!event || index === undefined) {
    return (
      <div className="col event-main">
        <div className="pane-head">
          <span>事件详情</span>
        </div>
        <div className="pane-body">
          <div className="empty">在左边选一个事件，这里会展开它的全部内容。</div>
        </div>
      </div>
    );
  }

  const replace = (next: ChartEvent) => {
    const copy = [...events];
    copy[index] = next;
    onChange(copy);
  };

  const remove = () => {
    onChange(events.filter((_, position) => position !== index));
    onSelect(index > 0 ? index - 1 : events.length > 1 ? 0 : undefined);
  };

  const duplicate = () => {
    const copy = [...events];
    copy.splice(index + 1, 0, { ...structuredClone(event), timestamp: event.timestamp + 1_000 });
    onChange(renumber(copy));
    onSelect(index + 1);
  };

  const first = events[0]?.timestamp ?? event.timestamp;

  return (
    <div className="col event-main">
      <div className="pane-head">
        <span>事件详情</span>
        <span className="spacer" />
        <span className="tiny muted">
          第 {(position?.index ?? index) + 1} / {position?.total ?? events.length} 个
        </span>
        <button className="btn tiny" onClick={duplicate} title="复制这个事件">
          复制
        </button>
        <button className="btn tiny ghost danger" onClick={remove} title="删除这个事件">
          删除
        </button>
      </div>

      <div className="pane-body event-editor">
        <section className="block">
          <header className="block-head">
            <span className="block-no">1</span>
            <span className="block-title">基本信息</span>
            <span className="spacer" />
            {runLabel ? <span className="chip none">{runLabel}</span> : null}
          </header>

          <div className="grid2">
            <label className="stack" style={{ gap: 4 }}>
              <span className="label">事件类型</span>
              <select
                className="field"
                value={event.type}
                onChange={(event_) => {
                  const type = event_.target.value as ChartEventType;
                  replace({
                    id: event.id,
                    sessionId: event.sessionId,
                    timestamp: event.timestamp,
                    type,
                    payload: defaultPayload(type),
                  } as ChartEvent);
                }}
              >
                {EVENT_TYPES.map((info) => (
                  <option key={info.type} value={info.type}>
                    {zhEventLabel(info.type)} · {info.type}
                  </option>
                ))}
              </select>
            </label>

            <label className="stack" style={{ gap: 4 }}>
              <span className="label">发生时间</span>
              <input
                className="field mono"
                type="datetime-local"
                step={1}
                value={toLocalInput(event.timestamp)}
                onChange={(event_) => {
                  const next = fromLocalInput(event_.target.value);
                  if (next !== undefined) replace({ ...event, timestamp: next });
                }}
              />
              <span className="zh-hint">相对这一轮开始 +{formatSpan(Math.max(0, event.timestamp - first))}</span>
            </label>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <span className="kv-inline">
              <span className="k">事件 id</span>
              <span className="v mono">{event.id}</span>
            </span>
            <span className="kv-inline">
              <span className="k">会话</span>
              <span className="v mono">{event.sessionId}</span>
            </span>
            <span className="spacer" />
            <button
              className="btn tiny"
              title="把时间改成紧挨着上一个事件之后 5 秒"
              onClick={() => {
                const previous = events[index - 1];
                replace({ ...event, timestamp: (previous?.timestamp ?? event.timestamp) + 5_000 });
              }}
            >
              接上一个
            </button>
          </div>
        </section>

        <section className="block">
          <header className="block-head">
            <span className="block-no">2</span>
            <span className="block-title">内容</span>
            <span className="block-hint">这个事件携带的数据</span>
          </header>

          <div className="payload-form">
            {fieldsFor(event.type).map((field) => {
              const path = field.path.replace(/^payload\./, "");
              return (
                <PayloadField
                  key={path}
                  label={zhPayload(path)}
                  path={path}
                  payload={event.payload}
                  onChange={(value) => replace({ ...event, payload: setPath(event.payload, path, value) } as ChartEvent)}
                />
              );
            })}
            {EVENT_FIELDS[event.type].length === 0 ? (
              <div className="empty tiny">这个类型没有可编辑的字段。</div>
            ) : null}
          </div>
          <span className="zh-hint">没列出来的字段，用下面的「原始 JSON」改。</span>
        </section>

        <section className="block">
          <header className="block-head">
            <span className="block-no">3</span>
            <span className="block-title">原始 JSON</span>
            <span className="block-hint">表单覆盖不到的字段在这里改</span>
          </header>
          <textarea
            className="field mono raw-json"
            rows={10}
            value={raw}
            onChange={(event_) => setRaw(event_.target.value)}
            onFocus={() => {
              rawFocused.current = true;
            }}
            onBlur={() => {
              rawFocused.current = false;
              try {
                replace({ ...event, payload: JSON.parse(raw) } as ChartEvent);
              } catch {
                // Still typing: keep the text, the form is the source of truth.
              }
            }}
          />
          <span className="zh-hint">失焦时保存。写坏了不会被应用，表单里的值保持不变。</span>
        </section>
      </div>
    </div>
  );
}

/* ── one payload field ───────────────────────────────────────────────────── */

function PayloadField({
  label,
  path,
  payload,
  onChange,
}: {
  label: string;
  path: string;
  payload: unknown;
  onChange: (value: unknown) => void;
}) {
  const value = getPath(payload, path);
  const long = ["content", "diff", "stdout", "stderr", "before", "after"].includes(path);

  if (typeof value === "boolean") {
    return (
      <label className="payload-row">
        <span className="k">{label}</span>
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => onChange(event.target.checked)}
          style={{ accentColor: "var(--green)", justifySelf: "start" }}
        />
      </label>
    );
  }

  if (typeof value === "number") {
    return (
      <label className="payload-row">
        <span className="k">{label}</span>
        <input className="field mono" type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
      </label>
    );
  }

  if (value !== undefined && typeof value === "object") {
    return (
      <label className="payload-row">
        <span className="k">{label}</span>
        <input
          className="field mono"
          value={JSON.stringify(value)}
          onChange={(event) => {
            try {
              onChange(JSON.parse(event.target.value));
            } catch {
              // A half-typed object is not applied.
            }
          }}
        />
      </label>
    );
  }

  return (
    <label className="payload-row">
      <span className="k">{label}</span>
      {long ? (
        <textarea
          className="field"
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="field mono"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

/* ── datetime-local helpers, keeping the date ────────────────────────────── */

function toLocalInput(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fromLocalInput(text: string): number | undefined {
  if (!text) return undefined;
  const value = new Date(text).getTime();
  return Number.isFinite(value) ? value : undefined;
}
