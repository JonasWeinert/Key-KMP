import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import {
  KIND_ICON,
  KIND_LABEL,
  bridge,
  relativeDate,
  shortCreators,
  snippetParts,
  type Collection,
  type Facets,
  type Invoke,
  type LibraryStatus,
  type SearchHit,
  type SearchResult,
  type Source,
  type SourcePage,
} from "./library-api";
import { SOURCE_DRAG_TYPE, currentSelection, libraryChanged, onLibraryChanged, onLibrarySelection, selectLibrary } from "./library-nav";
import SourceInspector, { indexLabel } from "./SourceInspector";
import {
  AgentFillSheet,
  IdentifierSheet,
  PropertySheet,
  TagManagerSheet,
  formulaValue,
  usePropertyDefinitions,
  type PropertyDefinition,
  type PropertySheetState,
} from "./PropertySheets";
import "./reference-library.css";

const PAGE = 300;
const ROW = 58;
const SCOPES: [string, string][] = [
  ["all", "All"],
  ["starred", "Starred"],
  ["unfiled", "Unfiled"],
  ["attention", "Needs attention"],
  ["trashed", "Trash"],
];
const SORTS: [string, string][] = [
  ["added", "Date added"],
  ["title", "Title"],
  ["creator", "First author"],
  ["year", "Year"],
  ["container", "Journal / container"],
  ["updated", "Last modified"],
];

export interface OpenHit {
  source: Source | SearchHit;
  passage: { id: string; page: number | null };
  results: { id: string; documentHash: string; documentTitle: string; page: number | null }[];
  query: string;
}

export default function ReferenceLibrary({
  invoke,
  workspaceId,
  workspaceName,
  active,
  refreshKey,
  onOpen,
  onOpenHit,
}: {
  invoke: Invoke;
  workspaceId: string;
  workspaceName: string;
  active: boolean;
  refreshKey: number;
  onOpen: (source: Source) => void;
  onOpenHit: (hit: OpenHit) => void;
}) {
  const initial = currentSelection(workspaceId);
  const [collectionId, setCollectionId] = useState<string | undefined>(initial?.collectionId);
  const [scope, setScope] = useState(initial?.scope ?? "all");
  const [kind, setKind] = useState<string>();
  const [tag, setTag] = useState<string>();
  const [sort, setSort] = useState("added");
  const [descending, setDescending] = useState(true);
  const [text, setText] = useState("");
  const [filterText, setFilterText] = useState("");
  const [items, setItems] = useState<Source[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<SourcePage["counts"]>();
  const [facets, setFacets] = useState<Facets>({ tags: [], itemTypes: [], kinds: [], years: [] });
  const [collections, setCollections] = useState<Collection[]>([]);
  const [status, setStatus] = useState<LibraryStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string>();
  const [anchor, setAnchor] = useState<string>();
  const [inspector, setInspector] = useState<Source>();
  const [search, setSearch] = useState<{ query: string; result?: SearchResult; busy: boolean }>();
  const [dropping, setDropping] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => void }>();
  const { definitions, reload: reloadDefinitions } = usePropertyDefinitions(invoke, workspaceId);
  const [sheet, setSheet] = useState<PropertySheetState>();
  const [agent, setAgent] = useState<{ targets: Source[]; name?: string }>();
  const [tagManager, setTagManager] = useState(false);
  const [identifier, setIdentifier] = useState(false);
  const [view, setView] = useState<"list" | "table">(() => {
    try {
      return localStorage.getItem("key.library.view") === "table" ? "table" : "list";
    } catch {
      return "list";
    }
  });
  const [visibleProperties, setVisibleProperties] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`key.library.columns:${workspaceId}`) || "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("key.library.view", view);
      localStorage.setItem(`key.library.columns:${workspaceId}`, JSON.stringify(visibleProperties));
    } catch {}
  }, [view, visibleProperties, workspaceId]);
  const tableColumns = definitions.filter((d) => visibleProperties.includes(d.name));
  const listRef = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const loadingMore = useRef(false);
  const virtualizerRef = useRef<{ measure: () => void } | null>(null);

  // Sidebar selection drives the collection and scope.
  useEffect(
    () =>
      onLibrarySelection((s) => {
        if (s.workspaceId !== workspaceId) return;
        setCollectionId(s.collectionId);
        setScope(s.scope ?? "all");
        setSearch(undefined);
      }),
    [workspaceId],
  );
  useEffect(() => {
    if (!active) return;
    try {
      localStorage.setItem("key.library.last", workspaceId);
    } catch {}
  }, [active, workspaceId]);
  useEffect(() => {
    const t = setTimeout(() => setFilterText(text), 160);
    return () => clearTimeout(t);
  }, [text]);

  const query = useMemo(
    () => ({ collectionId: collectionId ?? null, scope, kind: kind ?? null, tag: tag ?? null, text: filterText || null, sort, descending }),
    [collectionId, scope, kind, tag, filterText, sort, descending],
  );

  const load = useCallback(
    async (offset = 0) => {
      const id = ++request.current;
      if (!offset) setLoading(true);
      try {
        const [page, nextFacets] = await Promise.all([
          invoke<SourcePage>("store_sources", { ...query, offset, limit: PAGE }, workspaceId),
          offset ? Promise.resolve(undefined) : invoke<Facets>("store_facets", { ...query, kind: null, tag: null }, workspaceId),
        ]);
        if (id !== request.current) return;
        setItems((previous) => (offset ? [...previous, ...page.items] : page.items));
        setTotal(page.total);
        setCounts(page.counts);
        if (nextFacets) setFacets(nextFacets);
        setError("");
      } catch (e) {
        if (id === request.current) setError(String(e));
      } finally {
        if (id === request.current) setLoading(false);
        loadingMore.current = false;
      }
    },
    [invoke, query, workspaceId],
  );
  const loadCollections = useCallback(() => {
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
  }, [invoke, workspaceId]);

  useEffect(() => {
    if (!active) return;
    void load(0);
  }, [load, active, refreshKey]);
  useEffect(() => {
    if (!active) return;
    loadCollections();
    return onLibraryChanged(() => {
      loadCollections();
      reloadDefinitions();
      void load(0);
    });
  }, [active, loadCollections, load, reloadDefinitions]);
  // Definitions can change in other tabs or through the agent; refresh when the inspector opens.
  useEffect(() => {
    if (active && focusId) reloadDefinitions();
  }, [active, focusId, reloadDefinitions]);

  // Indexing progress: poll while anything is in flight, refresh visible statuses gently.
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let ticks = 0;
    const poll = async () => {
      try {
        const next = await invoke<LibraryStatus>("store_status", {}, workspaceId);
        if (stopped) return;
        setStatus(next);
        if ((next.busy || next.counts.indexing > 0) && ++ticks % 4 === 0 && !search) {
          const page = await invoke<SourcePage>("store_sources", { ...query, offset: 0, limit: Math.max(PAGE, items.length) }, workspaceId);
          if (!stopped) {
            setItems(page.items);
            setCounts(page.counts);
          }
        }
      } catch {}
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, invoke, workspaceId, query, search, items.length]);

  // Keep the inspector in step with the focused row.
  useEffect(() => {
    if (!focusId) return setInspector(undefined);
    const row = items.find((s) => s.id === focusId);
    if (row) setInspector(row);
  }, [focusId, items]);

  useEffect(() => {
    virtualizerRef.current?.measure();
  }, [view]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => (view === "table" ? 36 : ROW),
    overscan: 12,
  });
  virtualizerRef.current = virtualizer;
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems.at(-1);
    if (last && last.index > items.length - 40 && items.length < total && !loadingMore.current) {
      loadingMore.current = true;
      void load(items.length);
    }
  }, [virtualItems, items.length, total, load]);

  const runSearch = async (value: string) => {
    if (!value.trim()) return setSearch(undefined);
    setSearch({ query: value, busy: true });
    try {
      const result = await invoke<SearchResult>(
        "store_search",
        { text: value, collectionId: collectionId ?? null, scope: scope === "trashed" ? "trashed" : "all", kind: kind ?? null, tag: tag ?? null, limit: 60, passagesPerSource: 3 },
        workspaceId,
      );
      setSearch({ query: value, result, busy: false });
    } catch (e) {
      setSearch(undefined);
      setError(String(e));
    }
  };

  const updateSource = (source: Source) => {
    setItems((list) => list.map((s) => (s.id === source.id ? source : s)));
    setInspector(source);
  };
  const selection = selected.size ? [...selected] : focusId ? [focusId] : [];
  const select = (id: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (event.shiftKey && anchor) {
      const a = items.findIndex((s) => s.id === anchor);
      const b = items.findIndex((s) => s.id === id);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelected(new Set(items.slice(from, to + 1).map((s) => s.id)));
    } else if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected);
      if (!next.size && focusId) next.add(focusId);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelected(next);
      setAnchor(id);
    } else {
      setSelected(new Set());
      setAnchor(id);
    }
    setFocusId(id);
  };
  const move = (delta: number, extend: boolean) => {
    const index = Math.max(0, Math.min(items.length - 1, items.findIndex((s) => s.id === focusId) + delta));
    const next = items[index];
    if (!next) return;
    if (extend) {
      const set = new Set(selected.size ? selected : focusId ? [focusId] : []);
      set.add(next.id);
      setSelected(set);
    } else {
      setSelected(new Set());
      setAnchor(next.id);
    }
    setFocusId(next.id);
    virtualizer.scrollToIndex(index, { align: "auto" });
  };

  const trash = async (ids: string[], trashed = true) => {
    await invoke("store_trash", { ids, trashed }, workspaceId);
    // Restoring brings the items back selected, so the inspector reopens where it was.
    setSelected(trashed || ids.length === 1 ? new Set() : new Set(ids));
    setFocusId(trashed ? undefined : ids[0]);
    await load(0);
    libraryChanged();
    setToast({
      text: trashed ? `Moved ${ids.length} ${ids.length === 1 ? "item" : "items"} to Trash` : `Restored ${ids.length}`,
      undo: trashed ? () => void trash(ids, false) : undefined,
    });
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const open = (source: Source) => {
    if (source.trashedAt) return;
    if (source.filePath && source.kind === "pdf") onOpen(source);
    else if (source.filePath) void bridge().openPath(source.filePath).catch((e) => setError(String(e)));
    else if (source.url) window.open(source.url, "_blank");
    else if (source.doi) window.open(`https://doi.org/${source.doi}`, "_blank");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Enter" && focusId) {
      const source = items.find((s) => s.id === focusId);
      if (source) open(source);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(items.map((s) => s.id)));
    } else if ((e.key === "Backspace" || e.key === "Delete") && selection.length && scope !== "trashed") {
      e.preventDefault();
      void trash(selection);
    } else if (e.key === "Escape") {
      if (selected.size) setSelected(new Set());
      else if (search) setSearch(undefined);
      else setFocusId(undefined);
    }
  };
  useEffect(() => {
    if (!active) return;
    const focusSearch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [active]);

  const importDropped = async (files: FileList) => {
    const paths = [...files].map((f) => bridge().pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    try {
      await bridge().importPaths(workspaceId, paths, collectionId);
      await load(0);
      libraryChanged();
      setToast({ text: `Added ${paths.length} ${paths.length === 1 ? "source" : "sources"}` });
    } catch (e) {
      setError(String(e));
    }
  };

  const collectionName = collections.find((c) => c.id === collectionId)?.name;
  const title = scope === "trashed" ? "Trash" : collectionName ?? (scope === "starred" ? "Starred" : scope === "unfiled" ? "Unfiled" : scope === "attention" ? "Needs attention" : "All sources");
  const model = status?.model;
  const indexing = status?.counts.indexing ?? 0;

  return (
    <section
      className={`kx-library ${dropping ? "dropping" : ""}`}
      aria-label="Library"
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void importDropped(e.dataTransfer.files);
        }
      }}
    >
      <div className="kx-library-main">
        <header className="kx-page-head">
          <div className="kx-page-title">
            <div className="key-library-breadcrumb">{workspaceName}{collectionName ? " · Collection" : ""}</div>
            <h1>{title}</h1>
          </div>
          <div className="kx-page-actions">
            <form
              className="kx-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch(text);
              }}
            >
              <Icon name="search" size={14} />
              <input
                ref={searchInput}
                className="kx-search-input"
                aria-label="Search the library"
                placeholder="Filter, or ↵ to search full text"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (!e.target.value) setSearch(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setText("");
                    setSearch(undefined);
                  }
                }}
              />
              {!text && <kbd aria-hidden="true">⌘F</kbd>}
            </form>
            <AddMenu
              onFiles={() =>
                void bridge()
                  .addFiles(workspaceId, collectionId)
                  .then((created) => {
                    if (created.length) {
                      void load(0);
                      libraryChanged();
                    }
                  })
                  .catch((e) => setError(String(e)))
              }
              onBlank={async () => {
                const source = await invoke<Source>("store_create", { source: { kind: "reference", itemType: "article", title: "", collections: collectionId ? [collectionId] : [] } }, workspaceId);
                await load(0);
                setFocusId(source.id);
                setInspector(source);
              }}
              onIdentifier={() => setIdentifier(true)}
              onZotero={async () => {
                setToast({ text: "Importing your Zotero library…" });
                try {
                  const { workspace, report } = await bridge().importZotero();
                  setToast({ text: `Imported ${report.items.toLocaleString()} items from Zotero into “${workspace.name}”` });
                  selectLibrary({ workspaceId: workspace.id });
                  libraryChanged();
                } catch (e) {
                  setError(String(e));
                }
              }}
            />
          </div>
        </header>

        {!search && (
        <div className="kx-filter-bar">
          <div className="kx-scopes" role="group" aria-label="Library views">
            {SCOPES.map(([value, label]) => {
              const count = value === "all" ? counts?.all : value === "trashed" ? counts?.trashed : value === "starred" ? counts?.starred : value === "unfiled" ? counts?.unfiled : counts?.attention;
              if (value !== "all" && value !== "trashed" && !count && scope !== value) return null;
              return (
                <button key={value} aria-pressed={scope === value} onClick={() => { setScope(value); setSearch(undefined); }}>
                  {label}
                  {!!count && <span className="kx-count">{count.toLocaleString()}</span>}
                </button>
              );
            })}
          </div>
          <div className="kx-controls-end">
            <label className="kx-control kx-control-select" title="Sort">
              <Icon name="sort" size={14} />
              <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="kx-control" title={descending ? "Descending" : "Ascending"} aria-label="Toggle sort direction" onClick={() => setDescending(!descending)}>
              <Icon name="chevronDown" size={13} style={{ transform: descending ? undefined : "rotate(180deg)" }} />
            </button>
            {view === "table" && (
              <details className="kx-menu">
                <summary className="kx-control" title="Columns">
                  <Icon name="columns" size={14} />
                  Columns
                </summary>
                <div className="kx-menu-popover kx-columns-popover">
                  {definitions.map((d) => (
                    <label key={d.name}>
                      <input
                        type="checkbox"
                        checked={visibleProperties.includes(d.name)}
                        onChange={(e) =>
                          setVisibleProperties((list) => (e.target.checked ? [...list, d.name] : list.filter((n) => n !== d.name)))
                        }
                      />
                      <span>{d.name}</span>
                      <button
                        title="Edit property"
                        onClick={(e) => {
                          e.preventDefault();
                          setSheet({ mode: "edit", definition: d, targets: [] });
                        }}
                      >
                        <Icon name="chevronRight" size={11} />
                      </button>
                    </label>
                  ))}
                  {!!definitions.length && <hr />}
                  <button onClick={() => setSheet({ mode: "new", targets: [] })}>
                    <Icon name="plus" size={13} /> New property…
                  </button>
                </div>
              </details>
            )}
            <div className="kx-segmented" role="group" aria-label="Layout">
              {(["list", "table"] as const).map((v) => (
                <button key={v} aria-pressed={view === v} aria-label={v === "table" ? "Table" : "List"} title={v === "table" ? "Table" : "List"} onClick={() => setView(v)}>
                  <Icon name={v === "table" ? "table" : "list"} size={15} />
                </button>
              ))}
            </div>
          </div>
        </div>
        )}
        {!search && (facets.kinds.length > 1 || facets.tags.length > 0) && (
          <div className="kx-facet-bar">
            {facets.kinds.length > 1 &&
              facets.kinds.map((k) => (
                <button key={k.value} className="kx-facet" aria-pressed={kind === k.value} onClick={() => setKind(kind === k.value ? undefined : k.value)}>
                  <Icon name={KIND_ICON[k.value] ?? "doc"} size={12} />
                  {KIND_LABEL[k.value] ?? k.value}
                  <span>{k.count.toLocaleString()}</span>
                </button>
              ))}
            {facets.tags.length > 0 && <TagPicker tags={facets.tags} value={tag} onChange={setTag} onManage={() => setTagManager(true)} />}
          </div>
        )}
        {model && model.state !== "ready" && (
          <div className="kx-banner" role="status">
            <Icon name="sparkle" size={14} />
            {model.state === "downloading" ? (
              <>
                <span>Downloading the on-device search model · {Math.round(model.received / 1e6)} of {Math.round(model.total / 1e6)} MB</span>
                <div className="kx-meter">
                  <span style={{ width: `${model.total ? Math.round((model.received / model.total) * 100) : 0}%` }} />
                </div>
              </>
            ) : model.state === "failed" ? (
              <span>The search model could not be downloaded ({model.error}). Keyword search still works; Key retries automatically.</span>
            ) : (
              <span>Preparing on-device semantic search…</span>
            )}
          </div>
        )}
        {error && (
          <div className="kx-banner kx-banner-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}

        {search ? (
          <SearchResults
            search={search}
            onBack={() => setSearch(undefined)}
            onSelect={(id) => setFocusId(id)}
            focusId={focusId}
            onOpenPassage={(hit, passage) =>
              onOpenHit({
                source: hit,
                passage,
                query: search.query,
                results: (search.result?.hits ?? []).flatMap((h) =>
                  h.passages.filter((p) => p.page !== null).map((p) => ({ id: p.id, documentHash: h.documentHash, documentTitle: h.title, page: p.page })),
                ),
              })
            }
            items={items}
          />
        ) : (
          <div className="kx-list" ref={listRef} tabIndex={0} role="listbox" aria-label={`${title}, ${total} items`} aria-multiselectable>
            {!loading && !items.length ? (
              <EmptyState scope={scope} filtered={!!(filterText || kind || tag)} onAdd={() => void bridge().addFiles(workspaceId, collectionId).then(() => void load(0))} />
            ) : (
              <>
              {view === "table" && (
                <div className="kx-table-head" style={{ gridTemplateColumns: tableGrid(tableColumns.length) }}>
                  {[["title", "Title"], ["creator", "Authors"], ["year", "Year"], ["container", "Journal / container"], ["added", "Added"]].map(([key, label]) => (
                    <button key={key} data-sorted={sort === key} onClick={() => (sort === key ? setDescending(!descending) : setSort(key))}>
                      {label}
                      {sort === key && <Icon name="chevronDown" size={10} style={{ transform: descending ? undefined : "rotate(180deg)" }} />}
                    </button>
                  ))}
                  {tableColumns.map((d) => (
                    <button key={d.name} onClick={() => setSheet({ mode: "edit", definition: d, targets: [] })} title="Edit property">
                      {d.name}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualItems.map((row) => {
                  const source = items[row.index];
                  if (!source) return null;
                  const isSelected = selected.has(source.id) || (!selected.size && focusId === source.id);
                  if (view === "table")
                    return (
                      <TableRow
                        key={source.id}
                        source={source}
                        top={row.start}
                        selected={isSelected}
                        columns={tableColumns}
                        grid={tableGrid(tableColumns.length)}
                        onPointer={(e) => select(source.id, e)}
                        onOpen={() => open(source)}
                        onCommit={(name, value) =>
                          void invoke<Source>("store_update", { id: source.id, patch: { properties: { [name]: value } } }, workspaceId).then(updateSource)
                        }
                        dragIds={() => (selected.has(source.id) ? [...selected] : [source.id])}
                      />
                    );
                  return (
                    <SourceRow
                      key={source.id}
                      source={source}
                      top={row.start}
                      selected={isSelected}
                      focused={focusId === source.id}
                      onPointer={(e) => select(source.id, e)}
                      onOpen={() => open(source)}
                      onStar={() =>
                        void invoke<Source>("store_update", { id: source.id, patch: { starred: !source.starred } }, workspaceId).then(updateSource)
                      }
                      dragIds={() => (selected.has(source.id) ? [...selected] : [source.id])}
                    />
                  );
                })}
              </div>
              </>
            )}
          </div>
        )}
        <footer className="kx-status-bar">
          <span>
            {search ? `${search.result?.hits.length ?? 0} matching sources` : `${total.toLocaleString()} ${total === 1 ? "item" : "items"}`}
            {selected.size > 1 ? ` · ${selected.size} selected` : ""}
          </span>
          <span className="kx-spacer" />
          {indexing > 0 ? (
            <span className="kx-status-indexing">
              <span className="kx-status-dot" data-tone="busy" />
              Indexing {indexing.toLocaleString()} {indexing === 1 ? "source" : "sources"}
            </span>
          ) : status ? (
            <span>
              <span className="kx-status-dot" data-tone="ready" /> {status.counts.ready.toLocaleString()} searchable
            </span>
          ) : null}
        </footer>

        {selected.size > 1 && (
          <BulkBar
            count={selected.size}
            collections={collections}
            trashed={scope === "trashed"}
            onTag={async (tagName) => {
              await invoke("store_bulk_tag", { ids: [...selected], add: [tagName] }, workspaceId);
              await load(0);
            }}
            onCollect={async (id) => {
              await invoke("store_membership", { collectionId: id, ids: [...selected], present: true }, workspaceId);
              libraryChanged();
              setToast({ text: `Added ${selected.size} to ${collections.find((c) => c.id === id)?.name}` });
            }}
            onStar={async () => {
              for (const id of selected) await invoke("store_update", { id, patch: { starred: true } }, workspaceId);
              await load(0);
            }}
            definitions={definitions}
            onSetProperty={(definition) => {
              const targets = items.filter((s) => selected.has(s.id));
              setSheet(definition ? { mode: "edit", definition, targets, applyValue: true } : { mode: "new", targets });
            }}
            onFill={() => setAgent({ targets: items.filter((s) => selected.has(s.id)) })}
            onTrash={() => void trash([...selected], scope !== "trashed")}
            onDelete={async () => {
              if (!window.confirm(`Delete ${selected.size} items permanently? Linked files stay on disk.`)) return;
              await invoke("store_delete", { ids: [...selected] }, workspaceId);
              setSelected(new Set());
              await load(0);
            }}
            onClear={() => setSelected(new Set())}
          />
        )}
        {toast && (
          <div className="kx-toast" role="status">
            <span>{toast.text}</span>
            {toast.undo && <button onClick={() => { toast.undo?.(); setToast(undefined); }}>Undo</button>}
          </div>
        )}
        {dropping && (
          <div className="kx-drop-overlay">
            <Icon name="upload" size={28} />
            <strong>Drop to add to {collectionName ?? workspaceName}</strong>
            <span>PDFs, web pages, videos, audio and images are linked where they are.</span>
          </div>
        )}
      </div>
      {inspector && (
        <SourceInspector
          key={inspector.id}
          source={inspector}
          invoke={invoke}
          workspaceId={workspaceId}
          collections={collections}
          tagSuggestions={facets.tags}
          onChanged={(source) => {
            updateSource(source);
            if (source.collections.length !== inspector.collections.length || source.tags.join("\n") !== inspector.tags.join("\n")) libraryChanged();
          }}
          onOpen={open}
          onClose={() => setFocusId(undefined)}
          definitions={definitions}
          onPropertySheet={setSheet}
          onAgentFill={(name) => setAgent({ targets: [inspector], name })}
          onDownload={async () => {
            const lookup = await invoke<{ fullTextUrl?: string | null }>("scholarly_lookup_resource", { resource: inspector.doi || inspector.url }, workspaceId);
            if (!lookup.fullTextUrl) throw Error("No open-access PDF was found for this reference.");
            updateSource(await invoke<Source>("library_download_pdf", { url: lookup.fullTextUrl, sourceId: inspector.id }, workspaceId));
          }}
        />
      )}
      {sheet && (
        <PropertySheet
          state={sheet}
          invoke={invoke}
          workspaceId={workspaceId}
          definitions={definitions}
          onClose={() => setSheet(undefined)}
          onSaved={() => {
            reloadDefinitions();
            void load(0);
          }}
        />
      )}
      {agent && (
        <AgentFillSheet
          invoke={invoke}
          workspaceId={workspaceId}
          targets={agent.targets}
          propertyName={agent.name}
          onClose={() => setAgent(undefined)}
          onSaved={() => {
            reloadDefinitions();
            void load(0);
          }}
        />
      )}
      {tagManager && (
        <TagManagerSheet
          invoke={invoke}
          workspaceId={workspaceId}
          onClose={() => setTagManager(false)}
          onSaved={() => void load(0)}
        />
      )}
      {identifier && (
        <IdentifierSheet
          invoke={invoke}
          workspaceId={workspaceId}
          collectionId={collectionId}
          onClose={() => setIdentifier(false)}
          onAdded={(source) => {
            void load(0);
            setFocusId(source.id);
            setInspector(source);
            libraryChanged();
          }}
        />
      )}
    </section>
  );
}

function SourceRow({
  source,
  top,
  selected,
  focused,
  onPointer,
  onOpen,
  onStar,
  dragIds,
}: {
  source: Source;
  top: number;
  selected: boolean;
  focused: boolean;
  onPointer: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onStar: () => void;
  dragIds: () => string[];
}) {
  const status = indexLabel(source);
  const meta = [shortCreators(source.creators), source.year, source.containerShort || source.containerTitle].filter(Boolean).join(" · ");
  return (
    <div
      className="kx-row"
      role="option"
      aria-selected={selected}
      data-focused={focused}
      data-trashed={!!source.trashedAt}
      style={{ transform: `translateY(${top}px)` }}
      onMouseDown={onPointer}
      onDoubleClick={onOpen}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify(dragIds()));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <span className="kx-row-kind" data-kind={source.kind}>
        <Icon name={KIND_ICON[source.kind] ?? "doc"} size={15} />
      </span>
      <span className="kx-row-text">
        <strong>{source.title || "Untitled"}</strong>
        <span>{meta || <em>No details yet</em>}</span>
      </span>
      <span className="kx-row-end">
        {(source.noteCount > 0 || source.annotationCount > 0) && (
          <span className="kx-row-badge" title={`${source.noteCount} notes, ${source.annotationCount} highlights`}>
            <Icon name="note" size={11} />
            {source.noteCount + source.annotationCount}
          </span>
        )}
        {source.indexStatus !== "skipped" && source.indexStatus !== "ready" && (
          <span className="kx-row-status" title={status.label}>
            <span className="kx-status-dot" data-tone={status.tone} />
          </span>
        )}
        <span className="kx-row-date">{relativeDate(source.addedAt)}</span>
        <button
          className="kx-row-star"
          data-on={source.starred}
          aria-label={source.starred ? "Unstar" : "Star"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onStar}
        >
          <Icon name="star" size={13} fill={source.starred ? "currentColor" : "none"} />
        </button>
      </span>
    </div>
  );
}

const tableGrid = (properties: number) =>
  `minmax(220px, 3fr) minmax(120px, 1.3fr) 56px minmax(120px, 1.2fr) 92px${" minmax(110px, 1fr)".repeat(properties)}`;

function TableRow({
  source,
  top,
  selected,
  columns,
  grid,
  onPointer,
  onOpen,
  onCommit,
  dragIds,
}: {
  source: Source;
  top: number;
  selected: boolean;
  columns: PropertyDefinition[];
  grid: string;
  onPointer: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onCommit: (name: string, value: unknown) => void;
  dragIds: () => string[];
}) {
  const [editing, setEditing] = useState<string>();
  return (
    <div
      className="kx-table-row"
      role="option"
      aria-selected={selected}
      style={{ transform: `translateY(${top}px)`, gridTemplateColumns: grid }}
      onMouseDown={onPointer}
      onDoubleClick={onOpen}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify(dragIds()));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <span className="kx-cell-title">
        <span className="kx-row-kind kx-row-kind-small" data-kind={source.kind}>
          <Icon name={KIND_ICON[source.kind] ?? "doc"} size={12} />
        </span>
        <span>{source.title || "Untitled"}</span>
      </span>
      <span>{shortCreators(source.creators)}</span>
      <span className="kx-cell-number">{source.year ?? ""}</span>
      <span>{source.containerShort || source.containerTitle || ""}</span>
      <span className="kx-cell-muted">{relativeDate(source.addedAt)}</span>
      {columns.map((d) => {
        const raw = source.properties[d.name];
        const text = d.type === "formula" ? formulaValue(d, source) : raw === undefined || raw === null ? "" : d.type === "boolean" ? (raw ? "✓" : "") : String(raw);
        if (editing === d.name && d.type !== "formula") {
          const done = (value: unknown) => {
            setEditing(undefined);
            if (value !== raw) onCommit(d.name, value);
          };
          return d.type === "select" || d.type === "boolean" ? (
            <select
              key={d.name}
              autoFocus
              className="kx-cell-editor"
              defaultValue={String(raw ?? "")}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => done(d.type === "boolean" ? e.target.value === "true" : e.target.value || null)}
              onBlur={() => setEditing(undefined)}
            >
              <option value="">—</option>
              {(d.type === "boolean" ? ["true", "false"] : d.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {d.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
                </option>
              ))}
            </select>
          ) : (
            <input
              key={d.name}
              autoFocus
              className="kx-cell-editor"
              defaultValue={String(raw ?? "")}
              inputMode={d.type === "number" ? "decimal" : undefined}
              onMouseDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const next = e.target.value.trim();
                done(next === "" ? null : d.type === "number" && Number.isFinite(Number(next)) ? Number(next) : next);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(undefined);
              }}
            />
          );
        }
        return (
          <span
            key={d.name}
            className={`kx-cell-property ${d.type === "formula" ? "computed" : ""}`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (d.type !== "formula") setEditing(d.name);
            }}
            title={d.type === "formula" ? "Calculated" : "Double-click to edit"}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
}

function SearchResults({
  search,
  items,
  focusId,
  onBack,
  onSelect,
  onOpenPassage,
}: {
  search: { query: string; result?: SearchResult; busy: boolean };
  items: Source[];
  focusId?: string;
  onBack: () => void;
  onSelect: (id: string) => void;
  onOpenPassage: (hit: SearchHit, passage: { id: string; page: number | null }) => void;
}) {
  const result = search.result;
  return (
    <div className="kx-results">
      <div className="kx-results-head">
        <button className="kx-link-button" onClick={onBack}>
          <Icon name="chevronRight" size={12} style={{ transform: "scaleX(-1)" }} /> Library
        </button>
        <span>
          {search.busy
            ? "Searching…"
            : `${result?.hits.length ?? 0} sources for “${search.query}”${result?.semantic ? " · meaning + keywords" : " · keywords"}`}
        </span>
      </div>
      {search.busy && (
        <div className="kx-results-loading">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="kx-skeleton-line" />
          ))}
        </div>
      )}
      {!search.busy && result && !result.hits.length && <p className="kx-results-empty">Nothing matched. Try other words or a broader collection.</p>}
      {result?.hits.map((hit) => {
        const source = items.find((s) => s.id === hit.sourceId);
        return (
          <article key={hit.sourceId} className="kx-result" data-focused={focusId === hit.sourceId}>
            <button className="kx-result-title" onClick={() => onSelect(hit.sourceId)}>
              <strong>{hit.title || "Untitled"}</strong>
              {source && <span>{[shortCreators(source.creators), source.year, source.containerTitle].filter(Boolean).join(" · ")}</span>}
              {hit.metadataMatch && !hit.passages.length && <span className="kx-result-why">Matched title, authors or notes</span>}
            </button>
            {hit.passages.map((passage) => (
              <button
                key={passage.id}
                className="kx-passage"
                disabled={passage.page === null}
                title={passage.page === null ? "From the abstract" : `Open page ${passage.page + 1}`}
                onClick={() => passage.page !== null && onOpenPassage(hit, passage)}
              >
                <span className="kx-passage-page">{passage.page === null ? "Abstract" : `p. ${passage.page + 1}`}</span>
                <span className="kx-passage-text">
                  {snippetParts(passage.snippet).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
                </span>
              </button>
            ))}
          </article>
        );
      })}
    </div>
  );
}

function AddMenu({ onFiles, onBlank, onIdentifier, onZotero }: { onFiles: () => void; onBlank: () => void; onIdentifier: () => void; onZotero: () => void }) {
  return (
    <div className="kx-add">
      <button className="kx-button-primary" onClick={onFiles}>
        <Icon name="plus" size={14} />
        Add
      </button>
      <details className="kx-menu">
        <summary aria-label="More ways to add">
          <Icon name="chevronDown" size={12} />
        </summary>
        <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
          <button onClick={onFiles}>
            <Icon name="upload" size={13} /> Add files…
          </button>
          <button onClick={onIdentifier}>
            <Icon name="search" size={13} /> Add by DOI, ISBN or URL…
          </button>
          <button onClick={onBlank}>
            <Icon name="quote" size={13} /> New reference…
          </button>
          <hr />
          <button onClick={onZotero}>
            <Icon name="books" size={13} /> Import Zotero library
          </button>
        </div>
      </details>
    </div>
  );
}

function TagPicker({ tags, value, onChange, onManage }: { tags: { value: string; count: number }[]; value?: string; onChange: (tag?: string) => void; onManage: () => void }) {
  const [query, setQuery] = useState("");
  const shown = tags.filter((t) => t.value.toLowerCase().includes(query.toLowerCase())).slice(0, 80);
  return (
    <details className="kx-menu kx-tag-picker">
      <summary className="kx-facet" aria-pressed={!!value}>
        <Icon name="tag" size={12} />
        {value ?? "Tags"}
        {value && (
          <span
            role="button"
            aria-label="Clear tag filter"
            onClick={(e) => {
              e.preventDefault();
              onChange(undefined);
            }}
          >
            <Icon name="close" size={9} />
          </span>
        )}
      </summary>
      <div className="kx-menu-popover kx-tag-popover">
        <input autoFocus placeholder="Find a tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div>
          {shown.map((t) => (
            <button
              key={t.value}
              aria-pressed={value === t.value}
              onClick={(e) => {
                onChange(t.value);
                (e.currentTarget.closest("details") as HTMLDetailsElement).removeAttribute("open");
              }}
            >
              <span>{t.value}</span>
              <small>{t.count}</small>
            </button>
          ))}
        </div>
        <hr />
        <button
          className="kx-tag-manage"
          onClick={(e) => {
            (e.currentTarget.closest("details") as HTMLDetailsElement).removeAttribute("open");
            onManage();
          }}
        >
          <Icon name="tag" size={12} /> Manage, merge and clean up tags…
        </button>
      </div>
    </details>
  );
}

function BulkBar({
  count,
  collections,
  trashed,
  definitions,
  onSetProperty,
  onFill,
  onTag,
  onCollect,
  onStar,
  onTrash,
  onDelete,
  onClear,
}: {
  count: number;
  collections: Collection[];
  trashed: boolean;
  definitions: PropertyDefinition[];
  onSetProperty: (definition?: PropertyDefinition) => void;
  onFill: () => void;
  onTag: (tag: string) => Promise<void>;
  onCollect: (id: string) => Promise<void>;
  onStar: () => Promise<void>;
  onTrash: () => void;
  onDelete: () => Promise<void>;
  onClear: () => void;
}) {
  const [tag, setTag] = useState("");
  return (
    <div className="kx-bulk-bar" role="toolbar" aria-label="Selected sources">
      <strong>{count} selected</strong>
      <span className="kx-bulk-sep" />
      {!trashed && (
        <>
          <button onClick={() => void onStar()}>
            <Icon name="star" size={13} /> Star
          </button>
          <select
            aria-label="Add selection to collection"
            value=""
            onChange={(e) => e.target.value && void onCollect(e.target.value)}
          >
            <option value="">Add to collection…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <form
            className="kx-bulk-tag"
            onSubmit={(e) => {
              e.preventDefault();
              if (tag.trim()) void onTag(tag.trim()).then(() => setTag(""));
            }}
          >
            <Icon name="tag" size={13} />
            <input aria-label="Tag selection" placeholder="Add tag…" value={tag} onChange={(e) => setTag(e.target.value)} />
          </form>
          <select
            aria-label="Set a property on the selection"
            value=""
            onChange={(e) => {
              const value = e.target.value;
              if (value === "__new") onSetProperty();
              else if (value) onSetProperty(definitions.find((d) => d.name === value));
            }}
          >
            <option value="">Set property…</option>
            {definitions.filter((d) => d.type !== "formula").map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
            <option value="__new">New property…</option>
          </select>
          <button onClick={onFill} title={count > 25 ? "Agent fill works on 25 sources at a time" : "Fill a property with AI"}>
            <Icon name="sparkle" size={13} /> Fill with AI
          </button>
          <span className="kx-bulk-sep" />
        </>
      )}
      <button className="kx-danger" onClick={onTrash}>
        <Icon name={trashed ? "retry" : "trash"} size={13} /> {trashed ? "Restore" : "Trash"}
      </button>
      {trashed && (
        <button className="kx-danger" onClick={() => void onDelete()}>
          Delete
        </button>
      )}
      <button aria-label="Clear selection" onClick={onClear}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function EmptyState({ scope, filtered, onAdd }: { scope: string; filtered: boolean; onAdd: () => void }) {
  if (filtered) return <p className="kx-results-empty">No items match these filters.</p>;
  if (scope === "trashed") return <p className="kx-results-empty">Trash is empty.</p>;
  return (
    <div className="kx-empty-hero kx-library-empty">
      <span className="kx-empty-icon">
        <Icon name="books" size={22} />
      </span>
      <h3>Nothing here yet</h3>
      <p>Drop PDFs, web pages, videos, audio or images here, or import your Zotero library from the Add menu.</p>
      <button className="kx-button-primary" onClick={onAdd}>
        <Icon name="upload" size={14} /> Add files…
      </button>
    </div>
  );
}
