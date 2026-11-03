import { Button, Input } from "@key/design-system";
import { Icon, type IconName } from "./icons";
import { ModelProgressPill, useModelProgress } from "./model-progress";
import Onboarding from "./Onboarding";
import { notesChanged } from "./NotePage";
import { markdownToPlainText } from "./note-editor";
import Settings, { type SettingsSection } from "./Settings";
import { bridge, type AppInfo, type AppSettings, type Note } from "./library-api";
import { GlobalDrawerHost, GlobalDialog } from "./GlobalDrawer";
import type { SearchPreviewState } from "./search-preview";
import { TabBar, type TabSummary, type TabsApi } from "./TabBar";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LibrarySource, type LibraryHit } from "./LibraryHome";
import "./shell.css";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import CollectionTree from "./CollectionTree";
import { sidebarClick } from "./sidebar-intent";
import { hasExternalDrop, hasItemDrag, importDrop, inboxCollection, readItemDrag, setItemDrag } from "./item-links";
import { describeCount, sendToCanvas, sendToNote, setShellContext, toast } from "./item-actions";
import { ItemLayer, itemAttrs, onShowInInspector, selectItems, useSelectedItems } from "./item-ui";
import Inspector from "./Inspector";
import CommandCenter from "./CommandCenter";
import type { DraggedItem } from "./note-editor";
import WorkspaceContent, { type ContentSpec } from "./WorkspaceContent";
import {
  MAX_PANES,
  PANE_HEADER,
  layoutPanes,
  paneBody,
  setWorkspaceSplitRatio,
  tabWithLayout,
  type PaneLayout,
  type SplitEdge,
  type WorkspaceViewDrop,
} from "../shared/tab-model";
import { TabKindIcon, type ContentDropTarget } from "./TabBar";
import LinkedFolders from "./LinkedFolders";
interface Workspace {
  id: string;
  name: string;
  root: string;
  icon?: string;
  color?: string;
}
interface Project {
  id: string;
  name: string;
  folder: string;
}
interface RecordItem {
  id: string;
  kind: string;
  documentHash?: string;
  title: string;
  body: string;
  properties: Record<string, unknown>;
  revision: number;
  workspaceId?: string;
}
interface TabState {
  searchPreview?: SearchPreviewState;
  /** The workspace this window shows; other windows' workspaces for the switcher. */
  workspaceId?: string;
  windowId?: string;
  windows?: { windowId: string; workspaceId: string }[];
  tabs: {
    id: string;
    layout?: PaneLayout;
    pinned?: boolean;
    title: string;
    views: {
      id: string;
      title: string;
      kind: string;
      workspaceId?: string;
      content?: ContentSpec;
      /** Titles of what this pane showed before (oldest first), and the next one forward. */
      back?: string[];
      forward?: string;
    }[];
  }[];
  activeTabId: string;
  activeViewId: string;
  splitRatio?: number;
}
const api = () =>
  (
    window as unknown as {
      key: {
        invoke: <T>(
          command: string,
          args?: Record<string, unknown>,
          workspaceId?: string,
        ) => Promise<T>;
        workspaces: () => Promise<Workspace[]>;
        addWorkspace: () => Promise<Workspace | null>;
        openSources: (workspaceId?: string) => Promise<void>;
        openSource: (
          source: LibrarySource,
          hit?: LibraryHit,
          results?: LibraryHit[],
        ) => Promise<void>;
        tabs: () => Promise<TabState>;
        tabAction: (
          action: string,
          payload?: Record<string, unknown>,
        ) => Promise<void>;
        on: (
          event: string,
          callback: (...args: unknown[]) => void,
        ) => () => void;
      };
    }
  ).key;
// The sidebar can be dragged between these widths; below the minimum its rows stop being readable.
const SIDEBAR_MIN = 180,
  SIDEBAR_MAX = 360,
  SIDEBAR_DEFAULT = 240;
const clampSidebar = (width: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)));

const emptyTabs: TabState = { tabs: [], activeTabId: "", activeViewId: "" };
// Native views start below the 40px tab bar; DOM panes use the same geometry.
const CHROME_TOP = 40;
/** A quarter of the pane, at most this many pixels, from an edge splits there. */
const EDGE_BAND = 80;
const DIVIDER_STEP = 0.025;
const INSPECTOR_WIDTH = 300;

/** The item a content pane shows, for the inspector when nothing is selected. */
function paneItem(content?: ContentSpec, title?: string): DraggedItem | undefined {
  if (!content) return undefined;
  const name = title ?? "Untitled";
  if (content.section === "note" && content.noteId) return { kind: "note", id: content.noteId, title: name };
  if (content.section === "canvas" && content.canvasId) return { kind: "canvas", id: content.canvasId, title: name };
  if (content.section === "source" && content.sourceId) return { kind: "source", id: content.sourceId, title: name };
  if (content.section === "record" && content.record?.id) return { kind: "record", id: content.record.id, title: name };
  if (content.section === "file" && content.fileId) return { kind: "file", id: content.fileId, title: name };
  return undefined;
}
/** Remounts a pane's content when a followed link changes what it shows. */
const contentIdentity = (content?: ContentSpec) =>
  content ? [content.section, content.noteId ?? content.canvasId ?? content.sourceId ?? content.record?.id ?? content.workspaceId ?? ""].join(":") : "";

const tabSummary = (state: TabState): TabSummary[] =>
  state.tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    kind: (tab.views[0]?.kind as TabSummary["kind"]) || "home",
    active: tab.id === state.activeTabId,
    closable: !tab.pinned,
    pinned: Boolean(tab.pinned),
    views: tab.views.map((view) => ({
      ...view,
      active: view.id === state.activeViewId,
    })),
  }));
const officeTabs: TabsApi = {
  list: () => api().tabs().then(tabSummary),
  onChanged: (callback) =>
    api().on("tabs-changed", (state) =>
      callback(tabSummary(state as TabState)),
    ),
  focusView: (viewId) => {
    void api().tabAction("focus", { viewId });
  },
  activate: (tabId) => api().tabAction("activate", { tabId }),
  close: (tabId) => api().tabAction("close", { tabId }),
  closeView: (viewId) => api().tabAction("close-pane", { viewId }),
  reorder: (tabId, index) => api().tabAction("reorder", { tabId, index }),
  showNewMenu: () => api().tabAction("new"),
  showMenu: (x, y) => api().tabAction("tab-menu", { x, y }),
  showTabMenu: (tabId, x, y) => api().tabAction("tab-context-menu", { tabId, x, y }),
  dropView: (drop) => api().tabAction("drop-view", drop),
  tearOff: (target) => api().tabAction("tear-off", target),
  notifyChromePressed: () => {
    void api().tabAction("chrome-pressed");
  },
};
export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [workspaceId, setWorkspaceId] = useState<string>();
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState<string>();
  const [records, setRecords] = useState<RecordItem[]>([]),
    [tabs, setTabs] = useState<TabState>(emptyTabs);
  const [section, setSection] = useState("sources"),
    [record, setRecord] = useState<RecordItem>();
  const [error, setError] = useState(""),
    [refreshKey, setRefreshKey] = useState(0);
  const splitFrame = useRef<number | null>(null);
  const splitPending = useRef<{ path: string; ratio: number }>({ path: "", ratio: 0.5 });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("key.sidebar.collapsed") === "true",
  );
  const sidebarSlot = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarCollapsed ? 0 : 240);
  // The open width the user dragged to, remembered; the slot animates between it and 0.
  const [sidebarSize, setSidebarSize] = useState(() =>
    clampSidebar(Number(localStorage.getItem("key.sidebar.width")) || SIDEBAR_DEFAULT),
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);
  useEffect(() => {
    localStorage.setItem("key.sidebar.width", String(sidebarSize));
  }, [sidebarSize]);
  useEffect(() => {
    localStorage.setItem("key.sidebar.collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    const node = sidebarSlot.current;
    if (!node) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.round(node.getBoundingClientRect().width);
        setSidebarWidth(width);
        void api().tabAction("sidebar-width", { width });
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  // The content area's size, which native views and DOM panes share.
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  // A divider being dragged: its split and the ratio shown until main confirms it.
  const [dragSplit, setDragSplit] = useState<{ path: string; ratio: number }>();
  const resizeSplit = (path: string, ratio: number) => {
    const next = { path, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
    setDragSplit(next);
    splitPending.current = next;
    if (splitFrame.current === null)
      splitFrame.current = requestAnimationFrame(() => {
        splitFrame.current = null;
        action("resize-split", splitPending.current);
      });
  };
  const [createMenu, setCreateMenu] = useState(false),
    [dialog, setDialog] = useState<"project" | "folder" | null>(null),
    [dialogValue, setDialogValue] = useState("");

  useEffect(() => {
    if (!createMenu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (
        event instanceof PointerEvent &&
        (event.target as Element).closest?.(".key-create-menu, [aria-label='Create item']")
      )
        return;
      setCreateMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [createMenu]);
  const invoke = useCallback(
    <T,>(command: string, args?: Record<string, unknown>, id?: string) =>
      api().invoke<T>(command, args, id),
    [],
  );
  const task = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    }
  };
  const action = (name: string, payload?: Record<string, unknown>) =>
    void task(() => api().tabAction(name, payload));
  // App preferences, Settings and the first-run welcome.
  const [prefs, setPrefs] = useState<{ settings: AppSettings; info: AppInfo }>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    void bridge()
      .appSettings()
      .then((loaded) => {
        setPrefs(loaded);
        if (!loaded.settings.onboarded) setWelcome(true);
      })
      .catch((e) => setError(String(e)));
    return api().on("open-settings", () => setSettingsSection("general"));
  }, []);
  const updatePrefs = (patch: Partial<AppSettings>) =>
    void bridge()
      .setAppSettings(patch)
      .then((settings) => setPrefs((p) => p && { ...p, settings }))
      .catch((e) => setError(String(e)));
  const refreshWorkspaces = () => void api().workspaces().then(setWorkspaces).catch(() => {});
  useEffect(() => {
    void task(async () => {
      setWorkspaces(await api().workspaces());
      setTabs(await api().tabs());
    });
    const a = api().on("tabs-changed", () => {
      void api()
        .tabs()
        .then(setTabs)
        .catch((e) => setError(String(e)));
    });
    const b = api().on("library-changed", () => {
      setRefreshKey((k) => k + 1);
      void api().workspaces().then(setWorkspaces).catch(() => {});
    });
    return () => {
      a();
      b();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setProjects([]);
    setRecords([]);
    if (!workspaceId) return;
    void Promise.all([
      invoke<Project[]>("workspace_projects", {}, workspaceId),
      invoke<RecordItem[]>(
        "workspace_records",
        { projectId: projectId || null, limit: 500, offset: 0 },
        workspaceId,
      ),
    ])
      .then(([p, r]) => {
        if (!cancelled) {
          setProjects(p);
          setRecords(r);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [invoke, workspaceId, projectId, refreshKey]);
  const chooseScope = (id?: string, project?: string) => {
    setWorkspaceId(id);
    setProjectId(project);
    action("open-content", {
      section: "sources",
      workspaceId: id,
      projectId: project,
    });
  };
  const selectRecord = (r: RecordItem) => {
    if (r.documentHash) {
      void task(() =>
        api().openSource({
          documentId: r.documentHash!,
          documentHash: r.documentHash!,
          title: r.title,
          status: "indexed",
          pageCount: 0,
          completed: 0,
          total: 0,
          workspaceId: r.workspaceId || workspaceId,
        }),
      );
      return;
    }
    if (r.properties?.path && r.properties?.editor) {
      action("open-office-record", {
        recordId: r.id,
        workspaceId: r.workspaceId || workspaceId,
      });
      return;
    }
    action("open-content", {
      section: "record",
      workspaceId: r.workspaceId || workspaceId,
      projectId,
      record: r,
    });
  };
  // Standalone notes (key-store), listed in the sidebar and opened as tabs.
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    if (!workspaceId) return setNotes([]);
    const load = () => void invoke<Note[]>("store_notes", {}, workspaceId).then(setNotes).catch(() => setNotes([]));
    load();
    window.addEventListener("key:notes-changed", load);
    return () => window.removeEventListener("key:notes-changed", load);
  }, [invoke, workspaceId, refreshKey]);
  const openNote = (note: Pick<Note, "id" | "title">) =>
    action("open-content", { section: "note", workspaceId, noteId: note.id, title: note.title });
  const createNote = () =>
    void task(async () => {
      setCreateMenu(false);
      if (!workspaceId) throw Error("Choose a workspace to create a note.");
      const note = await invoke<Note>("store_note_save", { id: null, sourceId: null, title: "", body: "" }, workspaceId);
      notesChanged();
      openNote(note);
    });
  // Canvases (key-store), listed under the notes and opened as tabs.
  const [canvases, setCanvases] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!workspaceId) return setCanvases([]);
    const load = () => void invoke<{ id: string; title: string }[]>("store_canvases", {}, workspaceId).then(setCanvases).catch(() => setCanvases([]));
    load();
    window.addEventListener("key:canvases-changed", load);
    return () => window.removeEventListener("key:canvases-changed", load);
  }, [invoke, workspaceId, refreshKey]);
  const openCanvas = (canvas: { id: string; title: string }) =>
    action("open-content", { section: "canvas", workspaceId, canvasId: canvas.id, title: canvas.title });
  const createCanvas = () =>
    void task(async () => {
      setCreateMenu(false);
      if (!workspaceId) throw Error("Choose a workspace to create a canvas.");
      const canvas = await invoke<{ id: string; title: string }>("store_canvas_save", { id: null, title: "", doc: { version: 1, nodes: [], edges: [] } }, workspaceId);
      window.dispatchEvent(new Event("key:canvases-changed"));
      openCanvas(canvas);
    });
  const createRecord = (kind: string) => {
    if (kind === "note") return createNote();
    if (kind === "canvas") return createCanvas();
    setCreateMenu(false);
    if (!workspaceId) {
      setError("Choose a workspace to create an item.");
      return;
    }
    action("open-content", {
      section: "record",
      workspaceId,
      projectId,
      record: {
        id: "",
        kind,
        title: "",
        body: "",
        properties: {},
        revision: 0,
      },
    });
  };
  // The model is shared by every workspace, so any host can report it.
  const model = useModelProgress(invoke, workspaceId || workspaces[0]?.id);
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId),
    selectedProject = projects.find((p) => p.id === projectId);
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId),
    activeView = activeTab?.views.find((v) => v.id === tabs.activeViewId);
  // The sidebar shows the window's workspace; the focused view only picks the project
  // and highlights its row (a view from another workspace changes neither).
  useEffect(() => {
    if (tabs.workspaceId) setWorkspaceId(tabs.workspaceId);
  }, [tabs.workspaceId]);
  useEffect(() => {
    const own = (activeView?.content?.workspaceId ?? activeView?.workspaceId) === tabs.workspaceId;
    if (activeView?.content) {
      setProjectId(own ? activeView.content.projectId : undefined);
      setSection(activeView.content.section);
      setRecord(activeView.content.record);
    } else if (activeView) {
      setProjectId(undefined);
      setRecord(undefined);
      setSection("");
    }
  }, [activeView?.id, activeView?.content?.record?.id, tabs.workspaceId]);
  // A sidebar canvas or note takes dropped items without being opened.
  const [dropOver, setDropOver] = useState<string>();
  const [inboxDrop, setInboxDrop] = useState(false);
  const dropTarget = (target: { kind: "canvas" | "note"; id: string; title: string }) => ({
    "data-drop-over": dropOver === `${target.kind}:${target.id}` || undefined,
    "data-drop-label": target.kind === "canvas" ? `Add to ${target.title}` : `Link in ${target.title} · ⌥ embed · ⌘ cite`,
    onDragOver: (e: React.DragEvent) => {
      if (!hasItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropOver(`${target.kind}:${target.id}`);
    },
    onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropOver(undefined),
    onDrop: (e: React.DragEvent) => {
      setDropOver(undefined);
      const items = readItemDrag(e.dataTransfer).filter((item) => !(item.kind === target.kind && item.id === target.id));
      if (!items.length || !workspaceId) return;
      e.preventDefault();
      const mode = e.altKey ? "embed" : e.metaKey || items.every((i) => i.anchor?.startsWith("highlight:")) ? "cite" : "link";
      void (target.kind === "canvas" ? sendToCanvas(invoke, workspaceId, target.id, items) : sendToNote(invoke, workspaceId, target.id, items, mode))
        .then((undo) => toast(`${target.kind === "canvas" ? "Added" : mode === "embed" ? "Embedded" : mode === "cite" ? "Cited" : "Linked"} ${describeCount(items)} ${target.kind === "canvas" ? "to" : "in"} ${target.title}`, undo))
        .catch((error) => toast(String(error)));
    },
  });
  // The shared item layer acts in this window's workspace and focused pane.
  useEffect(() => setShellContext({ invoke, workspaceId, viewId: tabs.activeViewId }), [invoke, workspaceId, tabs.activeViewId]);
  // A pane that gains focus is what's selected until something inside it is.
  useEffect(() => {
    const own = paneItem(activeView?.content, activeView?.title?.replace(/ •$/, ""));
    selectItems(own ? [own] : []);
  }, [activeView?.id, contentIdentity(activeView?.content)]);
  const selected = useSelectedItems();
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem("key.inspector.open") === "true");
  const inspectorWidth = inspectorOpen ? INSPECTOR_WIDTH : 0;
  useEffect(() => {
    localStorage.setItem("key.inspector.open", String(inspectorOpen));
    void api().tabAction("inspector-width", { width: inspectorWidth });
  }, [inspectorOpen, inspectorWidth]);
  useEffect(() => onShowInInspector(() => setInspectorOpen(true)), []);
  useEffect(() => api().on("toggle-inspector", () => setInspectorOpen((open) => !open)), []);
  const switchWorkspace = (id: string, newWindow = false) =>
    task(() => api().tabAction("switch-workspace", { workspaceId: id, newWindow }));
  const [switcherRequest, setSwitcherRequest] = useState(0);
  useEffect(() => api().on("open-workspace-switcher", () => setSwitcherRequest((n) => n + 1)), []);
  // Cmd-Option-arrows into a DOM pane: focus lands inside it.
  useEffect(
    () =>
      api().on("focus-pane", (id) => {
        const pane = document.querySelector<HTMLElement>(`[data-content-view="${id}"]`);
        const target =
          pane?.querySelector<HTMLElement>("input, textarea, [contenteditable='true'], button, [tabindex]:not([tabindex='-1'])") ?? pane;
        target?.focus({ preventScroll: true });
      }),
    [],
  );
  // The active tab's panes and dividers, in content-area pixels (right of the sidebar, below the tab bar).
  const shownLayout = (() => {
    const layout = activeTab?.layout;
    if (!layout || !dragSplit) return layout;
    const tab = tabWithLayout({ id: "drag" }, layout);
    return setWorkspaceSplitRatio({ tabs: [tab], activeTabId: tab.id }, tab.id, dragSplit.ratio, dragSplit.path).tabs[0].layout;
  })();
  const laidOut = shownLayout
    ? layoutPanes(shownLayout, {
        x: 0,
        y: 0,
        width: Math.max(0, viewport.width - sidebarWidth - inspectorWidth),
        height: Math.max(0, viewport.height - CHROME_TOP),
      })
    : { panes: [], dividers: [] };
  /** What releasing a dragged tab or pane at (x, y) over the content would do. */
  const contentDrop = (x: number, y: number, drag: { viewId: string; pane: boolean; header?: boolean }): ContentDropTarget | undefined => {
    const cx = x - sidebarWidth,
      cy = y - CHROME_TOP;
    const target = laidOut.panes.find((p) => cx >= p.x && cx < p.x + p.width && cy >= p.y && cy < p.y + p.height);
    if (!activeTab || !target || target.viewId === drag.viewId) return undefined;
    const distances: [SplitEdge, number, number][] = [
      ["left", cx - target.x, target.width],
      ["right", target.x + target.width - cx, target.width],
      ["top", cy - target.y, target.height],
      ["bottom", target.y + target.height - cy, target.height],
    ];
    const near = distances
      .map(([edge, distance, size]) => [edge, distance / Math.min(EDGE_BAND, size / 4)] as const)
      .filter(([, scaled]) => scaled <= 1)
      .sort((a, b) => a[1] - b[1])[0];
    const title = activeTab.views.find((v) => v.id === target.viewId)?.title ?? "this pane";
    const onScreen = { x: target.x + sidebarWidth, y: target.y + CHROME_TOP, width: target.width, height: target.height };
    if (near) {
      const edge = near[0];
      const half =
        edge === "left" ? { ...onScreen, width: onScreen.width / 2 }
        : edge === "right" ? { ...onScreen, x: onScreen.x + onScreen.width / 2, width: onScreen.width / 2 }
        : edge === "top" ? { ...onScreen, height: onScreen.height / 2 }
        : { ...onScreen, y: onScreen.y + onScreen.height / 2, height: onScreen.height / 2 };
      const drop: WorkspaceViewDrop = { kind: "split", viewId: drag.viewId, targetTabId: activeTab.id, targetViewId: target.viewId, edge };
      const where = { left: "left of", right: "right of", top: "above", bottom: "below" }[edge];
      return { drop, preview: half, label: `◫ Release to split ${where} ${title}` };
    }
    // The centre of a pane in a split swaps with it; a pane's own group falls back to separating,
    // except when the pane is dragged by its header, which stays in the content.
    if ((drag.pane && !drag.header) || activeTab.views.length < 2) return undefined;
    return { drop: { kind: "swap", viewId: drag.viewId, targetViewId: target.viewId }, preview: onScreen, label: `⇄ Release to swap with ${title}` };
  };
  // While a drag is over the content, native views are swapped for still frames so the
  // drop preview can be drawn over them.
  type Frame = { id: string; x: number; y: number; width: number; height: number; image: string };
  const [dragFrames, setDragFrames] = useState<Frame[]>([]);
  const dragOverlay = useRef<string | undefined>(undefined);
  // Main recaptures when what is shown changes mid-drag (the dragged-from tab comes back).
  useEffect(
    () =>
      api().on("global-overlay-frames", (result) => {
        const { id, frames } = result as { id: string; frames: Frame[] };
        if (id === dragOverlay.current) setDragFrames(frames);
      }),
    [],
  );
  const contentDragging = (dragging: boolean) => {
    if (dragging && !dragOverlay.current) {
      const id = `tab-drag-${crypto.randomUUID()}`;
      dragOverlay.current = id;
      void (api().tabAction("global-overlay-open", { id }) as unknown as Promise<{ frames?: Frame[] }>)
        .then((result) => {
          if (dragOverlay.current === id) setDragFrames(result?.frames ?? []);
        })
        .catch(() => {});
    } else if (!dragging && dragOverlay.current) {
      const id = dragOverlay.current;
      dragOverlay.current = undefined;
      setDragFrames([]);
      void api().tabAction("global-overlay-close", { id });
    }
  };
  // A pane of a split dragged by its header: onto another pane to split or swap, up into the
  // tab bar to become a tab of its own, or out of the window into a new one.
  const paneDragRef = useRef<{ pointerId: number; viewId: string; startX: number; startY: number; started: boolean; drop?: WorkspaceViewDrop; tearOff?: boolean }>(undefined);
  const [paneDrag, setPaneDrag] = useState<{ viewId: string; x: number; label: string; preview?: ContentDropTarget["preview"]; insertAt?: number }>();
  const movePaneDrag = (e: React.PointerEvent) => {
    const drag = paneDragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      drag.started = true;
      contentDragging(true);
    }
    const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
    drag.drop = undefined;
    drag.tearOff = outside;
    if (outside) return setPaneDrag({ viewId: drag.viewId, x: e.clientX, label: "↗ Release to open in a new window" });
    if (e.clientY < CHROME_TOP) {
      const rects = Array.from(document.querySelectorAll<HTMLElement>(".tab-strip .tab-item"), (el) => el.getBoundingClientRect());
      const index = rects.findIndex((r) => e.clientX < r.left + r.width / 2);
      const at = index < 0 ? rects.length : index;
      drag.drop = { kind: "detach", viewId: drag.viewId, index: at };
      const marker = at < rects.length ? rects[at].left : (rects.at(-1)?.right ?? 0);
      return setPaneDrag({ viewId: drag.viewId, x: e.clientX, label: "↑ Release to move into a tab of its own", insertAt: marker });
    }
    const target = contentDrop(e.clientX, e.clientY, { viewId: drag.viewId, pane: true, header: true });
    drag.drop = target?.drop;
    setPaneDrag({
      viewId: drag.viewId,
      x: e.clientX,
      label: target?.label ?? "Drag onto another pane, or up to the tab bar",
      preview: target?.preview,
    });
  };
  const endPaneDrag = (pointerId: number, commit: boolean) => {
    const drag = paneDragRef.current;
    if (!drag || pointerId !== drag.pointerId) return;
    paneDragRef.current = undefined;
    setPaneDrag(undefined);
    if (!drag.started) return;
    contentDragging(false);
    if (!commit) return;
    if (drag.tearOff) action("tear-off", { tabId: tabs.activeTabId, viewId: drag.viewId });
    else if (drag.drop) action("drop-view", drag.drop as unknown as Record<string, unknown>);
  };
  useEffect(() => {
    if (!paneDrag) return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape" && paneDragRef.current) endPaneDrag(paneDragRef.current.pointerId, false);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  });
  const recordIcon = (r: RecordItem): IconName =>
    r.kind === "note" ? "note" : r.kind === "database" ? "database" : "doc";
  const sidebarToggle = (
    <button
      className="key-sidebar-toggle"
      aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!sidebarCollapsed}
      title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      onClick={() => setSidebarCollapsed((v) => !v)}
    >
      <Icon name="sidebar" />
    </button>
  );
  const navItem = (
    label: string,
    icon: IconName,
    current: boolean,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      className="kx-nav-item"
      aria-current={current ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  return (
    <div
      className="key-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      data-inbox-drop={inboxDrop || undefined}
      // Files and links dropped where nothing else takes them go to the library's Inbox.
      onDragOver={(e) => {
        if (e.defaultPrevented || !workspaceId || !hasExternalDrop(e.dataTransfer)) return setInboxDrop(false);
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setInboxDrop(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setInboxDrop(false)}
      onDrop={(e) => {
        setInboxDrop(false);
        if (e.defaultPrevented || !workspaceId || !hasExternalDrop(e.dataTransfer)) return;
        e.preventDefault();
        void importDrop(invoke, workspaceId, e.dataTransfer, () => inboxCollection(invoke, workspaceId))
          .then((items) => items.length && toast(`Added ${describeCount(items)} to the Inbox`))
          .catch((error) => setError(String(error)));
      }}
    >
      <GlobalDrawerHost />
      <ItemLayer />
      <CommandCenter
        invoke={invoke}
        workspaceId={workspaceId}
        section={section}
        commands={[
          { id: "new-note", label: "New note", icon: "note", run: createNote },
          { id: "new-canvas", label: "New canvas", icon: "canvas", run: createCanvas },
          { id: "library", label: "Show library", icon: "books", run: () => action("open-content", { section: "sources", workspaceId }) },
          { id: "highlights", label: "All highlights", icon: "quote", shortcut: "⌘⇧H", run: () => action("open-content", { section: "highlights", workspaceId }) },
          { id: "inspector", label: inspectorOpen ? "Hide inspector" : "Show inspector", icon: "panelRight", shortcut: "⌘⇧I", run: () => setInspectorOpen((o) => !o) },
          { id: "sidebar", label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar", icon: "sidebar", run: () => setSidebarCollapsed((v) => !v) },
          { id: "split", label: "Split with another tab", icon: "split", run: () => action("split-menu") },
          { id: "capture", label: "Quick capture", icon: "plus", shortcut: "⌃⌥Space", run: () => action("quick-capture") },
          { id: "settings", label: "Settings", icon: "gear", shortcut: "⌘,", run: () => setSettingsSection("general") },
          { id: "shortcuts", label: "Keyboard shortcuts", icon: "info", shortcut: "⌘/", run: () => window.dispatchEvent(new CustomEvent("key:shortcuts")) },
        ]}
      />
      {prefs && settingsSection && !welcome && (
        <Settings
          section={settingsSection}
          invoke={invoke}
          workspaces={workspaces}
          settings={prefs.settings}
          info={prefs.info}
          onSettings={updatePrefs}
          onClose={() => setSettingsSection(undefined)}
          onShowWelcome={() => {
            setSettingsSection(undefined);
            setWelcome(true);
          }}
          onOpenLibrary={(id) => {
            setSettingsSection(undefined);
            if (id === tabs.workspaceId) action("open-content", { section: "sources", workspaceId: id });
            else void switchWorkspace(id);
          }}
          onWorkspacesChanged={refreshWorkspaces}
        />
      )}
      {prefs && welcome && (
        <Onboarding
          invoke={invoke}
          workspaces={workspaces}
          info={prefs.info}
          theme={prefs.settings.theme}
          onTheme={(theme) => updatePrefs({ theme })}
          onFinish={(id) => {
            setWelcome(false);
            updatePrefs({ onboarded: true });
            refreshWorkspaces();
            if (id && id !== tabs.workspaceId) void switchWorkspace(id);
            else if (id) action("open-content", { section: "sources", workspaceId: id });
          }}
        />
      )}
      <div
        ref={sidebarSlot}
        className={`key-sidebar-slot ${sidebarCollapsed ? "collapsed" : ""}`}
        data-resizing={sidebarResizing || undefined}
        style={{ "--kx-sidebar-width": `${sidebarSize}px` } as React.CSSProperties}
      >
        <aside
          className="key-sidebar key-ui-root"
          style={
            {
              "--workspace-accent": selectedWorkspace?.color || "#64748b",
            } as React.CSSProperties
          }
          inert={sidebarCollapsed}
          aria-hidden={sidebarCollapsed}
        >
          <div className="kx-sidebar-titlebar">{sidebarToggle}</div>
          <WorkspaceSwitcher
            workspaces={workspaces}
            selectedId={workspaceId}
            openElsewhere={(tabs.windows ?? []).filter((w) => w.windowId !== tabs.windowId).map((w) => w.workspaceId)}
            openRequest={switcherRequest}
            onSelect={(id, newWindow) =>
              // Choosing the workspace this window already shows opens its library.
              id === tabs.workspaceId && !newWindow
                ? action("open-content", { section: "sources", workspaceId: id })
                : void switchWorkspace(id, newWindow)
            }
            onAdd={async () => {
              const added = await api().addWorkspace();
              setWorkspaces(await api().workspaces());
              if (added) await switchWorkspace(added.id);
            }}
            onSave={async (id, icon, color) => {
              await api().invoke(
                "workspace_set_appearance",
                { icon, color },
                id,
              );
              setWorkspaces(await api().workspaces());
            }}
          />
          <nav className="kx-nav" aria-label="Main">
            {navItem("Home", "home", section === "home", () =>
              action("open-home"),
            )}
            {navItem("Search", "search", section === "search", () => window.dispatchEvent(new Event("key:search")), !workspaceId)}
            {navItem("Highlights", "quote", section === "highlights", () => sidebarClick({ kind: "highlights" }, () => action("open-content", { section: "highlights", workspaceId })), !workspaceId)}
          </nav>
          <div className="kx-sidebar-scroll">
            <CollectionTree
              invoke={invoke}
              workspaceId={workspaceId}
              sourcesCurrent={section === "sources"}
              onShowSources={() =>
                action("open-content", { section: "sources", workspaceId, projectId })
              }
            >
              <div role="treeitem" aria-level={1} aria-selected={section === "records"}>
                {navItem(
                  "All items",
                  "layers",
                  section === "records",
                  () =>
                    sidebarClick({ kind: "records" }, () => action("open-content", {
                      section: "records",
                      workspaceId,
                      projectId,
                    })),
                  !workspaceId,
                )}
              </div>
            </CollectionTree>
            {!workspaceId && (
              <p className="key-sidebar-hint">
                Choose a workspace to see its collections and pages.
              </p>
            )}
            <div className="key-sidebar-section">
              <span>Notes</span>
              <button disabled={!workspaceId} aria-label="New note" title="New note" onClick={createNote}>
                <Icon name="plus" size={14} />
              </button>
            </div>
            <nav className="kx-nav" aria-label="Notes">
              {notes.map((n) => (
                <button
                  key={n.id}
                  className="kx-nav-item"
                  aria-current={activeView?.content?.noteId === n.id ? "page" : undefined}
                  onClick={() => sidebarClick({ kind: "note", id: n.id, title: n.title || markdownToPlainText(n.body).split("\n")[0] || "Untitled note" }, () => openNote(n))}
                  {...dropTarget({ kind: "note", id: n.id, title: n.title || "Untitled note" })}
                  {...itemAttrs({ kind: "note", id: n.id, title: n.title || markdownToPlainText(n.body).split("\n")[0] || "Untitled note" })}
                  draggable
                  onDragStart={(e) => {
                    setItemDrag(e.dataTransfer, [{ kind: "note", id: n.id, title: n.title || markdownToPlainText(n.body).split("\n")[0] || "Untitled note" }]);
                    // Dropped into another app, a note is its text.
                    e.dataTransfer.setData("text/plain", [n.title && `# ${n.title}`, n.body].filter(Boolean).join("\n\n"));
                  }}
                  title={n.title || markdownToPlainText(n.body).slice(0, 120) || "Untitled note"}
                >
                  <Icon name="note" />
                  <span>{n.title || markdownToPlainText(n.body).split("\n")[0] || "Untitled note"}</span>
                </button>
              ))}
              {workspaceId && !notes.length && <p className="key-sidebar-hint">No notes yet.</p>}
              {canvases.map((c) => (
                <button
                  key={c.id}
                  className="kx-nav-item"
                  aria-current={activeView?.content?.canvasId === c.id ? "page" : undefined}
                  onClick={() => sidebarClick({ kind: "canvas", id: c.id, title: c.title || "Untitled canvas" }, () => openCanvas(c))}
                  {...dropTarget({ kind: "canvas", id: c.id, title: c.title || "Untitled canvas" })}
                  {...itemAttrs({ kind: "canvas", id: c.id, title: c.title || "Untitled canvas" })}
                  draggable
                  onDragStart={(e) => setItemDrag(e.dataTransfer, [{ kind: "canvas", id: c.id, title: c.title || "Untitled canvas" }])}
                  title={c.title || "Untitled canvas"}
                >
                  <Icon name="canvas" />
                  <span>{c.title || "Untitled canvas"}</span>
                </button>
              ))}
            </nav>
            <div className="key-sidebar-section">
              <span>Pages</span>
              <button
                disabled={!workspaceId}
                aria-label="Create item"
                title="New page, note or document"
                aria-expanded={createMenu}
                onClick={() => setCreateMenu(!createMenu)}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
            {createMenu && (
              <div className="key-create-menu">
                {(
                  [
                    ["note", "Note", "note"],
                    ["canvas", "Canvas", "canvas"],
                    ["page", "Page", "doc"],
                    ["database", "Database", "database"],
                  ] as const
                ).map(([kind, label, icon]) => (
                  <button
                    key={kind}
                    onClick={() => createRecord(kind)}
                  >
                    <Icon name={icon} />
                    New {label.toLowerCase()}
                  </button>
                ))}
                <hr />
                {["docs", "sheets", "slides", "markdown", "html"].map(
                  (kind) => (
                    <button
                      key={kind}
                      onClick={() => {
                        setCreateMenu(false);
                        action("create-office", { kind, workspaceId });
                      }}
                    >
                      <Icon name="doc" />
                      New {kind === "docs" ? "document" : kind}
                    </button>
                  ),
                )}
              </div>
            )}
            <nav className="kx-nav" aria-label="Pages">
              {records
                .filter((r) => r.kind !== "source")
                .map((r) => (
                  <button
                    key={r.id}
                    className="kx-nav-item"
                    aria-current={record?.id === r.id ? "page" : undefined}
                    onClick={() => sidebarClick({ kind: "record", id: r.id, title: r.title || "Untitled" }, () => selectRecord(r))}
                    {...itemAttrs({ kind: "record", id: r.id, title: r.title || "Untitled" })}
                    draggable
                    onDragStart={(e) => setItemDrag(e.dataTransfer, [{ kind: "record", id: r.id, title: r.title || "Untitled" }])}
                  >
                    <Icon name={recordIcon(r)} />
                    <span>{r.title || "Untitled"}</span>
                  </button>
                ))}
              {workspaceId &&
                !records.some((r) => r.kind !== "source") &&
                !createMenu && (
                  <p className="key-sidebar-hint">No pages yet.</p>
                )}
            </nav>
            <LinkedFolders invoke={invoke} workspaceId={workspaceId} />
          </div>
          <div className="key-sidebar-footer">
            <ModelProgressPill progress={model} />
            {projectId && (
              <button
                className="kx-nav-item"
                onClick={() =>
                  action("link-folder", { workspaceId, projectId })
                }
              >
                <Icon name="link" />
                <span>Link folder…</span>
              </button>
            )}
            <button className="kx-nav-item" onClick={() => setSettingsSection("general")}>
              <Icon name="gear" />
              <span>Settings</span>
            </button>
            <small>
              <Icon name="disk" size={13} />
              <span>
                {selectedWorkspace
                  ? "Stored on this Mac"
                  : `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} on this Mac`}
              </span>
            </small>
          </div>
        </aside>
        {!sidebarCollapsed && (
          <div
            className="kx-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarSize}
            title="Drag to resize · double-click to reset"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setSidebarResizing(true);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) setSidebarSize(clampSidebar(e.clientX));
            }}
            onPointerUp={() => setSidebarResizing(false)}
            onPointerCancel={() => setSidebarResizing(false)}
            onDoubleClick={() => setSidebarSize(SIDEBAR_DEFAULT)}
          />
        )}
      </div>
      <div className="kx-main">
      <TabBar
        api={officeTabs}
        contentDrop={contentDrop}
        onContentDrag={contentDragging}
        trailingControls={
          <div className="key-chrome-layout-controls">
            {activeTab && activeTab.views.length > 1 && (
              <>
                <button
                  title="Swap panes"
                  aria-label="Swap panes"
                  onClick={() => action("swap")}
                >
                  <Icon name="swap" />
                </button>
                <button
                  title="Separate panes"
                  aria-label="Separate panes"
                  onClick={() =>
                    action("separate", { viewId: tabs.activeViewId })
                  }
                >
                  <Icon name="detach" />
                </button>
              </>
            )}
            {tabs.tabs.length > 1 && (
              <button
                title="Move this tab to a new window"
                aria-label="Move tab to new window"
                onClick={() => action("pop-out", { tabId: tabs.activeTabId })}
              >
                <Icon name="windows" />
              </button>
            )}
            <button
              title="Split with another tab"
              aria-label="Split with another tab"
              disabled={
                (activeTab?.views.length ?? 0) >= MAX_PANES ||
                !tabs.tabs.some(
                  (t) => t.id !== tabs.activeTabId && t.views.length === 1,
                )
              }
              onClick={() => action("split-menu")}
            >
              <Icon name="split" />
            </button>
          </div>
        }
        chromeControl={sidebarCollapsed ? sidebarToggle : undefined}
      />
      <div className="key-shell-body key-ui-root">
        <div className="key-content-panes">
          {tabs.tabs
            .flatMap((t) => t.views)
            .filter((v) => v.content)
            .map((v) => {
              const pane = laidOut.panes.find((p) => p.viewId === v.id);
              const placed = pane && paneBody(pane, laidOut.panes.length > 1);
              return (
                <div
                  key={v.id}
                  data-content-view={v.id}
                  className="key-content-pane"
                  data-pane-focused={laidOut.panes.length > 1 && v.id === tabs.activeViewId ? "" : undefined}
                  tabIndex={-1}
                  hidden={!placed}
                  onPointerDownCapture={() => {
                    if (tabs.activeViewId !== v.id)
                      action("focus", { viewId: v.id });
                  }}
                  onFocusCapture={() => {
                    if (tabs.activeViewId !== v.id)
                      action("focus", { viewId: v.id });
                  }}
                  style={
                    placed && {
                      left: placed.x,
                      top: placed.y,
                      width: placed.width,
                      height: placed.height,
                    }
                  }
                >
                  {!!(v.back?.length || v.forward) && (
                    <nav className="key-pane-history" aria-label="Pane history">
                      <button disabled={!v.back?.length} title={v.back?.length ? `Back to ${v.back.at(-1)} (⌘[)` : undefined} aria-label="Back" onClick={() => action("history", { viewId: v.id, step: -1 })}>
                        <Icon name="chevronRight" size={13} style={{ transform: "scaleX(-1)" }} />
                      </button>
                      <button disabled={!v.forward} title={v.forward ? `Forward to ${v.forward} (⌘])` : undefined} aria-label="Forward" onClick={() => action("history", { viewId: v.id, step: 1 })}>
                        <Icon name="chevronRight" size={13} />
                      </button>
                      <ol className="key-pane-crumbs">
                        {(v.back ?? []).map((title, i, all) => (
                          <li key={i}>
                            <button onClick={() => { for (let n = 0; n < all.length - i; n++) action("history", { viewId: v.id, step: -1 }); }}>{title}</button>
                          </li>
                        ))}
                        <li aria-current="page">{v.title.replace(/ •$/, "")}</li>
                      </ol>
                    </nav>
                  )}
                  <WorkspaceContent
                    key={contentIdentity(v.content)}
                    viewId={v.id}
                    spec={v.content || { section: "sources" }}
                    visible={!!placed}
                    tabs={tabs}
                  />
                </div>
              );
            })}
          {error && (
            <div className="key-shell-error" role="alert">
              <span>{error}</span>
              <Button onClick={() => setError("")}>Dismiss</Button>
            </div>
          )}
        </div>
      </div>
      </div>
      {inspectorOpen && (
        <div style={{ "--kx-inspector-width": `${INSPECTOR_WIDTH}px` } as React.CSSProperties}>
          <Inspector invoke={invoke} workspaceId={workspaceId} items={selected} onClose={() => setInspectorOpen(false)} />
        </div>
      )}
      {laidOut.dividers.map((d) => {
        const row = d.split === "row";
        const fromPointer = (e: React.PointerEvent) =>
          row
            ? (e.clientX - sidebarWidth - d.parent.x) / Math.max(1, d.parent.width)
            : (e.clientY - CHROME_TOP - d.parent.y) / Math.max(1, d.parent.height);
        return (
          <div
            key={d.path || "root"}
            className={`key-split-divider ${row ? "" : "key-split-divider-column"}`}
            role="separator"
            aria-label="Resize split panes"
            aria-orientation={row ? "vertical" : "horizontal"}
            aria-valuemin={10}
            aria-valuemax={90}
            aria-valuenow={Math.round(d.ratio * 100)}
            data-split-path={d.path}
            tabIndex={0}
            style={{
              left: sidebarWidth + d.x,
              top: CHROME_TOP + d.y,
              width: d.width,
              height: d.height,
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              resizeSplit(d.path, fromPointer(e));
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                resizeSplit(d.path, fromPointer(e));
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
                action("resize-split", splitPending.current);
                setDragSplit(undefined);
              }
            }}
            onPointerCancel={() => setDragSplit(undefined)}
            onDoubleClick={() => action("resize-split", { path: d.path, ratio: 0.5 })}
            onKeyDown={(e) => {
              const back = row ? "ArrowLeft" : "ArrowUp",
                forward = row ? "ArrowRight" : "ArrowDown";
              if (e.key === back || e.key === forward) {
                e.preventDefault();
                action("resize-split", {
                  path: d.path,
                  ratio: d.ratio + (e.key === back ? -DIVIDER_STEP : DIVIDER_STEP),
                });
              }
            }}
          />
        );
      })}
      {laidOut.panes.length > 1 &&
        laidOut.panes.map((p) => {
          const view = activeTab?.views.find((v) => v.id === p.viewId);
          if (!view) return null;
          const title = view.title.replace(/ •$/, "");
          return (
            <div
              key={p.viewId}
              className="key-pane-header"
              data-pane-header={p.viewId}
              data-pane-focused={p.viewId === tabs.activeViewId ? "" : undefined}
              data-dragging={paneDrag?.viewId === p.viewId ? "" : undefined}
              title={`${title}\nDrag to move this pane · middle-click to close`}
              style={{ left: sidebarWidth + p.x, top: CHROME_TOP + p.y, width: p.width, height: Math.min(PANE_HEADER, p.height) }}
              onPointerDown={(e) => {
                if (e.button === 1) e.preventDefault();
                if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                if (tabs.activeViewId !== p.viewId) action("focus", { viewId: p.viewId });
                paneDragRef.current = { pointerId: e.pointerId, viewId: p.viewId, startX: e.clientX, startY: e.clientY, started: false };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={movePaneDrag}
              onPointerUp={(e) => endPaneDrag(e.pointerId, true)}
              onPointerCancel={(e) => endPaneDrag(e.pointerId, false)}
              onLostPointerCapture={(e) => endPaneDrag(e.pointerId, false)}
              onAuxClick={(e) => {
                if (e.button === 1) action("close-pane", { viewId: p.viewId });
              }}
            >
              <span className="key-pane-header-icon">
                <TabKindIcon kind={view.kind} />
              </span>
              <span className="key-pane-header-title">{view.title}</span>
              <button
                title="Move to a tab of its own"
                aria-label={`Move ${title} to a tab of its own`}
                onClick={() => {
                  const index = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
                  action("drop-view", { kind: "detach", viewId: p.viewId, index: index + 1 });
                }}
              >
                <Icon name="detach" size={13} />
              </button>
              <button
                className="key-pane-close"
                title={`Close ${title} (⌘W when focused)`}
                aria-label={`Close pane ${title}`}
                onClick={() => action("close-pane", { viewId: p.viewId })}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      {paneDrag && (
        <div className="tab-drop-feedback" role="status" aria-live="polite" style={{ left: Math.max(12, Math.min(window.innerWidth - 280, paneDrag.x - 110)) }}>
          {paneDrag.label}
          <small>Esc to cancel</small>
        </div>
      )}
      {paneDrag?.preview && (
        <div
          className="key-pane-drop-preview"
          aria-hidden="true"
          style={{
            left: paneDrag.preview.x + 4,
            top: paneDrag.preview.y + 4,
            width: Math.max(0, paneDrag.preview.width - 8),
            height: Math.max(0, paneDrag.preview.height - 8),
          }}
        />
      )}
      {paneDrag?.insertAt !== undefined && <div className="key-tab-insert-marker" aria-hidden="true" style={{ left: paneDrag.insertAt - 1 }} />}
      {dragFrames.map((frame) => (
        <img
          key={frame.id}
          className="key-native-overlay-frame"
          alt=""
          draggable={false}
          src={frame.image}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        />
      ))}{" "}
      {dialog && (
        <GlobalDialog label={dialog === "project" ? "New project" : "Link a folder"} onClose={()=>setDialog(null)}>
          <form
            className="key-shell-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              if (!workspaceId) return;
              void task(async () => {
                if (dialog === "project") {
                  const p = await invoke<Project>(
                    "workspace_create_project",
                    { name: dialogValue },
                    workspaceId,
                  );
                  chooseScope(workspaceId, p.id);
                } else {
                  const folder = await invoke<{ id: string }>(
                    "workspace_link_folder",
                    { projectId, path: dialogValue },
                    workspaceId,
                  );
                  await invoke(
                    "workspace_scan_linked_folder",
                    { id: folder.id },
                    workspaceId,
                  );
                }
                setDialog(null);
                setRefreshKey((k) => k + 1);
              });
            }}
          >
            <h2>{dialog === "project" ? "New project" : "Link a folder"}</h2>
            <p>
              {dialog === "project"
                ? "Projects are subfolders and filtered views of this workspace."
                : "Files stay in their original folder. Their metadata is added to this project and supported sources are indexed."}
            </p>
            <label>
              {dialog === "project" ? "Project name" : "Absolute folder path"}
              <Input
                autoFocus
                required
                value={dialogValue}
                onChange={(e) => setDialogValue(e.target.value)}
              />
            </label>
            <div>
              <Button type="button" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button type="submit">
                {dialog === "project" ? "Create project" : "Link and scan"}
              </Button>
            </div>
          </form>
        </GlobalDialog>
      )}
    </div>
  );
}
