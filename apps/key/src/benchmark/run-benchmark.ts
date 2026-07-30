import type { ZoomScope } from '@embedpdf/plugin-zoom';
import type { ScrollScope } from '@embedpdf/plugin-scroll';
import { canvasHasExactDeviceDensity } from '../performance/render-quality';

export interface BenchmarkResult {
  schemaVersion: 2;
  engine: 'wasm';
  userAgent: string;
  startedAt: string;
  pageCount: number;
  durationMs: number;
  frameCount: number;
  frameIntervalMs: {
    median: number;
    p95: number;
    maximum: number;
  };
  framesOverBudget: number;
  exactRenderSettleMs: {
    median: number;
    p95: number;
    maximum: number;
    timeouts: number;
  };
  scenario: {
    scrollJumps: number;
    zoomChanges: number;
  };
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function nextFrames(count: number) {
  return new Promise<void>(resolve => {
    const tick = () => {
      if (--count <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function waitForExactRender(documentId: string, timeoutMs = 5000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const pane = [...document.querySelectorAll<HTMLElement>('.pdf-pane')].find(
      candidate => candidate.dataset.documentId === documentId,
    );
    const viewport = pane?.querySelector<HTMLElement>('.pdf-viewport');
    const viewportRect = viewport?.getBoundingClientRect();
    const canvases = [
      ...(pane?.querySelectorAll<HTMLCanvasElement>('.crisp-canvas-layer') ?? []),
    ].filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        return (
          viewportRect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > viewportRect.top &&
          rect.top < viewportRect.bottom &&
          rect.right > viewportRect.left &&
          rect.left < viewportRect.right
        );
      });
    if (
      canvases.length > 0 &&
      canvases.every(
        canvas =>
          canvasHasExactDeviceDensity(
            canvas,
            canvas.getBoundingClientRect(),
            window.devicePixelRatio,
          ),
      )
    ) {
      return { durationMs: performance.now() - start, timedOut: false };
    }
    await nextFrames(1);
  }
  return { durationMs: timeoutMs, timedOut: true };
}

export async function runReaderBenchmark(
  documentId: string,
  engine: 'wasm',
  scroll: ScrollScope,
  zoom: ZoomScope,
): Promise<BenchmarkResult> {
  const frameTimes: number[] = [];
  const exactSettleTimes: number[] = [];
  let exactSettleTimeouts = 0;
  let collecting = true;
  let previous = performance.now();
  const collect = (now: number) => {
    if (!collecting) return;
    frameTimes.push(now - previous);
    previous = now;
    requestAnimationFrame(collect);
  };
  requestAnimationFrame(collect);

  const startedAt = new Date().toISOString();
  const start = performance.now();
  const pageCount = Math.max(
    scroll.getTotalPages(),
    scroll.getSpreadPagesWithRotatedSize().flat().length,
  );
  const pageTargets = [1, Math.ceil(pageCount * 0.25), Math.ceil(pageCount * 0.5), pageCount]
    .map(page => Math.max(1, Math.min(pageCount, page)));

  for (const pageNumber of pageTargets) {
    scroll.scrollToPage({ pageNumber, behavior: 'instant' });
    await nextFrames(4);
    const settled = await waitForExactRender(documentId);
    exactSettleTimes.push(settled.durationMs);
    if (settled.timedOut) exactSettleTimeouts += 1;
  }
  const zoomLevels = [1, 1.5, 2, 0.8, 1.25, 1];
  for (const level of zoomLevels) {
    zoom.requestZoom(level);
    await nextFrames(4);
    const settled = await waitForExactRender(documentId);
    exactSettleTimes.push(settled.durationMs);
    if (settled.timedOut) exactSettleTimeouts += 1;
  }
  for (const pageNumber of [...pageTargets].reverse()) {
    scroll.scrollToPage({ pageNumber, behavior: 'instant' });
    await nextFrames(4);
    const settled = await waitForExactRender(documentId);
    exactSettleTimes.push(settled.durationMs);
    if (settled.timedOut) exactSettleTimeouts += 1;
  }
  await nextFrames(10);

  collecting = false;
  const durationMs = performance.now() - start;
  const intervals = frameTimes.slice(1);
  return {
    schemaVersion: 2,
    engine,
    userAgent: navigator.userAgent,
    startedAt,
    pageCount,
    durationMs,
    frameCount: intervals.length,
    frameIntervalMs: {
      median: percentile(intervals, 0.5),
      p95: percentile(intervals, 0.95),
      maximum: Math.max(0, ...intervals),
    },
    framesOverBudget: intervals.filter(interval => interval > 20).length,
    exactRenderSettleMs: {
      median: percentile(exactSettleTimes, 0.5),
      p95: percentile(exactSettleTimes, 0.95),
      maximum: Math.max(0, ...exactSettleTimes),
      timeouts: exactSettleTimeouts,
    },
    scenario: {
      scrollJumps: pageTargets.length * 2,
      zoomChanges: zoomLevels.length,
    },
  };
}

export function downloadBenchmark(result: BenchmarkResult) {
  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], {
    type: 'application/json',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${result.engine}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
