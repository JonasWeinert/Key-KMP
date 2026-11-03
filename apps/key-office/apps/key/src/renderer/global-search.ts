// Search across everything (sources, notes, pages, canvases and highlights) for the
// search popup and the search tab: the same three sections as everywhere, counted and
// narrowed by kind, by the library's filter tokens and by one item picked in the sidebar.
import { useEffect, useRef, useState } from "react";
import { linkTargets } from "./item-links";
import { bridge, shortCreators, type Invoke, type Source } from "./library-api";
import type { SidebarTarget } from "./sidebar-intent";
import { storeFilters, type SearchFilter } from "./search-suggest";
import { EMPTY_FOUND, GROUPS, mergeFound, searchText, searchTitles, targetFound, type Found, type Found3 } from "./unified-search";

export type FindKind = "source" | "note" | "record" | "canvas" | "highlight";
export const FIND_KINDS: FindKind[] = ["source", "note", "record", "canvas", "highlight"];
export const KIND_LABEL: Record<FindKind, string> = { source: "Sources", note: "Notes", record: "Pages", canvas: "Canvases", highlight: "Highlights" };
const ONE: Record<FindKind, string> = { source: "Source", note: "Note", record: "Page", canvas: "Canvas", highlight: "Highlight" };

export interface FindState {
  text: string;
  /** Only these kinds; none means all. */
  kinds: FindKind[];
  /** Library filter tokens, plus at most one `item` token ("only this note"). */
  filters: SearchFilter[];
}
export const EMPTY_FIND: FindState = { text: "", kinds: [], filters: [] };

export const kindOf = (found: Pick<Found, "kind" | "anchor">): FindKind => (found.anchor?.startsWith("highlight:") ? "highlight" : (found.kind as FindKind));

/** A sidebar item as a filter token: results only from that note, canvas, page or source. */
export const itemFilter = (kind: FindKind, id: string, title: string): SearchFilter => ({ field: "item", op: "is", key: kind, value: id, label: title || "Untitled" });
export const isItemFilter = (filter: SearchFilter) => filter.field === "item";

export interface FindResult {
  found: Found3;
  /** Per kind, before the kind chips narrow the results. */
  counts: Record<FindKind, number>;
  all: number;
}
const noCounts = (): Record<FindKind, number> => ({ source: 0, note: 0, record: 0, canvas: 0, highlight: 0 });
export const EMPTY_RESULT: FindResult = { found: EMPTY_FOUND, counts: noCounts(), all: 0 };

const sourceFound = (source: Source): Found => ({
  kind: "source",
  id: source.id,
  title: source.title || "Untitled",
  detail: source.kind,
  sourceKind: source.kind,
  group: "titles",
  where: [shortCreators(source.creators), source.year].filter(Boolean).join(" · ") || undefined,
});

/** Titles and details. With library filters only sources (and their highlights) can match. */
async function findTitles(invoke: Invoke, workspaceId: string, state: FindState, limit: number): Promise<Found[]> {
  const q = state.text.trim();
  const library = state.filters.filter((f) => !isItemFilter(f));
  if (!library.length) return searchTitles(invoke, workspaceId, q, { limit, kinds: FIND_KINDS });
  const query = { filters: storeFilters(library), scope: "all", sort: "added", descending: true };
  const [scoped, matching, highlights] = await Promise.all([
    invoke<{ items: Source[] }>("store_sources", { ...query, limit: 1000 }, workspaceId),
    q ? invoke<{ items: Source[] }>("store_sources", { ...query, text: q, limit }, workspaceId) : undefined,
    linkTargets(invoke, workspaceId, q, ["highlight"], limit * 2).catch(() => []),
  ]);
  const ids = new Set(scoped.items.map((s) => s.id));
  return [
    ...(matching ?? scoped).items.slice(0, limit).map(sourceFound),
    ...highlights
      .filter((h) => ids.has(h.id))
      .slice(0, limit)
      .map(targetFound),
  ];
}

/** Narrows merged results to the sidebar item and counts them by kind, then applies the kind chips. */
export function narrow(found: Omit<Found3, "pending">, state: FindState, pending: boolean): FindResult {
  const item = state.filters.find(isItemFilter);
  const inItem = (f: Found) => !item || (f.id === item.value && f.kind === item.key);
  const q = state.text.trim().toLowerCase();
  const scoped = { titles: found.titles.filter(inItem), text: found.text.filter(inItem), meaning: found.meaning.filter(inItem) };
  // The item itself leads when its name fits (or nothing was typed).
  if (item && !scoped.titles.some((f) => f.id === item.value && !f.anchor) && (!q || item.label.toLowerCase().includes(q)))
    scoped.titles.unshift({ kind: item.key as Found["kind"], id: item.value, title: item.label, group: "titles", where: ONE[item.key as FindKind] });
  const counts = noCounts();
  for (const group of GROUPS) for (const f of scoped[group]) counts[kindOf(f)]++;
  const wanted = (f: Found) => !state.kinds.length || state.kinds.includes(kindOf(f));
  return {
    found: { titles: scoped.titles.filter(wanted), text: scoped.text.filter(wanted), meaning: scoped.meaning.filter(wanted), semantic: found.semantic, pending },
    counts,
    all: FIND_KINDS.reduce((sum, k) => sum + counts[k], 0),
  };
}

/** Searches as the state changes: titles at once, the text after (newest search wins). */
export function useFind(invoke: Invoke | undefined, workspaceId: string | undefined, state: FindState, limit = 10): FindResult {
  const [result, setResult] = useState<FindResult>(EMPTY_RESULT);
  const request = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const searchKey = JSON.stringify([state.text.trim(), state.filters]);
  const latest = useRef<{ key?: string; titles: Found[]; more?: Awaited<ReturnType<typeof searchText>>; pending: boolean }>({ titles: [], pending: false });
  // The kind chips only narrow what was found; they don't search again.
  const kindsKey = state.kinds.join();
  useEffect(() => {
    const { key, titles, more, pending } = latest.current;
    // Results of an earlier search would flash up; the new search narrows its own.
    if (key !== searchKey) return;
    setResult(narrow(mergeFound(titles, more), state, pending));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindsKey]);
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    const id = ++request.current;
    const current = () => id === request.current;
    const q = state.text.trim();
    const timer = setTimeout(async () => {
      const titles = await findTitles(invoke, workspaceId, state, limit).catch(() => []);
      if (!current()) return;
      const wantsText = q.length >= 2;
      latest.current = { key: searchKey, titles, pending: wantsText };
      setResult(narrow(mergeFound(titles, undefined), stateRef.current, wantsText));
      if (!wantsText) return;
      const library = state.filters.filter((f) => !isItemFilter(f));
      const more = await searchText(invoke, workspaceId, q, { limit: limit + 4, filters: storeFilters(library) }).catch(() => undefined);
      if (!current()) return;
      latest.current = { key: searchKey, titles, more, pending: false };
      setResult(narrow(mergeFound(titles, more), stateRef.current, false));
    }, q ? 120 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, searchKey, limit]);
  return result;
}

// ── The sidebar while a search tab is focused ────────────────────────────────

const same = (a: FindKind[], b: FindKind[]) => a.length === b.length && a.every((k) => b.includes(k));
const without = (filters: SearchFilter[], ...fields: string[]) => filters.filter((f) => !fields.includes(f.field));

/** The search a sidebar click turns this one into; undefined when it already is that,
 * so a second click opens the item as usual. */
export function sidebarFilter(state: FindState, target: SidebarTarget): FindState | undefined {
  const item = state.filters.find(isItemFilter);
  switch (target.kind) {
    case "sources": {
      if (target.collectionId) {
        if (state.filters.some((f) => f.field === "collection" && f.value === target.collectionId)) return undefined;
        const collection: SearchFilter = { field: "collection", op: "is", value: target.collectionId, label: target.title || "Collection" };
        return { ...state, kinds: ["source"], filters: [...without(state.filters, "collection", "item"), collection] };
      }
      if (same(state.kinds, ["source"]) && !item && !state.filters.some((f) => f.field === "collection")) return undefined;
      return { ...state, kinds: ["source"], filters: without(state.filters, "collection", "item") };
    }
    case "highlights":
    case "records": {
      const kinds: FindKind[] = [target.kind === "highlights" ? "highlight" : "record"];
      if (same(state.kinds, kinds) && !item) return undefined;
      // Library filters only match sources; pages need them gone.
      return { ...state, kinds, filters: target.kind === "records" ? [] : without(state.filters, "item") };
    }
    default: {
      if (item?.value === target.id) return undefined;
      // A note, canvas or page has none of the library's details, so its filters go.
      return { ...state, kinds: [], filters: [itemFilter(target.kind, target.id, target.title)] };
    }
  }
}

// ── Opening the search tab ───────────────────────────────────────────────────

const pending = new Map<string, FindState>();
const pendingListeners = new Set<(workspaceId: string) => void>();

/** Opens (or brings forward) the workspace's search tab showing `state`. */
export function openSearchTab(workspaceId: string, state: FindState) {
  pending.set(workspaceId, state);
  pendingListeners.forEach((listener) => listener(workspaceId));
  void bridge().tabAction("open-content", { section: "search", workspaceId });
}
/** The state a new search tab starts with, once. */
export function takePendingFind(workspaceId: string) {
  const state = pending.get(workspaceId);
  pending.delete(workspaceId);
  return state;
}
/** An open search tab takes what is sent to it later. */
export function onPendingFind(workspaceId: string, apply: (state: FindState) => void) {
  const listener = (id: string) => {
    const state = id === workspaceId ? takePendingFind(id) : undefined;
    if (state) apply(state);
  };
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}
