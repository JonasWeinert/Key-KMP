import { useEffect, useMemo, useRef, useState } from "react";
import { apa, apaInText, bibtex } from "./citation";
import NoteEditor from "./note-editor";
import { noteSources } from "./note-sources";
import type { Creator } from "./citation";
import { Icon } from "./icons";
import { ProgressRing } from "./index-activity";
import { formulaValue, type PropertyDefinition, type PropertySheetState } from "./PropertySheets";
import {
  ITEM_TYPES,
  KIND_ICON,
  bridge,
  formatBytes,
  itemTypeLabel,
  type Collection,
  type Facet,
  type Invoke,
  type Note,
  type Source,
} from "./library-api";

type FieldSpec = [key: keyof Source & string, label: string, kind?: "url" | "doi" | "number" | "long"];
const COMMON_TAIL: FieldSpec[] = [
  ["doi", "DOI", "doi"],
  ["url", "URL", "url"],
];
export const FIELDS: Record<string, FieldSpec[]> = {
  article: [["containerTitle", "Journal"], ["year", "Year", "number"], ["volume", "Volume"], ["issue", "Issue"], ["pages", "Pages"], ...COMMON_TAIL, ["issn", "ISSN"], ["pmid", "PMID"]],
  "magazine-article": [["containerTitle", "Magazine"], ["date", "Date"], ["pages", "Pages"], ...COMMON_TAIL],
  "newspaper-article": [["containerTitle", "Newspaper"], ["date", "Date"], ["pages", "Pages"], ...COMMON_TAIL],
  preprint: [["containerTitle", "Repository"], ["year", "Year", "number"], ["arxivId", "arXiv ID"], ...COMMON_TAIL],
  book: [["publisher", "Publisher"], ["place", "Place"], ["year", "Year", "number"], ["edition", "Edition"], ["series", "Series"], ["isbn", "ISBN"], ...COMMON_TAIL],
  chapter: [["containerTitle", "Book"], ["publisher", "Publisher"], ["place", "Place"], ["year", "Year", "number"], ["pages", "Pages"], ["isbn", "ISBN"], ...COMMON_TAIL],
  "conference-paper": [["containerTitle", "Proceedings"], ["publisher", "Publisher"], ["year", "Year", "number"], ["pages", "Pages"], ...COMMON_TAIL],
  report: [["institution", "Institution"], ["genre", "Report type"], ["place", "Place"], ["year", "Year", "number"], ...COMMON_TAIL],
  thesis: [["institution", "University"], ["genre", "Thesis type"], ["place", "Place"], ["year", "Year", "number"], ...COMMON_TAIL],
  webpage: [["containerTitle", "Website"], ["date", "Date"], ["accessed", "Accessed"], ["url", "URL", "url"]],
  "blog-post": [["containerTitle", "Blog"], ["date", "Date"], ["accessed", "Accessed"], ["url", "URL", "url"]],
  video: [["publisher", "Studio / channel"], ["date", "Date"], ["durationSeconds", "Length (s)", "number"], ["url", "URL", "url"]],
  audio: [["publisher", "Label / show"], ["date", "Date"], ["durationSeconds", "Length (s)", "number"], ["url", "URL", "url"]],
  dataset: [["publisher", "Repository"], ["year", "Year", "number"], ["genre", "Version"], ...COMMON_TAIL],
  software: [["publisher", "Company"], ["year", "Year", "number"], ["genre", "Version"], ["url", "URL", "url"]],
};
export const DEFAULT_FIELDS: FieldSpec[] = [["containerTitle", "Published in"], ["publisher", "Publisher"], ["year", "Year", "number"], ...COMMON_TAIL];
export const MORE_FIELDS: FieldSpec[] = [
  ["shortTitle", "Short title"],
  ["containerShort", "Journal abbr."],
  ["language", "Language"],
  ["citationKey", "Citation key"],
  ["pmcid", "PMCID"],
  ["rights", "Rights"],
  ["extra", "Extra", "long"],
];
const ROLES = ["author", "editor", "translator", "container-author", "contributor"];

export default function SourceInspector({
  source,
  invoke,
  workspaceId,
  collections,
  tagSuggestions,
  onChanged,
  onOpen,
  onOpenPage,
  onClose,
  definitions,
  progress,
  onPropertySheet,
  onAgentFill,
  onDownload,
}: {
  definitions: PropertyDefinition[];
  /** Live stage while this source is being read or indexed. */
  progress?: { fraction: number; label: string };
  onPropertySheet: (state: PropertySheetState) => void;
  onAgentFill: (propertyName?: string) => void;
  onDownload: () => Promise<void>;
  source: Source;
  invoke: Invoke;
  workspaceId: string;
  collections: Collection[];
  tagSuggestions: Facet[];
  onChanged: (source: Source) => void;
  onOpen: (source: Source) => void;
  /** The source as a full page with its note (beside the PDF when reading). */
  onOpenPage: (source: Source) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [copied, setCopied] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setNotes([]);
    setError("");
    invoke<Note[]>("store_notes", { sourceId: source.id }, workspaceId)
      .then((n) => current && setNotes(n))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [source.id, workspaceId, invoke]);

  const save = async (patch: Record<string, unknown>) => {
    setError("");
    try {
      onChanged(await invoke<Source>("store_update", { id: source.id, patch }, workspaceId));
    } catch (e) {
      setError(String(e));
    }
  };
  const copy = async (label: string, text: string, html?: string) => {
    try {
      if (html && "ClipboardItem" in window) {
        await navigator.clipboard.write([
          new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
        ]);
      } else await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1400);
    } catch (e) {
      setError(String(e));
    }
  };
  const fields = FIELDS[source.itemType || ""] ?? DEFAULT_FIELDS;
  const collectionNames = useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections]);
  const canOpen = !!source.filePath || !!source.url;
  const status = indexLabel(source);

  return (
    <aside className="kx-inspector" aria-label="Source details">
      <header className="kx-inspector-bar">
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
        <button className="kx-icon-button" title="Open as page" aria-label="Open as page" onClick={() => onOpenPage(source)}>
          <Icon name="doc" size={14} />
        </button>
        <button className="kx-icon-button" data-active={source.starred} aria-pressed={source.starred} title={source.starred ? "Unstar" : "Star"} onClick={() => void save({ starred: !source.starred })}>
          <Icon name="star" size={15} fill={source.starred ? "currentColor" : "none"} />
        </button>
        <button className="kx-icon-button" title="Close details" aria-label="Close details" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </header>
      <div className="kx-inspector-scroll">
        <AutoText className="kx-inspector-title" label="Title" value={source.title || ""} placeholder="Untitled" onCommit={(title) => void save({ title })} />
        <Creators creators={source.creators} onCommit={(creators) => void save({ creators })} />
        <div className="kx-inspector-actions">
          <button className="kx-button-primary" disabled={!canOpen} onClick={() => onOpen(source)}>
            <Icon name={source.filePath ? (source.kind === "pdf" ? "book" : "external") : "globe"} size={14} />
            {source.filePath ? (source.kind === "pdf" ? "Read" : "Open") : "Open link"}
          </button>
          <div className="kx-split-button">
            <button onClick={() => void copy("APA", apa(source), apa(source, true))}>
              <Icon name="quote" size={13} />
              {copied ? `Copied ${copied}` : "Cite"}
            </button>
            <details className="kx-menu">
              <summary aria-label="More citation formats">
                <Icon name="chevronDown" size={12} />
              </summary>
              <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
                <button onClick={() => void copy("APA", apa(source), apa(source, true))}>Copy APA reference</button>
                <button onClick={() => void copy("in-text", apaInText(source))}>Copy in-text citation</button>
                <button onClick={() => void copy("BibTeX", bibtex(source))}>Copy BibTeX</button>
              </div>
            </details>
          </div>
        </div>
        {error && <p className="kx-inline-error">{error}</p>}

        {/* Bibliographic fields (fixed columns) and your own properties (attributes) are one list. */}
        <section className="kx-inspector-section">
          <h3>Details</h3>
          <div className="kx-inspector-group kx-details">
            {fields.map(([key, label, kind]) => (
              <FieldRow key={key} label={label} kind={kind} value={source[key] as string | number | undefined} onCommit={(value) => void save({ [key]: kind === "number" ? (value === "" ? null : Number(value)) : value })} />
            ))}
            {MORE_FIELDS.filter(([key]) => moreOpen || !!source[key]).map(([key, label, kind]) => (
              <FieldRow key={key} label={label} kind={kind} value={source[key] as string | undefined} onCommit={(value) => void save({ [key]: value })} />
            ))}
            <TypedProperties
              source={source}
              definitions={definitions}
              onCommit={(properties) => void save({ properties })}
              onEdit={(definition) => onPropertySheet({ mode: "edit", definition, targets: [source] })}
              onFill={onAgentFill}
            />
            <div className="kx-details-foot">
              <button className="kx-row-toggle" onClick={() => setMoreOpen(!moreOpen)}>
                {moreOpen ? "Fewer fields" : "More fields"}
              </button>
              <button className="kx-row-toggle" onClick={() => onPropertySheet({ mode: "new", targets: [source] })}>
                <Icon name="plus" size={11} /> New property…
              </button>
            </div>
          </div>
        </section>

        <section className="kx-inspector-section">
          <h3>Abstract</h3>
          <AutoText className="kx-abstract" label="Abstract" value={source.abstract || ""} placeholder="Add an abstract" onCommit={(abstract) => void save({ abstract })} />
        </section>

        <section className="kx-inspector-section">
          <h3>Tags</h3>
          <TagEditor tags={source.tags} suggestions={tagSuggestions} onCommit={(tags) => void save({ tags })} />
        </section>

        <section className="kx-inspector-section">
          <h3>Collections</h3>
          <div className="kx-chips">
            {source.collections.map((id) => (
              <span className="kx-chip" key={id}>
                <Icon name="folder" size={11} />
                <span>{collectionNames.get(id) ?? "Collection"}</span>
                <button
                  aria-label={`Remove from ${collectionNames.get(id) ?? "collection"}`}
                  onClick={() =>
                    void invoke("store_membership", { collectionId: id, ids: [source.id], present: false }, workspaceId).then(() =>
                      onChanged({ ...source, collections: source.collections.filter((c) => c !== id) }),
                    )
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
              onChange={(e) => {
                const id = e.target.value;
                if (id)
                  void invoke("store_membership", { collectionId: id, ids: [source.id], present: true }, workspaceId).then(() =>
                    onChanged({ ...source, collections: [...source.collections, id] }),
                  );
              }}
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
        </section>

        <section className="kx-inspector-section">
          <h3>
            Notes <span className="kx-count">{notes.length}</span>
          </h3>
          <Notes
            notes={notes}
            invoke={invoke}
            workspaceId={workspaceId}
            onCreate={async () => {
              const saved = await invoke<Note>("store_note_save", { id: null, sourceId: source.id, title: "", body: "" }, workspaceId);
              setNotes((list) => [...list, saved]);
              return saved.id;
            }}
            onSave={async (note) => {
              await invoke<Note>("store_note_save", { id: note.id, sourceId: source.id, title: note.title, body: note.body }, workspaceId);
            }}
            onDelete={async (id) => {
              await invoke("store_note_delete", { id }, workspaceId);
              setNotes((list) => list.filter((n) => n.id !== id));
            }}
          />
        </section>

        {(source.filePath || source.indexStatus !== "skipped") && (
          <section className="kx-inspector-section">
            <h3>File & search</h3>
            <div className="kx-file-card">
              {source.filePath ? (
                <>
                  <div className="kx-file-name" title={source.filePath}>
                    <Icon name={KIND_ICON[source.kind] ?? "doc"} size={14} />
                    <span>{/\/\.key\/files\/[0-9a-f]{64}\./.test(source.filePath) ? "Saved in this workspace" : source.filePath.split("/").pop()}</span>
                  </div>
                  <small>
                    {[source.pageCount ? `${source.pageCount} pages` : "", formatBytes(source.fileSize), source.mime].filter(Boolean).join(" · ")}
                  </small>
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
              <div className="kx-file-actions">
                {!source.filePath && (source.doi || source.url) && (
                  <button
                    onClick={() => {
                      setError("");
                      void onDownload().catch((e) => setError(String(e).replace(/^Error: /, "")));
                    }}
                  >
                    <Icon name="upload" size={12} style={{ transform: "rotate(180deg)" }} />
                    Find PDF
                  </button>
                )}
                {source.filePath && (
                  <button onClick={() => void bridge().revealPath(source.filePath!)}>
                    <Icon name="folder" size={12} />
                    Show in Finder
                  </button>
                )}
                <button onClick={() => void invoke("store_index_control", { action: "reindex", ids: [source.id] }, workspaceId).then(() => onChanged({ ...source, indexStatus: "pending" }))}>
                  <Icon name="retry" size={12} />
                  Re-index
                </button>
              </div>
            </div>
          </section>
        )}
        <footer className="kx-inspector-foot">
          Added {new Date(source.addedAt).toLocaleDateString()} · Modified {new Date(source.updatedAt).toLocaleDateString()}
          {source.origin === "zotero" ? " · from Zotero" : ""}
        </footer>
      </div>
    </aside>
  );
}

export function indexLabel(source: Source): { tone: string; label: string } {
  switch (source.indexStatus) {
    case "ready":
      return { tone: "ready", label: `Searchable · ${source.indexTotal} passages` };
    case "indexing":
      return { tone: "busy", label: source.indexTotal ? `Indexing ${source.indexedChunks} of ${source.indexTotal}` : "Reading text…" };
    case "pending":
      return { tone: "idle", label: "Waiting to index" };
    case "missing":
      return { tone: "attention", label: "File moved or deleted" };
    case "no_text":
      return { tone: "attention", label: "No extractable text (scanned?)" };
    case "failed":
      return { tone: "attention", label: source.indexError || "Indexing failed" };
    default:
      return { tone: "idle", label: "Metadata only" };
  }
}

/** A textarea that grows with its content and commits on blur. */
export function AutoText({ value, onCommit, className, placeholder, label }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      className={className}
      rows={1}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
        if (e.key === "Enter" && !e.shiftKey && className === "kx-inspector-title") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function FieldRow({ label, value, kind, onCommit }: { label: string; value?: string | number; kind?: string; onCommit: (v: string) => void }) {
  const text = value === undefined || value === null ? "" : String(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const link = kind === "doi" && text ? `https://doi.org/${text}` : kind === "url" && /^https?:/.test(text) ? text : "";
  return (
    <label className="kx-field-row">
      <span>{label}</span>
      <input
        value={draft}
        inputMode={kind === "number" ? "numeric" : undefined}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== text && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(text);
            e.currentTarget.blur();
          }
        }}
      />
      {link && (
        <a href={link} target="_blank" rel="noreferrer" title={`Open ${link}`} onClick={(e) => e.stopPropagation()}>
          <Icon name="external" size={12} />
        </a>
      )}
    </label>
  );
}

export function Creators({ creators, onCommit }: { creators: Creator[]; onCommit: (c: Creator[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(creators);
  useEffect(() => setDraft(creators), [creators]);
  if (!editing)
    return (
      <button className="kx-creators" onClick={() => setEditing(true)} title="Edit creators">
        <Icon name="user" size={12} />
        <span>
          {creators.length
            ? creators.map((c) => `${c.literal || [c.given, c.family].filter(Boolean).join(" ")}${c.role && c.role !== "author" ? ` (${c.role})` : ""}`).join(", ")
            : "Add authors"}
        </span>
      </button>
    );
  const update = (index: number, patch: Partial<Creator>) => setDraft(draft.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  return (
    <div className="kx-creator-editor">
      {draft.map((c, i) => (
        <div className="kx-creator-row" key={i}>
          <input aria-label="Family name" placeholder="Family" value={c.family ?? c.literal ?? ""} onChange={(e) => update(i, c.literal !== undefined && !c.given ? { literal: e.target.value } : { family: e.target.value })} />
          <input aria-label="Given name" placeholder="Given" value={c.given ?? ""} onChange={(e) => update(i, { given: e.target.value, family: c.family ?? c.literal, literal: undefined })} />
          <select aria-label="Role" value={c.role || "author"} onChange={(e) => update(i, { role: e.target.value })}>
            {ROLES.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
          <button aria-label="Remove creator" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
      <div className="kx-creator-actions">
        <button onClick={() => setDraft([...draft, { family: "", given: "", role: "author" }])}>
          <Icon name="plus" size={11} />
          Add person
        </button>
        <span className="kx-spacer" />
        <button onClick={() => { setDraft(creators); setEditing(false); }}>Cancel</button>
        <button
          className="kx-button-primary"
          onClick={() => {
            onCommit(draft.filter((c) => (c.family || c.given || c.literal || "").trim()));
            setEditing(false);
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

export function TagEditor({ tags, suggestions, onCommit }: { tags: string[]; suggestions: Facet[]; onCommit: (t: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const listId = useMemo(() => `tags-${Math.random().toString(36).slice(2)}`, []);
  const add = () => {
    const value = draft.trim();
    if (value && !tags.includes(value)) onCommit([...tags, value]);
    setDraft("");
  };
  return (
    <div className="kx-chips">
      {tags.map((tag) => (
        <span className="kx-chip" key={tag} title={tag}>
          <span>{tag}</span>
          <button aria-label={`Remove tag ${tag}`} onClick={() => onCommit(tags.filter((t) => t !== tag))}>
            <Icon name="close" size={9} />
          </button>
        </span>
      ))}
      <input
        className="kx-chip-input"
        aria-label="Add tag"
        placeholder="Add tag…"
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
          if (e.key === "Backspace" && !draft && tags.length) onCommit(tags.slice(0, -1));
        }}
        onBlur={add}
      />
      <datalist id={listId}>
        {suggestions.slice(0, 200).map((t) => (
          <option key={t.value} value={t.value} />
        ))}
      </datalist>
    </div>
  );
}

/** Defined properties with typed editors, then any free-form keys on this source. */
export function TypedProperties({
  source,
  definitions,
  onCommit,
  onEdit,
  onFill,
}: {
  source: Source;
  definitions: PropertyDefinition[];
  onCommit: (p: Record<string, unknown>) => void;
  onEdit: (d: PropertyDefinition) => void;
  onFill: (name?: string) => void;
}) {
  const defined = new Set(definitions.map((d) => d.name));
  const extra = Object.fromEntries(Object.entries(source.properties).filter(([key]) => !defined.has(key)));
  const glyph = (type: string) => (type === "number" ? "#" : type === "boolean" ? "✓" : type === "select" ? "◦" : type === "formula" ? "ƒ" : "Aa");
  // Rows only: they sit in the Details list under the bibliographic fields.
  return (
    <>
      {definitions.map((definition) => {
        const value = source.properties[definition.name];
        const text = value === undefined || value === null ? "" : String(value);
        return (
          <div className="kx-field-row kx-typed-row" key={definition.name}>
            <button className="kx-property-name" title={`Edit “${definition.name}”`} aria-label={`Configure ${definition.name} property`} onClick={() => onEdit(definition)}>
              <span className="kx-type-badge">{glyph(definition.type)}</span>
              <span>{definition.name}</span>
            </button>
            {definition.type === "formula" ? (
              <output>{formulaValue(definition, source) || "—"}</output>
            ) : definition.type === "boolean" ? (
              <input type="checkbox" className="kx-switch" checked={value === true} onChange={(e) => onCommit({ [definition.name]: e.target.checked })} />
            ) : definition.type === "select" ? (
              <select value={text} onChange={(e) => onCommit({ [definition.name]: e.target.value || null })}>
                <option value="">—</option>
                {(definition.options ?? []).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                key={`${source.id}:${definition.name}:${text}`}
                defaultValue={text}
                placeholder="—"
                inputMode={definition.type === "number" ? "decimal" : undefined}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === text) return;
                  if (definition.type === "number" && next && !Number.isFinite(Number(next))) {
                    e.target.value = text;
                    return;
                  }
                  onCommit({ [definition.name]: next === "" ? null : definition.type === "number" ? Number(next) : next });
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            )}
            {definition.type !== "formula" && (
              <button className="kx-row-remove" title={`Fill “${definition.name}” with AI`} aria-label={`Fill ${definition.name} with AI`} onClick={() => onFill(definition.name)}>
                <Icon name="sparkle" size={11} />
              </button>
            )}
          </div>
        );
      })}
      {Object.keys(extra).length > 0 && <PropertyRows properties={extra} onCommit={onCommit} embedded />}
    </>
  );
}

function PropertyRows({ properties, onCommit, embedded = false }: { properties: Record<string, unknown>; onCommit: (p: Record<string, unknown>) => void; embedded?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const entries = Object.entries(properties);
  if (embedded)
    return (
      <>
        {entries.map(([key, value]) => (
          <div className="kx-field-row" key={key}>
            <span title={key}>{key}</span>
            <input
              defaultValue={typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}
              onBlur={(e) => {
                if (e.target.value !== String(value ?? "")) onCommit({ [key]: e.target.value === "" ? null : coerce(e.target.value) });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <button className="kx-row-remove" aria-label={`Remove ${key}`} onClick={() => onCommit({ [key]: null })}>
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
      </>
    );
  return (
    <div className="kx-inspector-group">
      {entries.map(([key, value]) => (
        <div className="kx-field-row" key={key}>
          <span title={key}>{key}</span>
          <input
            defaultValue={typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}
            onBlur={(e) => {
              const next = e.target.value;
              if (next !== String(value ?? "")) onCommit({ [key]: next === "" ? null : coerce(next) });
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <button className="kx-row-remove" aria-label={`Remove ${key}`} onClick={() => onCommit({ [key]: null })}>
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
      {adding ? (
        <div className="kx-field-row">
          <input autoFocus placeholder="Property" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="Value"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                onCommit({ [name.trim()]: coerce(e.currentTarget.value) });
                setName("");
                setAdding(false);
              }
              if (e.key === "Escape") setAdding(false);
            }}
          />
        </div>
      ) : (
        <button className="kx-row-toggle" onClick={() => setAdding(true)}>
          <Icon name="plus" size={11} /> Add property
        </button>
      )}
      {!entries.length && !adding && <small className="kx-muted">Your own fields: status, rating, research question…</small>}
    </div>
  );
}

function coerce(value: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}

/** Source notes, each an always-editable block editor; a note can also open in its own tab. */
function Notes({
  notes,
  invoke,
  workspaceId,
  onCreate,
  onSave,
  onDelete,
}: {
  notes: Note[];
  invoke: Invoke;
  workspaceId: string;
  onCreate: () => Promise<string>;
  onSave: (n: Pick<Note, "id" | "title" | "body">) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const sources = useMemo(() => noteSources(invoke, workspaceId), [invoke, workspaceId]);
  const [fresh, setFresh] = useState<string>();
  const openInTab = (note: Note) =>
    void (window as unknown as { key: { tabAction: (a: string, p: unknown) => Promise<unknown> } }).key.tabAction("open-content", {
      section: "note",
      workspaceId,
      noteId: note.id,
      title: note.title,
    });
  return (
    <div className="kx-notes">
      {notes.map((note) => (
        <div className="kx-note-card" key={note.id}>
          <div className="kx-note-card-bar">
            <span>{new Date(note.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
            <span className="kx-spacer" />
            <button title="Open in a tab" aria-label="Open note in a tab" onClick={() => openInTab(note)}>
              <Icon name="external" size={11} />
            </button>
            <button
              title="Delete note"
              aria-label="Delete note"
              onClick={() => {
                if (note.body.trim() && !window.confirm("Delete this note?")) return;
                void onDelete(note.id);
              }}
            >
              <Icon name="trash" size={11} />
            </button>
          </div>
          <NoteEditor
            compact
            autoFocus={fresh === note.id}
            value={note.body}
            onChange={(body) => void onSave({ id: note.id, title: note.title, body })}
            searchSources={sources.searchSources}
            resolveSource={sources.resolveSource}
            onOpenSource={sources.onOpenSource}
            media={sources.media}
          />
        </div>
      ))}
      <button className="kx-row-toggle" onClick={() => void onCreate().then(setFresh)}>
        <Icon name="plus" size={11} /> New note
      </button>
    </div>
  );
}
