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
  zoteroWorkspace: () => ipcRenderer.invoke("key:zotero-workspace"),
  syncZotero: () => ipcRenderer.invoke("key:sync-zotero"),
  addFiles: (workspaceId: string, collectionId?: string) =>
    ipcRenderer.invoke("key:add-files", workspaceId, collectionId),
  importPaths: (workspaceId: string, paths: string[], collectionId?: string) =>
    ipcRenderer.invoke("key:import-paths", workspaceId, paths, collectionId),
  openPath: (path: string) => ipcRenderer.invoke("key:open-path", path),
  revealPath: (path: string) => ipcRenderer.invoke("key:reveal-path", path),
  thumbnail: (path: string, size?: number) => ipcRenderer.invoke("key:thumbnail", path, size),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openSource: (source: unknown, hit?: unknown, results?: unknown[]) =>
    ipcRenderer.invoke("key:open-source", source, hit, results),
  tabAction: (action: string, payload?: unknown) =>
    ipcRenderer.invoke("key:tab-action", action, payload),
  readerBack: () => ipcRenderer.invoke("key:reader-back"),
  readerDismiss: () => ipcRenderer.invoke("key:reader-dismiss"),
  readerNotes: () => ipcRenderer.invoke("key:reader-notes"),
  readerAddToNote: (passage: unknown) => ipcRenderer.invoke("key:reader-add-to-note", passage),
  readerAnalysis: () => ipcRenderer.invoke("key:reader-analysis"),
  readerReanalyze: () => ipcRenderer.invoke("key:reader-reanalyze"),
  readerOpenSource: (sourceId: string) => ipcRenderer.invoke("key:reader-open-source", sourceId),
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
        "links-changed",
        "note-append",
        "annotations-changed",
        "search-target",
        "reader-focus",
        "search-navigation",
        "operation-error",
        "focus-pane",
        "open-workspace-switcher",
      ].includes(event)
    )
      throw Error("Unknown event");
    const listener = (_: unknown, value: unknown) => callback(value);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
