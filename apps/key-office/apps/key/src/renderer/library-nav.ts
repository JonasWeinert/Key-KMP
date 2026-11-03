// Shared selection between the sidebar's collection tree and the Sources view, which
// render in the same document. Each workspace remembers its own selection.
import type { SearchFilter } from "./search-suggest";

export interface LibrarySelection {
  workspaceId: string;
  collectionId?: string;
  scope?: string;
  /** Search filters to show, e.g. from clicking a tag on a source page. */
  filters?: SearchFilter[];
}
type Listener = (selection: LibrarySelection) => void;
const listeners = new Set<Listener>();
const selections = new Map<string, LibrarySelection>();

export function selectLibrary(selection: LibrarySelection) {
  selections.set(selection.workspaceId, selection);
  listeners.forEach((listener) => listener(selection));
}
export function currentSelection(workspaceId?: string): LibrarySelection | undefined {
  return workspaceId ? selections.get(workspaceId) : undefined;
}
export function onLibrarySelection(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The sidebar and list exchange dragged source ids with this MIME type.
export const SOURCE_DRAG_TYPE = "application/x-key-sources";

const changeListeners = new Set<() => void>();
/** Collections or memberships changed; the sidebar and list refresh their counts. */
export function libraryChanged() {
  changeListeners.forEach((listener) => listener());
}
export function onLibraryChanged(listener: () => void) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
