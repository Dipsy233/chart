/**
 * Drag-to-reorder, without a dependency.
 *
 * The handle on the left of a card starts the drag; the cards are a fixed height,
 * so the target slot is arithmetic rather than a hit test. Everything else is
 * `transform`, which the browser composites — no layout thrash while dragging.
 *
 * The hook returns `handleProps(index)` for the grip and `itemStyle(index)` for
 * each card, so a list keeps its own markup and only borrows the behaviour.
 */

import { useCallback, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

interface DragState {
  from: number;
  to: number;
  dy: number;
}

export interface DragSort {
  listRef: React.MutableRefObject<HTMLDivElement | null>;
  dragging: number | null;
  target: number | null;
  handleProps: (index: number) => { onPointerDown: (event: ReactPointerEvent) => void };
  itemStyle: (index: number) => CSSProperties;
}

export function useDragSort(
  count: number,
  itemHeight: number,
  gap: number,
  onMove: (from: number, to: number) => void,
): DragSort {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const update = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (event: ReactPointerEvent) => {
        if (event.button !== 0) return;
        const list = listRef.current;
        if (!list) return;
        event.preventDefault();
        event.stopPropagation();

        const startY = event.clientY;
        const listTop = list.getBoundingClientRect().top - list.scrollTop;
        update({ from: index, to: index, dy: 0 });
        document.body.classList.add("is-dragging");

        const move = (moveEvent: PointerEvent) => {
          const dy = moveEvent.clientY - startY;
          const center = listTop + index * (itemHeight + gap) + itemHeight / 2 + dy;
          const slot = Math.floor((center - listTop) / (itemHeight + gap));
          const to = Math.max(0, Math.min(count - 1, slot));
          update({ from: index, to, dy });
        };

        const end = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          document.body.classList.remove("is-dragging");
          const last = dragRef.current;
          update(null);
          if (last && last.to !== last.from) onMove(last.from, last.to);
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
      },
    }),
    [count, gap, itemHeight, onMove, update],
  );

  const itemStyle = useCallback(
    (index: number): CSSProperties => {
      if (!drag) return {};
      if (index === drag.from) {
        return { transform: `translateY(${drag.dy}px)`, zIndex: 6, position: "relative" };
      }
      if (drag.from < drag.to && index > drag.from && index <= drag.to) {
        return { transform: `translateY(${-(itemHeight + gap)}px)` };
      }
      if (drag.from > drag.to && index >= drag.to && index < drag.from) {
        return { transform: `translateY(${itemHeight + gap}px)` };
      }
      return {};
    },
    [drag, gap, itemHeight],
  );

  return {
    listRef,
    dragging: drag?.from ?? null,
    target: drag?.to ?? null,
    handleProps,
    itemStyle,
  };
}
