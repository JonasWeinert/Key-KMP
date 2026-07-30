import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getDocument } from 'pdfjs-dist';
import type { NativeLink } from '../engines/types';
import { PdfJsTileController } from './PdfJsBenchmarkApp';
import { PdfJsTextOverlayManager } from './text-overlays';
import {
  closeNativeCompanion,
  openNativeCompanion,
} from './reader-model';

interface BenchmarkFixture {
  name: string;
  bytes: number[];
}

interface StoredDocument {
  name: string;
  bytes: Uint8Array;
  nativeId: string;
  backendOpen: boolean;
  lastModified: number;
  links: Array<NativeLink & { synthetic?: boolean }>;
  pane: HTMLDivElement;
  controller?: PdfJsTileController;
  overlay?: PdfJsTextOverlayManager;
  zoom: number;
  scrollFraction: number;
}

interface Summary {
  median: number;
  p95: number;
  maximum: number;
  framesOver20Ms: number;
}

interface MultiStressResult {
  schemaVersion: 1;
  policy: 'two-active-64mib-tiles-inactive-state-preview-only';
  documentCount: number;
  liveFrontendDocuments: number;
  totalSourceBytes: number;
  loadMs: number;
  stressMs: number;
  switchLatencyMs: Summary;
  frontendReloadMs: Summary;
  frameIntervals: Summary;
  exactSettleMs: Summary;
  cache: {
    residentBytes: number;
    peakResidentBytes: number;
    fallbackBytes: number;
    residentTiles: number;
  };
  cycles: number;
}

declare global {
  interface Window {
    __PDFJS_MULTI_EVICTION_RESULT__?: MultiStressResult;
    __PDFJS_MULTI_EVICTION_ERROR__?: string;
  }
}

const nextFrame = () =>
  new Promise<number>(resolve => requestAnimationFrame(resolve));

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const summary = (values: number[]): Summary => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  maximum: Math.max(0, ...values),
  framesOver20Ms: values.filter(value => value > 20).length,
});

function capturePreview(entry: StoredDocument) {
  const source = entry.pane.querySelector<HTMLCanvasElement>(
    '.pdfjs-page-fallback',
  );
  const sourcePage = source?.closest<HTMLElement>('.pdfjs-page');
  if (!source || !sourcePage) return undefined;
  const paneRect = entry.pane.getBoundingClientRect();
  const pageRect = sourcePage.getBoundingClientRect();
  const preview = document.createElement('canvas');
  preview.className = 'pdfjs-stress-snapshot';
  preview.width = source.width;
  preview.height = source.height;
  preview.getContext('2d', { alpha: false })?.drawImage(source, 0, 0);
  preview.style.left = `${pageRect.left - paneRect.left}px`;
  preview.style.top = `${pageRect.top - paneRect.top}px`;
  preview.style.width = `${pageRect.width}px`;
  preview.style.height = `${pageRect.height}px`;
  return preview;
}

async function unmountFrontend(entry: StoredDocument, keepPreview: boolean) {
  const controller = entry.controller;
  if (!controller) {
    if (entry.backendOpen) {
      await closeNativeCompanion(entry.nativeId);
      entry.backendOpen = false;
    }
    if (!keepPreview) entry.pane.replaceChildren();
    return;
  }
  const preview = keepPreview ? capturePreview(entry) : undefined;
  entry.zoom = controller.currentZoom();
  entry.scrollFraction = controller.currentScrollFraction();
  entry.overlay?.destroy();
  entry.overlay = undefined;
  entry.controller = undefined;
  await controller.destroy();
  if (entry.backendOpen) {
    await closeNativeCompanion(entry.nativeId);
    entry.backendOpen = false;
  }
  entry.pane.replaceChildren();
  if (preview) entry.pane.append(preview);
}

async function mountFrontend(entry: StoredDocument) {
  if (entry.controller) return 0;
  const startedAt = performance.now();
  const scroll = document.createElement('div');
  scroll.className = 'pdfjs-scroll';
  const content = document.createElement('div');
  content.className = 'pdfjs-content';
  scroll.append(content);
  entry.pane.append(scroll);

  const file = new File([entry.bytes.slice().buffer as ArrayBuffer], entry.name, {
    type: 'application/pdf',
    lastModified: entry.lastModified,
  });
  const [documentProxy, companion] = await Promise.all([
    getDocument({ data: entry.bytes.slice() }).promise,
    openNativeCompanion(file, entry.bytes.slice()),
  ]);
  entry.nativeId = companion.id;
  entry.backendOpen = true;
  if (companion.analysis) {
    entry.links = [
      ...companion.analysis.document.links,
      ...companion.analysis.syntheticLinks.map(link => ({
        ...link,
        synthetic: true,
      })),
    ];
  }
  const sourcePages = await Promise.all(
    Array.from({ length: documentProxy.numPages }, async (_, pageIndex) => {
      const page = await documentProxy.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      return { page, width: viewport.width, height: viewport.height };
    }),
  );
  const controller = new PdfJsTileController(
    scroll,
    content,
    documentProxy,
    sourcePages,
    32 * 1024 * 1024,
  );
  const overlay = new PdfJsTextOverlayManager(
    entry.nativeId,
    controller.pageHosts(),
  );
  overlay.setLinks(entry.links);
  controller.onVisiblePages(pages => {
    const demand = pages.flatMap(page => [page - 1, page, page + 1]);
    void overlay.ensurePages(
      demand.filter(page => page >= 0 && page < documentProxy.numPages),
    );
  });
  entry.controller = controller;
  entry.overlay = overlay;
  if (Math.abs(entry.zoom - 1) > 0.001) controller.setZoom(entry.zoom);
  controller.scrollToFraction(entry.scrollFraction);
  await controller.waitForExact(10_000);
  await overlay.ensurePage(0);
  entry.pane.querySelector('.pdfjs-stress-snapshot')?.remove();
  return performance.now() - startedAt;
}

async function activatePair(
  documents: StoredDocument[],
  primary: number,
  secondary: number,
  recentDocuments: number[],
) {
  const active = new Set([primary, secondary]);
  for (const index of [primary, secondary]) {
    const previous = recentDocuments.indexOf(index);
    if (previous >= 0) recentDocuments.splice(previous, 1);
    recentDocuments.push(index);
  }
  const previewWarm = new Set(
    recentDocuments.filter(index => !active.has(index)).slice(-4),
  );

  documents.forEach((entry, index) => {
    const visible = active.has(index);
    entry.pane.style.visibility = visible ? 'visible' : 'hidden';
    entry.pane.style.pointerEvents = visible ? 'auto' : 'none';
    entry.pane.style.zIndex = visible ? '2' : '1';
    entry.pane.style.left = index === secondary ? '50%' : '0';
  });

  const unmounts: Promise<void>[] = [];
  documents.forEach((entry, index) => {
    if (active.has(index) || !entry.controller) return;
    unmounts.push(unmountFrontend(entry, previewWarm.has(index)));
  });
  await Promise.all(unmounts);
  for (const [index, entry] of documents.entries()) {
    if (
      !active.has(index) &&
      !previewWarm.has(index) &&
      !entry.controller
    ) {
      entry.pane.replaceChildren();
    }
  }
  return Promise.all(
    [...active].map(index => mountFrontend(documents[index])),
  );
}

export default function PdfJsMultiEvictionStressApp() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState('Preparing 12-document eviction test…');

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;
    const documents: StoredDocument[] = [];
    const recentDocuments: number[] = [];

    const run = async () => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      window.__PDFJS_MULTI_EVICTION_RESULT__ = undefined;
      window.__PDFJS_MULTI_EVICTION_ERROR__ = undefined;
      await invoke('benchmark_phase', { name: 'baseline-ready' });
      await new Promise(resolve => window.setTimeout(resolve, 600));

      const names = await invoke<string[]>('benchmark_fixture_names');
      if (names.length < 10) {
        throw new Error(`Multi-PDF benchmark requires at least 10 fixtures; received ${names.length}`);
      }
      const loadStartedAt = performance.now();
      let totalSourceBytes = 0;
      for (let index = 0; index < names.length; index += 1) {
        if (disposed) return;
        await invoke('benchmark_phase', { name: `loading-${index + 1}` });
        setStatus(`Preprocessing ${index + 1}/${names.length}; frontend remains evicted…`);
        const fixture = await invoke<BenchmarkFixture | null>('benchmark_fixture_at', {
          index,
        });
        if (!fixture) throw new Error(`Fixture ${index} disappeared`);
        const bytes = Uint8Array.from(fixture.bytes);
        totalSourceBytes += bytes.byteLength;
        const file = new File([bytes], fixture.name, {
          type: 'application/pdf',
          lastModified: index + 1,
        });
        const companion = await openNativeCompanion(file, bytes.slice());
        // Inactive tabs retain only the returned preprocessing metadata.
        // Native text/search state is rebuilt when a tab becomes visible.
        await closeNativeCompanion(companion.id);
        const pane = document.createElement('div');
        pane.className = 'pdfjs-stress-pane';
        pane.dataset.documentName = fixture.name;
        pane.style.visibility = 'hidden';
        workspace.append(pane);
        documents.push({
          name: fixture.name,
          bytes,
          nativeId: companion.id,
          backendOpen: false,
          lastModified: index + 1,
          links: companion.analysis
            ? [
                ...companion.analysis.document.links,
                ...companion.analysis.syntheticLinks.map(link => ({
                  ...link,
                  synthetic: true,
                })),
              ]
            : [],
          pane,
          zoom: 1,
          scrollFraction: 0,
        });
        await invoke('benchmark_phase', { name: `loaded-${index + 1}` });
      }

      const initialReloads = await activatePair(
        documents,
        documents.length - 2,
        documents.length - 1,
        recentDocuments,
      );
      const loadMs = performance.now() - loadStartedAt;
      await invoke('benchmark_phase', { name: 'loaded-all' });
      await new Promise(resolve => window.setTimeout(resolve, 1_000));

      const cycles = 72;
      const switchLatencies: number[] = [];
      const reloadTimes = [...initialReloads];
      const exactSettle: number[] = [];
      const frameIntervals: number[] = [];
      let lastFrame = performance.now();
      let frameSampling = true;
      const sampleFrame = (now: number) => {
        frameIntervals.push(now - lastFrame);
        lastFrame = now;
        if (frameSampling) requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);

      setStatus(`Stress switching ${documents.length} state-only tabs…`);
      await invoke('benchmark_phase', { name: 'stress' });
      const stressStartedAt = performance.now();
      const zooms = [0.7, 1.25, 1.8, 0.9, 2.35, 1.05];
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const primary = cycle % documents.length;
        let secondary = (cycle * 5 + 3) % documents.length;
        if (secondary === primary) secondary = (secondary + 1) % documents.length;
        const switchedAt = performance.now();
        const activation = activatePair(
          documents,
          primary,
          secondary,
          recentDocuments,
        );
        await nextFrame();
        switchLatencies.push(performance.now() - switchedAt);
        reloadTimes.push(...(await activation));

        const primaryController = documents[primary].controller!;
        const secondaryController = documents[secondary].controller!;
        primaryController.scrollToFraction(((cycle * 37) % 101) / 100);
        secondaryController.scrollToFraction(((cycle * 61 + 17) % 101) / 100);
        primaryController.setZoom(zooms[cycle % zooms.length]);
        secondaryController.setZoom(zooms[(cycle + 2) % zooms.length]);
        if (cycle % 6 === 5) {
          const results = await Promise.all([
            primaryController.waitForExact(5_000),
            secondaryController.waitForExact(5_000),
          ]);
          exactSettle.push(...results.map(result => result.durationMs));
        } else {
          await new Promise(resolve => window.setTimeout(resolve, 35));
        }
      }
      const stressMs = performance.now() - stressStartedAt;
      await Promise.all(
        documents
          .flatMap(entry => (entry.controller ? [entry.controller] : []))
          .map(controller => controller.waitForExact(10_000)),
      );
      await new Promise(resolve => window.setTimeout(resolve, 1_000));
      frameSampling = false;

      const live = documents.filter(entry => entry.controller);
      const caches = live.map(entry => entry.controller!.cacheMetrics());
      const result: MultiStressResult = {
        schemaVersion: 1,
        policy: 'two-active-64mib-tiles-inactive-state-preview-only',
        documentCount: documents.length,
        liveFrontendDocuments: live.length,
        totalSourceBytes,
        loadMs,
        stressMs,
        switchLatencyMs: summary(switchLatencies),
        frontendReloadMs: summary(reloadTimes),
        frameIntervals: summary(frameIntervals),
        exactSettleMs: summary(exactSettle),
        cache: {
          residentBytes: caches.reduce((sum, cache) => sum + cache.residentBytes, 0),
          peakResidentBytes: caches.reduce(
            (sum, cache) => sum + cache.peakResidentBytes,
            0,
          ),
          fallbackBytes: caches.reduce((sum, cache) => sum + cache.fallbackBytes, 0),
          residentTiles: caches.reduce((sum, cache) => sum + cache.residentTiles, 0),
        },
        cycles,
      };
      window.__PDFJS_MULTI_EVICTION_RESULT__ = result;
      await invoke('benchmark_phase', { name: 'settled' });
      await invoke('benchmark_report', { payload: result });
      setStatus('Eviction stress test complete');
    };

    void run().catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      window.__PDFJS_MULTI_EVICTION_ERROR__ = message;
      setStatus(`Stress test failed: ${message}`);
      await invoke('benchmark_report', {
        payload: { error: message },
      }).catch(() => undefined);
    });

    return () => {
      disposed = true;
      for (const entry of documents) {
        entry.overlay?.destroy();
        if (entry.controller) void entry.controller.destroy();
        if (entry.backendOpen) void closeNativeCompanion(entry.nativeId);
      }
      documents.length = 0;
    };
  }, []);

  return (
    <main className="pdfjs-multi-stress">
      <div className="pdfjs-stress-status">{status}</div>
      <div className="pdfjs-stress-workspace" ref={workspaceRef} />
    </main>
  );
}
