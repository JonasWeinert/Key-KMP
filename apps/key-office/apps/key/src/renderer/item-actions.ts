// What every item (source, highlight, note, canvas, page) can do wherever it is shown:
// describe itself for previews, open in a tab, beside the current pane or in its place,
// copy a link or citation, and be sent to a canvas or note. Views register here so a
// send reaches an open editor rather than racing it through the store.
import { apa, apaInText } from "./citation";
import type { IconName } from "./icons";
import { bridge, shortCreators, type Invoke, type Note, type Source } from "./library-api";
import { itemFromHref, itemHref, markdownToPlainText, type DraggedItem, type ItemLink } from "./note-editor";
import { noteSources } from "./note-sources";
import { belowContent, layoutCards, normalizeDoc } from "./canvas/model";
import { describeLinkedFile, openLinkedFile } from "./linked-files";

export type Placement = "tab" | "split" | "here";

// ── The shell's current context ──────────────────────────────────────────────

const shell: { invoke?: Invoke; workspaceId?: string; viewId?: string } = {};
/** App keeps this current: the window's workspace and the focused pane. */
export function setShellContext(context: Partial<typeof shell>) {
  Object.assign(shell, context);
}
export const shellContext = () => shell;

// ── Describing an item ───────────────────────────────────────────────────────

export interface Highlight {
  id: string;
  text?: string;
  comment?: string;
  color?: string;
  range?: { start?: { page?: number } };
  anchor?: { pages?: { page?: number }[] };
}
export const highlightPage = (h: Highlight) => h.anchor?.pages?.[0]?.page ?? h.range?.start?.page;

export interface ItemInfo {
  item: ItemLink;
  title: string;
  /** "Note", "PDF", "Highlight" … */
  kindLabel: string;
  icon: IconName;
  /** Authors and year, or where a highlight is from. */
  subtitle?: string;
  /** Markdown of a note or page. */
  body?: string;
  /** A source's abstract or a highlight's comment. */
  summary?: string;
  source?: Source;
  highlight?: Highlight & { page?: number };
  canvas?: { nodes: { x: number; y: number; w: number; h: number; type: string; color?: string }[]; cards: number };
  note?: Note;
  /** A file in a linked folder: where it is on disk, for a Quick Look preview. */
  file?: { path: string; kind: string; folder: string; missing: boolean };
  exists: boolean;
}

const KIND_LABEL: Record<string, string> = { pdf: "PDF", web: "Web page", video: "Video", audio: "Audio", image: "Image", book: "Book", reference: "Reference", file: "File" };
const SOURCE_ICON: Record<string, IconName> = { pdf: "doc", web: "globe", video: "video", audio: "audio", image: "image", book: "book", reference: "quote" };
export function itemIcon(item: Pick<ItemLink, "kind" | "anchor">, sourceKind?: string): IconName {
  if (item.anchor?.startsWith("highlight:")) return "quote";
  if (item.kind === "note") return "note";
  if (item.kind === "canvas") return "canvas";
  if (item.kind === "record") return "doc";
  if (item.kind === "file") return sourceKind === "markdown" ? "note" : sourceKind === "image" ? "image" : "doc";
  return SOURCE_ICON[sourceKind ?? ""] ?? "doc";
}

const cache = new Map<string, { at: number; info: Promise<ItemInfo> }>();
/** Forgets what was read about items, after a save changes them. */
export function forgetItems() {
  cache.clear();
}
if (typeof window !== "undefined") {
  for (const event of ["key:note-saved", "key:notes-changed", "key:canvases-changed"]) window.addEventListener(event, forgetItems);
}

export function describeItem(invoke: Invoke, workspaceId: string, item: ItemLink): Promise<ItemInfo> {
  const key = `${workspaceId}|${itemHref(item)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.info;
  const info = readItem(invoke, workspaceId, item).catch(
    (): ItemInfo => ({ item, title: "Missing item", kindLabel: "", icon: itemIcon(item), exists: false }),
  );
  cache.set(key, { at: Date.now(), info });
  return info;
}

async function readItem(invoke: Invoke, workspaceId: string, item: ItemLink): Promise<ItemInfo> {
  const missing = (label: string): ItemInfo => ({ item, title: `This ${label.toLowerCase()} no longer exists`, kindLabel: label, icon: itemIcon(item), exists: false });
  switch (item.kind) {
    case "note": {
      const note = await invoke<Note | null>("store_note", { id: item.id }, workspaceId);
      if (!note) return missing("Note");
      const title = note.title || markdownToPlainText(note.body).split("\n").find(Boolean) || "Untitled note";
      let subtitle: string | undefined;
      if (note.sourceId) subtitle = `Note on ${(await invoke<Source | null>("store_source", { id: note.sourceId }, workspaceId).catch(() => null))?.title ?? "a source"}`;
      return { item, title, kindLabel: "Note", icon: "note", subtitle, body: note.body, note, exists: true };
    }
    case "record": {
      const record = await invoke<{ title: string; kind: string; body: string } | null>("workspace_record", { id: item.id }, workspaceId);
      if (!record) return missing("Page");
      return { item, title: record.title || "Untitled", kindLabel: record.kind === "database" ? "Database" : "Page", icon: record.kind === "database" ? "database" : "doc", body: record.body, exists: true };
    }
    case "file":
      return (await describeLinkedFile(invoke, workspaceId, item)) ?? missing("File");
    case "canvas": {
      const canvas = await invoke<{ title: string; doc: unknown } | null>("store_canvas", { id: item.id }, workspaceId);
      if (!canvas) return missing("Canvas");
      const doc = normalizeDoc(canvas.doc);
      return {
        item,
        title: canvas.title || "Untitled canvas",
        kindLabel: "Canvas",
        icon: "canvas",
        subtitle: `${doc.nodes.filter((n) => n.type === "item").length} cards · ${doc.nodes.length} objects`,
        canvas: { nodes: doc.nodes.map(({ x, y, w, h, type, ...rest }) => ({ x, y, w, h, type, color: (rest as { color?: string }).color })), cards: doc.nodes.length },
        exists: true,
      };
    }
    case "source": {
      const source = await invoke<Source | null>("store_source", { id: item.id }, workspaceId);
      if (!source) return missing("Source");
      const byline = [shortCreators(source.creators), source.year].filter(Boolean).join(" · ");
      if (item.anchor?.startsWith("highlight:")) {
        const id = item.anchor.slice("highlight:".length);
        const all = await invoke<Highlight[]>("library_annotations", { hash: source.id }, workspaceId).catch(() => []);
        const found = all.find((h) => h.id === id);
        if (!found) return missing("Highlight");
        const page = highlightPage(found);
        return {
          item,
          title: (found.text || found.comment || "Highlight").replace(/\s+/g, " ").trim(),
          kindLabel: "Highlight",
          icon: "quote",
          subtitle: [source.title || "Untitled", page !== undefined ? `p. ${page + 1}` : ""].filter(Boolean).join(" · "),
          summary: found.comment,
          source,
          highlight: { ...found, page },
          exists: true,
        };
      }
      const page = item.anchor?.startsWith("page:") ? Number(item.anchor.slice(5)) : undefined;
      return {
        item,
        title: source.title || "Untitled",
        kindLabel: page !== undefined ? `Page ${page + 1}` : (KIND_LABEL[source.kind] ?? "Source"),
        icon: itemIcon(item, source.kind),
        subtitle: [byline, source.containerTitle].filter(Boolean).join(" · ") || undefined,
        summary: source.abstract,
        source,
        exists: true,
      };
    }
  }
}

// ── Opening ──────────────────────────────────────────────────────────────────

/** Opens what a link points at: in a new tab, beside the focused pane, or in its place. */
export function openItemAt(item: ItemLink, placement: Placement = "tab", title?: string, workspaceId = shell.workspaceId, invoke = shell.invoke) {
  if (!workspaceId || !invoke) return;
  const where = placement === "tab" ? {} : { placement, fromViewId: shell.viewId };
  const action = (name: string, payload: Record<string, unknown>) => void bridge().tabAction(name, { ...payload, ...where });
  switch (item.kind) {
    case "note":
      return action("open-content", { section: "note", workspaceId, noteId: item.id, title });
    case "canvas":
      return action("open-content", { section: "canvas", workspaceId, canvasId: item.id, title });
    case "record":
      return action("open-content", { section: "record", workspaceId, record: { id: item.id } });
    case "file":
      return void openLinkedFile(invoke, workspaceId, item.id, title, where);
    case "source": {
      const page = item.anchor?.startsWith("page:") ? Number(item.anchor.slice(5)) : undefined;
      const highlight = item.anchor?.startsWith("highlight:") ? item.anchor.slice(10) : undefined;
      if (page !== undefined || highlight) return noteSources(invoke, workspaceId).onOpenSource(item.id, page, highlight);
      return action("open-source-page", { workspaceId, sourceId: item.id, title: title || "Untitled", read: false });
    }
  }
}

// ── Copying ──────────────────────────────────────────────────────────────────

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function writeClipboard(plain: string, html?: string) {
  try {
    const parts: Record<string, Blob> = { "text/plain": new Blob([plain], { type: "text/plain" }) };
    if (html) parts["text/html"] = new Blob([html], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}

/** A link that pastes as a link in notes (and as its key:// address elsewhere). */
export async function copyItemLink(items: { item: ItemLink; title: string }[]) {
  if (!items.length) return;
  const plain = items.map(({ item }) => itemHref(item)).join("\n");
  const html = items.map(({ item, title }) => `<a href="${escapeHtml(itemHref(item))}">${escapeHtml(title)}</a>`).join(", ");
  await writeClipboard(plain, html);
  toast(items.length === 1 ? "Link copied" : `${items.length} links copied`);
}

/** (Palma et al., 2022, p. 4) */
export function inTextCitation(source: Source, page?: number) {
  const base = apaInText(source);
  return page === undefined ? base : `${base.slice(0, -1)}, p. ${page + 1})`;
}

/** The reference list entry for sources; a highlight copies as a quotation with its citation. */
export async function copyCitation(invoke: Invoke, workspaceId: string, items: ItemLink[]) {
  const infos = await Promise.all(items.map((item) => describeItem(invoke, workspaceId, item)));
  const cited = infos.filter((info) => info.source);
  if (!cited.length) return toast("Only sources and highlights have citations");
  const plain = cited
    .map((info) => (info.highlight ? `“${info.highlight.text ?? ""}” ${inTextCitation(info.source!, info.highlight.page)}` : apa(info.source!)))
    .join("\n\n");
  const html = cited
    .map((info) => (info.highlight ? `<p>“${escapeHtml(info.highlight.text ?? "")}” ${escapeHtml(inTextCitation(info.source!, info.highlight.page))}</p>` : `<p>${apa(info.source!, true)}</p>`))
    .join("");
  await writeClipboard(plain, html);
  toast(cited.length === 1 ? "Citation copied" : `${cited.length} citations copied`);
}

// ── Sending to a canvas or a note ────────────────────────────────────────────

export type InsertMode = "link" | "embed" | "cite";

type CanvasTarget = (items: DraggedItem[]) => () => void;
type NoteTarget = (markdown: string) => () => void;
const openCanvases = new Map<string, CanvasTarget>();
const openNotes = new Map<string, NoteTarget>();
/** An open canvas takes sent items itself (and answers how to take them back). */
export function registerCanvasTarget(id: string, add: CanvasTarget) {
  openCanvases.set(id, add);
  return () => {
    if (openCanvases.get(id) === add) openCanvases.delete(id);
  };
}
export function registerNoteTarget(id: string, append: NoteTarget) {
  openNotes.set(id, append);
  return () => {
    if (openNotes.get(id) === append) openNotes.delete(id);
  };
}

/** Adds items as cards below what a canvas already shows. Answers an undo. */
export async function sendToCanvas(invoke: Invoke, workspaceId: string, canvasId: string, items: DraggedItem[]): Promise<() => void> {
  const placing = items.filter((item) => !(item.kind === "canvas" && item.id === canvasId));
  const live = openCanvases.get(canvasId);
  if (live) return live(placing);
  const stored = await invoke<{ doc: unknown } | null>("store_canvas", { id: canvasId }, workspaceId);
  if (!stored) throw Error("This canvas no longer exists");
  const before = normalizeDoc(stored.doc);
  const nodes = layoutCards(placing, belowContent(before));
  await invoke("store_canvas_save", { id: canvasId, doc: { ...before, nodes: [...before.nodes, ...nodes] } }, workspaceId);
  return () => {
    const ids = new Set(nodes.map((n) => n.id));
    void invoke<{ doc: unknown } | null>("store_canvas", { id: canvasId }, workspaceId).then((now) => {
      if (!now) return;
      const doc = normalizeDoc(now.doc);
      return invoke("store_canvas_save", { id: canvasId, doc: { ...doc, nodes: doc.nodes.filter((n) => !ids.has(n.id)), edges: doc.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node)) } }, workspaceId);
    });
  };
}

/** Markdown for items placed in a note: links, citations or live embeds. */
export async function itemsMarkdown(invoke: Invoke, workspaceId: string, items: DraggedItem[], mode: InsertMode): Promise<string> {
  const label = (text: string) => text.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
  if (mode === "embed") return items.map((item) => `\`\`\`embed href="${itemHref(item)}"\n${label(item.title)}\n\`\`\``).join("\n\n");
  if (mode === "cite") {
    const parts = await Promise.all(
      items.map(async (item) => {
        const info = await describeItem(invoke, workspaceId, item);
        if (!info.source) return `[${label(item.title)}](${itemHref(item)})`;
        const page = info.highlight?.page ?? (item.anchor?.startsWith("page:") ? Number(item.anchor.slice(5)) : undefined);
        const cite = `[${inTextCitation(info.source, page)}](${itemHref(item)})`;
        return info.highlight?.text ? `“${info.highlight.text.replace(/\s+/g, " ").trim()}” ${cite}` : cite;
      }),
    );
    return parts.join(" ");
  }
  return items.map((item) => `[${label(item.title)}](${itemHref(item)})`).join(", ");
}

/** Appends items to the end of a note. Answers an undo. */
export async function sendToNote(invoke: Invoke, workspaceId: string, noteId: string, items: DraggedItem[], mode: InsertMode = "link"): Promise<() => void> {
  const markdown = await itemsMarkdown(invoke, workspaceId, items, mode);
  const live = openNotes.get(noteId);
  if (live) return live(markdown);
  const note = await invoke<Note | null>("store_note", { id: noteId }, workspaceId);
  if (!note) throw Error("This note no longer exists");
  const body = `${note.body.replace(/\s+$/, "")}\n\n${markdown}\n`;
  await invoke("store_note_save", { id: noteId, title: note.title, body }, workspaceId);
  window.dispatchEvent(new CustomEvent("key:note-saved", { detail: noteId }));
  return () => void invoke("store_note_save", { id: noteId, title: note.title, body: note.body }, workspaceId).then(() => window.dispatchEvent(new CustomEvent("key:note-saved", { detail: noteId })));
}

/** Items in a DOM drag or a key:// address list. */
export function itemsFromHrefs(text: string): ItemLink[] {
  return text
    .split(/\s+/)
    .map((line) => itemFromHref(line.trim()))
    .filter((item): item is ItemLink => !!item);
}

// ── Toasts with undo ─────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}
const toastListeners = new Set<(toast: Toast) => void>();
let toastId = 0;
/** A short message at the bottom of the window, with Undo when the action can be taken back. */
export function toast(message: string, undo?: () => void) {
  const next = { id: ++toastId, message, undo };
  toastListeners.forEach((listener) => listener(next));
}
export function onToast(listener: (toast: Toast) => void) {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

/** "3 sources", "a note and 2 highlights". */
export function describeCount(items: Pick<ItemLink, "kind" | "anchor">[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const kind = item.anchor?.startsWith("highlight:") ? "highlight" : item.kind === "record" ? "page" : item.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => (n === 1 ? `1 ${kind}` : `${n} ${kind}s`));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
}
