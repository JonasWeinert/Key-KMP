// Types and helpers for the workspace library (`store_*` host commands).
import type { CitableSource, Creator } from "./citation";
import type { IconName } from "./icons";

export type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>, workspaceId?: string) => Promise<T>;

export interface Source extends CitableSource {
  creators: Creator[];
  tags: string[];
  properties: Record<string, unknown>;
  collections: string[];
  starred: boolean;
  indexStatus: string;
  indexError?: string | null;
  indexedChunks: number;
  indexTotal: number;
  origin?: string | null;
  addedAt: number;
  updatedAt: number;
  trashedAt?: number | null;
  noteCount: number;
  annotationCount: number;
  shortTitle?: string;
  containerShort?: string;
  series?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  accessed?: string;
  abstract?: string;
  language?: string;
  rights?: string;
  extra?: string;
  readState?: string;
  filePath?: string;
  fileHash?: string;
  fileSize?: number;
  mime?: string;
  pageCount?: number;
  durationSeconds?: number;
}

export interface Counts {
  all: number;
  trashed: number;
  starred: number;
  unfiled: number;
  ready: number;
  indexing: number;
  attention: number;
}
export interface SourcePage {
  items: Source[];
  total: number;
  nextOffset: number | null;
  counts: Counts;
}
export interface Facet {
  value: string;
  count: number;
}
export interface Facets {
  tags: Facet[];
  itemTypes: Facet[];
  kinds: Facet[];
  years: Facet[];
}
export interface Collection {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
  sourceCount: number;
}
export interface Note {
  id: string;
  sourceId: string | null;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}
export interface Passage {
  id: string;
  page: number | null;
  startSeconds: number | null;
  snippet: string;
  text: string;
  score: number;
  /** Found by meaning only: none of the query words occur in it. */
  related?: boolean;
  /** Set when the passage is from a note rather than the document. */
  noteId?: string | null;
}
export interface FieldMatch {
  field: "creators" | "container" | "abstract" | "tags" | "notes" | "identifiers";
  snippet: string;
}
export interface SearchHit {
  sourceId: string;
  documentHash: string;
  title: string;
  score: number;
  metadataMatch: boolean;
  source?: Source;
  fields: FieldMatch[];
  passages: Passage[];
}
/** A note that belongs to no source. */
export interface NoteHit {
  noteId: string;
  /** Its title, or else its first line. */
  title: string;
  score: number;
  passages: Passage[];
}
export interface SearchResult {
  hits: SearchHit[];
  /** Standalone notes, only when nothing narrows the search. */
  notes: NoteHit[];
  semantic: boolean;
  keywordPassages: number;
  semanticPassages: number;
}
export interface IndexJob {
  id: string;
  title: string;
  kind: string;
  /** opening | reading | chunking | embedding | queued */
  stage: string;
  done: number;
  total: number;
  priority?: "visible" | "selected" | "opened" | null;
}
export interface IndexActivity {
  paused: boolean;
  reading?: IndexJob | null;
  embedding?: IndexJob | null;
  upNext: IndexJob[];
  batchDone: number;
  batchTotal: number;
  secondsPerSource?: number | null;
  vectorsPending: number;
}
export interface LibraryStatus {
  model: { state: string; received: number; total: number; error?: string | null };
  busy: boolean;
  vectors: number;
  counts: Counts;
  activity?: IndexActivity;
}

export type Theme = "system" | "light" | "dark";
export interface AppSettings {
  theme: Theme;
  onboarded: boolean;
  layoutModel: boolean;
  zoteroSync: boolean;
}
export interface AppInfo {
  version: string;
  electron: string;
  platform: string;
  userData: string;
  workspaceParent: string;
  modelDir: string;
  zoteroDir: string;
  zoteroFound: boolean;
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  root: string;
  icon?: string | null;
  color?: string | null;
}

export interface Bridge {
  appSettings(): Promise<{ settings: AppSettings; info: AppInfo }>;
  setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  workspaces(): Promise<WorkspaceSummary[]>;
  addWorkspace(): Promise<WorkspaceSummary | null>;
  tabAction(action: string, payload?: unknown): Promise<unknown>;
  addFiles(workspaceId: string, collectionId?: string): Promise<unknown[]>;
  importPaths(workspaceId: string, paths: string[], collectionId?: string): Promise<unknown[]>;
  importZotero(options?: ZoteroOptions): Promise<{ workspace: WorkspaceSummary; report: ZoteroReport }>;
  /** The workspace Zotero imports into, created on first use. */
  zoteroWorkspace(): Promise<WorkspaceSummary>;
  /** Syncs the Zotero workspace now, when sync is on. */
  syncZotero(): Promise<void>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  /** A Quick Look thumbnail as a data URL, or null when the file has none. */
  thumbnail(path: string, size?: number): Promise<string | null>;
  pathForFile(file: File): string;
  on(event: string, callback: (value: unknown) => void): () => void;
}
/** What a Zotero import brings across (key-zotero's ImportOptions). */
export interface ZoteroOptions {
  dataDir?: string;
  /** Zotero collection keys; absent for the whole library. */
  collectionKeys?: string[];
  attachments: boolean;
  notes: boolean;
  annotations: boolean;
  mirrorCollections: boolean;
}
export interface ZoteroCounts {
  items: number;
  files: number;
  notes: number;
  annotations: number;
}
export interface ZoteroPreview {
  dataDir: string;
  collections: { key: string; name: string; parentKey?: string | null; items: number; total: number }[];
  library: ZoteroCounts;
  selected: ZoteroCounts;
  unfiled: number;
}
export interface ZoteroConflict {
  title: string;
  what: string;
  detail: string;
}
export interface ZoteroReport {
  items: number;
  added: number;
  updated: number;
  unchanged: number;
  trashed: number;
  restored: number;
  keptDeleted: number;
  collections: number;
  collectionsDeleted: number;
  notes: number;
  notesUpdated: number;
  notesDeleted: number;
  annotations: number;
  linkedFiles: number;
  missingFiles: number;
  skipped: number;
  conflictCount: number;
  conflicts: ZoteroConflict[];
}
export interface ZoteroProgress {
  stage: "reading" | "items" | "notes" | "saving" | string;
  done: number;
  total: number;
}
export interface ZoteroStatus {
  options?: ZoteroOptions | null;
  at?: number | null;
  report?: ZoteroReport | null;
}

export const bridge = () => (window as unknown as { key: Bridge }).key;

export const KIND_ICON: Record<string, IconName> = {
  pdf: "doc",
  web: "globe",
  video: "video",
  audio: "audio",
  image: "image",
  file: "doc",
  reference: "quote",
  note: "note",
};
export const KIND_LABEL: Record<string, string> = {
  pdf: "PDFs",
  web: "Web",
  video: "Video",
  audio: "Audio",
  image: "Images",
  file: "Files",
  reference: "References",
};
export const ITEM_TYPES: [string, string][] = [
  ["article", "Journal article"],
  ["book", "Book"],
  ["chapter", "Book chapter"],
  ["conference-paper", "Conference paper"],
  ["report", "Report"],
  ["thesis", "Thesis"],
  ["preprint", "Preprint"],
  ["webpage", "Web page"],
  ["blog-post", "Blog post"],
  ["dataset", "Dataset"],
  ["software", "Software"],
  ["video", "Video"],
  ["audio", "Audio"],
  ["image", "Image"],
  ["magazine-article", "Magazine article"],
  ["newspaper-article", "Newspaper article"],
  ["presentation", "Presentation"],
  ["manuscript", "Manuscript"],
  ["document", "Document"],
];
export const itemTypeLabel = (type?: string) => ITEM_TYPES.find(([id]) => id === type)?.[1] ?? "Document";

export function creatorName(c: Creator) {
  return c.literal || [c.given, c.family].filter(Boolean).join(" ");
}
/** "Palma, Huseynov & Nayga" / "Palma et al." for list rows. */
export function shortCreators(creators: Creator[]) {
  const authors = creators.filter((c) => !c.role || c.role === "author");
  const list = authors.length ? authors : creators;
  const name = (c: Creator) => c.family || c.literal || c.given || "";
  if (!list.length) return "";
  if (list.length === 1) return name(list[0]);
  if (list.length === 2) return `${name(list[0])} & ${name(list[1])}`;
  return `${name(list[0])} et al.`;
}
export function formatBytes(bytes?: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
export function relativeDate(ms: number) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
}
/** `[[match]]` markers from the host become <mark> segments. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  return snippet.split(/(\[\[.*?\]\])/g).filter(Boolean).map((part) =>
    part.startsWith("[[") ? { text: part.slice(2, -2), match: true } : { text: part, match: false },
  );
}
