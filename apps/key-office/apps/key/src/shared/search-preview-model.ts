import {
  insertIntoLayout,
  removeFromLayout,
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

/** Open a search result beside its results, in the same tab (the search tab keeps its
 * place). A result shown there before is replaced, so stepping through results reuses
 * one pane; a view already open in that tab is simply focused.
 */
export function placeSearchResultBeside(
  state: WorkspaceTabsState,
  sourceViewId: string,
  resultViewId: string,
  replaceableViewId?: string,
): WorkspaceTabsState {
  const source = state.tabs.find((t) => t.viewIds.includes(sourceViewId));
  if (!source || sourceViewId === resultViewId) return state;
  if (source.viewIds.includes(resultViewId))
    return { tabs: state.tabs.map((t) => (t.id === source.id ? { ...t, activeViewId: resultViewId } : t)), activeTabId: source.id };
  const without =
    replaceableViewId && replaceableViewId !== sourceViewId && source.viewIds.includes(replaceableViewId)
      ? (removeFromLayout(source.layout, replaceableViewId) ?? { view: sourceViewId })
      : source.layout;
  const layout = insertIntoLayout(without, sourceViewId, { view: resultViewId }, "right");
  const tabs = state.tabs
    // The result leaves any other tab it was in.
    .map((t) => {
      if (t.id === source.id || !t.viewIds.includes(resultViewId)) return t;
      const rest = removeFromLayout(t.layout, resultViewId);
      return rest ? tabWithLayout(t, rest) : null;
    })
    .filter((t): t is WorkspaceTab => !!t)
    .map((t) => (t.id === source.id ? tabWithLayout({ ...t, activeViewId: resultViewId }, layout) : t));
  return { tabs, activeTabId: source.id };
}
