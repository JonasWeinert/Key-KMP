// One search for everywhere something is looked up — the link and citation pickers in
// notes, Open Quickly, Send to…, adding to a canvas — in the same three sections as the
// library's search: matches in titles and details first, then in the text, then related
// by meaning. Title matches come back at once; the full-text search follows.
import { useEffect, useRef, useState } from "react";
import type { Invoke, SearchResult } from "./library-api";
import { linkTargets, type LinkTarget } from "./item-links";
import type { DraggedItem, ItemKind } from "./note-editor";

export type SearchGroup = "titles" | "text" | "meaning";
export const GROUP_LABEL: Record<SearchGroup, string> = {
  titles: "Titles and details",
  text: "In the text",
  meaning: "Related by meaning",
};
export const GROUPS: SearchGroup[] = ["titles", "text", "meaning"];

export interface Found extends DraggedItem {
  group: SearchGroup;
  /** Where it matched: "p. 4", "Abstract", "Note on …". */
  where?: string;
  /** A passage with `[[match]]` markers. */
  snippet?: string;
  /** A source's kind (pdf, web …), for the icon. */
  sourceKind?: string;
}

export interface Found3 {
  titles: Found[];
  text: Found[];
  meaning: Found[];
  /** The full-text search is still running. */
  pending: boolean;
  semantic: boolean;
}
export const EMPTY_FOUND: Found3 = { titles: [], text: [], meaning: [], pending: false, semantic: false };

export interface SearchOptions {
  /** Only these kinds (a highlight is a source with an anchor; "highlight" asks for those). */
  kinds?: (ItemKind | "highlight")[];
  /** Leave out the full-text search (titles only). */
  titlesOnly?: boolean;
  limit?: number;
  /** Library filters (as the store takes them) for the text search; standalone notes then drop out. */
  filters?: { field: string; op?: string; value: string; key?: string }[];
}

const FIELD_WHERE: Record<string, string> = { creators: "Authors", container: "Journal", abstract: "Abstract", tags: "Tags", notes: "Notes", identifiers: "Identifier" };

const key = (f: Pick<Found, "kind" | "id" | "anchor">) => `${f.kind}:${f.id}:${f.anchor ?? ""}`;

/** Exact and prefix title matches first, then by recency (the order the store gives). */
function rank(query: string, found: Found[]) {
  const q = query.trim().toLowerCase();
  if (!q) return found;
  const score = (f: Found) => {
    const t = f.title.toLowerCase();
    return t === q ? 0 : t.startsWith(q) ? 1 : new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t) ? 2 : 3;
  };
  return found.map((f, i) => [f, score(f), i] as const).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([f]) => f);
}

export function targetFound(target: LinkTarget): Found {
  const highlight = target.anchor?.startsWith("highlight:");
  return {
    kind: target.kind,
    id: target.id,
    anchor: target.anchor,
    title: target.title,
    detail: highlight ? target.context : target.detail,
    color: target.color,
    group: "titles",
    where: highlight ? [target.context, target.page != null ? `p. ${target.page + 1}` : ""].filter(Boolean).join(" · ") : target.kind === "note" ? (target.detail === "source note" ? "Note on a source" : "Note") : target.kind === "canvas" ? "Canvas" : undefined,
    sourceKind: target.kind === "source" && !highlight ? target.detail : undefined,
  };
}

function wanted(found: Found, kinds?: SearchOptions["kinds"]) {
  if (!kinds) return true;
  const highlight = found.anchor?.startsWith("highlight:");
  return highlight ? kinds.includes("highlight") : kinds.includes(found.kind);
}

/** Titles and details: names of notes, sources, highlights, canvases and pages. */
export async function searchTitles(invoke: Invoke, workspaceId: string, query: string, options: SearchOptions = {}): Promise<Found[]> {
  const limit = options.limit ?? 8;
  const storeKinds = options.kinds?.filter((k) => k !== "record");
  const [targets, records] = await Promise.all([
    storeKinds && !storeKinds.length ? [] : linkTargets(invoke, workspaceId, query.trim(), storeKinds as string[] | undefined, limit),
    options.kinds && !options.kinds.includes("record")
      ? []
      : invoke<{ id: string; kind: string; title: string }[]>("workspace_records", { query: query.trim() || null, limit, offset: 0 }, workspaceId).catch(() => []),
  ]);
  const pages: Found[] = records
    .filter((r) => r.kind !== "source")
    .map((r) => ({ kind: "record", id: r.id, title: r.title || "Untitled", group: "titles", where: r.kind === "database" ? "Database" : "Page" }));
  return rank(query, [...targets.map(targetFound), ...pages].filter((f) => wanted(f, options.kinds)));
}

/** The library search: details beyond the title, passages in the text, and passages by meaning. */
export async function searchText(invoke: Invoke, workspaceId: string, query: string, options: SearchOptions = {}) {
  const result = await invoke<SearchResult>("store_search", { text: query, limit: options.limit ?? 12, passagesPerSource: 2, filters: options.filters ?? [] }, workspaceId);
  const details: Found[] = [],
    text: Found[] = [],
    meaning: Found[] = [];
  for (const hit of result.hits) {
    const source = hit.source;
    const title = source?.title || hit.title || "Untitled";
    const base = { kind: "source" as const, id: hit.sourceId, title, sourceKind: source?.kind, detail: source?.kind };
    const field = hit.fields.find((f) => f.field !== "notes");
    if (hit.metadataMatch && field) details.push({ ...base, group: "titles", where: FIELD_WHERE[field.field], snippet: field.snippet });
    for (const passage of hit.passages) {
      const into = passage.related ? meaning : text;
      if (passage.noteId) into.push({ kind: "note", id: passage.noteId, title: `Note on ${title}`, group: into === text ? "text" : "meaning", where: "Note", snippet: passage.snippet });
      else
        into.push({
          ...base,
          anchor: passage.page != null ? `page:${passage.page}` : undefined,
          group: into === text ? "text" : "meaning",
          where: passage.page != null ? `p. ${passage.page + 1}` : undefined,
          snippet: passage.snippet,
        });
    }
  }
  for (const note of options.filters?.length ? [] : result.notes) {
    for (const passage of note.passages.slice(0, 1)) {
      const into = passage.related ? meaning : text;
      into.push({ kind: "note", id: note.noteId, title: note.title || "Untitled note", group: into === text ? "text" : "meaning", where: "Note", snippet: passage.snippet });
    }
  }
  return { details, text, meaning, semantic: result.semantic };
}

/** Both searches, merged without repeats: a title match is never repeated below. */
export function mergeFound(titles: Found[], more: Awaited<ReturnType<typeof searchText>> | undefined, options: SearchOptions = {}): Omit<Found3, "pending"> {
  const seen = new Set(titles.map(key));
  const sourcesInTitles = new Set(titles.filter((t) => t.kind === "source" && !t.anchor).map((t) => t.id));
  const take = (list: Found[]) =>
    list.filter((f) => {
      if (!wanted(f, options.kinds) || seen.has(key(f))) return false;
      seen.add(key(f));
      return true;
    });
  const details = take((more?.details ?? []).filter((d) => !sourcesInTitles.has(d.id)));
  const text = take(more?.text ?? []);
  const meaning = take(more?.meaning ?? []);
  return { titles: [...titles, ...details], text, meaning, semantic: !!more?.semantic };
}

/** Searches as the query changes: titles at once, the text after (newest query wins). */
export function useUnifiedSearch(invoke: Invoke | undefined, workspaceId: string | undefined, query: string, options: SearchOptions = {}) {
  const [found, setFound] = useState<Found3>(EMPTY_FOUND);
  const request = useRef(0);
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    const id = ++request.current;
    const current = () => id === request.current;
    const timer = setTimeout(async () => {
      const titles = await searchTitles(invoke, workspaceId, query, options).catch(() => []);
      if (!current()) return;
      const wantsText = !options.titlesOnly && query.trim().length >= 2;
      setFound({ ...mergeFound(titles, undefined, options), pending: wantsText });
      if (!wantsText) return;
      const more = await searchText(invoke, workspaceId, query.trim(), options).catch(() => undefined);
      if (current()) setFound({ ...mergeFound(titles, more, options), pending: false });
    }, query ? 120 : 0);
    return () => clearTimeout(timer);
  }, [invoke, workspaceId, query, optionsKey]);
  return found;
}
