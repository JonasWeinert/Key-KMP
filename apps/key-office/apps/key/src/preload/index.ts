import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("key", {
  invoke: (
    command: string,
    args?: unknown,
    workspaceId?: string,
    options?: unknown,
  ) => ipcRenderer.invoke("key:invoke", command, args, workspaceId, options),
  workspaces: () => ipcRenderer.invoke("key:workspaces"),
  addWorkspace: () => ipcRenderer.invoke("key:add-workspace"),
  appSettings: () => ipcRenderer.invoke("key:app-settings"),
  setAppSettings: (patch: unknown) => ipcRenderer.invoke("key:set-app-settings", patch),
  tabs: () => ipcRenderer.invoke("key:tabs"),
  openSources: (id?: string) => ipcRenderer.invoke("key:open-sources", id),
  importZotero: (options?: unknown) => ipcRenderer.invoke("key:import-zotero", options),
  addFiles: (workspaceId: string, collectionId?: string) =>
    ipcRenderer.invoke("key:add-files", workspaceId, collectionId),
  importPaths: (workspaceId: string, paths: string[], collectionId?: string) =>
    ipcRenderer.invoke("key:import-paths", workspaceId, paths, collectionId),
  openPath: (path: string) => ipcRenderer.invoke("key:open-path", path),
  revealPath: (path: string) => ipcRenderer.invoke("key:reveal-path", path),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openSource: (source: unknown, hit?: unknown, results?: unknown[]) =>
    ipcRenderer.invoke("key:open-source", source, hit, results),
  tabAction: (action: string, payload?: unknown) =>
    ipcRenderer.invoke("key:tab-action", action, payload),
  readerBack: () => ipcRenderer.invoke("key:reader-back"),
  readerDismiss: () => ipcRenderer.invoke("key:reader-dismiss"),
  readerNotes: () => ipcRenderer.invoke("key:reader-notes"),
  readerAddToNote: (passage: unknown) => ipcRenderer.invoke("key:reader-add-to-note", passage),
  readerResult: (direction: number) =>
    ipcRenderer.invoke("key:reader-result", direction),
  readerReady: () => ipcRenderer.invoke("key:reader-ready"),
  readerState: (state: unknown) => ipcRenderer.send("key:reader-state", state),
  on: (event: string, callback: (value: unknown) => void) => {
    if (
      ![
        "tabs-changed",
        "global-overlay-frames",
        "save-content",
        "property-definitions-changed",
        "library-changed",
        "open-settings",
        "note-changed",
        "note-append",
        "annotations-changed",
        "search-target",
        "search-navigation",
        "operation-error",
      ].includes(event)
    )
      throw Error("Unknown event");
    const listener = (_: unknown, value: unknown) => callback(value);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
