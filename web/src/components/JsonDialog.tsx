/**
 * A JSON dialog: read it, copy it, replace it, or load it.
 *
 * Two uses, one component:
 *
 *   read   the rule's native JSON, or the whole pack, with 复制 / 下载
 *   edit   paste someone else's rule or pack and 应用 it
 *
 * `onApply` receives the parsed value only when it parses; a half-typed document
 * is never applied, and the dialog says so inline instead of closing over a
 * mistake. The dialog is a modal on purpose: distributing a pack is a deliberate
 * act, not a keystroke.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../lib/storage.ts";

export interface JsonDialogProps {
  title: string;
  subtitle?: string;
  /** The JSON to show. */
  value: unknown;
  /** Omit for a read-only dialog. */
  onApply?: (parsed: unknown) => void | Promise<void>;
  /** Called after a successful copy, so the host can show a toast. */
  onCopied?: (ok: boolean) => void;
  /** Extra footer buttons (e.g. 下载). */
  actions?: React.ReactNode;
  onClose: () => void;
}

export function JsonDialog({ title, subtitle, value, onApply, onCopied, actions, onClose }: JsonDialogProps) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // A different document (a different rule) replaces the draft.
  useEffect(() => {
    setDraft(text);
    setError(undefined);
    setDirty(false);
  }, [text]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const validate = (text: string): { ok: true; parsed: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, parsed: JSON.parse(text) as unknown };
    } catch (caught) {
      return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
    }
  };

  const apply = async () => {
    const result = validate(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    await onApply?.(result.parsed);
  };

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal json-modal" onClick={(event) => event.stopPropagation()}>
        <div className="json-head">
          <h2>{title}</h2>
          {subtitle ? <span className="json-sub">{subtitle}</span> : null}
          <span className="spacer" />
          <button className="btn tiny ghost" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>

        <textarea
          ref={areaRef}
          className={`field mono json-area${error ? " bad" : ""}`}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              event.preventDefault();
              const area = areaRef.current;
              if (!area) return;
              const start = area.selectionStart;
              const next = `${draft.slice(0, start)}  ${draft.slice(area.selectionEnd)}`;
              setDraft(next);
              requestAnimationFrame(() => area.setSelectionRange(start + 2, start + 2));
            }
          }}
        />

        {error ? <div className="json-error">JSON 解析失败：{error}</div> : null}
        {!error && dirty && onApply ? <div className="zh-hint">改完点「应用」，会先校验再保存。</div> : null}

        <div className="json-actions">
          <button
            className="btn tiny"
            onClick={async () => {
              const ok = await copyText(draft);
              onCopied?.(ok);
            }}
          >
            复制
          </button>
          <button
            className="btn tiny"
            onClick={() => {
              setDraft(text);
              setDirty(false);
              setError(undefined);
            }}
            disabled={!dirty}
          >
            还原
          </button>
          <span className="spacer" />
          {actions}
          {onApply ? (
            <button className="btn tiny primary" onClick={() => void apply()} disabled={!dirty}>
              应用
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
