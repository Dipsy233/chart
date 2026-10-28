/**
 * The event view: runs | events | the event.
 *
 * Editing the record is a three-step task — pick the round, pick the event, edit
 * the event — so it gets three columns instead of one long form with a side
 * panel. Reordering is the same grip as the rule list: the stream is ordered, and
 * order is what runs are made of.
 *
 * This panel does not judge. Adding a failing command changes the record; whether
 * that matters is the report's answer, one view away.
 */

import { useMemo, useState } from "react";
import type { ChartEvent, ChartEventType } from "../../../src/core/events.ts";
import { EVENT_TYPES } from "../../../src/editor/catalog.ts";
import { newEvent, renumber, restamp, shiftTo } from "../lib/events.ts";
import { pickRunView, type RunView } from "../lib/runs.ts";
import { zhEventLabel } from "../lib/plain.ts";
import { EventCardList } from "./EventCardList.tsx";
import { EventDetail } from "./EventDetail.tsx";
import { RunList } from "./RunList.tsx";

export function EventStreamEditor({
  events,
  views,
  runId,
  allMode,
  selectedIndex,
  onChange,
  onSelectRun,
  onToggleAll,
  onSelectIndex,
  /** The header ＋ on the runs column: open a new simulated run. */
  onAddRun,
  /** Delete a whole round: it asks first, because a run *is* its events. */
  onDeleteRun,
  /** The 事件会话 column — what is being observed, rendered leftmost. */
  sessions,
}: {
  events: ChartEvent[];
  views: RunView[];
  runId: string | undefined;
  allMode: boolean;
  selectedIndex: number | undefined;
  onChange: (events: ChartEvent[]) => void;
  onSelectRun: (id: string) => void;
  onToggleAll: () => void;
  onSelectIndex: (index: number | undefined) => void;
  /** The 事件会话 column — what is being observed, rendered leftmost. */
  sessions?: React.ReactNode;
  onAddRun?: () => void;
  onDeleteRun?: (view: RunView) => void;
}) {
  const [addType, setAddType] = useState<ChartEventType>("command");
  const selectedView = pickRunView(views, runId);

  const indices = useMemo(() => {
    if (allMode) return events.map((_, index) => index);
    if (!selectedView) return [];
    const out: number[] = [];
    for (let index = selectedView.run.fromIndex; index <= selectedView.run.toIndex; index++) out.push(index);
    return out;
  }, [allMode, events, selectedView]);

  const scopeLabel = allMode
    ? "整段事件流"
    : selectedView
      ? `第 ${selectedView.index + 1} 轮`
      : undefined;

  const add = () => {
    const fallback = indices[indices.length - 1];
    const base = selectedIndex !== undefined && indices.includes(selectedIndex) ? selectedIndex : fallback;
    const anchorEvent = base === undefined ? undefined : events[base];
    const at = (anchorEvent?.timestamp ?? Date.now()) + 5_000;
    const event = newEvent(addType, at, anchorEvent?.sessionId ?? "draft");

    // An event after a trailing `agent_end` belongs to no run and would be
    // ignored, so it goes *before* the end marker instead.
    const insertAt = anchorEvent?.type === "agent_end" ? base! : base === undefined ? events.length : base + 1;
    const copy = [...events];
    copy.splice(insertAt, 0, event);
    onChange(copy);
    onSelectIndex(insertAt);
  };

  const move = (fromPosition: number, toPosition: number) => {
    const from = indices[fromPosition];
    const to = indices[toPosition];
    if (from === undefined || to === undefined) return;
    const copy = [...events];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved!);
    onChange(copy);
    onSelectIndex(to);
  };

  return (
    <div className="view events">
      {sessions}
      <RunList
        views={views}
        events={events}
        selectedId={runId}
        onSelect={onSelectRun}
        all={{ selected: allMode, count: events.length, onSelect: onToggleAll }}
        onAddRun={onAddRun}
        onDelete={onDeleteRun}
      />

      <EventCardList
        events={events}
        indices={indices}
        selectedIndex={selectedIndex}
        onSelect={onSelectIndex}
        onMove={move}
        onDelete={(index) => {
          onChange(events.filter((_, position) => position !== index));
          onSelectIndex(index > 0 ? index - 1 : events.length > 1 ? 0 : undefined);
        }}
        header={
          <div className="pane-head">
            <span>事件 events</span>
            <span className="spacer" />
            <span className="tiny">{indices.length} 个</span>
            <button className="btn tiny ghost" title="按 5 秒间隔重排时间" onClick={() => onChange(restamp(events, 5_000))}>
              ⏱
            </button>
            <button
              className="btn tiny ghost"
              title="整体平移，让第一个事件发生在此刻"
              onClick={() => {
                const span = (events[events.length - 1]?.timestamp ?? 0) - (events[0]?.timestamp ?? 0);
                onChange(shiftTo(events, Date.now() - span));
              }}
            >
              ⤓
            </button>
            <button className="btn tiny ghost" title="把事件 id 重排成 evt_1…" onClick={() => onChange(renumber(events))}>
              #
            </button>
          </div>
        }
        footer={
          <div className="addbar">
            <span className="label">添加</span>
            <select className="field" value={addType} onChange={(event) => setAddType(event.target.value as ChartEventType)}>
              {EVENT_TYPES.map((info) => (
                <option key={info.type} value={info.type}>
                  {zhEventLabel(info.type)}
                </option>
              ))}
            </select>
            <button className="btn tiny primary" onClick={add} title="插入在选中事件之后">
              ＋ 添加事件
            </button>
          </div>
        }
      />

      <EventDetail
        events={events}
        index={selectedIndex}
        runLabel={scopeLabel}
        position={
          selectedIndex === undefined || !indices.includes(selectedIndex)
            ? undefined
            : { index: indices.indexOf(selectedIndex), total: indices.length }
        }
        onChange={onChange}
        onSelect={onSelectIndex}
      />
    </div>
  );
}
