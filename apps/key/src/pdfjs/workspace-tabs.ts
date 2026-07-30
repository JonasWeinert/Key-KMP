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

export function singleWorkspaceTab(viewId: string): WorkspaceTab {
  return {
    id: crypto.randomUUID(),
    viewIds: [viewId],
    activeViewId: viewId,
    splitRatio: 0.5,
  };
}

export function activeWorkspaceTab(state: WorkspaceTabsState) {
  return state.tabs.find(tab => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
}

export function activateWorkspaceTab(
  state: WorkspaceTabsState,
  tabId: string,
  viewId?: string,
): WorkspaceTabsState {
  const target = state.tabs.find(tab => tab.id === tabId);
  if (!target) return state;
  const activeViewId =
    viewId && target.viewIds.includes(viewId) ? viewId : target.activeViewId;
  return {
    tabs: state.tabs.map(tab =>
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
  const source = state.tabs.find(tab => tab.id === sourceTabId);
  const target = state.tabs.find(tab => tab.id === targetTabId);
  if (!source || !target || source.id === target.id || source.viewIds.length !== 1) {
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
      .filter(tab => tab.id !== target.id)
      .map(tab => (tab.id === source.id ? split : tab)),
    activeTabId: source.id,
  };
}

export function separateWorkspaceTab(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  const target = state.tabs.find(tab => tab.id === tabId);
  if (!target || target.viewIds.length !== 2) return state;
  const [first, second] = target.viewIds;
  const firstTab: WorkspaceTab = {
    ...target,
    viewIds: [first],
    activeViewId: first,
    splitRatio: 0.5,
  };
  const secondTab = singleWorkspaceTab(second);
  const index = state.tabs.findIndex(tab => tab.id === tabId);
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
    tabs: state.tabs.map(tab =>
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
  return {
    ...state,
    tabs: state.tabs.map(tab =>
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
  const owner = state.tabs.find(tab => tab.viewIds.includes(viewId));
  if (!owner) return state;
  if (owner.viewIds.length === 2) {
    const survivor = owner.viewIds.find(id => id !== viewId)!;
    return {
      ...state,
      tabs: state.tabs.map(tab =>
        tab.id === owner.id
          ? { ...tab, viewIds: [survivor], activeViewId: survivor, splitRatio: 0.5 }
          : tab,
      ),
    };
  }
  const index = state.tabs.findIndex(tab => tab.id === owner.id);
  const tabs = state.tabs.filter(tab => tab.id !== owner.id);
  const activeTabId =
    state.activeTabId === owner.id
      ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null
      : state.activeTabId;
  return { tabs, activeTabId };
}
