import {
  singleWorkspaceTab,
  type WorkspaceTabsState,
  type WorkspaceTab,
} from "./tab-model";

/** Install a preview beside its result list without ever duplicating a view owner.
 * An ordinary displaced view is retained as a tab; only a caller-approved transient
 * preview is removed. Existing preview owners are detached, preserving their peers.
 */
export function placeSearchPreview(
  state: WorkspaceTabsState,
  sourceViewId: string,
  previewViewId: string,
  replaceableViewId?: string,
): WorkspaceTabsState {
  const source = state.tabs.find((t) => t.viewIds.includes(sourceViewId));
  if (!source || sourceViewId === previewViewId) return state;
  if (source.viewIds.includes(previewViewId))
    return { ...state, activeTabId: source.id };
  const displaced = source.viewIds.find((id) => id !== sourceViewId);
  let tabs: WorkspaceTab[] = [];
  for (const tab of state.tabs) {
    if (tab.id === source.id) {
      const ids =
        tab.viewIds.length === 1
          ? [sourceViewId, previewViewId]
          : tab.viewIds.map((id) => (id === sourceViewId ? id : previewViewId));
      tabs.push({
        ...tab,
        viewIds: ids as [string, string],
        activeViewId: sourceViewId,
      });
      if (displaced && displaced !== replaceableViewId)
        tabs.push(singleWorkspaceTab(displaced));
    } else if (tab.viewIds.includes(previewViewId)) {
      const survivor = tab.viewIds.find((id) => id !== previewViewId);
      if (survivor)
        tabs.push({ ...tab, viewIds: [survivor], activeViewId: survivor });
    } else tabs.push(tab);
  }
  return { tabs, activeTabId: source.id };
}
