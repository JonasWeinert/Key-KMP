// Adapted from beUI Table (MIT; ../BEUI-LICENSE.txt). Key owns persisted order.
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { capturePointer, releasePointer } from "./touch";
import type { HeaderCellRefs, TableColumn } from "./types";

export function useColumnReorder<T>({
  columns,
  thRefs,
  onColumnOrderChange,
}: {
  columns: TableColumn<T>[];
  thRefs: HeaderCellRefs;
  onColumnOrderChange?: (keys: string[]) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const cancelReorder = () => {
    cleanup.current?.();
    setDragKey(null);
    setDropIndex(null);
  };
  const startReorder = (key: string, event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    cancelReorder();
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget,
      pointerId = event.pointerId;
    const indexFor = (x: number) => {
      for (let i = 0; i < columns.length; i++) {
        const rect = thRefs.current[columns[i].key]?.getBoundingClientRect();
        if (rect && x < rect.left + rect.width / 2) return i;
      }
      return columns.length;
    };
    // Native listeners and release coordinates avoid stale React state on quick
    // drags and retain ownership if rendering changes the original hit target.
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId) setDropIndex(indexFor(e.clientX));
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const keys = columns.map((c) => c.key),
        from = keys.indexOf(key);
      let to = indexFor(e.clientX);
      cancelReorder();
      if (from < 0) return;
      keys.splice(from, 1);
      if (from < to) to--;
      keys.splice(to, 0, key);
      onColumnOrderChange?.(keys);
    };
    const cancel = () => cancelReorder();
    cleanup.current = () => {
      cleanup.current = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      releasePointer(element, pointerId);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    capturePointer(element, pointerId);
    setDragKey(key);
  };
  return { dragKey, dropIndex, startReorder, cancelReorder };
}
