/**
 * The run column.
 *
 * A run is one round of events. The report panel simulates one run at a time and
 * the event panel edits one run at a time, so both views start here. Nothing in
 * this column judges anything: it only says when a round started, how long it
 * took and how much happened.
 */

import type { ChartEvent } from "../../../src/core/events.ts";
import type { RunView } from "../lib/runs.ts";
import { formatSpan, runDuration, runStatusTone, zhRunStatus } from "../lib/runs.ts";

export function RunList({
  onAddRun,
  views,
  events,
  selectedId,
  onSelect,
  all,
}: {
  views: RunView[];
  events: readonly ChartEvent[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** The events panel can also show the whole stream; the report cannot. */
  all?: { selected: boolean; count: number; onSelect: () => void };
  /** The header ＋: open a new simulated run at the end of the stream. */
  onAddRun?: () => void;
}) {
  return (
    <div className="col runs-col">
      <div className="pane-head">
        <span>轮次 runs</span>
        <span className="spacer" />
        <span className="tiny">{views.length}</span>
        {onAddRun ? (
          <button className="btn tiny ghost" onClick={onAddRun} title="在流末尾新开一轮 —— 一条新的用户消息，新轮次从这里长出来">
            ＋
          </button>
        ) : null}
      </div>
      <div className="pane-body stack" style={{ gap: 4 }}>
        {all ? (
          <button
            className={`run-card${all.selected ? " sel" : ""}`}
            onClick={all.onSelect}
            title="不按轮次过滤，直接看整段事件流"
          >
            <span className="run-line">
              <span className="run-name">全部事件</span>
              <span className="chip none">{all.count} 个</span>
            </span>
            <span className="run-meta">跨轮次编辑整段事件流</span>
          </button>
        ) : null}

        {views.map((view) => {
          const duration = runDuration(view.run, events);
          const tone = runStatusTone(view.run.status);
          return (
            <button
              key={view.run.id}
              className={`run-card${view.run.id === selectedId ? " sel" : ""}`}
              onClick={() => onSelect(view.run.id)}
              title={`${view.run.id} · ${new Date(view.run.startedAt).toLocaleString()}`}
            >
              <span className="run-line">
                <span className="run-name">第 {view.index + 1} 轮</span>
                <span className={`chip ${tone}`}>{zhRunStatus(view.run.status)}</span>
              </span>
              <span className="run-meta">
                {view.run.id} · {view.eventCount} 个事件 · {formatSpan(duration)}
              </span>
            </button>
          );
        })}

        {views.length === 0 ? <div className="empty">这段事件流里还没有一轮运行。</div> : null}
      </div>
    </div>
  );
}
