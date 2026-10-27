/**
 * Two small in-page dialogs, so the editor never drops into a browser prompt.
 *
 *   PromptDialog  ask for one line of text (a pack name), validating as you type
 *   ConfirmDialog ask before something irreversible (deleting a pack)
 *
 * They are deliberately plain: a title, one line of explanation, one input or
 * one warning, and two buttons. `window.prompt`/`window.confirm` are the browser
 * talking; these are the editor talking, in the editor's own type and colour.
 *
 * Both are modal and both close on Esc / veil click. The confirm dialog focuses
 * the *cancel* button, so Enter does not destroy anything by accident.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface PromptDialogProps {
  title: string;
  subtitle?: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  /** Returns an error message, or undefined when the value is acceptable. */
  validate?: (value: string) => string | undefined;
  /** The quiet line under the input when the value is acceptable. */
  hint?: string;
  confirmText?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onClose: () => void;
}

export function PromptDialog({
  title,
  subtitle,
  label,
  placeholder,
  initialValue = "",
  validate,
  hint,
  confirmText = "确定",
  onConfirm,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  // Capture phase, so the Esc that closes this dialog cannot also close a
  // dialog underneath it (the JSON dialog registers its own window listener).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Focus and select the prefilled name: renaming means typing over it.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const problem = useMemo(() => (value.trim() === "" ? "名字不能为空" : validate?.(value.trim())), [value, validate]);
  const canSubmit = !problem;
  // The empty-name complaint is noise until you have actually cleared the field.
  const shown = error ?? (value.trim() !== "" ? problem : undefined);

  const submit = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    await onConfirm(value.trim());
  };

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal small-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        {subtitle ? <div className="sub">{subtitle}</div> : null}

        {label ? <div className="modal-label">{label}</div> : null}
        <input
          ref={inputRef}
          className={`field big mono${error ? " bad" : ""}`}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />

        {shown ? (
          <div className="modal-error">{shown}</div>
        ) : (
          <div className="zh-hint">{hint ?? "字母、数字、. - _，最多 64 个字符。「active」是保留名。"}</div>
        )}

        <div className="modal-actions">
          <button className="btn tiny" onClick={onClose}>
            取消
          </button>
          <span className="spacer" />
          <button className="btn tiny primary" onClick={() => void submit()} disabled={!canSubmit}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  title: string;
  /** The one sentence that says what will be lost. */
  message: string;
  /** A quiet line under the warning, e.g. what the deletion does *not* touch. */
  detail?: string;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, detail, confirmText = "删除", onConfirm, onClose }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Capture phase: see PromptDialog — one Esc closes one dialog.
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
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal small-modal" onClick={(event) => event.stopPropagation()}>
        <h2 className="danger">{title}</h2>
        <div className="sub">{message}</div>
        {detail ? <div className="zh-hint" style={{ marginBottom: 12 }}>{detail}</div> : null}
        <div className="modal-actions">
          <button ref={cancelRef} className="btn tiny" onClick={onClose}>
            取消
          </button>
          <span className="spacer" />
          <button className="btn tiny danger-strong" onClick={() => void onConfirm()}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
