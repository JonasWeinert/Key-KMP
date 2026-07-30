import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getDocument } from 'pdfjs-dist';
import { PdfJsTileController } from './PdfJsBenchmarkApp';

interface BenchmarkFixture {
  name: string;
  bytes: number[];
}

interface PaneReady {
  slot: number;
  generation: number;
  fixtureIndex: number;
  name: string;
  loadMs: number;
  settleMs: number;
  sourceBytes: number;
  cacheBytes: number;
}

interface PaneFirstUsable {
  slot: number;
  generation: number;
  fixtureIndex: number;
  loadMs: number;
  firstUsableMs: number;
}

const waitForPaintedCanvas = (host: HTMLElement, timeoutMs = 10_000) =>
  new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    const inspect = () => {
      if (host.querySelector('.pdfjs-tile, .pdfjs-page-fallback')) {
        resolve();
      } else if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error('first painted PDF canvas timed out'));
      } else {
        requestAnimationFrame(inspect);
      }
    };
    requestAnimationFrame(inspect);
  });

export default function PdfJsIsolatedPaneApp() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState('Loading PDF…');

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let controller: PdfJsTileController | undefined;
    let disposed = false;

    const run = async () => {
      const query = new URLSearchParams(window.location.search);
      const fixtureIndex = Number(query.get('fixtureIndex'));
      const slot = Number(query.get('slot'));
      const generation = Number(query.get('generation'));
      const scroll = scrollRef.current;
      const content = contentRef.current;
      if (!scroll || !content) throw new Error('renderer host is unavailable');

      const startedAt = performance.now();
      const fixture = await invoke<BenchmarkFixture | null>('benchmark_fixture_at', {
        index: fixtureIndex,
      });
      if (!fixture) throw new Error(`fixture ${fixtureIndex} is unavailable`);
      const bytes = Uint8Array.from(fixture.bytes);
      const documentProxy = await getDocument({ data: bytes }).promise;
      const sourcePages = await Promise.all(
        Array.from({ length: documentProxy.numPages }, async (_, pageIndex) => {
          const page = await documentProxy.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1 });
          return { page, width: viewport.width, height: viewport.height };
        }),
      );
      controller = new PdfJsTileController(
        scroll,
        content,
        documentProxy,
        sourcePages,
        32 * 1024 * 1024,
      );
      const loadMs = performance.now() - startedAt;
      await waitForPaintedCanvas(content);
      const firstUsable: PaneFirstUsable = {
        slot,
        generation,
        fixtureIndex,
        loadMs,
        firstUsableMs: performance.now() - startedAt,
      };
      await emitTo('main', 'pdf-pane-first-usable', firstUsable);

      // Exercise the same paths that cause transient peaks: far scrolls and
      // zoom changes. The low-resolution fallback remains visible while exact
      // tiles catch up, avoiding white tile gaps.
      const sequence = [
        [0.82, 1.8],
        [0.12, 0.8],
        [0.57, 2.25],
        [0.33, 1.15],
      ] as const;
      let settleMs = 0;
      for (const [scrollFraction, zoom] of sequence) {
        controller.scrollToFraction(scrollFraction);
        controller.setZoom(zoom);
        await new Promise(resolve => window.setTimeout(resolve, 24));
      }
      const settled = await controller.waitForExact(10_000);
      settleMs += settled.durationMs;
      if (disposed) return;
      const metrics = controller.cacheMetrics();
      const payload: PaneReady = {
        slot,
        generation,
        fixtureIndex,
        name: fixture.name,
        loadMs,
        settleMs,
        sourceBytes: bytes.byteLength,
        cacheBytes: metrics.residentBytes + metrics.fallbackBytes,
      };
      setStatus(fixture.name);
      await emitTo('main', 'pdf-pane-ready', payload);
    };

    void run().catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Renderer failed: ${message}`);
      await emitTo('main', 'pdf-pane-error', { message }).catch(() => undefined);
    });
    return () => {
      disposed = true;
      if (controller) void controller.destroy();
    };
  }, []);

  return (
    <main className="pdfjs-isolated-pane">
      <div className="pdfjs-isolated-pane-status">{status}</div>
      <div className="pdfjs-scroll" ref={scrollRef}>
        <div className="pdfjs-content" ref={contentRef} />
      </div>
    </main>
  );
}
