// beUI Table base, adapted from https://beui.dev/components/motion/table (MIT).
// See ../BEUI-LICENSE.txt. Key supplies source-specific header/cell renderers,
// server ordering, sticky columns, and the existing pane scroll container.
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  cloneElement,
  useCallback,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import "./table.css";
export function Table<T>({
  data,
  columns,
  getRowId,
  header,
  renderRow,
  rowHeight = 56,
}: {
  data: T[];
  columns: { id: string; width: number }[];
  getRowId: (row: T) => string;
  header: ReactNode;
  renderRow: (row: T) => ReactElement<any>;
  rowHeight?: number;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const getScrollElement = useCallback(
    () => tableRef.current?.closest<HTMLElement>(".key-library-scroll") || null,
    [],
  );
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement,
    estimateSize: () => rowHeight,
    overscan: 8,
    getItemKey: (index) => getRowId(data[index]),
    scrollMargin: 44,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length
    ? Math.max(0, virtualItems[0].start - 44)
    : 0;
  const paddingBottom = virtualItems.length
    ? Math.max(0, virtualizer.getTotalSize() - (virtualItems.at(-1)!.end - 44))
    : 0;
  return (
    <table
      ref={tableRef}
      className="key-source-grid key-beui-table"
      aria-label="Sources"
      aria-rowcount={data.length + 1}
      style={{
        minWidth: columns.reduce((sum, c) => sum + c.width, 84),
        width: "100%",
        tableLayout: "fixed",
      }}
    >
      <colgroup>
        <col style={{ width: 42 }} />
        {columns.map((c) => (
          <col key={c.id} style={{ width: c.width }} />
        ))}
        <col style={{ width: 42 }} />
        <col />
      </colgroup>
      {header}
      <tbody>
        {paddingTop > 0 && (
          <tr
            aria-hidden="true"
            className="key-table-spacer"
            style={{ height: paddingTop }}
          >
            <td colSpan={columns.length + 3} />
          </tr>
        )}
        {virtualItems.map((item) =>
          cloneElement(renderRow(data[item.index]), {
            key: item.key,
            "data-index": item.index,
            "aria-rowindex": item.index + 2,
            ref: virtualizer.measureElement,
            style: { height: rowHeight },
          }),
        )}
        {paddingBottom > 0 && (
          <tr
            aria-hidden="true"
            className="key-table-spacer"
            style={{ height: paddingBottom }}
          >
            <td colSpan={columns.length + 3} />
          </tr>
        )}
      </tbody>
    </table>
  );
}
