/** What a link can point at. Highlights and pages are a source with an anchor. */
export type ItemKind = "source" | "note" | "canvas" | "record";
export const ITEM_KINDS: readonly ItemKind[] = ["source", "note", "canvas", "record"];

export interface ItemLink {
  kind: ItemKind;
  id: string;
  /** A place inside the item: `page:3`, `highlight:<id>`, `heading:<slug>`, `node:<id>`. */
  anchor?: string;
}

export interface SourceRef {
  id: string;
  title: string;
  detail?: string;
  /** For a source, its kind (pdf, web, book …), used for the icon. */
  kind?: string;
  page?: number;
  /** Set when the picker offers something other than a whole source. */
  itemKind?: ItemKind;
  anchor?: string;
  /** A highlight's colour. */
  color?: string;
}

/** Where a note's images live: the workspace stores files and shows them back. */
export interface NoteMediaHost {
  /** Stores an image file in the workspace; answers the `media/…` path the note keeps. */
  save(file: File): Promise<string>;
  /** A URL the editor can load for a stored path (other URLs pass through). */
  url(src: string): string;
}

export interface NoteEditorProps {
  /** Markdown (GFM plus the note fences). */
  value: string;
  /** Called debounced (~400 ms) and on blur/unmount when there are unsaved edits. */
  onChange: (markdown: string) => void;
  searchSources: (query: string) => Promise<SourceRef[]>;
  /** Used by source cards, source quotes and mention chips. */
  resolveSource: (id: string) => Promise<SourceRef | undefined>;
  onOpenSource: (id: string, page?: number) => void;
  /** Without it, images can only be linked by URL. */
  media?: NoteMediaHost;
  /** The @ picker in link mode: any item (notes, highlights, canvases …). Falls back to searchSources. */
  searchItems?: (query: string) => Promise<SourceRef[]>;
  /** Opens a link to something other than a whole source. */
  onOpenItem?: (item: ItemLink) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Shows the note without editing it (a canvas card); links and media still work. */
  readOnly?: boolean;
  /** Narrow inspector panel: smaller type, gutter tucked closer. */
  compact?: boolean;
  className?: string;
}

export type CalloutTone = "info" | "tip" | "warning" | "note";
export const CALLOUT_TONES: readonly CalloutTone[] = ["info", "tip", "warning", "note"];

export const SOURCE_HREF_PREFIX = "key://source/";

export function sourceIdFromHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith(SOURCE_HREF_PREFIX)) return null;
  const id = decodeURIComponent(href.slice(SOURCE_HREF_PREFIX.length).replace(/[?#].*$/, ""));
  return id || null;
}

export function sourceHref(id: string): string {
  return SOURCE_HREF_PREFIX + encodeURIComponent(id);
}

export const ITEM_HREF_PREFIX = "key://";

/** `key://note/<id>`, `key://source/<id>#page:3`. */
export function itemHref(item: ItemLink): string {
  return `${ITEM_HREF_PREFIX}${item.kind}/${encodeURIComponent(item.id)}${item.anchor ? `#${encodeURIComponent(item.anchor)}` : ""}`;
}

export function itemFromHref(href: string | null | undefined): ItemLink | null {
  if (!href || !href.startsWith(ITEM_HREF_PREFIX)) return null;
  const match = /^([a-z]+)\/([^?#]+)(?:\?page=(\d+))?(?:#(.+))?$/.exec(href.slice(ITEM_HREF_PREFIX.length));
  if (!match || !(ITEM_KINDS as readonly string[]).includes(match[1])) return null;
  const anchor = match[4] ? decodeURIComponent(match[4]) : match[3] ? `page:${match[3]}` : undefined;
  return { kind: match[1] as ItemKind, id: decodeURIComponent(match[2]), ...(anchor ? { anchor } : {}) };
}

// Items dragged anywhere in the app (library rows, the sidebar, canvas cards) carry this
// type; a canvas places them as cards and a note links them where they land.
export const ITEM_DRAG_TYPE = "application/x-key-items";

export interface DraggedItem extends ItemLink {
  title: string;
  /** A source's kind, or a highlight's text. */
  detail?: string;
  color?: string;
}

export function setItemDrag(data: DataTransfer, items: DraggedItem[]) {
  if (!items.length) return;
  data.setData(ITEM_DRAG_TYPE, JSON.stringify(items));
  data.setData("text/uri-list", items.map(itemHref).join("\r\n"));
  data.setData("text/plain", items.map((item) => item.title || "Untitled").join("\n"));
}

export const hasItemDrag = (data: DataTransfer | null | undefined) => !!data?.types.includes(ITEM_DRAG_TYPE);

export function readItemDrag(data: DataTransfer | null | undefined): DraggedItem[] {
  try {
    const items = JSON.parse(data?.getData(ITEM_DRAG_TYPE) || "[]") as DraggedItem[];
    return Array.isArray(items) ? items.filter((i) => i && (ITEM_KINDS as readonly string[]).includes(i.kind) && typeof i.id === "string") : [];
  } catch {
    return [];
  }
}

/** The link a picked entry makes. */
export function refItem(ref: SourceRef): ItemLink {
  return { kind: ref.itemKind ?? "source", id: ref.id, ...(ref.anchor ? { anchor: ref.anchor } : {}) };
}
