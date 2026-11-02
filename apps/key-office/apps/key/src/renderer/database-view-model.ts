// State for the shared database view (grid, list and table over any kind of row):
// which layout, which columns in what order and width, and the sort levels.
export type DatabaseLayout = "grid" | "list" | "table";
export interface SortLevel {
  field: string;
  descending: boolean;
}
/** What the user changed about a column; anything left out uses the column's default. */
export interface ColumnSetting {
  id: string;
  width?: number;
  hidden?: boolean;
  pinned?: boolean;
}
export interface DatabaseViewState {
  layout: DatabaseLayout;
  /** In display order; columns not listed keep their default place after these. */
  columns: ColumnSetting[];
  sorts: SortLevel[];
}
export interface ColumnDefaults {
  id: string;
  width: number;
  hidden?: boolean;
  pinned?: boolean;
}
export interface ResolvedColumn<C extends ColumnDefaults> {
  column: C;
  width: number;
  hidden: boolean;
  pinned: boolean;
}

export const MIN_COLUMN = 56;
export const MAX_COLUMN = 900;
export const clampWidth = (width: number) => Math.round(Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, width)));

/** Columns in display order with the user's settings applied; pinned ones lead. */
export function resolveColumns<C extends ColumnDefaults>(columns: C[], settings: ColumnSetting[]): ResolvedColumn<C>[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const ordered: ResolvedColumn<C>[] = [];
  const add = (column: C, setting?: ColumnSetting) => {
    seen.add(column.id);
    ordered.push({
      column,
      width: clampWidth(setting?.width ?? column.width),
      hidden: setting?.hidden ?? !!column.hidden,
      pinned: setting?.pinned ?? !!column.pinned,
    });
  };
  for (const setting of settings) {
    const column = byId.get(setting.id);
    if (column && !seen.has(column.id)) add(column, setting);
  }
  // New columns (a property defined later) go after their default neighbour.
  columns.forEach((column, index) => {
    if (seen.has(column.id)) return;
    const before = columns.slice(0, index).reverse().find((c) => seen.has(c.id));
    const at = before ? ordered.findIndex((r) => r.column.id === before.id) + 1 : 0;
    seen.add(column.id);
    ordered.splice(at, 0, { column, width: clampWidth(column.width), hidden: !!column.hidden, pinned: !!column.pinned });
  });
  return [...ordered.filter((c) => c.pinned), ...ordered.filter((c) => !c.pinned)];
}

/** Settings for every column, so order survives columns being added later. */
export function toSettings<C extends ColumnDefaults>(resolved: ResolvedColumn<C>[]): ColumnSetting[] {
  return resolved.map((r) => ({ id: r.column.id, width: r.width, hidden: r.hidden, pinned: r.pinned }));
}

export function updateColumn<C extends ColumnDefaults>(resolved: ResolvedColumn<C>[], id: string, patch: Partial<Omit<ColumnSetting, "id">>) {
  return toSettings(resolved.map((r) => (r.column.id === id ? { ...r, ...patch, width: patch.width !== undefined ? clampWidth(patch.width) : r.width } : r)));
}

/** Moves a column to sit before `to` (an index into the full order; length = last). */
export function moveColumn<C extends ColumnDefaults>(resolved: ResolvedColumn<C>[], id: string, to: number) {
  const list = [...resolved];
  const from = list.findIndex((r) => r.column.id === id);
  if (from < 0) return toSettings(list);
  const [moved] = list.splice(from, 1);
  const target = Math.max(0, Math.min(list.length, from < to ? to - 1 : to));
  // Crossing into the pinned group pins it, leaving it unpins it.
  const pinnedCount = list.filter((r) => r.pinned).length;
  list.splice(target, 0, { ...moved, pinned: target < pinnedCount || (moved.pinned && target === pinnedCount) });
  return toSettings(list);
}

/**
 * Header clicks: a plain click sorts by that field alone (again flips it);
 * with `additive` (Shift) it adds a level, flips an existing one, or a third click removes it.
 */
export function clickSort(sorts: SortLevel[], field: string, additive: boolean, defaultDescending = false): SortLevel[] {
  const existing = sorts.find((s) => s.field === field);
  if (!additive) {
    if (existing && sorts.length === 1) return [{ field, descending: !existing.descending }];
    return [{ field, descending: existing?.descending ?? defaultDescending }];
  }
  if (!existing) return [...sorts, { field, descending: defaultDescending }];
  if (existing.descending === defaultDescending) return sorts.map((s) => (s.field === field ? { ...s, descending: !s.descending } : s));
  const rest = sorts.filter((s) => s.field !== field);
  return rest.length ? rest : sorts;
}

export function readViewState(key: string, fallback: DatabaseViewState): DatabaseViewState {
  try {
    const saved = JSON.parse(localStorage.getItem(`key.view:${key}`) || "null") as Partial<DatabaseViewState> | null;
    if (!saved) return fallback;
    return {
      layout: saved.layout === "grid" || saved.layout === "list" || saved.layout === "table" ? saved.layout : fallback.layout,
      columns: Array.isArray(saved.columns) ? saved.columns.filter((c) => c && typeof c.id === "string") : fallback.columns,
      sorts: Array.isArray(saved.sorts) && saved.sorts.length ? saved.sorts.filter((s) => s && typeof s.field === "string") : fallback.sorts,
    };
  } catch {
    return fallback;
  }
}
export function writeViewState(key: string, state: DatabaseViewState) {
  try {
    localStorage.setItem(`key.view:${key}`, JSON.stringify(state));
  } catch {}
}
