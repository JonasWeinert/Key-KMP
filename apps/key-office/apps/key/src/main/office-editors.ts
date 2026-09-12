/** GenOffice's editors hosted by Key's single-owner tab/split manager. */
import { app, type BrowserWindow, type WebContentsView } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { configurePdfTextExtractor } from "@key/file-parse";
import {
  configureDocsRuntime,
  createDocsView,
  markDocsNewBlank,
  queueDocsAiContent,
  registerDocsIpc,
  registerAiIpc,
  registerProjectIpc,
  requestDocsClose,
  setDocsShellWindow,
  setActiveDocsResolver,
  setDocsMenuGate,
  setDocsShellHooks,
  setDocsFileSavedHook,
  setDocsFileOpenedHook,
  teardownDocsRenderer,
  buildDocsMenu,
  createAiDocument,
} from "../../../docs/src/main/docs-main";
import {
  configureSheetsRuntime,
  createSheetsView,
  queueWorkbookForView,
  setSheetsNewBlank,
  requestSheetsClose,
  setSheetsShellWindow,
  setActiveSheetsWebContents,
  setSheetsWorkbookOpenedHook,
  setSheetsCloseTabHook,
  installSheetsMenu,
} from "../../../sheets/src/main/sheets-main";
import {
  configureSlidesRuntime,
  createSlidesView,
  requestSlidesClose,
  setSlidesShellWindow,
  setActiveSlidesWebContents,
  setSlidesOpenedHook,
  setSlidesCloseTabHook,
  setSlidesShowBleed,
  installSlidesMenu,
} from "../../../slides/src/main/slides-main";
import {
  configureMarkdownRuntime,
  createMarkdownView,
  requestMarkdownClose,
  requestMarkdownSave,
  setMarkdownFileSavedHook,
  setMarkdownDocxExportedHook,
} from "../../../markdown/src/main/markdown-main";
import {
  configureHtmlRuntime,
  createHtmlView,
  requestHtmlClose,
  requestHtmlSave,
  registerHtmlSchemes,
  setHtmlFileSavedHook,
  setHtmlProvisionalTitleHook,
  setHtmlDocxExportedHook,
  setHtmlPresentHooks,
} from "../../../html/src/main/html-main";

export type OfficeKind = "docs" | "sheets" | "slides" | "markdown" | "html";
export interface OfficeRecord {
  kind: OfficeKind;
  view: WebContentsView;
}
export interface OfficeCallbacks {
  open(
    kind: OfficeKind,
    path?: string,
    options?: { newBlank?: boolean },
  ): WebContentsView | void;
  openPath(path: string): boolean;
  closeActive(): void;
  listTabs(): { id: string; title: string; kind: string; active: boolean }[];
  focus(id: string): void;
  fileChanged(webContentsId: number, path: string): void;
  titleChanged?(webContentsId: number, title: string): void;
  setBleed?(webContentsId: number, enabled: boolean): void;
  extractPdfText?(bytes: Uint8Array): Promise<string>;
  installBaseMenu?(): void;
}

// Electron requires scheme privileges to be declared before app.whenReady().
registerHtmlSchemes();
let configured = false;
let parent: BrowserWindow | null = null;
let callbacks: OfficeCallbacks | null = null;
let active: OfficeRecord | null = null;
const closing = new Map<number, Promise<boolean>>();

export function configureOfficeEditors(
  window: BrowserWindow,
  hooks: OfficeCallbacks,
): void {
  parent = window;
  callbacks = hooks;
  configurePdfTextExtractor((bytes) => {
    if (!callbacks?.extractPdfText)
      return Promise.reject(new Error("Key PDF backend is unavailable"));
    return callbacks.extractPdfText(bytes);
  });
  const besideApp = join(app.getAppPath(), "..");
  const appsRoot =
    process.env.KEY_OFFICE_APPS_ROOT ??
    (existsSync(join(besideApp, "docs"))
      ? besideApp
      : join(besideApp, "key-office", "apps"));
  const out = (kind: OfficeKind) =>
    app.isPackaged
      ? join(process.resourcesPath, "modules", kind)
      : join(appsRoot, kind, "out");
  const paths = (kind: OfficeKind) => ({
    preloadPath: join(out(kind), "preload", "index.js"),
    rendererFile: join(out(kind), "renderer", "index.html"),
    rendererUrl: process.env[`${kind.toUpperCase()}_RENDERER_URL`],
  });
  const openGeneratedPath = (path: string) =>
    callbacks?.openPath(path) ?? false;
  configureDocsRuntime(paths("docs"));
  configureSheetsRuntime({
    ...paths("sheets"),
    openGeneratedPath,
    createDocument: createAiDocument,
    sidecarPath: app.isPackaged
      ? join(
          process.resourcesPath,
          "native",
          process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar",
        )
      : join(
          appsRoot,
          "sheets",
          "native",
          "xlsx-engine",
          "target",
          "release",
          process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar",
        ),
  });
  configureSlidesRuntime({
    preloadPath: paths("slides").preloadPath,
    rendererDevUrl: paths("slides").rendererUrl,
    rendererFilePath: paths("slides").rendererFile,
    openGeneratedPath,
  });
  configureMarkdownRuntime({ ...paths("markdown"), openGeneratedPath });
  configureHtmlRuntime({ ...paths("html"), openGeneratedPath });
  setDocsShellWindow(window);
  setSheetsShellWindow(window);
  setSlidesShellWindow(window);
  setDocsMenuGate(() => active?.kind === "docs");
  setActiveDocsResolver(() =>
    active?.kind === "docs" ? active.view.webContents : null,
  );
  setDocsShellHooks({
    openTab: (path, options) => {
      callbacks?.open("docs", path, options);
    },
    openAiDocTab: (content) => {
      const view = callbacks?.open("docs", undefined, { newBlank: true });
      if (view) queueDocsAiContent(view.webContents.id, content);
    },
    listTabs: () =>
      callbacks
        ?.listTabs()
        .filter((tab) => tab.kind === "docs")
        .map((tab) => ({
          id: tab.id,
          title: tab.title,
          focused: tab.active,
        })) ?? [],
    focusTab: (id) => callbacks?.focus(id),
    closeActiveTab: () => callbacks?.closeActive(),
    openGeneratedPath,
  });
  setSheetsCloseTabHook(() => callbacks?.closeActive());
  setSlidesCloseTabHook(() => callbacks?.closeActive());
  setSlidesShowBleed((wc, on) => callbacks?.setBleed?.(wc.id, on));
  const fileChanged = (id: number, path: string) =>
    callbacks?.fileChanged(id, path);
  setDocsFileSavedHook((wc, path) => fileChanged(wc.id, path));
  setDocsFileOpenedHook(fileChanged);
  setSheetsWorkbookOpenedHook((wc, path) => fileChanged(wc.id, path));
  setSlidesOpenedHook((wc, path) => fileChanged(wc.id, path));
  setMarkdownFileSavedHook((wc, path) => fileChanged(wc.id, path));
  setHtmlFileSavedHook((wc, path) => fileChanged(wc.id, path));
  setHtmlProvisionalTitleHook((wc, title) =>
    callbacks?.titleChanged?.(wc.id, title),
  );
  setMarkdownDocxExportedHook((path) => {
    callbacks?.openPath(path);
  });
  setHtmlDocxExportedHook((path) => {
    callbacks?.openPath(path);
  });
  setHtmlPresentHooks({
    setBleed: (wc, on) => callbacks?.setBleed?.(wc.id, on),
    hostWindow: () => parent,
  });
  if (!configured) {
    registerAiIpc();
    registerProjectIpc();
    registerDocsIpc();
    configured = true;
  }
}

export function createOfficeView(
  kind: OfficeKind,
  path?: string,
  options?: { newBlank?: boolean },
): WebContentsView {
  if (!configured)
    throw new Error("Configure Key office editors before opening a view");
  switch (kind) {
    case "docs": {
      const view = createDocsView(path);
      if (options?.newBlank ?? !path) markDocsNewBlank(view.webContents.id);
      return view;
    }
    case "sheets": {
      if (options?.newBlank ?? !path) setSheetsNewBlank();
      // The docs-owned shared AI IPC dispatcher is registered once by the shell.
      const view = createSheetsView({ includeAiHandlers: false });
      if (path) queueWorkbookForView(view.webContents, path);
      return view;
    }
    case "slides":
      return createSlidesView(path);
    case "markdown":
      return createMarkdownView(path);
    case "html":
      return createHtmlView(path);
  }
}

export function activateOfficeView(
  kind: OfficeKind | null,
  view: WebContentsView | null,
): void {
  active = kind && view ? { kind, view } : null;
  setActiveSheetsWebContents(
    kind === "sheets" && view ? view.webContents : null,
  );
  setActiveSlidesWebContents(
    kind === "slides" && view ? view.webContents : null,
  );
  if (kind === "docs") buildDocsMenu();
  else if (kind === "sheets") installSheetsMenu();
  else if (kind === "slides") installSlidesMenu();
  else callbacks?.installBaseMenu?.();
}

/** The owner detaches the view only after this returns true. */
export function closeOfficeView(record: OfficeRecord): Promise<boolean> {
  const wc = record.view.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve(true);
  const previous = closing.get(wc.id);
  if (previous) return previous;
  const id = wc.id;
  const pending = (async () => {
    const guard = {
      docs: requestDocsClose,
      sheets: requestSheetsClose,
      slides: requestSlidesClose,
      markdown: requestMarkdownClose,
      html: requestHtmlClose,
    }[record.kind];
    if (!(await guard(wc, parent))) return false;
    if (record.kind === "docs" && !wc.isDestroyed()) {
      teardownDocsRenderer(wc);
      // Drop the editor/accessibility tree before destroying the native view.
      // Upstream detached Docs forever to avoid a native close-loop hang.
      await wc.loadURL("about:blank");
    }
    if (active?.view === record.view) activateOfficeView(null, null);
    if (!wc.isDestroyed()) wc.close();
    return true;
  })().finally(() => closing.delete(id));
  closing.set(id, pending);
  return pending;
}

export function saveOfficeTextView(
  record: OfficeRecord,
  saveAs = false,
): Promise<boolean> {
  if (record.kind === "markdown")
    return requestMarkdownSave(
      record.view.webContents,
      saveAs ? "saveAs" : "save",
    );
  if (record.kind === "html")
    return requestHtmlSave(record.view.webContents, saveAs ? "saveAs" : "save");
  return Promise.resolve(false);
}
