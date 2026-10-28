/**
 * The ＋ dialog of the 事件会话 column.
 *
 * Adding a session used to mean one thing — an empty stream you fill by hand.
 * It now means two, and the choice is the point:
 *
 *   empty     a blank simulated session, built event by event
 *   snapshot  the current session *as it is right now*, copied once
 *
 * A snapshot is a photograph, not a mirror: it copies the events (and the
 * resource samples) at the instant you press 新建, and from then on the two
 * sessions are independent — editing one never touches the other. That is the
 * whole mechanic, so the dialog says it in as many words instead of leaving the
 * user to wonder which of the two they just created.
 *
 * The dialog owns the name too, with the same rules the editor uses elsewhere:
 * one line of text, non-empty, not already taken.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export type SessionMode = "empty" | "snapshot";

export interface NewSessionDialogProps {
  /** What the current session is called, for the snapshot option's explanation. */
  sourceLabel: string;
  /** How many events the snapshot would copy. */
  sourceCount: number;
  /** Names already in the column; the dialog refuses to duplicate one. */
  taken: readonly string[];
  /** Default names per mode, already made free by the caller. */
  defaults: Record<SessionMode, string>;
  onCreate: (name: string, mode: SessionMode) => void;
  onClose: () => void;
}

export function NewSessionDialog({
  sourceLabel,
  sourceCount,
  taken,
  defaults,
  onCreate,
  onClose,
}: NewSessionDialogProps) {
  const canSnapshot = sourceCount > 0;
  const [mode, setMode] = useState<SessionMode>(canSnapshot ? "snapshot" : "empty");
  // One name per mode: switching back and forth does not lose what you typed.
  const [names, setNames] = useState<Record<SessionMode, string>>(defaults);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const problem = useMemo(() => {
    const value = names[mode].trim();
    if (value === "") return "名字不能为空";
    if (taken.includes(value)) return "已经有同名的会话了";
    return undefined;
  }, [names, mode, taken]);

  const submit = () => {
    if (problem) {
      setError(problem);
      return;
    }
    onCreate(names[mode].trim(), mode);
  };

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal small-modal" onClick={(event) => event.stopPropagation()}>
        <h2>＋ 新建会话</h2>
        <div className="sub">
          空白会话，还是把当前会话此刻的样子拍下来？快照只复制点击的那一下，之后两边各改各的。
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
          className={`template${mode === "snapshot" ? " on" : ""}${canSnapshot ? "" : " off"}`}
          disabled={!canSnapshot}
          onClick={() => {
            if (!canSnapshot) return;
            setMode("snapshot");
            setError(undefined);
          }}
          title={canSnapshot ? undefined : "当前会话还没有事件，没有可复制的内容"}
        >
          <span className="ico">{mode === "snapshot" ? "●" : "○"}</span>
          <span>
            <div className="name">当前会话的快照</div>
            <div className="desc">
              {canSnapshot
                ? `复制「${sourceLabel}」此刻的 ${sourceCount} 个事件，之后不再同步 —— 改哪边都只影响哪边。`
                : "当前会话还没有事件，没有可复制的内容。"}
            </div>
          </span>
        </button>

        <div className="modal-label" style={{ marginTop: 12 }}>
          会话名字
        </div>
        <input
          ref={inputRef}
          className={`field big mono${error ? " bad" : ""}`}
          value={names[mode]}
          placeholder={mode === "snapshot" ? "我的实验 · 快照" : "我的实验"}
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value;
            setNames((current) => ({ ...current, [mode]: value }));
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />

        {error ?? (names[mode].trim() !== "" ? problem : undefined) ? (
          <div className="modal-error">{error ?? problem}</div>
        ) : (
          <div className="zh-hint">
            {mode === "snapshot"
              ? "快照是一份独立的副本：源会话之后改动、删除，都不会影响它。"
              : "会话保存在浏览器里，删了就没了。"}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn tiny" onClick={onClose}>
            取消
          </button>
          <span className="spacer" />
          <button className="btn tiny primary" onClick={submit} disabled={!!problem}>
            {mode === "snapshot" ? "快照" : "新建"}
          </button>
        </div>
      </div>
    </div>
  );
}
