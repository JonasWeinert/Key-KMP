// A source as one document, like a Notion page: its title and authors, a compact grid of
// bibliographic fields and the user's own properties, the abstract, then the note itself,
// followed by the PDF's highlights (each quotable into the note) and any further notes.
// Opened beside the PDF reader for sources that have one, and as the library's details
// panel (`variant="side"`), so a source looks the same wherever it is shown.
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apa, apaInText, bibtex } from "./citation";
import { Icon } from "./icons";
import { ProgressRing } from "./index-activity";
import { ItemPage } from "./ItemPage";
import { ITEM_TYPES, KIND_ICON, OA_LABEL, bridge as libraryBridge, fetchedAgo, formatBytes, itemTypeLabel, shortCreators, type Collection, type Facet, type Invoke, type Note, type Source, type SourceGraph } from "./library-api";
import { libraryChanged } from "./library-nav";
import { FilterButton, FilterLink, FilterLinks, fieldFilter, showInLibrary, sourceFilter } from "./filter-links";
import { EntityLink } from "./entity-ui";
import { WorkReferences } from "./work-references";
import NoteEditor from "./note-editor";
import { noteSources } from "./note-sources";
import LinkedFrom from "./LinkedFrom";
import { setItemDrag } from "./item-links";
import { itemAttrs } from "./item-ui";
import { readAppearance } from "./page-appearance";
import { PropertySheet, usePropertyDefinitions, type PropertySheetState } from "./PropertySheets";
import { AutoText, Creators, DEFAULT_FIELDS, FIELDS, FieldRow, MORE_FIELDS, TagEditor, TypedProperties, indexLabel } from "./SourceInspector";

interface Highlight {
  id: string;
  text?: string;
  comment?: string;
  color?: string;
  range?: { start?: { page?: number } };
  anchor?: { pages?: { page?: number }[] };
}
const bridge = () =>
  (window as unknown as {
    key: { on(event: string, cb: (value: unknown) => void): () => void; tabAction(action: string, payload?: unknown): Promise<unknown> };
  }).key;
const highlightPage = (h: Highlight) => h.anchor?.pages?.[0]?.page ?? h.range?.start?.page;
const quoteBlock = (text: string, sourceId: string, page?: number, color?: string) => {
  const body = text.replace(/\r\n?/g, "\n").replace(/[ \t]*\n[ \t]*/g, " ").trim();
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const attrs = [`source="${sourceId}"`, page === undefined ? "" : `page="${page}"`, color ? `color="${color}"` : ""].filter(Boolean).join(" ");
  return `${fence}quote ${attrs}\n${body}\n${fence}`;
};

/** What the library's details panel adds around the page. */
export interface SourceSide {
  onClose: () => void;
  onOpenPage: (source: Source) => void;
  onChanged: (source: Source) => void;
  onAgentFill: (propertyName?: string) => void;
  /** Live stage while this source is being read or indexed. */
  progress?: { fraction: number; label: string };
}

export default function SourcePage({ invoke, workspaceId, sourceId, viewId, side }: { invoke: Invoke; workspaceId: string; sourceId: string; viewId?: string; side?: SourceSide }) {
  const [source, setSource] = useState<Source>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  // In the library's side panel a clicked value filters the library; on its own page it opens the library filtered.
  const libraryFilter = useContext(FilterLinks);
  const filterBy = libraryFilter ?? ((filter: Parameters<typeof showInLibrary>[1]) => showInLibrary(workspaceId, filter));
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<Facet[]>([]);
  const [moreFields, setMoreFields] = useState(false);
  const [abstractOpen, setAbstractOpen] = useState(false);
  /** People, journal, topics, citations: the metadata graph around the source. */
  const [graph, setGraph] = useState<SourceGraph>();
  const [sheet, setSheet] = useState<PropertySheetState>();
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const { definitions, reload: reloadDefinitions } = usePropertyDefinitions(invoke, workspaceId);
  const sources = useMemo(() => noteSources(invoke, workspaceId), [invoke, workspaceId]);
  // The page's own note is the source's first note; it is created on the first keystroke.
  const page = notes[0];
  const pageId = useRef<string | undefined>(undefined);
  const pageBody = useRef("");
  const lastSent = useRef<string | undefined>(undefined);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Narrow layout beside a PDF, from the measured width (see reference-library.css).
  const pageRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<"wide" | "narrow" | "tight">("wide");
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setWidth(w < 420 ? "tight" : w < 640 ? "narrow" : "wide");
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  const loadSource = useCallback(
    () =>
      invoke<Source | null>("store_source", { id: sourceId }, workspaceId)
        .then((s) => (s ? setSource(s) : setError("This source no longer exists.")))
        .catch((e) => setError(String(e))),
    [invoke, workspaceId, sourceId],
  );
  const loadNotes = useCallback(
    () =>
      invoke<Note[]>("store_notes", { sourceId }, workspaceId)
        .then((list) => {
          pageId.current ??= list[0]?.id;
          const ours = !!list[0] && (pending.current > 0 || list[0].body === lastSent.current);
          if (ours) {
            // Our own save coming back: keep what the editor shows, it may already be newer.
            setNotes((previous) => (previous[0]?.id === list[0].id ? [previous[0], ...list.slice(1)] : list));
          } else {
            // Another view (the details panel, another window) changed it.
            pageBody.current = list[0]?.body ?? "";
            setNotes(list);
          }
        })
        .catch(() => {}),
    [invoke, workspaceId, sourceId],
  );
  const loadGraph = useCallback(
    () =>
      invoke<SourceGraph>("store_source_graph", { id: sourceId }, workspaceId)
        .then(setGraph)
        .catch(() => {}),
    [invoke, workspaceId, sourceId],
  );
  const loadHighlights = useCallback(
    () =>
      invoke<Highlight[]>("library_annotations", { hash: sourceId }, workspaceId)
        .then((list) => setHighlights(list.filter((h) => h.text?.trim() || h.comment?.trim())))
        .catch(() => setHighlights([])),
    [invoke, workspaceId, sourceId],
  );
  useEffect(() => {
    void loadSource();
    void loadGraph();
    // Cached counts (citations, FWCI) are fetched again when old; the host decides.
    void invoke<(Source & { refreshing?: boolean }) | null>("store_refresh", { kind: "source", id: sourceId }, workspaceId)
      .then((s) => {
        if (!s) return;
        setSource(s);
        // Fetched in the background: read the new counts once they are in.
        if (s.refreshing) setTimeout(() => void loadSource(), 2500);
      })
      .catch(() => {});
    void loadHighlights();
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
    void invoke<{ tags: Facet[] }>("store_facets", {}, workspaceId).then((f) => setTagSuggestions(f.tags)).catch(() => {});
  }, [invoke, workspaceId, sourceId, loadSource, loadGraph, loadHighlights]);
  // While OpenAlex is being asked, the page follows the lookup.
  const looking = source?.enrichStatus === "requested" || source?.enrichStatus === "pending";
  useEffect(() => {
    if (!looking) return;
    const timer = setInterval(() => {
      void loadSource();
      void loadGraph();
    }, 1500);
    return () => clearInterval(timer);
  }, [looking, loadSource, loadGraph]);
  useEffect(() => {
    const offs = [
      bridge().on("library-changed", () => {
        void loadSource();
        void loadGraph();
      }),
      bridge().on("note-changed", (p) => (p as { sourceId?: string })?.sourceId === sourceId && void loadNotes()),
      bridge().on("annotations-changed", () => void loadHighlights()),
    ];
    return () => offs.forEach((off) => off());
  }, [sourceId, loadSource, loadGraph, loadNotes, loadHighlights]);
  // The tab follows the title.
  useEffect(() => {
    if (source && viewId) void bridge().tabAction("content-title", { viewId, title: source.title || "Untitled" });
  }, [source?.title, viewId]);

  const save = async (patch: Record<string, unknown>) => {
    setError("");
    try {
      const next = await invoke<Source>("store_update", { id: sourceId, patch }, workspaceId);
      setSource(next);
      side?.onChanged(next);
      libraryChanged();
    } catch (e) {
      setError(String(e));
    }
  };
  /** Saves the page note (creating it if needed); saves run one at a time, newest text wins. */
  const savePage = (body: string) => {
    pageBody.current = body;
    pending.current += 1;
    const run = queue.current
      .then(async () => {
        lastSent.current = pageBody.current;
        const saved = await invoke<Note>("store_note_save", { id: pageId.current ?? null, sourceId, title: "", body: pageBody.current }, workspaceId);
        if (!pageId.current) {
          pageId.current = saved.id;
          setNotes((list) => (list.length ? list : [saved]));
        }
      })
      .finally(() => (pending.current -= 1));
    queue.current = run.catch(() => {});
    return run;
  };
  /** Appends Markdown to the page note and scrolls to it, briefly flashing it. */
  const jump = useRef(false);
  const append = useCallback((markdown: string) => {
    const next = pageBody.current.trim() ? `${pageBody.current.trimEnd()}\n\n${markdown}\n` : `${markdown}\n`;
    jump.current = true;
    setNotes((list) => (list.length ? [{ ...list[0], body: next }, ...list.slice(1)] : [{ id: "", sourceId, title: "", body: next, createdAt: 0, updatedAt: 0 }]));
    void savePage(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);
  const quote = (h: Highlight) => append(quoteBlock(h.text?.trim() || h.comment?.trim() || "", sourceId, highlightPage(h), h.color));
  useEffect(() => {
    if (!jump.current) return;
    jump.current = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const quotes = pageRef.current?.querySelectorAll<HTMLElement>(".kx-page-note .ne-squote");
        const target = quotes?.[quotes.length - 1] ?? pageRef.current?.querySelector<HTMLElement>(".kx-page-note .ProseMirror > :last-child");
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("kx-flash");
        setTimeout(() => target.classList.remove("kx-flash"), 1800);
      }),
    );
  }, [notes]);
  // Passages sent from the PDF ("Add to note") wait in the main process until the page,
  // once its note has loaded, takes and appends them.
  const notesLoaded = useRef(false);
  const takeAppends = useCallback(async () => {
    if (!notesLoaded.current) return;
    const queued = (await bridge().tabAction("take-note-appends", { sourceId })) as { text: string; page: number; color?: string }[];
    for (const p of queued ?? []) append(quoteBlock(p.text, sourceId, p.page, p.color));
  }, [sourceId, append]);
  useEffect(() => {
    notesLoaded.current = false;
    void loadNotes().then(() => {
      notesLoaded.current = true;
      void takeAppends();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);
  useEffect(
    () =>
      bridge().on("note-append", (p) => {
        if ((p as { sourceId?: string })?.sourceId === sourceId) void takeAppends();
      }),
    [sourceId, takeAppends],
  );
  const openNote = (note: Note) =>
    void bridge().tabAction("open-content", { section: "note", workspaceId, noteId: note.id, title: note.title });
  const newNote = async () => {
    const saved = await invoke<Note>("store_note_save", { id: null, sourceId, title: "", body: "" }, workspaceId);
    setNotes((list) => [...list, saved]);
  };
  const deleteNote = async (note: Note) => {
    if (note.body.trim() && !window.confirm("Delete this note?")) return;
    await invoke("store_note_delete", { id: note.id }, workspaceId);
    setNotes((list) => list.filter((n) => n.id !== note.id));
  };
  const findPdf = async () => {
    setError("");
    try {
      const lookup = await invoke<{ fullTextUrl?: string | null }>("scholarly_lookup_resource", { resource: source!.doi || source!.url }, workspaceId);
      if (!lookup.fullTextUrl) throw Error("No open-access PDF was found for this reference.");
      const next = await invoke<Source>("library_download_pdf", { url: lookup.fullTextUrl, sourceId }, workspaceId);
      setSource(next);
      side?.onChanged(next);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };
  const enrich = async () => {
    setError("");
    try {
      await invoke("store_enrich", { ids: [sourceId] }, workspaceId);
      await loadSource();
    } catch (e) {
      setError(String(e));
    }
  };
  const copy = async (label: string, text: string, html?: string) => {
    try {
      if (html && "ClipboardItem" in window)
        await navigator.clipboard.write([
          new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
        ]);
      else await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1400);
    } catch (e) {
      setError(String(e));
    }
  };

  if (error && !source) return <p className="kx-note-page-error">{error}</p>;
  if (!source) return <div className="kx-source-page" aria-busy="true" />;
  // Like a Notion page: filled fields show, empty ones wait behind "N empty fields".
  // A source with no details yet shows its type's main fields to fill in.
  const all = [...(FIELDS[source.itemType || ""] ?? DEFAULT_FIELDS), ...MORE_FIELDS];
  const filled = all.filter(([key]) => source[key] !== undefined && source[key] !== null && source[key] !== "");
  const shown = moreFields ? all : filled.length ? filled : (FIELDS[source.itemType || ""] ?? DEFAULT_FIELDS);
  const hidden = all.length - shown.length;
  const names = new Map(collections.map((c) => [c.id, c.name]));
  const isPdf = !!source.filePath && source.kind === "pdf";
  const pageNote = page?.body ?? "";
  /** The PDF on its own: jumps to it when it is already open anywhere. */
  const openReaderTab = () =>
    void (window as unknown as { key: { openSource(s: unknown): Promise<unknown> } }).key.openSource({
      documentHash: source.fileHash,
      documentId: source.fileHash,
      title: source.title || "Untitled",
      workspaceId,
      pageCount: source.pageCount ?? 0,
    });
  const openReader = () =>
    void bridge().tabAction("open-source-page", {
      workspaceId,
      sourceId,
      title: source.title,
      read: true,
      pdf: { documentHash: source.fileHash, documentId: source.fileHash, title: source.title || "Untitled", workspaceId, pageCount: source.pageCount ?? 0 },
    });

  const status = indexLabel(source);
  const progress = side?.progress;

  // Everything between the title and the highlights folds under "Details" (see ItemPage).
  const details = (
    <>
        <section className="kx-page-properties" aria-label="Properties">
          <div className="kx-field-row kx-page-chips kx-page-author">
            <span>Author</span>
            <Creators creators={source.creators} onCommit={(creators) => void save({ creators })} />
          </div>
          {shown.map(([key, label, kind]) => (
            <FieldRow
              key={key}
              label={label}
              kind={kind}
              value={source[key] as string | number | undefined}
              filter={fieldFilter(key, source[key])}
              entity={key === "containerTitle" && graph?.venue ? { kind: "venue", id: graph.venue.id, name: graph.venue.name } : undefined}
              onCommit={(value) => void save({ [key]: kind === "number" ? (value === "" ? null : Number(value)) : value })} />
          ))}
          <ResearchRows source={source} graph={graph} onEnrich={() => void enrich()} />
          <div className="kx-field-row kx-page-chips">
            <span>Tags</span>
            <TagEditor tags={source.tags} suggestions={tagSuggestions} onCommit={(tags) => void save({ tags })} />
          </div>
          <div className="kx-field-row kx-page-chips">
            <span>Collections</span>
            <div className="kx-chips">
              {source.collections.map((id) => (
                <span className="kx-chip" key={id}>
                  <Icon name="folder" size={11} />
                  <FilterLink filter={sourceFilter.collection(id, names.get(id) ?? "Collection")}>{names.get(id) ?? "Collection"}</FilterLink>
                  <button
                    aria-label={`Remove from ${names.get(id) ?? "collection"}`}
                    onClick={() =>
                      void invoke("store_membership", { collectionId: id, ids: [sourceId], present: false }, workspaceId).then(() => {
                        void loadSource();
                        libraryChanged();
                      })
                    }
                  >
                    <Icon name="close" size={9} />
                  </button>
                </span>
              ))}
              <select
                className="kx-chip-add"
                aria-label="Add to collection"
                value=""
                onChange={(e) =>
                  e.target.value &&
                  void invoke("store_membership", { collectionId: e.target.value, ids: [sourceId], present: true }, workspaceId).then(() => {
                    void loadSource();
                    libraryChanged();
                  })
                }
              >
                <option value="">+ Add to…</option>
                {collections
                  .filter((c) => !source.collections.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <TypedProperties
            source={source}
            definitions={definitions}
            onCommit={(properties) => void save({ properties })}
            onEdit={(definition) => setSheet({ mode: "edit", definition, targets: [source] })}
            onFill={side?.onAgentFill ?? (() => {})}
          />
          <div className="kx-page-properties-foot">
            {(hidden > 0 || moreFields) && (
              <button onClick={() => setMoreFields(!moreFields)}>{moreFields ? "Hide empty fields" : `${hidden} empty ${hidden === 1 ? "field" : "fields"}`}</button>
            )}
            <button onClick={() => setSheet({ mode: "new", targets: [source] })}>
              <Icon name="plus" size={11} /> Add a property
            </button>
          </div>
        </section>

        <section className="kx-page-abstract" data-open={abstractOpen}>
          <button className="kx-page-abstract-toggle" onClick={() => setAbstractOpen(!abstractOpen)} aria-expanded={abstractOpen}>
            <Icon name="chevronRight" size={11} />
            Abstract
          </button>
          {abstractOpen ? (
            <AutoText className="kx-abstract kx-page-abstract-text" label="Abstract" value={source.abstract || ""} placeholder="Add an abstract" onCommit={(abstract) => void save({ abstract })} />
          ) : (
            source.abstract && (
              <p className="kx-page-abstract-preview" onClick={() => setAbstractOpen(true)}>
                {source.abstract}
              </p>
            )
          )}
        </section>
        {(source.filePath || source.indexStatus !== "skipped") && (
          <section className="kx-page-file" aria-label="File and search">
            <div className="kx-file-card">
              {source.filePath ? (
                <>
                  <div className="kx-file-name" title={source.filePath}>
                    <Icon name={KIND_ICON[source.kind] ?? "doc"} size={14} />
                    <span>{/\/\.key\/files\/[0-9a-f]{64}\./.test(source.filePath) ? "Saved in this workspace" : source.filePath.split("/").pop()}</span>
                  </div>
                  <small>{[source.pageCount ? `${source.pageCount} pages` : "", formatBytes(source.fileSize), source.mime].filter(Boolean).join(" · ")}</small>
                </>
              ) : (
                <small>No file. Title and abstract are searchable.</small>
              )}
              <div className="kx-index-line" data-tone={progress ? "busy" : status.tone}>
                {progress ? <ProgressRing fraction={progress.fraction} size={14} /> : <span className="kx-status-dot" data-tone={status.tone} />}
                <span>{progress ? progress.label : status.label}</span>
              </div>
              {progress && (
                <div className="kx-meter">
                  <span style={{ width: `${progress.fraction * 100}%` }} />
                </div>
              )}
            </div>
            <footer className="kx-inspector-foot">
              Added {readableDate(source.addedAt)} · Modified {readableDate(source.updatedAt)}
              {source.origin === "zotero" ? " · from Zotero" : ""}
            </footer>
          </section>
        )}
    </>
  );
  const detailsSummary = [
    shortCreators(source.creators),
    source.containerShort || source.containerTitle,
    source.year,
    source.tags.length && `${source.tags.length} ${source.tags.length === 1 ? "tag" : "tags"}`,
    source.collections.length && `${source.collections.length} ${source.collections.length === 1 ? "collection" : "collections"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <FilterLinks.Provider value={filterBy}>
    <ItemPage
      kind="source"
      className="kx-source-page"
      innerClassName="kx-source-page-inner"
      pageRef={pageRef}
      data-narrow={width !== "wide"}
      data-tight={width === "tight"}
      data-side={!!side}
      appearance={readAppearance(source.appearance)}
      onAppearance={(appearance) => void save({ appearance })}
      media={sources.media}
      defaultIcon={KIND_ICON[source.kind] ?? "doc"}
      bar={
        // Like a note's: what it is on the left, a few quiet actions on the right, the rest under "More".
        <header className="kx-note-page-head kx-source-page-bar">
          <span className="kx-note-source kx-kind-badge" data-kind={source.kind}>
            <Icon name={KIND_ICON[source.kind] ?? "doc"} size={12} />
            <select aria-label="Item type" value={source.itemType || "document"} onChange={(e) => void save({ itemType: e.target.value })}>
              {!ITEM_TYPES.some(([id]) => id === source.itemType) && <option value={source.itemType}>{itemTypeLabel(source.itemType)}</option>}
              {ITEM_TYPES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </span>
          <span className="kx-spacer" />
          {copied && (
            <span className="kx-note-saved" aria-live="polite">
              Copied {copied}
            </span>
          )}
          {isPdf ? (
            <button className="kx-page-action" onClick={openReader} title="Read the PDF beside this page">
              <Icon name="book" size={13} />
              Read
            </button>
          ) : source.filePath ? (
            <button className="kx-icon-button" title="Open file" aria-label="Open file" onClick={() => void libraryBridge().openPath(source.filePath!)}>
              <Icon name="external" size={14} />
            </button>
          ) : (
            (source.url || source.doi) && (
              <button className="kx-icon-button" title="Open link" aria-label="Open link" onClick={() => window.open(source.url || `https://doi.org/${source.doi}`, "_blank")}>
                <Icon name="globe" size={14} />
              </button>
            )
          )}
          <button className="kx-icon-button" data-active={source.starred} aria-pressed={source.starred} title={source.starred ? "Unstar" : "Star"} onClick={() => void save({ starred: !source.starred })}>
            <Icon name="star" size={14} fill={source.starred ? "currentColor" : "none"} />
          </button>
          <details className="kx-menu kx-source-more">
            <summary className="kx-icon-button" title="More" aria-label="More">
              <Icon name="more" size={14} />
            </summary>
            <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
              <button onClick={() => void copy("APA", apa(source), apa(source, true))}>Copy APA reference</button>
              <button onClick={() => void copy("in-text", apaInText(source))}>Copy in-text citation</button>
              <button onClick={() => void copy("BibTeX", bibtex(source))}>Copy BibTeX</button>
              {isPdf && <button onClick={openReaderTab}>Open PDF in its own tab</button>}
              {!source.filePath && (source.doi || source.url) && <button onClick={() => void findPdf()}>Find PDF</button>}
              {source.filePath && <button onClick={() => void libraryBridge().revealPath(source.filePath!)}>Show in Finder</button>}
              <button onClick={() => void enrich()}>Look up in OpenAlex</button>
              <button onClick={() => void invoke("store_index_control", { action: "reindex", ids: [sourceId] }, workspaceId).then(() => void loadSource())}>Re-index</button>
            </div>
          </details>
          {side && (
            <>
              <button className="kx-icon-button" title="Open as page" aria-label="Open as page" onClick={() => side.onOpenPage(source)}>
                <Icon name="doc" size={14} />
              </button>
              <button className="kx-icon-button" title="Close details" aria-label="Close details" onClick={side.onClose}>
                <Icon name="close" size={13} />
              </button>
            </>
          )}
        </header>
      }
      titleText={source.title || ""}
      details={{ summary: detailsSummary, content: details }}
      notice={
        source.retracted === 1 && (
          <div className="kx-retracted" role="alert">
            <Icon name="info" size={14} />
            Retracted
            <span>OpenAlex lists this work as retracted. Check before citing it.</span>
          </div>
        )
      }
      title={<AutoText className="kx-inspector-title kx-source-page-title kx-note-title" label="Title" value={source.title || ""} placeholder="Untitled" onCommit={(title) => void save({ title })} />}
    >
        {source.kind === "image" && source.filePath && (
          // served by the shell from the linked file, so the page shows what the source is
          <figure className="kx-source-image">
            <img src={`key-media://${workspaceId.toLowerCase()}/source/${encodeURIComponent(source.id)}`} alt={source.title || ""} onDoubleClick={() => void libraryBridge().openPath(source.filePath!)} />
          </figure>
        )}
        {error && <p className="kx-inline-error">{error}</p>}

        {highlights.length > 0 && (
          <section className="kx-page-section" data-part-of="highlights">
            <h3>
              Highlights <span className="kx-count">{highlights.length}</span>
            </h3>
            <ul className="kx-page-highlights">
              {highlights.map((h) => {
                const pageIndex = highlightPage(h);
                return (
                  <li
                    key={h.id}
                    data-color={h.color || "orange"}
                    {...itemAttrs({ kind: "source", id: sourceId, anchor: `highlight:${h.id}`, title: h.text || "Highlight" })}
                    draggable
                    onDragStart={(e) => setItemDrag(e.dataTransfer, [{ kind: "source", id: sourceId, anchor: `highlight:${h.id}`, title: h.text || h.comment || "Highlight", detail: source.title, color: h.color }])}
                    title="Drag onto a canvas or into a note"
                  >
                    {h.text && (
                      <blockquote title={h.text}>
                        <mark>{h.text.replace(/\s*\r?\n\s*/g, " ")}</mark>
                      </blockquote>
                    )}
                    {h.comment && <p className="kx-page-highlight-comment">{h.comment}</p>}
                    <footer>
                      {pageIndex !== undefined && <span>p. {pageIndex + 1}</span>}
                      <span className="kx-spacer" />
                      <button onClick={() => quote(h)}>
                        <Icon name="quote" size={11} /> Quote in note
                      </button>
                      {isPdf && (
                        <button onClick={() => sources.onOpenSource(sourceId, pageIndex, h.id)}>
                          <Icon name="book" size={11} /> Show in PDF
                        </button>
                      )}
                    </footer>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="kx-page-note" data-part-of="notes">
          {page?.id && (
            <div className="kx-page-note-bar">
              <button title="Open in a tab" aria-label="Open note in a tab" onClick={() => openNote(page)}>
                <Icon name="external" size={11} />
              </button>
              <button title="Add another note" aria-label="New note" onClick={() => void newNote()}>
                <Icon name="plus" size={11} />
              </button>
            </div>
          )}
          {/* One editor for the page's life: creating the note on the first keystroke must not remount it. */}
          <NoteEditor
            value={pageNote}
            onChange={(body) => void savePage(body)}
            searchSources={sources.searchSources}
            resolveSource={sources.resolveSource}
            onOpenSource={sources.onOpenSource}
            media={sources.media}
            searchItems={sources.searchItems}
            searchItemsMore={sources.searchItemsMore}
            citeLabel={sources.citeLabel}
            onOpenItem={sources.onOpenItem}
            placeholder="Write about this source. Type / for blocks, @ to link anything"
          />
        </div>

        <LinkedFrom invoke={invoke} workspaceId={workspaceId} item={{ kind: "source", id: sourceId }} />
        {graph && <WorkReferences invoke={invoke} workspaceId={workspaceId} sourceId={sourceId} graph={graph} hasWork={!!source.openalexId} onChanged={() => void loadGraph()} />}

        {notes.length > 1 && (
          <section className="kx-page-section" data-part-of="notes">
            <h3>
              More notes <span className="kx-count">{notes.length - 1}</span>
            </h3>
            {notes.slice(1).map((note) => (
              <div className="kx-note-card" key={note.id}>
                <div className="kx-note-card-bar">
                  <span>{note.title || new Date(note.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                  <span className="kx-spacer" />
                  <button title="Open in a tab" aria-label="Open note in a tab" onClick={() => openNote(note)}>
                    <Icon name="external" size={11} />
                  </button>
                  <button title="Delete note" aria-label="Delete note" onClick={() => void deleteNote(note)}>
                    <Icon name="trash" size={11} />
                  </button>
                </div>
                <NoteEditor
                  compact
                  autoFocus={!note.body && note === notes[notes.length - 1]}
                  value={note.body}
                  onChange={(body) => void invoke("store_note_save", { id: note.id, sourceId, title: note.title, body }, workspaceId)}
                  searchSources={sources.searchSources}
                  resolveSource={sources.resolveSource}
                  onOpenSource={sources.onOpenSource}
                  media={sources.media}
                  searchItems={sources.searchItems}
                  searchItemsMore={sources.searchItemsMore}
                  citeLabel={sources.citeLabel}
                  onOpenItem={sources.onOpenItem}
                />
              </div>
            ))}
          </section>
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
            void loadSource();
          }}
        />
      )}
    </ItemPage>
    </FilterLinks.Provider>
  );
}

/** What OpenAlex knows of a source, as rows among its properties: each value filters the
 * library (topics open their popover), the counts say when they were fetched. */
function ResearchRows({ source, graph, onEnrich }: { source: Source; graph?: SourceGraph; onEnrich: () => void }) {
  const row = (label: string, children: ReactNode) => (
    <div className="kx-field-row kx-page-chips kx-research-row" data-research={label}>
      <span>{label}</span>
      <div className="kx-research-values">{children}</div>
    </div>
  );
  const status = source.enrichStatus;
  const looking = status === "pending" || status === "requested";
  const nice = (n: number) => [1000, 500, 100, 50, 10].find((step) => n >= step);
  return (
    <>
      {source.citedByCount != null &&
        row(
          "Cited by",
          <>
            <span>
              {source.citedByCount.toLocaleString()} {source.citedByCount === 1 ? "work" : "works"}
              {source.fwci != null && ` · FWCI ${source.fwci.toFixed(1)}`}
            </span>
            {nice(source.citedByCount) && <FilterButton filter={sourceFilter.citations("gte", nice(source.citedByCount)!)} />}
            <small title="Citation counts are cached and refreshed when the page is opened">updated {fetchedAgo(source.metricsAt)}</small>
          </>,
        )}
      {source.oaStatus &&
        row(
          "Access",
          <>
            <FilterLink filter={sourceFilter.oaStatus(source.oaStatus)}>{OA_LABEL[source.oaStatus] ?? source.oaStatus}</FilterLink>
            {source.oaUrl && (
              <a href={source.oaUrl} target="_blank" rel="noreferrer" title={source.oaUrl}>
                <Icon name="external" size={12} />
              </a>
            )}
          </>,
        )}
      {source.workType && row("Work type", <FilterLink filter={sourceFilter.workType(source.workType)}>{workTypeLabel(source.workType)}</FilterLink>)}
      {!!graph?.topics.length &&
        row(
          "Topics",
          graph.topics.map((t) => (
            <EntityLink key={t.id} entity={{ kind: "topic", id: t.id, name: t.name }}>
              {t.name}
            </EntityLink>
          )),
        )}
      {!!graph?.keywords.length &&
        row(
          "Keywords",
          graph.keywords.map((k) => (
            <FilterLink key={k.id} filter={sourceFilter.keyword(k.id, k.name)}>
              {k.name}
            </FilterLink>
          )),
        )}
      {!!graph?.grants.length &&
        row(
          "Funding",
          graph.grants.map((g) => (
            <span key={`${g.funderId}:${g.awardId ?? ""}`}>
              <FilterLink filter={sourceFilter.funder(g.funderId, g.funder)}>{g.funder}</FilterLink>
              {g.awardId && <small> {g.awardId}</small>}
            </span>
          )),
        )}
      {row(
        "OpenAlex",
        <span className="kx-enrich-line">
          {looking ? (
            "Looking up…"
          ) : source.openalexId ? (
            <>
              <a href={`https://openalex.org/${source.openalexId}`} target="_blank" rel="noreferrer">
                {source.openalexId}
              </a>
              <span>looked up {fetchedAgo(source.enrichedAt)}</span>
              <button onClick={onEnrich}>Look up again</button>
            </>
          ) : (
            <>
              {status === "not_found" ? <span>Not found</span> : status === "failed" ? <span title={source.enrichError}>Lookup failed</span> : null}
              <button onClick={onEnrich}>{status ? "Try again" : "Look up"}</button>
            </>
          )}
        </span>,
      )}
    </>
  );
}

/** "Article", "Book chapter" for OpenAlex's article, book-chapter … */
function workTypeLabel(type: string) {
  const text = type.replace(/-/g, " ");
  return text[0].toUpperCase() + text.slice(1);
}

/** "3 Nov 2026". */
function readableDate(at: number) {
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
