// A source as one document, like a Notion page: its title and authors, a compact grid of
// bibliographic fields and the user's own properties, the abstract, then the note itself,
// followed by the PDF's highlights (each quotable into the note) and any further notes.
// Opened beside the PDF reader for sources that have one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apa, apaInText, bibtex } from "./citation";
import { Icon } from "./icons";
import { ITEM_TYPES, KIND_ICON, bridge as libraryBridge, itemTypeLabel, shortCreators, type Collection, type Facet, type Invoke, type Note, type Source } from "./library-api";
import { libraryChanged } from "./library-nav";
import NoteEditor from "./note-editor";
import { noteSources } from "./note-sources";
import { PropertySheet, usePropertyDefinitions, type PropertySheetState } from "./PropertySheets";
import { AutoText, Creators, DEFAULT_FIELDS, FIELDS, FieldRow, MORE_FIELDS, TagEditor, TypedProperties } from "./SourceInspector";

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

export default function SourcePage({ invoke, workspaceId, sourceId, viewId }: { invoke: Invoke; workspaceId: string; sourceId: string; viewId: string }) {
  const [source, setSource] = useState<Source>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<Facet[]>([]);
  const [moreFields, setMoreFields] = useState(false);
  const [abstractOpen, setAbstractOpen] = useState(false);
  // Authors, properties and abstract fold together into one summary line (open by default),
  // so highlights and the note can start right under the title.
  const [detailsOpen, setDetailsOpen] = useState(() => {
    try {
      return localStorage.getItem("key.page.details") !== "closed";
    } catch {
      return true;
    }
  });
  const toggleDetails = (open: boolean) => {
    setDetailsOpen(open);
    try {
      localStorage.setItem("key.page.details", open ? "open" : "closed");
    } catch {}
  };
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
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 640));
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
  const loadHighlights = useCallback(
    () =>
      invoke<Highlight[]>("library_annotations", { hash: sourceId }, workspaceId)
        .then((list) => setHighlights(list.filter((h) => h.text?.trim() || h.comment?.trim())))
        .catch(() => setHighlights([])),
    [invoke, workspaceId, sourceId],
  );
  useEffect(() => {
    void loadSource();
    void loadHighlights();
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
    void invoke<{ tags: Facet[] }>("store_facets", {}, workspaceId).then((f) => setTagSuggestions(f.tags)).catch(() => {});
  }, [invoke, workspaceId, loadSource, loadHighlights]);
  useEffect(() => {
    const offs = [
      bridge().on("library-changed", () => void loadSource()),
      bridge().on("note-changed", (p) => (p as { sourceId?: string })?.sourceId === sourceId && void loadNotes()),
      bridge().on("annotations-changed", () => void loadHighlights()),
    ];
    return () => offs.forEach((off) => off());
  }, [sourceId, loadSource, loadNotes, loadHighlights]);
  // The tab follows the title.
  useEffect(() => {
    if (source) void bridge().tabAction("content-title", { viewId, title: source.title || "Untitled" });
  }, [source?.title, viewId]);

  const save = async (patch: Record<string, unknown>) => {
    setError("");
    try {
      setSource(await invoke<Source>("store_update", { id: sourceId, patch }, workspaceId));
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

  return (
    <article className="kx-source-page" ref={pageRef} data-narrow={narrow}>
      <div className="kx-source-page-inner">
        <header className="kx-source-page-bar">
          <span className="kx-kind-badge" data-kind={source.kind}>
            <Icon name={KIND_ICON[source.kind] ?? "doc"} size={13} />
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
          <button className="kx-icon-button" data-active={source.starred} aria-pressed={source.starred} title={source.starred ? "Unstar" : "Star"} onClick={() => void save({ starred: !source.starred })}>
            <Icon name="star" size={15} fill={source.starred ? "currentColor" : "none"} />
          </button>
          <details className="kx-menu">
            <summary className="kx-page-action">
              <Icon name="quote" size={13} />
              {copied ? `Copied ${copied}` : "Cite"}
            </summary>
            <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
              <button onClick={() => void copy("APA", apa(source), apa(source, true))}>Copy APA reference</button>
              <button onClick={() => void copy("in-text", apaInText(source))}>Copy in-text citation</button>
              <button onClick={() => void copy("BibTeX", bibtex(source))}>Copy BibTeX</button>
            </div>
          </details>
          {isPdf ? (
            <div className="kx-page-split">
              <button className="kx-page-action kx-page-action-primary" onClick={openReader} title="Read the PDF beside this page">
                <Icon name="book" size={13} />
                Read
              </button>
              <details className="kx-menu">
                <summary className="kx-page-action kx-page-action-primary" aria-label="More ways to read">
                  <Icon name="chevronDown" size={11} />
                </summary>
                <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
                  <button onClick={openReader}>
                    <Icon name="split" size={13} /> Read beside this page
                  </button>
                  <button onClick={openReaderTab}>
                    <Icon name="book" size={13} /> Open PDF in its own tab
                  </button>
                </div>
              </details>
            </div>
          ) : source.filePath ? (
            <button className="kx-page-action kx-page-action-primary" onClick={() => void libraryBridge().openPath(source.filePath!)}>
              <Icon name="external" size={13} />
              Open file
            </button>
          ) : (
            (source.url || source.doi) && (
              <button className="kx-page-action kx-page-action-primary" onClick={() => window.open(source.url || `https://doi.org/${source.doi}`, "_blank")}>
                <Icon name="globe" size={13} />
                Open link
              </button>
            )
          )}
        </header>

        <AutoText className="kx-inspector-title kx-source-page-title" label="Title" value={source.title || ""} placeholder="Untitled" onCommit={(title) => void save({ title })} />
        {!detailsOpen && (
          <button className="kx-page-properties-summary" onClick={() => toggleDetails(true)} aria-expanded={false}>
            <Icon name="chevronRight" size={11} />
            {[
              shortCreators(source.creators),
              source.containerShort || source.containerTitle,
              source.year,
              source.tags.length && `${source.tags.length} ${source.tags.length === 1 ? "tag" : "tags"}`,
              source.collections.length && `${source.collections.length} ${source.collections.length === 1 ? "collection" : "collections"}`,
            ]
              .filter(Boolean)
              .join(" · ") || "Show details"}
          </button>
        )}
        {detailsOpen && (
          <div className="kx-page-details">
        <Creators creators={source.creators} onCommit={(creators) => void save({ creators })} />
        {/* One grid: bibliographic fields, tags, collections and the user's properties. */}
        <section className="kx-page-properties" aria-label="Properties">
          {shown.map(([key, label, kind]) => (
            <FieldRow key={key} label={label} kind={kind} value={source[key] as string | number | undefined} onCommit={(value) => void save({ [key]: kind === "number" ? (value === "" ? null : Number(value)) : value })} />
          ))}
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
                  <span>{names.get(id) ?? "Collection"}</span>
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
            onFill={() => {}}
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
          <button className="kx-page-details-hide" onClick={() => toggleDetails(false)} aria-expanded>
            <Icon name="chevronDown" size={11} /> Hide details
          </button>
          </div>
        )}

        {error && <p className="kx-inline-error">{error}</p>}

        {highlights.length > 0 && (
          <section className="kx-page-section">
            <h3>
              Highlights <span className="kx-count">{highlights.length}</span>
            </h3>
            <ul className="kx-page-highlights">
              {highlights.map((h) => {
                const pageIndex = highlightPage(h);
                return (
                  <li key={h.id} data-color={h.color || "yellow"}>
                    {h.text && <blockquote title={h.text}>{h.text.replace(/\s*\r?\n\s*/g, " ")}</blockquote>}
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

        <div className="kx-page-note">
          {/* One editor for the page's life: creating the note on the first keystroke must not remount it. */}
          <NoteEditor
            value={pageNote}
            onChange={(body) => void savePage(body)}
            searchSources={sources.searchSources}
            resolveSource={sources.resolveSource}
            onOpenSource={sources.onOpenSource}
            placeholder="Write about this source. Type / for blocks, @ to link another source"
          />
        </div>

        {notes.length > 1 && (
          <section className="kx-page-section">
            <h3>
              More notes <span className="kx-count">{notes.length - 1}</span>
            </h3>
            {notes.slice(1).map((note) => (
              <div className="kx-note-card" key={note.id}>
                <NoteEditor
                  compact
                  value={note.body}
                  onChange={(body) => void invoke("store_note_save", { id: note.id, sourceId, title: note.title, body }, workspaceId)}
                  searchSources={sources.searchSources}
                  resolveSource={sources.resolveSource}
                  onOpenSource={sources.onOpenSource}
                />
              </div>
            ))}
          </section>
        )}
      </div>
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
    </article>
  );
}
