import { Button, Input, Textarea, Select } from "@key/design-system";
import type { SearchPreviewState } from "./SearchPreviewBar";
import { EntryDetails } from "./EntryTools";
import { RecordProperties } from "./RecordProperties";
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
  icon?: string;
  color?: string;
}
interface Project {
  id: string;
  name: string;
  folder: string;
}
export interface RecordItem {
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
  active = true,
}: {
  workspaceId: string;
  projectId?: string;
  view: DatabaseView;
  onSelect: (record: RecordItem) => void;
  revision: number;
  active?: boolean;
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
    if (!active) return;
    setRows([]);
    setMore(false);
    const timer = setTimeout(() => void load(0, seq), 250);
    return () => {
      clearTimeout(timer);
      ++generation.current;
    };
  }, [workspaceId, projectId, view.query, revision, active]);
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
                <Button onClick={() => onSelect(r)}>{r.title}</Button>
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
        <Button
          disabled={loading}
          onClick={() => void load(offset, generation.current)}
        >
          Load next 100 records
        </Button>
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

export interface ContentSpec {
  section: "sources" | "records" | "record";
  workspaceId?: string;
  projectId?: string;
  record?: RecordItem;
}
export default function WorkspaceContent({
  viewId,
  spec,
  visible,
  tabs,
}: {
  viewId: string;
  spec: ContentSpec;
  visible: boolean;
  tabs: TabState;
}) {
  const host = useRef<HTMLElement>(null);
  useEffect(
    () =>
      api().on("save-content", (id) => {
        if (id === viewId)
          host.current
            ?.querySelector<HTMLButtonElement>("[data-save-record]")
            ?.click();
      }),
    [viewId],
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const { workspaceId, projectId, section } = spec;
  const [projects, setProjects] = useState<Project[]>([]);
  const [record, setRecord] = useState<RecordItem | undefined>(spec.record);
  const [propertiesText, setPropertiesText] = useState(
      JSON.stringify(spec.record?.properties || {}, null, 2),
    ),
    [databaseView, setDatabaseView] = useState<DatabaseView>(
      (spec.record?.properties.view as DatabaseView) || {},
    ),
    [recordQuery, setRecordQuery] = useState("");
  const [title, setTitle] = useState(spec.record?.title || ""),
    [body, setBody] = useState(spec.record?.body || ""),
    [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshKey, setRefreshKey] = useState(0);
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
    void api()
      .workspaces()
      .then(setWorkspaces)
      .catch((e) => setError(String(e)));
    return api().on("library-changed", () => setRefreshKey((k) => k + 1));
  }, []);
  useEffect(() => {
    if (record?.properties.sourceType) return;
    void api().tabAction("content-state", {
      viewId,
      dirty,
      title: title || "Untitled",
      recordId: record?.id,
    });
  }, [viewId, dirty, title, record?.id]);
  useEffect(() => {
    if (!visible || !workspaceId || section !== "record") return;
    let cancelled = false;
    void invoke<Project[]>("workspace_projects", {}, workspaceId)
      .then((p) => {
        if (!cancelled) setProjects(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [invoke, workspaceId, visible, section, refreshKey]);
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
      await api().tabAction("content-saved", { viewId, recordId: saved.id });
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
  const renameProperty = async (name: string, newName: string) => {
    if (!workspaceId || !record || busy)
      throw new Error("This item is busy. Try again shortly.");
    if (
      Object.prototype.hasOwnProperty.call(JSON.parse(propertiesText), newName)
    ) {
      throw new Error(
        "This draft already has that property. Choose a different name.",
      );
    }
    setBusy(true);
    try {
      const result = await invoke<{
        attribute?: {
          type?: string;
          options?: string[];
          formula?: string;
        } | null;
      }>("workspace_rename_attribute", { name, newName }, workspaceId);
      // Rebase only the revision caused by this rename, never unrelated concurrent edits.
      if (record.id) {
        const fresh = await invoke<RecordItem>(
          "workspace_record",
          { id: record.id },
          workspaceId,
        );
        const affected =
          Object.prototype.hasOwnProperty.call(record.properties, name) ||
          (record.kind === "database" &&
            (record.properties.view as DatabaseView | undefined)?.property ===
              name);
        if (!fresh || fresh.revision !== record.revision + (affected ? 1 : 0)) {
          throw new Error(
            "Property renamed, but this item also changed elsewhere. Your draft is preserved; reopen the item before saving it.",
          );
        }
        setRecord(fresh);
      }
      setPropertiesText((text) => {
        const next = JSON.parse(text);
        if (Object.prototype.hasOwnProperty.call(next, name)) {
          next[newName] = next[name];
          delete next[name];
        }
        if (next.view?.property === name)
          next.view = { ...next.view, property: newName };
        return JSON.stringify(next);
      });
      setDatabaseView((view) =>
        view.property === name ? { ...view, property: newName } : view,
      );
      setMessage("Property renamed");
      return result;
    } finally {
      setBusy(false);
    }
  };
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId),
    selectedProject = projects.find((p) => p.id === projectId);
  const openIds = new Set(
    tabs.tabs.flatMap((t) =>
      t.views.map((v) => (v.id.startsWith("pdf:") ? v.id.slice(4) : v.id)),
    ),
  );
  return (
    <main
      ref={host}
      className="key-shell-content"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          host.current
            ?.querySelector<HTMLButtonElement>("[data-save-record]")
            ?.click();
        }
      }}
    >
      {error && (
        <div className="key-shell-error" role="alert">
          {error}
          <Button onClick={() => setError("")}>Dismiss</Button>
        </div>
      )}
      {section === "record" && record && !!record.properties.sourceType && (
        <EntryDetails
          embedded
          entry={record}
          invoke={invoke}
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => {}}
          onSaved={() => {
            setRefreshKey((k) => k + 1);
            void api().tabAction("content-saved", {
              viewId,
              recordId: record.id,
            });
          }}
          onState={(dirty, title) => {
            void api().tabAction("content-state", {
              viewId,
              dirty,
              title,
              recordId: record.id,
            });
          }}
        />
      )}
      {section === "record" && record && !record.properties.sourceType && (
        <section className="key-record-editor">
          <div className="key-record-top">
            <span>
              {selectedWorkspace?.name} / {selectedProject?.name || "Pages"} /{" "}
              {record.kind}
            </span>
            <Button
              variant="primary"
              data-save-record
              disabled={busy || !title.trim()}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : dirty ? "Save changes" : "Save"}
            </Button>
          </div>
          <Input
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
                  <Select
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
                  </Select>
                </label>
                <label>
                  Text contains
                  <Input
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
                  <Input
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
                  <Input
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
                  active={visible}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  view={databaseView}
                  onSelect={selectRecord}
                  revision={refreshKey}
                />
              )}
              <p className="key-sidebar-hint">
                A saved database is a filtered view of workspace items. Formula
                properties can be calculated explicitly; relation rollups are
                planned.
              </p>
            </>
          ) : (
            <Textarea
              aria-label="Page content"
              placeholder="Start writing…"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty(true);
              }}
            />
          )}
          <RecordProperties
            value={JSON.parse(propertiesText)}
            workspaceId={workspaceId}
            invoke={invoke}
            disabled={busy}
            onRename={renameProperty}
            onChange={(next) => {
              setPropertiesText(JSON.stringify(next));
              setDirty(true);
            }}
          />
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
                  <Button
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
                  </Button>
                  <Button
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
                  </Button>
                </div>
              ))}
            </details>
          )}
        </section>
      )}
      {section === "records" && workspaceId && (
        <section className="key-record-editor">
          <h1>All items & linked files</h1>
          <Input
            aria-label="Search workspace records"
            placeholder="Search file metadata, notes and pages"
            value={recordQuery}
            onChange={(e) => setRecordQuery(e.target.value)}
          />
          <WorkspaceRecordTable
            active={visible}
            workspaceId={workspaceId}
            projectId={projectId}
            view={{ query: recordQuery }}
            onSelect={selectRecord}
            revision={refreshKey}
          />
        </section>
      )}
      {section === "sources" && (
        <div
          style={{
            display: section === "sources" ? "flex" : "none",
            flex: 1,
            minHeight: 0,
          }}
        >
          <LibraryHome
            active={visible}
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
                : setError("Choose a destination workspace before adding PDFs.")
            }
            onOpenItem={(item) => selectRecord(item as RecordItem)}
            activePreview={
              tabs.searchPreview?.sourceViewId === viewId
                ? tabs.searchPreview.hit
                : undefined
            }
            onDismissSearch={() =>
              action("preview-dismiss", { sourceViewId: viewId })
            }
            onOpenSource={(source, hit, results, query) =>
              void task(() =>
                hit
                  ? api().tabAction("preview-result", {
                      sourceViewId: viewId,
                      source,
                      hit,
                      results,
                      query,
                    })
                  : api().openSource(source),
              )
            }
            refreshKey={refreshKey}
          />
        </div>
      )}
    </main>
  );
}
