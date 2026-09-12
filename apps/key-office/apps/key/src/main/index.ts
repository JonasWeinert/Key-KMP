import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  Menu,
  shell as systemShell,
} from "electron";
import { join, resolve, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { setUiLang, normalizeLang } from "@key/i18n";
import { Registry } from "./workspaces";
import {
  configureOfficeEditors,
  createOfficeView,
  closeOfficeView,
  activateOfficeView,
  type OfficeKind,
} from "./office-editors";
import {
  singleWorkspaceTab,
  activeWorkspaceTab,
  activateWorkspaceTab,
  closeWorkspaceView,
  splitWithTab,
  separateWorkspaceTab,
  swapWorkspaceSplit,
  setWorkspaceSplitRatio,
  type WorkspaceTabsState,
} from "../shared/tab-model";

type OwnedView = {
  id: string;
  title: string;
  kind: "home" | "pdf" | OfficeKind;
  workspaceId?: string;
  path?: string;
  source?: any;
  searchTarget?: any;
  viewState?: any;
  view?: WebContentsView;
  lastUsed: number;
  recordId?: string;
  revision?: number;
};
let window: BrowserWindow;
let registry: Registry;
const views = new Map<string, OwnedView>();
const readerCalls = new Map<number, Set<Promise<unknown>>>();
const readerReleases = new Map<string, Promise<void>>();
function disposePdf(record: OwnedView) {
  const view = record.view;
  if (!view) return;
  const calls = [...(readerCalls.get(view.webContents.id) ?? [])];
  readerCalls.delete(view.webContents.id);
  window.contentView.removeChildView(view);
  view.webContents.close();
  record.view = undefined;
  const previous = readerReleases.get(record.id);
  const release = (async () => {
    await previous;
    await Promise.allSettled(calls);
    await Promise.allSettled([
      registry.invoke(
        "release_disposable_document",
        { id: record.source.hash },
        record.workspaceId,
      ),
      registry.invoke(
        "native_close",
        { id: record.source.hash },
        record.workspaceId,
      ),
    ]);
  })();
  readerReleases.set(record.id, release);
  void release.finally(() => {
    if (readerReleases.get(record.id) === release)
      readerReleases.delete(record.id);
  });
}
let state: WorkspaceTabsState = { tabs: [], activeTabId: null };
let quitting = false;
let shellDirty = false;
const preload = join(__dirname, "../preload/index.js");
const renderer = join(__dirname, "../renderer");
function snapshot() {
  return {
    splitRatio: activeWorkspaceTab(state)?.splitRatio ?? 0.5,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      title: t.viewIds.map((id) => views.get(id)?.title ?? "Key").join(" / "),
      views: t.viewIds.map((id) => ({
        id,
        title: views.get(id)?.title,
        kind: views.get(id)?.kind,
      })),
    })),
    activeTabId: state.activeTabId,
    activeViewId: activeWorkspaceTab(state)?.activeViewId,
  };
}
function emit(event: string, value?: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send(event, value);
}
function home() {
  const record: OwnedView = {
    id: randomUUID(),
    title: "Home",
    kind: "home",
    lastUsed: Date.now(),
  };
  views.set(record.id, record);
  const tab = singleWorkspaceTab(record.id);
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  layout();
}
function attach(record: OwnedView) {
  if (record.view || record.kind === "home") return;
  if (record.kind === "pdf") {
    const view = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    record.view = view;
    const load = async () => {
      await readerReleases.get(record.id);
      if (record.view !== view || view.webContents.isDestroyed()) return;
      if (process.env.ELECTRON_RENDERER_URL)
        await view.webContents.loadURL(
          `${process.env.ELECTRON_RENDERER_URL}/pdf.html`,
        );
      else await view.webContents.loadFile(join(renderer, "pdf.html"));
    };
    void load().catch((error) => emit("operation-error", String(error)));
  } else
    record.view = createOfficeView(record.kind, record.path, {
      newBlank: !record.path,
    });
  window.contentView.addChildView(record.view);
  record.view.webContents.on("focus", () => {
    const owner = state.tabs.find((t) => t.viewIds.includes(record.id));
    if (owner) {
      state = activateWorkspaceTab(state, owner.id, record.id);
      activateOfficeView(
        record.kind === "pdf" ? null : (record.kind as OfficeKind),
        record.kind === "pdf" ? null : record.view!,
      );
      emit("tabs-changed", snapshot());
    }
  });
  record.view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url))
      void systemShell.openExternal(url);
    return { action: "deny" };
  });
}
function layout() {
  if (!window || window.isDestroyed()) return;
  const tab = activeWorkspaceTab(state);
  const visible = new Set(tab?.viewIds ?? []);
  const [width, height] = window.getContentSize();
  for (const record of views.values()) {
    if (visible.has(record.id)) {
      record.lastUsed = Date.now();
      attach(record);
    }
    if (record.view) record.view.setVisible(visible.has(record.id));
  }
  const ids = tab?.viewIds ?? [];
  const left = 224,
    top = 96,
    available = Math.max(0, width - left);
  const first = Math.round(available * (tab?.splitRatio ?? 0.5));
  ids.forEach((id, index) =>
    views.get(id)?.view?.setBounds({
      x: left + (index ? first + 3 : 0),
      y: top,
      width:
        ids.length === 1
          ? available
          : Math.max(0, index ? available - first - 3 : first - 3),
      height: Math.max(0, height - top),
    }),
  );
  // Only the two most recently used PDF renderers retain their raster/GPU caches.
  const pdfs = [...views.values()].filter((v) => v.kind === "pdf" && v.view);
  const keep = Math.max(0, 2 - pdfs.filter((v) => visible.has(v.id)).length);
  const inactive = pdfs
    .filter((v) => !visible.has(v.id))
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const record of inactive.slice(keep)) {
    if (!visible.has(record.id) && record.view) {
      disposePdf(record);
    }
  }
  const active = views.get(tab?.activeViewId ?? "");
  activateOfficeView(
    active && active.kind !== "home" && active.kind !== "pdf"
      ? active.kind
      : null,
    active?.kind !== "pdf" ? (active?.view ?? null) : null,
  );
  emit("tabs-changed", snapshot());
}
function focus(id: string) {
  const owner = state.tabs.find((t) => t.viewIds.includes(id));
  if (owner) {
    state = activateWorkspaceTab(state, owner.id, id);
    layout();
  }
}
function add(record: OwnedView) {
  views.set(record.id, record);
  const tab = singleWorkspaceTab(record.id);
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  layout();
  return record.view;
}
async function closeTab(id: string) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  for (const viewId of [...tab.viewIds]) {
    const record = views.get(viewId)!;
    if (
      record.view &&
      record.kind !== "pdf" &&
      record.kind !== "home" &&
      !(await closeOfficeView({ kind: record.kind, view: record.view }))
    )
      return;
    if (record.kind === "pdf") disposePdf(record);
    else if (record.view) {
      window.contentView.removeChildView(record.view);
      if (!record.view.webContents.isDestroyed())
        record.view.webContents.close();
    }
    views.delete(viewId);
    state = closeWorkspaceView(state, viewId);
  }
  if (!state.tabs.length) home();
  else layout();
}
function office(kind: OfficeKind, path?: string, workspaceId?: string) {
  const existing = [...views.values()].find((v) => path && v.path === path);
  if (existing) {
    focus(existing.id);
    return existing.view;
  }
  return add({
    id: randomUUID(),
    kind,
    path,
    workspaceId,
    title: path ? basename(path) : `Untitled ${kind}`,
    lastUsed: Date.now(),
  });
}
function openPath(path: string, workspaceId?: string) {
  const kind = (
    {
      ".docx": "docs",
      ".xlsx": "sheets",
      ".pptx": "slides",
      ".md": "markdown",
      ".html": "html",
    } as Record<string, OfficeKind>
  )[extname(path).toLowerCase()];
  if (!kind) return false;
  office(kind, path, workspaceId);
  return true;
}
async function sourceOpen(source: any, hit?: any) {
  const workspaceId =
    source.workspaceId ?? hit?.workspaceId ?? (await registry.list())[0]?.id;
  if (!workspaceId) throw Error("Choose a workspace");
  const hash = source.documentHash ?? source.hash;
  const id = `pdf:${workspaceId}:${hash}`;
  const info = await registry.invoke(
    "library_source_info",
    { hash },
    workspaceId,
  );
  let target = hit
    ? await registry.invoke(
        "resolve_search_target",
        { id: hit.id },
        workspaceId,
      )
    : undefined;
  const existing = views.get(id);
  if (existing) {
    existing.searchTarget = target;
    focus(id);
    if (target) existing.view?.webContents.send("search-target", target);
    return;
  }
  add({
    id,
    title: source.title ?? source.documentTitle ?? (info as any).title,
    kind: "pdf",
    workspaceId,
    source: info,
    searchTarget: target,
    lastUsed: Date.now(),
  });
}
async function saveOfficeRecord(v: OwnedView) {
  try {
    v.workspaceId ??= (await registry.list())[0]?.id;
    if (!v.workspaceId || !v.path) return;
    const record: any = await registry.invoke(
      "workspace_register_file",
      { path: v.path, editor: v.kind, title: v.title },
      v.workspaceId,
    );
    v.recordId = record.id;
    v.revision = record.revision;
    emit("library-changed");
  } catch (e) {
    emit("operation-error", String(e));
  }
}
async function importSources(workspaceId?: string) {
  workspaceId ??= (await registry.list())[0]?.id;
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents",
        extensions: ["pdf", "docx", "xlsx", "pptx", "md", "html"],
      },
    ],
  });
  for (const path of result.filePaths) {
    if (openPath(path, workspaceId)) continue;
    const info: any = await registry.invoke(
      "library_import_file",
      { path },
      workspaceId,
    );
    emit("library-changed");
    void registry
      .invoke(
        "library_processing_control",
        { hash: info.hash, action: "resume" },
        workspaceId,
      )
      .then(() => emit("library-changed"))
      .catch((e) => emit("operation-error", String(e)));
  }
  emit("library-changed");
}
function baseMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Key", submenu: [{ role: "about" }, { role: "quit" }] },
      {
        label: "File",
        submenu: [
          { label: "New Tab", accelerator: "CmdOrCtrl+T", click: home },
          {
            label: "Open…",
            accelerator: "CmdOrCtrl+O",
            click: () => void importSources(),
          },
          {
            label: "Close Tab",
            accelerator: "CmdOrCtrl+W",
            click: () => void closeTab(state.activeTabId!),
          },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}
app.setName("Key");
if (process.env.KEY_USER_DATA)
  app.setPath("userData", process.env.KEY_USER_DATA);
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) { if(window.isMinimized())window.restore(); window.show(); window.focus(); }
});
if (!app.requestSingleInstanceLock()) app.quit();
else app
  .whenReady()
  .then(async () => {
    setUiLang(normalizeLang(app.getLocale()));
    const root = resolve(app.getAppPath(), "../../../..");
    registry = new Registry({
      registryDir: join(app.getPath("userData"), "workspaces"),
      defaultWorkspaceParent:
        process.env.KEY_WORKSPACE_PARENT ??
        join(app.getPath("documents"), "Key"),
      hostExecutable:
        process.env.KEY_HOST_EXECUTABLE ??
        (app.isPackaged
          ? join(process.resourcesPath, "backend/key-desktop-host")
          : join(root, "apps/key/src-tauri/target/debug/key-desktop-host")),
      pdfiumPath:
        process.env.PDFIUM_DYNAMIC_LIB_PATH ??
        (app.isPackaged
          ? join(process.resourcesPath, "backend/libpdfium.dylib")
          : join(root, "vendor/pdfium/lib/libpdfium.dylib")),
    });
    await registry.list();
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 850,
      minHeight: 600,
      title: "Key",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 13, y: 12 },
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    configureOfficeEditors(window, {
      extractPdfText: async (bytes) => {
        if (bytes.byteLength > 32 * 1024 * 1024)
          throw Error("PDF attachment exceeds 32 MiB");
        const workspaceId = (await registry.list())[0].id;
        const id = randomUUID();
        let text = "";
        try {
          const doc: any = await registry.invoke(
            "native_open_buffer",
            { id },
            workspaceId,
            { binary: bytes },
          );
          for (let page = 0; page < doc.pages.length; page++) {
            const value: any = await registry.invoke(
              "native_text",
              { id, page },
              workspaceId,
            );
            text += value.text + "\n";
            if (text.length > 2 * 1024 * 1024)
              throw Error("PDF attachment text exceeds 2 MiB");
          }
          return text;
        } finally {
          await registry.invoke("native_close", { id }, workspaceId);
        }
      },
      open: (kind, path) => office(kind, path),
      openPath,
      closeActive: () => void closeTab(state.activeTabId!),
      listTabs: () =>
        [...views.values()].map((v) => ({
          id: v.id,
          title: v.title,
          kind: v.kind,
          active: v.id === activeWorkspaceTab(state)?.activeViewId,
        })),
      focus,
      fileChanged: (wc, path) => {
        const v = [...views.values()].find(
          (v) => v.view?.webContents.id === wc,
        );
        if (v) {
          v.path = path;
          v.title = basename(path);
          void saveOfficeRecord(v);
          emit("tabs-changed", snapshot());
        }
      },
      titleChanged: (wc, title) => {
        const v = [...views.values()].find(
          (v) => v.view?.webContents.id === wc,
        );
        if (v) {
          v.title = title;
          emit("tabs-changed", snapshot());
        }
      },
      installBaseMenu: baseMenu,
    });
    const bound = (sender: number) =>
      [...views.values()].find((v) => v.view?.webContents.id === sender);
    const shell = (sender: number) => {
      if (sender !== window.webContents.id)
        throw Error("Only the workspace shell can perform this operation");
    };
    ipcMain.handle(
      "key:invoke",
      (event, command, args, workspaceId, options) => {
        const record = bound(event.sender.id);
        if (!record && event.sender.id !== window.webContents.id)
          throw Error("Unknown view");
        const operation = registry.invoke(
          command,
          args,
          record?.workspaceId ?? workspaceId,
          options,
        );
        if (record?.kind === "pdf") {
          const id = event.sender.id;
          const calls = readerCalls.get(id) ?? new Set<Promise<unknown>>();
          calls.add(operation);
          readerCalls.set(id, calls);
          void operation.finally(() => calls.delete(operation)).catch(() => {});
        }
        return operation;
      },
    );
    ipcMain.handle("key:workspaces", (event) => {
      shell(event.sender.id);
      return registry.list();
    });
    ipcMain.handle("key:add-workspace", async (event) => {
      shell(event.sender.id);
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled
        ? null
        : registry.add(result.filePaths[0], basename(result.filePaths[0]));
    });
    ipcMain.handle("key:tabs", () => snapshot());
    ipcMain.on("key:dirty", (event, dirty) => {
      shell(event.sender.id);
      shellDirty = Boolean(dirty);
    });
    ipcMain.handle("key:reader-back", (event) => {
      const v = bound(event.sender.id);
      if (v?.kind !== "pdf") throw Error("Not a PDF reader");
      const tab = state.tabs.find((t) =>
        t.viewIds.some((id) => views.get(id)?.kind === "home"),
      );
      if (tab) {
        state = activateWorkspaceTab(state, tab.id);
        layout();
      } else home();
    });
    ipcMain.handle("key:open-sources", (event, id) => {
      shell(event.sender.id);
      return importSources(id);
    });
    ipcMain.handle("key:open-source", (event, source, hit) => {
      shell(event.sender.id);
      return sourceOpen(source, hit);
    });
    ipcMain.handle("key:reader-ready", (event) => {
      const v = bound(event.sender.id);
      if (v?.kind !== "pdf") throw Error("Not a PDF reader");
      return {
        source: v.source,
        viewState: v.viewState,
        searchTarget: v.searchTarget,
      };
    });
    ipcMain.on("key:reader-state", (event, value) => {
      const v = bound(event.sender.id);
      if (v?.kind === "pdf") v.viewState = value;
    });
    ipcMain.handle("key:tab-action", async (event, action, p = {}) => {
      shell(event.sender.id);
      switch (action) {
        case "new":
          home();
          break;
        case "activate":
          state = activateWorkspaceTab(state, p.tabId);
          break;
        case "focus":
          focus(p.viewId);
          break;
        case "close":
          await closeTab(p.tabId);
          break;
        case "split": {
          const target = state.tabs.find(
            (t) =>
              t.id !== state.activeTabId &&
              t.viewIds.length === 1 &&
              views.get(t.activeViewId)?.kind !== "home" &&
              (p.viewId === activeWorkspaceTab(state)?.activeViewId ||
                t.viewIds.includes(p.viewId)),
          );
          if (
            target &&
            target.id !== state.activeTabId &&
            target.viewIds.length === 1 &&
            views.get(p.viewId)?.kind !== "home" &&
            views.get(activeWorkspaceTab(state)?.activeViewId ?? "")?.kind !==
              "home"
          )
            state = splitWithTab(state, state.activeTabId!, target.id);
          break;
        }
        case "separate":
          state = separateWorkspaceTab(state, state.activeTabId!);
          break;
        case "swap":
          state = swapWorkspaceSplit(state, state.activeTabId!);
          break;
        case "resize-split":
          state = setWorkspaceSplitRatio(
            state,
            state.activeTabId!,
            Number(p.ratio),
          );
          break;
        case "create-office":
          if (
            ["docs", "sheets", "slides", "markdown", "html"].includes(p.kind)
          ) {
            if (!p.workspaceId) throw Error("Choose a workspace");
            office(p.kind, undefined, p.workspaceId);
          }
          break;
        case "open-office-record": {
          const item: any = await registry.invoke(
            "workspace_record",
            { id: p.recordId },
            p.workspaceId,
          );
          if (
            !item?.properties?.path ||
            !openPath(item.properties.path, p.workspaceId)
          )
            throw Error("No supported file linked to this record");
          break;
        }
        case "link-folder": {
          const result = await dialog.showOpenDialog(window, {
            properties: ["openDirectory"],
          });
          if (!result.canceled) {
            const linked: any = await registry.invoke(
              "workspace_link_folder",
              { projectId: p.projectId, path: result.filePaths[0] },
              p.workspaceId,
            );
            await registry.invoke(
              "workspace_scan_linked_folder",
              { id: linked.id, maxEntries: 10000 },
              p.workspaceId,
            );
            emit("library-changed");
          }
          break;
        }
      }
      layout();
      return snapshot();
    });
    if (process.env.ELECTRON_RENDERER_URL)
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(renderer, "index.html"));
    home();
    window.on("resize", layout);
    window.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      void (async () => {
        if (shellDirty) {
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            message: "Discard unsaved page changes?",
            detail: "Return to the page and save to keep your changes.",
            buttons: ["Cancel", "Discard"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response !== 1) return;
        }
        for (const tab of [...state.tabs]) {
          await closeTab(tab.id);
          if (state.tabs.some((t) => t.id === tab.id)) return;
        }
        quitting = true;
        await registry.close();
        app.quit();
      })();
    });
  })
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox("Key could not start", String(error));
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
