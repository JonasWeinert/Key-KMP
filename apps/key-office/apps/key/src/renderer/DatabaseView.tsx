// A database view over any kind of row (sources now; notes and records later):
// virtualized grid, list and table layouts, a toolbar to switch between them, and
// table columns the user can show, hide, reorder, resize and pin, sorted on several levels.
import { useVirtualizer } from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./icons";
import {
  clickSort,
  moveColumn,
  readViewState,
  resolveColumns,
  updateColumn,
  writeViewState,
  type DatabaseLayout,
  type DatabaseViewState,
  type ResolvedColumn,
  type SortLevel,
} from "./database-view-model";
import "./database-view.css";

export type { DatabaseLayout, SortLevel } from "./database-view-model";

export interface DatabaseColumn<T> {
  id: string;
  label: string;
  /** Default width in pixels. */
  width: number;
  hidden?: boolean;
  pinned?: boolean;
  /** The sort field this column sorts by; unsortable without one. */
  sortField?: string;
  numeric?: boolean;
  /** Shown before the label (e.g. ƒ for calculated properties). */
  mark?: string;
  render: (row: T) => ReactNode;
  /** Adds "Edit property…" to the column's menu. */
  onEdit?: () => void;
}

const LAYOUTS: [DatabaseLayout, string, IconName][] = [
  ["grid", "Grid", "grid"],
  ["list", "List", "list"],
  ["table", "Table", "table"],
];

/** The view's layout, column settings and sort levels, remembered under `key`. */
export function useDatabaseViewState(key: string, fallback: DatabaseViewState) {
  const [state, setState] = useState(() => readViewState(key, fallback));
  const loaded = useRef(key);
  useEffect(() => {
    if (loaded.current === key) return;
    loaded.current = key;
    setState(readViewState(key, fallback));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = useCallback(
    (patch: Partial<DatabaseViewState>) =>
      setState((previous) => {
        const next = { ...previous, ...patch };
        writeViewState(key, next);
        return next;
      }),
    [key],
  );
  return [state, update] as const;
}

/** Layout switch, sort menu and (in table layout) column menu. */
export function DatabaseToolbar<T>({
  state,
  onChange,
  columns,
  sortFields,
  layouts = ["grid", "list", "table"],
  columnFooter,
}: {
  state: DatabaseViewState;
  onChange: (patch: Partial<DatabaseViewState>) => void;
  columns: DatabaseColumn<T>[];
  /** Everything the rows can be sorted by, including fields without a column. */
  sortFields: [string, string][];
  layouts?: DatabaseLayout[];
  /** Extra items under the column list, like "New property…". */
  columnFooter?: ReactNode;
}) {
  return (
    <>
      <SortMenu sorts={state.sorts} fields={sortFields} onChange={(sorts) => onChange({ sorts })} />
      {state.layout === "table" && <ColumnMenu columns={columns} settings={state} onChange={onChange} footer={columnFooter} />}
      <div className="kx-segmented" role="group" aria-label="Layout">
        {LAYOUTS.filter(([id]) => layouts.includes(id)).map(([id, label, icon]) => (
          <button key={id} aria-pressed={state.layout === id} aria-label={label} title={label} onClick={() => onChange({ layout: id })}>
            <Icon name={icon} size={15} />
          </button>
        ))}
      </div>
    </>
  );
}

/** A popover that closes on outside clicks and Escape. */
function Popover({
  label,
  summary,
  className,
  children,
}: {
  label: string;
  summary: ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div className="kx-menu" ref={ref}>
      <button className="kx-control" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        {summary}
      </button>
      {open && (
        <div className={`kx-menu-popover ${className ?? ""}`} role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function SortMenu({ sorts, fields, onChange }: { sorts: SortLevel[]; fields: [string, string][]; onChange: (sorts: SortLevel[]) => void }) {
  const label = (field: string) => fields.find(([id]) => id === field)?.[1] ?? field;
  const unused = fields.filter(([id]) => !sorts.some((s) => s.field === id));
  return (
    <Popover
      label="Sort"
      className="kx-sort-popover"
      summary={
        <>
          <Icon name="sort" size={14} />
          <span>{sorts.length ? label(sorts[0].field) : "Sort"}</span>
          {sorts.length > 1 && <span className="kx-count">+{sorts.length - 1}</span>}
        </>
      }
    >
      {() => (
        <>
          <div className="kx-sort-levels">
            {sorts.map((level, index) => (
              <div key={level.field} className="kx-sort-level" aria-label={`Sort level ${index + 1}`}>
                <span className="kx-sort-ordinal">{index === 0 ? "Sort by" : "then by"}</span>
                <select
                  aria-label={`Sort field ${index + 1}`}
                  value={level.field}
                  onChange={(e) => onChange(sorts.map((s, i) => (i === index ? { ...s, field: e.target.value } : s)))}
                >
                  {fields
                    .filter(([id]) => id === level.field || !sorts.some((s) => s.field === id))
                    .map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                </select>
                <button
                  className="kx-sort-direction"
                  aria-label={`${level.descending ? "Descending" : "Ascending"}, switch direction of ${label(level.field)}`}
                  title={level.descending ? "Descending" : "Ascending"}
                  onClick={() => onChange(sorts.map((s, i) => (i === index ? { ...s, descending: !s.descending } : s)))}
                >
                  <Icon name="chevronDown" size={12} style={{ transform: level.descending ? undefined : "rotate(180deg)" }} />
                  {level.descending ? "Desc" : "Asc"}
                </button>
                <button
                  className="kx-sort-remove"
                  aria-label={`Remove sort by ${label(level.field)}`}
                  disabled={sorts.length === 1}
                  onClick={() => onChange(sorts.filter((_, i) => i !== index))}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
          <hr />
          <button disabled={!unused.length} onClick={() => onChange([...sorts, { field: unused[0][0], descending: false }])}>
            <Icon name="plus" size={13} /> Add sort level
          </button>
          <p className="kx-menu-hint">Shift-click a column header to sort within a sort.</p>
        </>
      )}
    </Popover>
  );
}

function ColumnMenu<T>({
  columns,
  settings,
  onChange,
  footer,
}: {
  columns: DatabaseColumn<T>[];
  settings: DatabaseViewState;
  onChange: (patch: Partial<DatabaseViewState>) => void;
  footer?: ReactNode;
}) {
  const resolved = resolveColumns(columns, settings.columns);
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<number>();
  return (
    <Popover
      label="Columns"
      className="kx-columns-popover"
      summary={
        <>
          <Icon name="columns" size={14} />
          Columns
        </>
      }
    >
      {() => (
        <>
          {resolved.map((r, index) => (
            <label
              key={r.column.id}
              data-drop={dragging && over === index ? true : undefined}
              data-dragging={dragging === r.column.id || undefined}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", r.column.id);
                setDragging(r.column.id);
              }}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setOver(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && over !== undefined) onChange({ columns: moveColumn(resolved, dragging, over) });
                setDragging(undefined);
                setOver(undefined);
              }}
              onDragEnd={() => {
                setDragging(undefined);
                setOver(undefined);
              }}
            >
              <span className="kx-column-grip" aria-hidden="true">
                <Icon name="grip" size={12} />
              </span>
              <input
                type="checkbox"
                aria-label={`Show ${r.column.label}`}
                checked={!r.hidden}
                onChange={(e) => onChange({ columns: updateColumn(resolved, r.column.id, { hidden: !e.target.checked }) })}
              />
              <span>{r.column.label}</span>
              <button
                className="kx-column-pin"
                aria-label={`${r.pinned ? "Unpin" : "Pin"} ${r.column.label}`}
                aria-pressed={r.pinned}
                title={r.pinned ? "Unpin" : "Pin to the left"}
                onClick={(e) => {
                  e.preventDefault();
                  onChange({ columns: updateColumn(resolved, r.column.id, { pinned: !r.pinned }) });
                }}
              >
                <Icon name="pin" size={12} />
              </button>
              {r.column.onEdit && (
                <button
                  title="Edit property"
                  aria-label={`Edit ${r.column.label} property`}
                  onClick={(e) => {
                    e.preventDefault();
                    r.column.onEdit?.();
                  }}
                >
                  <Icon name="chevronRight" size={11} />
                </button>
              )}
            </label>
          ))}
          {footer && <hr />}
          {footer}
        </>
      )}
    </Popover>
  );
}

export interface DatabaseViewHandle {
  scrollToIndex: (index: number) => void;
  focus: () => void;
}
export interface RowState {
  selected: boolean;
  focused: boolean;
}

interface Props<T> {
  rows: T[];
  rowId: (row: T) => string;
  state: DatabaseViewState;
  onChange: (patch: Partial<DatabaseViewState>) => void;
  columns: DatabaseColumn<T>[];
  label: string;
  className?: string;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  isSelected: (row: T) => boolean;
  isFocused: (row: T) => boolean;
  onPointer: (row: T, event: React.MouseEvent) => void;
  onOpen: (row: T) => void;
  onDragStart?: (row: T, event: React.DragEvent) => void;
  /** Extra attributes on each row or card (the item it shows, for previews and menus). */
  rowAttrs?: (row: T) => Record<string, string | undefined>;
  /** List layout: the row element itself, absolutely placed at `top`. */
  renderListRow: (row: T, top: number, state: RowState) => ReactNode;
  listRowHeight?: number;
  /** Grid layout: the card's cover and caption. */
  renderCard: (row: T, state: RowState) => ReactNode;
  /** The visible range changed (indices into `rows`), for paging and prefetch. */
  onRange?: (first: number, last: number) => void;
}

const TABLE_ROW = 34;
const CARD_MIN = 158;
const CARD_GAP = 20;
const CARD_HEIGHT = 286;
const GRID_PAD = 20;

function DatabaseViewInner<T>(
  {
    rows,
    rowId,
    state,
    onChange,
    columns,
    label,
    className = "kx-list",
    empty,
    isSelected,
    isFocused,
    onPointer,
    onOpen,
    onDragStart,
    rowAttrs,
    renderListRow,
    listRowHeight = 58,
    renderCard,
    onRange,
  }: Props<T>,
  ref: React.Ref<DatabaseViewHandle>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const layout = state.layout;
  const perRow = layout === "grid" ? Math.max(1, Math.floor((width - GRID_PAD * 2 + CARD_GAP) / (CARD_MIN + CARD_GAP))) : 1;
  const count = layout === "grid" ? Math.ceil(rows.length / perRow) : rows.length;
  const size = layout === "grid" ? CARD_HEIGHT : layout === "table" ? TABLE_ROW : listRowHeight;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => size,
    overscan: layout === "grid" ? 3 : 12,
    paddingStart: layout === "grid" ? 14 : 0,
    scrollMargin: 0,
  });
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, perRow, size]);
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index) => virtualizer.scrollToIndex(Math.floor(index / perRow), { align: "auto" }),
      focus: () => scrollRef.current?.focus(),
    }),
    [virtualizer, perRow],
  );
  const items = virtualizer.getVirtualItems();
  const first = items.length ? items[0].index * perRow : 0;
  const last = items.length ? Math.min(rows.length - 1, (items[items.length - 1].index + 1) * perRow - 1) : -1;
  const latestRange = useRef(onRange);
  latestRange.current = onRange;
  useEffect(() => {
    latestRange.current?.(first, last);
  }, [first, last]);

  const resolved = useMemo(() => resolveColumns(columns, state.columns), [columns, state.columns]);
  const visible = resolved.filter((r) => !r.hidden);
  const table = layout === "table";
  const tableWidth = visible.reduce((sum, r) => sum + r.width, 0);

  const rowProps = (row: T) => ({
    role: "option" as const,
    "aria-selected": isSelected(row),
    "data-focused": isFocused(row),
    onMouseDown: (e: React.MouseEvent) => onPointer(row, e),
    onDoubleClick: () => onOpen(row),
    draggable: !!onDragStart,
    onDragStart: onDragStart ? (e: React.DragEvent) => onDragStart(row, e) : undefined,
    ...rowAttrs?.(row),
  });

  return (
    <div
      className={className}
      ref={scrollRef}
      tabIndex={0}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      data-layout={layout}
    >
      {!rows.length && empty ? (
        empty
      ) : (
        <>
          {table && <TableHead resolved={resolved} visible={visible} width={tableWidth} sorts={state.sorts} onChange={onChange} />}
          <div className="kx-db-body" style={{ height: virtualizer.getTotalSize(), width: table ? tableWidth : undefined }}>
            {items.map((item) => {
              if (layout === "grid") {
                const slice = rows.slice(item.index * perRow, item.index * perRow + perRow);
                return (
                  <div
                    key={item.key}
                    className="kx-db-grid-row"
                    style={{ transform: `translateY(${item.start}px)`, gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
                  >
                    {slice.map((row) => (
                      <div key={rowId(row)} className="kx-db-card" {...rowProps(row)}>
                        {renderCard(row, { selected: isSelected(row), focused: isFocused(row) })}
                      </div>
                    ))}
                  </div>
                );
              }
              const row = rows[item.index];
              if (!row) return null;
              if (layout === "list") return <ListSlot key={rowId(row)}>{renderListRow(row, item.start, { selected: isSelected(row), focused: isFocused(row) })}</ListSlot>;
              return (
                <div
                  key={rowId(row)}
                  className="kx-table-row"
                  {...rowProps(row)}
                  style={{ transform: `translateY(${item.start}px)`, gridTemplateColumns: gridTemplate(visible) }}
                >
                  {visible.map((r) => (
                    <span
                      key={r.column.id}
                      className={`kx-db-cell${r.column.numeric ? " kx-cell-number" : ""}`}
                      data-pinned={r.pinned || undefined}
                      data-column={r.column.id}
                      style={r.pinned ? { left: pinnedLeft(visible, r) } : undefined}
                    >
                      {r.column.render(row)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const ListSlot = ({ children }: { children: ReactNode }) => <>{children}</>;

export const DatabaseView = forwardRef(DatabaseViewInner) as <T>(
  props: Props<T> & { ref?: React.Ref<DatabaseViewHandle> },
) => ReturnType<typeof DatabaseViewInner>;

const gridTemplate = <C,>(visible: ResolvedColumn<DatabaseColumn<C>>[]) => `${visible.map((r) => `${r.width}px`).join(" ")} minmax(0, 1fr)`;
const pinnedLeft = <C,>(visible: ResolvedColumn<DatabaseColumn<C>>[], column: ResolvedColumn<DatabaseColumn<C>>) =>
  visible.slice(0, visible.indexOf(column)).reduce((sum, r) => sum + (r.pinned ? r.width : 0), 0);

/** Header cells: click to sort (Shift adds a level), drag to reorder, drag the edge to resize. */
function TableHead<T>({
  resolved,
  visible,
  width,
  sorts,
  onChange,
}: {
  resolved: ResolvedColumn<DatabaseColumn<T>>[];
  visible: ResolvedColumn<DatabaseColumn<T>>[];
  width: number;
  sorts: SortLevel[];
  onChange: (patch: Partial<DatabaseViewState>) => void;
}) {
  const cells = useRef<Record<string, HTMLElement | null>>({});
  const [drag, setDrag] = useState<{ id: string; drop: number; offset: number }>();
  const [resizing, setResizing] = useState<{ id: string; width: number }>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const live = resizing ? visible.map((r) => (r.column.id === resizing.id ? { ...r, width: resizing.width } : r)) : visible;

  // Index into `resolved` (the full order) that a drop at x lands before.
  const dropIndex = (x: number) => {
    for (const r of visible) {
      const rect = cells.current[r.column.id]?.getBoundingClientRect();
      if (rect && x < rect.left + rect.width / 2) return resolved.indexOf(r);
    }
    return resolved.length;
  };

  // The whole gesture runs on window listeners and ends however the pointer is released
  // (outside the window, lost capture, blur), so a header never stays pressed or dragged.
  const startDrag = (r: ResolvedColumn<DatabaseColumn<T>>, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".kx-db-resize, .kx-db-head-menu")) return;
    const startX = e.clientX;
    const shift = e.shiftKey;
    let moved = false;
    const finish = (commit: boolean, x?: number) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      setDrag(undefined);
      if (!commit) return;
      if (moved && x !== undefined) onChange({ columns: moveColumn(resolved, r.column.id, dropIndex(x)) });
      else if (!moved && r.column.sortField) onChange({ sorts: clickSort(sorts, r.column.sortField, shift, r.column.sortField === "added") });
    };
    const move = (ev: PointerEvent) => {
      // A release we never saw (outside the window) ends the drag on the next move, moving nothing.
      if (!(ev.buttons & 1)) return finish(false);
      if (!moved && Math.abs(ev.clientX - startX) < 4) return;
      moved = true;
      setDrag({ id: r.column.id, drop: dropIndex(ev.clientX), offset: ev.clientX - startX });
    };
    const up = (ev: PointerEvent) => finish(true, ev.clientX);
    const cancel = () => finish(false);
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
  };

  const startResize = (r: ResolvedColumn<DatabaseColumn<T>>, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    let next = r.width;
    const move = (ev: PointerEvent) => {
      if (!(ev.buttons & 1)) return end();
      next = Math.max(56, Math.min(900, r.width + ev.clientX - startX));
      setResizing({ id: r.column.id, width: next });
    };
    const end = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      setResizing(undefined);
      if (next !== r.width) onChange({ columns: updateColumn(resolved, r.column.id, { width: next }) });
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
  };

  const menuColumn = menu && resolved.find((r) => r.column.id === menu.id);
  const set = (id: string, patch: Parameters<typeof updateColumn>[2]) => onChange({ columns: updateColumn(resolved, id, patch) });
  const sortBy = (field: string, descending: boolean, additive: boolean) =>
    onChange({ sorts: additive ? [...sorts.filter((s) => s.field !== field), { field, descending }] : [{ field, descending }] });

  return (
    <div className="kx-table-head" role="row" style={{ gridTemplateColumns: gridTemplate(live), width }} data-dragging={drag ? true : undefined}>
      {live.map((r) => {
        const level = r.column.sortField ? sorts.findIndex((s) => s.field === r.column.sortField) : -1;
        const index = resolved.indexOf(visible.find((v) => v.column.id === r.column.id)!);
        return (
          <div
            key={r.column.id}
            ref={(el) => {
              cells.current[r.column.id] = el;
            }}
            role="columnheader"
            className="kx-db-head-cell"
            aria-sort={level === 0 ? (sorts[0].descending ? "descending" : "ascending") : undefined}
            data-sorted={level >= 0 || undefined}
            data-pinned={r.pinned || undefined}
            data-dragging={drag?.id === r.column.id || undefined}
            data-drop-before={drag && drag.id !== r.column.id && drag.drop === index ? true : undefined}
            style={{
              left: r.pinned ? pinnedLeft(live, r) : undefined,
              transform: drag?.id === r.column.id ? `translateX(${drag.offset}px)` : undefined,
            }}
            title={r.column.sortField ? `Sort by ${r.column.label} · Shift-click to sort within the current sort · drag to move` : "Drag to move"}
            onPointerDown={(e) => startDrag(r, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: r.column.id, x: e.clientX, y: e.clientY });
            }}
          >
            {r.pinned && <Icon name="pin" size={10} className="kx-db-pin-mark" />}
            <span className="kx-db-head-label">
              {r.column.mark}
              {r.column.label}
            </span>
            {level >= 0 && (
              <span className="kx-db-sort-mark">
                <Icon name="chevronDown" size={10} style={{ transform: sorts[level].descending ? undefined : "rotate(180deg)" }} />
                {sorts.length > 1 && <small>{level + 1}</small>}
              </span>
            )}
            <button
              className="kx-db-head-menu"
              aria-label={`${r.column.label} column options`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu(menu?.id === r.column.id ? undefined : { id: r.column.id, x: rect.left, y: rect.bottom + 4 });
              }}
            >
              <Icon name="chevronDown" size={10} />
            </button>
            <span
              className="kx-db-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${r.column.label} column`}
              aria-valuenow={r.width}
              tabIndex={0}
              onPointerDown={(e) => startResize(r, e)}
              onDoubleClick={() => set(r.column.id, { width: r.column.width })}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  set(r.column.id, { width: r.width + (e.key === "ArrowLeft" ? -20 : 20) });
                }
              }}
            />
          </div>
        );
      })}
      {drag && drag.drop === resolved.length && <span className="kx-db-drop-end" />}
      {menu && menuColumn && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} label={`${menuColumn.column.label} column`}>
          {(close) => {
            const field = menuColumn.column.sortField;
            const item = (text: string, icon: IconName, run: () => void, disabled = false) => (
              <button
                key={text}
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  run();
                  close();
                }}
              >
                <Icon name={icon} size={13} />
                {text}
              </button>
            );
            return [
              field && item("Sort ascending", "chevronUpDown", () => sortBy(field, false, false)),
              field && item("Sort descending", "chevronUpDown", () => sortBy(field, true, false)),
              field && sorts.length > 0 && !(sorts.length === 1 && sorts[0].field === field) && item("Then sort by this", "sort", () => sortBy(field, false, true)),
              field && <hr key="sort-rule" />,
              item(menuColumn.pinned ? "Unpin column" : "Pin column", "pin", () => set(menuColumn.column.id, { pinned: !menuColumn.pinned })),
              item("Hide column", "close", () => set(menuColumn.column.id, { hidden: true }), visible.length <= 1),
              item("Reset width", "columns", () => set(menuColumn.column.id, { width: menuColumn.column.width })),
              menuColumn.column.onEdit && item("Edit property…", "gear", () => menuColumn.column.onEdit?.()),
            ];
          }}
        </ContextMenu>
      )}
    </div>
  );
}

/** A floating menu at a point, closed by outside clicks, Escape or choosing an item. */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ x, y });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace({ x: Math.min(x, window.innerWidth - rect.width - 8), y: Math.min(y, window.innerHeight - rect.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  // Drawn on the body: inside the sidebar (or any pane with a transform or filter) a fixed
  // menu would be framed and clipped by that pane.
  return createPortal(
    <div
      ref={ref}
      className="kx-menu-popover kx-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      {children(onClose)}
    </div>,
    document.body,
  );
}
