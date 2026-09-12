import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./library.css";

export interface LibrarySource {
  documentId: string;
  documentHash: string;
  title: string;
  pageCount: number;
  status: string;
  keywordReady?: boolean;
  year?: number;
  authors?: string[];
  completed: number;
  total: number;
  error?: string;
  updatedAtMs?: number;
  workspaceId?: string;
}
export interface LibraryHit {
  id: string;
  documentId: string;
  documentHash: string;
  documentTitle?: string;
  page: number;
  text: string;
  targetText: string;
  score: number;
  workspaceId?: string;
}
export interface LibraryHomeProps {
  invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    workspaceId?: string,
  ) => Promise<T>;
  workspaceId?: string;
  projectId?: string;
  scopeLabel?: string;
  openDocumentIds?: ReadonlySet<string>;
  onOpenSource: (source: LibrarySource, hit?: LibraryHit) => void;
  onOpenItem?: (item: unknown) => void;
  onAddSources: () => void;
  refreshKey?: number;
  active?: boolean;
}
interface LibraryPage {
  documents: LibrarySource[];
  nextOffset: number | null;
  total: number;
}
interface Metadata {
  tags: string[];
  collections: string[];
  properties: Record<string, string | number | boolean | null>;
}
const emptyFilter = {
  author: "",
  yearFrom: "",
  yearTo: "",
  tag: "",
  collection: "",
  annotations: "any",
  metadataText: "",
  property: "",
  type: "text",
  value: "",
};
const activeStates = new Set(["queued", "processing", "indexing"]);
const identity = (d: LibrarySource | LibraryHit) =>
  `${d.workspaceId || ""}:${d.documentHash}`;
function statusText(d: LibrarySource) {
  if (d.status === "indexed")
    return `${d.total.toLocaleString()} searchable passages`;
  if (d.status === "no_text") return "No extractable text";
  if (d.status === "needs_source") return "Original PDF needed";
  if (d.status === "failed") return d.error || "Processing failed";
  if (d.status === "paused") return "Paused";
  if (d.status === "queued") return "Waiting to process";
  if (d.status === "indexing")
    return `${d.completed.toLocaleString()} / ${d.total.toLocaleString()} passages${d.keywordReady ? " · keyword ready" : ""}`;
  return "Extracting text…";
}

export default function LibraryHome({
  invoke,
  workspaceId,
  projectId,
  scopeLabel = "Library",
  openDocumentIds = new Set<string>(),
  onOpenSource,
  onAddSources,
  refreshKey,
  active = true,
}: LibraryHomeProps) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const [documents, setDocuments] = useState<LibrarySource[]>([]);
  const [scope, setScope] = useState("all");
  const [view, setView] = useState("table");
  const [sort, setSort] = useState("title");
  const [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<LibrarySource>();
  const [details, setDetails] = useState<Metadata>();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [sourceRecordId, setSourceRecordId] = useState<string>();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [hits, setHits] = useState<LibraryHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [filter, setFilter] = useState(emptyFilter);
  const [showFilters, setShowFilters] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [roadmap, setRoadmap] = useState(false);
  const [removed, setRemoved] = useState<LibrarySource>();
  const request = useRef(0);
  const submittedArgs = useRef<Record<string, unknown> | undefined>(undefined);
  const context = useRef(0);
  const call = <T,>(
    command: string,
    args: Record<string, unknown> = {},
    source?: LibrarySource,
  ) => invoke<T>(command, args, source?.workspaceId || workspaceId);
  const refresh = async () => {
    const page = await call<LibraryPage>("semantic_library_page", {
      projectId: projectId || null,
      offset,
      limit: 200,
      removed: scope === "removed",
    });
    setDocuments(page.documents);
    setNextOffset(page.nextOffset);
    setTotal(page.total);
  };
  useEffect(() => {
    const generation = ++context.current;
    ++request.current;
    setSelected(undefined);
    setDetails(undefined);
    setSubmitted("");
    setHits([]);
    setCursor(null);
    setSearching(false);
    setError("");
    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!activeRef.current) { timer = setTimeout(poll, 2000); return; }
      try {
        const page = await invoke<LibraryPage>(
          "semantic_library_page",
          {
            projectId: projectId || null,
            offset,
            limit: 200,
            removed: scope === "removed",
          },
          workspaceId,
        );
        const next = page.documents;
        if (generation !== context.current) return;
        setDocuments(next);
        setNextOffset(page.nextOffset);
        setTotal(page.total);
        setSelected((previous) =>
          previous
            ? next.find((d) => identity(d) === identity(previous))
            : undefined,
        );
        setLoading(false);
        timer = setTimeout(
          poll,
          next.some((d) => activeStates.has(d.status)) ? 900 : 3500,
        );
      } catch (e) {
        if (generation === context.current) {
          setError(String(e));
          setLoading(false);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => {
      ++context.current;
      ++request.current;
      clearTimeout(timer);
    };
  }, [invoke, workspaceId, projectId, scope, refreshKey, offset]);
  useEffect(() => {
    setOffset(0);
  }, [workspaceId, projectId, scope]);
  useEffect(() => {
    setDetails(undefined);
    setSourceRecordId(undefined);
    setProjects([]);
    if (!selected) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await call<{ id: string; name: string }[]>(
          "workspace_projects",
          {},
          selected,
        );
        if (cancelled) return;
        setProjects(list);
        const source = await call<{id:string} | null>('workspace_record', {id:`source:${selected.documentHash}`}, selected);
        if (!cancelled) setSourceRecordId(source?.id);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    void call<Metadata>(
      "library_metadata_details",
      { hash: selected.documentHash },
      selected,
    )
      .then((d) => {
        if (!cancelled) setDetails(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.documentHash, selected?.workspaceId]);
  const isOpen = (d: LibrarySource) =>
    openDocumentIds.has(d.documentId) ||
    openDocumentIds.has(d.documentHash) ||
    openDocumentIds.has(identity(d));
  const visible = useMemo(
    () =>
      documents
        .filter((d) =>
          scope === "open"
            ? isOpen(d)
            : scope === "attention"
              ? ["failed", "needs_source", "paused", "no_text"].includes(
                  d.status,
                )
              : true,
        )
        .sort((a, b) =>
          sort === "year"
            ? (b.year || 0) - (a.year || 0)
            : sort === "updated"
              ? (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
              : a.title.localeCompare(b.title),
        ),
    [documents, scope, sort, openDocumentIds],
  );
  const groups = useMemo(() => {
    const map = new Map<string, LibraryHit[]>();
    for (const h of hits) {
      const key = identity(h);
      map.set(key, [...(map.get(key) || []), h]);
    }
    return [...map.values()];
  }, [hits]);
  const run = async (action: () => Promise<void>, success = "") => {
    if (busy) return;
    const generation = context.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (generation === context.current) {
        await refresh();
        setMessage(success);
      }
    } catch (e) {
      if (generation === context.current) setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const search = async (next: string | null = null) => {
    if (!query.trim()) return;
    const yearFrom = filter.yearFrom ? Number(filter.yearFrom) : null,
      yearTo = filter.yearTo ? Number(filter.yearTo) : null;
    if (
      (yearFrom !== null && !Number.isInteger(yearFrom)) ||
      (yearTo !== null && !Number.isInteger(yearTo)) ||
      (yearFrom !== null && yearTo !== null && yearFrom > yearTo)
    ) {
      setError("Enter a valid year range.");
      return;
    }
    if (
      filter.property &&
      filter.type === "number" &&
      (!filter.value.trim() || !Number.isFinite(Number(filter.value)))
    ) {
      setError("Enter a finite property number.");
      return;
    }
    if (
      filter.property &&
      filter.type === "boolean" &&
      !["true", "false"].includes(filter.value)
    ) {
      setError("Enter true or false for the property value.");
      return;
    }
    const seq = ++request.current;
    setSearching(true);
    setError("");
    if (!next) setSubmitted(query.trim());
    try {
      const searchArgs =
        next && submittedArgs.current
          ? { ...submittedArgs.current, cursor: next }
          : {
              query: query.trim(),
              cursor: next,
              projectId: projectId || null,
              filter: {
                author: filter.author || null,
                yearFrom,
                yearTo,
                tag: filter.tag || null,
                collection: filter.collection || null,
                hasAnnotations:
                  filter.annotations === "any"
                    ? null
                    : filter.annotations === "yes",
                metadataText: filter.metadataText || null,
                properties: filter.property
                  ? {
                      [filter.property]:
                        filter.type === "number"
                          ? Number(filter.value)
                          : filter.type === "boolean"
                            ? filter.value === "true"
                            : filter.value,
                    }
                  : {},
              },
            };
      if (!next) submittedArgs.current = searchArgs;
      const page = await call<{
        hits: LibraryHit[];
        nextCursor: string | null;
        capped: boolean;
      }>("global_search_page", searchArgs);
      if (seq !== request.current) return;
      setHits((previous) => (next ? [...previous, ...page.hits] : page.hits));
      setCursor(page.nextCursor);
      setCapped(page.capped);
    } catch (e) {
      if (seq === request.current) {
        setError(String(e));
        if (!next) setHits([]);
      }
    } finally {
      if (seq === request.current) setSearching(false);
    }
  };
  const saveMetadata = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const source = selected;
    const data = new FormData(event.currentTarget);
    void run(async () => {
      await call(
        "library_update_metadata",
        {
          hash: source.documentHash,
          title: String(data.get("title")),
          authors: String(data.get("authors"))
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean),
          year: data.get("year") ? Number(data.get("year")) : null,
        },
        source,
      );
      setSelected({
        ...source,
        title: String(data.get("title")),
        authors: String(data.get("authors"))
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean),
        year: data.get("year") ? Number(data.get("year")) : undefined,
      });
    }, "Metadata saved");
  };
  return (
    <section className="key-library" aria-label="Library">
      <div className="key-library-main">
        <header className="key-library-heading">
          <div>
            <div className="key-library-breadcrumb">Home / Sources</div>
            <h1>{scopeLabel}</h1>
            <p>
              {total} documents ·{" "}
              {documents.filter((d) => d.status === "indexed").length}{" "}
              searchable ·{" "}
              {documents.filter((d) => activeStates.has(d.status)).length}{" "}
              processing on this page
            </p>
          </div>
          <button onClick={() => setRoadmap(true)}>
            Roadmap <span className="key-mock-badge">Preview</span>
          </button>
        </header>
        <nav className="key-library-scopes" aria-label="Library views">
          {[
            ["all", "All sources"],
            ["open", "Open"],
            ["attention", "Needs attention"],
            ["removed", "Removed"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={scope === id}
              onClick={() => setScope(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="key-library-toolbar">
          <div className="key-view-switch">
            {["table", "list"].map((v) => (
              <button
                key={v}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === "table" ? "▤ Table" : "☷ List"}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input
              aria-label="Search passages"
              placeholder="Search passages · keyword or describe an idea"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button disabled={searching || !query.trim()}>Search</button>
          </form>
          <button
            aria-expanded={showFilters}
            onClick={() => setShowFilters(!showFilters)}
          >
            Filter
          </button>
          <select
            aria-label="Sort library"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="title">Title</option>
            <option value="year">Year</option>
            <option value="updated">Last updated</option>
          </select>
          <button className="key-primary" onClick={onAddSources}>
            ＋ Add PDFs
          </button>
        </div>
        {showFilters && (
          <form
            className="key-library-filters"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            {[
              ["author", "Author"],
              ["yearFrom", "Year from"],
              ["yearTo", "Year to"],
              ["tag", "Tag"],
              ["collection", "Collection"],
              ["metadataText", "Metadata or comments"],
              ["property", "Property name"],
              ["value", "Property value"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={filter[key as keyof typeof filter]}
                  onChange={(e) =>
                    setFilter({ ...filter, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label>
              Annotations
              <select
                value={filter.annotations}
                onChange={(e) =>
                  setFilter({ ...filter, annotations: e.target.value })
                }
              >
                <option value="any">Any</option>
                <option value="yes">With annotations</option>
                <option value="no">Without annotations</option>
              </select>
            </label>
            <label>
              Property type
              <select
                value={filter.type}
                onChange={(e) => setFilter({ ...filter, type: e.target.value })}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="boolean">True / false</option>
              </select>
            </label>
            <button type="button" onClick={() => setFilter(emptyFilter)}>
              Reset
            </button>
            <button disabled={searching || !query.trim()}>
              Apply to search
            </button>
          </form>
        )}
        {error && (
          <div className="key-library-error" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {message && (
          <p className="key-library-message" role="status">
            {message}
          </p>
        )}
        {removed && (
          <p className="key-library-message" role="status">
            Removed “{removed.title}”.{" "}
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call(
                    "library_set_removed",
                    { hash: removed.documentHash, removed: false },
                    removed,
                  );
                  setRemoved(undefined);
                }, "Restored")
              }
            >
              Undo
            </button>
          </p>
        )}
        <div className="key-library-scroll">
          {submitted ? (
            <div className="key-library-results">
              <header>
                <strong>
                  {searching ? "Searching…" : `${hits.length} matches loaded`}{" "}
                  for “{submitted}”
                </strong>
                <button
                  onClick={() => {
                    ++request.current;
                    setSearching(false);
                    setSubmitted("");
                    setHits([]);
                  }}
                >
                  Back to library
                </button>
              </header>
              {!searching && !hits.length && !error && (
                <p className="key-library-empty">
                  No matching passages. Try different words or fewer filters.
                </p>
              )}
              {groups.map((group) => (
                <article key={identity(group[0])}>
                  <h2>
                    {group[0].documentTitle ||
                      documents.find((d) => identity(d) === identity(group[0]))
                        ?.title ||
                      "Document"}
                  </h2>
                  {group.map((hit) => (
                    <button
                      className="key-library-hit"
                      key={`${identity(hit)}:${hit.id}`}
                      onClick={() => {
                        const source = documents.find(
                          (d) => identity(d) === identity(hit),
                        ) || {
                          documentId: hit.documentId,
                          documentHash: hit.documentHash,
                          title: hit.documentTitle || "Document",
                          workspaceId: hit.workspaceId,
                          pageCount: hit.page + 1,
                          status: "indexed",
                          completed: 0,
                          total: 0,
                        };
                        onOpenSource(source, hit);
                      }}
                    >
                      <span>
                        Page {hit.page + 1} <span>Open passage ↗</span>
                      </span>
                      <p>{hit.targetText || hit.text}</p>
                    </button>
                  ))}
                </article>
              ))}
              {cursor && (
                <button
                  disabled={searching}
                  onClick={() => void search(cursor)}
                >
                  Load more results
                </button>
              )}
              {capped && (
                <p>
                  Showing up to 1,000 candidate passages. Narrow your search for
                  more specific results.
                </p>
              )}
            </div>
          ) : loading ? (
            <p className="key-library-empty" role="status">
              Loading sources…
            </p>
          ) : !visible.length ? (
            <div className="key-library-empty">
              <h2>
                {scope === "all"
                  ? "Your sources live here"
                  : "No documents in this view"}
              </h2>
              <p>
                Add PDFs to read immediately. Search indexing happens in the
                background.
              </p>
              <button onClick={onAddSources}>Add PDFs</button>
            </div>
          ) : (
            <table className={`key-source-table ${view}`}>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Authors</th>
                  <th>Year</th>
                  <th>Pages</th>
                  <th>Search readiness</th>
                  <th>
                    <span className="key-sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr
                    key={identity(d)}
                    className={
                      selected && identity(selected) === identity(d)
                        ? "selected"
                        : ""
                    }
                    tabIndex={0}
                    onClick={() => setSelected(d)}
                    onDoubleClick={() => {
                      if (scope !== "removed") onOpenSource(d);
                    }}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && e.key === "Enter") {
                        e.preventDefault();
                        if (scope !== "removed") onOpenSource(d);
                      }
                    }}
                  >
                    <td>
                      <span className="key-source-title" title={d.title}>
                        ▱ {d.title}
                      </span>
                      {isOpen(d) && (
                        <span className="key-open-badge">Open</span>
                      )}
                      {view === "list" && (
                        <small>
                          {d.authors?.join(", ") || "Unknown author"} ·{" "}
                          {d.year || "—"} · {d.pageCount} pages
                        </small>
                      )}
                    </td>
                    <td>{d.authors?.join("; ") || "—"}</td>
                    <td>{d.year || "—"}</td>
                    <td>{d.pageCount}</td>
                    <td>
                      <span className={`key-source-status ${d.status}`}>
                        {statusText(d)}
                      </span>
                      {activeStates.has(d.status) && d.total > 0 && (
                        <progress
                          max={d.total}
                          value={d.completed}
                          aria-label={`${d.title} processing`}
                        />
                      )}
                    </td>
                    <td>
                      <button
                        aria-label={`Details for ${d.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(d);
                        }}
                      >
                        •••
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!submitted && (offset > 0 || nextOffset !== null) && (
            <div className="key-library-pagination">
              <button
                disabled={loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 200))}
              >
                Previous 200
              </button>
              <span>
                Sources {Math.min(offset + 1, total)}–
                {Math.min(offset + documents.length, total)} of {total}
                {scope === "open" || scope === "attention"
                  ? " · view filters apply to this page"
                  : ""}
              </span>
              <button
                disabled={loading || nextOffset === null}
                onClick={() => {
                  if (nextOffset !== null) setOffset(nextOffset);
                }}
              >
                Next 200 sources
              </button>
            </div>
          )}
        </div>
      </div>
      {selected && (
        <aside className="key-library-detail" aria-label="Document details">
          <header>
            <strong>Details</strong>
            <button
              aria-label="Close details"
              onClick={() => setSelected(undefined)}
            >
              ×
            </button>
          </header>
          <h2>{selected.title}</h2>
          <p>{statusText(selected)}</p>
          <div className="key-detail-actions">
            {scope !== "removed" && (
              <button
                className="key-primary"
                onClick={() =>
                  selected.status === "needs_source"
                    ? onAddSources()
                    : onOpenSource(selected)
                }
              >
                {selected.status === "needs_source"
                  ? "Relink original PDF"
                  : isOpen(selected)
                    ? "Go to tab ↗"
                    : "Open PDF ↗"}
              </button>
            )}
            {(activeStates.has(selected.status) ||
              ["paused", "failed"].includes(selected.status)) && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(
                      "library_processing_control",
                      {
                        hash: selected.documentHash,
                        action:
                          selected.status === "paused"
                            ? "resume"
                            : selected.status === "failed"
                              ? "retry"
                              : "pause",
                      },
                      selected,
                    );
                  }, "Processing updated")
                }
              >
                {selected.status === "paused"
                  ? "Resume"
                  : selected.status === "failed"
                    ? "Retry"
                    : "Pause"}
              </button>
            )}
          </div>
          <form key={`metadata:${identity(selected)}`} onSubmit={saveMetadata}>
            <label>
              Title
              <input name="title" defaultValue={selected.title} required />
            </label>
            <label>
              Authors
              <input
                name="authors"
                defaultValue={selected.authors?.join("; ")}
                placeholder="Separate authors with ;"
              />
            </label>
            <label>
              Year
              <input
                name="year"
                type="number"
                step="1"
                defaultValue={selected.year || ""}
              />
            </label>
            <button disabled={busy}>Save metadata</button>
          </form>
          {details && (
            <>
              <form
                key={`labels:${identity(selected)}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const source = selected;
                  void run(async () => {
                    await call(
                      "library_set_labels",
                      {
                        hash: source.documentHash,
                        tags: String(data.get("tags"))
                          .split(";")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        collections: String(data.get("collections"))
                          .split(";")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                      source,
                    );
                  }, "Labels saved");
                }}
              >
                <label>
                  Tags
                  <input
                    name="tags"
                    defaultValue={details.tags.join("; ")}
                    placeholder="Separate tags with ;"
                  />
                </label>
                <label>
                  Collections
                  <input
                    name="collections"
                    defaultValue={details.collections.join("; ")}
                  />
                </label>
                <button disabled={busy}>Save labels</button>
              </form>
              <h3>Properties</h3>
              {Object.entries(details.properties).map(([key, value]) => (
                <p key={key}>
                  {key}: {String(value)}
                </p>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const name = String(data.get("name")).trim(),
                    raw = String(data.get("value")),
                    type = data.get("type");
                  if (
                    !name ||
                    (type === "number" &&
                      (!raw.trim() || !Number.isFinite(Number(raw)))) ||
                    (type === "boolean" && !["true", "false"].includes(raw))
                  ) {
                    setError("Enter a property name and valid typed value.");
                    return;
                  }
                  const value =
                    type === "number"
                      ? Number(raw)
                      : type === "boolean"
                        ? raw === "true"
                        : raw;
                  const source = selected;
                  void run(async () => {
                    await call(
                      "library_set_property",
                      { hash: source.documentHash, name, value },
                      source,
                    );
                    setDetails(
                      await call<Metadata>(
                        "library_metadata_details",
                        { hash: source.documentHash },
                        source,
                      ),
                    );
                  }, "Property saved");
                }}
              >
                <label>
                  Property name
                  <input name="name" required />
                </label>
                <label>
                  Type
                  <select name="type">
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">True / false</option>
                  </select>
                </label>
                <label>
                  Value
                  <input name="value" required />
                </label>
                <button disabled={busy}>Save property</button>
              </form>
            </>
          )}
          {projects.length > 0 && (
            <details className="key-source-projects">
              <summary>Project membership</summary>
              {!sourceRecordId && <small>Loading source record…</small>}
              {projects.map((project) => (
                <div key={project.id}>
                  <span>{project.name}</span>
                  <button
                    disabled={busy || !sourceRecordId}
                    onClick={() =>
                      void run(async () => {
                        await call(
                          "workspace_set_project_membership",
                          {
                            projectId: project.id,
                            recordId: sourceRecordId,
                            present: true,
                          },
                          selected,
                        );
                      }, `Added to ${project.name}`)
                    }
                  >
                    Add
                  </button>
                  <button
                    disabled={busy || !sourceRecordId}
                    onClick={() =>
                      void run(async () => {
                        await call(
                          "workspace_set_project_membership",
                          {
                            projectId: project.id,
                            recordId: sourceRecordId,
                            present: false,
                          },
                          selected,
                        );
                      }, `Removed from ${project.name}`)
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </details>
          )}
          <button onClick={() => setRoadmap(true)}>
            Formulas & agentic fill{" "}
            <span className="key-mock-badge">Preview</span>
          </button>
          <div className="key-detail-danger">
            {scope === "removed" ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call(
                        "library_set_removed",
                        { hash: selected.documentHash, removed: false },
                        selected,
                      );
                      setSelected(undefined);
                    }, "Document restored")
                  }
                >
                  Restore
                </button>
                <button
                  disabled={busy || isOpen(selected)}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Permanently delete “${selected.title}”, its saved PDF, annotations and metadata? Your original file outside Key is kept. This cannot be undone.`,
                      )
                    )
                      void run(async () => {
                        await call(
                          "library_purge",
                          { hash: selected.documentHash },
                          selected,
                        );
                        setSelected(undefined);
                      }, "Permanently deleted");
                  }}
                >
                  Delete permanently
                </button>
                {isOpen(selected) && (
                  <small>Close this PDF in every tab before deleting it.</small>
                )}
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(
                      "library_set_removed",
                      { hash: selected.documentHash, removed: true },
                      selected,
                    );
                    setRemoved(selected);
                    setSelected(undefined);
                  }, "")
                }
              >
                Remove from library
              </button>
            )}
          </div>
        </aside>
      )}
      {roadmap && (
        <div className="key-roadmap-backdrop" onClick={() => setRoadmap(false)}>
          <section
            className="key-roadmap"
            role="dialog"
            aria-modal="true"
            aria-label="Library roadmap"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>Library roadmap</h2>
              <button
                aria-label="Close roadmap"
                onClick={() => setRoadmap(false)}
              >
                ×
              </button>
            </header>
            <p>
              These design concepts are previews. They do not process or change
              your sources.
            </p>
            <ul>
              <li>
                <strong>Flexible databases:</strong> select properties,
                relations, formulas, rollups and saved views.
              </li>
              <li>
                <strong>Agentic properties:</strong> editable prompts and chosen
                inputs, with per-cell or batch filling.
              </li>
              <li>
                <strong>Bibliographic enrichment:</strong> metadata extraction,
                DOI/BibTeX/RIS reference import and open-access PDF lookup.
              </li>
              <li>
                <strong>More source types:</strong> video and podcast
                transcripts, web snapshots and image descriptions.
              </li>
              <li>
                <strong>Organization:</strong> tag consolidation, bulk edits and
                pinnable/resizable columns.
              </li>
            </ul>
            <p>
              PDF import, search, processing controls, scalar properties and
              metadata editing use the real library.
            </p>
            <button onClick={() => setRoadmap(false)}>Back to library</button>
          </section>
        </div>
      )}
    </section>
  );
}
