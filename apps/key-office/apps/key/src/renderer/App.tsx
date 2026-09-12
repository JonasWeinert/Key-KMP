import { TabBar, type TabSummary, type TabsApi } from "./TabBar";
import { useCallback, useEffect, useRef, useState } from "react";
import LibraryHome, {
  type LibrarySource,
  type LibraryHit,
} from "./LibraryHome";
import "./shell.css";
interface Workspace {
  id: string;
  name: string;
  root: string;
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
  tabs: {
    id: string;
    title: string;
    views: { id: string; title: string; kind: string }[];
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
        setDirty?: (dirty: boolean) => void;
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

interface DatabaseView {
  kind?: string;
  query?: string;
  property?: string;
  value?: string;
}
function WorkspaceRecordTable({
  workspaceId,
  projectId,
  view,
  onSelect,
  revision,
}: {
  workspaceId: string;
  projectId?: string;
  view: DatabaseView;
  onSelect: (record: RecordItem) => void;
  revision: number;
}) {
  const [rows, setRows] = useState<RecordItem[]>([]),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const load = async (start: number, seq: number) => {
    setLoading(true);
    setError("");
    try {
      const page = await api().invoke<RecordItem[]>(
        "workspace_records",
        {
          projectId: projectId || null,
          query: view.query || null,
          limit: 100,
          offset: start,
        },
        workspaceId,
      );
      if (seq !== generation.current) return;
      setRows((previous) => (start ? [...previous, ...page] : page));
      setOffset(start + page.length);
      setMore(page.length === 100);
    } catch (e) {
      if (seq === generation.current) setError(String(e));
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const seq = ++generation.current;
    setRows([]);
    setMore(false);
    const timer = setTimeout(() => void load(0, seq), 250);
    return () => {
      clearTimeout(timer);
      ++generation.current;
    };
  }, [workspaceId, projectId, view.query, revision]);
  const visible = rows.filter(
    (r) =>
      (!view.kind || r.kind === view.kind) &&
      (!view.property ||
        JSON.stringify(r.properties[view.property]) ===
          JSON.stringify(parseFilterValue(view.value || ""))),
  );
  return (
    <div className="key-record-browser">
      <p>
        {visible.length} matching items in {rows.length} loaded records
        {more ? " · more available" : ""}
      </p>
      {error && <p role="alert">{error}</p>}
      <table className="key-source-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Properties</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id}>
              <td>
                <button onClick={() => onSelect(r)}>{r.title}</button>
              </td>
              <td>{r.kind}</td>
              <td title={JSON.stringify(r.properties)}>
                {Object.entries(r.properties)
                  .filter(([key]) => !["path", "view"].includes(key))
                  .map(
                    ([key, value]) =>
                      `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
                  )
                  .join(" · ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <p role="status">Loading records…</p>}
      {!loading && !visible.length && (
        <p>
          No matching items in the loaded records.
          {more ? " Load more to continue searching this filtered view." : ""}
        </p>
      )}
      {more && (
        <button
          disabled={loading}
          onClick={() => void load(offset, generation.current)}
        >
          Load next 100 records
        </button>
      )}
    </div>
  );
}
function parseFilterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

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
  const [propertiesText, setPropertiesText] = useState("{}"),
    [databaseView, setDatabaseView] = useState<DatabaseView>({}),
    [recordQuery, setRecordQuery] = useState("");
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
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
  useEffect(() => {
    api().setDirty?.(dirty);
  }, [dirty]);
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
  const revealHome = () => {
    const current = tabs.tabs.find((t) => t.id === tabs.activeTabId);
    if (current?.views.some((v) => v.kind !== "home")) action("new");
  };
  const discard = () =>
    !dirty || window.confirm("Discard unsaved changes to this page?");
  const chooseScope = (id?: string, project?: string) => {
    if (!discard()) return;
    revealHome();
    setWorkspaceId(id);
    setProjectId(project);
    setRecord(undefined);
    setDirty(false);
    setSection("sources");
    setMessage("");
  };
  const selectRecord = (r: RecordItem) => {
    if (!discard()) return;
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
    revealHome();
    setRecord(r);
    setTitle(r.title);
    setBody(r.body);
    setPropertiesText(JSON.stringify(r.properties, null, 2));
    setDatabaseView((r.properties.view as DatabaseView) || {});
    setDirty(false);
    setSection("record");
    setMessage("");
  };
  const createRecord = (kind: string) => {
    setCreateMenu(false);
    if (!workspaceId) {
      setError("Choose a workspace to create an item.");
      return;
    }
    if (!discard()) return;
    revealHome();
    setRecord({
      id: "",
      kind,
      title: "",
      body: "",
      properties: {},
      revision: 0,
    });
    setTitle("");
    setBody("");
    setPropertiesText("{}");
    setDatabaseView({});
    setDirty(false);
    setSection("record");
  };
  const save = async () => {
    if (!workspaceId || !record || busy) return;
    setBusy(true);
    setError("");
    try {
      const properties = JSON.parse(propertiesText);
      if (
        !properties ||
        Array.isArray(properties) ||
        typeof properties !== "object"
      )
        throw new Error("Properties must be a JSON object.");
      if (record.kind === "database") properties.view = databaseView;
      const saved = await invoke<RecordItem>(
        "workspace_save_record",
        {
          id: record.id || null,
          kind: record.kind,
          title,
          body: record.kind === "database" ? "" : body,
          properties,
          expectedRevision: record.id ? record.revision : null,
        },
        workspaceId,
      );
      if (projectId && !record.id)
        await invoke(
          "workspace_set_project_membership",
          { projectId, recordId: saved.id, present: true },
          workspaceId,
        );
      setRecord(saved);
      setPropertiesText(JSON.stringify(saved.properties, null, 2));
      setDirty(false);
      setMessage("Saved");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId),
    selectedProject = projects.find((p) => p.id === projectId);
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId),
    activeView = activeTab?.views.find((v) => v.id === tabs.activeViewId);
  const home =
    !activeTab ||
    activeTab.views.length === 0 ||
    activeView?.kind === "home" ||
    activeTab.views.every((v) => v.kind === "home");
  const openIds = new Set(
    tabs.tabs.flatMap((t) =>
      t.views.map((v) => (v.id.startsWith("pdf:") ? v.id.slice(4) : v.id)),
    ),
  );
  return (
    <div className="key-shell">
      <TabBar
        api={officeTabs}
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
      <header className="key-navbar">
        <select
          aria-label="Workspace"
          value={workspaceId || ""}
          onChange={(e) => chooseScope(e.target.value || undefined)}
        >
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <span className="key-path">
          {selectedProject
            ? `${selectedWorkspace?.name} / ${selectedProject.name}`
            : selectedWorkspace?.name || "All workspaces"}
          <span>
            {" "}
            /{" "}
            {home
              ? section === "record"
                ? title || "Untitled"
                : "Sources"
              : activeView?.title || activeTab?.title}
          </span>
        </span>
        <div className="key-navbar-actions">
          {activeTab && activeTab.views.length > 1 && (
            <>
              <button onClick={() => action("swap")}>Swap panes</button>
              <button
                onClick={() =>
                  action("separate", { viewId: tabs.activeViewId })
                }
              >
                Separate
              </button>
            </>
          )}
          {!home && (
            <button
              disabled={
                !tabs.tabs.some(
                  (t) =>
                    t.id !== tabs.activeTabId &&
                    t.views.some((v) => v.kind !== "home"),
                )
              }
              onClick={() => action("split", { viewId: tabs.activeViewId })}
            >
              Split with another tab
            </button>
          )}
          <button
            onClick={() =>
              void task(async () => {
                const added = await api().addWorkspace();
                setWorkspaces(await api().workspaces());
                if (added) chooseScope(added.id);
              })
            }
          >
            ＋ Workspace
          </button>
        </div>
      </header>
      <div className="key-shell-body">
        <div
          ref={sidebarSlot}
          className={`key-sidebar-slot ${sidebarCollapsed ? "collapsed" : ""}`}
        >
          <aside
            className="key-sidebar"
            inert={sidebarCollapsed}
            aria-hidden={sidebarCollapsed}
          >
            <div className="key-sidebar-caption">
              {selectedWorkspace?.name || "Overview"}
            </div>
            <button
              className={section === "sources" ? "selected" : ""}
              onClick={() => {
                if (discard()) {
                  revealHome();
                  setSection("sources");
                  setRecord(undefined);
                  setDirty(false);
                }
              }}
            >
              ▤ <span>Sources</span>
            </button>
            <button
              disabled={!workspaceId}
              className={section === "records" ? "selected" : ""}
              onClick={() => {
                if (discard()) {
                  revealHome();
                  setSection("records");
                  setRecord(undefined);
                  setDirty(false);
                }
              }}
            >
              ▦ <span>All items & linked files</span>
            </button>
            <div className="key-sidebar-section">
              <span>Projects</span>
              <button
                aria-label="New project"
                disabled={!workspaceId}
                onClick={() => {
                  setDialog("project");
                  setDialogValue("");
                }}
              >
                ＋
              </button>
            </div>
            {workspaceId ? (
              <>
                <button
                  className={!projectId ? "scope-current" : ""}
                  onClick={() => chooseScope(workspaceId)}
                >
                  ⌂ <span>Entire workspace</span>
                </button>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    className={projectId === p.id ? "scope-current" : ""}
                    onClick={() => chooseScope(workspaceId, p.id)}
                    title={p.folder}
                  >
                    ▱ <span>{p.name}</span>
                  </button>
                ))}
              </>
            ) : (
              <p className="key-sidebar-hint">
                Choose a workspace to browse its projects and pages.
              </p>
            )}
            <div className="key-sidebar-section">
              <span>Pages & documents</span>
              <button
                disabled={!workspaceId}
                aria-label="Create item"
                onClick={() => setCreateMenu(!createMenu)}
              >
                ＋
              </button>
            </div>
            {createMenu && (
              <div className="key-create-menu">
                {["note", "page", "database"].map((kind) => (
                  <button key={kind} onClick={() => createRecord(kind)}>
                    New {kind}
                  </button>
                ))}
                {["docs", "sheets", "slides", "markdown", "html"].map(
                  (kind) => (
                    <button
                      key={kind}
                      onClick={() => {
                        setCreateMenu(false);
                        action("create-office", { kind, workspaceId });
                      }}
                    >
                      New {kind === "docs" ? "document" : kind}
                    </button>
                  ),
                )}
              </div>
            )}
            {records
              .filter((r) => r.kind !== "source")
              .map((r) => (
                <button
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
                </button>
              ))}
            <div className="key-sidebar-footer">
              {projectId && (
                <button
                  onClick={() =>
                    action("link-folder", { workspaceId, projectId })
                  }
                >
                  ＋ Link folder
                </button>
              )}
              <small>
                {selectedWorkspace
                  ? "Local workspace · saved on this Mac"
                  : `${workspaces.length} local workspaces`}
              </small>
            </div>
          </aside>
        </div>
        <main className="key-shell-content">
          {error && (
            <div className="key-shell-error" role="alert">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {home && section === "record" && record && (
            <section className="key-record-editor">
              <div className="key-record-top">
                <span>
                  {selectedWorkspace?.name} / {selectedProject?.name || "Pages"}{" "}
                  / {record.kind}
                </span>
                <button
                  disabled={busy || !title.trim()}
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : dirty ? "Save changes" : "Save"}
                </button>
              </div>
              <input
                className="key-record-title"
                aria-label="Page title"
                placeholder="Untitled"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
              />
              {record.kind === "database" ? (
                <>
                  <div className="key-library-filters">
                    <label>
                      Item type
                      <select
                        value={databaseView.kind || ""}
                        onChange={(e) => {
                          setDatabaseView({
                            ...databaseView,
                            kind: e.target.value,
                          });
                          setDirty(true);
                        }}
                      >
                        <option value="">Any type</option>
                        {[
                          "source",
                          "note",
                          "page",
                          "document",
                          "file",
                          "database",
                        ].map((kind) => (
                          <option key={kind}>{kind}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Text contains
                      <input
                        value={databaseView.query || ""}
                        onChange={(e) => {
                          setDatabaseView({
                            ...databaseView,
                            query: e.target.value,
                          });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label>
                      Property name
                      <input
                        value={databaseView.property || ""}
                        onChange={(e) => {
                          setDatabaseView({
                            ...databaseView,
                            property: e.target.value,
                          });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label>
                      Equals
                      <input
                        placeholder="Text, number, true or false"
                        value={databaseView.value || ""}
                        onChange={(e) => {
                          setDatabaseView({
                            ...databaseView,
                            value: e.target.value,
                          });
                          setDirty(true);
                        }}
                      />
                    </label>
                  </div>
                  {workspaceId && (
                    <WorkspaceRecordTable
                      workspaceId={workspaceId}
                      projectId={projectId}
                      view={databaseView}
                      onSelect={selectRecord}
                      revision={refreshKey}
                    />
                  )}
                  <p className="key-sidebar-hint">
                    A saved database is a filtered view of workspace items.
                    Formulas and relation rollups are planned.
                  </p>
                </>
              ) : (
                <textarea
                  aria-label="Page content"
                  placeholder="Start writing…"
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setDirty(true);
                  }}
                />
              )}
              <details className="key-record-projects">
                <summary>Custom properties</summary>
                <p>
                  Properties are saved on this item. Enter a JSON object with
                  your own names and values.
                </p>
                <textarea
                  style={{
                    height: 160,
                    minHeight: 100,
                    fontFamily: "monospace",
                    fontSize: 12,
                  }}
                  aria-label="Custom properties JSON"
                  value={propertiesText}
                  onChange={(e) => {
                    setPropertiesText(e.target.value);
                    setDirty(true);
                  }}
                />
              </details>
              <div className="key-record-status" role="status">
                {dirty
                  ? "Unsaved changes"
                  : message ||
                    (record.id ? `Revision ${record.revision}` : "New page")}
              </div>
              {record.id && projects.length > 0 && (
                <details className="key-record-projects">
                  <summary>Project membership</summary>
                  {projects.map((p) => (
                    <div key={p.id}>
                      <span>{p.name}</span>
                      <button
                        onClick={() =>
                          void task(async () => {
                            await invoke(
                              "workspace_set_project_membership",
                              {
                                projectId: p.id,
                                recordId: record.id,
                                present: true,
                              },
                              workspaceId,
                            );
                            setMessage(`Added to ${p.name}`);
                            setRefreshKey((k) => k + 1);
                          })
                        }
                      >
                        Add
                      </button>
                      <button
                        onClick={() =>
                          void task(async () => {
                            await invoke(
                              "workspace_set_project_membership",
                              {
                                projectId: p.id,
                                recordId: record.id,
                                present: false,
                              },
                              workspaceId,
                            );
                            setMessage(`Removed from ${p.name}`);
                            setRefreshKey((k) => k + 1);
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}
          {home && section === "records" && workspaceId && (
            <section className="key-record-editor">
              <h1>All items & linked files</h1>
              <input
                aria-label="Search workspace records"
                placeholder="Search file metadata, notes and pages"
                value={recordQuery}
                onChange={(e) => setRecordQuery(e.target.value)}
              />
              <WorkspaceRecordTable
                workspaceId={workspaceId}
                projectId={projectId}
                view={{ query: recordQuery }}
                onSelect={selectRecord}
                revision={refreshKey}
              />
            </section>
          )}
          <div
            style={{
              display: home && section === "sources" ? "flex" : "none",
              flex: 1,
              minHeight: 0,
            }}
          >
            <LibraryHome
              active={home && section === "sources"}
              invoke={invoke}
              workspaceId={workspaceId}
              projectId={projectId}
              scopeLabel={
                selectedProject
                  ? `${selectedProject.name} · Sources`
                  : selectedWorkspace
                    ? "Sources"
                    : "All sources"
              }
              openDocumentIds={openIds}
              onAddSources={() =>
                workspaceId
                  ? void task(() => api().openSources(workspaceId))
                  : setError(
                      "Choose a destination workspace before adding PDFs.",
                    )
              }
              onOpenSource={(source, hit, results) =>
                void task(() => api().openSource(source, hit, results))
              }
              refreshKey={refreshKey}
            />
          </div>
          {!home && (
            <div
              className="key-view-host-placeholder"
              aria-label="Document view"
            />
          )}
        </main>
      </div>
      {!home && activeTab?.views.length === 2 && (
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
        <div className="key-dialog-backdrop">
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
                  setProjectId(p.id);
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
              <input
                autoFocus
                required
                value={dialogValue}
                onChange={(e) => setDialogValue(e.target.value)}
              />
            </label>
            <div>
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit">
                {dialog === "project" ? "Create project" : "Link and scan"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
