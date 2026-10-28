/**
 * The session column — 事件会话.
 *
 * The leftmost column of the report and event views: what is being observed.
 * It used to live in the top bar as a dropdown, but a control that only exists
 * while a view is open belongs in the view; and a column can show every session
 * at once, with its description, instead of one chosen line.
 */

export interface Subject {
  id: string;
  label: string;
  /** Shown under the label; the subject's own description when it has one. */
  hint?: string;
}

export function SessionColumn({
  subjects,
  selectedId,
  onSelect,
}: {
  subjects: readonly Subject[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="col sessions-col">
      <div className="pane-head">
        <span>事件会话 sessions</span>
        <span className="spacer" />
        <span className="tiny">{subjects.length}</span>
      </div>
      <div className="pane-body stack" style={{ gap: 4 }}>
        {subjects.map((subject) => (
          <button
            key={subject.id}
            className={`run-card${subject.id === selectedId ? " sel" : ""}`}
            onClick={() => onSelect(subject.id)}
            title={subject.hint ?? subject.label}
          >
            <span className="run-line">
              <span className="run-name">{subject.label}</span>
            </span>
            {subject.hint ? <span className="run-meta">{subject.hint}</span> : null}
          </button>
        ))}
        {subjects.length === 0 ? <div className="empty">没有可观察的会话。</div> : null}
      </div>
    </div>
  );
}
