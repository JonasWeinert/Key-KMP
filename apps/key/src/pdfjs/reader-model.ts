import { invoke } from '@tauri-apps/api/core';
import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import type {
  NativeBounds,
  NativeCompanionSnapshot,
  NativeDocumentInfo,
  NativeSearchMatch,
  NativeTextPage,
  PaperPreprocessingResult,
  SemanticDocument,
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
  anchor?: { version: 1; pages: Array<{ page: number; bounds: NativeBounds[] }> };
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
  getPage?: () => Promise<PDFPageProxy>;
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

const annotationWrites = new Map<string, Promise<void>>();

export async function loadCanonicalAnnotations(documentId: string): Promise<ReaderAnnotation[]> {
  if (!isTauri()) return loadReaderAnnotations(documentId);
  return invoke<ReaderAnnotation[]>('library_annotations', { hash: documentId });
}

export function saveCanonicalAnnotations(documentId: string, annotations: ReaderAnnotation[], deleted: string[] = []): Promise<void> {
  if (!isTauri()) { saveReaderAnnotations(documentId, annotations); return Promise.resolve(); }
  const previous = annotationWrites.get(documentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => invoke<void>('library_apply_annotations', { hash: documentId, upserts: annotations, deleted }));
  annotationWrites.set(documentId, next);
  void next.finally(() => { if (annotationWrites.get(documentId) === next) annotationWrites.delete(documentId); }).catch(() => undefined);
  return next;
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

export interface ManagedSource { hash: string; size: number; title: string }
const managedSources = new WeakMap<File, ManagedSource>();
export const managedSourceFor = (file: File) => managedSources.get(file);
export const registerManagedSource = (file: File, source: ManagedSource) => managedSources.set(file, source);

const sourceImports = new WeakMap<File, Promise<ManagedSource>>();
let activeImports = 0;
const importWaiters: Array<() => void> = [];
async function importManagedSource(file: File): Promise<ManagedSource> {
  const existing = managedSourceFor(file);
  if (existing) return existing;
  const pending = sourceImports.get(file);
  if (pending) return pending;
  const task = (async () => {
    if (activeImports >= 2) await new Promise<void>(resolve => importWaiters.push(resolve));
    else ++activeImports;
    let upload: string | undefined;
    try {
      upload = await invoke<string>('library_import_begin', { title: file.name, length: file.size });
      for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
        const chunk = new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer());
        await invoke('library_import_chunk', chunk, { headers: { 'x-key-import': upload, 'x-key-offset': String(offset) } });
      }
      const source = await invoke<ManagedSource>('library_import_finish', { id: upload });
      registerManagedSource(file, source);
      return source;
    } catch (error) {
      if (upload) await invoke('library_import_cancel', { id: upload }).catch(() => undefined);
      throw error;
    } finally {
      const next = importWaiters.shift();
      if (next) next(); else --activeImports;
    }
  })();
  sourceImports.set(file, task);
  try { return await task; } finally { sourceImports.delete(file); }
}

export async function openNativeCompanion(
  file: File,
  bytes?: Uint8Array,
  _includeText = true,
  semanticOnnx = false,
): Promise<{
  id: string;
  document?: NativeDocumentInfo;
  analysis?: PaperPreprocessingResult;
  semantic?: SemanticDocument;
}> {
  let id: string;
  let snapshot: NativeCompanionSnapshot;
  if (isTauri() && !semanticOnnx) {
    const source = await importManagedSource(file);
    id = source.hash;
    snapshot = await invoke<NativeCompanionSnapshot>('begin_pdfjs_companion_managed', { hash: id });
  } else {
    const data = bytes ?? new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer);
    id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (!isTauri()) return { id };
    snapshot = await invoke<NativeCompanionSnapshot>('begin_pdfjs_companion', { id, fileName: file.name, bytes: Array.from(data), semanticOnnx });
  }
  const legacyId = nativeDocumentId(file);
  const legacy = loadReaderAnnotations(legacyId);
  if (legacy.length) await invoke('library_import_annotations', { hash: id, legacyId, annotations: legacy });
  snapshot.document.id = id;
  if (snapshot.analysis) snapshot.analysis.document.id = id;
  if (snapshot.hasNativeText) disposableNativeText.add(id);
  else disposableNativeText.delete(id);
  disposableDocumentReferences.set(
    id,
    (disposableDocumentReferences.get(id) ?? 0) + 1,
  );
  return {
    id,
    document: snapshot.document,
    analysis: snapshot.analysis,
    semantic: snapshot.semantic,
  };
}

export function watchNativeCompanion(
  documentId: string,
  listener: (snapshot: NativeCompanionSnapshot) => void,
) {
  if (!isTauri()) return () => undefined;
  let cancelled = false;
  let timer = 0;
  let revision = -1;
  let analysisRevision: number | undefined;
  let nativeHibernated = false;
  const poll = async () => {
    try {
      const snapshot = await invoke<NativeCompanionSnapshot>(
        'pdfjs_companion_snapshot',
        { id: documentId, afterAnalysisRevision: analysisRevision },
      );
      if (cancelled) return;
      analysisRevision = snapshot.analysisRevision;
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
      if ((snapshot.stage === 'ready' || snapshot.stage === 'failed') && ['ready', 'indexed', 'failed', 'paused', 'no_text'].includes(snapshot.semanticStatus ?? 'pending')) return;
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
  styles: Record<string, { ascent?: number; descent?: number }>,
): NativeTextPage {
  const characters: NativeTextPage['characters'] = [];
  const viewport = page.getViewport({ scale: 1 });
  let text = '';
  for (const item of items) {
    if (!item.str) {
      if (item.hasEOL) { text += '\n'; characters.push({ value: '\n' }); }
      continue;
    }
    const [a, b, c, d, x, y] = item.transform;
    const baselineLength = Math.hypot(a, b) || 1;
    const upLength = Math.hypot(c, d) || baselineLength;
    const along = [a / baselineLength, b / baselineLength];
    const up = [c / upLength, d / upLength];
    const values = Array.from(item.str);
    const advance = Math.max(0, item.width) / Math.max(1, values.length);
    const style = styles[item.fontName];
    const ascent = style?.ascent ?? .8;
    const descent = style?.descent ?? -.2;
    // Compose the text axes with the viewport once per text item. The glyph
    // loop then needs only scalar arithmetic and its output bounds object.
    const [va, vb, vc, vd, ve, vf] = viewport.transform;
    const originX = va * x + vc * y + ve, originY = vb * x + vd * y + vf;
    const stepX = (va * along[0] + vc * along[1]) * advance;
    const stepY = (vb * along[0] + vd * along[1]) * advance;
    const upX = (va * up[0] + vc * up[1]) * upLength;
    const upY = (vb * up[0] + vd * up[1]) * upLength;
    const minUpX = Math.min(upX * descent, upX * ascent), maxUpX = Math.max(upX * descent, upX * ascent);
    const minUpY = Math.min(upY * descent, upY * ascent), maxUpY = Math.max(upY * descent, upY * ascent);
    for (let offset = 0; offset < values.length; offset += 1) {
      const startX = originX + stepX * offset, endX = startX + stepX;
      const startY = originY + stepY * offset, endY = startY + stepY;
      const bounds: NativeBounds = {
        left: (Math.min(startX, endX) + minUpX) / viewport.width,
        right: (Math.max(startX, endX) + maxUpX) / viewport.width,
        top: (Math.min(startY, endY) + minUpY) / viewport.height,
        bottom: (Math.max(startY, endY) + maxUpY) / viewport.height,
      };
      const value = values[offset]; text += value; characters.push({ value, bounds });
    }
    if (item.hasEOL) { text += '\n'; characters.push({ value: '\n' }); }
  }
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
  const pdfPage = host.getPage ? await host.getPage() : host.page;
  const content = await pdfPage.getTextContent();
  return pdfJsTextPage(
    pageIndex,
    pdfPage,
    content.items.filter((item): item is TextItem => 'str' in item),
    content.styles,
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

export function localMatches(
  pages: Map<number, NativeTextPage>,
  query: string,
): ReaderSearchMatch[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const output: ReaderSearchMatch[] = [];
  for (const [page, text] of [...pages].sort(([a], [b]) => a - b)) {
    const haystack = text.characters.map(character => character.value).join('');
    const lowerToCharacter: number[] = [];
    const originalOffsets = [0];
    const lowerParts: string[] = [];
    text.characters.forEach((character, index) => {
      const part = character.value.toLocaleLowerCase();
      lowerParts.push(part);
      for (let n = 0; n < part.length; n += 1) lowerToCharacter.push(index);
      originalOffsets.push(originalOffsets[index] + character.value.length);
    });
    const lower = lowerParts.join('');
    let offset = 0;
    while (output.length < 20_000) {
      const match = lower.indexOf(needle, offset);
      if (match < 0) break;
      const start = lowerToCharacter[match];
      const end = lowerToCharacter[match + needle.length - 1];
      const range = normalizeRange({ page, index: start }, { page, index: end });
      output.push({
        id: `${page}:${start}:${end}`, page, start, end,
        preview: haystack.slice(Math.max(0, originalOffsets[start] - 42), Math.min(haystack.length, originalOffsets[end + 1] + 42)),
        bounds: boundsForRange(text, range),
      });
      offset = match + needle.length;
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
