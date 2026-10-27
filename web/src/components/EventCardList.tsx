/**
 * The event column: one compact card per event.
 *
 * Used twice, with different behaviour:
 *
 *   report — read-only, and the card doubles as a seek bar: cards after the
 *            playback cursor are dimmed, the current one is lit, and clicking a
 *            card moves the cursor there.
 *   events — editable: a grip on the left reorders the card (the list closes the
 *            gap as you drag), clicking selects it for the detail panel.
 *
 * Cards are a fixed height so a long payload is truncated instead of stretching
 * the column — the detail panel is where the whole event is read.
 */

import type { CSSProperties, ReactNode } from "react";
import type { ChartEvent } from "../../../src/core/events.ts";
import { eventMeta, eventSummary } from "../lib/events.ts";
import { formatSpan } from "../lib/runs.ts";
import { zhEventLabel } from "../lib/plain.ts";
import { useDragSort } from "./useDragSort.ts";

export const EVENT_CARD_HEIGHT = 58;
const EVENT_CARD_GAP = 6;

export function EventCardList({
  events,
  indices,
  selectedIndex,
  cursorIndex,
  revealedUpTo,
  onSelect,
  onMove,
  header,
  footer,
}: {
  events: readonly ChartEvent[];
  /** Global indices to show, in order. */
  indices: number[];
  /** The selected event (events view). */
  selectedIndex?: number;
  /** The playback cursor (report view): this card is "now". */
  cursorIndex?: number;
  /** Cards after this global index have not happened yet. */
  revealedUpTo?: number;
  onSelect?: (index: number) => void;
  /** Reorder by displayed position; only rendered when present. */
  onMove?: (from: number, to: number) => void;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const sort = useDragSort(indices.length, EVENT_CARD_HEIGHT, EVENT_CARD_GAP, onMove ?? (() => {}));
  const first = events[0]?.timestamp ?? 0;

  return (
    <div className="col events-col">
      {header}
      <div className="pane-body" style={{ padding: "10px 12px 18px" }}>
        <div ref={sort.listRef} className="sortable event-cards">
          {indices.length === 0 ? <div className="empty">这一轮还没有事件。</div> : null}
          {indices.map((globalIndex, position) => {
            const event = events[globalIndex];
            if (!event) return null;
            const future = revealedUpTo !== undefined && globalIndex > revealedUpTo;
            const current = cursorIndex === globalIndex;
            const selected = selectedIndex === globalIndex;
            return (
              <div
                key={`${event.id}-${position}`}
                className={[
                  "event-card compact",
                  current ? "current" : "",
                  future ? "future" : "",
                  selected ? "sel" : "",
                  sort.dragging === position ? "dragging" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={sort.itemStyle(position) as CSSProperties}
                onClick={() => onSelect?.(globalIndex)}
                title={`${zhEventLabel(event.type)} · ${new Date(event.timestamp).toLocaleString()}`}
              >
                {onMove ? (
                  <span className="grip" {...sort.handleProps(position)} title="按住拖动，调整事件顺序">
                    ⠿
                  </span>
                ) : (
                  <span className="grip static" title={event.id}>
                    {String(position + 1).padStart(2, "0")}
                  </span>
                )}
                <div className="card-main">
                  <div className="card-line">
                    <span className="ev-type">{zhEventLabel(event.type)}</span>
                    <span className="spacer" />
                    <span className="ev-time">+{formatSpan(Math.max(0, event.timestamp - first))}</span>
                  </div>
                  <div className="card-line">
                    <span className="ev-summary">{eventSummary(event)}</span>
                    <span className="ev-meta">{eventMeta(event)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {footer}
    </div>
  );
}
