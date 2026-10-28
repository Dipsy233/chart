/**
 * The session column — 事件会话.
 *
 * The leftmost column of the report and event views: what is being observed.
 * It used to live in the top bar as a dropdown, but a control that only exists
 * while a view is open belongs in the view; and a column can show every session
 * at once, with its description, instead of one chosen line.
 *
 * The column also *creates*: the ＋ in its header opens a dialog with two ways
to add a session — a blank stream of the user's own, or a one-time **snapshot**
of the session currently on screen (the ＋ dialog owns that choice, so the column
stays a list with one button). Simulated sessions persist in localStorage and are
deletable — the demos and any real sessions the host passes in are not.
 */

export interface Subject {
  id: string;
  label: string;
  /** Shown under the label; the subject's own description when it has one. */
  hint?: string;
  /** True only for sessions the user created, which can be deleted. */
  deletable?: boolean;
}

export function SessionColumn({
  subjects,
  selectedId,
  onSelect,
  onAdd,
  onDelete,
}: {
  subjects: readonly Subject[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** The header ＋: create a new simulated session. */
  onAdd?: () => void;
  /** Shown on deletable subjects; removing one is confirmed by the caller. */
  onDelete?: (id: string) => void;
}) {
  return (
    <div className="col sessions-col">
      <div className="pane-head">
        <span>事件会话 sessions</span>
        <span className="spacer" />
        <span className="tiny">{subjects.length}</span>
        {onAdd ? (
          <button className="btn tiny ghost" onClick={onAdd} title="新建会话：空白，或当前会话此刻的快照">
            ＋
          </button>
        ) : null}
      </div>
      <div className="pane-body stack" style={{ gap: 4 }}>
        {subjects.map((subject) => (
          <div key={subject.id} className={`session-card${subject.id === selectedId ? " sel" : ""}`}>
            <button
              className="session-pick"
              onClick={() => onSelect(subject.id)}
              title={subject.hint ?? subject.label}
            >
              <span className="run-line">
                <span className="run-name">{subject.label}</span>
              </span>
              {subject.hint ? <span className="run-meta">{subject.hint}</span> : null}
            </button>
            {subject.deletable && onDelete ? (
              <button
                className="card-del"
                onClick={() => onDelete(subject.id)}
                title={`删除模拟会话「${subject.label}」`}
              >
                ✕
              </button>
            ) : null}
          </div>
        ))}
        {subjects.length === 0 ? <div className="empty">没有可观察的会话。</div> : null}
      </div>
    </div>
  );
}
