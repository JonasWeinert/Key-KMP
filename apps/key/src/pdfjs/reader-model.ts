import { invoke } from '@tauri-apps/api/core';
import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import type {
  NativeBounds,
  NativeCompanionSnapshot,
  NativeDocumentInfo,
  NativeSearchMatch,
  NativeTextPage,
  PaperPreprocessingResult,
} from '../engines/types';

export type HighlightColor = 'orange' | 'green' | 'blue' | 'pink' | 'purple';

export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'orange';
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  'orange',
  'green',
  'blue',
  'pink',
  'purple',
];
export const HIGHLIGHT_COLOR_RGB: Record<HighlightColor, string> = {
  orange: '255 185 60',
  green: '94 210 129',
  blue: '80 158 255',
  pink: '244 104 172',
  purple: '164 110 244',
};

export interface TextPosition {
  page: number;
  index: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface ReaderAnnotation {
  id: string;
  documentId: string;
  range: TextRange;
  text: string;
  color: HighlightColor;
  comment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationCommentDraft {
  annotationId?: string;
  documentId: string;
  range: TextRange;
  text: string;
  comment: string;
  timestamp: string;
}

export interface ReaderSearchMatch extends NativeSearchMatch {
  id: string;
}

export interface PageHost {
  page: PDFPageProxy;
  baseWidth: number;
  baseHeight: number;
  element: HTMLDivElement;
}

export interface SelectionSnapshot {
  range: TextRange;
  text: string;
  viewportRect: DOMRect;
}

// v2 deliberately discards the old PDF.js-indexed experiment annotations.
// Every range written under this key is anchored to the PDFium character
// sequence served by the native sidecar.
const ANNOTATION_STORAGE_KEY = 'key.pdfium-annotations.v2';
const LEGACY_ANNOTATION_STORAGE_KEY =
  'gpuipdf.tauri-experiment.pdfium-annotations.v2';
const disposableTextPages = new Map<string, Map<number, NativeTextPage>>();
const disposableDocumentReferences = new Map<string, number>();
const disposableNativeText = new Set<string>();

export const isTauri = () => '__TAURI_INTERNALS__' in window;

export function normalizeRange(first: TextPosition, second: TextPosition): TextRange {
  return first.page < second.page ||
    (first.page === second.page && first.index <= second.index)
    ? { start: first, end: second }
    : { start: second, end: first };
}

export function loadReaderAnnotations(documentId: string): ReaderAnnotation[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem(ANNOTATION_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_ANNOTATION_STORAGE_KEY) ??
        '[]',
    );
    if (!Array.isArray(stored)) return [];
    return stored.flatMap(annotation => {
      if (
        annotation?.documentId !== documentId ||
        !annotation?.range?.start ||
        !annotation?.range?.end
      ) {
        return [];
      }
      const color =
        annotation.color === 'yellow'
          ? DEFAULT_HIGHLIGHT_COLOR
          : HIGHLIGHT_COLORS.includes(annotation.color)
            ? annotation.color
            : DEFAULT_HIGHLIGHT_COLOR;
      return [{ ...annotation, color } as ReaderAnnotation];
    });
  } catch {
    return [];
  }
}

export function saveReaderAnnotations(
  documentId: string,
  annotations: ReaderAnnotation[],
) {
  let all: ReaderAnnotation[] = [];
  try {
    const stored = JSON.parse(
      localStorage.getItem(ANNOTATION_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_ANNOTATION_STORAGE_KEY) ??
        '[]',
    );
    if (Array.isArray(stored)) all = stored;
  } catch {
    // Replace malformed experiment data with the validated current state.
  }
  localStorage.setItem(
    ANNOTATION_STORAGE_KEY,
    JSON.stringify([
      ...all.filter(annotation => annotation?.documentId !== documentId),
      ...annotations,
    ]),
  );
}

function nativeDocumentId(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export async function openNativeCompanion(
  file: File,
  bytes: Uint8Array,
  _includeText = true,
): Promise<{
  id: string;
  document?: NativeDocumentInfo;
  analysis?: PaperPreprocessingResult;
}> {
  const id = nativeDocumentId(file);
  if (!isTauri()) return { id };
  const snapshot = await invoke<NativeCompanionSnapshot>('begin_pdfjs_companion', {
    id,
    bytes: Array.from(bytes),
  });
  snapshot.document.id = id;
  if (snapshot.analysis) snapshot.analysis.document.id = id;
  if (snapshot.hasNativeText) disposableNativeText.add(id);
  else disposableNativeText.delete(id);
  disposableDocumentReferences.set(
    id,
    (disposableDocumentReferences.get(id) ?? 0) + 1,
  );
  return { id, document: snapshot.document, analysis: snapshot.analysis };
}

export function watchNativeCompanion(
  documentId: string,
  listener: (snapshot: NativeCompanionSnapshot) => void,
) {
  if (!isTauri()) return () => undefined;
  let cancelled = false;
  let timer = 0;
  let revision = -1;
  let nativeHibernated = false;
  const poll = async () => {
    try {
      const snapshot = await invoke<NativeCompanionSnapshot>(
        'pdfjs_companion_snapshot',
        { id: documentId },
      );
      if (cancelled) return;
      snapshot.document.id = documentId;
      if (snapshot.analysis) snapshot.analysis.document.id = documentId;
      if (snapshot.hasNativeText) {
        disposableNativeText.add(documentId);
        if (!nativeHibernated) {
          nativeHibernated = true;
          void invoke('native_hibernate', { id: documentId }).catch(
            () => undefined,
          );
        }
      }
      if (snapshot.revision !== revision) {
        revision = snapshot.revision;
        listener(snapshot);
      }
      if (snapshot.stage === 'ready' || snapshot.stage === 'failed') return;
    } catch {
      if (cancelled) return;
    }
    timer = window.setTimeout(poll, 180);
  };
  void poll();
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

export async function closeNativeCompanion(documentId: string) {
  if (!isTauri()) return;
  const remaining = Math.max(
    0,
    (disposableDocumentReferences.get(documentId) ?? 1) - 1,
  );
  if (remaining === 0) {
    disposableDocumentReferences.delete(documentId);
    disposableTextPages.delete(documentId);
    disposableNativeText.delete(documentId);
    await Promise.all([
      invoke('release_disposable_document', { id: documentId }).catch(
        () => undefined,
      ),
      invoke('native_close', { id: documentId }).catch(() => undefined),
    ]);
  } else {
    disposableDocumentReferences.set(documentId, remaining);
  }
}

export function releaseNativeCompanionText(documentId: string) {
  disposableTextPages.delete(documentId);
}

export function hasNativeCompanionText(documentId: string) {
  return (
    disposableDocumentReferences.has(documentId) ||
    disposableNativeText.has(documentId) ||
    (disposableTextPages.get(documentId)?.size ?? 0) > 0
  );
}

function pdfJsTextPage(
  pageIndex: number,
  page: PDFPageProxy,
  items: TextItem[],
  baseWidth: number,
  baseHeight: number,
): NativeTextPage {
  const characters: NativeTextPage['characters'] = [];
  let text = '';
  for (const item of items) {
    if (!item.str) {
      if (item.hasEOL) {
        text += '\n';
        characters.push({ value: '\n' });
      }
      continue;
    }
    const [a, b, c, d, x, y] = item.transform;
    const horizontal = Math.abs(a) >= Math.abs(b);
    const itemWidth = Math.max(0, item.width);
    const itemHeight = Math.max(1, item.height || Math.hypot(c, d) || Math.hypot(a, b));
    const values = Array.from(item.str);
    const advance = itemWidth / Math.max(1, values.length);
    for (let offset = 0; offset < values.length; offset += 1) {
      const value = values[offset];
      let bounds: NativeBounds;
      if (horizontal) {
        const left = Math.min(x + advance * offset, x + advance * (offset + 1));
        const right = Math.max(x + advance * offset, x + advance * (offset + 1));
        bounds = {
          left: left / baseWidth,
          right: right / baseWidth,
          top: (baseHeight - y - itemHeight) / baseHeight,
          bottom: (baseHeight - y) / baseHeight,
        };
      } else {
        const top = Math.min(y + advance * offset, y + advance * (offset + 1));
        const bottom = Math.max(y + advance * offset, y + advance * (offset + 1));
        bounds = {
          left: x / baseWidth,
          right: (x + itemHeight) / baseWidth,
          top: top / baseHeight,
          bottom: bottom / baseHeight,
        };
      }
      text += value;
      characters.push({ value, bounds });
    }
    if (item.hasEOL) {
      text += '\n';
      characters.push({ value: '\n' });
    }
  }
  void page;
  return { page: pageIndex, text, characters };
}

export async function fetchTextPage(
  documentId: string,
  pageIndex: number,
  host: PageHost,
): Promise<NativeTextPage> {
  const disposable = disposableTextPages.get(documentId)?.get(pageIndex);
  if (disposable) return disposable;
  if (isTauri() && disposableNativeText.has(documentId)) {
    try {
      return await invoke<NativeTextPage>('disposable_text_page', {
        id: documentId,
        page: pageIndex,
      });
    } catch {
      // The local-analysis sidecar can become visible between the snapshot and
      // this request. The live PDFium companion remains the authoritative
      // fallback until the document closes.
    }
  }
  if (isTauri()) {
    try {
      return await invoke<NativeTextPage>('native_text', {
        id: documentId,
        page: pageIndex,
      });
    } catch {
      // Non-Tauri tests and a failed native bootstrap retain the PDF.js
      // fallback below so the document remains readable.
    }
  }
  const content = await host.page.getTextContent();
  return pdfJsTextPage(
    pageIndex,
    host.page,
    content.items.filter((item): item is TextItem => 'str' in item),
    host.baseWidth,
    host.baseHeight,
  );
}

function inRange(page: number, index: number, range: TextRange) {
  return (
    (page > range.start.page ||
      (page === range.start.page && index >= range.start.index)) &&
    (page < range.end.page || (page === range.end.page && index <= range.end.index))
  );
}

export function textForRange(pages: Map<number, NativeTextPage>, range: TextRange) {
  let output = '';
  for (let page = range.start.page; page <= range.end.page; page += 1) {
    const text = pages.get(page);
    if (!text) continue;
    if (output) output += '\n\n';
    output += text.characters
      .filter((_, index) => inRange(page, index, range))
      .map(character => character.value)
      .join('');
  }
  return output;
}

export function boundsForRange(
  text: NativeTextPage,
  range: TextRange,
): NativeBounds[] {
  const glyphs = text.characters
    .map((character, index) => ({ character, index }))
    .filter(({ character, index }) => character.bounds && inRange(text.page, index, range))
    .map(({ character }) => character.bounds!);
  return harmonizeBounds(glyphs);
}

export function harmonizeBounds(bounds: NativeBounds[]): NativeBounds[] {
  const ordered = bounds
    .filter(
      bound =>
        Number.isFinite(bound.left) &&
        Number.isFinite(bound.right) &&
        Number.isFinite(bound.top) &&
        Number.isFinite(bound.bottom),
    )
    .sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: NativeBounds[][] = [];
  for (const glyph of ordered) {
    const height = Math.max(0.001, glyph.bottom - glyph.top);
    const center = (glyph.top + glyph.bottom) / 2;
    const line = lines.find(candidate => {
      const candidateCenter =
        candidate.reduce(
          (total, item) => total + (item.top + item.bottom) / 2,
          0,
        ) / candidate.length;
      const candidateHeight =
        candidate.reduce(
          (total, item) => total + item.bottom - item.top,
          0,
        ) / candidate.length;
      return (
        Math.abs(candidateCenter - center) <=
        Math.max(height, candidateHeight) * 0.55
      );
    });
    if (line) line.push(glyph);
    else lines.push([glyph]);
  }

  const output: NativeBounds[] = [];
  for (const line of lines) {
    line.sort((left, right) => left.left - right.left);
    const tops = line.map(bound => bound.top).sort((a, b) => a - b);
    const bottoms = line.map(bound => bound.bottom).sort((a, b) => a - b);
    const top = tops[Math.floor(tops.length / 2)]!;
    const bottom = bottoms[Math.floor(bottoms.length / 2)]!;
    const height = Math.max(0.001, bottom - top);
    const widths = line
      .map(bound => bound.right - bound.left)
      .filter(width => width > 0)
      .sort((a, b) => a - b);
    const glyphWidth = widths[Math.floor(widths.length / 2)] ?? 0.006;
    const mergeGap = Math.max(0.01, glyphWidth * 2.4);
    for (const bound of line) {
      const previous = output.at(-1);
      if (
        previous &&
        Math.abs(previous.top - top) <= height * 0.2 &&
        bound.left <= previous.right + mergeGap
      ) {
        previous.right = Math.max(previous.right, bound.right);
      } else {
        const verticalPadding = height * 0.04;
        output.push({
          left: bound.left,
          right: bound.right,
          top: top - verticalPadding,
          bottom: bottom + verticalPadding,
        });
      }
    }
  }
  return output;
}

function localMatches(
  pages: Map<number, NativeTextPage>,
  query: string,
): ReaderSearchMatch[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const output: ReaderSearchMatch[] = [];
  for (const [page, text] of [...pages].sort(([a], [b]) => a - b)) {
    const haystack = text.characters.map(character => character.value).join('');
    const lower = haystack.toLocaleLowerCase();
    let offset = 0;
    while (output.length < 20_000) {
      const start = lower.indexOf(needle, offset);
      if (start < 0) break;
      const end = start + Array.from(query).length - 1;
      const range = normalizeRange({ page, index: start }, { page, index: end });
      output.push({
        id: `${page}:${start}:${end}`,
        page,
        start,
        end,
        preview: haystack.slice(Math.max(0, start - 42), Math.min(haystack.length, end + 43)),
        bounds: boundsForRange(text, range),
      });
      offset = Math.max(start + 1, end + 1);
    }
  }
  return output;
}

export async function searchReaderDocument(
  documentId: string,
  query: string,
  pages: Map<number, NativeTextPage>,
): Promise<ReaderSearchMatch[]> {
  const disposable = disposableTextPages.get(documentId);
  if (disposable?.size) return localMatches(disposable, query);
  if (isTauri() && disposableNativeText.has(documentId)) {
    try {
      const matches = await invoke<NativeSearchMatch[]>('disposable_search', {
        id: documentId,
        query,
      });
      return matches.map(match => ({
        ...match,
        bounds: harmonizeBounds(match.bounds),
        id: `${match.page}:${match.start}:${match.end}`,
      }));
    } catch {
      // Fall through to the live PDFium document while the sidecar is being
      // installed or if the staged cache was evicted.
    }
  }
  if (isTauri()) {
    try {
      const matches = await invoke<NativeSearchMatch[]>('native_search', {
        id: documentId,
        query,
      });
      return matches.map(match => ({
        ...match,
        bounds: harmonizeBounds(match.bounds),
        id: `${match.page}:${match.start}:${match.end}`,
      }));
    } catch {
      return localMatches(pages, query);
    }
  }
  return localMatches(pages, query);
}

export function annotationId() {
  return globalThis.crypto?.randomUUID?.() ?? `annotation-${Date.now()}-${Math.random()}`;
}

export function upsertAnnotationComment(
  annotations: ReaderAnnotation[],
  draft: AnnotationCommentDraft,
): ReaderAnnotation[] {
  const existing = draft.annotationId
    ? annotations.find(annotation => annotation.id === draft.annotationId)
    : annotations.find(
        annotation =>
          annotation.range.start.page === draft.range.start.page &&
          annotation.range.start.index === draft.range.start.index &&
          annotation.range.end.page === draft.range.end.page &&
          annotation.range.end.index === draft.range.end.index,
      );
  const updated: ReaderAnnotation = existing
    ? {
        ...existing,
        comment: draft.comment,
        updatedAt: draft.timestamp,
      }
    : {
        id: annotationId(),
        documentId: draft.documentId,
        range: draft.range,
        text: draft.text,
        color: DEFAULT_HIGHLIGHT_COLOR,
        comment: draft.comment,
        createdAt: draft.timestamp,
        updatedAt: draft.timestamp,
      };
  return [
    ...annotations.filter(annotation => annotation.id !== updated.id),
    updated,
  ];
}
