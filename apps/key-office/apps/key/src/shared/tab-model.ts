export interface WorkspaceTab {
  id: string;
  viewIds: [string] | [string, string];
  activeViewId: string;
  splitRatio: number;
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}

export const LIBRARY_VIEW_ID = "key:library";

export function singleWorkspaceTab(viewId: string): WorkspaceTab {
  return {
    id: crypto.randomUUID(),
    viewIds: [viewId],
    activeViewId: viewId,
    splitRatio: 0.5,
  };
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

export function splitWithTab(
  state: WorkspaceTabsState,
  sourceTabId: string,
  targetTabId: string,
): WorkspaceTabsState {
  const source = state.tabs.find((tab) => tab.id === sourceTabId);
  const target = state.tabs.find((tab) => tab.id === targetTabId);
  if (
    !source ||
    !target ||
    source.id === target.id ||
    source.viewIds.length !== 1 ||
    target.viewIds.length !== 1
  ) {
    return state;
  }
  const targetViewId = target.activeViewId;
  const split: WorkspaceTab = {
    ...source,
    viewIds: [source.activeViewId, targetViewId],
    activeViewId: source.activeViewId,
    splitRatio: 0.5,
  };
  return {
    tabs: state.tabs
      .filter((tab) => tab.id !== target.id)
      .map((tab) => (tab.id === source.id ? split : tab)),
    activeTabId: source.id,
  };
}

export function separateWorkspaceTab(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target || target.viewIds.length !== 2) return state;
  const [first, second] = target.viewIds;
  const firstTab: WorkspaceTab = {
    ...target,
    viewIds: [first],
    activeViewId: first,
    splitRatio: 0.5,
  };
  const secondTab = singleWorkspaceTab(second);
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = [...state.tabs];
  tabs.splice(index, 1, firstTab, secondTab);
  return { tabs, activeTabId: firstTab.id };
}

export function swapWorkspaceSplit(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId && tab.viewIds.length === 2
        ? { ...tab, viewIds: [tab.viewIds[1], tab.viewIds[0]] }
        : tab,
    ),
  };
}

export function setWorkspaceSplitRatio(
  state: WorkspaceTabsState,
  tabId: string,
  ratio: number,
): WorkspaceTabsState {
  if (!Number.isFinite(ratio)) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId
        ? { ...tab, splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }
        : tab,
    ),
  };
}

export function closeWorkspaceView(
  state: WorkspaceTabsState,
  viewId: string,
): WorkspaceTabsState {
  const owner = state.tabs.find((tab) => tab.viewIds.includes(viewId));
  if (!owner) return state;
  if (owner.viewIds.length === 2) {
    const survivor = owner.viewIds.find((id) => id !== viewId)!;
    return {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === owner.id
          ? {
              ...tab,
              viewIds: [survivor],
              activeViewId: survivor,
              splitRatio: 0.5,
            }
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
  | { kind: "split"; viewId: string; targetTabId: string }
  | { kind: "swap"; viewId: string; targetViewId: string }
  | { kind: "detach"; viewId: string; index: number };

/** Atomic ownership transfer: no view is closed or duplicated during a drag. */
export function applyWorkspaceViewDrop(state: WorkspaceTabsState, drop: WorkspaceViewDrop): WorkspaceTabsState {
  const source = state.tabs.find(tab => tab.viewIds.includes(drop.viewId));
  if (!source) return state;
  if (drop.kind === "swap") {
    const target = state.tabs.find(tab => tab.viewIds.includes(drop.targetViewId));
    if (!target || target.viewIds.length !== 2 || drop.viewId === drop.targetViewId) return state;
    const exchange = (id: string) => id === drop.viewId ? drop.targetViewId : id === drop.targetViewId ? drop.viewId : id;
    return {
      tabs: state.tabs.map(tab => tab.id === source.id || tab.id === target.id ? {
        ...tab,
        viewIds: tab.viewIds.map(exchange) as WorkspaceTab["viewIds"],
        activeViewId: tab.id === target.id ? drop.viewId : exchange(tab.activeViewId),
      } : tab),
      activeTabId: target.id,
    };
  }
  if (drop.kind === "detach" && (source.viewIds.length !== 2 || !Number.isFinite(drop.index))) return state;
  const target = drop.kind === "split" ? state.tabs.find(tab => tab.id === drop.targetTabId) : undefined;
  if (drop.kind === "split" && (!target || target.id === source.id || target.viewIds.length !== 1)) return state;
  const survivor = source.viewIds.find(id => id !== drop.viewId);
  const tabs = state.tabs.flatMap(tab => tab.id !== source.id ? [tab] : survivor ? [{...tab, viewIds: [survivor] as [string], activeViewId: survivor, splitRatio: 0.5}] : []);
  if (drop.kind === "detach") {
    const detached = singleWorkspaceTab(drop.viewId);
    tabs.splice(Math.max(0, Math.min(tabs.length, Math.trunc(drop.index))), 0, detached);
    return {tabs, activeTabId: detached.id};
  }
  return {
    tabs: tabs.map(tab => tab.id === target!.id ? {...tab, viewIds: [tab.viewIds[0], drop.viewId], activeViewId: drop.viewId, splitRatio: 0.5} : tab),
    activeTabId: target!.id,
  };
}
