// Files in linked folders as items (`key://file/<id>`): what they are called and where they
// live, and how they open — PDFs in the reader, everything else in a file pane (Markdown
// editable, other files previewed). The folders themselves are listed by LinkedFolders.
import type { ItemInfo } from "./item-actions";
import { bridge, type Invoke } from "./library-api";
import type { ItemLink } from "./note-editor";
import { noteSources } from "./note-sources";

export interface LinkedFolder {
  id: string;
  path: string;
  name: string;
  tracked: boolean;
  indexed: boolean;
  missing: boolean;
  scannedAt?: number;
  files: number;
  indexedFiles: number;
  pendingFiles: number;
}

export interface LinkedFile {
  /** Empty for a file of an untracked folder until it is opened or linked. */
  id: string;
  folderId: string;
  /** Relative to the folder. */
  path: string;
  name: string;
  absPath: string;
  size: number;
  mtime: number;
  /** markdown | text | pdf | other */
  kind: string;
  missing: boolean;
  indexed: boolean;
  indexError?: string;
  sourceId?: string;
}

export interface LinkedEntries {
  dirs: { path: string; name: string }[];
  files: LinkedFile[];
  truncated: boolean;
}

export const linkedFolders = (invoke: Invoke, workspaceId: string) => invoke<LinkedFolder[]>("store_linked_folders", {}, workspaceId);
export const linkedEntries = (invoke: Invoke, workspaceId: string, folderId: string, dir = "") =>
  invoke<LinkedEntries>("store_linked_entries", { folderId, dir }, workspaceId);
export const linkedFile = (invoke: Invoke, workspaceId: string, id: string) => invoke<LinkedFile | null>("store_linked_file", { id }, workspaceId);

/** A file's id, giving it one first when its folder is not tracked. */
export async function ensureFileId(invoke: Invoke, workspaceId: string, file: LinkedFile) {
  if (file.id) return file;
  return invoke<LinkedFile>("store_linked_file_at", { folderId: file.folderId, path: file.path }, workspaceId);
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp|svg)$/i;
/** markdown | text | pdf | image | other: what the file shows as. */
export const fileShowsAs = (file: Pick<LinkedFile, "kind" | "name">) => (file.kind === "other" && IMAGE.test(file.name) ? "image" : file.kind);

const KIND_LABEL: Record<string, string> = { markdown: "Markdown", text: "Text file", pdf: "PDF", image: "Image", other: "File" };

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export async function describeLinkedFile(invoke: Invoke, workspaceId: string, item: ItemLink): Promise<ItemInfo | undefined> {
  const file = await linkedFile(invoke, workspaceId, item.id);
  if (!file) return undefined;
  const folders = await linkedFolders(invoke, workspaceId).catch(() => []);
  const folder = folders.find((f) => f.id === file.folderId);
  const shows = fileShowsAs(file);
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  let body: string | undefined;
  if (shows === "markdown" && !file.missing && file.size < 256 * 1024)
    body = await invoke<{ text: string }>("store_linked_read", { id: file.id }, workspaceId)
      .then((r) => r.text)
      .catch(() => undefined);
  return {
    item,
    title: file.name,
    kindLabel: KIND_LABEL[shows] ?? "File",
    icon: shows === "markdown" ? "note" : shows === "image" ? "image" : "doc",
    subtitle: [[folder?.name, dir].filter(Boolean).join("/"), formatSize(file.size)].filter(Boolean).join(" · "),
    body,
    file: { path: file.absPath, kind: shows, folder: folder?.name ?? "", missing: file.missing || !!folder?.missing },
    exists: !file.missing,
  };
}

/** PDFs open in the reader (as a source that points at the file in place); others in a file pane. */
export async function openLinkedFile(invoke: Invoke, workspaceId: string, id: string, title?: string, where: Record<string, unknown> = {}) {
  const file = await linkedFile(invoke, workspaceId, id);
  if (!file) return;
  void invoke("store_linked_priority", { id }, workspaceId).catch(() => {});
  if (file.kind === "pdf" && !file.missing) {
    try {
      const source = await invoke<{ id: string }>("store_linked_open_pdf", { id }, workspaceId);
      return noteSources(invoke, workspaceId).onOpenSource(source.id);
    } catch {
      // Unreadable as a PDF: shown in the file pane with its preview instead.
    }
  }
  return bridge().tabAction("open-content", { section: "file", workspaceId, fileId: id, title: title || file.name, ...where });
}
