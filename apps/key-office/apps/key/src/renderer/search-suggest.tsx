// The library search field: free text plus filter tokens, with suggestions as you type
// (people, journals, tags, collections, years, property values, then "… contains")
// in the manner of Apple Mail. Tokens all apply; free text then searches within them.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "./icons";
import type { Invoke } from "./library-api";
import { Highlight, prefixPattern } from "./search-highlight";

export interface SearchFilter {
  /** creator | container | title | notes | fulltext | tag | collection | year | property */
  field: string;
  op?: "is" | "contains";
  value: string;
  /** The property name, for `field = "property"`. */
  key?: string;
  /** What the token shows, e.g. a collection's name rather than its id. */
  label: string;
}
interface Suggestion {
  filter: Omit<SearchFilter, "label">;
  label: string;
  count: number;
}
interface MenuItem {
  filter: SearchFilter;
  icon: IconName;
  content: ReactNode;
  count?: number;
}

const FIELD: Record<string, { label: string; icon: IconName }> = {
  creator: { label: "Author", icon: "user" },
  container: { label: "Journal", icon: "book" },
  title: { label: "Title", icon: "doc" },
  notes: { label: "Notes", icon: "note" },
  fulltext: { label: "Full text", icon: "search" },
  tag: { label: "Tag", icon: "tag" },
  collection: { label: "Collection", icon: "folder" },
  year: { label: "Year", icon: "clock" },
  property: { label: "Property", icon: "list" },
};
// Specific matches come first, in this order; a typed year leads.
const ORDER = ["year", "creator", "container", "tag", "collection", "property"];
const CONTAINS: [string, string][] = [
  ["creator", "Author contains"],
  ["title", "Title contains"],
  ["container", "Journal contains"],
  ["notes", "Notes contain"],
  ["fulltext", "Full text contains"],
];

export const filterKey = (f: Pick<SearchFilter, "field" | "op" | "value" | "key">) => `${f.field}:${f.op ?? "contains"}:${f.key ?? ""}:${f.value.toLowerCase()}`;
/** Filters as the store takes them (no display label). */
export const storeFilters = (filters: SearchFilter[]) => filters.map(({ field, op, value, key }) => ({ field, op, value, key }));

export default function SearchField({
  invoke,
  workspaceId,
  view,
  text,
  onText,
  filters,
  onFilters,
  busy,
  inputRef,
  onSubmit,
  onArrowIntoResults,
}: {
  invoke: Invoke;
  workspaceId: string;
  /** The current scope, collection, kind and tag, so counts match what the user sees. */
  view: Record<string, unknown>;
  text: string;
  onText: (text: string) => void;
  filters: SearchFilter[];
  onFilters: (filters: SearchFilter[]) => void;
  busy?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onArrowIntoResults: () => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [index, setIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const typed = text.trim();

  useEffect(() => {
    const id = ++request.current;
    if (typed.length < 2) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      void invoke<Suggestion[]>("store_suggest", { ...view, text: typed, perGroup: 4, filters: storeFilters(filters) }, workspaceId)
        .then((found) => id === request.current && setSuggestions(found))
        .catch(() => id === request.current && setSuggestions([]));
    }, 110);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, workspaceId, JSON.stringify(view), filters]);

  const pattern = useMemo(() => prefixPattern(typed), [typed]);
  const items = useMemo<MenuItem[]>(() => {
    if (!typed) return [];
    const taken = new Set(filters.map(filterKey));
    const specific = [...suggestions]
      .sort((a, b) => ORDER.indexOf(a.filter.field) - ORDER.indexOf(b.filter.field))
      .filter((s) => !taken.has(filterKey(s.filter)))
      .slice(0, 8)
      .map((s): MenuItem => {
        const field = FIELD[s.filter.field] ?? FIELD.property;
        return {
          filter: { ...s.filter, op: "is", label: s.label },
          icon: field.icon,
          count: s.count,
          content: (
            <>
              <span className="kx-suggest-value">
                {s.filter.field === "property" && <span className="kx-suggest-scope">{s.filter.key}: </span>}
                <Highlight text={s.label} pattern={pattern} />
              </span>
              {s.filter.field !== "creator" && <span className="kx-suggest-scope"> — {field.label}</span>}
            </>
          ),
        };
      });
    const generic = CONTAINS.map(([field, phrase]): MenuItem => ({
      filter: { field, op: "contains", value: typed, label: typed },
      icon: FIELD[field].icon,
      content: (
        <>
          <span className="kx-suggest-scope">{phrase}: </span>
          <span className="kx-suggest-value">{typed}</span>
        </>
      ),
    })).filter((item) => !taken.has(filterKey(item.filter)));
    return [...specific, ...generic];
  }, [suggestions, typed, filters, pattern]);
  useEffect(() => setIndex(-1), [typed]);
  const showMenu = open && items.length > 0;

  const pick = (item: MenuItem) => {
    onFilters([...filters, item.filter]);
    onText("");
    setIndex(-1);
    inputRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (showMenu) setIndex((i) => Math.min(items.length - 1, i + 1));
      else onArrowIntoResults();
    } else if (e.key === "ArrowUp" && showMenu) {
      e.preventDefault();
      setIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter" && showMenu && index >= 0) {
      e.preventDefault();
      pick(items[index]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (showMenu) setOpen(false);
      else if (text) onText("");
      else if (filters.length) onFilters([]);
    } else if (e.key === "Backspace" && !text && filters.length && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      onFilters(filters.slice(0, -1));
    } else setOpen(true);
  };

  return (
    <form
      className="kx-search"
      role="search"
      data-tokens={filters.length > 0}
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        onSubmit();
      }}
    >
      <Icon name="search" size={14} />
      <div className="kx-search-field" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), inputRef.current?.focus())}>
        {filters.map((f) => (
          <span key={filterKey(f)} className="kx-token" data-field={f.field} title={`${tokenScope(f)} ${f.label}`}>
            <Icon name={(FIELD[f.field] ?? FIELD.property).icon} size={11} />
            <span className="kx-token-scope">{tokenScope(f)}</span>
            <span className="kx-token-value">{f.label}</span>
            <button
              type="button"
              aria-label={`Remove filter ${tokenScope(f)} ${f.label}`}
              onClick={() => onFilters(filters.filter((other) => other !== f))}
            >
              <Icon name="close" size={8} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="kx-search-input"
          aria-label="Search the library"
          aria-expanded={showMenu}
          aria-controls="kx-suggest"
          aria-activedescendant={index >= 0 ? `kx-suggest-${index}` : undefined}
          role="combobox"
          placeholder={filters.length ? "Search within these filters" : "Search titles, authors, notes and full text"}
          value={text}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {busy ? <span className="kx-search-spinner" aria-label="Searching" /> : !text && !filters.length && <kbd aria-hidden="true">⌘F</kbd>}
      {(text || filters.length > 0) && (
        <button
          type="button"
          className="kx-search-clear"
          aria-label="Clear search"
          onClick={() => {
            onText("");
            onFilters([]);
          }}
        >
          <Icon name="close" size={10} />
        </button>
      )}
      {showMenu && (
        <div id="kx-suggest" className="kx-suggest" role="listbox" aria-label="Search suggestions">
          {items.map((item, i) => (
            <div
              key={filterKey(item.filter)}
              id={`kx-suggest-${i}`}
              role="option"
              aria-selected={i === index}
              className="kx-suggest-item"
              // Keep the field focused while choosing.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
              onMouseMove={() => i !== index && setIndex(i)}
            >
              <Icon name={item.icon} size={14} />
              <span className="kx-suggest-text">{item.content}</span>
              {item.count !== undefined && <span className="kx-suggest-count">{item.count.toLocaleString()}</span>}
            </div>
          ))}
        </div>
      )}
    </form>
  );
}

/** "Author", "Status" or "Title contains" in front of the token's value. */
function tokenScope(f: SearchFilter) {
  const field = f.field === "property" ? (f.key ?? "Property") : (FIELD[f.field]?.label ?? f.field);
  return f.op === "is" ? field : `${field} contains`;
}
