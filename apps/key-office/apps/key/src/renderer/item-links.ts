// Cross-references between items (the `store_links` / `store_link_targets` host commands):
// what the link picker offers, and how a link opens what it points at.
import { bridge, type Invoke, type Source } from "./library-api";
import { openItemAt, type Placement } from "./item-actions";
import { hasItemDrag, itemFromHref, type DraggedItem, type ItemKind, type ItemLink, type SourceRef } from "./note-editor";
import { libraryChanged } from "./library-nav";
import { noteSources } from "./note-sources";

export type { DraggedItem, ItemKind, ItemLink };
export { hasItemDrag, readItemDrag, setItemDrag } from "./note-editor";

export interface LinkEnd extends ItemLink {
  title: string;
  /** A source's kind (pdf, web …). */
  detail?: string;
  /** "p. 4" or a highlight's text. */
  anchorLabel?: string;
  exists: boolean;
}
export interface Link {
  id: number;
  from: LinkEnd;
  to: LinkEnd;
  /** The canvas a connector was drawn on. */
  via?: LinkEnd;
  label: string | null;
  context: string | null;
  broken: boolean;
  createdAt: number;
}
export interface ItemLinks {
  outgoing: Link[];
  backlinks: Link[];
}
export interface LinkTarget extends ItemLink {
  title: string;
  detail?: string;
  context?: string;
  color?: string;
  page?: number;
  updatedAt: number;
}

export const itemLinks = (invoke: Invoke, workspaceId: string, item: ItemLink) =>
  invoke<ItemLinks>("store_links", { kind: item.kind, id: item.id }, workspaceId);

export const linkTargets = (invoke: Invoke, workspaceId: string, text: string, kinds?: string[], limit = 8) =>
  invoke<LinkTarget[]>("store_link_targets", { text, kinds: kinds ?? null, limit }, workspaceId);

/** A picker entry as the note editor shows and inserts it. */
export function targetRef(target: LinkTarget): SourceRef {
  const highlight = target.anchor?.startsWith("highlight:");
  return {
    id: target.id,
    title: target.title,
    detail: highlight ? [target.context, target.page !== undefined ? `p. ${target.page + 1}` : ""].filter(Boolean).join(" · ") : target.kind === "source" ? target.detail : TARGET_LABEL[target.kind],
    kind: target.kind === "source" && !highlight ? target.detail : undefined,
    itemKind: target.kind,
    anchor: target.anchor,
    color: target.color,
    page: target.page,
  };
}
const TARGET_LABEL: Record<ItemKind, string> = { source: "Source", note: "Note", canvas: "Canvas", record: "Page", file: "File" };

/** Opens whatever a link points at. A followed link replaces the pane it is in (Back returns),
 * like a browser; other places pass "tab" or "split". */
export function openItem(invoke: Invoke, workspaceId: string, item: ItemLink, title?: string, placement: Placement = "here") {
  openItemAt(item, placement, title, workspaceId, invoke);
}

/** Notes, sources, highlights and canvases for the @ picker; an empty query lists recent ones. */
export function itemSearch(invoke: Invoke, workspaceId: string) {
  return async (query: string): Promise<SourceRef[]> => (await linkTargets(invoke, workspaceId, query.trim(), undefined, 6)).map(targetRef);
}

// ── Dropping things in from outside the app ──────────────────────────────────

export const sourceItem = (source: Pick<Source, "id" | "title" | "kind">): DraggedItem => ({ kind: "source", id: source.id, title: source.title || "Untitled", detail: source.kind });

/** Web links in a drop (a browser's address bar or a link), not the app's own key:// ones. */
function droppedUrls(data: DataTransfer): string[] {
  const list = data.getData("text/uri-list") || data.getData("text/plain");
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/\S+$/i.test(line));
}

/** Files, or web links, from outside the app: things a drop can add to the library. Drags
 * inside the app (items, sources, collections) carry an `application/x-key-…` type. */
export const hasExternalDrop = (data: DataTransfer | null) =>
  !!data && !hasItemDrag(data) && !data.types.some((t) => t.startsWith("application/x-key")) && (data.types.includes("Files") || data.types.includes("text/uri-list"));

/**
 * Adds dropped files (imported and indexed) or web links (as web sources) to the library,
 * in `collectionId` when given, and answers them as items to place or link.
 */
export async function importDrop(invoke: Invoke, workspaceId: string, data: DataTransfer, collection?: string | (() => Promise<string | undefined>)): Promise<DraggedItem[]> {
  // Read everything now: the drop's data is gone once the event returns.
  const paths = [...data.files].map((file) => bridge().pathForFile(file)).filter(Boolean);
  const urls = droppedUrls(data);
  const collectionId = typeof collection === "function" ? await collection() : collection;
  const sources = paths.length ? ((await bridge().importPaths(workspaceId, paths, collectionId)) as Source[]) : await createWebSources(invoke, workspaceId, urls, collectionId);
  if (sources.length) libraryChanged();
  return sources.map(sourceItem);
}

function createWebSources(invoke: Invoke, workspaceId: string, urls: string[], collectionId?: string) {
  return Promise.all(
    urls
      .filter((url) => !itemFromHref(url))
      .map((url) =>
        invoke<Source>("store_create", { source: { kind: "web", itemType: "webpage", title: url, url, collections: collectionId ? [collectionId] : [] } }, workspaceId),
      ),
  );
}

/** The workspace's Inbox collection, where things dropped on the window land; made when first needed. */
export async function inboxCollection(invoke: Invoke, workspaceId: string): Promise<string> {
  const collections = await invoke<{ id: string; name: string; parentId: string | null }[]>("store_collections", {}, workspaceId);
  const inbox = collections.find((c) => !c.parentId && c.name === "Inbox");
  if (inbox) return inbox.id;
  const created = await invoke<{ id: string }>("store_collection_create", { name: "Inbox", parentId: null }, workspaceId);
  libraryChanged();
  return created.id;
}
