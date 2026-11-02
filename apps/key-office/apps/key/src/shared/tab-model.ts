/** A tab's arrangement: one view, or a split whose halves are arrangements themselves.
 * `row` places `a` left of `b`; `column` places `a` above `b`. */
export type PaneLayout =
  | { view: string }
  | { split: "row" | "column"; ratio: number; a: PaneLayout; b: PaneLayout };

export interface WorkspaceTab {
  id: string;
  /** The layout's views in reading order (left to right, top to bottom). */
  viewIds: string[];
  activeViewId: string;
  /** The root split's ratio (0.5 for a single pane). */
  splitRatio: number;
  layout: PaneLayout;
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}

export type SplitEdge = "left" | "right" | "top" | "bottom";

export const LIBRARY_VIEW_ID = "key:library";
/** More panes than this stop being readable in one window. */
export const MAX_PANES = 8;
const MIN_RATIO = 0.1,
  MAX_RATIO = 0.9;

export function layoutViews(layout: PaneLayout): string[] {
  return "view" in layout ? [layout.view] : [...layoutViews(layout.a), ...layoutViews(layout.b)];
}

/** A tab around `layout`, keeping `activeViewId` when it is still part of it. */
export function tabWithLayout(tab: Pick<WorkspaceTab, "id"> & Partial<WorkspaceTab>, layout: PaneLayout): WorkspaceTab {
  const viewIds = layoutViews(layout);
  return {
    id: tab.id,
    viewIds,
    activeViewId: tab.activeViewId && viewIds.includes(tab.activeViewId) ? tab.activeViewId : viewIds[0],
    splitRatio: "view" in layout ? 0.5 : layout.ratio,
    layout,
  };
}

export function singleWorkspaceTab(viewId: string): WorkspaceTab {
  return tabWithLayout({ id: crypto.randomUUID() }, { view: viewId });
}

/** `layout` with `viewId` taken out; its sibling takes the parent split's place. */
export function removeFromLayout(layout: PaneLayout, viewId: string): PaneLayout | null {
  if ("view" in layout) return layout.view === viewId ? null : layout;
  const a = removeFromLayout(layout.a, viewId),
    b = removeFromLayout(layout.b, viewId);
  if (!a) return b;
  if (!b) return a;
  return a === layout.a && b === layout.b ? layout : { ...layout, a, b };
}

/** Places `insert` beside the pane showing `targetViewId`, on its `edge`. */
export function insertIntoLayout(layout: PaneLayout, targetViewId: string, insert: PaneLayout, edge: SplitEdge): PaneLayout {
  if ("view" in layout) {
    if (layout.view !== targetViewId) return layout;
    const split = edge === "left" || edge === "right" ? "row" : "column";
    const before = edge === "left" || edge === "top";
    return { split, ratio: 0.5, a: before ? insert : layout, b: before ? layout : insert };
  }
  return {
    ...layout,
    a: insertIntoLayout(layout.a, targetViewId, insert, edge),
    b: insertIntoLayout(layout.b, targetViewId, insert, edge),
  };
}

function mapViews(layout: PaneLayout, map: (id: string) => string): PaneLayout {
  return "view" in layout ? { view: map(layout.view) } : { ...layout, a: mapViews(layout.a, map), b: mapViews(layout.b, map) };
}

/** Splits are addressed by their path from the root: "" is the root, "ab" is the root's a's b. */
export function layoutAt(layout: PaneLayout, path: string): PaneLayout | undefined {
  let node: PaneLayout | undefined = layout;
  for (const step of path) node = node && "split" in node ? (step === "a" ? node.a : node.b) : undefined;
  return node;
}
function updateAt(layout: PaneLayout, path: string, update: (node: PaneLayout) => PaneLayout): PaneLayout {
  if (!path) return update(layout);
  if (!("split" in layout)) return layout;
  return path[0] === "a"
    ? { ...layout, a: updateAt(layout.a, path.slice(1), update) }
    : { ...layout, b: updateAt(layout.b, path.slice(1), update) };
}
/** The path of the split directly holding `viewId`'s pane. */
function parentPath(layout: PaneLayout, viewId: string, path = ""): string | undefined {
  if ("view" in layout) return undefined;
  for (const side of ["a", "b"] as const) {
    const child = layout[side];
    if ("view" in child && child.view === viewId) return path;
    const found = parentPath(child, viewId, path + side);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LaidOutPane extends PaneRect {
  viewId: string;
}
export interface LaidOutDivider extends PaneRect {
  path: string;
  split: "row" | "column";
  ratio: number;
  /** The extent the divider's ratio is measured against. */
  parent: PaneRect;
}
/** Pixel rectangles for every pane and divider. Each divider is 2 × `gap` wide.
 * Main (native views) and renderer (DOM panes, dividers) share this, so they never disagree. */
export function layoutPanes(layout: PaneLayout, rect: PaneRect, gap = 3) {
  const panes: LaidOutPane[] = [],
    dividers: LaidOutDivider[] = [];
  const visit = (node: PaneLayout, r: PaneRect, path: string) => {
    if ("view" in node) {
      panes.push({ viewId: node.view, ...r });
      return;
    }
    const row = node.split === "row";
    const size = row ? r.width : r.height;
    const at = Math.round(size * node.ratio);
    const first = Math.max(0, at - gap),
      second = Math.max(0, size - at - gap);
    if (row) {
      dividers.push({ path, split: "row", ratio: node.ratio, parent: r, x: r.x + at - gap, y: r.y, width: gap * 2, height: r.height });
      visit(node.a, { ...r, width: first }, path + "a");
      visit(node.b, { ...r, x: r.x + at + gap, width: second }, path + "b");
    } else {
      dividers.push({ path, split: "column", ratio: node.ratio, parent: r, x: r.x, y: r.y + at - gap, width: r.width, height: gap * 2 });
      visit(node.a, { ...r, height: first }, path + "a");
      visit(node.b, { ...r, y: r.y + at + gap, height: second }, path + "b");
    }
  };
  visit(layout, rect, "");
  return { panes, dividers };
}

/** The pane next to `viewId` in `direction`, judged by where the panes are on screen. */
export function neighbourPane(layout: PaneLayout, viewId: string, direction: SplitEdge): string | undefined {
  const { panes } = layoutPanes(layout, { x: 0, y: 0, width: 1000, height: 1000 });
  const from = panes.find((p) => p.viewId === viewId);
  if (!from) return undefined;
  const horizontal = direction === "left" || direction === "right";
  const overlap = (p: LaidOutPane) =>
    horizontal
      ? Math.min(p.y + p.height, from.y + from.height) - Math.max(p.y, from.y)
      : Math.min(p.x + p.width, from.x + from.width) - Math.max(p.x, from.x);
  const distance = (p: LaidOutPane) =>
    direction === "left" ? from.x - (p.x + p.width)
    : direction === "right" ? p.x - (from.x + from.width)
    : direction === "top" ? from.y - (p.y + p.height)
    : p.y - (from.y + from.height);
  return panes
    .filter((p) => p.viewId !== viewId && distance(p) >= 0 && overlap(p) > 0)
    .sort((p, q) => distance(p) - distance(q) || overlap(q) - overlap(p))[0]?.viewId;
}

export function activeWorkspaceTab(state: WorkspaceTabsState) {
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId) ??
    state.tabs[0] ??
    null
  );
}

export function activateWorkspaceTab(
  state: WorkspaceTabsState,
  tabId: string,
  viewId?: string,
): WorkspaceTabsState {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target) return state;
  const activeViewId =
    viewId && target.viewIds.includes(viewId) ? viewId : target.activeViewId;
  return {
    tabs: state.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, activeViewId } : tab,
    ),
    activeTabId: tabId,
  };
}

/** Moves the whole of `targetTabId`'s arrangement beside the source tab's focused pane. */
export function splitWithTab(
  state: WorkspaceTabsState,
  sourceTabId: string,
  targetTabId: string,
  edge: SplitEdge = "right",
): WorkspaceTabsState {
  const source = state.tabs.find((tab) => tab.id === sourceTabId);
  const target = state.tabs.find((tab) => tab.id === targetTabId);
  if (
    !source ||
    !target ||
    source.id === target.id ||
    source.viewIds.length + target.viewIds.length > MAX_PANES
  ) {
    return state;
  }
  const split = tabWithLayout(
    { ...source, activeViewId: source.activeViewId },
    insertIntoLayout(source.layout, source.activeViewId, target.layout, edge),
  );
  return {
    tabs: state.tabs
      .filter((tab) => tab.id !== target.id)
      .map((tab) => (tab.id === source.id ? split : tab)),
    activeTabId: source.id,
  };
}

/** Every pane of a split tab becomes a tab of its own, in reading order. */
export function separateWorkspaceTab(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target || target.viewIds.length < 2) return state;
  const [first, ...rest] = target.viewIds;
  const firstTab = tabWithLayout({ id: target.id }, { view: first });
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = [...state.tabs];
  tabs.splice(index, 1, firstTab, ...rest.map(singleWorkspaceTab));
  return { tabs, activeTabId: firstTab.id };
}

/** Exchanges the two sides of the split holding the focused pane. */
export function swapWorkspaceSplit(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== tabId || tab.viewIds.length < 2) return tab;
      const path = parentPath(tab.layout, tab.activeViewId) ?? "";
      return tabWithLayout(tab, updateAt(tab.layout, path, (node) => ("split" in node ? { ...node, a: node.b, b: node.a } : node)));
    }),
  };
}

export function setWorkspaceSplitRatio(
  state: WorkspaceTabsState,
  tabId: string,
  ratio: number,
  path = "",
): WorkspaceTabsState {
  if (!Number.isFinite(ratio) || typeof path !== "string" || !/^[ab]*$/.test(path)) return state;
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      if ("view" in tab.layout && !path) return { ...tab, splitRatio: clamped };
      return tabWithLayout(tab, updateAt(tab.layout, path, (node) => ("split" in node ? { ...node, ratio: clamped } : node)));
    }),
  };
}

/** Every split in the tab back to half and half. */
export function resetWorkspaceSplits(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const even = (node: PaneLayout): PaneLayout => ("view" in node ? node : { ...node, ratio: 0.5, a: even(node.a), b: even(node.b) });
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === tabId ? tabWithLayout(tab, even(tab.layout)) : tab)) };
}

/** Puts `viewId` where `replacedViewId` is; the replaced view leaves the layout. */
export function replaceWorkspaceView(state: WorkspaceTabsState, replacedViewId: string, viewId: string): WorkspaceTabsState {
  const owner = state.tabs.find((tab) => tab.viewIds.includes(replacedViewId));
  if (!owner || state.tabs.some((tab) => tab.viewIds.includes(viewId))) return state;
  return {
    tabs: state.tabs.map((tab) =>
      tab.id === owner.id ? tabWithLayout({ ...tab, activeViewId: viewId }, mapViews(tab.layout, (id) => (id === replacedViewId ? viewId : id))) : tab,
    ),
    activeTabId: owner.id,
  };
}

export function closeWorkspaceView(
  state: WorkspaceTabsState,
  viewId: string,
): WorkspaceTabsState {
  const owner = state.tabs.find((tab) => tab.viewIds.includes(viewId));
  if (!owner) return state;
  const layout = removeFromLayout(owner.layout, viewId);
  if (layout) {
    // Focus stays near the closed pane: the first view of what took its place.
    const sibling = "split" in owner.layout ? parentPath(owner.layout, viewId) : undefined;
    const parent = sibling !== undefined ? layoutAt(owner.layout, sibling) : undefined;
    const survivor =
      parent && "split" in parent
        ? layoutViews("view" in parent.a && parent.a.view === viewId ? parent.b : parent.a)[0]
        : undefined;
    return {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === owner.id
          ? tabWithLayout({ id: tab.id, activeViewId: tab.activeViewId === viewId ? survivor : tab.activeViewId }, layout)
          : tab,
      ),
    };
  }
  const index = state.tabs.findIndex((tab) => tab.id === owner.id);
  const tabs = state.tabs.filter((tab) => tab.id !== owner.id);
  const activeTabId =
    state.activeTabId === owner.id
      ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
      : state.activeTabId;
  return { tabs, activeTabId };
}

/** Reorder groups as units; document identities and active pane are unchanged. */
export function reorderWorkspaceTab(
  state: WorkspaceTabsState,
  id: string,
  index: number,
): WorkspaceTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from < 0 || !Number.isFinite(index)) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(Math.min(tabs.length, Math.max(0, Math.trunc(index))), 0, moved);
  return { ...state, tabs };
}

export type WorkspaceViewDrop =
  /** Beside `targetViewId` (default: the target tab's focused pane) on `edge` (default: right). */
  | { kind: "split"; viewId: string; targetTabId: string; targetViewId?: string; edge?: SplitEdge }
  | { kind: "swap"; viewId: string; targetViewId: string }
  | { kind: "detach"; viewId: string; index: number };

const EDGES: SplitEdge[] = ["left", "right", "top", "bottom"];

/** Atomic ownership transfer: no view is closed or duplicated during a drag. */
export function applyWorkspaceViewDrop(state: WorkspaceTabsState, drop: WorkspaceViewDrop): WorkspaceTabsState {
  const source = state.tabs.find(tab => tab.viewIds.includes(drop.viewId));
  if (!source) return state;
  if (drop.kind === "swap") {
    const target = state.tabs.find(tab => tab.viewIds.includes(drop.targetViewId));
    if (!target || drop.viewId === drop.targetViewId) return state;
    // A singleton dropped on another singleton would only trade tab places.
    if (target.viewIds.length < 2 && source.viewIds.length < 2) return state;
    const exchange = (id: string) => id === drop.viewId ? drop.targetViewId : id === drop.targetViewId ? drop.viewId : id;
    return {
      tabs: state.tabs.map(tab => tab.id === source.id || tab.id === target.id ? {
        ...tabWithLayout(tab, mapViews(tab.layout, exchange)),
        activeViewId: tab.id === target.id ? drop.viewId : exchange(tab.activeViewId),
      } : tab),
      activeTabId: target.id,
    };
  }
  if (drop.kind === "detach") {
    if (source.viewIds.length < 2 || !Number.isFinite(drop.index)) return state;
    const tabs = state.tabs.map(tab => tab.id === source.id ? tabWithLayout(tab, removeFromLayout(tab.layout, drop.viewId)!) : tab);
    const detached = singleWorkspaceTab(drop.viewId);
    tabs.splice(Math.max(0, Math.min(tabs.length, Math.trunc(drop.index))), 0, detached);
    return {tabs, activeTabId: detached.id};
  }
  const target = state.tabs.find(tab => tab.id === drop.targetTabId);
  const edge = drop.edge ?? "right";
  if (!target || !EDGES.includes(edge)) return state;
  const targetViewId = drop.targetViewId ?? target.activeViewId;
  if (!target.viewIds.includes(targetViewId) || targetViewId === drop.viewId) return state;
  if (target.id === source.id ? false : target.viewIds.length >= MAX_PANES) return state;
  const tabs = state.tabs.flatMap(tab => {
    if (tab.id !== source.id) return [tab];
    const rest = removeFromLayout(tab.layout, drop.viewId);
    return rest ? [tabWithLayout(tab, rest)] : [];
  });
  return {
    tabs: tabs.map(tab => tab.id === target.id
      ? tabWithLayout({...tab, activeViewId: drop.viewId}, insertIntoLayout(tab.layout, targetViewId, {view: drop.viewId}, edge))
      : tab),
    activeTabId: target.id,
  };
}
