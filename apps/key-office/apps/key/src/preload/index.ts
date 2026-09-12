import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("key", {
  invoke: (
    command: string,
    args?: unknown,
    workspaceId?: string,
    options?: unknown,
  ) => ipcRenderer.invoke("key:invoke", command, args, workspaceId, options),
  setDirty: (dirty: boolean) => ipcRenderer.send("key:dirty", dirty),
  workspaces: () => ipcRenderer.invoke("key:workspaces"),
  addWorkspace: () => ipcRenderer.invoke("key:add-workspace"),
  tabs: () => ipcRenderer.invoke("key:tabs"),
  openSources: (id?: string) => ipcRenderer.invoke("key:open-sources", id),
  openSource: (source: unknown, hit?: unknown) =>
    ipcRenderer.invoke("key:open-source", source, hit),
  tabAction: (action: string, payload?: unknown) =>
    ipcRenderer.invoke("key:tab-action", action, payload),
  readerBack: () => ipcRenderer.invoke("key:reader-back"),
  readerReady: () => ipcRenderer.invoke("key:reader-ready"),
  readerState: (state: unknown) => ipcRenderer.send("key:reader-state", state),
  on: (event: string, callback: (value: unknown) => void) => {
    if (
      ![
        "tabs-changed",
        "library-changed",
        "search-target",
        "operation-error",
      ].includes(event)
    )
      throw Error("Unknown event");
    const listener = (_: unknown, value: unknown) => callback(value);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
