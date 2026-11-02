import {
  singleWorkspaceTab,
  tabWithLayout,
  type WorkspaceTabsState,
  type WorkspaceTab,
} from "./tab-model";

/** Open a search result in its own tab, right after the results it came from.
 * Stepping to a result in another document reuses the result's tab (when the
 * caller marks the old view replaceable) instead of piling up tabs; a view that is
 * already open anywhere is simply brought forward.
 */
export function placeSearchResultTab(
  state: WorkspaceTabsState,
  sourceViewId: string,
  resultViewId: string,
  replaceableViewId?: string,
): WorkspaceTabsState {
  const source = state.tabs.find((t) => t.viewIds.includes(sourceViewId));
  if (!source || sourceViewId === resultViewId) return state;
  const open = state.tabs.find((t) => t.viewIds.includes(resultViewId));
  if (open)
    return {
      tabs: state.tabs.map((t) =>
        t.id === open.id ? { ...t, activeViewId: resultViewId } : t,
      ),
      activeTabId: open.id,
    };
  const reusable =
    replaceableViewId &&
    state.tabs.find(
      (t) => t.viewIds.length === 1 && t.viewIds[0] === replaceableViewId,
    );
  if (reusable) {
    const tabs = state.tabs.map((t): WorkspaceTab =>
      t.id === reusable.id
        ? tabWithLayout({ id: t.id, activeViewId: resultViewId }, { view: resultViewId })
        : t,
    );
    return { tabs, activeTabId: reusable.id };
  }
  const tab = singleWorkspaceTab(resultViewId);
  const at = state.tabs.findIndex((t) => t.id === source.id) + 1;
  return {
    tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)],
    activeTabId: tab.id,
  };
}
