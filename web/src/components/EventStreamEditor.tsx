/**
 * The event stream, as a form.
 *
 * Left: one card per event — type, time, and the payload fields the catalogue
 * says matter for that type, plus a raw-JSON escape hatch. Reorder, duplicate,
 * delete, and add from the bar at the bottom.
 *
 * Right: what the stream adds up to — the run, the facts, and the findings this
 * pack produces from it. That is the "simulate" half: edit an event, watch the
 * verdict move.
 */

import { useState } from "react";
import { EVENT_TYPES, eventFields } from "../../../src/editor/catalog.ts";
import type { Observation } from "../../../src/index.ts";
import type { ChartEvent, ChartEventType } from "../../../src/core/events.ts";
import { fieldsFor, getPath, newEvent, renumber, restamp, setPath, shiftTo } from "../lib/events.ts";

export function EventStreamEditor({
  events,
  observation,
  onChange,
  onOpenReport,
  onSelectRule,
}: {
  events: ChartEvent[];
  observation: Observation | undefined;
  onChange: (events: ChartEvent[]) => void;
  onOpenReport: () => void;
  onSelectRule: (id: string) => void;
}) {
  const [jsonFor, setJsonFor] = useState<string | undefined>(undefined);
  const [rawText, setRawText] = useState("");

  const replace = (index: number, next: ChartEvent) => {
    const copy = [...events];
    copy[index] = next;
    onChange(copy);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= events.length) return;
    const copy = [...events];
    const [moved] = copy.splice(index, 1);
    copy.splice(target, 0, moved!);
    onChange(copy);
  };

  const remove = (index: number) => onChange(events.filter((_, i) => i !== index));

  const duplicate = (index: number) => {
    const source = events[index]!;
    const copy = [...events];
    copy.splice(index + 1, 0, { ...structuredClone(source), timestamp: source.timestamp + 1_000 });
    onChange(renumber(copy));
  };

  /**
   * Insert where the user expects it to count: before a trailing `agent_end`,
   * because anything after it belongs to no run and would be silently ignored.
   */
  const add = (type: ChartEventType) => {
    if (type === "agent_start") {
      const first = events[0];
      onChange([newEvent(type, (first?.timestamp ?? Date.now()) - 1_000), ...events]);
      return;
    }
    const last = events[events.length - 1];
    const at = (last?.timestamp ?? Date.now()) + 5_000;
    const event = newEvent(type, at);
    if (type !== "agent_end" && last?.type === "agent_end") {
      const copy = [...events];
      copy.splice(copy.length - 1, 0, event);
      onChange(copy);
      return;
    }
    onChange([...events, event]);
  };

  const firstAt = events[0]?.timestamp ?? Date.now();
  const span = (events[events.length - 1]?.timestamp ?? firstAt) - firstAt;

  return (
    <div className="view events" style={{ display: "grid" }}>
      {/* ── the stream ─────────────────────────────────────── */}
      <div style={{ minHeight: 0, overflowY: "auto", background: "var(--bg)" }}>
        <div className="pane-head" style={{ background: "var(--bg)" }}>
          <span>event stream</span>
          <span className="spacer" />
          <span className="tiny">{events.length} events</span>
          <button
            className="btn tiny"
            title="Re-space every event 5s apart from two minutes ago"
            onClick={() => onChange(restamp(events, 5_000))}
          >
            auto-time
          </button>
          <button className="btn tiny" title="Shift so the first event is now" onClick={() => onChange(shiftTo(events, Date.now() - span))}>
            shift to now
          </button>
          <button className="btn tiny" title="Renumber ids evt_1…" onClick={() => onChange(renumber(events))}>
            renumber
          </button>
        </div>

        <div className="timeline-gutter" style={{ padding: "14px 18px 24px" }}>
          {events.length === 0 ? (
            <div className="empty">No events. Add one from the bar below.</div>
          ) : null}

          {events.map((event, index) => (
            <div className="event-card" key={`${event.id}-${index}`}>
              <div className="head">
                <span className="n">{index + 1}</span>
                <select
                  className="field"
                  style={{ width: 150 }}
                  value={event.type}
                  onChange={(e) => {
                    const type = e.target.value as ChartEventType;
                    const replacement = newEvent(type, event.timestamp, event.sessionId);
                    replace(index, { ...replacement, id: event.id });
                  }}
                >
                  {EVENT_TYPES.map((info) => (
                    <option key={info.type} value={info.type}>
                      {info.label}
                    </option>
                  ))}
                </select>
                <span className="when">
                  +{((event.timestamp - firstAt) / 1000).toFixed(1)}s
                </span>
                <span className="spacer" />
                <button className="btn tiny" onClick={() => move(index, -1)} title="Move up">
                  ▲
                </button>
                <button className="btn tiny" onClick={() => move(index, 1)} title="Move down">
                  ▼
                </button>
                <button className="btn tiny" onClick={() => duplicate(index)} title="Duplicate">
                  ⧉
                </button>
                <button
                  className="btn tiny"
                  onClick={() => {
                    if (jsonFor === event.id) {
                      setJsonFor(undefined);
                    } else {
                      setJsonFor(event.id);
                      setRawText(JSON.stringify(event.payload, null, 2));
                    }
                  }}
                  title="Edit the payload as JSON"
                >
                  {"{ }"}
                </button>
                <button className="btn tiny danger" onClick={() => remove(index)} title="Delete">
                  ✕
                </button>
              </div>

              <div className="payload">
                <span className="k">timestamp</span>
                <input
                  className="field mono"
                  value={new Date(event.timestamp).toISOString().slice(11, 19)}
                  onChange={(e) => {
                    const parts = e.target.value.split(":");
                    const base = new Date(event.timestamp);
                    const seconds =
                      Number(parts[0] ?? 0) * 3600 + Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
                    base.setHours(0, 0, 0, 0);
                    replace(index, { ...event, timestamp: base.getTime() + seconds * 1000 });
                  }}
                />
                {fieldsFor(event.type).map((field) => {
                  const path = field.path.replace(/^payload\./, "");
                  return (
                    <FieldRow
                      key={path}
                      label={path}
                      path={path}
                      payload={event.payload}
                      onChange={(value) =>
                        replace(index, { ...event, payload: setPath(event.payload, path, value) as never })
                      }
                    />
                  );
                })}
              </div>

              {jsonFor === event.id ? (
                <textarea
                  className="field"
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  onBlur={() => {
                    try {
                      replace(index, { ...event, payload: JSON.parse(rawText) as never });
                    } catch {
                      // Keep the text; the user is still typing.
                    }
                  }}
                  rows={8}
                />
              ) : null}
            </div>
          ))}
        </div>

        <div className="addbar">
          <span className="label" style={{ alignSelf: "center", marginRight: 6 }}>
            add
          </span>
          {EVENT_TYPES.map((info) => (
            <button key={info.type} className="btn tiny" title={info.hint} onClick={() => add(info.type)}>
              {info.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── what it adds up to ─────────────────────────────── */}
      <div className="side-panel">
        <h3>this stream</h3>
        <div className="kv">
          <span className="k">events</span>
          <span className="v">{events.length}</span>
        </div>
        <div className="kv">
          <span className="k">span</span>
          <span className="v">{span >= 1000 ? `${Math.round(span / 1000)}s` : `${span}ms`}</span>
        </div>
        <div className="kv">
          <span className="k">run</span>
          <span className="v">{observation?.run.id ?? "—"}</span>
        </div>
        <div className="kv">
          <span className="k">verdict</span>
          <span className="v" style={{ color: levelColor(observation?.attention.level) }}>
            {observation?.attention.level ?? "—"}
          </span>
        </div>

        <h3 style={{ marginTop: 18 }}>facts the rules will read</h3>
        {observation ? (
          <>
            <div className="kv">
              <span className="k">commands</span>
              <span className="v">
                {observation.facts.commands.succeeded} ok / {observation.facts.commands.failed} failed
              </span>
            </div>
            <div className="kv">
              <span className="k">streak</span>
              <span className="v">{observation.facts.failureStreak.count}</span>
            </div>
            <div className="kv">
              <span className="k">files</span>
              <span className="v">
                {observation.facts.files.created.length} new · {observation.facts.files.modified.length} changed
              </span>
            </div>
            <div className="kv">
              <span className="k">processes</span>
              <span className="v">
                {observation.facts.processes.primary.length} laid · {observation.facts.processes.runningAtEnd.length} running
              </span>
            </div>
            <div className="kv">
              <span className="k">unresolved</span>
              <span className="v">{observation.facts.unresolved.length}</span>
            </div>
            <div className="kv">
              <span className="k">outside</span>
              <span className="v">{observation.facts.outsideChanges.length}</span>
            </div>
          </>
        ) : (
          <div className="empty">no run in this stream</div>
        )}

        <h3 style={{ marginTop: 18 }}>findings</h3>
        {observation && observation.findings.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {observation.findings.map((finding) => (
              <button
                key={finding.ruleId}
                className="btn tiny"
                style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                onClick={() => onSelectRule(finding.ruleId)}
              >
                <span className={`chip ${finding.level}`}>{finding.level}</span> {finding.title}
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">nothing fires on this stream</div>
        )}

        <button className="btn" style={{ marginTop: 18, width: "100%" }} onClick={onOpenReport}>
          open the report →
        </button>
      </div>
    </div>
  );
}

/* ── one payload field ───────────────────────────────────────────────────── */

function FieldRow({
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

  if (typeof value === "boolean") {
    return (
      <>
        <span className="k">{label}</span>
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          style={{ accentColor: "rgb(232,169,74)", justifySelf: "start" }}
        />
      </>
    );
  }

  if (typeof value === "number") {
    return (
      <>
        <span className="k">{label}</span>
        <input
          className="field mono"
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </>
    );
  }

  if (value !== undefined && typeof value === "object") {
    return (
      <>
        <span className="k">{label}</span>
        <input
          className="field mono"
          value={JSON.stringify(value)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              // ignore a half-typed object
            }
          }}
        />
      </>
    );
  }

  // `content` and `diff` are long: give them a textarea.
  const long = path.endsWith("content") || path.endsWith("diff") || path.endsWith("stdout") || path.endsWith("stderr");
  return (
    <>
      <span className="k">{label}</span>
      {long ? (
        <textarea
          className="field"
          rows={2}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="field mono"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
}

function levelColor(level: string | undefined): string {
  if (level === "high") return "var(--high)";
  if (level === "medium") return "var(--medium)";
  if (level === "low") return "var(--low)";
  return "var(--dim)";
}
