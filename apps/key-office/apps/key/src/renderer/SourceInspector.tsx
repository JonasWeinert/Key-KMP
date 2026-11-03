// The editors a source's details are made of (fields, creators, tags, typed properties),
// shared by the source page, which is also the library's details panel, and other pages.
import { Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Creator } from "./citation";
import { FilterButton, FilterLink, FilterLinks, fieldFilter, sourceFilter } from "./filter-links";
import type { SearchFilter } from "./search-suggest";
import { Icon } from "./icons";
import { EntityButton, EntityLink, type EntityRef } from "./entity-ui";
import { formulaValue, type PropertyDefinition } from "./PropertySheets";
import type { Facet, Source } from "./library-api";

export type FieldSpec = [key: keyof Source & string, label: string, kind?: "url" | "doi" | "number" | "long"];
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
    const fit = () => {
      el.style.height = "0";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // A page title changes size with its pane (see ItemPage's titleSize).
    window.addEventListener("key:title-size", fit);
    return () => window.removeEventListener("key:title-size", fit);
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

export function FieldRow({ label, value, kind, onCommit, filter, entity }: { label: string; value?: string | number; kind?: string; onCommit: (v: string) => void; filter?: SearchFilter; entity?: EntityRef }) {
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
      {entity ? <EntityButton entity={entity} /> : <FilterButton filter={filter} />}
    </label>
  );
}

export function Creators({ creators, onCommit }: { creators: Creator[]; onCommit: (c: Creator[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(creators);
  useEffect(() => setDraft(creators), [creators]);
  const filterBy = useContext(FilterLinks);
  // Each name shows that person's sources; a pencil edits the list.
  if (!editing && filterBy && creators.length)
    return (
      <div className="kx-creators">
        <Icon name="user" size={12} />
        <span>
          {creators.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && ", "}
              {c.personId ? (
                <EntityLink entity={{ kind: "person", id: c.personId, name: c.literal || [c.given, c.family].filter(Boolean).join(" ") }}>
                  {c.literal || [c.given, c.family].filter(Boolean).join(" ")}
                </EntityLink>
              ) : (
                <FilterLink filter={sourceFilter.creator(c)}>{c.literal || [c.given, c.family].filter(Boolean).join(" ")}</FilterLink>
              )}
              {c.role && c.role !== "author" ? ` (${c.role})` : ""}
            </Fragment>
          ))}
        </span>
        <button className="kx-filter-button" title="Edit creators" aria-label="Edit creators" onClick={() => setEditing(true)}>
          <Icon name="pen" size={11} />
        </button>
      </div>
    );
  if (!editing)
    return (
      <button
        className="kx-creators"
        onClick={() => {
          // With nobody yet, start with one empty row to type into.
          if (!creators.length) setDraft([{ family: "", given: "", role: "author" }]);
          setEditing(true);
        }}
        title="Edit creators"
      >
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
          <FilterLink filter={sourceFilter.tag(tag)}>{tag}</FilterLink>
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

/** Defined properties with typed editors, then any free-form keys on this item. */
export function TypedProperties({
  source,
  definitions,
  onCommit,
  onEdit,
  onFill,
  formula = (definition) => formulaValue(definition, source as Source),
}: {
  /** A source, or any page item with its own properties (a note). */
  source: { id: string; properties: Record<string, unknown> };
  definitions: PropertyDefinition[];
  onCommit: (p: Record<string, unknown>) => void;
  onEdit: (d: PropertyDefinition) => void;
  /** Agent fill; without it a row offers to remove the value instead. */
  onFill?: (name?: string) => void;
  formula?: (d: PropertyDefinition) => string;
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
              <output>{formula(definition) || "—"}</output>
            ) : definition.type === "boolean" ? (
              <input type="checkbox" className="kx-switch" aria-label={definition.name} checked={value === true} onChange={(e) => onCommit({ [definition.name]: e.target.checked })} />
            ) : definition.type === "select" ? (
              <select aria-label={definition.name} value={text} onChange={(e) => onCommit({ [definition.name]: e.target.value || (onFill ? null : "") })}>
                <option value="">—</option>
                {(definition.options ?? []).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                key={`${source.id}:${definition.name}:${text}`}
                aria-label={definition.name}
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
                  // A page keeps an emptied row (""), so the property stays on it until removed.
                  onCommit({ [definition.name]: next === "" ? (onFill ? null : "") : definition.type === "number" ? Number(next) : next });
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            )}
            <FilterButton filter={definition.type !== "formula" && definition.type !== "boolean" && text ? sourceFilter.property(definition.name, text) : undefined} />
            {onFill ? (
              definition.type !== "formula" && (
                <button className="kx-row-remove" title={`Fill “${definition.name}” with AI`} aria-label={`Fill ${definition.name} with AI`} onClick={() => onFill(definition.name)}>
                  <Icon name="sparkle" size={11} />
                </button>
              )
            ) : (
              <button className="kx-row-remove" title={`Remove “${definition.name}”`} aria-label={`Remove ${definition.name}`} onClick={() => onCommit({ [definition.name]: null })}>
                <Icon name="close" size={10} />
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
