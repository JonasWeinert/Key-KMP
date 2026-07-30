import {
  forwardRef,
  type ComponentPropsWithoutRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {
  NativeBounds,
  NativeLink,
  PaperPreprocessingResult,
  ScholarlyMetadata,
  ScientificCitation,
  ScientificReference,
} from '../engines/types';
import { Icon } from '../ui/Icon';
import { MarkdownEditor } from '../ui/MarkdownEditor';
import { EmptyState, IconButton, PanelShell } from '../ui/primitives';
import {
  annotationId,
  boundsForRange,
  closeNativeCompanion,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_RGB,
  hasNativeCompanionText,
  isTauri,
  loadReaderAnnotations,
  openNativeCompanion,
  releaseNativeCompanionText,
  saveReaderAnnotations,
  searchReaderDocument,
  upsertAnnotationComment,
  watchNativeCompanion,
  type HighlightColor,
  type ReaderAnnotation,
  type ReaderSearchMatch,
  type SelectionSnapshot,
  type TextRange,
} from './reader-model';
import { PdfJsTextOverlayManager } from './text-overlays';
import { readerHorizontalGeometry } from './reader-layout';
import {
  preprocessedScholarlyEntries,
  type ScholarlyEntry,
} from './scholarly-metadata';
import {
  citationAuthorsSnippet,
  citationBibliographyLine,
  citationLinks,
  citationSummary,
  citationTabLabel,
  isScholarlyResourceUrl,
} from './citation-details';
import {
  HoverCardBridge,
  anchoredFloatingCardPosition,
} from './floating-card';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Safari/WebKit versions used by current Tauri builds expose ReadableStream
// but not its async-iterator protocol. PDF.js getTextContent() consumes its
// worker stream with `for await`, so provide the standards-compatible bridge
// until the host WebKit implements it natively.
const readableStreamPrototype = globalThis.ReadableStream?.prototype as
  | (ReadableStream & {
      [Symbol.asyncIterator]?: () => AsyncGenerator<unknown, void, unknown>;
    })
  | undefined;
if (readableStreamPrototype && !readableStreamPrototype[Symbol.asyncIterator]) {
  Object.defineProperty(readableStreamPrototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (this: ReadableStream<unknown>) {
      const reader = this.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

const TILE_PHYSICAL_PX = 512;
const MAX_RENDER_BYTES = 96 * 1024 * 1024;
const MAX_FALLBACK_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_RENDERS = 2;
const PAGE_GAP_CSS_PX = 16;
const PAGE_PADDING_CSS_PX = 24;
/** Matches the `top/right/bottom` inset of `.key-panel-shell` in styles.css. */
const PANEL_EDGE_GAP = 10;
let pdfJsDestructionBarrier: Promise<void> = Promise.resolve();

interface PageState {
  index: number;
  page: PDFPageProxy;
  baseWidth: number;
  baseHeight: number;
  top: number;
  width: number;
  height: number;
  element: HTMLDivElement;
  fallbackCanvas?: HTMLCanvasElement;
  fallbackLastUsed: number;
}

interface TileSpec {
  key: string;
  pageIndex: number;
  rasterWidth: number;
  rasterHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  distance: number;
}

interface TileRecord extends TileSpec {
  canvas: HTMLCanvasElement;
  bytes: number;
  lastUsed: number;
}

interface PendingTile {
  task: RenderTask;
  revision: number;
}

interface SettleResult {
  durationMs: number;
  timedOut: boolean;
}

export interface PdfJsViewState {
  zoom: number;
  pageIndex: number;
  pageOffsetFraction: number;
  horizontalFraction: number;
}

export interface PdfJsPreview {
  pageIndex: number;
  dataUrl: string;
}

interface FrameSummary {
  median: number;
  p95: number;
  maximum: number;
  framesOver20Ms: number;
}

export interface PdfJsBenchmarkResult {
  schemaVersion: 1;
  renderer: 'pdfjs-canvas-tiles';
  userAgent: string;
  startedAt: string;
  pageCount: number;
  sourceBytes: number;
  loadMs: number;
  featureSetupMs: number;
  interactionMs: number;
  frameIntervals: FrameSummary;
  exactRenderSettleMs: {
    median: number;
    p95: number;
    maximum: number;
    timeouts: number;
  };
  cache: {
    budgetBytes: number;
    residentBytes: number;
    residentTiles: number;
    peakResidentBytes: number;
    peakResidentTiles: number;
    fallbackBytes: number;
    fallbackBudgetBytes: number;
  };
  scenario: {
    scrollJumps: 8;
    zoomChanges: 6;
  };
}

declare global {
  interface Window {
    __PDFJS_READY__?: boolean;
    __PDFJS_ERROR__?: string;
    __PDFJS_BENCHMARK_RESULT__?: PdfJsBenchmarkResult;
    __PDFJS_FEATURES_READY__?: boolean;
  }
}

const nextFrames = (count: number) =>
  new Promise<void>(resolve => {
    const tick = () => {
      count -= 1;
      if (count <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

export class PdfJsTileController {
  private readonly scroll: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly document: PDFDocumentProxy;
  private readonly pages: PageState[];
  private readonly dpr: number;
  private readonly configuredRenderBytes: number;
  private maxRenderBytes: number;
  private readonly cache = new Map<string, TileRecord>();
  private readonly pending = new Map<string, PendingTile>();
  private readonly fallbackTasks = new Map<number, RenderTask>();
  private readonly fallbackKeys = new Set<string>();
  private desiredVisible = new Set<string>();
  private desiredAll = new Set<string>();
  private queue: TileSpec[] = [];
  private revision = 0;
  private zoom = 1;
  private fitScale = 1;
  private residentBytes = 0;
  private peakResidentBytes = 0;
  private peakResidentTiles = 0;
  private fallbackBytes = 0;
  private currentVisiblePages = new Set<number>();
  private scrollFrame = 0;
  private resizeFrame = 0;
  private wheelZoomTimer = 0;
  private wheelZoomTarget: number | null = null;
  private wheelZoomAnchor: { clientX: number; clientY: number } | null = null;
  /** Width a floating panel currently covers on the trailing edge. */
  private panelInset = 0;
  private destroyed = false;
  private suspended = false;
  private activeRenders = 0;
  private visiblePagesListener?: (pages: number[]) => void;
  private zoomListener?: (zoom: number) => void;
  private viewStateListener?: (state: PdfJsViewState) => void;
  private previewListener?: (preview: PdfJsPreview) => void;
  private readonly resizeObserver?: ResizeObserver;
  private gestureStart:
    | { distance: number; zoom: number; clientX: number; clientY: number }
    | undefined;
  private panStart:
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        scrollLeft: number;
        scrollTop: number;
      }
    | undefined;

  constructor(
    scroll: HTMLDivElement,
    content: HTMLDivElement,
    document: PDFDocumentProxy,
    sourcePages: Array<{ page: PDFPageProxy; width: number; height: number }>,
    maxRenderBytes = MAX_RENDER_BYTES,
  ) {
    this.scroll = scroll;
    this.content = content;
    this.document = document;
    this.configuredRenderBytes = maxRenderBytes;
    this.maxRenderBytes = maxRenderBytes;
    this.dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    this.pages = sourcePages.map(({ page, width, height }, pageIndex) => {
      const element = documentElement('div', 'pdfjs-page');
      element.dataset.pageIndex = String(pageIndex);
      this.content.append(element);
      return {
        index: pageIndex,
        page,
        baseWidth: width,
        baseHeight: height,
        top: 0,
        width: width,
        height: height,
        element,
        fallbackLastUsed: 0,
      };
    });
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroll.addEventListener('wheel', this.onWheel, { passive: false });
    this.scroll.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.scroll.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.scroll.addEventListener('touchend', this.onTouchEnd, { passive: true });
    this.scroll.addEventListener('pointerdown', this.onPointerDown);
    this.scroll.addEventListener('pointermove', this.onPointerMove);
    this.scroll.addEventListener('pointerup', this.onPointerEnd);
    this.scroll.addEventListener('pointercancel', this.onPointerEnd);
    this.updateLayout();
    this.replaceDemand();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.destroyed || this.resizeFrame) return;
        const state = this.currentViewState();
        this.resizeFrame = requestAnimationFrame(() => {
          this.resizeFrame = 0;
          if (this.destroyed) return;
          this.updateLayout();
          this.restoreViewState(state);
        });
      });
      this.resizeObserver.observe(this.scroll);
    }
  }

  pageCount() {
    return this.pages.length;
  }

  pageHosts() {
    return this.pages;
  }

  currentZoom() {
    return this.zoom;
  }

  setPanelInset(inset: number) {
    const normalized = Math.max(0, Math.ceil(inset));
    if (normalized === this.panelInset) return;
    this.panelInset = normalized;
    this.updateLayout();
    this.replaceDemand();
  }

  fitWidth() {
    this.setZoom(1);
  }

  actualSize() {
    this.setZoom(1 / Math.max(0.05, this.fitScale));
  }

  onVisiblePages(listener: (pages: number[]) => void) {
    this.visiblePagesListener = listener;
    this.replaceDemand();
  }

  onZoomChange(listener: (zoom: number) => void) {
    this.zoomListener = listener;
  }

  onViewStateChange(listener: (state: PdfJsViewState) => void) {
    this.viewStateListener = listener;
    listener(this.currentViewState());
  }

  onPreviewChange(listener: (preview: PdfJsPreview) => void) {
    this.previewListener = listener;
    const visiblePage = [...this.currentVisiblePages][0];
    const canvas =
      this.pages[visiblePage]?.fallbackCanvas ??
      this.pages.find(page => page.fallbackCanvas)?.fallbackCanvas;
    if (canvas) {
      listener({
        pageIndex: visiblePage ?? 0,
        dataUrl: canvas.toDataURL('image/jpeg', 0.72),
      });
    }
  }

  currentViewState(): PdfJsViewState {
    const anchorY = this.scroll.scrollTop + this.scroll.clientHeight * 0.32;
    const page =
      this.pages.find(
        candidate =>
          anchorY >= candidate.top && anchorY <= candidate.top + candidate.height,
      ) ??
      this.pages.reduce(
        (nearest, candidate) =>
          Math.abs(candidate.top - anchorY) < Math.abs(nearest.top - anchorY)
            ? candidate
            : nearest,
        this.pages[0],
      );
    const horizontalMaximum = Math.max(
      0,
      this.content.scrollWidth - this.scroll.clientWidth,
    );
    return {
      zoom: this.zoom,
      pageIndex: page?.index ?? 0,
      pageOffsetFraction: page
        ? Math.min(1, Math.max(0, (anchorY - page.top) / Math.max(1, page.height)))
        : 0,
      horizontalFraction:
        horizontalMaximum > 0 ? this.scroll.scrollLeft / horizontalMaximum : 0,
    };
  }

  restoreViewState(state: PdfJsViewState) {
    this.setZoom(state.zoom);
    const page = this.pages[Math.min(this.pages.length - 1, Math.max(0, state.pageIndex))];
    if (page) {
      this.scroll.scrollTop = Math.max(
        0,
        page.top +
          Math.min(1, Math.max(0, state.pageOffsetFraction)) * page.height -
          this.scroll.clientHeight * 0.32,
      );
    }
    const horizontalMaximum = Math.max(
      0,
      this.content.scrollWidth - this.scroll.clientWidth,
    );
    this.scroll.scrollLeft =
      horizontalMaximum * Math.min(1, Math.max(0, state.horizontalFraction));
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  scrollToFraction(fraction: number) {
    const maximum = Math.max(0, this.content.scrollHeight - this.scroll.clientHeight);
    this.scroll.scrollTop = maximum * Math.min(1, Math.max(0, fraction));
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  scrollByPixels(left: number, top: number) {
    this.scroll.scrollBy({ left, top, behavior: 'instant' });
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  currentScrollFraction() {
    const maximum = Math.max(0, this.content.scrollHeight - this.scroll.clientHeight);
    return maximum > 0 ? this.scroll.scrollTop / maximum : 0;
  }

  setZoom(nextZoom: number, clientX?: number, clientY?: number) {
    if (this.wheelZoomTimer) {
      window.clearTimeout(this.wheelZoomTimer);
      this.wheelZoomTimer = 0;
    }
    this.wheelZoomTarget = null;
    this.wheelZoomAnchor = null;
    this.content.style.transform = '';
    this.content.style.transformOrigin = '';
    const clamped = Math.min(5, Math.max(0.2, nextZoom));
    if (Math.abs(clamped - this.zoom) < 0.0001) return;
    const scrollRect = this.scroll.getBoundingClientRect();
    const localX =
      clientX === undefined ? this.scroll.clientWidth / 2 : clientX - scrollRect.left;
    const localY =
      clientY === undefined ? this.scroll.clientHeight / 2 : clientY - scrollRect.top;
    const anchorX = this.scroll.scrollLeft + localX;
    const anchorY = this.scroll.scrollTop + localY;
    const anchorPage = this.pages.find(
      page => anchorY >= page.top && anchorY <= page.top + page.height,
    );
    const normalizedX = anchorPage
      ? (anchorX - anchorPage.element.offsetLeft) / anchorPage.width
      : 0.5;
    const normalizedY = anchorPage ? (anchorY - anchorPage.top) / anchorPage.height : 0.5;
    const anchorIndex = anchorPage ? this.pages.indexOf(anchorPage) : 0;

    // Preserve the last complete raster grid while a pinch gesture creates a
    // stream of intermediate scales. Those canvases scale softly with their
    // page instead of exposing the white page background between new tiles.
    if (
      this.desiredVisible.size > 0 &&
      [...this.desiredVisible].every(key => this.cache.has(key))
    ) {
      this.fallbackKeys.clear();
      const visiblePages = new Set(
        [...this.desiredVisible]
          .map(key => Number(key.split(':')[0]))
          .filter(Number.isInteger),
      );
      for (const [key, record] of this.cache) {
        if (visiblePages.has(record.pageIndex)) this.fallbackKeys.add(key);
      }
    }
    this.zoom = clamped;
    this.zoomListener?.(this.zoom);
    this.revision += 1;
    this.cancelPending();
    this.updateLayout();

    const restored = this.pages[anchorIndex];
    if (restored) {
      const pageLeft = restored.element.offsetLeft;
      this.scroll.scrollLeft =
        pageLeft + normalizedX * restored.width - localX;
      this.scroll.scrollTop =
        restored.top + normalizedY * restored.height - localY;
    }
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  scrollToBounds(pageIndex: number, bounds?: NativeBounds) {
    const page = this.pages[pageIndex];
    if (!page) return;
    const targetY = page.top + (bounds?.top ?? 0) * page.height;
    const targetX =
      page.element.offsetLeft + (bounds?.left ?? 0.5) * page.width;
    this.scroll.scrollTo({
      top: Math.max(0, targetY - this.scroll.clientHeight * 0.32),
      left: Math.max(0, targetX - this.scroll.clientWidth / 2),
      behavior: 'instant',
    });
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  centerOnBounds(pageIndex: number, bounds?: NativeBounds) {
    const page = this.pages[pageIndex];
    if (!page) return;
    const targetY =
      page.top + ((bounds?.top ?? 0.5) + (bounds?.bottom ?? 0.5)) / 2 * page.height;
    const targetX =
      page.element.offsetLeft +
      ((bounds?.left ?? 0.5) + (bounds?.right ?? 0.5)) / 2 * page.width;
    this.scroll.scrollTo({
      top: Math.max(0, targetY - this.scroll.clientHeight / 2),
      left: Math.max(0, targetX - this.scroll.clientWidth / 2),
      behavior: 'smooth',
    });
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  }

  async waitForExact(timeoutMs = 5000): Promise<SettleResult> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (
        this.desiredVisible.size > 0 &&
        [...this.desiredVisible].every(key => this.cache.has(key))
      ) {
        return { durationMs: performance.now() - start, timedOut: false };
      }
      await nextFrames(1);
    }
    return { durationMs: timeoutMs, timedOut: true };
  }

  cacheMetrics() {
    return {
      budgetBytes: this.maxRenderBytes,
      residentBytes: this.residentBytes,
      residentTiles: this.cache.size,
      peakResidentBytes: this.peakResidentBytes,
      peakResidentTiles: this.peakResidentTiles,
      fallbackBytes: this.fallbackBytes,
      fallbackBudgetBytes: MAX_FALLBACK_BYTES,
      suspended: this.suspended,
    };
  }

  suspendRaster(keepFallback: boolean) {
    this.suspended = true;
    this.revision += 1;
    this.cancelPending();
    for (const task of this.fallbackTasks.values()) task.cancel();
    this.fallbackKeys.clear();
    this.desiredVisible.clear();
    this.desiredAll.clear();
    for (const [key, record] of [...this.cache]) {
      this.cache.delete(key);
      this.release(record);
    }
    if (!keepFallback) {
      for (const page of this.pages) this.releaseFallback(page);
    }
    // Releasing canvases alone is not enough: PDF.js retains decoded image,
    // font, and operator-list resources on every page proxy. A parsed-warm
    // document keeps its document/xref state, text and app layers, but lets
    // those renderer-only resources go. PDF.js will lazily reconstruct them
    // if this reader is promoted again.
    void this.document.cleanup(false).catch(() => undefined);
  }

  resumeRaster() {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.updateLayout();
    this.replaceDemand();
  }

  async destroy() {
    this.destroyed = true;
    this.scroll.removeEventListener('scroll', this.onScroll);
    this.scroll.removeEventListener('wheel', this.onWheel);
    this.scroll.removeEventListener('touchstart', this.onTouchStart);
    this.scroll.removeEventListener('touchmove', this.onTouchMove);
    this.scroll.removeEventListener('touchend', this.onTouchEnd);
    this.scroll.removeEventListener('pointerdown', this.onPointerDown);
    this.scroll.removeEventListener('pointermove', this.onPointerMove);
    this.scroll.removeEventListener('pointerup', this.onPointerEnd);
    this.scroll.removeEventListener('pointercancel', this.onPointerEnd);
    this.resizeObserver?.disconnect();
    if (this.wheelZoomTimer) window.clearTimeout(this.wheelZoomTimer);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.cancelPending();
    for (const task of this.fallbackTasks.values()) task.cancel();
    this.fallbackTasks.clear();
    this.fallbackKeys.clear();
    for (const record of this.cache.values()) this.release(record);
    this.cache.clear();
    for (const page of this.pages) this.releaseFallback(page);
    this.content.replaceChildren();
    await this.document.loadingTask.destroy();
  }

  private readonly onScroll = () => {
    // Capture navigation state while the pane is still attached. React runs
    // passive unmount cleanup after removing the old DOM, at which point
    // WebKit reports scrollTop as zero.
    this.viewStateListener?.(this.currentViewState());
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.replaceDemand();
    });
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const currentTarget = this.wheelZoomTarget ?? this.zoom;
    const target = Math.min(
      5,
      Math.max(0.2, currentTarget * Math.exp(-event.deltaY * 0.012)),
    );
    this.wheelZoomTarget = target;
    this.wheelZoomAnchor = { clientX: event.clientX, clientY: event.clientY };
    const scrollRect = this.scroll.getBoundingClientRect();
    const localX = this.scroll.scrollLeft + event.clientX - scrollRect.left;
    const localY = this.scroll.scrollTop + event.clientY - scrollRect.top;
    this.content.style.transformOrigin = `${localX}px ${localY}px`;
    this.content.style.transform = `scale(${target / this.zoom})`;
    if (this.wheelZoomTimer) window.clearTimeout(this.wheelZoomTimer);
    this.wheelZoomTimer = window.setTimeout(() => {
      this.wheelZoomTimer = 0;
      const committed = this.wheelZoomTarget;
      const anchor = this.wheelZoomAnchor;
      if (committed === null || !anchor) return;
      this.setZoom(committed, anchor.clientX, anchor.clientY);
    }, 120);
  };

  private readonly onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    const [first, second] = [event.touches[0], event.touches[1]];
    this.gestureStart = {
      distance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
      zoom: this.zoom,
      clientX: (first.clientX + second.clientX) / 2,
      clientY: (first.clientY + second.clientY) / 2,
    };
    event.preventDefault();
  };

  private readonly onTouchMove = (event: TouchEvent) => {
    if (!this.gestureStart || event.touches.length !== 2) return;
    const [first, second] = [event.touches[0], event.touches[1]];
    const distance = Math.hypot(
      first.clientX - second.clientX,
      first.clientY - second.clientY,
    );
    const clientX = (first.clientX + second.clientX) / 2;
    const clientY = (first.clientY + second.clientY) / 2;
    this.setZoom(
      this.gestureStart.zoom * (distance / Math.max(1, this.gestureStart.distance)),
      clientX,
      clientY,
    );
    event.preventDefault();
  };

  private readonly onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) this.gestureStart = undefined;
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    this.panStart = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: this.scroll.scrollLeft,
      scrollTop: this.scroll.scrollTop,
    };
    this.scroll.setPointerCapture(event.pointerId);
    this.scroll.classList.add('panning');
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.panStart || event.pointerId !== this.panStart.pointerId) return;
    event.preventDefault();
    this.scroll.scrollLeft =
      this.panStart.scrollLeft - (event.clientX - this.panStart.clientX);
    this.scroll.scrollTop =
      this.panStart.scrollTop - (event.clientY - this.panStart.clientY);
  };

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (!this.panStart || event.pointerId !== this.panStart.pointerId) return;
    this.panStart = undefined;
    if (this.scroll.hasPointerCapture(event.pointerId)) {
      this.scroll.releasePointerCapture(event.pointerId);
    }
    this.scroll.classList.remove('panning');
    this.replaceDemand();
    this.viewStateListener?.(this.currentViewState());
  };

  /**
   * Bytes needed to hold everything currently on screen plus the one-tile
   * overscan ring `replaceDemand` asks for. A retained reader whose budget is
   * below this can never keep its own visible set — it evicts tiles it is
   * about to be asked for again, so switching back to it is never warm.
   */
  private viewportTileBytes() {
    const columns = Math.ceil((this.scroll.clientWidth * this.dpr) / TILE_PHYSICAL_PX) + 2;
    const rows = Math.ceil((this.scroll.clientHeight * this.dpr) / TILE_PHYSICAL_PX) + 2;
    return columns * rows * TILE_PHYSICAL_PX * TILE_PHYSICAL_PX * 4;
  }

  private updateLayout() {
    // The budget follows the window: a fixed constant is either wasteful on a
    // small window or below the visible set on a large one.
    this.maxRenderBytes = Math.max(this.configuredRenderBytes, this.viewportTileBytes());
    const widest = Math.max(1, ...this.pages.map(page => page.baseWidth));
    this.fitScale = Math.max(
      0.05,
      (this.scroll.clientWidth - PAGE_PADDING_CSS_PX * 2) / widest,
    );
    const scale = this.fitScale * this.zoom;
    const geometry = readerHorizontalGeometry(
      this.scroll.clientWidth,
      widest * scale,
      PAGE_PADDING_CSS_PX,
      this.panelInset,
    );
    const baseContentWidth = geometry.baseContentWidth;
    let top = PAGE_PADDING_CSS_PX;
    for (const page of this.pages) {
      page.width = page.baseWidth * scale;
      page.height = page.baseHeight * scale;
      page.top = top;
      page.element.style.width = `${page.width}px`;
      page.element.style.height = `${page.height}px`;
      page.element.style.setProperty('--page-height', `${page.height}px`);
      page.element.style.top = `${top}px`;
      page.element.style.left = `${geometry.pageLeft(page.width)}px`;
      top += page.height + PAGE_GAP_CSS_PX;
    }
    this.content.style.height = `${Math.max(this.scroll.clientHeight, top + PAGE_PADDING_CSS_PX)}px`;
    this.content.style.minWidth = `${geometry.contentWidth}px`;
  }

  private replaceDemand() {
    if (this.destroyed || this.suspended || this.pages.length === 0) return;
    // Low-resolution backings are background work. If the user moves, tiles win.
    for (const task of this.fallbackTasks.values()) task.cancel();
    this.revision += 1;
    const revision = this.revision;
    const viewportTop = this.scroll.scrollTop;
    const viewportBottom = viewportTop + this.scroll.clientHeight;
    const viewportLeft = this.scroll.scrollLeft;
    const viewportRight = viewportLeft + this.scroll.clientWidth;
    const specs: TileSpec[] = [];

    for (let pageIndex = 0; pageIndex < this.pages.length; pageIndex += 1) {
      const page = this.pages[pageIndex];
      const pageLeft = page.element.offsetLeft;
      const overscanCss = TILE_PHYSICAL_PX / this.dpr;
      const left = Math.max(pageLeft, viewportLeft - overscanCss);
      const right = Math.min(pageLeft + page.width, viewportRight + overscanCss);
      const top = Math.max(page.top, viewportTop - overscanCss);
      const bottom = Math.min(page.top + page.height, viewportBottom + overscanCss);
      if (left >= right || top >= bottom) continue;

      const rasterWidth = Math.max(1, Math.ceil(page.width * this.dpr));
      const rasterHeight = Math.max(1, Math.ceil(page.height * this.dpr));
      const firstColumn = Math.max(
        0,
        Math.floor(((left - pageLeft) * this.dpr) / TILE_PHYSICAL_PX),
      );
      const lastColumn = Math.min(
        Math.ceil(rasterWidth / TILE_PHYSICAL_PX) - 1,
        Math.floor((((right - pageLeft) * this.dpr) - 1) / TILE_PHYSICAL_PX),
      );
      const firstRow = Math.max(
        0,
        Math.floor(((top - page.top) * this.dpr) / TILE_PHYSICAL_PX),
      );
      const lastRow = Math.min(
        Math.ceil(rasterHeight / TILE_PHYSICAL_PX) - 1,
        Math.floor((((bottom - page.top) * this.dpr) - 1) / TILE_PHYSICAL_PX),
      );

      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const x = column * TILE_PHYSICAL_PX;
          const y = row * TILE_PHYSICAL_PX;
          const width = Math.min(TILE_PHYSICAL_PX, rasterWidth - x);
          const height = Math.min(TILE_PHYSICAL_PX, rasterHeight - y);
          const tileLeft = pageLeft + x / this.dpr;
          const tileTop = page.top + y / this.dpr;
          const tileRight = tileLeft + width / this.dpr;
          const tileBottom = tileTop + height / this.dpr;
          const visible =
            tileRight > viewportLeft &&
            tileLeft < viewportRight &&
            tileBottom > viewportTop &&
            tileTop < viewportBottom;
          const centerX = tileLeft + width / this.dpr / 2;
          const centerY = tileTop + height / this.dpr / 2;
          const key = `${pageIndex}:${rasterWidth}x${rasterHeight}:${column}:${row}`;
          specs.push({
            key,
            pageIndex,
            rasterWidth,
            rasterHeight,
            x,
            y,
            width,
            height,
            visible,
            distance:
              (centerX - (viewportLeft + this.scroll.clientWidth / 2)) ** 2 +
              (centerY - (viewportTop + this.scroll.clientHeight / 2)) ** 2,
          });
        }
      }
    }

    specs.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
    this.desiredVisible = new Set(specs.filter(spec => spec.visible).map(spec => spec.key));
    this.desiredAll = new Set(specs.map(spec => spec.key));
    const visiblePages = [
      ...new Set(specs.filter(spec => spec.visible).map(spec => spec.pageIndex)),
    ];
    this.currentVisiblePages = new Set(visiblePages);
    const fallbackNow = performance.now();
    for (const pageIndex of visiblePages) {
      this.pages[pageIndex].fallbackLastUsed = fallbackNow;
    }
    this.visiblePagesListener?.(visiblePages);
    for (const [key, pending] of this.pending) {
      if (!this.desiredAll.has(key)) {
        pending.task.cancel();
        this.pending.delete(key);
      }
    }
    const now = performance.now();
    for (const spec of specs) {
      const cached = this.cache.get(spec.key);
      if (cached) cached.lastUsed = now;
    }
    this.queue = specs.filter(spec => !this.cache.has(spec.key) && !this.pending.has(spec.key));
    this.evict();
    this.pump(revision);
    this.warmFallbackWhenIdle();
  }

  private pump(revision: number) {
    while (
      !this.destroyed &&
      !this.suspended &&
      this.activeRenders < MAX_CONCURRENT_RENDERS &&
      this.queue.length > 0
    ) {
      const spec = this.queue.shift();
      if (!spec || !this.desiredAll.has(spec.key) || this.cache.has(spec.key)) continue;
      void this.render(spec, revision);
    }
  }

  private async render(spec: TileSpec, revision: number) {
    const pageState = this.pages[spec.pageIndex];
    if (!pageState) return;
    const canvas = document.createElement('canvas');
    canvas.width = spec.width;
    canvas.height = spec.height;
    canvas.className = 'pdfjs-tile';
    canvas.dataset.tileKey = spec.key;
    const viewport = pageState.page.getViewport({
      scale: spec.rasterWidth / pageState.baseWidth,
    });
    const task = pageState.page.render({
      canvas: null,
      canvasContext: canvas.getContext('2d', { alpha: false })!,
      viewport,
      transform: [1, 0, 0, 1, -spec.x, -spec.y],
      background: '#ffffff',
    });
    this.pending.set(spec.key, { task, revision });
    this.activeRenders += 1;
    try {
      await task.promise;
      if (
        this.destroyed ||
        this.suspended ||
        !this.desiredAll.has(spec.key) ||
        this.pending.get(spec.key)?.revision !== revision
      ) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      const record: TileRecord = {
        ...spec,
        canvas,
        bytes: spec.width * spec.height * 4,
        lastUsed: performance.now(),
      };
      this.place(record);
      this.cache.set(spec.key, record);
      this.residentBytes += record.bytes;
      this.peakResidentBytes = Math.max(this.peakResidentBytes, this.residentBytes);
      this.peakResidentTiles = Math.max(this.peakResidentTiles, this.cache.size);
      this.retireOldScaleWhenExact(spec.pageIndex);
      this.evict();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name !== 'RenderingCancelledException' && !this.destroyed) {
        console.warn('PDF.js tile render failed', error);
      }
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      this.pending.delete(spec.key);
      this.activeRenders = Math.max(0, this.activeRenders - 1);
      this.pump(this.revision);
      this.warmFallbackWhenIdle();
    }
  }

  private place(record: TileRecord) {
    const page = this.pages[record.pageIndex];
    record.canvas.style.left = `${record.x / record.rasterWidth * 100}%`;
    record.canvas.style.top = `${record.y / record.rasterHeight * 100}%`;
    record.canvas.style.width = `${record.width / record.rasterWidth * 100}%`;
    record.canvas.style.height = `${record.height / record.rasterHeight * 100}%`;
    record.canvas.style.zIndex = '2';
    page?.element.append(record.canvas);
  }

  private retireOldScaleWhenExact(pageIndex: number) {
    const visibleForPage = [...this.desiredVisible].filter(key =>
      key.startsWith(`${pageIndex}:`),
    );
    if (visibleForPage.length === 0 || !visibleForPage.every(key => this.cache.has(key))) return;
    for (const key of [...this.fallbackKeys]) {
      if (key.startsWith(`${pageIndex}:`)) this.fallbackKeys.delete(key);
    }
    const currentPrefix = visibleForPage[0]?.split(':').slice(0, 2).join(':');
    for (const [key, record] of [...this.cache]) {
      if (
        record.pageIndex === pageIndex &&
        !key.startsWith(`${currentPrefix}:`) &&
        !this.desiredVisible.has(key)
      ) {
        this.cache.delete(key);
        this.release(record);
      }
    }
  }

  private evict() {
    if (this.residentBytes <= this.maxRenderBytes) return;
    const candidates = [...this.cache.values()]
      .filter(
        record =>
          !this.desiredVisible.has(record.key) && !this.fallbackKeys.has(record.key),
      )
      .sort((a, b) => {
        const aCurrent = this.desiredAll.has(a.key);
        const bCurrent = this.desiredAll.has(b.key);
        return Number(aCurrent) - Number(bCurrent) || a.lastUsed - b.lastUsed;
      });
    for (const record of candidates) {
      if (this.residentBytes <= this.maxRenderBytes) break;
      this.cache.delete(record.key);
      this.release(record);
    }
  }

  private release(record: TileRecord) {
    this.fallbackKeys.delete(record.key);
    record.canvas.remove();
    record.canvas.width = 0;
    record.canvas.height = 0;
    this.residentBytes = Math.max(0, this.residentBytes - record.bytes);
  }

  private cancelPending() {
    for (const pending of this.pending.values()) pending.task.cancel();
    this.pending.clear();
    this.queue = [];
  }

  private async ensurePageFallback(pageIndex: number) {
    const page = this.pages[pageIndex];
    if (page) page.fallbackLastUsed = performance.now();
    if (
      this.destroyed ||
      this.suspended ||
      !page ||
      page.fallbackCanvas ||
      this.fallbackTasks.has(pageIndex)
    ) {
      return;
    }
    // About 0.35 MiB for an A4/Letter page: deliberately soft while scaled,
    // but large enough that page structure remains recognizable during pinch.
    const rasterWidth = 256;
    const scale = rasterWidth / page.baseWidth;
    const viewport = page.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdfjs-page-fallback';
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const task = page.page.render({
      canvas: null,
      canvasContext: canvas.getContext('2d', { alpha: false })!,
      viewport,
      background: '#ffffff',
    });
    this.fallbackTasks.set(pageIndex, task);
    try {
      await task.promise;
      if (this.destroyed || this.suspended || page.fallbackCanvas) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      page.fallbackCanvas = canvas;
      this.fallbackBytes += canvas.width * canvas.height * 4;
      page.element.prepend(canvas);
      if (this.currentVisiblePages.has(pageIndex)) {
        this.previewListener?.({
          pageIndex,
          dataUrl: canvas.toDataURL('image/jpeg', 0.72),
        });
      }
      this.evictFallbacks();
    } catch (error) {
      if ((error instanceof Error ? error.name : '') !== 'RenderingCancelledException') {
        console.warn('PDF.js fallback render failed', error);
      }
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      this.fallbackTasks.delete(pageIndex);
      this.warmFallbackWhenIdle();
    }
  }

  private warmFallbackWhenIdle() {
    if (
      this.destroyed ||
      this.suspended ||
      this.activeRenders > 0 ||
      this.queue.length > 0 ||
      this.fallbackTasks.size > 0
    ) {
      return;
    }
    const pageIndex = [...this.currentVisiblePages].find(
      index => !this.pages[index]?.fallbackCanvas,
    );
    if (pageIndex !== undefined) void this.ensurePageFallback(pageIndex);
  }

  private evictFallbacks() {
    if (this.fallbackBytes <= MAX_FALLBACK_BYTES) return;
    const candidates = this.pages
      .filter(
        page =>
          page.fallbackCanvas && !this.currentVisiblePages.has(page.index),
      )
      .sort((a, b) => a.fallbackLastUsed - b.fallbackLastUsed);
    for (const page of candidates) {
      if (this.fallbackBytes <= MAX_FALLBACK_BYTES) break;
      this.releaseFallback(page);
    }
  }

  private releaseFallback(page: PageState) {
    const canvas = page.fallbackCanvas;
    if (!canvas) return;
    this.fallbackBytes = Math.max(
      0,
      this.fallbackBytes - canvas.width * canvas.height * 4,
    );
    canvas.remove();
    canvas.width = 0;
    canvas.height = 0;
    page.fallbackCanvas = undefined;
  }
}

function documentElement(tag: 'div', className: string) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

interface CommentDraft {
  range: TextRange;
  annotationId?: string;
  text: string;
  comment: string;
}

type ReaderPanel = 'search' | 'outline' | 'references' | 'comments';
interface HoveredLink {
  link: NativeLink & { synthetic?: boolean };
  rect: DOMRect;
}

interface CitationFocus {
  citation: ScientificCitation;
  rect: DOMRect;
}

interface ExternalCitationFocus {
  link: NativeLink & { synthetic?: boolean };
  rect: DOMRect;
  entry: ScholarlyEntry;
}

interface BenchmarkFixture {
  name: string;
  bytes: number[];
}

interface LiveAnchoredCardProps
  extends Omit<ComponentPropsWithoutRef<'div'>, 'style'> {
  resolveAnchor: () => DOMRect | undefined;
  gap?: number;
}

function LiveAnchoredCard({
  resolveAnchor,
  gap = 10,
  children,
  ...props
}: LiveAnchoredCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );

  const updatePosition = useCallback(() => {
    const card = cardRef.current;
    const anchor = resolveAnchor();
    if (!card || !anchor) return;
    const cardRect = card.getBoundingClientRect();
    const next = anchoredFloatingCardPosition(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      {
        width: Math.max(1, cardRect.width),
        height: Math.max(1, cardRect.height),
      },
      gap,
    );
    setPosition(current =>
      current &&
      Math.abs(current.left - next.left) < 0.5 &&
      Math.abs(current.top - next.top) < 0.5
        ? current
        : next,
    );
  }, [gap, resolveAnchor]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updatePosition();
      });
    };
    updatePosition();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleUpdate);
    observer?.observe(card);
    document.addEventListener('scroll', scheduleUpdate, true);
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [updatePosition]);

  return (
    <div
      {...props}
      ref={cardRef}
      style={
        position ?? {
          left: -10_000,
          top: -10_000,
          visibility: 'hidden',
        }
      }
    >
      {children}
    </div>
  );
}

function linkPreviewText(link: NativeLink & { synthetic?: boolean }) {
  if (link.target.kind === 'internal') {
    return {
      title: link.synthetic ? 'Citation' : 'Document link',
      detail: `Go to page ${link.target.page + 1}`,
    };
  }
  try {
    return {
      title: new URL(link.target.url).hostname,
      detail: link.target.url,
    };
  } catch {
    return { title: 'External link', detail: link.target.url };
  }
}

function unionBounds(bounds: NativeBounds[]): NativeBounds | undefined {
  if (bounds.length === 0) return;
  return {
    left: Math.min(...bounds.map(bound => bound.left)),
    top: Math.min(...bounds.map(bound => bound.top)),
    right: Math.max(...bounds.map(bound => bound.right)),
    bottom: Math.max(...bounds.map(bound => bound.bottom)),
  };
}

function referenceForNumber(
  analysis: PaperPreprocessingResult | null,
  number: number,
) {
  return analysis?.references.find(reference => reference.number === number);
}

function compactReferenceTitle(
  reference: ScientificReference,
  metadata?: ScholarlyMetadata,
) {
  if (metadata?.title) return metadata.title;
  return reference.text
    .replace(new RegExp(`^\\s*[[(]?${reference.number}[\\]).:]?\\s*`), '')
    .trim();
}

function citationPreview(
  link: NativeLink & { synthetic?: boolean },
  analysis: PaperPreprocessingResult | null,
) {
  if (!link.synthetic || link.target.kind !== 'internal' || !analysis) {
    return linkPreviewText(link);
  }
  const target = link.target;
  const targetY = target.yFraction ?? 0;
  const reference = analysis.references
    .filter(candidate => candidate.page === target.page)
    .sort(
      (left, right) =>
        Math.abs((left.yFraction ?? 0) - targetY) -
        Math.abs((right.yFraction ?? 0) - targetY),
    )[0];
  return reference
    ? { title: `Reference [${reference.number}]`, detail: reference.text }
    : linkPreviewText(link);
}

interface PdfJsBenchmarkAppProps {
  initialFile?: File;
  embedded?: boolean;
  paneTitle?: string;
  keyboardShortcuts?: boolean;
  initialViewState?: PdfJsViewState;
  onViewStateChange?: (state: PdfJsViewState) => void;
  onReady?: () => void;
  rasterMode?: 'active' | 'parsed';
  visibilityMode?: 'visible' | 'standby' | 'parsed';
  previewUrl?: string;
  onPreviewChange?: (preview: PdfJsPreview) => void;
  onChromeStateChange?: (state: PdfReaderChromeState) => void;
  initialControlState?: { searchQuery: string };
  onRequestControlMode?: (mode: 'search' | 'comments' | null) => void;
}

export type PdfReaderPanel = ReaderPanel;

export interface PdfReaderChromeState {
  ready: boolean;
  title: string;
  zoom: number;
  pageCount: number;
  status: string;
  searchQuery: string;
  searchCount: number;
  activeSearchIndex: number;
  searchResults: Array<{ id: string; page: number; preview: string }>;
  searching: boolean;
  activePanel: PdfReaderPanel | null;
  commentCount: number;
  comments: Array<{
    id: string;
    page: number;
    text: string;
    comment: string;
    color: HighlightColor;
    accentRgb: string;
  }>;
  activeCommentId: string | null;
  outlineCount: number;
  referenceCount: number;
}

export interface PdfReaderHandle {
  zoomIn(): void;
  zoomOut(): void;
  actualSize(): void;
  fitWidth(): void;
  setSearchQuery(query: string): void;
  previousSearchResult(): void;
  nextSearchResult(): void;
  activateSearchResult(index: number): void;
  activateComment(id: string): void;
  closeSearch(): void;
  togglePanel(panel: PdfReaderPanel): void;
  closePanel(): void;
}

const PdfJsBenchmarkApp = forwardRef<PdfReaderHandle, PdfJsBenchmarkAppProps>(
function PdfJsBenchmarkApp({
  initialFile,
  embedded = false,
  paneTitle = 'PDF.js reader',
  keyboardShortcuts = true,
  initialViewState,
  onViewStateChange,
  onReady,
  rasterMode = 'active',
  visibilityMode = 'visible',
  previewUrl,
  onPreviewChange,
  onChromeStateChange,
  initialControlState,
  onRequestControlMode,
}: PdfJsBenchmarkAppProps = {}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PdfJsTileController | null>(null);
  const overlayRef = useRef<PdfJsTextOverlayManager | null>(null);
  const companionWatchRef = useRef<(() => void) | null>(null);
  const documentIdRef = useRef<string | null>(null);
  const searchRevisionRef = useRef(0);
  const fixtureRequestedRef = useRef(false);
  const autoRunBenchmarkRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const citationDialogRef = useRef<HTMLElement>(null);
  const citationUiId = useId().replaceAll(':', '');
  const [status, setStatus] = useState('Choose a PDF');
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadMs, setLoadMs] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([]);
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<ReaderAnnotation | null>(null);
  const [contextRect, setContextRect] = useState<DOMRect | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentEditorExpanded, setCommentEditorExpanded] = useState(false);
  const [commentAnchorRect, setCommentAnchorRect] = useState<DOMRect | null>(null);
  const [commentError, setCommentError] = useState('');
  const [activePanel, setActivePanel] = useState<ReaderPanel | null>(null);
  const [analysis, setAnalysis] = useState<PaperPreprocessingResult | null>(null);
  const [hoveredLink, setHoveredLink] = useState<HoveredLink | null>(null);
  const [hoveredCitation, setHoveredCitation] = useState<CitationFocus | null>(null);
  const linkHoverBridgeRef = useRef<HoverCardBridge | null>(null);
  linkHoverBridgeRef.current ??= new HoverCardBridge();
  const [selectedCitation, setSelectedCitation] = useState<CitationFocus | null>(null);
  const [externalCitation, setExternalCitation] =
    useState<ExternalCitationFocus | null>(null);
  const [externalCitationExpanded, setExternalCitationExpanded] = useState(false);
  const externalCitationRequestRef = useRef(0);
  const [activeCitationNumber, setActiveCitationNumber] = useState<number | null>(
    null,
  );
  const [expandedCitationNumber, setExpandedCitationNumber] = useState<
    number | null
  >(null);
  const [scholarly, setScholarly] = useState<Map<number, ScholarlyEntry>>(
    () => new Map(),
  );
  const [searchQuery, setSearchQuery] = useState(
    () => initialControlState?.searchQuery ?? '',
  );
  const [searchMatches, setSearchMatches] = useState<ReaderSearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const sourceBytesRef = useRef(0);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const onReadyRef = useRef(onReady);
  const onPreviewChangeRef = useRef(onPreviewChange);
  const onChromeStateChangeRef = useRef(onChromeStateChange);
  const onRequestControlModeRef = useRef(onRequestControlMode);
  const initialViewStateRef = useRef(initialViewState);
  const initialControlStateRef = useRef(initialControlState);
  const lastViewStateRef = useRef<PdfJsViewState | null>(
    initialViewStateRef.current ?? null,
  );
  const visibilityModeRef = useRef(visibilityMode);
  if (initialViewState) initialViewStateRef.current = initialViewState;
  onViewStateChangeRef.current = onViewStateChange;
  onReadyRef.current = onReady;
  onPreviewChangeRef.current = onPreviewChange;
  onChromeStateChangeRef.current = onChromeStateChange;
  onRequestControlModeRef.current = onRequestControlMode;

  const cancelLinkHoverExit = useCallback(() => {
    linkHoverBridgeRef.current?.cancel();
  }, []);
  const showHoveredLink = useCallback((focus: HoveredLink) => {
    cancelLinkHoverExit();
    setHoveredLink(focus);
  }, [cancelLinkHoverExit]);
  const scheduleLinkHoverExit = useCallback(() => {
    linkHoverBridgeRef.current?.schedule(() => {
      setHoveredLink(null);
    });
  }, []);

  const showHoveredCitation = useCallback((focus: CitationFocus) => {
    setHoveredCitation(focus);
  }, []);

  useEffect(
    () => () => {
      linkHoverBridgeRef.current?.dispose();
      if (lastViewStateRef.current) {
        onViewStateChangeRef.current?.(lastViewStateRef.current);
      }
      overlayRef.current?.destroy();
      overlayRef.current = null;
      companionWatchRef.current?.();
      companionWatchRef.current = null;
      const controller = controllerRef.current;
      controllerRef.current = null;
      const documentId = documentIdRef.current;
      documentIdRef.current = null;
      pdfJsDestructionBarrier = pdfJsDestructionBarrier
        .catch(() => undefined)
        .then(async () => {
          await controller?.destroy();
          if (documentId) await closeNativeCompanion(documentId);
        });
    },
    [cancelLinkHoverExit],
  );

  const load = useCallback(async (file: File) => {
    await pdfJsDestructionBarrier.catch(() => undefined);
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    setReady(false);
    setAnalysis(null);
    cancelLinkHoverExit();
    setHoveredLink(null);
    setHoveredCitation(null);
    setSelectedCitation(null);
    setExternalCitation(null);
    setExternalCitationExpanded(false);
    externalCitationRequestRef.current += 1;
    setActiveCitationNumber(null);
    setExpandedCitationNumber(null);
    setScholarly(new Map());
    setStatus('PDF.js: loading document');
    window.__PDFJS_READY__ = false;
    window.__PDFJS_FEATURES_READY__ = false;
    window.__PDFJS_ERROR__ = undefined;
    window.__PDFJS_BENCHMARK_RESULT__ = undefined;
    overlayRef.current?.destroy();
    overlayRef.current = null;
    companionWatchRef.current?.();
    companionWatchRef.current = null;
    if (controllerRef.current) await controllerRef.current.destroy();
    if (documentIdRef.current) await closeNativeCompanion(documentIdRef.current);
    documentIdRef.current = null;
    content.replaceChildren();
    const start = performance.now();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      sourceBytesRef.current = bytes.byteLength;
      const companionPromise = openNativeCompanion(
        file,
        bytes.slice(),
        false,
      );
      const documentProxy = await getDocument({ data: bytes.slice() }).promise;
      const sourcePages = await Promise.all(
        Array.from({ length: documentProxy.numPages }, async (_, index) => {
          const page = await documentProxy.getPage(index + 1);
          const viewport = page.getViewport({ scale: 1 });
          return { page, width: viewport.width, height: viewport.height };
        }),
      );
      const companion = await companionPromise;
      setAnalysis(companion.analysis ?? null);
      setScholarly(preprocessedScholarlyEntries(companion.analysis));
      documentIdRef.current = companion.id;
      const controller = new PdfJsTileController(
        scroll,
        content,
        documentProxy,
        sourcePages,
        embedded ? 16 * 1024 * 1024 : undefined,
      );
      controllerRef.current = controller;
      controller.onZoomChange(setZoom);
      if (initialViewStateRef.current) {
        controller.restoreViewState(initialViewStateRef.current);
      }
      controller.onViewStateChange(state => {
        // WebKit emits a synthetic scrollTop=0 event when an existing reader
        // moves behind the visible pane. The state captured while visible is
        // authoritative; hidden layout activity must not overwrite it.
        if (
          visibilityModeRef.current !== 'visible' &&
          lastViewStateRef.current
        ) {
          return;
        }
        initialViewStateRef.current = state;
        lastViewStateRef.current = state;
        onViewStateChangeRef.current?.(state);
      });
      controller.onPreviewChange(preview => {
        onPreviewChangeRef.current?.(preview);
      });
      const overlay = new PdfJsTextOverlayManager(companion.id, controller.pageHosts());
      overlayRef.current = overlay;
      overlay.setLinks(
        companion.analysis?.document.links ?? companion.document?.links ?? [],
      );
      overlay.setCitations(companion.analysis?.citations ?? []);
      companionWatchRef.current = watchNativeCompanion(
        companion.id,
        snapshot => {
          if (documentIdRef.current !== companion.id) return;
          if (snapshot.analysis) {
            setAnalysis(snapshot.analysis);
            setScholarly(preprocessedScholarlyEntries(snapshot.analysis));
            overlayRef.current?.setLinks(snapshot.analysis.document.links);
            overlayRef.current?.setCitations(snapshot.analysis.citations ?? []);
          }
          if (snapshot.stage === 'failed' && snapshot.error) {
            setStatus(`Reader ready · analysis unavailable: ${snapshot.error}`);
          }
        },
      );
      const restored = loadReaderAnnotations(companion.id);
      setAnnotations(restored);
      overlay.setAnnotations(restored);
      overlay.onSelection(snapshot => {
        setSelection(snapshot);
        setContextRect(snapshot?.viewportRect ?? null);
        if (snapshot) setActiveAnnotation(null);
      });
      overlay.onAnnotationActivation((annotation, rect) => {
        setSelection(null);
        setActiveAnnotation(annotation);
        setContextRect(rect ?? null);
      });
      overlay.onLinkActivation((link, rect) => {
        if (link.target.kind === 'internal') {
          controller.scrollToBounds(link.target.page, {
            left: link.target.xFraction ?? 0,
            right: link.target.xFraction ?? 0,
            top: link.target.yFraction ?? 0,
            bottom: link.target.yFraction ?? 0,
          });
        } else if (isScholarlyResourceUrl(link.target.url) && isTauri()) {
          const request = ++externalCitationRequestRef.current;
          cancelLinkHoverExit();
          setHoveredLink(null);
          setHoveredCitation(null);
          setSelectedCitation(null);
          setExternalCitationExpanded(false);
          setExternalCitation({ link, rect, entry: { state: 'loading' } });
          setActivePanel(null);
          void invoke<ScholarlyMetadata>('scholarly_lookup_resource', {
            resource: link.target.url,
          })
            .then(metadata => {
              if (externalCitationRequestRef.current !== request) return;
              setExternalCitation(current =>
                current
                  ? { ...current, entry: { state: 'ready', metadata } }
                  : current,
              );
            })
            .catch(error => {
              if (externalCitationRequestRef.current !== request) return;
              setExternalCitation(current =>
                current
                  ? {
                      ...current,
                      entry: {
                        state: 'failed',
                        error:
                          error instanceof Error ? error.message : String(error),
                      },
                    }
                  : current,
              );
            });
        } else {
          window.open(link.target.url, '_blank', 'noopener,noreferrer');
        }
      });
      overlay.onLinkHover((link, rect) => {
        if (link && rect) {
          showHoveredLink({ link, rect });
        } else {
          scheduleLinkHoverExit();
        }
      });
      overlay.onCitationActivation((citation, rect) => {
        cancelLinkHoverExit();
        setHoveredLink(null);
        setHoveredCitation(null);
        setExternalCitation(null);
        setExternalCitationExpanded(false);
        setSelectedCitation({ citation, rect });
        setActiveCitationNumber(citation.numbers[0] ?? null);
        setActivePanel(null);
      });
      overlay.onCitationHover((citation, rect) => {
        if (citation && rect) {
          cancelLinkHoverExit();
          setHoveredLink(null);
          showHoveredCitation({ citation, rect });
        }
      });
      controller.onVisiblePages(pages => {
        const demand = pages.flatMap(page => [page - 1, page, page + 1]);
        void overlay.ensurePages(
          demand.filter(page => page >= 0 && page < documentProxy.numPages),
        );
      });
      // A slow first raster is a performance result, not a load failure. Tiles
      // keep streaming in either way, so treating the timeout as fatal only
      // stranded a perfectly readable document behind the blur veil.
      const settled = await controller.waitForExact();
      await overlay.ensurePage(0);
      const duration = performance.now() - start;
      setLoadMs(duration);
      setZoom(controller.currentZoom());
      setSelection(null);
      setActiveAnnotation(null);
      setCommentDraft(null);
      setCommentAnchorRect(null);
      setCommentEditorExpanded(false);
      setActivePanel(null);
      setSearchQuery(initialControlStateRef.current?.searchQuery ?? '');
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setReady(true);
      setStatus(
        settled.timedOut
          ? `Ready · ${documentProxy.numPages} pages · still rasterising`
          : `Ready · ${documentProxy.numPages} pages · rendering + text ${Math.round(duration)} ms`,
      );
      window.__PDFJS_READY__ = true;
      window.__PDFJS_FEATURES_READY__ = true;
      onReadyRef.current?.();
      if (isTauri()) void invoke('benchmark_phase', { name: 'load-ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.__PDFJS_ERROR__ = message;
      setStatus(`PDF.js failed: ${message}`);
      if (isTauri()) {
        void invoke('benchmark_report', {
          payload: {
            error: `reader load failed: ${message}${
              error instanceof Error && error.stack ? `\n${error.stack}` : ''
            }`,
          },
        }).catch(() => undefined);
      }
    }
  }, [
    cancelLinkHoverExit,
    embedded,
    scheduleLinkHoverExit,
    showHoveredCitation,
    showHoveredLink,
  ]);

  useLayoutEffect(() => {
    const previousMode = visibilityModeRef.current;
    visibilityModeRef.current = visibilityMode;
    const controller = controllerRef.current;
    if (!ready || !controller || previousMode === visibilityMode) return;

    const persisted = initialViewStateRef.current ?? lastViewStateRef.current;
    if (visibilityMode === 'visible' && persisted) {
      controller.restoreViewState(persisted);
      const restored = controller.currentViewState();
      initialViewStateRef.current = restored;
      lastViewStateRef.current = restored;
      onViewStateChangeRef.current?.(restored);
    }
  }, [ready, visibilityMode]);

  // Panels remain true overlays. The controller adds trailing scroll range
  // while keeping the page centred against the unchanged viewport, so the
  // user can move the full page out from underneath an open panel.
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!activePanel) {
      controller?.setPanelInset(0);
      return;
    }
    const panel = scrollRef.current?.parentElement?.querySelector<HTMLElement>(
      '.key-panel-shell',
    );
    if (!panel) {
      controller?.setPanelInset(0);
      return;
    }
    const update = () => {
      const panelRect = panel.getBoundingClientRect();
      controller?.setPanelInset(panelRect.width + PANEL_EDGE_GAP * 2);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      controller?.setPanelInset(0);
    };
  }, [activePanel, ready]);

  const citationFocus = selectedCitation ?? hoveredCitation;
  const selectedCitationNumbers = citationFocus?.citation.numbers ?? [];
  const selectedActiveCitationNumber =
    activeCitationNumber !== null &&
    selectedCitationNumbers.includes(activeCitationNumber)
      ? activeCitationNumber
      : selectedCitationNumbers[0] ?? null;
  const selectedActiveReference =
    selectedActiveCitationNumber === null
      ? undefined
      : referenceForNumber(analysis, selectedActiveCitationNumber);
  const selectedActiveEntry =
    selectedActiveCitationNumber === null
      ? undefined
      : scholarly.get(selectedActiveCitationNumber);
  const selectedActiveMetadata =
    selectedActiveEntry?.state === 'ready'
      ? selectedActiveEntry.metadata
      : undefined;
  const selectedActiveSummary = citationSummary(selectedActiveMetadata);
  const selectedActiveLinks = citationLinks(selectedActiveMetadata);
  const externalCitationMetadata =
    externalCitation?.entry.state === 'ready'
      ? externalCitation.entry.metadata
      : undefined;
  const externalCitationSummary = citationSummary(externalCitationMetadata);
  const externalCitationLinks = citationLinks(externalCitationMetadata);
  const resolveHoveredLinkAnchor = useCallback(
    () =>
      hoveredLink
        ? overlayRef.current?.viewportRectForPageBounds(hoveredLink.link.page, [
            hoveredLink.link.bounds,
          ]) ?? hoveredLink.rect
        : undefined,
    [hoveredLink],
  );
  const resolveCitationAnchor = useCallback(
    () =>
      citationFocus
        ? overlayRef.current?.viewportRectForPageBounds(
            citationFocus.citation.page,
            [citationFocus.citation.bounds],
          ) ?? citationFocus.rect
        : undefined,
    [citationFocus],
  );
  const resolveExternalCitationAnchor = useCallback(
    () =>
      externalCitation
        ? overlayRef.current?.viewportRectForPageBounds(
            externalCitation.link.page,
            [externalCitation.link.bounds],
          ) ?? externalCitation.rect
        : undefined,
    [externalCitation],
  );

  useEffect(() => {
    const numbers = citationFocus?.citation.numbers ?? [];
    setActiveCitationNumber(current =>
      current !== null && numbers.includes(current)
        ? current
        : numbers[0] ?? null,
    );
    setExpandedCitationNumber(null);
  }, [citationFocus?.citation.id]);

  useEffect(() => {
    if (expandedCitationNumber === null && !externalCitationExpanded) return;
    const frame = requestAnimationFrame(() => citationDialogRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expandedCitationNumber, externalCitationExpanded]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const overlay = overlayRef.current;
    const range =
      commentDraft?.range ?? selection?.range ?? activeAnnotation?.range;
    if (!scroll || !overlay || !range) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = overlay.viewportRectForRange(range);
        if (commentDraft) setCommentAnchorRect(rect ?? null);
        else setContextRect(rect ?? null);
      });
    };
    scroll.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [activeAnnotation, commentDraft, selection]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!ready || !controller) return;
    if (rasterMode === 'parsed') {
      controller.suspendRaster(false);
      if (documentIdRef.current) {
        releaseNativeCompanionText(documentIdRef.current);
      }
    }
    else controller.resumeRaster();
  }, [rasterMode, ready]);

  const initialFileRef = useRef<File | null>(null);
  useEffect(() => {
    if (!initialFile || initialFileRef.current === initialFile) return;
    initialFileRef.current = initialFile;
    void load(initialFile);
  }, [initialFile, load]);

  useEffect(() => {
    if (initialFile || !isTauri() || fixtureRequestedRef.current) return;
    fixtureRequestedRef.current = true;
    void invoke<BenchmarkFixture | null>('benchmark_fixture')
      .then(async fixture => {
        if (!fixture) return;
        await invoke('benchmark_phase', { name: 'baseline-ready' });
        await new Promise(resolve => window.setTimeout(resolve, 600));
        await invoke('benchmark_phase', { name: 'load-start' });
        autoRunBenchmarkRef.current = true;
        await load(
          new File([Uint8Array.from(fixture.bytes)], fixture.name, {
            type: 'application/pdf',
            lastModified: 0,
          }),
        );
      })
      .catch(error => setStatus(`Benchmark fixture failed: ${String(error)}`));
  }, [initialFile, load]);

  const updateAnnotations = useCallback((next: ReaderAnnotation[]) => {
    const documentId = documentIdRef.current;
    if (!documentId) return;
    setAnnotations(next);
    saveReaderAnnotations(documentId, next);
    overlayRef.current?.setAnnotations(next);
  }, []);

  const addHighlight = useCallback(
    (color: HighlightColor) => {
      const documentId = documentIdRef.current;
      if (!documentId) return;
      const range = selection?.range ?? activeAnnotation?.range;
      if (!range) return;
      const exact = annotations.find(
        annotation =>
          annotation.range.start.page === range.start.page &&
          annotation.range.start.index === range.start.index &&
          annotation.range.end.page === range.end.page &&
          annotation.range.end.index === range.end.index,
      );
      const now = new Date().toISOString();
      const updated: ReaderAnnotation = exact
        ? { ...exact, color, updatedAt: now }
        : {
            id: annotationId(),
            documentId,
            range,
            text: selection?.text ?? activeAnnotation?.text ?? '',
            color,
            createdAt: now,
            updatedAt: now,
          };
      updateAnnotations([
        ...annotations.filter(annotation => annotation.id !== updated.id),
        updated,
      ]);
      overlayRef.current?.clearBrowserSelection();
      setSelection(null);
      setActiveAnnotation(updated);
      requestAnimationFrame(() => {
        setContextRect(
          overlayRef.current?.viewportRectForRange(updated.range) ?? null,
        );
      });
      setStatus(`Added ${color} highlight`);
    },
    [activeAnnotation, annotations, selection, updateAnnotations],
  );

  const openCommentEditor = useCallback(() => {
    const range = selection?.range ?? activeAnnotation?.range;
    if (!range) return;
    setCommentError('');
    setCommentDraft({
      range,
      annotationId: activeAnnotation?.id,
      text: selection?.text ?? activeAnnotation?.text ?? '',
      comment: activeAnnotation?.comment ?? '',
    });
    setCommentAnchorRect(
      contextRect ?? overlayRef.current?.viewportRectForRange(range) ?? null,
    );
    setCommentEditorExpanded(true);
    onRequestControlModeRef.current?.('comments');
  }, [activeAnnotation, contextRect, selection]);

  const openAnnotationEditor = useCallback(
    async (annotation: ReaderAnnotation) => {
      const overlay = overlayRef.current;
      const controller = controllerRef.current;
      const page = annotation.range.start.page;
      await overlay?.ensurePage(page);
      const textPage = overlay?.textPages.get(page);
      const targetBounds = textPage
        ? unionBounds(boundsForRange(textPage, annotation.range))
        : undefined;

      setSelection(null);
      setActiveAnnotation(annotation);
      setContextRect(null);
      setCommentError('');
      setCommentDraft({
        range: annotation.range,
        annotationId: annotation.id,
        text: annotation.text,
        comment: annotation.comment ?? '',
      });
      setCommentEditorExpanded(true);
      setCommentAnchorRect(
        overlay?.viewportRectForRange(annotation.range) ?? null,
      );
      onRequestControlModeRef.current?.('comments');
      controller?.centerOnBounds(page, targetBounds);

      requestAnimationFrame(() => {
        setCommentAnchorRect(
          overlayRef.current?.viewportRectForRange(annotation.range) ?? null,
        );
      });
    },
    [],
  );

  const saveComment = useCallback(() => {
    const documentId = documentIdRef.current;
    if (!documentId || !commentDraft) return;
    const comment = commentDraft.comment.trim();
    if (!comment) {
      setCommentError('A comment cannot be empty.');
      return;
    }
    const now = new Date().toISOString();
    const next = upsertAnnotationComment(annotations, {
      annotationId: commentDraft.annotationId,
      documentId,
      range: commentDraft.range,
      text: commentDraft.text,
      comment,
      timestamp: now,
    });
    const updated = next.find(annotation =>
      commentDraft.annotationId
        ? annotation.id === commentDraft.annotationId
        : annotation.comment === comment &&
          annotation.range.start.page === commentDraft.range.start.page &&
          annotation.range.start.index === commentDraft.range.start.index,
    )!;
    updateAnnotations(next);
    overlayRef.current?.clearBrowserSelection();
    setSelection(null);
    setActiveAnnotation(updated);
    setCommentDraft(null);
    setCommentAnchorRect(null);
    setCommentEditorExpanded(false);
    setStatus('Comment saved');
  }, [annotations, commentDraft, updateAnnotations]);

  const removeActiveAnnotation = useCallback(() => {
    if (!activeAnnotation) return;
    updateAnnotations(
      annotations.filter(annotation => annotation.id !== activeAnnotation.id),
    );
    setActiveAnnotation(null);
    setContextRect(null);
    setStatus('Annotation removed');
  }, [activeAnnotation, annotations, updateAnnotations]);

  const copyContextText = useCallback(async () => {
    const text = selection?.text ?? activeAnnotation?.text ?? '';
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied selected text');
    } catch {
      setStatus('Could not copy selected text');
    }
  }, [activeAnnotation, selection]);

  const activateSearch = useCallback(
    (matches: ReaderSearchMatch[], index: number) => {
      if (matches.length === 0) {
        setActiveSearchIndex(-1);
        overlayRef.current?.setSearch([], null);
        return;
      }
      const normalized = ((index % matches.length) + matches.length) % matches.length;
      const match = matches[normalized];
      setActiveSearchIndex(normalized);
      overlayRef.current?.setSearch(matches, match.id);
      controllerRef.current?.scrollToBounds(match.page, match.bounds[0]);
      void overlayRef.current?.ensurePage(match.page);
    },
    [],
  );

  const runSearch = useCallback(
    async (query: string, navigate = true) => {
      const documentId = documentIdRef.current;
      const overlay = overlayRef.current;
      if (!documentId || !overlay) return [] as ReaderSearchMatch[];
      const trimmed = query.trim();
      const revision = ++searchRevisionRef.current;
      if (!trimmed) {
        setSearchMatches([]);
        setActiveSearchIndex(-1);
        overlay.setSearch([], null);
        return [];
      }
      setSearching(true);
      try {
        if (!isTauri() || !hasNativeCompanionText(documentId)) {
          await overlay.ensureAllPages();
        }
        const matches = await searchReaderDocument(documentId, trimmed, overlay.textPages);
        if (revision !== searchRevisionRef.current) return [];
        setSearchMatches(matches);
        if (navigate) activateSearch(matches, 0);
        else overlay.setSearch(matches, matches[0]?.id ?? null);
        return matches;
      } catch (error) {
        if (revision === searchRevisionRef.current) {
          setStatus(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
      } finally {
        if (revision === searchRevisionRef.current) setSearching(false);
      }
    },
    [activateSearch],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void runSearch(searchQuery), 180);
    return () => window.clearTimeout(timer);
  }, [ready, runSearch, searchQuery]);

  useEffect(() => {
    if (!keyboardShortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches('input, textarea, select') ||
        target?.isContentEditable;
      const command = event.metaKey || event.ctrlKey;
      const applyZoom = (next: number) => {
        controllerRef.current?.setZoom(next);
        setZoom(controllerRef.current?.currentZoom() ?? next);
      };
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        onRequestControlModeRef.current?.('search');
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (command && event.key.toLocaleLowerCase() === 'c' && selection && !editing) {
        event.preventDefault();
        void copyContextText();
        return;
      }
      if (command && event.key.toLocaleLowerCase() === 'g') {
        event.preventDefault();
        activateSearch(
          searchMatches,
          activeSearchIndex + (event.shiftKey ? -1 : 1),
        );
        return;
      }
      if (command && event.key === '0') {
        event.preventDefault();
        controllerRef.current?.actualSize();
        setZoom(controllerRef.current?.currentZoom() ?? 1);
        return;
      }
      if (command && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        applyZoom((controllerRef.current?.currentZoom() ?? 1) * 1.2);
        return;
      }
      if (command && event.key === '-') {
        event.preventDefault();
        applyZoom((controllerRef.current?.currentZoom() ?? 1) / 1.2);
        return;
      }
      if (command && event.altKey && event.key.toLocaleLowerCase() === 'm') {
        event.preventDefault();
        openCommentEditor();
        return;
      }
      if (event.key === 'Escape') {
        if (externalCitationExpanded) {
          setExternalCitationExpanded(false);
          return;
        }
        if (expandedCitationNumber !== null) {
          setExpandedCitationNumber(null);
          return;
        }
        overlayRef.current?.clearBrowserSelection();
        setSelection(null);
        setActiveAnnotation(null);
        setContextRect(null);
        setActivePanel(null);
        setSelectedCitation(null);
        setExternalCitation(null);
        setHoveredCitation(null);
        return;
      }
      if (editing) return;
      const controller = controllerRef.current;
      if (!controller) return;
      const pageStep = Math.max(120, (scrollRef.current?.clientHeight ?? 600) * 0.86);
      const actions: Record<string, () => void> = {
        ArrowUp: () => controller.scrollByPixels(0, -48),
        ArrowDown: () => controller.scrollByPixels(0, 48),
        ArrowLeft: () => controller.scrollByPixels(-48, 0),
        ArrowRight: () => controller.scrollByPixels(48, 0),
        PageUp: () => controller.scrollByPixels(0, -pageStep),
        PageDown: () => controller.scrollByPixels(0, pageStep),
        Home: () => controller.scrollToFraction(0),
        End: () => controller.scrollToFraction(1),
        ' ': () => controller.scrollByPixels(0, event.shiftKey ? -pageStep : pageStep),
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activateSearch,
    activeSearchIndex,
    copyContextText,
    expandedCitationNumber,
    externalCitationExpanded,
    keyboardShortcuts,
    openCommentEditor,
    searchMatches,
    selection,
  ]);

  const benchmark = useCallback(async () => {
    const controller = controllerRef.current;
    const overlay = overlayRef.current;
    if (!controller || !overlay || running) return;
    setRunning(true);
    setStatus('Preparing text, search, and overlays');
    if (isTauri()) void invoke('benchmark_phase', { name: 'feature-start' });
    const featureStart = performance.now();
    if (!isTauri()) await overlay.ensureAllPages();
    const benchmarkMatches = await runSearch('the', false);
    const featureSetupMs = performance.now() - featureStart;
    if (isTauri()) {
      await invoke('benchmark_phase', { name: 'feature-ready' });
      await new Promise(resolve => window.setTimeout(resolve, 150));
    }
    setStatus('Running layered scroll/zoom sequence');
    const intervals: number[] = [];
    const settleTimes: number[] = [];
    let settleTimeouts = 0;
    let collecting = true;
    let previous = performance.now();
    const collect = (now: number) => {
      if (!collecting) return;
      intervals.push(now - previous);
      previous = now;
      requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    if (isTauri()) void invoke('benchmark_phase', { name: 'interaction-start' });
    const settle = async () => {
      await nextFrames(4);
      const result = await controller.waitForExact();
      settleTimes.push(result.durationMs);
      if (result.timedOut) settleTimeouts += 1;
    };
    const scrollTargets = [0, 0.25, 0.5, 1];
    for (const target of scrollTargets) {
      controller.scrollToFraction(target);
      await settle();
    }
    for (const zoom of [1, 1.5, 2, 0.8, 1.25, 1]) {
      controller.setZoom(zoom);
      await settle();
    }
    for (const target of [...scrollTargets].reverse()) {
      controller.scrollToFraction(target);
      await settle();
    }
    await nextFrames(10);
    collecting = false;
    const usable = intervals.slice(1);
    const result: PdfJsBenchmarkResult = {
      schemaVersion: 1,
      renderer: 'pdfjs-canvas-tiles',
      userAgent: navigator.userAgent,
      startedAt,
      pageCount: controller.pageCount(),
      sourceBytes: sourceBytesRef.current,
      loadMs,
      featureSetupMs,
      interactionMs: performance.now() - start,
      frameIntervals: {
        median: percentile(usable, 0.5),
        p95: percentile(usable, 0.95),
        maximum: Math.max(0, ...usable),
        framesOver20Ms: usable.filter(value => value > 20).length,
      },
      exactRenderSettleMs: {
        median: percentile(settleTimes, 0.5),
        p95: percentile(settleTimes, 0.95),
        maximum: Math.max(0, ...settleTimes),
        timeouts: settleTimeouts,
      },
      cache: controller.cacheMetrics(),
      scenario: { scrollJumps: 8, zoomChanges: 6 },
    };
    window.__PDFJS_BENCHMARK_RESULT__ = result;
    if (isTauri()) void invoke('benchmark_report', { payload: result });
    setRunning(false);
    setStatus(
      `Done · ${benchmarkMatches.length} search hits · ${Math.round(result.interactionMs)} ms · p95 ${result.frameIntervals.p95.toFixed(1)} ms`,
    );
  }, [loadMs, runSearch, running]);

  const setReaderZoom = useCallback((next: number) => {
    controllerRef.current?.setZoom(next);
    setZoom(controllerRef.current?.currentZoom() ?? next);
  }, []);

  const context = selection || activeAnnotation ? contextRect : null;
  const comments = useMemo(
    () => annotations.filter(annotation => annotation.comment),
    [annotations],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => setReaderZoom(zoom * 1.2),
      zoomOut: () => setReaderZoom(zoom / 1.2),
      actualSize: () => {
        controllerRef.current?.actualSize();
        setZoom(controllerRef.current?.currentZoom() ?? 1);
      },
      fitWidth: () => {
        controllerRef.current?.fitWidth();
        setZoom(controllerRef.current?.currentZoom() ?? 1);
      },
      setSearchQuery,
      previousSearchResult: () =>
        activateSearch(searchMatches, activeSearchIndex - 1),
      nextSearchResult: () =>
        activateSearch(searchMatches, activeSearchIndex + 1),
      activateSearchResult: index => activateSearch(searchMatches, index),
      activateComment: id => {
        const annotation = comments.find(comment => comment.id === id);
        if (!annotation) return;
        void openAnnotationEditor(annotation);
      },
      closeSearch: () => {
        setSearchQuery('');
        setActivePanel(current => (current === 'search' ? null : current));
      },
      togglePanel: panel =>
        setActivePanel(current => (current === panel ? null : panel)),
      closePanel: () => setActivePanel(null),
    }),
    [
      activateSearch,
      activeSearchIndex,
      comments,
      openAnnotationEditor,
      searchMatches,
      setReaderZoom,
      zoom,
    ],
  );

  useEffect(() => {
    onChromeStateChangeRef.current?.({
      ready,
      title: initialFile?.name ?? paneTitle,
      zoom,
      pageCount: controllerRef.current?.pageCount() ?? 0,
      status,
      searchQuery,
      searchCount: searchMatches.length,
      activeSearchIndex,
      searchResults: searchMatches.slice(0, 256).map(match => ({
        id: match.id,
        page: match.page,
        preview: match.preview,
      })),
      searching,
      activePanel,
      commentCount: comments.length,
      comments: comments.map(comment => ({
        id: comment.id,
        page: comment.range.start.page,
        text: comment.text,
        comment: comment.comment ?? '',
        color: comment.color,
        accentRgb: HIGHLIGHT_COLOR_RGB[comment.color],
      })),
      activeCommentId: activeAnnotation?.comment ? activeAnnotation.id : null,
      outlineCount: analysis?.document.toc.length ?? 0,
      referenceCount: analysis?.references.length ?? 0,
    });
  }, [
    activePanel,
    activeAnnotation,
    activeSearchIndex,
    analysis,
    comments,
    initialFile?.name,
    paneTitle,
    ready,
    searchMatches.length,
    searchQuery,
    searching,
    status,
    zoom,
  ]);

  useEffect(() => {
    if (!ready || !autoRunBenchmarkRef.current || running) return;
    autoRunBenchmarkRef.current = false;
    const timer = window.setTimeout(() => void benchmark(), 250);
    return () => window.clearTimeout(timer);
  }, [benchmark, ready, running]);

  return (
    <main
      className={`pdfjs-benchmark ${embedded ? 'embedded' : ''}`}
      onPointerDownCapture={event => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('.pdfjs-citation-card, .pdfjs-citation-modal')
        ) {
          return;
        }
        setSelectedCitation(null);
        setHoveredCitation(null);
        setExternalCitation(null);
        setExternalCitationExpanded(false);
      }}
    >
      {!embedded && <header className="pdfjs-benchmark-toolbar" aria-label="Within PDF controls">
        <div className="pdfjs-pane-title">
          <Icon name="document" />
          <strong>{paneTitle}</strong>
        </div>
        {!embedded && (
          <label className="pdfjs-file-button">
            Open PDF
            <input
              type="file"
              accept="application/pdf"
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                if (file) void load(file);
              }}
            />
          </label>
        )}
        <div className="pdfjs-toolbar-group" aria-label="Zoom controls">
          <IconButton
            icon="zoom_out"
            label="Zoom out"
            disabled={!ready}
            onClick={() => setReaderZoom(zoom / 1.2)}
          />
          <button
            type="button"
            disabled={!ready}
            className="pdfjs-zoom-value"
            onClick={() => {
              controllerRef.current?.actualSize();
              setZoom(controllerRef.current?.currentZoom() ?? 1);
            }}
            title="Actual size"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton
            icon="zoom_in"
            label="Zoom in"
            disabled={!ready}
            onClick={() => setReaderZoom(zoom * 1.2)}
          />
          <IconButton
            icon="fit_width"
            label="Fit width"
            selected={Math.abs(zoom - 1) < 0.01}
            disabled={!ready}
            onClick={() => {
              controllerRef.current?.fitWidth();
              setZoom(controllerRef.current?.currentZoom() ?? 1);
            }}
          />
        </div>
        <div className="pdfjs-search-box">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            disabled={!ready}
            placeholder="Search this PDF"
            aria-label="Search this PDF"
            onChange={event => {
              const value = event.currentTarget.value;
              setSearchQuery(value);
              if (value.trim()) setActivePanel('search');
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              activateSearch(
                searchMatches,
                activeSearchIndex + (event.shiftKey ? -1 : 1),
              );
            }}
            onFocus={() => {
              if (searchQuery) setActivePanel('search');
            }}
          />
          {searching ? (
            <span className="pdfjs-search-spinner" aria-label="Searching" />
          ) : (
            <span className="pdfjs-search-count">
              {searchQuery
                ? searchMatches.length
                  ? `${activeSearchIndex + 1}/${searchMatches.length}`
                  : '0'
                : ''}
            </span>
          )}
          <IconButton
            icon="previous"
            label="Previous search result"
            disabled={!searchMatches.length}
            onClick={() => activateSearch(searchMatches, activeSearchIndex - 1)}
          />
          <IconButton
            icon="next"
            label="Next search result"
            disabled={!searchMatches.length}
            onClick={() => activateSearch(searchMatches, activeSearchIndex + 1)}
          />
        </div>
        <div className="pdfjs-toolbar-spacer" />
        <IconButton
          icon="book"
          label="Document outline"
          selected={activePanel === 'outline'}
          disabled={!ready || !analysis?.document.toc.length}
          onClick={() => setActivePanel(panel => panel === 'outline' ? null : 'outline')}
        />
        <IconButton
          icon="highlight"
          label="Paper references"
          selected={activePanel === 'references'}
          disabled={!ready || !analysis?.references.length}
          onClick={() => setActivePanel(panel => panel === 'references' ? null : 'references')}
        />
        <IconButton
          icon="comments"
          label={`Comments${comments.length ? ` (${comments.length})` : ''}`}
          selected={activePanel === 'comments'}
          disabled={!ready}
          onClick={() => setActivePanel(panel => panel === 'comments' ? null : 'comments')}
        />
        <span className="pdfjs-status" title={status}>
          <i className={ready ? 'ready' : ''} />
          {ready ? `${controllerRef.current?.pageCount() ?? 0} pages` : status}
        </span>
      </header>}
      <div ref={scrollRef} className="pdfjs-scroll">
        <div ref={contentRef} className="pdfjs-content" />
      </div>
      <div
        className={`pdfjs-loading-veil ${ready ? 'ready' : ''}`}
        aria-hidden={ready}
      >
        {previewUrl && (
          <img
            className="pdfjs-loading-preview"
            src={previewUrl}
            alt=""
          />
        )}
        <span>
          <i className="pdfjs-loading-spinner" aria-hidden="true" />
          {status}
        </span>
      </div>
      {context && (
        <div
          className="pdfjs-selection-toolbar"
          role="toolbar"
          aria-label={selection ? 'Text selection actions' : 'Annotation actions'}
          style={{
            left: Math.max(
              12,
              Math.min(
                window.innerWidth - 342,
                context.left + context.width / 2 - 165,
              ),
            ),
            top:
              context.bottom + 54 < window.innerHeight
                ? context.bottom + 10
                : Math.max(54, context.top - 48),
          }}
          onPointerDown={event => event.preventDefault()}
        >
          {HIGHLIGHT_COLORS.map(color => (
            <button
              key={color}
              type="button"
              className={`pdfjs-color-button color-${color}`}
              aria-label={`${color} highlight`}
              aria-pressed={activeAnnotation?.color === color}
              onClick={() => addHighlight(color)}
            />
          ))}
          <span className="pdfjs-selection-divider" />
          <button
            type="button"
            className="pdfjs-selection-action"
            aria-label="Copy selected text"
            title="Copy"
            onClick={() => void copyContextText()}
          >
            <Icon name="copy" />
          </button>
          <button
            type="button"
            className="pdfjs-selection-action"
            aria-label={activeAnnotation?.comment ? 'Edit note' : 'Add note'}
            title={activeAnnotation?.comment ? 'Edit note' : 'Add note'}
            onClick={openCommentEditor}
          >
            <Icon name="note" />
          </button>
          {activeAnnotation && (
            <button
              type="button"
              className="danger"
              aria-label="Delete annotation"
              onClick={removeActiveAnnotation}
            >
              Delete
            </button>
          )}
        </div>
      )}
      {hoveredLink && !context && (
        <LiveAnchoredCard
          className="pdfjs-link-card"
          resolveAnchor={resolveHoveredLinkAnchor}
          gap={12}
          onPointerEnter={cancelLinkHoverExit}
          onPointerLeave={scheduleLinkHoverExit}
        >
          <span><Icon name={hoveredLink.link.synthetic ? 'highlight' : 'document'} /></span>
          <div>
            <strong>{citationPreview(hoveredLink.link, analysis).title}</strong>
            <small>{citationPreview(hoveredLink.link, analysis).detail}</small>
          </div>
          <Icon name="next" />
        </LiveAnchoredCard>
      )}
      {citationFocus && !context && (
        <LiveAnchoredCard
          className="pdfjs-citation-card"
          resolveAnchor={resolveCitationAnchor}
          onPointerDown={event => event.stopPropagation()}
        >
          <header>
            <span><Icon name="highlight" /></span>
            <div>
              <strong>
                {citationFocus.citation.numbers.length > 1
                  ? `${citationFocus.citation.numbers.length} cited works`
                  : `Reference [${citationFocus.citation.numbers[0]}]`}
              </strong>
              <small>{citationFocus.citation.source}</small>
            </div>
            {selectedCitation && (
              <IconButton
                icon="close"
                label="Close citation"
                onClick={() => {
                  setSelectedCitation(null);
                  setHoveredCitation(null);
                }}
              />
            )}
          </header>
          <div className="pdfjs-citation-panel">
            {citationFocus.citation.numbers.length > 1 && (
              <div
                className={`pdfjs-citation-tabs ${
                  citationFocus.citation.numbers.length > 3 ? 'compact' : ''
                }`}
                role="tablist"
                aria-label="Works in this citation"
              >
                {citationFocus.citation.numbers.map(number => {
                  const entry = scholarly.get(number);
                  const metadata =
                    entry?.state === 'ready' ? entry.metadata : undefined;
                  return (
                    <button
                      type="button"
                      key={number}
                      role="tab"
                      aria-selected={selectedActiveCitationNumber === number}
                      aria-controls={`${citationUiId}-citation-card-${number}`}
                      onClick={() => setActiveCitationNumber(number)}
                    >
                      {citationFocus.citation.numbers.length > 3
                        ? `[${number}]`
                        : citationTabLabel(number, metadata)}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedActiveReference && selectedActiveCitationNumber !== null ? (
              <article
                key={selectedActiveCitationNumber}
                className="pdfjs-citation-preview"
                id={`${citationUiId}-citation-card-${selectedActiveCitationNumber}`}
                role="tabpanel"
              >
                <div className="pdfjs-citation-preview-copy">
                  <h2>
                    {compactReferenceTitle(
                      selectedActiveReference,
                      selectedActiveMetadata,
                    )}
                  </h2>
                  <p className="pdfjs-citation-byline">
                    {!selectedActiveEntry ||
                    selectedActiveEntry.state === 'loading' ? (
                      <span className="pdfjs-citation-lookup-state">
                        <i aria-hidden="true" />
                        Metadata lookup in progress
                      </span>
                    )
                      : selectedActiveEntry?.state === 'failed'
                        ? selectedActiveEntry.error
                        : citationBibliographyLine(selectedActiveMetadata)}
                  </p>
                  {selectedActiveSummary ? (
                    <section className="pdfjs-citation-summary">
                      <span>{selectedActiveSummary.label}</span>
                      <p>{selectedActiveSummary.text}</p>
                    </section>
                  ) : (
                    <blockquote>{selectedActiveReference.text}</blockquote>
                  )}
                </div>
                <footer>
                  <button
                    type="button"
                    className="pdfjs-citation-show-more"
                    onClick={() => {
                      setSelectedCitation(citationFocus);
                      setActiveCitationNumber(selectedActiveCitationNumber);
                      setExpandedCitationNumber(selectedActiveCitationNumber);
                    }}
                  >
                    Show more
                    <Icon name="expand" />
                  </button>
                  <button
                    type="button"
                    className="pdfjs-citation-reference-action"
                    onClick={() =>
                      controllerRef.current?.scrollToBounds(
                        selectedActiveReference.page,
                        {
                          left: selectedActiveReference.xFraction ?? 0,
                          right: selectedActiveReference.xFraction ?? 0,
                          top: selectedActiveReference.yFraction ?? 0,
                          bottom: selectedActiveReference.yFraction ?? 0,
                        },
                      )
                    }
                  >
                    Go to reference
                    <span>Page {selectedActiveReference.page + 1}</span>
                  </button>
                </footer>
              </article>
            ) : (
              <EmptyState
                icon="book"
                title="Reference unavailable"
                detail="This citation could not be matched to the document reference list."
              />
            )}
          </div>
        </LiveAnchoredCard>
      )}
      {externalCitation && !context && (
        <LiveAnchoredCard
          className="pdfjs-citation-card pdfjs-external-citation-card"
          resolveAnchor={resolveExternalCitationAnchor}
          onPointerDown={event => event.stopPropagation()}
        >
          <header>
            <span><Icon name="highlight" /></span>
            <div>
              <strong>Linked research</strong>
              <small>
                {externalCitation.entry.state === 'loading'
                  ? 'Resolving scholarly metadata…'
                  : externalCitation.entry.state === 'failed'
                    ? 'Metadata unavailable'
                    : externalCitationMetadata?.sources?.join(' + ') ??
                      externalCitationMetadata?.source ??
                      'Scholarly link'}
              </small>
            </div>
            <IconButton
              icon="close"
              label="Close linked research"
              onClick={() => {
                externalCitationRequestRef.current += 1;
                setExternalCitation(null);
                setExternalCitationExpanded(false);
              }}
            />
          </header>
          <div className="pdfjs-citation-panel">
            <article className="pdfjs-citation-preview">
              <div className="pdfjs-citation-preview-copy">
                <h2>
                  {externalCitationMetadata?.title ??
                    (externalCitation.entry.state === 'loading'
                      ? 'Looking up this work…'
                      : 'Scholarly resource')}
                </h2>
                <p className="pdfjs-citation-byline">
                  {externalCitation.entry.state === 'loading' ? (
                    <span className="pdfjs-citation-lookup-state">
                      <i aria-hidden="true" />
                      Metadata lookup in progress
                    </span>
                  )
                    : externalCitation.entry.state === 'failed'
                      ? externalCitation.entry.error
                      : citationBibliographyLine(externalCitationMetadata)}
                </p>
                {externalCitationSummary ? (
                  <section className="pdfjs-citation-summary">
                    <span>{externalCitationSummary.label}</span>
                    <p>{externalCitationSummary.text}</p>
                  </section>
                ) : (
                  <blockquote>
                    {externalCitation.link.target.kind === 'external'
                      ? externalCitation.link.target.url
                      : 'Linked research resource'}
                  </blockquote>
                )}
              </div>
              <footer>
                <button
                  type="button"
                  className="pdfjs-citation-show-more"
                  disabled={externalCitation.entry.state !== 'ready'}
                  onClick={() => setExternalCitationExpanded(true)}
                >
                  Show more
                  <Icon name="expand" />
                </button>
                {externalCitation.link.target.kind === 'external' && (
                  <a
                    className="pdfjs-citation-reference-action"
                    href={externalCitation.link.target.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open original link
                    <span>
                      {new URL(externalCitation.link.target.url).hostname}
                    </span>
                  </a>
                )}
              </footer>
            </article>
          </div>
        </LiveAnchoredCard>
      )}
      {activePanel === 'search' && (
        <PanelShell
          title="Search"
          detail={
            searching
              ? 'Searching document…'
              : `${searchMatches.length} ${searchMatches.length === 1 ? 'result' : 'results'}`
          }
          icon="search"
          onClose={() => setActivePanel(null)}
          className="pdfjs-reader-panel"
        >
          {searchMatches.length ? (
            <div className="pdfjs-result-list">
              {searchMatches.map((match, index) => (
                <button
                  type="button"
                  key={match.id}
                  className={index === activeSearchIndex ? 'active' : ''}
                  onClick={() => activateSearch(searchMatches, index)}
                >
                  <span>Page {match.page + 1}</span>
                  <p>{match.preview}</p>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="search"
              title={searchQuery ? 'No matches' : 'Search this document'}
              detail={
                searchQuery
                  ? `Nothing matched “${searchQuery}”.`
                  : 'Type in the search field to find text across every page.'
              }
            />
          )}
        </PanelShell>
      )}
      {activePanel === 'outline' && (
        <PanelShell
          title="Document outline"
          detail={`${analysis?.document.toc.length ?? 0} sections`}
          icon="book"
          onClose={() => setActivePanel(null)}
          className="pdfjs-reader-panel"
        >
          {analysis?.document.toc.length ? (
            <nav className="pdfjs-outline-list" aria-label="Document outline">
              {analysis.document.toc.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.page}-${entry.title}-${index}`}
                  style={{ '--outline-depth': entry.depth } as React.CSSProperties}
                  onClick={() =>
                    controllerRef.current?.scrollToBounds(entry.page, {
                      left: 0,
                      right: 0,
                      top: entry.destinationY ?? 0,
                      bottom: entry.destinationY ?? 0,
                    })
                  }
                >
                  <span>{entry.title}</span>
                  <small>{entry.page + 1}</small>
                </button>
              ))}
            </nav>
          ) : (
            <EmptyState
              icon="book"
              title="No document outline"
              detail="This PDF does not contain a table of contents."
            />
          )}
        </PanelShell>
      )}
      {activePanel === 'references' && (
        <PanelShell
          title="Paper references"
          detail={
            analysis
              ? `${analysis.references.length} references · processed in ${Math.round(analysis.processingMs)} ms`
              : 'Analysing paper structure…'
          }
          icon="highlight"
          onClose={() => setActivePanel(null)}
          className="pdfjs-reader-panel references"
        >
          {analysis?.references.length ? (
            <div className="pdfjs-reference-list">
              {analysis.references.map(reference => (
                <button
                  type="button"
                  key={`${reference.number}-${reference.page}`}
                  onClick={() =>
                    controllerRef.current?.scrollToBounds(reference.page, {
                      left: reference.xFraction ?? 0,
                      right: reference.xFraction ?? 0,
                      top: reference.yFraction ?? 0,
                      bottom: reference.yFraction ?? 0,
                    })
                  }
                >
                  <strong>[{reference.number}]</strong>
                  <p>{reference.text}</p>
                  <small>Page {reference.page + 1}</small>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="highlight"
              title="No references detected"
              detail="The backend did not find a sufficiently reliable reference section."
            />
          )}
        </PanelShell>
      )}
      {externalCitationExpanded &&
        externalCitation &&
        externalCitationMetadata && (
          <div
            className="pdfjs-citation-modal-backdrop"
            onPointerDown={event => {
              if (event.target === event.currentTarget) {
                setExternalCitationExpanded(false);
              }
            }}
          >
            <section
              ref={citationDialogRef}
              className="pdfjs-citation-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${citationUiId}-external-citation-modal-title`}
              tabIndex={-1}
              onPointerDown={event => event.stopPropagation()}
            >
              <header>
                <div>
                  <span>
                    {(externalCitationMetadata.sources?.length
                      ? externalCitationMetadata.sources
                      : [externalCitationMetadata.source]
                    ).join(' + ')}
                  </span>
                  <h2 id={`${citationUiId}-external-citation-modal-title`}>
                    {externalCitationMetadata.title}
                  </h2>
                  <p>{citationBibliographyLine(externalCitationMetadata)}</p>
                </div>
                <IconButton
                  icon="close"
                  label="Close linked research details"
                  onClick={() => setExternalCitationExpanded(false)}
                />
              </header>
              <div className="pdfjs-citation-modal-body">
                {externalCitationMetadata.tldrText && (
                  <section className="pdfjs-citation-modal-tldr">
                    <span>TLDR</span>
                    <p>{externalCitationMetadata.tldrText}</p>
                  </section>
                )}
                <section className="pdfjs-citation-provenance">
                  <h3>Source details</h3>
                  <dl>
                    <div>
                      <dt>Metadata</dt>
                      <dd>
                        {(externalCitationMetadata.sources?.length
                          ? externalCitationMetadata.sources
                          : [externalCitationMetadata.source]
                        ).join(' + ')}
                      </dd>
                    </div>
                    {externalCitationMetadata.doi && (
                      <div>
                        <dt>DOI</dt>
                        <dd>{externalCitationMetadata.doi}</dd>
                      </div>
                    )}
                    {externalCitationMetadata.openAccess !== undefined && (
                      <div>
                        <dt>Access</dt>
                        <dd>
                          {externalCitationMetadata.openAccess
                            ? 'Open access'
                            : 'Not marked open access'}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>In this PDF</dt>
                      <dd>External link · page {externalCitation.link.page + 1}</dd>
                    </div>
                  </dl>
                </section>
                {externalCitationMetadata.abstractText && (
                  <section className="pdfjs-citation-modal-abstract">
                    <h3>Abstract</h3>
                    <p>{externalCitationMetadata.abstractText}</p>
                  </section>
                )}
              </div>
              <footer>
                <nav aria-label="Scholarly resource links">
                  {externalCitationLinks.map(link => (
                    <a
                      key={`${link.label}-${link.url}`}
                      className={link.emphasis}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.label}
                    </a>
                  ))}
                </nav>
              </footer>
            </section>
          </div>
        )}
      {expandedCitationNumber !== null &&
        selectedCitation &&
        selectedActiveReference &&
        selectedActiveCitationNumber === expandedCitationNumber && (
          <div
            className="pdfjs-citation-modal-backdrop"
            onPointerDown={event => {
              if (event.target === event.currentTarget) {
                setExpandedCitationNumber(null);
              }
            }}
          >
            <section
              ref={citationDialogRef}
              className="pdfjs-citation-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${citationUiId}-citation-modal-title`}
              tabIndex={-1}
              onPointerDown={event => event.stopPropagation()}
            >
              <header>
                <div>
                  <span>
                    Reference [{selectedActiveCitationNumber}]
                    {selectedActiveMetadata
                      ? ` · ${(selectedActiveMetadata.sources?.length
                          ? selectedActiveMetadata.sources
                          : [selectedActiveMetadata.source]
                        ).join(' + ')}`
                      : ''}
                  </span>
                  <h2 id={`${citationUiId}-citation-modal-title`}>
                    {compactReferenceTitle(
                      selectedActiveReference,
                      selectedActiveMetadata,
                    )}
                  </h2>
                  <p>{citationBibliographyLine(selectedActiveMetadata)}</p>
                </div>
                <IconButton
                  icon="close"
                  label="Close citation details"
                  onClick={() => setExpandedCitationNumber(null)}
                />
              </header>
              <div className="pdfjs-citation-modal-body">
                {selectedActiveMetadata?.tldrText && (
                  <section className="pdfjs-citation-modal-tldr">
                    <span>TLDR</span>
                    <p>{selectedActiveMetadata.tldrText}</p>
                  </section>
                )}
                <section className="pdfjs-citation-provenance">
                  <h3>Source details</h3>
                  <dl>
                    {selectedActiveMetadata && (
                      <>
                        <div>
                          <dt>Metadata</dt>
                          <dd>
                            {(selectedActiveMetadata.sources?.length
                              ? selectedActiveMetadata.sources
                              : [selectedActiveMetadata.source]
                            ).join(' + ')}
                          </dd>
                        </div>
                        {selectedActiveMetadata.certainty && (
                          <div>
                            <dt>Match</dt>
                            <dd>{selectedActiveMetadata.certainty} confidence</dd>
                          </div>
                        )}
                        {selectedActiveMetadata.doi && (
                          <div>
                            <dt>DOI</dt>
                            <dd>{selectedActiveMetadata.doi}</dd>
                          </div>
                        )}
                        {selectedActiveMetadata.openAccess !== undefined && (
                          <div>
                            <dt>Access</dt>
                            <dd>
                              {selectedActiveMetadata.openAccess
                                ? 'Open access'
                                : 'Not marked open access'}
                            </dd>
                          </div>
                        )}
                      </>
                    )}
                    <div>
                      <dt>In this PDF</dt>
                      <dd>Reference list · page {selectedActiveReference.page + 1}</dd>
                    </div>
                  </dl>
                </section>
                {selectedActiveMetadata?.abstractText && (
                  <section className="pdfjs-citation-modal-abstract">
                    <h3>Abstract</h3>
                    <p>{selectedActiveMetadata.abstractText}</p>
                  </section>
                )}
                <section className="pdfjs-citation-original-reference">
                  <h3>Original reference</h3>
                  <blockquote>{selectedActiveReference.text}</blockquote>
                </section>
              </div>
              <footer>
                <nav aria-label="Citation links">
                  {selectedActiveLinks.map(link => (
                    <a
                      key={`${link.label}-${link.url}`}
                      className={link.emphasis}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.label}
                    </a>
                  ))}
                </nav>
                <button
                  type="button"
                  onClick={() => {
                    controllerRef.current?.scrollToBounds(
                      selectedActiveReference.page,
                      {
                        left: selectedActiveReference.xFraction ?? 0,
                        right: selectedActiveReference.xFraction ?? 0,
                        top: selectedActiveReference.yFraction ?? 0,
                        bottom: selectedActiveReference.yFraction ?? 0,
                      },
                    );
                    setExpandedCitationNumber(null);
                  }}
                >
                  Go to reference
                </button>
              </footer>
            </section>
          </div>
        )}
      {commentDraft && commentAnchorRect && (
        <div
          className={`pdfjs-comment-anchor-card ${
            commentEditorExpanded ? 'expanded' : ''
          }`}
          style={{
            left: Math.max(
              12,
              Math.min(
                window.innerWidth - (commentEditorExpanded ? 390 : 220),
                commentAnchorRect.left,
              ),
            ),
            top:
              commentAnchorRect.bottom + (commentEditorExpanded ? 300 : 52) <
              window.innerHeight
                ? commentAnchorRect.bottom + 8
                : Math.max(
                    52,
                    commentAnchorRect.top -
                      (commentEditorExpanded ? 292 : 48),
                  ),
          }}
        >
          {!commentEditorExpanded ? (
            <>
              <span><Icon name="comments" /></span>
              <button
                type="button"
                className="pdfjs-comment-anchor-open"
                onClick={() => setCommentEditorExpanded(true)}
              >
                Add comment
              </button>
              <IconButton
                icon="expand"
                label="Expand comment editor"
                onClick={() => setCommentEditorExpanded(true)}
              />
            </>
          ) : (
            <div className="pdfjs-comment-editor">
              <blockquote>{commentDraft.text.trim() || 'Selected text'}</blockquote>
              <MarkdownEditor
                autoFocus
                value={commentDraft.comment}
                placeholder="Write a comment…"
                ariaLabel="Comment"
                onChange={comment => {
                  setCommentError('');
                  setCommentDraft({ ...commentDraft, comment });
                }}
              />
              {commentError && <p className="pdfjs-comment-error">{commentError}</p>}
              <div className="pdfjs-comment-actions">
                <button
                  type="button"
                  onClick={() => {
                    setCommentDraft(null);
                    setCommentAnchorRect(null);
                    setCommentEditorExpanded(false);
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="primary" onClick={saveComment}>
                  Save comment
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
});

export default PdfJsBenchmarkApp;
