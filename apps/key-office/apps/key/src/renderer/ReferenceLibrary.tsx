import { apa } from "./citation";
import { itemAttrs, selectItems } from "./item-ui";
import { SectionHeader, useCollapsedGroups } from "./search-sections";
import { GROUPS, type SearchGroup } from "./unified-search";
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
  type NoteHit,
  type SearchHit,
  type SearchResult,
  type Source,
  type SourcePage,
} from "./library-api";
import { hasExternalDrop, importDrop, setItemDrag, sourceItem } from "./item-links";
import { SOURCE_DRAG_TYPE, currentSelection, libraryChanged, onLibraryChanged, onLibrarySelection, selectLibrary } from "./library-nav";
import type { Creator } from "./citation";
import { Highlight, Snippet, hasMatch, queryPattern } from "./search-highlight";
import SearchField, { storeFilters, type SearchFilter } from "./search-suggest";
import SourceItemPage from "./SourcePage";
import { indexLabel } from "./SourceInspector";
import { FilterLink, FilterLinks, sourceFilter, withFilter } from "./filter-links";
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
import { DatabaseToolbar, DatabaseView, useDatabaseViewState, type DatabaseViewHandle } from "./DatabaseView";
import { DEFAULT_SORTS, SOURCE_SORTS, SourceCard, legacyColumnSettings, useSourceColumns } from "./library-columns";
import "./reference-library.css";
import { ZoteroImportSheet } from "./ZoteroImport";

const PAGE = 300;
const ROW = 58;
const SCOPES: [string, string][] = [
  ["all", "All"],
  ["starred", "Starred"],
  ["unfiled", "Unfiled"],
  ["attention", "Needs attention"],
  ["trashed", "Trash"],
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
  onOpenNote,
}: {
  invoke: Invoke;
  workspaceId: string;
  workspaceName: string;
  active: boolean;
  refreshKey: number;
  onOpen: (source: Source) => void;
  onOpenHit: (hit: OpenHit) => void;
  onOpenNote: (note: { id: string; title: string }) => void;
}) {
  const initial = currentSelection(workspaceId);
  const [collectionId, setCollectionId] = useState<string | undefined>(initial?.collectionId);
  const [scope, setScope] = useState(initial?.scope ?? "all");
  const [kind, setKind] = useState<string>();
  const [tag, setTag] = useState<string>();
  const [text, setText] = useState("");
  // Filter tokens picked from search suggestions; they narrow the list and any search.
  const [filters, setFilters] = useState<SearchFilter[]>(initial?.filters ?? []);
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
  const [zotero, setZotero] = useState(false);
  // Layout, columns and sorting are remembered per workspace library.
  const [viewState, setViewState] = useDatabaseViewState(`library:${workspaceId}`, {
    layout: (() => {
      try {
        return localStorage.getItem("key.library.view") === "table" ? "table" : "list";
      } catch {
        return "list";
      }
    })(),
    columns: legacyColumnSettings(workspaceId),
    sorts: DEFAULT_SORTS,
  });
  const sorts = viewState.sorts.length ? viewState.sorts : DEFAULT_SORTS;
  const listRef = useRef<DatabaseViewHandle>(null);
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

  // Sidebar selection drives the collection and scope.
  useEffect(
    () =>
      onLibrarySelection((s) => {
        if (s.workspaceId !== workspaceId) return;
        setCollectionId(s.collectionId);
        setScope(s.scope ?? "all");
        setText("");
        if (s.filters) setFilters(s.filters);
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
    () => ({ collectionId: collectionId ?? null, scope, kind: kind ?? null, tag: tag ?? null, filters: storeFilters(filters), text: null, sort: sorts[0].field, descending: sorts[0].descending, sorts }),
    [collectionId, scope, kind, tag, filters, sorts],
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

  // While searching, selection, arrow keys and bulk actions work on the results, in the
  // order of their sections (collapsed sections left out).
  const { collapsed: collapsedGroups } = useCollapsedGroups();
  const rows = useMemo(
    () =>
      search?.result
        ? GROUPS.filter((g) => !collapsedGroups.includes(g)).flatMap((g) => search.result!.hits.filter((h) => hitGroup(h) === g).flatMap((h) => (h.source ? [h.source] : [])))
        : items,
    [search?.result, items, collapsedGroups],
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

  // Rows on screen are indexed first; nearing the end loads the next page.
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const onScreen = (search ? rows.slice(0, 20) : items.slice(range[0], range[1] + 1))
    .filter((s): s is Source => !!s && waitingToIndex(s))
    .map((s) => s.id)
    .join(",");
  useEffect(() => {
    if (!onScreen) return;
    const t = setTimeout(() => prioritize(onScreen.split(",").slice(0, 40), "visible"), 600);
    return () => clearTimeout(t);
  }, [onScreen, prioritize]);
  useEffect(() => {
    if (range[1] > items.length - 40 && items.length < total && !loadingMore.current) {
      loadingMore.current = true;
      void load(items.length);
    }
  }, [range, items.length, total, load]);
  const columns = useSourceColumns({
    definitions,
    collections,
    onCommit: (source, name, value) =>
      void invoke<Source>("store_update", { id: source.id, patch: { properties: { [name]: value } } }, workspaceId).then(updateSource),
    onEditProperty: (definition) => setSheet({ mode: "edit", definition, targets: [] }),
  });

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
  // The inspector and ⌘K act on the selected sources.
  const selectionKey = selection.join(",");
  useEffect(() => {
    if (!active) return;
    const known = new Map<string, Source>([...items, ...(search?.result?.hits.map((h) => h.source).filter((x): x is Source => !!x) ?? [])].map((x) => [x.id, x]));
    const chosen = selection.map((id) => known.get(id)).filter((x): x is Source => !!x);
    if (chosen.length) selectItems(chosen.map(sourceItem));
  }, [selectionKey, active]);
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
    else listRef.current?.scrollToIndex(index);
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

  const importDropped = async (data: DataTransfer) => {
    try {
      const added = await importDrop(invoke, workspaceId, data, collectionId);
      if (!added.length) return;
      await load(0);
      libraryChanged();
      setToast({ text: `Added ${added.length} ${added.length === 1 ? "source" : "sources"}` });
    } catch (e) {
      setError(String(e));
    }
  };
  // Dragged sources go to collections (by id) and anywhere items go: canvases, notes.
  const dragSources = (source: Source, e: React.DragEvent) => {
    const ids = selected.has(source.id) ? [...selected] : [source.id];
    const byId = new Map(items.map((s) => [s.id, s]));
    const files = ids.map((id) => byId.get(id)?.filePath).filter((path): path is string => !!path);
    // ⌥-drag takes the files themselves out of the app (to Finder, Mail …).
    if (e.altKey && files.length) {
      e.preventDefault();
      bridge().startFileDrag(files);
      return;
    }
    e.dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify(ids));
    setItemDrag(e.dataTransfer, ids.map((id) => sourceItem(byId.get(id) ?? { id, title: "", kind: "" })));
    // Dropped into another app's text, a source is its reference.
    const cited = ids.map((id) => byId.get(id)).filter((x): x is Source => !!x);
    if (cited.length) e.dataTransfer.setData("text/plain", cited.map((x) => apa(x)).join("\n\n"));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  // Results only re-render when they change, not on every keystroke; handlers stay stable.
  const latest = useRef({ select, open, runSearch, onOpenHit, onOpenNote, search });
  latest.current = { select, open, runSearch, onOpenHit, onOpenNote, search };
  const resultHandlers = useMemo<ResultHandlers>(
    () => ({
      onPointer: (id, e) => latest.current.select(id, e),
      onOpen: (source) => latest.current.open(source),
      onOpenNote: (note) => latest.current.onOpenNote(note),
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

  // A clicked tag, author, year … joins the search's filter tokens.
  const addFilter = useCallback((filter: SearchFilter) => setFilters((current) => withFilter(current, filter)), []);
  const collectionName = collections.find((c) => c.id === collectionId)?.name;
  const title = scope === "trashed" ? "Trash" : collectionName ?? (scope === "starred" ? "Starred" : scope === "unfiled" ? "Unfiled" : scope === "attention" ? "Needs attention" : "All sources");

  return (
    <FilterLinks.Provider value={addFilter}>
    <section
      ref={libraryRef}
      className={`kx-library ${dropping ? "dropping" : ""}`}
      data-overlay={overlay}
      style={{ "--kx-inspector-width": `${inspectorWidth}px` } as React.CSSProperties}
      aria-label="Library"
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (hasExternalDrop(e.dataTransfer)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (hasExternalDrop(e.dataTransfer)) {
          e.preventDefault();
          void importDropped(e.dataTransfer);
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
              onZotero={() => setZotero(true)}
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
          {!search && (
            <div className="kx-controls-end">
              <DatabaseToolbar
                state={{ ...viewState, sorts }}
                onChange={setViewState}
                columns={columns}
                sortFields={[...SOURCE_SORTS, ...definitions.filter((d) => d.type !== "formula").map<[string, string]>((d) => [`property:${d.name}`, d.name])]}
                columnFooter={
                  <button onClick={() => setSheet({ mode: "new", targets: [] })}>
                    <Icon name="plus" size={13} /> New property…
                  </button>
                }
              />
            </div>
          )}
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
          <DatabaseView
            rowAttrs={(source: Source) => itemAttrs({ kind: "source", id: source.id, title: source.title || "Untitled" })}
            ref={listRef}
            rows={items}
            rowId={(source) => source.id}
            state={{ ...viewState, sorts }}
            onChange={setViewState}
            columns={columns}
            label={`${title}, ${total} items`}
            empty={!loading && <EmptyState scope={scope} filtered={!!(kind || tag || filters.length)} onAdd={() => void bridge().addFiles(workspaceId, collectionId).then(() => void load(0))} />}
            isSelected={(source) => selected.has(source.id) || (!selected.size && focusId === source.id)}
            isFocused={(source) => focusId === source.id}
            onPointer={(source, e) => select(source.id, e)}
            onOpen={open}
            onDragStart={dragSources}
            onRange={(first, last) => setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]))}
            renderCard={(source) => <SourceCard source={source} />}
            renderListRow={(source, top, row) => (
              <SourceRow
                key={source.id}
                source={source}
                progress={jobProgress(activity, source.id)}
                top={top}
                selected={row.selected}
                focused={row.focused}
                onPointer={(e) => select(source.id, e)}
                onOpen={() => open(source)}
                onStar={() =>
                  void invoke<Source>("store_update", { id: source.id, patch: { starred: !source.starred } }, workspaceId).then(updateSource)
                }
                onDragStart={(e) => dragSources(source, e)}
              />
            )}
          />
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
        // The details panel is the source's page, the same component as its own tab.
        <aside className="kx-inspector kx-inspector-page" aria-label="Source details">
          <SourceItemPage
            key={inspector.id}
            invoke={invoke}
            workspaceId={workspaceId}
            sourceId={inspector.id}
            side={{
              onChanged: (source) => {
                updateSource(source);
                if (source.collections.length !== inspector.collections.length || source.tags.join("\n") !== inspector.tags.join("\n")) libraryChanged();
              },
              onOpenPage: (source) => void bridge().tabAction("open-source-page", { workspaceId, sourceId: source.id, title: source.title || "Untitled", read: false }),
              onClose: () => setFocusId(undefined),
              progress: jobProgress(activity, inspector.id),
              onAgentFill: (name) => setAgent({ targets: [inspector], name }),
            }}
          />
        </aside>
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
      {zotero && (
        <ZoteroImportSheet
          invoke={invoke}
          workspaceId={workspaceId}
          onClose={() => setZotero(false)}
          onDone={(workspace, report) => {
            setToast({ text: `Imported ${report.items.toLocaleString()} items from Zotero into “${workspace.name}”` });
            selectLibrary({ workspaceId: workspace.id });
            libraryChanged();
          }}
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
    </FilterLinks.Provider>
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
  onDragStart,
}: {
  source: Source;
  progress?: { fraction: number; label: string };
  top: number;
  selected: boolean;
  focused: boolean;
  onPointer: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onStar: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const status = indexLabel(source);
  const container = source.containerShort || source.containerTitle;
  const meta = [
    source.creators.length > 0 && (
      <FilterLink key="a" filter={sourceFilter.creator(source.creators[0])}>
        {shortCreators(source.creators)}
      </FilterLink>
    ),
    source.year && (
      <FilterLink key="y" filter={sourceFilter.year(source.year)}>
        {source.year}
      </FilterLink>
    ),
    container && (
      <FilterLink key="c" filter={source.containerTitle ? sourceFilter.container(source.containerTitle) : undefined}>
        {container}
      </FilterLink>
    ),
  ]
    .filter(Boolean)
    .flatMap((part, i) => (i ? [" · ", part] : [part]));
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
      onDragStart={onDragStart}
      {...itemAttrs({ kind: "source", id: source.id, title: source.title || "Untitled" })}
    >
      <span className="kx-row-kind" data-kind={source.kind}>
        <Icon name={KIND_ICON[source.kind] ?? "doc"} size={15} />
      </span>
      <span className="kx-row-text">
        <strong>{source.title || "Untitled"}</strong>
        <span>
          {progress && <b className="kx-row-stage">{progress.label}</b>}
          {meta.length ? meta : !progress && <em>No details yet</em>}
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
  if (passage.noteId) return "Note";
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
  onOpenNote: (note: { id: string; title: string }) => void;
  onMore: () => void;
}

/** A result's section: matched in its details, in its text, or only by meaning. */
const hitGroup = (hit: SearchHit): SearchGroup => (hit.metadataMatch ? "titles" : hit.passages.some((p) => !p.related) ? "text" : "meaning");
const noteGroup = (note: NoteHit): SearchGroup => (note.passages.some((p) => !p.related) ? "text" : "meaning");

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
  const { collapsed, toggle } = useCollapsedGroups();
  const pattern = useMemo(() => queryPattern(search.query), [search.query]);
  const hits = result?.hits ?? [];
  const notes = result?.notes ?? [];
  const inDetails = hits.filter((h) => h.metadataMatch).length;
  const inText = hits.filter((h) => h.passages.some((p) => !p.noteId)).length;
  const inNotes = hits.filter((h) => h.passages.some((p) => p.noteId)).length + notes.length;
  return (
    <div className="kx-results" role="listbox" aria-label="Search results" aria-multiselectable tabIndex={0} data-busy={search.busy}>
      {search.error ? (
        <p className="kx-results-empty" role="alert">
          Search failed: {search.error}
        </p>
      ) : result ? (
        <div className="kx-results-head">
          <strong>
            {hits.length || notes.length
              ? [
                  hits.length && `${hits.length === search.limit ? `Top ${hits.length}` : hits.length} ${hits.length === 1 ? "source" : "sources"}`,
                  notes.length && `${notes.length} ${notes.length === 1 ? "note" : "notes"}`,
                ]
                  .filter(Boolean)
                  .join(" and ")
              : "No matches"}
          </strong>
          {!!(hits.length || notes.length) && (
            <span>
              {[inDetails && `${inDetails} in titles and details`, inText && `${inText} in full text`, inNotes && `${inNotes} in notes`].filter(Boolean).join(" · ")}
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
      {result && !hits.length && !notes.length && <p className="kx-results-empty">Nothing matched “{search.query}”. Try other words or a broader collection.</p>}
      {GROUPS.map((group) => {
        const inGroup = hits.filter((h) => hitGroup(h) === group);
        const notesInGroup = notes.filter((n) => noteGroup(n) === group);
        if (!inGroup.length && !notesInGroup.length) return null;
        const shut = collapsed.includes(group);
        return (
          <section key={group} className="kx-results-section" data-group={group}>
            <SectionHeader group={group} count={inGroup.length + notesInGroup.length} collapsed={shut} onToggle={() => toggle(group)} />
            {!shut && (
              <>
                {notesInGroup.map((note) => (
                  <NoteHitRow key={note.noteId} note={note} pattern={pattern} handlers={handlers} />
                ))}
                {inGroup.map((hit) => (
                  <SearchHitRow
                    key={hit.sourceId}
                    hit={hit}
                    pattern={pattern}
                    selected={selected.has(hit.sourceId) || (!selected.size && focusId === hit.sourceId)}
                    focused={focusId === hit.sourceId}
                    handlers={handlers}
                  />
                ))}
              </>
            )}
          </section>
        );
      })}
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
            {...itemAttrs({ kind: "source", id: source.id, title: source.title || "Untitled" })}
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
                {source.year && (
                  <span>
                    <FilterLink filter={sourceFilter.year(source.year)}>{source.year}</FilterLink>
                  </span>
                )}
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
                      <FilterLink filter={sourceFilter.tag(t)}>
                        <Highlight text={t} pattern={pattern} />
                      </FilterLink>
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
                  {hit.passages.map((passage) => (
                    <PassageMatch
                      key={passage.id}
                      passage={passage}
                      pattern={pattern}
                      // A note opens with its source's page; a document passage at its page.
                      onOpen={passage.noteId ? () => handlers.onOpen(source) : passage.page !== null ? () => handlers.onOpenPassage(hit, passage) : undefined}
                    />
                  ))}
                </ul>
              )}
            </div>
          </article>
        );
      });

/** One place a query matched; opens it when it can be opened. */
function PassageMatch({ passage, pattern, onOpen }: { passage: Passage; pattern?: RegExp; onOpen?: () => void }) {
  return (
    <li>
      <button
        className="kx-passage"
        data-related={!!passage.related}
        disabled={!onOpen}
        title={!onOpen ? undefined : passage.noteId ? "Open note" : `Open page ${passage.page! + 1}`}
        onClick={onOpen}
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
}

/** A standalone note among the results; opens in its own tab. */
const NoteHitRow = memo(function NoteHitRow({ note, pattern, handlers }: { note: NoteHit; pattern?: RegExp; handlers: ResultHandlers }) {
  const open = () => handlers.onOpenNote({ id: note.noteId, title: note.title });
  return (
    <article className="kx-hit" role="option" aria-selected={false} data-note={note.noteId} onDoubleClick={open}>
      <span className="kx-row-kind" data-kind="note">
        <Icon name="note" size={15} />
      </span>
      <div className="kx-hit-body">
        <strong className="kx-hit-title">
          <Highlight text={note.title || "Untitled note"} pattern={pattern} />
        </strong>
        <ul className="kx-hit-matches">
          {note.passages.map((passage) => (
            <PassageMatch key={passage.id} passage={passage} pattern={pattern} onOpen={open} />
          ))}
        </ul>
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
            <Icon name="books" size={13} /> Import from Zotero…
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
