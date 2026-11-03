// Metadata values that lead to everything sharing them: a tag, an author, a journal, a
// year, an item type or a property value. Inside the library a click adds the value to
// the search as a filter token; anywhere else it opens the library filtered by it.
import { createContext, useContext, type ReactNode } from "react";
import { Icon } from "./icons";
import type { Creator } from "./citation";
import { OA_LABEL, bridge, creatorName, itemTypeLabel } from "./library-api";
import { selectLibrary } from "./library-nav";
import "./search-page.css";
import type { SearchFilter } from "./search-suggest";

/** What a value click does here; without one, values are plain text. */
export const FilterLinks = createContext<((filter: SearchFilter) => void) | undefined>(undefined);

/** Opens the library with just this filter (and no collection). */
export function showInLibrary(workspaceId: string, filter: SearchFilter) {
  selectLibrary({ workspaceId, filters: [filter] });
  void bridge().tabAction("open-content", { section: "sources", workspaceId });
}

export const sourceFilter = {
  creator: (c: Creator): SearchFilter => ({ field: "creator", op: "is", value: creatorName(c), label: creatorName(c) }),
  tag: (tag: string): SearchFilter => ({ field: "tag", op: "is", value: tag, label: tag }),
  container: (title: string): SearchFilter => ({ field: "container", op: "is", value: title, label: title }),
  year: (year: number | string): SearchFilter => ({ field: "year", op: "is", value: String(year), label: String(year) }),
  itemType: (type: string): SearchFilter => ({ field: "itemType", op: "is", value: type, label: itemTypeLabel(type) }),
  collection: (id: string, name: string): SearchFilter => ({ field: "collection", op: "is", value: id, label: name }),
  property: (key: string, value: unknown): SearchFilter => ({ field: "property", op: "is", key, value: String(value), label: String(value) }),
  // The metadata graph: by id, so a renamed or merged person or journal still matches.
  person: (id: string, name: string): SearchFilter => ({ field: "person", op: "is", value: id, label: name }),
  venue: (id: string, name: string): SearchFilter => ({ field: "venue", op: "is", value: id, label: name }),
  institution: (id: string, name: string): SearchFilter => ({ field: "institution", op: "is", value: id, label: name }),
  topic: (id: string, name: string): SearchFilter => ({ field: "topic", op: "is", value: id, label: name }),
  keyword: (id: string, name: string): SearchFilter => ({ field: "keyword", op: "is", value: id, label: name }),
  funder: (id: string, name: string): SearchFilter => ({ field: "funder", op: "is", value: id, label: name }),
  citations: (op: "gt" | "gte" | "lt" | "lte", count: number): SearchFilter => ({
    field: "citations",
    op,
    value: String(count),
    label: `Cited ${{ gt: "more than", gte: "at least", lt: "fewer than", lte: "at most" }[op]} ${count} times`,
  }),
  retracted: (): SearchFilter => ({ field: "retracted", op: "is", value: "true", label: "Retracted" }),
  oaStatus: (status: string): SearchFilter => ({ field: "oaStatus", op: "is", value: status, label: OA_LABEL[status] ?? status }),
  workType: (type: string): SearchFilter => ({ field: "workType", op: "is", value: type, label: type[0].toUpperCase() + type.slice(1).replace(/-/g, " ") }),
  language: (code: string): SearchFilter => ({ field: "language", op: "is", value: code, label: languageName(code) }),
};

/** "English" for "en", when the system knows the code. */
export function languageName(code: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A value that filters the library when clicked (plain text where nothing would happen). */
export function FilterLink({ filter, children, className }: { filter?: SearchFilter; children: ReactNode; className?: string }) {
  const apply = useContext(FilterLinks);
  if (!apply || !filter || !filter.value.trim()) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      className={`kx-filter-link${className ? ` ${className}` : ""}`}
      title={`Show all sources with ${filter.label}`}
      // Rows select on mouse down; a value click only filters.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        apply(filter);
      }}
    >
      {children}
    </button>
  );
}

/** Adds a filter unless an equal one is there. */
export function withFilter(filters: SearchFilter[], filter: SearchFilter) {
  const same = (f: SearchFilter) => f.field === filter.field && (f.key ?? "") === (filter.key ?? "") && f.value.toLowerCase() === filter.value.toLowerCase();
  return filters.some(same) ? filters : [...filters, filter];
}

/** For a value that is edited in place: a small button beside it that filters by it. */
export function FilterButton({ filter }: { filter?: SearchFilter }) {
  const apply = useContext(FilterLinks);
  if (!apply || !filter || !filter.value.trim()) return null;
  return (
    <button
      type="button"
      className="kx-filter-button"
      title={`Show all sources with ${filter.label}`}
      aria-label={`Show all sources with ${filter.label}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        apply(filter);
      }}
    >
      <Icon name="filter" size={11} />
    </button>
  );
}

/** The filter for a bibliographic field's value, where the library can filter by it. */
export function fieldFilter(key: string, value: unknown): SearchFilter | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (key === "containerTitle") return sourceFilter.container(String(value));
  if (key === "year") return sourceFilter.year(value as number);
  if (key === "language") return sourceFilter.language(String(value));
  if (key === "publisher") return { field: "container", op: "contains", value: String(value), label: String(value) };
  return undefined;
}
