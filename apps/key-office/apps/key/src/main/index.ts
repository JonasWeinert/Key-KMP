import { placeSearchResultTab } from "../shared/search-preview-model";
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  Menu,
  screen,
  shell as systemShell,
  nativeImage,
  globalShortcut,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setUiLang, normalizeLang } from "@key/i18n";
import { AgentFill } from "./agent-fill";
import { AppSettingsStore, appInfo } from "./app-settings";
import { downloadPdf } from "./download-pdf";
import { LinkedFolders } from "./linked-folders";
import { Registry, type WorkspaceInfo } from "./workspaces";
import { registerMediaScheme, routeEmbeddedMedia, serveNoteMedia } from "./note-media";
import { WindowStateStore, type SavedLayout, type SavedTabs, type SavedView, type SavedWindow, type WindowState } from "./window-state";
import {
  setOfficeShellWindow,
  configureOfficeEditors,
  createOfficeView,
  closeOfficeView,
  canCloseOfficeView,
  activateOfficeView,
  type OfficeKind,
} from "./office-editors";
import {
  reorderWorkspaceTab,
  applyWorkspaceViewDrop,
  singleWorkspaceTab,
  activeWorkspaceTab,
  activateWorkspaceTab,
  closeWorkspaceView,
  splitWithTab,
  separateWorkspaceTab,
  swapWorkspaceSplit,
  setWorkspaceSplitRatio,
  resetWorkspaceSplits,
  replaceWorkspaceView,
  layoutPanes,
  layoutViews,
  neighbourPane,
  MAX_PANES,
  tabWithLayout,
  type PaneLayout,
  type SplitEdge,
  type WorkspaceTabsState,
} from "../shared/tab-model";

type OwnedView = {
  id: string;
  title: string;
  kind: "home" | "pdf" | OfficeKind;
  content?: {
    section: string;
    workspaceId?: string;
    projectId?: string;
    record?: any;
    noteId?: string;
    sourceId?: string;
    canvasId?: string;
    fileId?: string;
  };
  contentKey?: string;
  /** What this pane showed before a link was followed in place, and after going back. */
  back?: PaneEntry[];
  forward?: PaneEntry[];
  returnViewId?: string;
  searchPreviewOwner?: string;
  sharedSearchNavigation?: boolean;
  dirty?: boolean;
  workspaceId?: string;
  path?: string;
  source?: any;
  searchTarget?: any;
  /** Where the reader should go once it is ready: a page, and the annotation to light up. */
  pendingFocus?: { page?: number; annotationId?: string };
  searchResults?: {
    id: string;
    documentHash: string;
    documentTitle?: string;
    workspaceId: string;
  }[];
  searchIndex?: number;
  viewState?: any;
  view?: WebContentsView;
  lastUsed: number;
  recordId?: string;
  revision?: number;
  /** The window whose content view currently holds this view's native WebContentsView. */
  host?: ShellWindow;
};
type PaneEntry = Pick<OwnedView, "title" | "contentKey" | "content">;
/** One window: one workspace, its own tabs, sidebar width and modal overlay. Every window
 * talks to the same registry, Rust hosts and view records, so a document is never open twice. */
type ShellWindow = {
  id: string;
  window: BrowserWindow;
  /** The library this window's sidebar, new items and title belong to. */
  workspaceId: string;
  state: WorkspaceTabsState;
  sidebarWidth: number;
  /** The inspector panel at the right edge, 0 while it is closed. */
  inspectorWidth?: number;
  globalOverlay?: string;
  overlayCaptureSequence: number;
  overlayCaptureKey: string;
  closed?: boolean;
};
const shells = new Map<string, ShellWindow>();
let lastFocusedShell: ShellWindow | undefined;
let quitRequested = false;
function liveShells() {
  return [...shells.values()].filter((w) => !w.closed && !w.window.isDestroyed());
}
function shellBySender(sender: number) {
  return liveShells().find((w) => w.window.webContents.id === sender);
}
function shellOfView(viewId: string) {
  return liveShells().find((w) => w.state.tabs.some((t) => t.viewIds.includes(viewId)));
}
/** The window a menu command or new document should go to. */
function focusedShell(): ShellWindow {
  const focused = BrowserWindow.getFocusedWindow();
  return (
    liveShells().find((w) => w.window === focused) ??
    (lastFocusedShell && !lastFocusedShell.closed && !lastFocusedShell.window.isDestroyed() ? lastFocusedShell : undefined) ??
    liveShells()[0]
  );
}
let registry: Registry;
let agentFill: AgentFill;
let appSettings: AppSettingsStore;
const views = new Map<string, OwnedView>();
const readerCalls = new Map<number, Set<Promise<unknown>>>();
const readerReleases = new Map<string, Promise<void>>();
function disposePdf(record: OwnedView) {
  const view = record.view;
  if (!view) return;
  const calls = [...(readerCalls.get(view.webContents.id) ?? [])];
  readerCalls.delete(view.webContents.id);
  if (record.host && !record.host.window.isDestroyed()) record.host.window.contentView.removeChildView(view);
  record.host = undefined;
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
type SearchResultRef = {
  id: string;
  documentHash: string;
  documentTitle?: string;
  workspaceId: string;
  page: number;
};
type SearchPreviewSession = {
  sourceViewId: string;
  previewViewId?: string;
  hits: SearchResultRef[];
  index: number;
  query: string;
  busy: boolean;
  error?: string;
  sequence: number;
  dismissed: boolean;
};
const searchPreviews = new Map<string, SearchPreviewSession>();
// The search bar belongs to the tab showing a result (results open in their own tab).
function activeSearchPreview(w: ShellWindow) {
  const group = activeWorkspaceTab(w.state);
  return [...searchPreviews.values()].find(
    (session) =>
      !session.dismissed &&
      (session.previewViewId && group?.viewIds.includes(session.previewViewId)
        ? group.activeViewId === session.previewViewId || group.viewIds.length === 1
        : (session.busy || Boolean(session.error)) && group?.viewIds.includes(session.sourceViewId)),
  );
}
function searchPreviewSnapshot(w: ShellWindow) {
  const session = activeSearchPreview(w);
  if (!session) return undefined;
  return {
    sourceViewId: session.sourceViewId,
    previewViewId: session.previewViewId,
    index: session.index,
    total: session.hits.length,
    query: session.query,
    busy: session.busy,
    error: session.error,
    hit: session.hits[session.index],
  };
}
async function showSearchPreview(session: SearchPreviewSession, index: number) {
  const hit = session.hits[index];
  const w = shellOfView(session.sourceViewId);
  if (!hit || !w || !views.has(session.sourceViewId)) return;
  const sequence = ++session.sequence;
  session.busy = true;
  session.error = undefined;
  session.dismissed = false;
  layout(w);
  try {
    const cachedSource = views.get(
      `pdf:${hit.workspaceId}:${hit.documentHash}`,
    )?.source;
    const [info, target] = await Promise.all([
      cachedSource
        ? Promise.resolve(cachedSource)
        : registry.invoke(
            "library_source_info",
            { hash: hit.documentHash },
            hit.workspaceId,
          ),
      registry.invoke("resolve_search_target", { id: hit.id }, hit.workspaceId),
    ]);
    if (
      session.sequence !== sequence ||
      session.dismissed ||
      !views.has(session.sourceViewId)
    )
      return;
    // Only follow through while the user is still on the results or on the result's tab.
    const current = activeWorkspaceTab(w.state)?.viewIds ?? [];
    if (!current.includes(session.sourceViewId) && !current.includes(session.previewViewId ?? "")) {
      session.busy = false;
      session.dismissed = true;
      return;
    }
    const id = `pdf:${hit.workspaceId}:${hit.documentHash}`;
    let preview = views.get(id);
    if (!preview) {
      preview = {
        id,
        kind: "pdf",
        title: hit.documentTitle || (info as any).title,
        workspaceId: hit.workspaceId,
        source: info,
        lastUsed: Date.now(),
        searchPreviewOwner: session.sourceViewId,
      };
      views.set(id, preview);
    }
    const old = views.get(session.previewViewId || "");
    const replaceable =
      old?.searchPreviewOwner === session.sourceViewId ? old.id : undefined;
    w.state = placeSearchResultTab(w.state, session.sourceViewId, id, replaceable);
    if (
      old &&
      old.id !== id &&
      replaceable &&
      !liveShells().some((s) => s.state.tabs.some((t) => t.viewIds.includes(old.id)))
    ) {
      disposePdf(old);
      views.delete(old.id);
    }
    preview.searchTarget = target;
    preview.returnViewId = session.sourceViewId;
    preview.sharedSearchNavigation = true;
    preview.searchResults = session.hits;
    preview.searchIndex = index;
    session.hits[index] = {
      ...hit,
      documentTitle: preview.title,
      page: (target as any).page,
    };
    session.previewViewId = id;
    session.index = index;
    session.busy = false;
    preview.view?.webContents.send("search-target", target);
    preview.view?.webContents.send("search-navigation", {
      index,
      total: session.hits.length,
      shared: true,
      query: session.query,
    });
    layout(w);
  } catch (e) {
    if (session.sequence !== sequence) return;
    session.busy = false;
    session.error = String(e);
    layout(w);
  }
}
function dismissSearchPreview(sourceViewId: string) {
  const session = searchPreviews.get(sourceViewId);
  if (!session) return;
  session.dismissed = true;
  session.busy = false;
  ++session.sequence;
  const preview = views.get(session.previewViewId || "");
  if (preview) {
    preview.searchTarget = undefined;
    preview.searchPreviewOwner = undefined;
    preview.view?.webContents.send("search-target", undefined);
  }
  const w = shellOfView(sourceViewId);
  if (w) layout(w);
}
const preload = join(__dirname, "../preload/index.js");
const renderer = join(__dirname, "../renderer");
function snapshot(w: ShellWindow) {
  const state = w.state;
  return {
    windowId: w.id,
    workspaceId: w.workspaceId,
    windowCount: liveShells().length,
    /** Which workspaces other windows show, for the switcher. */
    windows: liveShells().map((s) => ({ windowId: s.id, workspaceId: s.workspaceId })),
    splitRatio: activeWorkspaceTab(state)?.splitRatio ?? 0.5,
    searchPreview: searchPreviewSnapshot(w),
    tabs: state.tabs.map((t) => ({
      id: t.id,
      layout: t.layout,
      title: t.viewIds
        .map(
          (id) =>
            `${views.get(id)?.title ?? "Key"}${views.get(id)?.dirty ? " •" : ""}`,
        )
        .join(" / "),
      views: t.viewIds.map((id) => ({
        id,
        title: `${views.get(id)?.title ?? "Key"}${views.get(id)?.dirty ? " •" : ""}`,
        workspaceId: views.get(id)?.workspaceId,
        kind:
          views.get(id)?.content?.section === "record"
            ? views.get(id)?.content?.record?.kind || "page"
            : views.get(id)?.contentKey
              ? views.get(id)?.content?.section === "sources"
                ? "library"
                : views.get(id)?.content?.section === "note"
                  ? "note"
                  : views.get(id)?.content?.section === "canvas"
                  ? "canvas"
                  : views.get(id)?.content?.section === "source" || views.get(id)?.content?.section === "file"
                    ? "page"
                    : "records"
              : views.get(id)?.kind,
        content: views.get(id)?.content,
        back: views.get(id)?.back?.map((e) => e.title).slice(-3),
        forward: views.get(id)?.forward?.at(-1)?.title,
      })),
    })),
    activeTabId: state.activeTabId,
    activeViewId: activeWorkspaceTab(state)?.activeViewId,
  };
}
/** Library-wide events reach every window. */
function emit(event: string, value?: unknown) {
  for (const w of liveShells()) w.window.webContents.send(event, value);
}
function emitTo(w: ShellWindow, event: string, value?: unknown) {
  if (!w.window.isDestroyed()) w.window.webContents.send(event, value);
}
function tabsChanged(w: ShellWindow) {
  emitTo(w, "tabs-changed", snapshot(w));
  saveWindows();
}
function homeView(): OwnedView {
  const record: OwnedView = {
    id: randomUUID(),
    title: "Home",
    content: { section: "home" },
    kind: "home",
    lastUsed: Date.now(),
  };
  views.set(record.id, record);
  return record;
}
function home(w: ShellWindow = focusedShell()) {
  const tab = singleWorkspaceTab(homeView().id);
  w.state.tabs.push(tab);
  w.state.activeTabId = tab.id;
  layout(w);
}
/** A Home pane beside the focused pane: a launcher whose next opened item takes its place. */
function splitPane(w: ShellWindow, edge: SplitEdge) {
  const tab = activeWorkspaceTab(w.state);
  if (!tab) return home(w);
  const record = homeView();
  const next = applyWorkspaceViewDrop(
    { ...w.state, tabs: [...w.state.tabs, singleWorkspaceTab(record.id)] },
    { kind: "split", viewId: record.id, targetTabId: tab.id, targetViewId: tab.activeViewId, edge },
  );
  // A full tab cannot take another pane; the Home view goes nowhere.
  if (next.tabs.some((t) => t.viewIds.length === 1 && t.viewIds[0] === record.id)) {
    views.delete(record.id);
    return;
  }
  w.state = next;
  layout(w);
}
function focusPane(w: ShellWindow, direction: SplitEdge) {
  const tab = activeWorkspaceTab(w.state);
  const next = tab && neighbourPane(tab.layout, tab.activeViewId, direction);
  if (!tab || !next) return;
  w.state = activateWorkspaceTab(w.state, tab.id, next);
  layout(w);
  // Native views take keyboard focus themselves; DOM panes are focused by the shell.
  const view = views.get(next)?.view;
  if (view) view.webContents.focus();
  else {
    w.window.webContents.focus();
    emitTo(w, "focus-pane", next);
  }
}
/** Creates the native view on first show, or moves it to the window that now shows it. */
function attach(record: OwnedView, w: ShellWindow) {
  if (record.kind === "home") return;
  if (record.view) {
    if (record.host !== w) {
      if (record.host && !record.host.window.isDestroyed()) record.host.window.contentView.removeChildView(record.view);
      w.window.contentView.addChildView(record.view);
      record.host = w;
    }
    return;
  }
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
  w.window.contentView.addChildView(record.view);
  record.host = w;
  record.view.webContents.on("focus", () => {
    const owner = shellOfView(record.id);
    const tab = owner?.state.tabs.find((t) => t.viewIds.includes(record.id));
    if (owner && tab) {
      owner.state = activateWorkspaceTab(owner.state, tab.id, record.id);
      activateOfficeView(
        record.kind === "pdf" ? null : (record.kind as OfficeKind),
        record.kind === "pdf" ? null : record.view!,
      );
      tabsChanged(owner);
    }
  });
  record.view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url))
      void systemShell.openExternal(url);
    return { action: "deny" };
  });
}
function placeViews(w: ShellWindow) {
  if (w.window.isDestroyed()) return;
  const tab = activeWorkspaceTab(w.state);
  if (!tab) return;
  const [width, height] = w.window.getContentSize();
  // The renderer lays its DOM panes and dividers out with the same function and numbers.
  const { panes } = layoutPanes(tab.layout, {
    x: w.sidebarWidth,
    y: 40,
    width: Math.max(0, width - w.sidebarWidth - (w.inspectorWidth ?? 0)),
    height: Math.max(0, height - 40),
  });
  for (const { viewId, ...bounds } of panes) views.get(viewId)?.view?.setBounds(bounds);
}
async function captureOverlayFrames(w: ShellWindow) {
  const ids = activeWorkspaceTab(w.state)?.viewIds || [];
  return Promise.all(
    ids.flatMap((id) => {
      const view = views.get(id)?.view;
      if (!view || view.webContents.isDestroyed()) return [];
      const bounds = view.getBounds();
      return [
        (async () => {
          try {
            const capture = await view.webContents.capturePage(undefined, {
              stayHidden: true,
            });
            return {
              id,
              ...bounds,
              image: capture
                .resize({ width: Math.max(1, bounds.width) })
                .toDataURL(),
            };
          } catch {
            return null;
          }
        })(),
      ];
    }),
  ).then((frames) => frames.filter(Boolean));
}
function refreshOverlayFrames(w: ShellWindow) {
  if (!w.globalOverlay) return;
  const key = JSON.stringify(
    (activeWorkspaceTab(w.state)?.viewIds || []).map((id) => [
      id,
      views.get(id)?.view?.getBounds(),
    ]),
  );
  if (key === w.overlayCaptureKey) return;
  w.overlayCaptureKey = key;
  const id = w.globalOverlay,
    sequence = ++w.overlayCaptureSequence;
  emitTo(w, "global-overlay-frames", { id, frames: [] });
  void captureOverlayFrames(w).then((frames) => {
    if (w.globalOverlay === id && sequence === w.overlayCaptureSequence)
      emitTo(w, "global-overlay-frames", { id, frames });
  });
}
function layout(w: ShellWindow = focusedShell()) {
  if (!w || w.window.isDestroyed()) return;
  const tab = activeWorkspaceTab(w.state);
  const shown = new Set(tab?.viewIds ?? []);
  for (const id of shown) {
    const record = views.get(id);
    if (!record) continue;
    record.lastUsed = Date.now();
    attach(record, w);
  }
  // Views hosted here that this window no longer shows are hidden (they may now be in another window).
  for (const record of views.values())
    if (record.view && record.host === w) record.view.setVisible(!w.globalOverlay && shown.has(record.id));
  placeViews(w);
  refreshOverlayFrames(w);
  // Only the two most recently used PDF renderers retain their raster/GPU caches, across all windows.
  const visible = new Set(liveShells().flatMap((s) => activeWorkspaceTab(s.state)?.viewIds ?? []));
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
  tabsChanged(w);
}
/** Shows a view wherever it is open, bringing its window forward. */
function focus(id: string) {
  const w = shellOfView(id);
  const owner = w?.state.tabs.find((t) => t.viewIds.includes(id));
  if (w && owner) {
    w.state = activateWorkspaceTab(w.state, owner.id, id);
    layout(w);
    if (!w.window.isFocused()) w.window.focus();
  }
}
/** Where the next `add` puts its view: beside a pane, or in a pane's place (with history). */
let placement: { mode: "split" | "here"; viewId: string } | undefined;
async function withPlacement(p: any, open: () => Promise<unknown>) {
  placement = p.placement === "split" || p.placement === "here" ? { mode: p.placement, viewId: String(p.fromViewId ?? "") } : undefined;
  try {
    await open();
  } finally {
    placement = undefined;
  }
}
const paneEntry = (v: OwnedView): PaneEntry => ({ title: v.title, contentKey: v.contentKey, content: v.content });
/** Follows a link inside a DOM pane: it shows `record`'s content and remembers what it showed. */
function navigateInPlace(w: ShellWindow, pane: OwnedView, record: OwnedView) {
  views.delete(record.id);
  pane.back = [...(pane.back ?? []), paneEntry(pane)].slice(-50);
  pane.forward = [];
  Object.assign(pane, { title: record.title, contentKey: record.contentKey, content: record.content, workspaceId: record.workspaceId, dirty: false });
  focus(pane.id);
  tabsChanged(w);
}
/** Back (-1) or forward (1) in a pane's history; an entry open elsewhere is focused there. */
function stepHistory(w: ShellWindow, viewId: string, step: number) {
  const pane = views.get(viewId);
  if (!pane || pane.dirty) return;
  const from = step < 0 ? pane.back : pane.forward;
  const entry = from?.pop();
  if (!entry) return;
  const elsewhere = [...views.values()].find((v) => v !== pane && v.contentKey === entry.contentKey);
  if (elsewhere && shellOfView(elsewhere.id)) return focus(elsewhere.id);
  (step < 0 ? (pane.forward ??= []) : (pane.back ??= [])).push(paneEntry(pane));
  Object.assign(pane, entry, { dirty: false });
  tabsChanged(w);
}
function add(record: OwnedView, w: ShellWindow = focusedShell()) {
  const target = placement && views.get(placement.viewId);
  const mode = placement?.mode;
  placement = undefined;
  if (mode === "here" && target?.kind === "home" && target.content && !target.dirty && record.kind === "home" && shellOfView(target.id) === w) {
    navigateInPlace(w, target, record);
    return undefined;
  }
  views.set(record.id, record);
  const beside = mode === "split" && target ? w.state.tabs.find((t) => t.viewIds.includes(target.id)) : undefined;
  if (beside && beside.viewIds.length < MAX_PANES) {
    const tab = singleWorkspaceTab(record.id);
    w.state.tabs.push(tab);
    w.state = applyWorkspaceViewDrop(w.state, { kind: "split", viewId: record.id, targetTabId: beside.id, targetViewId: target!.id, edge: "right" });
    layout(w);
    return record.view;
  }
  // A focused Home pane inside a split is a launcher: what it opens takes its place.
  const current = activeWorkspaceTab(w.state);
  const launcher = current && current.viewIds.length > 1 ? views.get(current.activeViewId) : undefined;
  if (launcher?.content?.section === "home") {
    w.state = replaceWorkspaceView(w.state, launcher.id, record.id);
    views.delete(launcher.id);
    layout(w);
    return record.view;
  }
  const tab = singleWorkspaceTab(record.id);
  w.state.tabs.push(tab);
  w.state.activeTabId = tab.id;
  layout(w);
  return record.view;
}
/** Closes a tab after unsaved-change checks. Returns false if the user kept it.
 * `windowClosing` leaves an emptied window empty instead of opening Home. */
async function closeTab(w: ShellWindow, id: string, windowClosing = false): Promise<boolean> {
  const tab = w.state.tabs.find((t) => t.id === id);
  if (!tab) return true;
  if (!(await closeViews(w, tab.viewIds))) return false;
  if (windowClosing) return true;
  afterClose(w);
  return true;
}
/** Closes one pane; the tab closes with its last pane. */
async function closePane(w: ShellWindow, viewId: string): Promise<boolean> {
  if (!w.state.tabs.some((t) => t.viewIds.includes(viewId))) return true;
  if (!(await closeViews(w, [viewId]))) return false;
  afterClose(w);
  return true;
}
// An emptied extra window closes; the last window keeps a Home tab.
function afterClose(w: ShellWindow) {
  if (!w.state.tabs.length && liveShells().length > 1) w.window.close();
  else if (!w.state.tabs.length) home(w);
  else layout(w);
}
/** Closed panes, newest last, for Reopen Closed Tab. */
const closedViews: SavedView[] = [];
async function reopenClosed(w: ShellWindow) {
  while (closedViews.length) {
    const record = await restoredView(closedViews.pop()!);
    if (record) return void add(record, w);
  }
}
/** Checks every view for unsaved changes before disposing any, then disposes them all. */
async function closeViews(w: ShellWindow, ids: string[]): Promise<boolean> {
  for (const viewId of ids) {
    const saved = savedView(viewId);
    if (saved && saved.type !== "home") closedViews.push(saved);
  }
  closedViews.splice(0, Math.max(0, closedViews.length - 20));
  for (const viewId of ids) {
    const record = views.get(viewId);
    if (record?.dirty) {
      const result = await dialog.showMessageBox(w.window, {
        type: "warning",
        message: `Discard unsaved changes to ${record.title}?`,
        detail: "Return to the tab and save to keep your changes.",
        buttons: ["Cancel", "Discard"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) {
        focus(viewId);
        return false;
      }
    }
    if (
      record?.view &&
      record.kind !== "home" &&
      record.kind !== "pdf" &&
      !(await canCloseOfficeView({ kind: record.kind, view: record.view }))
    ) {
      focus(viewId);
      return false;
    }
  }
  for (const viewId of [...ids]) {
    const record = views.get(viewId);
    if (!record) {
      w.state = closeWorkspaceView(w.state, viewId);
      continue;
    }
    if (
      record.view &&
      record.kind !== "pdf" &&
      record.kind !== "home" &&
      !(await closeOfficeView({ kind: record.kind, view: record.view }, true))
    )
      return false;
    if (record.kind === "pdf") disposePdf(record);
    else if (record.view) {
      if (record.host && !record.host.window.isDestroyed()) record.host.window.contentView.removeChildView(record.view);
      if (!record.view.webContents.isDestroyed())
        record.view.webContents.close();
    }
    views.delete(viewId);
    if (searchPreviews.has(viewId)) {
      const session = searchPreviews.get(viewId)!;
      session.dismissed = true;
      ++session.sequence;
      searchPreviews.delete(viewId);
    }
    w.state = closeWorkspaceView(w.state, viewId);
  }
  return true;
}
function office(kind: OfficeKind, path?: string, workspaceId?: string, w: ShellWindow = focusedShell()) {
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
  }, w);
}
function openPath(path: string, workspaceId?: string, w: ShellWindow = focusedShell()) {
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
  office(kind, path, workspaceId, w);
  return true;
}
async function sourceOpen(source: any, hit?: any, results?: any[], w: ShellWindow = focusedShell()) {
  const origin = views.get(activeWorkspaceTab(w.state)?.activeViewId ?? "");
  const returnViewId = origin?.content ? origin.id : origin?.returnViewId;
  const workspaceId = source.workspaceId ?? hit?.workspaceId ?? w.workspaceId;
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
  const searchResults =
    hit && Array.isArray(results)
      ? results.slice(0, 1000).map((h) => ({
          id: h.id,
          documentHash: h.documentHash,
          documentTitle: h.documentTitle,
          workspaceId: h.workspaceId ?? workspaceId,
        }))
      : undefined;
  const searchIndex = searchResults?.findIndex(
    (h) => h.id === hit.id && h.workspaceId === workspaceId,
  );
  const existing = views.get(id);
  if (existing) {
    existing.sharedSearchNavigation = false;
    existing.returnViewId = returnViewId ?? existing.returnViewId;
    existing.searchTarget = target;
    existing.searchResults = searchResults;
    existing.searchIndex = searchIndex;
    focus(id);
    if (target) existing.view?.webContents.send("search-target", target);
    existing.view?.webContents.send("search-navigation", {
      shared: false,
      index: searchIndex ?? -1,
      total: searchResults?.length ?? 0,
    });
    return;
  }
  add({
    id,
    title: source.title ?? source.documentTitle ?? (info as any).title,
    kind: "pdf",
    returnViewId,
    workspaceId,
    source: info,
    searchTarget: target,
    searchResults,
    searchIndex,
    lastUsed: Date.now(),
  }, w);
}
async function saveOfficeRecord(v: OwnedView) {
  try {
    v.workspaceId ??= shellOfView(v.id)?.workspaceId ?? (await registry.list())[0]?.id;
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
async function importSources(workspaceId?: string, w: ShellWindow = focusedShell()) {
  workspaceId ??= w.workspaceId;
  const result = await dialog.showOpenDialog(w.window, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents",
        extensions: ["pdf", "docx", "xlsx", "pptx", "md", "html"],
      },
    ],
  });
  for (const path of result.filePaths) {
    if (openPath(path, workspaceId, w)) continue;
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
let workspaceParent = "";
/** The "Zotero" workspace beside the default one, created on first use. */
const zoteroWorkspace = () => registry.add(join(workspaceParent, "Zotero"), "Zotero");
/** Imports the Zotero library into its own "Zotero" workspace beside the default one. */
async function importZotero(options?: Record<string, unknown>) {
  const workspace = await zoteroWorkspace();
  const report = await registry.invoke("store_import_zotero", options ?? {}, workspace.id);
  emit("library-changed");
  return { workspace, report };
}
/** While Zotero sync is on, asks the Zotero workspace to sync; its host only reads
 *  zotero.sqlite again when the file changed. Nothing runs before a first import. */
let zoteroSyncing = false;
async function syncZotero(force = false) {
  if (zoteroSyncing || !appSettings?.get().zoteroSync) return;
  zoteroSyncing = true;
  try {
    const root = await realpath(join(workspaceParent, "Zotero")).catch(() => "");
    const workspace = root && (await registry.list()).find((w) => w.root === root);
    if (!workspace) return;
    const result: any = await registry.invoke("store_zotero_sync", { force }, workspace.id);
    if (result?.ran) emit("library-changed");
  } catch (e) {
    console.warn("Zotero sync:", e);
  } finally {
    zoteroSyncing = false;
  }
}
/** Quick capture (⌃⌥Space from anywhere): a small window for a thought or a link. */
let captureWindow: BrowserWindow | undefined;
function quickCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = 560,
    height = 236;
  captureWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * 0.22),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Quick capture",
    ...(process.platform === "darwin" ? { vibrancy: "hud" as const, visualEffectState: "active" as const, backgroundColor: "#00000000", roundedCorners: true } : {}),
    webPreferences: WINDOW_OPTIONS.webPreferences,
  });
  const win = captureWindow;
  win.once("ready-to-show", () => win.show());
  win.on("blur", () => !win.isDestroyed() && win.close());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#capture`);
  else void win.loadFile(join(renderer, "index.html"), { hash: "capture" });
}
/** Saves a capture to the focused window's workspace: a link joins the Inbox, text becomes a note. */
async function saveCapture(text: string) {
  const workspaceId = focusedShell()?.workspaceId || knownWorkspaces[0]?.id;
  if (!workspaceId || !text.trim()) return;
  const value = text.trim();
  if (/^https?:\/\/\S+$/i.test(value)) {
    const collections = await registry.invoke<{ id: string; name: string; parentId: string | null }[]>("store_collections", {}, workspaceId);
    const inbox =
      collections.find((c) => !c.parentId && c.name === "Inbox")?.id ??
      (await registry.invoke<{ id: string }>("store_collection_create", { name: "Inbox", parentId: null }, workspaceId)).id;
    await registry.invoke("store_create", { source: { kind: "web", itemType: "webpage", title: value, url: value, collections: [inbox] } }, workspaceId);
  } else {
    const [first, ...rest] = value.split("\n");
    await registry.invoke("store_note_save", { id: null, sourceId: null, title: first.slice(0, 200), body: rest.join("\n").trim() }, workspaceId);
  }
  emit("library-changed");
}

const WINDOW_OPTIONS = {
  width: 1440,
  height: 960,
  minWidth: 850,
  minHeight: 600,
  title: "Key",
  titleBarStyle: "hiddenInset" as const,
  trafficLightPosition: { x: 16, y: 14 },
  // The renderer leaves the sidebar translucent; the content column stays opaque.
  ...(process.platform === "darwin"
    ? {
        vibrancy: "sidebar" as const,
        visualEffectState: "followWindow" as const,
        backgroundColor: "#00000000",
      }
    : {}),
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
};
/** Opens a window on a workspace. With `tabs`, it starts with those (moved) tabs; with
 * `saved`, it takes that window's frame and restores its tabs; otherwise it shows Home. */
function createShell(
  options: { workspaceId?: string; tabs?: WorkspaceTabsState["tabs"]; saved?: SavedWindow; load?: boolean } = {},
): ShellWindow {
  const previous = focusedShell();
  const frame = options.saved?.bounds && visibleBounds(options.saved.bounds);
  const window = new BrowserWindow({
    ...WINDOW_OPTIONS,
    ...(frame
      ? frame
      : // New windows cascade from the one they came from.
        previous
        ? (() => {
            const [x, y] = previous.window.getPosition();
            const [width, height] = previous.window.getSize();
            return { x: x + 28, y: y + 28, width, height };
          })()
        : {}),
  });
  if (options.saved?.maximized) window.maximize();
  if (options.saved?.fullScreen) window.setFullScreen(true);
  const w: ShellWindow = {
    id: randomUUID(),
    window,
    workspaceId: options.saved?.workspaceId ?? options.workspaceId ?? previous?.workspaceId ?? knownWorkspaces[0]?.id ?? "",
    state: { tabs: options.tabs ?? [], activeTabId: options.tabs?.at(-1)?.id ?? null },
    sidebarWidth: options.saved?.sidebarWidth ?? previous?.sidebarWidth ?? 240,
    overlayCaptureSequence: 0,
    overlayCaptureKey: "",
  };
  shells.set(w.id, w);
  focusOrder.unshift(w.id);
  titleWindow(w);
  touchRecent(w.workspaceId);
  // The window's title names its workspace, not the page.
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.on("did-start-loading", () => {
    if (w.globalOverlay) {
      w.globalOverlay = undefined;
      w.overlayCaptureKey = "";
      ++w.overlayCaptureSequence;
      layout(w);
    }
  });
  window.on("resize", () => layout(w));
  window.on("move", () => saveWindows());
  window.on("focus", () => {
    lastFocusedShell = w;
    focusOrder.splice(focusOrder.indexOf(w.id) >>> 0, 1);
    focusOrder.unshift(w.id);
    // Office editors open their dialogs and menus over the window in use.
    setOfficeShellWindow(window);
    refreshMenu();
  });
  window.on("close", (event) => {
    if (w.closed) return;
    event.preventDefault();
    // Quitting, or closing the last window, keeps every window for the next launch;
    // closing one of several keeps its arrangement for the next visit to its workspace.
    const ending = quitRequested || liveShells().length === 1;
    if (ending) freezeWindows();
    else windowState.layouts[w.workspaceId] = savedTabs(w);
    void (async () => {
      for (const tab of [...w.state.tabs]) {
        if (!(await closeTab(w, tab.id, true))) {
          quitRequested = false;
          frozen = false;
          layout(w);
          return;
        }
      }
      w.closed = true;
      shells.delete(w.id);
      focusOrder.splice(focusOrder.indexOf(w.id) >>> 0, 1);
      if (lastFocusedShell === w) lastFocusedShell = undefined;
      for (const other of liveShells()) tabsChanged(other);
      if (!liveShells().length) {
        await registry.close();
        window.destroy();
        app.quit();
        return;
      }
      window.destroy();
      if (quitRequested) app.quit();
      else saveWindows();
    })();
  });
  if (options.load !== false) {
    void (async () => {
      if (options.saved) await restoreTabs(w, options.saved.tabs);
      if (!w.state.tabs.length) home(w);
      await loadShell(w);
      layout(w);
      for (const other of liveShells()) if (other !== w) tabsChanged(other);
    })().catch((error) => emit("operation-error", String(error)));
  }
  return w;
}
async function loadShell(w: ShellWindow) {
  if (process.env.ELECTRON_RENDERER_URL) await w.window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await w.window.loadFile(join(renderer, "index.html"));
}
/** A saved frame, if it still shows enough of itself on a connected display. */
function visibleBounds(bounds: { x: number; y: number; width: number; height: number }) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined;
  const width = Math.max(WINDOW_OPTIONS.minWidth, Math.round(bounds.width)),
    height = Math.max(WINDOW_OPTIONS.minHeight, Math.round(bounds.height));
  const fits = screen.getAllDisplays().some(({ workArea: a }) => {
    const across = Math.min(bounds.x + width, a.x + a.width) - Math.max(bounds.x, a.x);
    const down = Math.min(bounds.y + height, a.y + a.height) - Math.max(bounds.y, a.y);
    return across >= 120 && down >= 80 && bounds.y >= a.y - 4;
  });
  return fits ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height } : { width, height };
}

// Workspaces, as last listed by the registry, for titles and menus.
let knownWorkspaces: WorkspaceInfo[] = [];
async function refreshWorkspaces() {
  knownWorkspaces = await registry.list();
  for (const w of liveShells()) titleWindow(w);
  refreshMenu();
  return knownWorkspaces;
}
function titleWindow(w: ShellWindow) {
  if (w.window.isDestroyed()) return;
  const workspace = knownWorkspaces.find((k) => k.id === w.workspaceId);
  w.window.setTitle(workspace?.name ?? "Key");
  // macOS shows the folder in the Window menu and Mission Control.
  if (process.platform === "darwin" && workspace) w.window.setRepresentedFilename(workspace.root);
}
function touchRecent(workspaceId: string) {
  if (!workspaceId) return;
  windowState.recent = [workspaceId, ...windowState.recent.filter((id) => id !== workspaceId)].slice(0, 32);
}

/** Opens `workspaceId`: in place in `w`, or in a window of its own. A window already
 * showing it comes forward instead, so switching never opens one library twice. */
async function switchWorkspace(w: ShellWindow, workspaceId: string, newWindow = false) {
  if (!knownWorkspaces.some((k) => k.id === workspaceId)) await refreshWorkspaces();
  if (!knownWorkspaces.some((k) => k.id === workspaceId)) throw Error("This workspace is no longer available");
  if (w.workspaceId === workspaceId && !newWindow) return;
  const showing = liveShells().find((s) => s.workspaceId === workspaceId);
  if (showing) {
    if (showing.window.isMinimized()) showing.window.restore();
    showing.window.focus();
    return;
  }
  const remembered = windowState.layouts[workspaceId];
  if (newWindow) {
    createShell({ workspaceId, saved: remembered ? { workspaceId, tabs: remembered } : undefined });
    touchRecent(workspaceId);
    return;
  }
  // Leaving: check for unsaved work first, then remember the arrangement and close it.
  const leaving = savedTabs(w);
  if (!(await closeViews(w, w.state.tabs.flatMap((t) => t.viewIds)))) {
    layout(w);
    return;
  }
  windowState.layouts[w.workspaceId] = leaving;
  w.workspaceId = workspaceId;
  touchRecent(workspaceId);
  titleWindow(w);
  if (remembered) await restoreTabs(w, remembered);
  if (!w.state.tabs.length) {
    // A workspace seen for the first time opens on its library.
    await openContent(w, { section: "sources", workspaceId });
  }
  refreshMenu();
  layout(w);
}

// Persistence: every window's workspace, frame and tabs, saved as view descriptors.
let windowState: WindowState = { version: 1, windows: [], layouts: {}, recent: [] };
let windowStore: WindowStateStore;
/** Window ids, front-most first. */
const focusOrder: string[] = [];
/** Set while windows close for quitting, so their emptying tabs are not saved. */
let frozen = false;
function savedView(id: string): SavedView | undefined {
  const v = views.get(id);
  if (!v) return undefined;
  if (v.kind === "pdf")
    return v.workspaceId ? { type: "pdf", workspaceId: v.workspaceId, hash: v.source?.hash ?? v.id.split(":").at(-1)!, title: v.title } : undefined;
  if (v.kind !== "home") return v.path ? { type: "office", kind: v.kind, path: v.path, workspaceId: v.workspaceId } : undefined;
  const c = v.content;
  if (!c || c.section === "home") return { type: "home" };
  // A record that was never saved has nothing to reopen.
  if (c.section === "record" && !c.record?.id) return undefined;
  if (!["sources", "records", "record", "note", "source", "canvas", "file"].includes(c.section)) return undefined;
  return {
    type: "content",
    section: c.section as "sources",
    workspaceId: c.workspaceId,
    projectId: c.projectId,
    noteId: c.noteId,
    sourceId: c.sourceId,
    canvasId: c.canvasId,
    fileId: c.fileId,
    recordId: c.record?.id,
    title: v.title,
  };
}
function savedLayout(layout: PaneLayout): SavedLayout | undefined {
  if ("view" in layout) {
    const view = savedView(layout.view);
    return view && { view };
  }
  const a = savedLayout(layout.a),
    b = savedLayout(layout.b);
  return a && b ? { split: layout.split, ratio: layout.ratio, a, b } : (a ?? b);
}
function savedTabs(w: ShellWindow): SavedTabs {
  const tabs: SavedTabs["tabs"] = [];
  let active = 0;
  for (const tab of w.state.tabs) {
    const layout = savedLayout(tab.layout);
    if (!layout) continue;
    if (tab.id === w.state.activeTabId) active = tabs.length;
    const kept = layoutViews(tab.layout).filter((id) => savedView(id));
    tabs.push({ layout, active: Math.max(0, kept.indexOf(tab.activeViewId)) });
  }
  return { tabs, active };
}
function windowStateNow(): WindowState {
  const ordered = focusOrder.map((id) => shells.get(id)).filter((w): w is ShellWindow => !!w && !w.closed && !w.window.isDestroyed());
  return {
    ...windowState,
    windows: ordered.map((w) => ({
      workspaceId: w.workspaceId,
      bounds: w.window.getNormalBounds(),
      maximized: w.window.isMaximized(),
      fullScreen: w.window.isFullScreen(),
      sidebarWidth: w.sidebarWidth,
      tabs: savedTabs(w),
    })),
  };
}
function saveWindows() {
  if (!frozen && windowStore) windowStore.schedule(windowStateNow);
}
function freezeWindows() {
  if (frozen || !windowStore) return;
  windowState = windowStateNow();
  windowStore.writeNow(windowState);
  frozen = true;
}

const contentKey = (section: string, workspaceId?: string, projectId?: string, id?: string | null) =>
  section === "record" && id
    ? JSON.stringify(["record", workspaceId, id])
    : JSON.stringify([section, workspaceId || null, projectId || null, id ?? null]);
/** Opens (or focuses) a library list, record, note or source page in `w`. */
async function openContent(w: ShellWindow, p: any) {
  if (!["sources", "records", "record", "note", "canvas", "highlights", "file"].includes(p.section))
    throw Error("Invalid content view");
  if (p.section === "note" && (typeof p.noteId !== "string" || !p.noteId))
    throw Error("Choose a note");
  if (p.section === "canvas" && (typeof p.canvasId !== "string" || !p.canvasId))
    throw Error("Choose a canvas");
  if (p.section === "file" && (typeof p.fileId !== "string" || !p.fileId))
    throw Error("Choose a file");
  if (p.section !== "sources" && !p.workspaceId)
    throw Error("Choose a workspace");
  // A library without a workspace is this window's library.
  if (p.section === "sources" && !p.workspaceId) p.workspaceId = w.workspaceId;
  // Records have one global owner even when opened through another project.
  const recordKey = contentKey(
    p.section,
    p.workspaceId,
    p.projectId,
    p.section === "record" ? p.record?.id || randomUUID() : p.section === "note" ? p.noteId : p.section === "canvas" ? p.canvasId : p.section === "file" ? p.fileId : null,
  );
  const existing = [...views.values()].find((v) => v.contentKey === recordKey);
  if (existing) {
    focus(existing.id);
    return;
  }
  if (p.section === "record" && p.record?.id) {
    p.record = await registry.invoke("workspace_record", { id: p.record.id }, p.workspaceId);
    if (!p.record) throw Error("This item no longer exists");
  }
  const workspace = (await registry.list()).find((k) => k.id === p.workspaceId);
  const scope = p.projectId
    ? (await registry.invoke<any[]>("workspace_projects", {}, p.workspaceId)).find((project) => project.id === p.projectId)?.name
    : workspace?.name;
  const owner = [...views.values()].find((v) => v.contentKey === recordKey);
  if (owner) {
    focus(owner.id);
    return;
  }
  add({
    id: randomUUID(),
    kind: "home",
    title:
      p.section === "record"
        ? p.record?.title || `Untitled ${p.record?.kind || "page"}`
        : p.section === "note"
          ? String(p.title || "Untitled note").slice(0, 200)
          : p.section === "canvas" || p.section === "file"
            ? String(p.title || (p.section === "file" ? "File" : "Untitled canvas")).slice(0, 200)
            : p.section === "highlights"
              ? "Highlights"
              : `${p.section === "records" ? "All items" : "Sources"}${scope ? ` · ${scope}` : ""}`,
    workspaceId: p.workspaceId,
    lastUsed: Date.now(),
    contentKey: recordKey,
    content: {
      section: p.section,
      workspaceId: p.workspaceId,
      projectId: p.projectId,
      record: p.record,
      noteId: p.section === "note" ? p.noteId : undefined,
      canvasId: p.section === "canvas" ? p.canvasId : undefined,
      fileId: p.section === "file" ? p.fileId : undefined,
    },
  }, w);
}
/** A view for a saved descriptor, registered but not yet placed; undefined when it cannot
 * be opened any more or is already open elsewhere (one owner per document). */
async function restoredView(saved: SavedView): Promise<OwnedView | undefined> {
  try {
    if (saved.type === "home") return homeView();
    if (saved.type === "office") {
      if (!existsSync(saved.path) || [...views.values()].some((v) => v.path === saved.path)) return undefined;
      const record: OwnedView = { id: randomUUID(), kind: saved.kind as OfficeKind, path: saved.path, workspaceId: saved.workspaceId, title: basename(saved.path), lastUsed: Date.now() };
      views.set(record.id, record);
      return record;
    }
    if (saved.type === "pdf") {
      const id = `pdf:${saved.workspaceId}:${saved.hash}`;
      if (views.has(id)) return undefined;
      const info: any = await registry.invoke("library_source_info", { hash: saved.hash }, saved.workspaceId);
      const record: OwnedView = { id, kind: "pdf", title: saved.title || info.title, workspaceId: saved.workspaceId, source: info, lastUsed: Date.now() };
      views.set(id, record);
      return record;
    }
    const { section, workspaceId, projectId } = saved;
    let record: any;
    if (section === "record") {
      record = await registry.invoke("workspace_record", { id: saved.recordId }, workspaceId);
      if (!record) return undefined;
    }
    if (section === "note" && !(await registry.invoke("store_note", { id: saved.noteId }, workspaceId))) return undefined;
    if (section === "canvas" && !(await registry.invoke("store_canvas", { id: saved.canvasId }, workspaceId))) return undefined;
    if (section === "source" && !(await registry.invoke("store_source", { id: saved.sourceId }, workspaceId))) return undefined;
    if (section === "file" && !(await registry.invoke("store_linked_file", { id: saved.fileId }, workspaceId))) return undefined;
    const key =
      section === "source"
        ? JSON.stringify(["source", workspaceId, null, saved.sourceId])
        : contentKey(section, workspaceId, projectId, section === "record" ? saved.recordId : section === "note" ? saved.noteId : section === "canvas" ? saved.canvasId : section === "file" ? saved.fileId : null);
    if ([...views.values()].some((v) => v.contentKey === key)) return undefined;
    const view: OwnedView = {
      id: randomUUID(),
      kind: "home",
      title: (record?.title ?? saved.title ?? "Untitled").slice(0, 200),
      workspaceId,
      lastUsed: Date.now(),
      contentKey: key,
      content: { section, workspaceId, projectId, record, noteId: saved.noteId, sourceId: saved.sourceId, canvasId: saved.canvasId, fileId: saved.fileId },
    };
    views.set(view.id, view);
    return view;
  } catch {
    return undefined;
  }
}
async function restoredLayout(saved: SavedLayout): Promise<PaneLayout | undefined> {
  if ("view" in saved) {
    const view = await restoredView(saved.view);
    return view && { view: view.id };
  }
  const [a, b] = await Promise.all([restoredLayout(saved.a), restoredLayout(saved.b)]);
  return a && b ? { split: saved.split, ratio: Math.min(0.9, Math.max(0.1, saved.ratio)), a, b } : (a ?? b);
}
/** Adds a saved arrangement's tabs to `w`, skipping what can no longer be opened. */
async function restoreTabs(w: ShellWindow, saved: SavedTabs) {
  const restored = await Promise.all(saved.tabs.map((t) => restoredLayout(t.layout)));
  let active: string | undefined;
  restored.forEach((layout, index) => {
    if (!layout || w.closed) return;
    const ids = layoutViews(layout);
    const tab = tabWithLayout({ id: randomUUID(), activeViewId: ids[saved.tabs[index].active] }, layout);
    w.state.tabs.push(tab);
    if (index === saved.active || !active) active = tab.id;
  });
  if (active) w.state.activeTabId = active;
}
/** Moves a tab, with its live views, to another window (a new one by default). */
function moveTab(from: ShellWindow, tabId: string, to?: ShellWindow, at?: { x: number; y: number }) {
  const tab = from.state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (!to && from.state.tabs.length === 1 && liveShells().length === 1) return;
  const remaining = from.state.tabs.filter((t) => t.id !== tabId);
  const index = from.state.tabs.findIndex((t) => t.id === tabId);
  from.state = {
    tabs: remaining,
    activeTabId:
      from.state.activeTabId === tabId ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null) : from.state.activeTabId,
  };
  if (to) {
    to.state = { tabs: [...to.state.tabs, tab], activeTabId: tab.id };
    layout(to);
    to.window.focus();
  } else {
    const opened = createShell({ tabs: [tab], workspaceId: from.workspaceId });
    if (at) opened.window.setPosition(Math.round(at.x), Math.round(at.y));
  }
  if (!from.state.tabs.length) from.window.close();
  else layout(from);
}
/** A source's page, opened on its own or (with `read`) beside its PDF in one split tab. */
/** Passages sent from a PDF selection to a source's note, until its page takes them. */
const pendingAppends = new Map<string, { text: string; page: number; color?: string }[]>();
async function openSourcePage(
  w: ShellWindow,
  p: { workspaceId: string; sourceId: string; title?: string; read?: boolean; pdf?: any },
) {
  const key = JSON.stringify(["source", p.workspaceId, null, p.sourceId]);
  let page = [...views.values()].find((v) => v.contentKey === key);
  if (!page) {
    page = {
      id: randomUUID(),
      kind: "home",
      title: String(p.title || "Untitled").slice(0, 200),
      workspaceId: p.workspaceId,
      lastUsed: Date.now(),
      contentKey: key,
      content: { section: "source", workspaceId: p.workspaceId, sourceId: p.sourceId },
    };
    views.set(page.id, page);
  }
  if (!p.read || !p.pdf?.documentHash) {
    if (shellOfView(page.id)) focus(page.id);
    else add(page, w);
    return;
  }
  await sourceOpen({ ...p.pdf, workspaceId: p.workspaceId }, undefined, undefined, w);
  const pdfId = `pdf:${p.workspaceId}:${p.pdf.documentHash}`;
  const host = shellOfView(pdfId) ?? w;
  const pdfTab = host.state.tabs.find((t) => t.viewIds.includes(pdfId));
  if (!pdfTab || pdfTab.viewIds.includes(page.id)) {
    focus(pdfId);
    return;
  }
  // The page leaves wherever it was and joins the reader: reader left, page right.
  const owner = shellOfView(page.id);
  if (owner) {
    owner.state = closeWorkspaceView(owner.state, page.id);
    if (owner !== host) layout(owner);
  }
  const tab = host.state.tabs.find((t) => t.viewIds.includes(pdfId))!;
  if (tab.viewIds.length === 1) {
    host.state = {
      tabs: host.state.tabs.map((t) =>
        t.id === tab.id
          ? tabWithLayout({ id: t.id, activeViewId: pdfId }, { split: "row", ratio: 0.6, a: { view: pdfId }, b: { view: page!.id } })
          : t,
      ),
      activeTabId: tab.id,
    };
    layout(host);
  } else add(page, host);
}
function windowLabel(w: ShellWindow) {
  const name = knownWorkspaces.find((k) => k.id === w.workspaceId)?.name ?? "Key";
  const titles = w.state.tabs.map((t) => views.get(t.activeViewId)?.title ?? "Key");
  return `${name}: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? "…" : ""}`;
}
/** Runs a pane or tab command on the focused window's active tab. */
function onActiveTab(run: (w: ShellWindow, tabId: string, viewId: string) => void) {
  return () => {
    const w = focusedShell();
    const tab = w && activeWorkspaceTab(w.state);
    if (tab) run(w, tab.id, tab.activeViewId);
  };
}
function selectTab(index: number) {
  const w = focusedShell();
  const tab = index < 0 ? w?.state.tabs.at(-1) : w?.state.tabs[index];
  if (!w || !tab) return;
  w.state = activateWorkspaceTab(w.state, tab.id);
  layout(w);
}
function stepTab(delta: number) {
  const w = focusedShell();
  if (!w?.state.tabs.length) return;
  const at = w.state.tabs.findIndex((t) => t.id === w.state.activeTabId);
  selectTab((at + delta + w.state.tabs.length) % w.state.tabs.length);
}
/** The base menu, or the focused Office editor's own menu while one has focus. */
function refreshMenu() {
  const w = focusedShell();
  const active = w && views.get(activeWorkspaceTab(w.state)?.activeViewId ?? "");
  if (active?.view && active.kind !== "pdf" && active.kind !== "home") activateOfficeView(active.kind, active.view);
  else baseMenu();
}
function baseMenu() {
  const recent = [
    ...windowState.recent.map((id) => knownWorkspaces.find((k) => k.id === id)).filter((k): k is WorkspaceInfo => !!k),
    ...knownWorkspaces.filter((k) => !windowState.recent.includes(k.id)),
  ];
  const current = focusedShell()?.workspaceId;
  const workspaceItems = (newWindow: boolean): MenuItemConstructorOptions[] =>
    recent.length
      ? recent.map((k) => ({
          label: k.name,
          type: newWindow ? ("normal" as const) : ("radio" as const),
          checked: !newWindow && k.id === current,
          click: () => {
            const w = focusedShell();
            if (w) void switchWorkspace(w, k.id, newWindow).catch((e) => emit("operation-error", String(e)));
          },
        }))
      : [{ label: "No workspaces", enabled: false }];
  const pane = (label: string, accelerator: string | undefined, run: (w: ShellWindow, tabId: string, viewId: string) => void): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: onActiveTab(run),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Key",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => emitTo(focusedShell(), "open-settings") },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => home() },
          { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => void createShell() },
          { type: "separator" },
          { label: "Switch Workspace…", accelerator: "CmdOrCtrl+Shift+O", click: () => emitTo(focusedShell(), "open-workspace-switcher") },
          { label: "Switch to Workspace", submenu: workspaceItems(false) },
          { label: "Open Workspace in New Window", submenu: workspaceItems(true) },
          { type: "separator" },
          {
            label: "Open…",
            accelerator: "CmdOrCtrl+O",
            click: () => void importSources(),
          },
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            click: () => {
              const w = focusedShell();
              const id = activeWorkspaceTab(w.state)?.activeViewId;
              if (views.get(id ?? "")?.content?.section === "record") emitTo(w, "save-content", id);
            },
          },
          { type: "separator" },
          {
            label: "Move Tab to New Window",
            click: () => {
              const w = focusedShell();
              if (w.state.activeTabId) moveTab(w, w.state.activeTabId);
            },
          },
          { type: "separator" },
          // Like a terminal's split panes: Cmd-W closes the focused pane, then the tab.
          pane("Close", "CmdOrCtrl+W", (w, _tab, viewId) => void closePane(w, viewId)),
          pane("Close Tab", "CmdOrCtrl+Alt+W", (w, tabId) => void closeTab(w, tabId)),
          { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => focusedShell()?.window.close() },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          pane("Split Right", "CmdOrCtrl+\\", (w) => splitPane(w, "right")),
          pane("Split Down", "CmdOrCtrl+Shift+\\", (w) => splitPane(w, "bottom")),
          {
            label: "Focus Pane",
            submenu: (
              [
                ["Left", "Left", "left"],
                ["Right", "Right", "right"],
                ["Above", "Up", "top"],
                ["Below", "Down", "bottom"],
              ] as const
            ).map(([label, key, edge]) => pane(label, `CmdOrCtrl+Alt+${key}`, (w) => focusPane(w, edge))),
          },
          pane("Move Pane to New Tab", undefined, (w, tabId, viewId) => {
            const index = w.state.tabs.findIndex((t) => t.id === tabId);
            w.state = applyWorkspaceViewDrop(w.state, { kind: "detach", viewId, index: index + 1 });
            layout(w);
          }),
          pane("Swap Panes", undefined, (w, tabId) => {
            w.state = swapWorkspaceSplit(w.state, tabId);
            layout(w);
          }),
          pane("Separate All Panes", undefined, (w, tabId) => {
            w.state = separateWorkspaceTab(w.state, tabId);
            layout(w);
          }),
          pane("Reset Pane Sizes", undefined, (w, tabId) => {
            w.state = resetWorkspaceSplits(w.state, tabId);
            layout(w);
          }),
          { type: "separator" },
          pane("Back", "CmdOrCtrl+[", (w, _tab, viewId) => stepHistory(w, viewId, -1)),
          pane("Forward", "CmdOrCtrl+]", (w, _tab, viewId) => stepHistory(w, viewId, 1)),
          { type: "separator" },
          { label: "Show Previous Tab", accelerator: "CmdOrCtrl+Shift+[", click: () => stepTab(-1) },
          { label: "Show Next Tab", accelerator: "CmdOrCtrl+Shift+]", click: () => stepTab(1) },
          {
            label: "Go to Tab",
            submenu: [
              ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => selectTab(n - 1) })),
              { label: "Last Tab", accelerator: "CmdOrCtrl+9", click: () => selectTab(-1) },
            ],
          },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Go",
        submenu: [
          { label: "Open Quickly…", accelerator: "CmdOrCtrl+P", click: () => emitTo(focusedShell(), "command", "quick-open") },
          { label: "Commands…", accelerator: "CmdOrCtrl+K", click: () => emitTo(focusedShell(), "command", "palette") },
          { type: "separator" },
          { label: "Copy Link", accelerator: "CmdOrCtrl+L", click: () => emitTo(focusedShell(), "command", "copy-link") },
          { label: "Copy Citation", accelerator: "CmdOrCtrl+Shift+C", click: () => emitTo(focusedShell(), "command", "copy-citation") },
          { label: "Send To…", accelerator: "CmdOrCtrl+Shift+S", click: () => emitTo(focusedShell(), "command", "send-to") },
          { type: "separator" },
          { label: "Show Inspector", accelerator: "CmdOrCtrl+Shift+I", click: () => emitTo(focusedShell(), "toggle-inspector") },
          { label: "All Highlights", accelerator: "CmdOrCtrl+Shift+H", click: () => emitTo(focusedShell(), "command", "highlights") },
          { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", click: () => void reopenClosed(focusedShell()) },
          { type: "separator" },
          { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: () => emitTo(focusedShell(), "command", "shortcuts") },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}
app.setName("Key");
registerMediaScheme();
if (process.env.KEY_USER_DATA)
  app.setPath("userData", process.env.KEY_USER_DATA);
app.on("second-instance", () => {
  const w = focusedShell();
  if (w) {
    if (w.window.isMinimized()) w.window.restore();
    w.window.show();
    w.window.focus();
  }
});
app.on("before-quit", () => {
  quitRequested = true;
  // Before any window starts closing its tabs.
  freezeWindows();
});
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(async () => {
      setUiLang(normalizeLang(app.getLocale()));
      const root = resolve(app.getAppPath(), "../../../..");
      workspaceParent =
        process.env.KEY_WORKSPACE_PARENT ?? join(app.getPath("documents"), "Key");
      registry = new Registry({
        registryDir: join(app.getPath("userData"), "workspaces"),
        defaultWorkspaceParent: workspaceParent,
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
      serveNoteMedia(registry);
      const linkedFolders = new LinkedFolders((c, a, w) => registry.invoke(c, a, w), () => liveShells().map((w) => w.workspaceId), (v) => emit("linked-folders-changed", v));
      routeEmbeddedMedia();
      agentFill = new AgentFill(
        registry,
        join(app.getPath("userData"), "ai-settings.json"),
      );
      appSettings = new AppSettingsStore(join(app.getPath("userData"), "app-settings.json"));
      await appSettings.load();
      // The bundled layout model, for packaged builds (development finds it in the crate).
      if (app.isPackaged) process.env.KEY_LAYOUT_MODEL ??= join(process.resourcesPath, "models/layout/model_fp16.onnx");
      windowStore = new WindowStateStore(join(app.getPath("userData"), "window-state.json"));
      windowState = await windowStore.load();
      await refreshWorkspaces();
      // Windows reopen where they were, on workspaces that still exist.
      const restoring = process.env.KEY_NO_WINDOW_RESTORE
        ? []
        : windowState.windows.filter((saved) => knownWorkspaces.some((k) => k.id === saved.workspaceId));
      const first = createShell({ load: false, workspaceId: knownWorkspaces[0]?.id, saved: restoring[0] });
      configureOfficeEditors(first.window, {
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
              {
                binary: bytes,
              },
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
        closeActive: () => {
          const w = focusedShell();
          if (w.state.activeTabId) void closeTab(w, w.state.activeTabId);
        },
        listTabs: () =>
          [...views.values()].map((v) => ({
            id: v.id,
            title: v.title,
            kind: v.kind,
            active: v.id === activeWorkspaceTab(focusedShell().state)?.activeViewId,
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
            const w = shellOfView(v.id);
            if (w) tabsChanged(w);
          }
        },
        titleChanged: (wc, title) => {
          const v = [...views.values()].find(
            (v) => v.view?.webContents.id === wc,
          );
          if (v) {
            v.title = title;
            const w = shellOfView(v.id);
            if (w) tabsChanged(w);
          }
        },
        installBaseMenu: baseMenu,
      });
      const bound = (sender: number) =>
        [...views.values()].find((v) => v.view?.webContents.id === sender);
      const shell = (sender: number) => {
        const w = shellBySender(sender);
        if (!w) throw Error("Only the workspace shell can perform this operation");
        return w;
      };
      ipcMain.handle(
        "key:invoke",
        async (event, command, args, workspaceId, options) => {
          const record = bound(event.sender.id);
          const from = record ? shellOfView(record.id) : shellBySender(event.sender.id);
          if (!record && !from) throw Error("Unknown view");
          const targetWorkspace = record?.workspaceId ?? workspaceId;
          if (command === "workspace_set_appearance") {
            shell(event.sender.id);
            return registry.setAppearance(workspaceId, args.icon, args.color);
          }
          if (command === "agent_fill_status") return agentFill.status();
          if (command === "agent_fill_configure")
            return agentFill.configure(args);
          if (command === "agent_tag_suggestions")
            return agentFill.suggestTags(
              args.tags,
              args.instruction ??
                "Merge synonyms and spelling variants without losing meaningful distinctions.",
            );
          if (command === "library_download_pdf") {
            if (record) throw Error("Download requires the library view");
            const info = await downloadPdf(registry, targetWorkspace, args.url, args.sourceId);
            emit("library-changed");
            return info;
          }
          if (command === "library_relink") {
            if (record) throw Error("Relink requires the library view");
            const selected = await dialog.showOpenDialog((from ?? focusedShell()).window, {
              title: "Relink original PDF — content must match",
              properties: ["openFile"],
              filters: [{ name: "PDF", extensions: ["pdf"] }],
            });
            if (selected.canceled) return { canceled: true };
            const result = await registry.invoke(
              "library_import_file",
              { path: selected.filePaths[0], expectedHash: args.hash },
              targetWorkspace,
            );
            emit("library-changed");
            return result;
          }
          if (linkedFolders.handles(command)) return linkedFolders.handle(command, args, targetWorkspace, (from ?? focusedShell()).window);
          if (command === "agent_fill_propose")
            return agentFill.propose(targetWorkspace, args);
          if (command === "agent_fill_apply")
            return agentFill.apply(targetWorkspace, args.ids);
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
            void operation
              .finally(() => calls.delete(operation))
              .catch(() => {});
          }
          const result = await operation;
          if (
            [
              "workspace_save_attribute",
              "workspace_delete_attribute",
              "workspace_rename_attribute",
            ].includes(command)
          )
            emit("property-definitions-changed", {
              workspaceId: targetWorkspace,
              name: args?.name,
              newName:
                command === "workspace_rename_attribute"
                  ? args?.newName
                  : undefined,
            });
          if (
            [
              "workspace_save_record",
              "workspace_save_entry",
              "workspace_set_project_membership",
            ].includes(command)
          )
            emit("library-changed");
          // Every view showing a note or a PDF's highlights stays in step with edits made elsewhere.
          if (command === "store_note_save" || command === "store_note_delete")
            emit("note-changed", { workspaceId: targetWorkspace, noteId: (result as any)?.id ?? args?.id, sourceId: (result as any)?.sourceId ?? args?.sourceId });
          // Backlinks are rewritten by these saves, and titles they show change with renames.
          if (["store_note_save", "store_note_delete", "store_canvas_save", "store_canvas_delete", "store_update", "store_delete", "library_apply_annotations", "library_save_annotations"].includes(command))
            emit("links-changed", { workspaceId: targetWorkspace, command });
          if (["library_apply_annotations", "library_save_annotations", "library_import_annotations"].includes(command))
            emit("annotations-changed", { workspaceId: targetWorkspace });
          return result;
        },
      );
      ipcMain.handle("key:app-settings", async (event) => {
        shell(event.sender.id);
        const settings = appSettings.get();
        // Automated checks run on fresh profiles; onboarding would cover what they test.
        if (process.env.KEY_SKIP_ONBOARDING) settings.onboarded = true;
        return { settings, info: await appInfo(workspaceParent) };
      });
      ipcMain.handle("key:set-app-settings", async (event, patch) => {
        shell(event.sender.id);
        const before = appSettings.get();
        const next = await appSettings.update(patch ?? {});
        if (!before.zoteroSync && next.zoteroSync) void syncZotero(true);
        // Running library hosts pick up the layout setting at once.
        if (before.layoutModel !== next.layoutModel)
          for (const workspace of await registry.list())
            void registry.invoke("store_analysis_options", { layoutModel: next.layoutModel }, workspace.id).catch(() => {});
        return next;
      });
      ipcMain.handle("key:workspaces", async (event) => {
        shell(event.sender.id);
        // Kept current for window titles and the File menu (onboarding and imports add workspaces).
        const list = await registry.list();
        if (JSON.stringify(list) !== JSON.stringify(knownWorkspaces)) void refreshWorkspaces();
        return list;
      });
      ipcMain.handle("key:add-workspace", async (event) => {
        const w = shell(event.sender.id);
        const result = await dialog.showOpenDialog(w.window, {
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled) return null;
        const added = await registry.add(result.filePaths[0], basename(result.filePaths[0]));
        await refreshWorkspaces();
        return added;
      });
      ipcMain.handle("key:tabs", (event) => snapshot(shell(event.sender.id)));
      ipcMain.handle("key:reader-back", (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf") throw Error("Not a PDF reader");
        if (v.returnViewId && views.has(v.returnViewId)) {
          focus(v.returnViewId);
          return;
        }
        const w = shellOfView(v.id) ?? focusedShell();
        const tab = w.state.tabs.find((t) =>
          t.viewIds.some((id) => views.get(id)?.content?.section === "sources"),
        );
        if (tab) {
          w.state = activateWorkspaceTab(w.state, tab.id);
          layout(w);
        } else home(w);
      });
      ipcMain.handle("key:add-files", async (event, workspaceId, collectionId) => {
        const w = shell(event.sender.id);
        const result = await dialog.showOpenDialog(w.window, {
          title: "Add sources",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "Sources",
              extensions: ["pdf", "html", "htm", "txt", "md", "mp4", "mov", "m4v", "webm", "mp3", "m4a", "wav", "aac", "flac", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"],
            },
            { name: "All files", extensions: ["*"] },
          ],
        });
        if (result.canceled) return [];
        const created = await registry.invoke(
          "store_import_files",
          { paths: result.filePaths, collectionId: collectionId ?? null },
          workspaceId,
        );
        emit("library-changed");
        return created;
      });
      ipcMain.handle("key:import-paths", async (event, workspaceId, paths, collectionId) => {
        shell(event.sender.id);
        const created = await registry.invoke(
          "store_import_files",
          { paths, collectionId: collectionId ?? null },
          workspaceId,
        );
        emit("library-changed");
        return created;
      });
      ipcMain.handle("key:open-path", async (event, path) => {
        shell(event.sender.id);
        const error = await systemShell.openPath(String(path));
        if (error) throw Error(error);
      });
      // Quick Look thumbnails for the library's grid; small, so they come back as data URLs.
      ipcMain.handle("key:thumbnail", async (event, path, size) => {
        shell(event.sender.id);
        const edge = Math.max(32, Math.min(800, Number(size) || 320));
        const image = await nativeImage.createThumbnailFromPath(String(path), { width: edge, height: edge });
        return image.isEmpty() ? null : image.toDataURL();
      });
      ipcMain.handle("key:reveal-path", (event, path) => {
        shell(event.sender.id);
        systemShell.showItemInFolder(String(path));
      });
      ipcMain.handle("key:import-zotero", async (event, options) => {
        shell(event.sender.id);
        return importZotero(options);
      });
      ipcMain.handle("key:zotero-workspace", (event) => {
        shell(event.sender.id);
        return zoteroWorkspace();
      });
      ipcMain.handle("key:sync-zotero", async (event) => {
        shell(event.sender.id);
        await syncZotero(true);
      });
      setInterval(() => void syncZotero(), 30_000);
      ipcMain.handle("key:open-sources", (event, id) => {
        return importSources(id, shell(event.sender.id));
      });
      ipcMain.handle("key:open-source", (event, source, hit, results) => {
        return sourceOpen(source, hit, results, shell(event.sender.id));
      });
      // The search session a reader is showing a result of, if any.
      const sessionOf = (viewId: string) =>
        [...searchPreviews.values()].find((s) => s.previewViewId === viewId && !s.dismissed);
      ipcMain.handle("key:reader-result", async (event, direction) => {
        const v = bound(event.sender.id);
        const session = v && v.sharedSearchNavigation ? sessionOf(v.id) : undefined;
        if (session && [-1, 1].includes(direction)) {
          if (!session.busy) await showSearchPreview(session, session.index + direction);
          return;
        }
        if (
          v?.kind !== "pdf" ||
          !v.searchResults ||
          ![-1, 1].includes(direction)
        )
          throw Error("Invalid search navigation");
        const index = (v.searchIndex ?? -1) + direction;
        const hit = v.searchResults[index];
        if (!hit) return;
        return sourceOpen(hit, hit, v.searchResults, shellOfView(v.id));
      });
      // The reader's Notes button: show or hide the source's page beside the PDF.
      ipcMain.handle("key:reader-notes", async (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        const w = shellOfView(v.id) ?? focusedShell();
        const tab = w.state.tabs.find((t) => t.viewIds.includes(v.id));
        const besides = tab?.viewIds.find((id) => id !== v.id);
        if (tab && besides && views.get(besides)?.content?.section === "source") {
          w.state = separateWorkspaceTab(w.state, tab.id);
          w.state = activateWorkspaceTab(w.state, w.state.tabs.find((t) => t.viewIds.includes(v.id))!.id);
          layout(w);
          return false;
        }
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const page = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        const source = page.items[0];
        if (!source) throw Error("This PDF is not in the library");
        await openSourcePage(w, {
          workspaceId: v.workspaceId,
          sourceId: source.id,
          title: source.title,
          read: true,
          pdf: { documentHash: hash, documentId: hash, title: v.title, workspaceId: v.workspaceId },
        });
        return true;
      });
      // "Add to note" on a PDF selection: the passage waits here until the source's page
      // (opened beside the PDF when needed) takes it, appends it and scrolls to it.
      ipcMain.handle("key:reader-add-to-note", async (event, passage: { text: string; page: number; color?: string }) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        if (!String(passage?.text ?? "").trim()) return;
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const found = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        const source = found.items[0];
        if (!source) throw Error("This PDF is not in the library");
        const queued = pendingAppends.get(source.id) ?? [];
        queued.push({ text: String(passage.text), page: Number(passage.page) || 0, color: passage.color });
        pendingAppends.set(source.id, queued);
        const w = shellOfView(v.id) ?? focusedShell();
        await openSourcePage(w, {
          workspaceId: v.workspaceId,
          sourceId: source.id,
          title: source.title,
          read: true,
          pdf: { documentHash: hash, documentId: hash, title: v.title, workspaceId: v.workspaceId },
        });
        emit("note-append", { sourceId: source.id });
      });
      ipcMain.handle("key:capture-save", async (event, text: unknown) => {
        if (!captureWindow || event.sender !== captureWindow.webContents) throw Error("Not the capture window");
        await saveCapture(String(text ?? ""));
        captureWindow.close();
      });
      globalShortcut.register("Control+Alt+Space", quickCapture);
      app.on("will-quit", () => globalShortcut.unregisterAll());
      // ⌥-dragging a source out of the library: the files themselves, as Finder drags them.
      ipcMain.on("key:start-file-drag", (event, paths: unknown) => {
        const files = (Array.isArray(paths) ? paths : []).map(String).filter((path) => existsSync(path));
        if (!files.length) return;
        void app
          .getFileIcon(files[0], { size: "normal" })
          .then((icon) => event.sender.startDrag({ file: files[0], files, icon }))
          .catch(() => {});
      });
      // "Send to…" on a PDF highlight: the window it is in asks where to put it.
      ipcMain.handle("key:reader-send-to", async (event, highlight: { annotationId: string; text: string; page: number; color?: string }) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const found = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        const source = found.items[0];
        if (!source) throw Error("This PDF is not in the library");
        const w = shellOfView(v.id) ?? focusedShell();
        w.window.webContents.focus();
        emitTo(w, "send-items", [
          { kind: "source", id: source.id, anchor: `highlight:${String(highlight.annotationId)}`, title: String(highlight.text ?? "").trim() || "Highlight", detail: source.title, color: highlight.color },
        ]);
      });
      // The References panel: how this PDF was analysed, its references and what they
      // link to; Re-run analyses it again; a linked reference opens beside the reader.
      const readerSource = async (sender: number) => {
        const v = bound(sender);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const found = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        return { v, source: found.items[0] as { id: string; title?: string } | undefined };
      };
      ipcMain.handle("key:reader-analysis", async (event) => {
        const { v, source } = await readerSource(event.sender.id);
        if (!source) return null;
        return registry.invoke("store_analysis", { id: source.id }, v.workspaceId);
      });
      ipcMain.handle("key:reader-reanalyze", async (event) => {
        const { v, source } = await readerSource(event.sender.id);
        if (!source) throw Error("This PDF is not in the library");
        await registry.invoke("store_reanalyze", { id: source.id }, v.workspaceId);
      });
      ipcMain.handle("key:reader-open-source", async (event, sourceId: string) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        await openSourcePage(shellOfView(v.id) ?? focusedShell(), { workspaceId: v.workspaceId, sourceId: String(sourceId) });
      });
      // × in the reader's result bar: end the search session but keep the document.
      ipcMain.handle("key:reader-dismiss", (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf") throw Error("Not a PDF reader");
        const session = sessionOf(v.id);
        if (session) dismissSearchPreview(session.sourceViewId);
        v.searchTarget = undefined;
      });
      ipcMain.handle("key:reader-ready", (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf") throw Error("Not a PDF reader");
        const tab = shellOfView(v.id)?.state.tabs.find((t) => t.viewIds.includes(v.id));
        const besides = tab?.viewIds.find((id) => id !== v.id);
        const focus = v.pendingFocus;
        v.pendingFocus = undefined;
        return {
          focus,
          notesOpen: !!besides && views.get(besides)?.content?.section === "source",
          source: v.source,
          viewState: v.viewState,
          searchTarget: v.searchTarget,
          searchNavigation: {
            query: sessionOf(v.id)?.query,
            shared: v.sharedSearchNavigation,
            index: v.searchIndex ?? -1,
            total: v.searchResults?.length ?? 0,
          },
        };
      });
      ipcMain.on("key:reader-state", (event, value) => {
        const v = bound(event.sender.id);
        if (v?.kind === "pdf") v.viewState = value;
      });
      ipcMain.handle("key:tab-action", async (event, action, p = {}) => {
        const w = shell(event.sender.id);
        switch (action) {
          case "global-overlay-open": {
            w.globalOverlay = String(p.id);
            w.overlayCaptureKey = "";
            const frames = await captureOverlayFrames(w);
            if (w.globalOverlay === p.id) {
              w.overlayCaptureKey = JSON.stringify((activeWorkspaceTab(w.state)?.viewIds || []).map((id) => [id, views.get(id)?.view?.getBounds()]));
              layout(w);
            }
            return { frames };
          }
          case "global-overlay-close": {
            if (w.globalOverlay === p.id) {
              w.globalOverlay = undefined;
              w.overlayCaptureKey = "";
              ++w.overlayCaptureSequence;
              layout(w);
            }
            return;
          }
          case "preview-result": {
            const source = views.get(p.sourceViewId);
            if (!source?.content || !p.hit?.id || !p.hit?.documentHash)
              throw Error("Invalid search preview");
            const hitWorkspace =
              p.hit.workspaceId ?? p.source?.workspaceId ?? source.workspaceId;
            if (!hitWorkspace) throw Error("Choose a workspace");
            const all = (Array.isArray(p.results) ? p.results : []).map(
              (h: any) => ({
                id: h.id,
                documentHash: h.documentHash,
                documentTitle: h.documentTitle,
                workspaceId: h.workspaceId ?? hitWorkspace,
                page: h.page,
              }),
            );
            const selected = all.findIndex(
              (h: SearchResultRef) =>
                h.id === p.hit.id && h.workspaceId === hitWorkspace,
            );
            const start = selected >= 1000 ? selected - 500 : 0;
            const hits: SearchResultRef[] = all.slice(start, start + 1000);
            let index = hits.findIndex(
              (h) => h.id === p.hit.id && h.workspaceId === hitWorkspace,
            );
            if (index < 0) {
              hits.unshift({ ...p.hit, workspaceId: hitWorkspace });
              index = 0;
            }
            const previous = searchPreviews.get(source.id);
            if (previous) ++previous.sequence;
            const session: SearchPreviewSession = {
              sourceViewId: source.id,
              previewViewId: previous?.previewViewId,
              hits,
              index,
              query: String(p.query || ""),
              busy: false,
              sequence: 0,
              dismissed: false,
            };
            searchPreviews.set(source.id, session);
            await showSearchPreview(session, index);
            return snapshot(w);
          }
          case "preview-step": {
            const session = activeSearchPreview(w);
            if (session && !session.busy && [-1, 1].includes(p.direction))
              await showSearchPreview(session, session.index + p.direction);
            return snapshot(w);
          }
          case "preview-dismiss":
            dismissSearchPreview(
              p.sourceViewId ?? activeSearchPreview(w)?.sourceViewId,
            );
            return snapshot(w);
          case "preview-focus-list": {
            const session = activeSearchPreview(w);
            if (session) focus(session.sourceViewId);
            return snapshot(w);
          }
          case "new":
            home(w);
            break;
          case "quick-capture":
            quickCapture();
            return snapshot(w);
          case "open-home": {
            const existing =
              w.state.tabs.flatMap((t) => t.viewIds).find((id) => views.get(id)?.content?.section === "home") ??
              [...views.values()].find((v) => v.content?.section === "home")?.id;
            if (existing) focus(existing); else home(w);
            break;
          }
          case "open-content":
            await withPlacement(p, () => openContent(w, p));
            break;
          case "history":
            stepHistory(w, String(p.viewId ?? activeWorkspaceTab(w.state)?.activeViewId ?? ""), Number(p.step) < 0 ? -1 : 1);
            return snapshot(w);
          // A note's tab follows its title as it is edited.
          case "content-title": {
            const view = views.get(p.viewId);
            if (!["note", "source", "canvas"].includes(view?.content?.section ?? "")) throw Error("Not a note, source or canvas page");
            view!.title = String(p.title || (view!.content!.section === "note" ? "Untitled note" : view!.content!.section === "canvas" ? "Untitled canvas" : "Untitled")).slice(0, 200);
            tabsChanged(w);
            return snapshot(w);
          }
          case "content-saved": {
            const view = views.get(p.viewId);
            if (view?.content?.section !== "record")
              throw Error("Not a record view");
            const saved = await registry.invoke<any>(
              "workspace_record",
              { id: p.recordId },
              view.workspaceId,
            );
            if (!saved) throw Error("Saved item is missing");
            view.content.record = saved;
            view.contentKey = JSON.stringify([
              "record",
              view.workspaceId,
              saved.id,
            ]);
            view.title = saved.title;
            view.dirty = false;
            tabsChanged(w);
            return snapshot(w);
          }
          case "content-state": {
            const record = views.get(p.viewId);
            if (record?.kind !== "home" || record.content?.section !== "record")
              return snapshot(w);
            const changed =
              record.title !== p.title || record.dirty !== Boolean(p.dirty);
            record.title = String(p.title || "Untitled");
            record.dirty = Boolean(p.dirty);
            if (p.recordId && record.content.record) {
              record.content.record.id = p.recordId;
              record.content.record.title = record.title;
            }
            if (p.recordId)
              record.contentKey = JSON.stringify([
                "record",
                record.workspaceId,
                p.recordId,
              ]);
            if (changed) tabsChanged(w);
            return snapshot(w);
          }
          case "open-url": {
            const url = new URL(p.url);
            if (!["https:", "http:", "mailto:"].includes(url.protocol))
              throw Error("Unsupported link");
            await systemShell.openExternal(url.toString());
            return snapshot(w);
          }
          case "sidebar-width":
            w.sidebarWidth = Number.isFinite(Number(p.width))
              ? Math.max(0, Math.min(360, Number(p.width)))
              : 240;
            placeViews(w);
            return snapshot(w);
          case "inspector-width":
            w.inspectorWidth = Math.max(0, Math.min(480, Number(p.width) || 0));
            placeViews(w);
            return snapshot(w);
          case "drop-view":
            w.state = applyWorkspaceViewDrop(w.state, p);
            layout(w);
            return snapshot(w);
          case "reorder":
            w.state = reorderWorkspaceTab(w.state, p.tabId, Number(p.index));
            tabsChanged(w);
            return snapshot(w);
          case "chrome-pressed":
            for (const record of views.values())
              record.view?.webContents.send("app:chrome-pressed");
            return snapshot(w);
          case "tab-menu":
            Menu.buildFromTemplate(
              w.state.tabs.map((tab) => ({
                label: tab.viewIds
                  .map((id) => views.get(id)?.title ?? "Key")
                  .join(" / "),
                type: "radio" as const,
                checked: tab.id === w.state.activeTabId,
                click: () => {
                  w.state = activateWorkspaceTab(w.state, tab.id);
                  layout(w);
                },
              })),
            ).popup({ window: w.window, x: Math.round(p.x), y: Math.round(p.y) });
            return snapshot(w);
          case "take-note-appends": {
            const queued = pendingAppends.get(String(p.sourceId)) ?? [];
            pendingAppends.delete(String(p.sourceId));
            return queued;
          }
          // "Show in PDF" on a highlight or quote: no search session, just go there.
          case "reader-focus": {
            const v = views.get(`pdf:${p.workspaceId}:${p.documentHash}`);
            if (v?.kind !== "pdf") throw Error("The PDF is not open");
            const target = { page: typeof p.page === "number" ? p.page : undefined, annotationId: p.annotationId ? String(p.annotationId) : undefined };
            v.pendingFocus = target;
            v.view?.webContents.send("reader-focus", target);
            return snapshot(w);
          }
          case "open-source-page":
            if (!p.workspaceId || !p.sourceId) throw Error("Choose a source");
            await withPlacement(p.read ? {} : p, () => openSourcePage(w, p));
            return snapshot(w);
          // Multiple windows: move a tab out to a new window or into another one.
          case "pop-out":
            moveTab(w, String(p.tabId ?? w.state.activeTabId));
            return snapshot(w);
          case "move-to-window": {
            const target = liveShells().find((s) => s.id === p.windowId);
            if (target && target !== w) moveTab(w, String(p.tabId), target);
            return snapshot(w);
          }
          case "tab-context-menu": {
            const tabId = String(p.tabId);
            const others = liveShells().filter((s) => s !== w);
            Menu.buildFromTemplate([
              { label: "Move to New Window", enabled: w.state.tabs.length > 1 || others.length > 0, click: () => moveTab(w, tabId) },
              ...(others.length
                ? [
                    {
                      label: "Move to Window",
                      submenu: others.map((s) => ({
                        label: windowLabel(s),
                        click: () => moveTab(w, tabId, s),
                      })),
                    },
                  ]
                : []),
              { type: "separator" as const },
              { label: "Close Tab", click: () => void closeTab(w, tabId) },
            ]).popup({ window: w.window, x: Math.round(p.x), y: Math.round(p.y) });
            return snapshot(w);
          }
          case "activate":
            w.state = activateWorkspaceTab(w.state, p.tabId);
            break;
          case "focus":
            focus(p.viewId);
            break;
          case "close":
            await closeTab(w, p.tabId);
            break;
          case "split-menu": {
            const sourceId = w.state.activeTabId;
            if ((activeWorkspaceTab(w.state)?.viewIds.length ?? MAX_PANES) >= MAX_PANES)
              return snapshot(w);
            Menu.buildFromTemplate(
              w.state.tabs
                .filter((t) => t.id !== sourceId && t.viewIds.length === 1)
                .map((t) => ({
                  label: views.get(t.activeViewId)?.title || "Tab",
                  click: () => {
                    w.state = splitWithTab(w.state, sourceId!, t.id);
                    layout(w);
                  },
                })),
            ).popup({ window: w.window });
            return snapshot(w);
          }
          case "split": {
            const target = w.state.tabs.find(
              (t) =>
                t.id !== w.state.activeTabId &&
                t.viewIds.length === 1 &&
                (p.viewId === activeWorkspaceTab(w.state)?.activeViewId ||
                  t.viewIds.includes(p.viewId)),
            );
            const edge = ["left", "right", "top", "bottom"].includes(p.edge) ? p.edge : "right";
            if (target) w.state = splitWithTab(w.state, w.state.activeTabId!, target.id, edge);
            break;
          }
          case "separate":
            w.state = separateWorkspaceTab(w.state, w.state.activeTabId!);
            break;
          case "swap":
            w.state = swapWorkspaceSplit(w.state, w.state.activeTabId!);
            break;
          case "resize-split":
            w.state = setWorkspaceSplitRatio(
              w.state,
              w.state.activeTabId!,
              Number(p.ratio),
              typeof p.path === "string" ? p.path : "",
            );
            break;
          case "reset-splits":
            w.state = resetWorkspaceSplits(w.state, w.state.activeTabId!);
            break;
          // Panes: a new Home pane beside the focused one, moving focus, closing one pane.
          case "split-pane":
            if (["left", "right", "top", "bottom"].includes(p.edge)) splitPane(w, p.edge);
            break;
          case "focus-pane":
            if (["left", "right", "top", "bottom"].includes(p.direction)) focusPane(w, p.direction);
            return snapshot(w);
          case "close-pane":
            await closePane(w, String(p.viewId ?? activeWorkspaceTab(w.state)?.activeViewId));
            return snapshot(w);
          // Workspaces: in place, or (newWindow) beside this window.
          case "switch-workspace":
            await switchWorkspace(w, String(p.workspaceId), Boolean(p.newWindow));
            break;
          // A pane or tab dragged out of the window opens in a new window near the pointer.
          case "tear-off": {
            const tab = w.state.tabs.find((t) => t.viewIds.includes(String(p.viewId)) || t.id === p.tabId);
            if (!tab) break;
            let tabId = tab.id;
            if (p.viewId && tab.viewIds.length > 1) {
              w.state = applyWorkspaceViewDrop(w.state, { kind: "detach", viewId: String(p.viewId), index: w.state.tabs.length });
              tabId = w.state.tabs.find((t) => t.viewIds.length === 1 && t.viewIds[0] === p.viewId)!.id;
            }
            if (w.state.tabs.length === 1 && liveShells().length === 1 && tab.viewIds.length === 1) break;
            const at = screen.getCursorScreenPoint();
            moveTab(w, tabId, undefined, { x: at.x - 120, y: at.y - 20 });
            return snapshot(w);
          }
          case "create-office":
            if (
              ["docs", "sheets", "slides", "markdown", "html"].includes(p.kind)
            ) {
              if (!p.workspaceId) throw Error("Choose a workspace");
              office(p.kind, undefined, p.workspaceId, w);
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
              !openPath(item.properties.path, p.workspaceId, w)
            )
              throw Error("No supported file linked to this record");
            break;
          }
          case "link-folder": {
            const result = await dialog.showOpenDialog(w.window, {
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
        layout(w);
        return snapshot(w);
      });
      // Tabs exist before the page loads, so nothing opened early lands in front of them.
      if (restoring[0]) await restoreTabs(first, restoring[0].tabs);
      if (!first.state.tabs.length) home(first);
      await loadShell(first);
      layout(first);
      for (const saved of restoring.slice(1)) createShell({ saved });
      if (restoring.length > 1) first.window.focus();
    })
    .catch((error) => {
      console.error(error);
      dialog.showErrorBox("Key could not start", String(error));
      app.quit();
    });
app.on("window-all-closed", () => app.quit());
