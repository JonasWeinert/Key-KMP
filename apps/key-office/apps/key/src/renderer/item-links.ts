// Cross-references between items (the `store_links` / `store_link_targets` host commands):
// what the link picker offers, and how a link opens what it points at.
import { bridge, type Invoke } from "./library-api";
import type { ItemKind, ItemLink, SourceRef } from "./note-editor";
import { noteSources } from "./note-sources";

export type { ItemKind, ItemLink };

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
const TARGET_LABEL: Record<ItemKind, string> = { source: "Source", note: "Note", canvas: "Canvas", record: "Page" };

/** Opens whatever a link points at, in the place the app opens that kind of item. */
export function openItem(invoke: Invoke, workspaceId: string, item: ItemLink, title?: string) {
  const action = (name: string, payload: unknown) => void bridge().tabAction(name, payload);
  switch (item.kind) {
    case "note":
      return action("open-content", { section: "note", workspaceId, noteId: item.id, title });
    case "canvas":
      return action("open-content", { section: "canvas", workspaceId, canvasId: item.id, title });
    case "record":
      return action("open-content", { section: "record", workspaceId, record: { id: item.id } });
    case "source": {
      const page = item.anchor?.startsWith("page:") ? Number(item.anchor.slice(5)) : undefined;
      const highlight = item.anchor?.startsWith("highlight:") ? item.anchor.slice(10) : undefined;
      if (page !== undefined || highlight) return noteSources(invoke, workspaceId).onOpenSource(item.id, page, highlight);
      return action("open-source-page", { workspaceId, sourceId: item.id, title: title || "Untitled", read: false });
    }
  }
}

/** Notes, sources, highlights and canvases for the @ picker; an empty query lists recent ones. */
export function itemSearch(invoke: Invoke, workspaceId: string) {
  return async (query: string): Promise<SourceRef[]> => (await linkTargets(invoke, workspaceId, query.trim(), undefined, 6)).map(targetRef);
}
