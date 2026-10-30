import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityBanner, ActivityPill, ProgressRing, jobProgress, useLibraryStatus } from "./index-activity";
import { ModelProgressCard, useModelProgress } from "./model-progress";
import { Icon } from "./icons";
import {
  KIND_ICON,
  KIND_LABEL,
  bridge,
  relativeDate,
  shortCreators,
  type Collection,
  type FieldMatch,
  type Facets,
  type Invoke,
  type LibraryStatus,
  type Passage,
  type SearchHit,
  type SearchResult,
  type Source,
  type SourcePage,
} from "./library-api";
import { SOURCE_DRAG_TYPE, currentSelection, libraryChanged, onLibraryChanged, onLibrarySelection, selectLibrary } from "./library-nav";
import type { Creator } from "./citation";
import { Highlight, Snippet, hasMatch, queryPattern } from "./search-highlight";
import SearchField, { storeFilters, type SearchFilter } from "./search-suggest";
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
  // Filter tokens picked from search suggestions; they narrow the list and any search.
  const [filters, setFilters] = useState<SearchFilter[]>([]);
  const [items, setItems] = useState<Source[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<SourcePage["counts"]>();
  const [facets, setFacets] = useState<Facets>({ tags: [], itemTypes: [], kinds: [], years: [] });
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string>();
  const [anchor, setAnchor] = useState<string>();
  const [inspector, setInspector] = useState<Source>();
  const [search, setSearch] = useState<SearchState>();
  const [dropping, setDropping] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => void }>();
  const { definitions, reload: reloadDefinitions } = usePropertyDefinitions(invoke, workspaceId);
  const model = useModelProgress(invoke, workspaceId, active);
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
  // Details panel width: dragged live through a CSS variable, saved when released.
  const libraryRef = useRef<HTMLElement>(null);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("key.library.inspectorWidth")) || DEFAULT_INSPECTOR;
    } catch {
      return DEFAULT_INSPECTOR;
    }
  });
  const [libraryWidth, setLibraryWidth] = useState(0);
  useEffect(() => {
    const el = libraryRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setLibraryWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Too narrow for list and details side by side: details float over the list.
  const overlay = libraryWidth > 0 && libraryWidth - inspectorWidth < MIN_LIST;
  const clampWidth = (width: number) => {
    const room = (libraryRef.current?.clientWidth ?? 1200) - (overlay ? 48 : MIN_LIST);
    return Math.round(Math.max(MIN_INSPECTOR, Math.min(MAX_INSPECTOR, room, width)));
  };
  const commitWidth = (width: number) => {
    const next = clampWidth(width);
    setInspectorWidth(next);
    try {
      localStorage.setItem("key.library.inspectorWidth", String(next));
    } catch {}
  };
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = libraryRef.current;
    if (!root || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = root.querySelector<HTMLElement>(".kx-inspector")?.offsetWidth ?? inspectorWidth;
    let width = startWidth;
    let frame = 0;
    root.dataset.resizing = "true";
    const move = (ev: PointerEvent) => {
      width = clampWidth(startWidth + (startX - ev.clientX));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => root.style.setProperty("--kx-inspector-width", `${width}px`));
    };
    const end = () => {
      cancelAnimationFrame(frame);
      delete root.dataset.resizing;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      commitWidth(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
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
        setText("");
      }),
    [workspaceId],
  );
  useEffect(() => {
    if (!active) return;
    try {
      localStorage.setItem("key.library.last", workspaceId);
    } catch {}
  }, [active, workspaceId]);

  const query = useMemo(
    () => ({ collectionId: collectionId ?? null, scope, kind: kind ?? null, tag: tag ?? null, filters: storeFilters(filters), text: null, sort, descending }),
    [collectionId, scope, kind, tag, filters, sort, descending],
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

  // Indexing progress: the status poll speeds up while anything is in flight; rows refresh gently.
  const status = useLibraryStatus(invoke, workspaceId, active);
  const activity = status?.activity;
  const knownCount = useRef<number | undefined>(undefined);
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!status || search) return;
    // Sources added elsewhere (another window, the agent, a direct import) appear without a reload.
    const known = knownCount.current;
    knownCount.current = status.counts.all;
    if (known !== undefined && known !== status.counts.all) return void load(0);
    if ((status.busy || status.counts.indexing > 0) && Date.now() - lastRefresh.current > 3000) {
      lastRefresh.current = Date.now();
      void invoke<SourcePage>("store_sources", { ...query, offset: 0, limit: Math.max(PAGE, items.length) }, workspaceId)
        .then((page) => {
          setItems(page.items);
          setCounts(page.counts);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  // Indexing follows the user: what they open, select and scroll to is read first.
  const prioritize = useCallback(
    (ids: string[], reason: "opened" | "selected" | "visible") => {
      if (ids.length) void invoke("store_index_priority", { ids, reason }, workspaceId).catch(() => {});
    },
    [invoke, workspaceId],
  );
  const pauseIndexing = (paused: boolean) => void invoke("store_index_control", { action: paused ? "pause" : "resume" }, workspaceId);

  // While searching, selection, arrow keys and bulk actions work on the results.
  const rows = useMemo(
    () => (search?.result ? search.result.hits.flatMap((h) => (h.source ? [h.source] : [])) : items),
    [search?.result, items],
  );
  useEffect(() => {
    const source = rows.find((s) => s.id === focusId);
    if (source && waitingToIndex(source)) prioritize([source.id], "selected");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, prioritize]);
  // Keep the inspector in step with the focused row.
  useEffect(() => {
    if (!focusId) return setInspector(undefined);
    const row = rows.find((s) => s.id === focusId);
    if (row) setInspector(row);
  }, [focusId, rows]);

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
  const onScreen = (search ? rows.slice(0, 20) : virtualItems.map((v) => items[v.index]))
    .filter((s): s is Source => !!s && waitingToIndex(s))
    .map((s) => s.id)
    .join(",");
  useEffect(() => {
    if (!onScreen) return;
    const t = setTimeout(() => prioritize(onScreen.split(",").slice(0, 40), "visible"), 600);
    return () => clearTimeout(t);
  }, [onScreen, prioritize]);
  useEffect(() => {
    const last = virtualItems.at(-1);
    if (last && last.index > items.length - 40 && items.length < total && !loadingMore.current) {
      loadingMore.current = true;
      void load(items.length);
    }
  }, [virtualItems, items.length, total, load]);

  // Search follows typing: metadata and full text together, newest request wins.
  const searchRequest = useRef(0);
  const runSearch = useCallback(
    async (value: string, limit = 60) => {
      const id = ++searchRequest.current;
      setSearch((previous) => ({ query: value, result: previous?.result, busy: true, limit }));
      try {
        const result = await invoke<SearchResult>(
          "store_search",
          { text: value, collectionId: collectionId ?? null, scope, kind: kind ?? null, tag: tag ?? null, filters: storeFilters(filters), limit, passagesPerSource: 3 },
          workspaceId,
        );
        if (id === searchRequest.current) setSearch({ query: value, result, busy: false, limit });
      } catch (e) {
        // Shown in place of the results, so a failed search never looks like it is still loading.
        if (id === searchRequest.current)
          setSearch({ query: value, busy: false, limit, error: String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "") });
      }
    },
    [invoke, workspaceId, collectionId, scope, kind, tag, filters],
  );
  useEffect(() => {
    const value = text.trim();
    if (!value) {
      ++searchRequest.current;
      setSearch(undefined);
      return;
    }
    const t = setTimeout(() => void runSearch(value), 180);
    return () => clearTimeout(t);
  }, [text, runSearch]);

  const updateSource = (source: Source) => {
    setItems((list) => list.map((s) => (s.id === source.id ? source : s)));
    setSearch((current) =>
      current?.result
        ? { ...current, result: { ...current.result, hits: current.result.hits.map((h) => (h.sourceId === source.id ? { ...h, source } : h)) } }
        : current,
    );
    setInspector(source);
  };
  const selection = selected.size ? [...selected] : focusId ? [focusId] : [];
  const select = (id: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (event.shiftKey && anchor) {
      const a = rows.findIndex((s) => s.id === anchor);
      const b = rows.findIndex((s) => s.id === id);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelected(new Set(rows.slice(from, to + 1).map((s) => s.id)));
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
    const index = Math.max(0, Math.min(rows.length - 1, rows.findIndex((s) => s.id === focusId) + delta));
    const next = rows[index];
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
    if (search) document.querySelector(`[data-hit="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
    else virtualizer.scrollToIndex(index, { align: "auto" });
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
    if (waitingToIndex(source)) prioritize([source.id], "opened");
    onOpen(source);
  };
  /** The file or link itself, outside Key (videos, web pages, other files). */
  const openExternal = (source: Source) => {
    if (source.filePath && source.kind === "pdf") onOpen(source);
    else if (source.filePath) void bridge().openPath(source.filePath).catch((e) => setError(String(e)));
    else if (source.url) window.open(source.url, "_blank");
    else if (source.doi) window.open(`https://doi.org/${source.doi}`, "_blank");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Typing anywhere (fields, the note editor) never triggers list shortcuts.
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Enter" && focusId) {
      const source = rows.find((s) => s.id === focusId);
      if (source) open(source);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(rows.map((s) => s.id)));
    } else if ((e.key === "Backspace" || e.key === "Delete") && selection.length && scope !== "trashed") {
      e.preventDefault();
      void trash(selection);
    } else if (e.key === "Escape") {
      if (selected.size) setSelected(new Set());
      else if (search) setText("");
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

  // Results only re-render when they change, not on every keystroke; handlers stay stable.
  const latest = useRef({ select, open, runSearch, onOpenHit, search });
  latest.current = { select, open, runSearch, onOpenHit, search };
  const resultHandlers = useMemo<ResultHandlers>(
    () => ({
      onPointer: (id, e) => latest.current.select(id, e),
      onOpen: (source) => latest.current.open(source),
      onMore: () => {
        const current = latest.current.search;
        if (current) void latest.current.runSearch(current.query, current.limit + 120);
      },
      onOpenPassage: (hit, passage) => {
        const current = latest.current.search;
        if (!current) return;
        latest.current.onOpenHit({
          source: hit,
          passage,
          query: current.query,
          results: (current.result?.hits ?? []).flatMap((h) =>
            h.passages.filter((p) => p.page !== null).map((p) => ({ id: p.id, documentHash: h.documentHash, documentTitle: h.title, page: p.page })),
          ),
        });
      },
    }),
    [],
  );

  const collectionName = collections.find((c) => c.id === collectionId)?.name;
  const title = scope === "trashed" ? "Trash" : collectionName ?? (scope === "starred" ? "Starred" : scope === "unfiled" ? "Unfiled" : scope === "attention" ? "Needs attention" : "All sources");

  return (
    <section
      ref={libraryRef}
      className={`kx-library ${dropping ? "dropping" : ""}`}
      data-overlay={overlay}
      style={{ "--kx-inspector-width": `${inspectorWidth}px` } as React.CSSProperties}
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
            <SearchField
              invoke={invoke}
              workspaceId={workspaceId}
              view={{ collectionId: collectionId ?? null, scope, kind: kind ?? null, tag: tag ?? null }}
              text={text}
              onText={setText}
              filters={filters}
              onFilters={setFilters}
              busy={search?.busy}
              inputRef={searchInput}
              onSubmit={() => {
                const first = search?.result?.hits[0];
                if (first) {
                  setSelected(new Set());
                  setFocusId(first.sourceId);
                }
              }}
              onArrowIntoResults={() => {
                const first = search?.result?.hits[0]?.sourceId ?? items[0]?.id;
                if (!first) return;
                setSelected(new Set());
                setFocusId(first);
                document.querySelector<HTMLElement>(search ? ".kx-results" : ".kx-list")?.focus();
              }}
            />
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

        {(
        <div className="kx-filter-bar" data-searching={!!search}>
          <div className="kx-scopes" role="group" aria-label="Library views">
            {SCOPES.map(([value, label]) => {
              const count = value === "all" ? counts?.all : value === "trashed" ? counts?.trashed : value === "starred" ? counts?.starred : value === "unfiled" ? counts?.unfiled : counts?.attention;
              if (value !== "all" && value !== "trashed" && !count && scope !== value) return null;
              return (
                <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>
                  {label}
                  {!!count && <span className="kx-count">{count.toLocaleString()}</span>}
                </button>
              );
            })}
          </div>
          {!search && <div className="kx-controls-end">
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
          </div>}
        </div>
        )}
        {(facets.kinds.length > 1 || facets.tags.length > 0) && (
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
        <ModelProgressCard progress={model} compact />
        <ActivityBanner status={status} minimum={12} onPause={pauseIndexing} />
        {error && (
          <div className="kx-banner kx-banner-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}

        {search ? (
          <SearchResults search={search} focusId={focusId} selected={selected} handlers={resultHandlers}
          />
        ) : (
          <div className="kx-list" ref={listRef} tabIndex={0} role="listbox" aria-label={`${title}, ${total} items`} aria-multiselectable>
            {!loading && !items.length ? (
              <EmptyState scope={scope} filtered={!!(kind || tag || filters.length)} onAdd={() => void bridge().addFiles(workspaceId, collectionId).then(() => void load(0))} />
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
                      progress={jobProgress(activity, source.id)}
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
          <ActivityPill status={status} onPause={pauseIndexing} />
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
        <div
          className="kx-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize details"
          aria-valuenow={inspectorWidth}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={() => commitWidth(DEFAULT_INSPECTOR)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              commitWidth(inspectorWidth + (e.key === "ArrowLeft" ? 24 : -24));
            }
          }}
        />
      )}
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
          onOpen={openExternal}
          onOpenPage={(source) =>
            void bridge().tabAction("open-source-page", { workspaceId, sourceId: source.id, title: source.title || "Untitled", read: false })
          }
          onClose={() => setFocusId(undefined)}
          definitions={definitions}
          progress={jobProgress(activity, inspector.id)}
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
  progress,
  top,
  selected,
  focused,
  onPointer,
  onOpen,
  onStar,
  dragIds,
}: {
  source: Source;
  progress?: { fraction: number; label: string };
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
        <span>
          {progress && <b className="kx-row-stage">{progress.label}</b>}
          {meta || (!progress && <em>No details yet</em>)}
        </span>
      </span>
      <span className="kx-row-end">
        {(source.noteCount > 0 || source.annotationCount > 0) && (
          <span className="kx-row-badge" title={`${source.noteCount} notes, ${source.annotationCount} highlights`}>
            <Icon name="note" size={11} />
            {source.noteCount + source.annotationCount}
          </span>
        )}
        {progress ? (
          <span className="kx-row-status" title={progress.label}>
            <ProgressRing fraction={progress.fraction} size={15} />
          </span>
        ) : (
          source.indexStatus !== "skipped" &&
          source.indexStatus !== "ready" && (
            <span className="kx-row-status" title={status.label}>
              <span className="kx-status-dot" data-tone={status.tone} />
            </span>
          )
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

const DEFAULT_INSPECTOR = 440;
const MIN_INSPECTOR = 320;
const MAX_INSPECTOR = 900;
const MIN_LIST = 380;

const waitingToIndex = (s: Source) => s.indexStatus === "pending" || s.indexStatus === "indexing";

type SearchState = { query: string; result?: SearchResult; busy: boolean; limit: number; error?: string };

const FIELD_LABEL: Record<FieldMatch["field"], string> = {
  creators: "Authors",
  container: "Published in",
  abstract: "Abstract",
  tags: "Tags",
  notes: "Notes",
  identifiers: "Identifiers",
};

function creatorList(creators: Creator[], max: number) {
  const authors = creators.filter((c) => !c.role || c.role === "author");
  const list = (authors.length ? authors : creators).map((c) => c.literal || [c.given, c.family].filter(Boolean).join(" "));
  return list.length > max ? `${list.slice(0, max).join(", ")} et al.` : list.join(", ");
}
function passagePlace(passage: Passage) {
  if (passage.page !== null) return `p. ${passage.page + 1}`;
  if (passage.startSeconds !== null) {
    const s = Math.round(passage.startSeconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return "Abstract";
}

/** Live results: one row per source, with every place the query matched underneath. */
interface ResultHandlers {
  onPointer: (id: string, e: React.MouseEvent) => void;
  onOpen: (source: Source) => void;
  onOpenPassage: (hit: SearchHit, passage: Passage) => void;
  onMore: () => void;
}

const SearchResults = memo(function SearchResults({
  search,
  focusId,
  selected,
  handlers,
}: {
  search: SearchState;
  focusId?: string;
  selected: Set<string>;
  handlers: ResultHandlers;
}) {
  const result = search.result;
  const pattern = useMemo(() => queryPattern(search.query), [search.query]);
  const hits = result?.hits ?? [];
  const inDetails = hits.filter((h) => h.metadataMatch).length;
  const inText = hits.filter((h) => h.passages.length).length;
  return (
    <div className="kx-results" role="listbox" aria-label="Search results" aria-multiselectable tabIndex={0} data-busy={search.busy}>
      {search.error ? (
        <p className="kx-results-empty" role="alert">
          Search failed: {search.error}
        </p>
      ) : result ? (
        <div className="kx-results-head">
          <strong>{hits.length ? `${hits.length === search.limit ? `Top ${hits.length}` : hits.length} ${hits.length === 1 ? "source" : "sources"}` : "No matches"}</strong>
          {!!hits.length && (
            <span>
              {[inDetails && `${inDetails} in titles and details`, inText && `${inText} in full text`].filter(Boolean).join(" · ")}
              {result.semantic ? " · matched by words and meaning" : ""}
            </span>
          )}
        </div>
      ) : (
        <div className="kx-results-loading">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="kx-skeleton-line" />
          ))}
        </div>
      )}
      {result && !hits.length && <p className="kx-results-empty">Nothing matched “{search.query}”. Try other words or a broader collection.</p>}
      {hits.map((hit) => (
        <SearchHitRow
          key={hit.sourceId}
          hit={hit}
          pattern={pattern}
          selected={selected.has(hit.sourceId) || (!selected.size && focusId === hit.sourceId)}
          focused={focusId === hit.sourceId}
          handlers={handlers}
        />
      ))}
      {hits.length === search.limit && search.limit < 300 && (
        <button className="kx-results-more" onClick={handlers.onMore}>
          Show more results
        </button>
      )}
    </div>
  );
});

const SearchHitRow = memo(function SearchHitRow({
  hit,
  pattern,
  selected,
  focused,
  handlers,
}: {
  hit: SearchHit;
  pattern?: RegExp;
  selected: boolean;
  focused: boolean;
  handlers: ResultHandlers;
}) {
        const source = hit.source;
        if (!source) return null;
        const authors = creatorList(source.creators, 6);
        const container = source.containerTitle || source.publisher;
        const tags = source.tags.filter((t) => hasMatch(t, pattern));
        // Matches already visible in the row need no extra line.
        const fields = hit.fields.filter(
          (f) => f.field !== "tags" && !(f.field === "creators" && hasMatch(authors, pattern)) && !(f.field === "container" && hasMatch(container, pattern)),
        );
        return (
          <article
            className="kx-hit"
            role="option"
            aria-selected={selected}
            data-focused={focused}
            data-hit={source.id}
            onMouseDown={(e) => {
              if (!(e.target as HTMLElement).closest(".kx-passage")) handlers.onPointer(source.id, e);
            }}
            onDoubleClick={(e) => {
              if (!(e.target as HTMLElement).closest(".kx-passage")) handlers.onOpen(source);
            }}
          >
            <span className="kx-row-kind" data-kind={source.kind}>
              <Icon name={KIND_ICON[source.kind] ?? "doc"} size={15} />
            </span>
            <div className="kx-hit-body">
              <strong className="kx-hit-title">
                <Highlight text={source.title || "Untitled"} pattern={pattern} />
              </strong>
              <span className="kx-hit-meta">
                {authors && (
                  <span>
                    <Highlight text={authors} pattern={pattern} />
                  </span>
                )}
                {source.year && <span>{source.year}</span>}
                {container && (
                  <span>
                    <Highlight text={container} pattern={pattern} />
                  </span>
                )}
              </span>
              {!!tags.length && (
                <span className="kx-hit-tags">
                  {tags.map((t) => (
                    <span key={t} className="kx-hit-tag">
                      <Highlight text={t} pattern={pattern} />
                    </span>
                  ))}
                </span>
              )}
              {(fields.length > 0 || hit.passages.length > 0) && (
                <ul className="kx-hit-matches">
                  {fields.map((f) => (
                    <li key={f.field} className="kx-field-match">
                      <span className="kx-match-where">{FIELD_LABEL[f.field]}</span>
                      <span className="kx-match-text">
                        <Snippet snippet={f.snippet} pattern={pattern} />
                      </span>
                    </li>
                  ))}
                  {hit.passages.map((passage) => {
                    const openable = passage.page !== null;
                    return (
                      <li key={passage.id}>
                        <button
                          className="kx-passage"
                          data-related={!!passage.related}
                          disabled={!openable}
                          title={openable ? `Open page ${passage.page! + 1}` : undefined}
                          onClick={() => openable && handlers.onOpenPassage(hit, passage)}
                        >
                          <span className="kx-match-where">
                            {passagePlace(passage)}
                            {passage.related && <em>related</em>}
                          </span>
                          <span className="kx-match-text">
                            <Snippet snippet={passage.snippet} pattern={pattern} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </article>
        );
      });

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
