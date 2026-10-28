/**
 * The ＋ dialog of the 事件会话 column.
 *
 * Adding a session used to mean one thing — an empty stream you fill by hand.
 * It now means two, and the choice is the point:
 *
 *   empty      a blank simulated session, built event by event
 *   absence    the agent session Absence is observing right now (`../daze`)
 *
 * "The current session" is **Absence's**, not a conversation in this editor:
 * what matters is the agent that is actually running, with the events and the
 * resource samples it really produced. And the import is a **snapshot**: the
 * events are read once, when 导入 is pressed, and copied into a session of this
 * editor's own. Nothing polls Absence afterwards, so the copy and the agent it
 * came from are independent from that moment on — the whole point of copying
 * instead of watching.
 *
 * Absence not running is the normal case, not an error: the option says why it
 * cannot be used and the dialog still opens for the empty session.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAbsenceSessions,
  fetchAbsenceSnapshot,
  type AbsenceSessionSummary,
  type AbsenceSessionsResult,
} from "../lib/absence.ts";

export type SessionMode = "empty" | "absence";

export interface NewSessionDialogProps {
  /** Names already in the column; the dialog refuses to duplicate one. */
  taken: readonly string[];
  /** Default names per mode, already made free by the caller. */
  defaults: Record<SessionMode, string>;
  /**
   * The import itself: the dialog reads Absence once and hands the copy over.
   * Resolves to an error message when it could not, so the dialog can stay open.
   */
  onCreate: (name: string, mode: SessionMode, snapshot?: AbsenceImport) => Promise<string | undefined>;
  onClose: () => void;
}

/** Everything the caller needs to own the copy; nothing here is live. */
export interface AbsenceImport {
  sessionId: string;
  label: string;
  projectPath: string;
  fetchedAt: number;
  events: import("../../../src/index.ts").ChartEvent[];
  metrics: import("../../../src/core/live.ts").MetricsFrameLike[];
  truncated: boolean;
}

export function NewSessionDialog({ taken, defaults, onCreate, onClose }: NewSessionDialogProps) {
  const [mode, setMode] = useState<SessionMode>("empty");
  // One name per mode: switching back and forth does not lose what you typed.
  const [names, setNames] = useState<Record<SessionMode, string>>(defaults);
  const [error, setError] = useState<string | undefined>(undefined);

  // Absence is probed once, when the dialog opens. A result list is a snapshot
  // too — nothing re-reads it while the dialog stays open.
  const [probe, setProbe] = useState<AbsenceSessionsResult | undefined>(undefined);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void fetchAbsenceSessions().then((result) => {
      if (!alive) return;
      setProbe(result);
      setChosenId(result.current?.id);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Capture phase, so the Esc that closes this dialog cannot also close a
  // dialog underneath it — the same contract as PromptDialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [mode]);

  const sessions: readonly AbsenceSessionSummary[] = probe?.sessions ?? [];
  const chosen = sessions.find((session) => session.id === chosenId) ?? sessions[0];
  const absenceReady = probe?.available === true && chosen !== undefined;

  // The session Absence is on *right now*: the live one it reported, not the
  // newest row — those are only the same thing when everything is closed.
  const currentId = probe?.current?.id;
  const chosenIsCurrent = chosen !== undefined && chosen.id === currentId;

  const problem = useMemo(() => {
    const value = names[mode].trim();
    if (value === "") return "名字不能为空";
    if (taken.includes(value)) return "已经有同名的会话了";
    if (mode === "absence" && !absenceReady) return "没有可导入的 Absence 会话";
    return undefined;
  }, [names, mode, taken, absenceReady]);

  const submit = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    const name = names[mode].trim();
    if (mode === "empty") {
      const failure = await onCreate(name, "empty");
      if (failure) setError(failure);
      return;
    }
    if (!chosen) return;
    setImporting(true);
    setError(undefined);
    try {
      const snapshot = await fetchAbsenceSnapshot(chosen.id);
      if (!snapshot.available) {
        setError(snapshot.error ?? "导入失败");
        return;
      }
      if (snapshot.events.length === 0) {
        setError("这个会话没有可用的事件，换个会话或先空着");
        return;
      }
      const failure = await onCreate(name, "absence", {
        sessionId: chosen.id,
        label: snapshot.label ?? chosen.label,
        projectPath: snapshot.projectPath ?? chosen.projectPath,
        fetchedAt: snapshot.fetchedAt ?? Date.now(),
        events: snapshot.events,
        metrics: snapshot.metrics,
        truncated: snapshot.truncated === true,
      });
      if (failure) setError(failure);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal small-modal" onClick={(event) => event.stopPropagation()}>
        <h2>＋ 新建会话</h2>
        <div className="sub">
          空白会话，还是把 Absence 正在观察的会话导入一份？导入只读一次 —— 点下去的那一刻是什么样，以后就是什么样。
        </div>

        <button
          className={`template${mode === "empty" ? " on" : ""}`}
          onClick={() => {
            setMode("empty");
            setError(undefined);
          }}
        >
          <span className="ico">{mode === "empty" ? "●" : "○"}</span>
          <span>
            <div className="name">空会话</div>
            <div className="desc">从零开始：去事件流里用轮次列的 ＋ 新开一轮，再一条条加事件。</div>
          </span>
        </button>

        <button
          className={`template${mode === "absence" ? " on" : ""}${absenceReady ? "" : " off"}`}
          disabled={!absenceReady}
          onClick={() => {
            if (!absenceReady) return;
            setMode("absence");
            setError(undefined);
          }}
          title={absenceReady ? undefined : (probe?.error ?? "正在读取 Absence…")}
        >
          <span className="ico">{mode === "absence" ? "●" : "○"}</span>
          <span>
            <div className="name">当前会话 · 从 Absence 导入</div>
            <div className="desc">
              {probe === undefined
                ? "正在读取 Absence 的会话…"
                : absenceReady && chosen
                  ? `${chosenIsCurrent ? "Absence 正在观察" : chosen.live ? "已打开的会话" : "历史会话"}「${shorten(chosen.label)}」· ${chosen.projectName} · 最近活动 ${formatWhen(chosen.updatedAt)}。导入后不再同步。`
                  : (probe.error ?? "Absence 里没有可导入的会话")}
            </div>
          </span>
        </button>

        {mode === "absence" && sessions.length > 1 ? (
          <>
            <div className="modal-label" style={{ marginTop: 12 }}>
              导入哪一个
            </div>
            <select
              className="field"
              value={chosen?.id ?? ""}
              onChange={(event) => {
                setChosenId(event.target.value);
                setError(undefined);
              }}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.id === currentId ? "● " : session.live ? "○ " : "  "}
                  {shorten(session.label)} · {session.projectName} · {formatWhen(session.updatedAt)}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <div className="modal-label" style={{ marginTop: 12 }}>
          会话名字
        </div>
        <input
          ref={inputRef}
          className={`field big mono${error ? " bad" : ""}`}
          value={names[mode]}
          placeholder={mode === "absence" ? "Absence 会话 · 快照" : "我的实验"}
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value;
            setNames((current) => ({ ...current, [mode]: value }));
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />

        {error ?? (names[mode].trim() !== "" ? problem : undefined) ? (
          <div className="modal-error">{error ?? problem}</div>
        ) : (
          <div className="zh-hint">
            {mode === "absence"
              ? "导入是一次性拷贝：之后 Absence 里发生什么都不会同步过来，改这边也不影响那边。"
              : "会话保存在浏览器里，删了就没了。"}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn tiny" onClick={onClose} disabled={importing}>
            取消
          </button>
          <span className="spacer" />
          <button
            className="btn tiny primary"
            onClick={() => void submit()}
            disabled={!!problem || importing}
          >
            {importing ? "导入中…" : mode === "absence" ? "导入" : "新建"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Absence can name a session after its whole first prompt; a row shows a bit. */
function shorten(text: string, max = 56): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** `3 分钟前`, `2 小时前`, `9 月 12 日` — how long ago Absence last saw activity. */
function formatWhen(at: number): string {
  if (!at) return "—";
  const ago = Date.now() - at;
  if (ago < 0) return "刚刚";
  if (ago < 60_000) return "刚刚";
  if (ago < 60 * 60_000) return `${Math.round(ago / 60_000)} 分钟前`;
  if (ago < 24 * 60 * 60_000) return `${Math.round(ago / (60 * 60_000))} 小时前`;
  if (ago < 7 * 24 * 60 * 60_000) return `${Math.round(ago / (24 * 60 * 60_000))} 天前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
