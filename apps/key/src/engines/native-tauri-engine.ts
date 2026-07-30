import { invoke } from '@tauri-apps/api/core';
import {
  PdfEngineFeature,
  PdfEngineOperation,
  PdfTaskHelper,
  Rotation,
  type ImageDataLike,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfFile,
  type PdfFileUrl,
  type PdfGlyphObject,
  type PdfAnnotationObject,
  type PdfBookmarkObject,
  type PdfBookmarksObject,
  type PdfMetadataObject,
  type PdfPageGeometry,
  type PdfPageObject,
  type PdfPageTextRuns,
  type PdfRenderPageOptions,
  type PdfRenderThumbnailOptions,
  type PdfSearchAllPagesOptions,
  type PdfSignatureObject,
  type PdfTextRectObject,
  type Rect,
  type SearchAllPagesResult,
  type SearchResult,
} from '@embedpdf/models';
import { taskFromPromise, unsupported } from './task';
import type {
  NativeDocumentInfo,
  NativeSearchMatch,
  NativeTextPage,
} from './types';

const documents = new Map<string, NativeDocumentInfo>();
const textPages = new Map<string, Promise<NativeTextPage>>();
let nextRenderRequestId = 1;

function textKey(id: string, page: number) {
  return `${id}:${page}`;
}

function fetchText(id: string, page: number): Promise<NativeTextPage> {
  const key = textKey(id, page);
  let pending = textPages.get(key);
  if (!pending) {
    pending = invoke<NativeTextPage>('native_text', { id, page });
    textPages.set(key, pending);
  }
  return pending;
}

function asDocument(info: NativeDocumentInfo): PdfDocumentObject {
  return {
    id: info.id,
    pageCount: info.pages.length,
    pages: info.pages.map(page => ({
      index: page.index,
      size: { width: page.width, height: page.height },
      rotation: Rotation.Degree0,
      objectNumber: 0,
    })),
    isEncrypted: false,
    isOwnerUnlocked: true,
    permissions: 0xffffffff,
    normalizedRotation: false,
  };
}

function raster(page: PdfPageObject, options?: PdfRenderPageOptions | PdfRenderThumbnailOptions) {
  const factor = Math.max(0.01, options?.scaleFactor ?? 1) * Math.max(1, options?.dpr ?? 1);
  return {
    width: Math.max(1, Math.ceil(page.size.width * factor)),
    height: Math.max(1, Math.ceil(page.size.height * factor)),
    factor,
  };
}

export function bgraToImageData(bytes: Uint8Array, width: number, height: number): ImageDataLike {
  const data = new Uint8ClampedArray(bytes.length);
  for (let index = 0; index < bytes.length; index += 4) {
    const alpha = bytes[index + 3];
    if (alpha === 0 || alpha === 255) {
      data[index] = bytes[index + 2];
      data[index + 1] = bytes[index + 1];
      data[index + 2] = bytes[index];
    } else {
      data[index] = Math.min(255, Math.round((bytes[index + 2] * 255) / alpha));
      data[index + 1] = Math.min(255, Math.round((bytes[index + 1] * 255) / alpha));
      data[index + 2] = Math.min(255, Math.round((bytes[index] * 255) / alpha));
    }
    data[index + 3] = alpha;
  }
  return { data, width, height };
}

async function imageDataToBlob(image: ImageDataLike, type = 'image/png'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable');
  context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not encode native raster'))),
      type,
    ),
  );
}

function renderRaw(
  doc: PdfDocumentObject,
  page: PdfPageObject,
  rect: Rect | undefined,
  options?: PdfRenderPageOptions,
): { promise: Promise<ImageDataLike>; cancel: () => void } {
  const { width, height, factor } = raster(page, options);
  const x = rect ? Math.max(0, Math.floor(rect.origin.x * factor)) : 0;
  const y = rect ? Math.max(0, Math.floor(rect.origin.y * factor)) : 0;
  const rectWidth = rect ? Math.max(1, Math.ceil(rect.size.width * factor)) : width;
  const rectHeight = rect ? Math.max(1, Math.ceil(rect.size.height * factor)) : height;
  const clippedWidth = Math.max(1, Math.min(rectWidth, width - Math.min(x, width - 1)));
  const clippedHeight = Math.max(1, Math.min(rectHeight, height - Math.min(y, height - 1)));
  const requestId = nextRenderRequestId++;
  const promise = invoke<ArrayBuffer>('native_render', {
    requestId,
    id: doc.id,
    page: page.index,
    width,
    height,
    x: Math.min(x, width - 1),
    y: Math.min(y, height - 1),
    rectWidth: clippedWidth,
    rectHeight: clippedHeight,
  }).then(response => {
    const bytes =
      response instanceof ArrayBuffer ? new Uint8Array(response) : new Uint8Array(response);
    return bgraToImageData(bytes, clippedWidth, clippedHeight);
  });
  return {
    promise,
    cancel: () => {
      void invoke('native_cancel_render', { requestId }).catch(() => undefined);
    },
  };
}

function renderImageTask(
  doc: PdfDocumentObject,
  page: PdfPageObject,
  rect: Rect | undefined,
  options?: PdfRenderPageOptions,
) {
  const request = renderRaw(doc, page, rect, options);
  return taskFromPromise(request.promise, request.cancel);
}

function renderBlobTask(
  doc: PdfDocumentObject,
  page: PdfPageObject,
  rect: Rect | undefined,
  options?: PdfRenderPageOptions,
) {
  const request = renderRaw(doc, page, rect, options);
  return taskFromPromise(request.promise.then(imageDataToBlob), request.cancel);
}

export function contextFromPreview(preview: string, query: string) {
  const lower = preview.toLocaleLowerCase();
  const start = lower.indexOf(query.toLocaleLowerCase());
  if (start < 0) {
    return {
      before: preview,
      match: query,
      after: '',
      truncatedLeft: false,
      truncatedRight: false,
    };
  }
  return {
    before: preview.slice(0, start),
    match: preview.slice(start, start + query.length),
    after: preview.slice(start + query.length),
    truncatedLeft: start > 0,
    truncatedRight: start + query.length < preview.length,
  };
}

function searchResult(documentId: string, match: NativeSearchMatch, query: string): SearchResult {
  const info = documents.get(documentId);
  const page = info?.pages[match.page];
  return {
    pageIndex: match.page,
    charIndex: match.start,
    charCount: match.end - match.start + 1,
    rects: match.bounds.map(bounds => ({
      origin: {
        x: bounds.left * (page?.width ?? 1),
        y: bounds.top * (page?.height ?? 1),
      },
      size: {
        width: (bounds.right - bounds.left) * (page?.width ?? 1),
        height: (bounds.bottom - bounds.top) * (page?.height ?? 1),
      },
    })),
    context: contextFromPreview(match.preview, query),
  };
}

const implemented: Partial<PdfEngine<Blob>> = {
  isSupport(feature: PdfEngineFeature) {
    const operations =
      feature === PdfEngineFeature.RenderPage ||
      feature === PdfEngineFeature.RenderPageRect ||
      feature === PdfEngineFeature.Thumbnails
        ? [PdfEngineOperation.Read]
        : [];
    return PdfTaskHelper.resolve(operations);
  },

  destroy() {
    documents.clear();
    textPages.clear();
    return PdfTaskHelper.resolve(true);
  },

  openDocumentBuffer(file: PdfFile) {
    return taskFromPromise(
      invoke<NativeDocumentInfo>('native_open_buffer', {
        id: file.id,
        bytes: Array.from(new Uint8Array(file.content)),
      }).then(info => {
        documents.set(file.id, info);
        return asDocument(info);
      }),
    );
  },

  openDocumentUrl(file: PdfFileUrl) {
    return taskFromPromise(
      fetch(file.url)
        .then(response => {
          if (!response.ok) throw new Error(`Could not fetch PDF (${response.status})`);
          return response.arrayBuffer();
        })
        .then(content => implemented.openDocumentBuffer!({ id: file.id, content }).toPromise()),
    );
  },

  getMetadata(doc: PdfDocumentObject) {
    const info = documents.get(doc.id);
    const metadata: PdfMetadataObject = {
      title: info?.title ?? null,
      author: null,
      subject: null,
      keywords: null,
      producer: null,
      creator: null,
      creationDate: null,
      modificationDate: null,
      trapped: null,
    };
    return PdfTaskHelper.resolve(metadata);
  },

  getDocPermissions() {
    return PdfTaskHelper.resolve(0xffffffff);
  },

  getDocUserPermissions() {
    return PdfTaskHelper.resolve(0xffffffff);
  },

  getSignatures() {
    return PdfTaskHelper.resolve<PdfSignatureObject[]>([]);
  },

  getBookmarks(doc: PdfDocumentObject) {
    const bookmarks =
      documents.get(doc.id)?.toc.map((entry, index) => ({
        id: String(index),
        title: entry.title,
        target: {
          pageIndex: entry.page,
          zoom: 0,
          view: [],
        },
        children: [],
      })) ?? [];
    return PdfTaskHelper.resolve<PdfBookmarksObject>({
      bookmarks: bookmarks as unknown as PdfBookmarkObject[],
    });
  },

  renderPage(doc, page, options) {
    return renderBlobTask(doc, page, undefined, options);
  },

  renderPageRect(doc, page, rect, options) {
    return renderBlobTask(doc, page, rect, options);
  },

  renderPageRaw(doc, page, options) {
    return renderImageTask(doc, page, undefined, options);
  },

  renderPageRectRaw(doc, page, rect, options) {
    return renderImageTask(doc, page, rect, options);
  },

  renderThumbnail(doc, page, options) {
    return renderBlobTask(doc, page, undefined, options);
  },

  getPageAnnotations() {
    return PdfTaskHelper.resolve<PdfAnnotationObject[]>([]);
  },

  getAllAnnotations() {
    return PdfTaskHelper.resolve({});
  },

  getPageTextRects(doc, page) {
    return taskFromPromise(
      fetchText(doc.id, page.index).then(text =>
        text.characters.flatMap<PdfTextRectObject>(character => {
          if (!character.bounds) return [];
          return [
            {
              font: { family: 'PDF', size: 12 },
              content: character.value,
              rect: {
                origin: {
                  x: character.bounds.left * page.size.width,
                  y: character.bounds.top * page.size.height,
                },
                size: {
                  width: (character.bounds.right - character.bounds.left) * page.size.width,
                  height: (character.bounds.bottom - character.bounds.top) * page.size.height,
                },
              },
            },
          ];
        }),
      ),
    );
  },

  searchAllPages(doc, keyword, _options?: PdfSearchAllPagesOptions) {
    return taskFromPromise<SearchAllPagesResult, { page: number; results: SearchResult[] }>(
      invoke<NativeSearchMatch[]>('native_search', { id: doc.id, query: keyword }).then(matches => {
        const results = matches.map(match => searchResult(doc.id, match, keyword));
        return { results, total: results.length };
      }),
    );
  },

  extractText(doc, pageIndexes) {
    return taskFromPromise(
      Promise.all(pageIndexes.map(index => fetchText(doc.id, index))).then(pages =>
        pages.map(page => page.text).join('\n'),
      ),
    );
  },

  getTextSlices(doc, slices) {
    return taskFromPromise(
      Promise.all(
        slices.map(async slice => {
          const page = await fetchText(doc.id, slice.pageIndex);
          return page.text.slice(slice.charIndex, slice.charIndex + slice.charCount);
        }),
      ),
    );
  },

  getPageGlyphs(doc, page) {
    return taskFromPromise(
      fetchText(doc.id, page.index).then(text =>
        text.characters.map<PdfGlyphObject>(character => {
          const bounds = character.bounds;
          return {
            origin: {
              x: (bounds?.left ?? 0) * page.size.width,
              y: (bounds?.top ?? 0) * page.size.height,
            },
            size: {
              width: ((bounds?.right ?? 0) - (bounds?.left ?? 0)) * page.size.width,
              height: ((bounds?.bottom ?? 0) - (bounds?.top ?? 0)) * page.size.height,
            },
            isSpace: /\s/.test(character.value),
            isEmpty: !bounds,
          };
        }),
      ),
    );
  },

  getPageGeometry(doc, page) {
    return taskFromPromise(
      fetchText(doc.id, page.index).then(text => {
        const glyphs = text.characters.map(character => {
          const bounds = character.bounds;
          return {
            x: (bounds?.left ?? 0) * page.size.width,
            y: (bounds?.top ?? 0) * page.size.height,
            width: ((bounds?.right ?? 0) - (bounds?.left ?? 0)) * page.size.width,
            height: ((bounds?.bottom ?? 0) - (bounds?.top ?? 0)) * page.size.height,
            flags: /\s/.test(character.value) ? 1 : 0,
          };
        });
        const geometry: PdfPageGeometry = {
          runs: [{ rect: { x: 0, y: 0, width: page.size.width, height: page.size.height }, charStart: 0, glyphs }],
        };
        return geometry;
      }),
    );
  },

  getPageTextRuns(doc, page) {
    return taskFromPromise(
      fetchText(doc.id, page.index).then(text => {
        const runs: PdfPageTextRuns = {
          runs: [
            {
              text: text.text,
              rect: { origin: { x: 0, y: 0 }, size: page.size },
              font: {
                name: 'PDF',
                familyName: 'PDF',
                weight: 400,
                italic: false,
                monospaced: false,
                embedded: true,
              },
              fontSize: 12,
              color: { red: 0, green: 0, blue: 0, alpha: 255 },
              charIndex: 0,
              charCount: text.characters.length,
            },
          ],
        };
        return runs;
      }),
    );
  },

  closeDocument(doc) {
    documents.delete(doc.id);
    for (const key of textPages.keys()) {
      if (key.startsWith(`${doc.id}:`)) textPages.delete(key);
    }
    return taskFromPromise(invoke<void>('native_close', { id: doc.id }).then(() => true));
  },

  closeAllDocuments() {
    const ids = [...documents.keys()];
    documents.clear();
    textPages.clear();
    return taskFromPromise(Promise.all(ids.map(id => invoke<void>('native_close', { id }))).then(() => true));
  },
};

const benignDefaults = new Map<string, unknown>([
  ['getPageAnnotationsRaw', []],
  ['getPageAnnoWidgets', []],
  ['getDocumentJavaScriptActions', []],
  ['getPageWidgetJavaScriptActions', []],
  ['getAttachments', []],
  ['getBookmarks', { bookmarks: [] }],
]);

export function createNativeTauriEngine(): PdfEngine<Blob> {
  return new Proxy(implemented as PdfEngine<Blob>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return value;
      if (typeof property !== 'string') return undefined;
      if (benignDefaults.has(property)) {
        return () => PdfTaskHelper.resolve(benignDefaults.get(property));
      }
      return () => unsupported(property);
    },
  });
}

export function nativeDocumentInfo(id: string) {
  return documents.get(id);
}
