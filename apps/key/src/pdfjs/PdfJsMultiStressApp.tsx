import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
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

interface OpenDocument {
  name: string;
  nativeId: string;
  document: PDFDocumentProxy;
  controller: PdfJsTileController;
  overlay: PdfJsTextOverlayManager;
  pane: HTMLDivElement;
}

interface FrameSummary {
  median: number;
  p95: number;
  maximum: number;
  framesOver20Ms: number;
}

interface MultiStressResult {
  schemaVersion: 1;
  documentCount: number;
  totalSourceBytes: number;
  loadMs: number;
  stressMs: number;
  switchLatencyMs: FrameSummary;
  frameIntervals: FrameSummary;
  exactSettleMs: FrameSummary;
  cache: {
    residentBytes: number;
    peakResidentBytes: number;
    fallbackBytes: number;
    residentTiles: number;
    perDocumentBudgetBytes: number;
    aggregateNominalBudgetBytes: number;
  };
  cycles: number;
}

declare global {
  interface Window {
    __PDFJS_MULTI_STRESS_RESULT__?: MultiStressResult;
    __PDFJS_MULTI_STRESS_ERROR__?: string;
  }
}

const nextFrame = () =>
  new Promise<number>(resolve => requestAnimationFrame(resolve));

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const summary = (values: number[]): FrameSummary => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  maximum: Math.max(0, ...values),
  framesOver20Ms: values.filter(value => value > 20).length,
});

function setPlacement(
  documents: OpenDocument[],
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
    recentDocuments
      .filter(index => !active.has(index))
      .slice(-4),
  );

  // Release inactive high-resolution canvases before promoting the next pair,
  // so a switch never temporarily holds more than two full tile caches.
  documents.forEach((entry, index) => {
    if (!active.has(index)) {
      entry.controller.suspendRaster(previewWarm.has(index));
    }
  });
  documents.forEach((entry, index) => {
    const visible = active.has(index);
    entry.pane.style.visibility = visible ? 'visible' : 'hidden';
    entry.pane.style.pointerEvents = visible ? 'auto' : 'none';
    entry.pane.style.zIndex = visible ? '2' : '1';
    entry.pane.style.left = index === secondary ? '50%' : '0';
    if (visible) entry.controller.resumeRaster();
  });
}

export default function PdfJsMultiStressApp() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState('Preparing 12-document stress test…');

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;
    const openDocuments: OpenDocument[] = [];
    const recentDocuments: number[] = [];

    const run = async () => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      window.__PDFJS_MULTI_STRESS_RESULT__ = undefined;
      window.__PDFJS_MULTI_STRESS_ERROR__ = undefined;
      await invoke('benchmark_phase', { name: 'baseline-ready' });
      await new Promise(resolve => window.setTimeout(resolve, 600));

      const names = await invoke<string[]>('benchmark_fixture_names');
      if (names.length < 10) {
        throw new Error(`Multi-PDF benchmark requires at least 10 fixtures; received ${names.length}`);
      }
      const loadStart = performance.now();
      let totalSourceBytes = 0;

      for (let index = 0; index < names.length; index += 1) {
        if (disposed) return;
        await invoke('benchmark_phase', { name: `loading-${index + 1}` });
        setStatus(`Opening and preprocessing ${index + 1}/${names.length}…`);
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
        const companionPromise = openNativeCompanion(file, bytes.slice());
        const documentProxy = await getDocument({ data: bytes.slice() }).promise;
        const sourcePages = await Promise.all(
          Array.from({ length: documentProxy.numPages }, async (_, pageIndex) => {
            const page = await documentProxy.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale: 1 });
            return { page, width: viewport.width, height: viewport.height };
          }),
        );
        const companion = await companionPromise;

        const pane = document.createElement('div');
        pane.className = 'pdfjs-stress-pane';
        pane.dataset.documentName = fixture.name;
        const scroll = document.createElement('div');
        scroll.className = 'pdfjs-scroll';
        const content = document.createElement('div');
        content.className = 'pdfjs-content';
        scroll.append(content);
        pane.append(scroll);
        workspace.append(pane);

        const controller = new PdfJsTileController(
          scroll,
          content,
          documentProxy,
          sourcePages,
        );
        const overlay = new PdfJsTextOverlayManager(
          companion.id,
          controller.pageHosts(),
        );
        if (companion.analysis) {
          overlay.setLinks([
            ...companion.analysis.document.links,
            ...companion.analysis.syntheticLinks.map(link => ({
              ...link,
              synthetic: true,
            })),
          ]);
        }
        controller.onVisiblePages(pages => {
          const demand = pages.flatMap(page => [page - 1, page, page + 1]);
          void overlay.ensurePages(
            demand.filter(page => page >= 0 && page < documentProxy.numPages),
          );
        });
        await controller.waitForExact(10_000);
        await overlay.ensurePage(0);
        openDocuments.push({
          name: fixture.name,
          nativeId: companion.id,
          document: documentProxy,
          controller,
          overlay,
          pane,
        });
        setPlacement(
          openDocuments,
          Math.max(0, index - 1),
          index,
          recentDocuments,
        );
        await invoke('benchmark_phase', { name: `loaded-${index + 1}` });
        await nextFrame();
      }

      const loadMs = performance.now() - loadStart;
      await invoke('benchmark_phase', { name: 'loaded-all' });
      await new Promise(resolve => window.setTimeout(resolve, 1_000));
      const cycles = 72;
      const switchLatencies: number[] = [];
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

      setStatus(`Stress switching ${names.length} documents in split view…`);
      await invoke('benchmark_phase', { name: 'stress' });
      const stressStart = performance.now();
      const zooms = [0.7, 1.25, 1.8, 0.9, 2.35, 1.05];
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const primary = cycle % openDocuments.length;
        let secondary = (cycle * 5 + 3) % openDocuments.length;
        if (secondary === primary) secondary = (secondary + 1) % openDocuments.length;
        const switchedAt = performance.now();
        setPlacement(openDocuments, primary, secondary, recentDocuments);
        await nextFrame();
        switchLatencies.push(performance.now() - switchedAt);

        const primaryController = openDocuments[primary].controller;
        const secondaryController = openDocuments[secondary].controller;
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
      const stressMs = performance.now() - stressStart;
      await Promise.all(
        openDocuments
          .filter(entry => entry.pane.style.visibility === 'visible')
          .map(entry => entry.controller.waitForExact(10_000)),
      );
      await new Promise(resolve => window.setTimeout(resolve, 1_000));
      frameSampling = false;

      const caches = openDocuments.map(entry => entry.controller.cacheMetrics());
      const result: MultiStressResult = {
        schemaVersion: 1,
        documentCount: openDocuments.length,
        totalSourceBytes,
        loadMs,
        stressMs,
        switchLatencyMs: summary(switchLatencies),
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
          perDocumentBudgetBytes: caches[0]?.budgetBytes ?? 0,
          aggregateNominalBudgetBytes: caches.reduce(
            (sum, cache) => sum + cache.budgetBytes,
            0,
          ),
        },
        cycles,
      };
      window.__PDFJS_MULTI_STRESS_RESULT__ = result;
      await invoke('benchmark_phase', { name: 'settled' });
      await invoke('benchmark_report', { payload: result });
      setStatus('Stress test complete');
    };

    void run().catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      window.__PDFJS_MULTI_STRESS_ERROR__ = message;
      setStatus(`Stress test failed: ${message}`);
      await invoke('benchmark_report', {
        payload: { error: message },
      }).catch(() => undefined);
    });

    return () => {
      disposed = true;
      for (const entry of openDocuments) {
        entry.overlay.destroy();
        void entry.controller.destroy();
        void closeNativeCompanion(entry.nativeId);
      }
      openDocuments.length = 0;
    };
  }, []);

  return (
    <main className="pdfjs-multi-stress">
      <div className="pdfjs-stress-status">{status}</div>
      <div className="pdfjs-stress-workspace" ref={workspaceRef} />
    </main>
  );
}
