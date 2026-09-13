import { Button, Input } from "@key/design-system";
import { GlobalDrawerHost, GlobalDialog } from "./GlobalDrawer";
import SearchPreviewBar, {type SearchPreviewState} from "./SearchPreviewBar";
import { TabBar, type TabSummary, type TabsApi } from "./TabBar";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LibrarySource, type LibraryHit } from "./LibraryHome";
import "./shell.css";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import WorkspaceContent, { type ContentSpec } from "./WorkspaceContent";
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
  tabs: {
    id: string;
    title: string;
    views: {
      id: string;
      title: string;
      kind: string;
      workspaceId?: string;
      content?: ContentSpec;
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
const emptyTabs: TabState = { tabs: [], activeTabId: "", activeViewId: "" };

const tabSummary = (state: TabState): TabSummary[] =>
  state.tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    kind: (tab.views[0]?.kind as TabSummary["kind"]) || "home",
    active: tab.id === state.activeTabId,
    closable: true,
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
  reorder: (tabId, index) => api().tabAction("reorder", { tabId, index }),
  showNewMenu: () => api().tabAction("new"),
  showMenu: (x, y) => api().tabAction("tab-menu", { x, y }),
  dropView: (drop) => api().tabAction("drop-view", drop),
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
  const splitPending = useRef(0.5);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("key.sidebar.collapsed") === "true",
  );
  const sidebarSlot = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarCollapsed ? 0 : 240);
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
  const [dragRatio, setDragRatio] = useState<number>();
  const resizeSplit = (x: number) => {
    const ratio = Math.max(
      0.2,
      Math.min(
        0.8,
        (x - sidebarWidth) / Math.max(1, window.innerWidth - sidebarWidth),
      ),
    );
    setDragRatio(ratio);
    splitPending.current = ratio;
    if (splitFrame.current === null)
      splitFrame.current = requestAnimationFrame(() => {
        splitFrame.current = null;
        action("resize-split", { ratio: splitPending.current });
      });
  };
  const [createMenu, setCreateMenu] = useState(false),
    [dialog, setDialog] = useState<"project" | "folder" | null>(null),
    [dialogValue, setDialogValue] = useState("");

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
    const b = api().on("library-changed", () => setRefreshKey((k) => k + 1));
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
  const createRecord = (kind: string) => {
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
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId),
    selectedProject = projects.find((p) => p.id === projectId);
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId),
    activeView = activeTab?.views.find((v) => v.id === tabs.activeViewId);
  useEffect(() => {
    if (activeView?.content) {
      setWorkspaceId(activeView.content.workspaceId);
      setProjectId(activeView.content.projectId);
      setSection(activeView.content.section);
      setRecord(activeView.content.record);
    } else if (activeView) {
      setWorkspaceId(activeView.workspaceId);
      setProjectId(undefined);
      setRecord(undefined);
      setSection("");
    }
  }, [activeView?.id, activeView?.content?.record?.id]);
  return (
    <div className="key-shell">
      <GlobalDrawerHost />
      <TabBar
        api={officeTabs}
        trailingControls={
          <div className="key-chrome-layout-controls">
            {activeTab && activeTab.views.length > 1 && (
              <>
                <button
                  title="Swap panes"
                  aria-label="Swap panes"
                  onClick={() => action("swap")}
                >
                  ⇄
                </button>
                <button
                  title="Separate panes"
                  aria-label="Separate panes"
                  onClick={() =>
                    action("separate", { viewId: tabs.activeViewId })
                  }
                >
                  ↗
                </button>
              </>
            )}
            <button
              title="Split with another tab"
              aria-label="Split with another tab"
              disabled={
                activeTab?.views.length === 2 ||
                !tabs.tabs.some(
                  (t) => t.id !== tabs.activeTabId && t.views.length === 1,
                )
              }
              onClick={() => action("split-menu")}
            >
              ◫
            </button>
          </div>
        }
        chromeControl={
          <button
            className="key-sidebar-toggle"
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            ◧
          </button>
        }
      />
      <div className="key-shell-body key-ui-root">
        <div
          ref={sidebarSlot}
          className={`key-sidebar-slot ${sidebarCollapsed ? "collapsed" : ""}`}
        >
          <aside
            className="key-sidebar"
            style={
              {
                "--workspace-accent": selectedWorkspace?.color || "#64748b",
              } as React.CSSProperties
            }
            inert={sidebarCollapsed}
            aria-hidden={sidebarCollapsed}
          >
            <WorkspaceSwitcher
              workspaces={workspaces}
              selectedId={workspaceId}
              onSelect={chooseScope}
              onAdd={async () => {
                const added = await api().addWorkspace();
                setWorkspaces(await api().workspaces());
                if (added) chooseScope(added.id);
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
            <Button
              className={section === "sources" ? "selected" : ""}
              onClick={() =>
                action("open-content", {
                  section: "sources",
                  workspaceId,
                  projectId,
                })
              }
            >
              ▤ <span>Sources</span>
            </Button>
            <Button
              disabled={!workspaceId}
              className={section === "records" ? "selected" : ""}
              onClick={() =>
                action("open-content", {
                  section: "records",
                  workspaceId,
                  projectId,
                })
              }
            >
              ▦ <span>All items & linked files</span>
            </Button>
            <div className="key-sidebar-section">
              <span>Projects</span>
              <Button
                aria-label="New project"
                disabled={!workspaceId}
                onClick={() => {
                  setDialog("project");
                  setDialogValue("");
                }}
              >
                ＋
              </Button>
            </div>
            {workspaceId ? (
              <>
                <Button
                  className={!projectId ? "scope-current" : ""}
                  onClick={() => chooseScope(workspaceId)}
                >
                  ⌂ <span>Entire workspace</span>
                </Button>
                {projects.map((p) => (
                  <Button
                    key={p.id}
                    className={projectId === p.id ? "scope-current" : ""}
                    onClick={() => chooseScope(workspaceId, p.id)}
                    title={p.folder}
                  >
                    ▱ <span>{p.name}</span>
                  </Button>
                ))}
              </>
            ) : (
              <p className="key-sidebar-hint">
                Choose a workspace to browse its projects and pages.
              </p>
            )}
            <div className="key-sidebar-section">
              <span>Pages & documents</span>
              <Button
                disabled={!workspaceId}
                aria-label="Create item"
                onClick={() => setCreateMenu(!createMenu)}
              >
                ＋
              </Button>
            </div>
            {createMenu && (
              <div className="key-create-menu">
                {["note", "page", "database"].map((kind) => (
                  <Button key={kind} onClick={() => createRecord(kind)}>
                    New {kind}
                  </Button>
                ))}
                {["docs", "sheets", "slides", "markdown", "html"].map(
                  (kind) => (
                    <Button
                      key={kind}
                      onClick={() => {
                        setCreateMenu(false);
                        action("create-office", { kind, workspaceId });
                      }}
                    >
                      New {kind === "docs" ? "document" : kind}
                    </Button>
                  ),
                )}
              </div>
            )}
            {records
              .filter((r) => r.kind !== "source")
              .map((r) => (
                <Button
                  key={r.id}
                  className={record?.id === r.id ? "selected" : ""}
                  onClick={() =>
                    r.documentHash
                      ? void task(() =>
                          api().openSource({
                            documentId: r.documentHash!,
                            documentHash: r.documentHash!,
                            title: r.title,
                            status: "indexed",
                            pageCount: 0,
                            completed: 0,
                            total: 0,
                            workspaceId,
                          }),
                        )
                      : selectRecord(r)
                  }
                >
                  <span>{r.kind === "note" ? "≡" : "▱"}</span>
                  <span>{r.title}</span>
                </Button>
              ))}
            <div className="key-sidebar-footer">
              {projectId && (
                <Button
                  onClick={() =>
                    action("link-folder", { workspaceId, projectId })
                  }
                >
                  ＋ Link folder
                </Button>
              )}
              <small>
                {selectedWorkspace
                  ? "Local workspace · saved on this Mac"
                  : `${workspaces.length} local workspaces`}
              </small>
            </div>
          </aside>
        </div>
        <div className="key-content-panes">
          {tabs.searchPreview && <SearchPreviewBar preview={tabs.searchPreview} action={action}/>}
          {tabs.tabs
            .flatMap((t) => t.views)
            .filter((v) => v.content)
            .map((v) => {
              const index =
                activeTab?.views.findIndex((p) => p.id === v.id) ?? -1;
              const split = activeTab?.views.length === 2;
              const ratio = dragRatio ?? tabs.splitRatio ?? 0.5;
              return (
                <div
                  key={v.id}
                  data-content-view={v.id}
                  className="key-content-pane"
                  hidden={index < 0}
                  onPointerDownCapture={() => {
                    if (tabs.activeViewId !== v.id)
                      action("focus", { viewId: v.id });
                  }}
                  onFocusCapture={() => {
                    if (tabs.activeViewId !== v.id)
                      action("focus", { viewId: v.id });
                  }}
                  style={{
                    top: tabs.searchPreview ? 40 : 0,
                    left:
                      split && index === 1 ? `calc(${ratio * 100}% + 3px)` : 0,
                    width: split
                      ? index === 0
                        ? `calc(${ratio * 100}% - 3px)`
                        : `calc(${(1 - ratio) * 100}% - 3px)`
                      : "100%",
                  }}
                >
                  <WorkspaceContent
                    viewId={v.id}
                    spec={v.content || { section: "sources" }}
                    visible={index >= 0}
                    tabs={tabs}
                  />
                </div>
              );
            })}
          {error && (
            <div className="key-shell-error" role="alert">
              {error}
              <Button onClick={() => setError("")}>Dismiss</Button>
            </div>
          )}
        </div>
      </div>
      {activeTab?.views.length === 2 && (
        <div
          className="key-split-divider"
          role="separator"
          aria-label="Resize split panes"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(
            (dragRatio ?? tabs.splitRatio ?? 0.5) * 100,
          )}
          tabIndex={0}
          style={{
            top: tabs.searchPreview ? 80 : 40,
            left: `calc(${sidebarWidth}px + (100vw - ${sidebarWidth}px) * ${dragRatio ?? tabs.splitRatio ?? 0.5} - 3px)`,
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            resizeSplit(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              resizeSplit(e.clientX);
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
              action("resize-split", { ratio: splitPending.current });
              setDragRatio(undefined);
            }
          }}
          onPointerCancel={() => setDragRatio(undefined)}
          onDoubleClick={() => action("resize-split", { ratio: 0.5 })}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              action("resize-split", {
                ratio:
                  (tabs.splitRatio ?? 0.5) +
                  (e.key === "ArrowLeft" ? -0.025 : 0.025),
              });
            }
          }}
        />
      )}{" "}
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
