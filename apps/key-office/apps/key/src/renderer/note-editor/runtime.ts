import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { DraggedItem, ItemLink, SourceRef } from "./types";

/** What the @ source picker inserts when an item is chosen. */
export type PickMode = "link" | "embed" | "quote" | "cite";

export interface UrlPromptRequest {
  title: string;
  placeholder: string;
  initial?: string;
  submit: (url: string) => void;
}

/**
 * Bridge between the ProseMirror side (extensions, node views) and the React
 * component that owns the props. One per mounted NoteEditor.
 */
export interface NoteRuntime {
  placeholder(): string;
  search(query: string, mode: PickMode): Promise<SourceRef[]>;
  /** Matches in the text and by meaning, which take longer; empty when not offered. */
  searchMore(query: string, mode: PickMode): Promise<SourceRef[]>;
  cite(ref: SourceRef, page?: number): Promise<string | undefined>;
  /** Items dropped in at [from, to): offers to turn the links into embeds or citations. */
  dropped(items: DraggedItem[], from: number, to: number): void;
  resolve(id: string): Promise<SourceRef | null>;
  open(id: string, page?: number): void;
  openItem(item: ItemLink): void;
  promptUrl(request: UrlPromptRequest): void;
  /** Stores an image file in the workspace and answers its `media/…` path; null when notes can't store files here. */
  saveImage: ((file: File) => Promise<string>) | null;
  /** A URL the editor can load for an image's `src`. */
  mediaUrl(src: string): string;
  pickMode: PickMode;
  /** query the latest finished source search was for (drives the "Searching…" row) */
  lastSourceQuery: string | null;
  /** The query whose text and meaning matches are on their way. */
  moreQuery: string | null;
  morePending: boolean;
}

export const NoteRuntimeExtension = Extension.create<{ runtime: NoteRuntime | null }>({
  name: "noteRuntime",
  addOptions() {
    return { runtime: null };
  },
});

export function getRuntime(editor: Editor): NoteRuntime | null {
  const ext = editor.extensionManager.extensions.find((e) => e.name === "noteRuntime");
  return (ext?.options as { runtime: NoteRuntime | null } | undefined)?.runtime ?? null;
}
