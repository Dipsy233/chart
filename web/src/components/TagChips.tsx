/**
 * Tag chips: a tag is a small card with its own ✕, and a trailing `+` opens a
 * one-line input. The `+` card is the affordance — no "edit comma-separated
 * string" field, no separate save button, no way to accidentally delete a tag by
 * removing a comma.
 *
 * Duplicates are ignored and blank input closes the editor, so the only invalid
 * action is one that produces no tag at all.
 */

import { useEffect, useRef, useState } from "react";

export function TagChips({
  tags,
  onChange,
  placeholder = "新标签",
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commit = () => {
    const value = draft.trim();
    setDraft("");
    setAdding(false);
    if (value.length === 0 || tags.includes(value)) return;
    onChange([...tags, value]);
  };

  const remove = (tag: string) => onChange(tags.filter((candidate) => candidate !== tag));

  return (
    <div className="tag-chips">
      {tags.map((tag) => (
        <span className="tag-chip" key={tag}>
          <span className="tag-text">{tag}</span>
          <button className="tag-x" title={`删除标签 ${tag}`} onClick={() => remove(tag)}>
            ✕
          </button>
        </span>
      ))}

      {adding ? (
        <span className="tag-chip editing">
          <input
            ref={inputRef}
            className="tag-input"
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
          />
        </span>
      ) : (
        <button className="tag-chip add" title="添加一个标签" onClick={() => setAdding(true)}>
          ＋
        </button>
      )}
    </div>
  );
}
