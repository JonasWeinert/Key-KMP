export interface SourceRef {
  id: string;
  title: string;
  detail?: string;
  kind?: string;
  page?: number;
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
  placeholder?: string;
  autoFocus?: boolean;
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
