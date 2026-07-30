import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface Sidecar {
  index: number;
  name: string;
  path: string;
  bytes: number;
  elapsedMs: number;
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

interface Summary {
  median: number;
  p95: number;
  maximum: number;
}

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const summary = (values: number[]): Summary => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  maximum: Math.max(0, ...values),
});

export default function PdfJsIsolatedStressApp() {
  const startedRef = useRef(false);
  const [status, setStatus] = useState('Preparing disposable preprocessing…');

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;
    let unlistenReady: UnlistenFn | undefined;
    let unlistenFirstUsable: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;
    const liveLabels = new Map<number, string>();
    const waiters = new Map<string, {
      resolve: (value: PaneReady) => void;
      reject: (reason: Error) => void;
    }>();
    const firstUsableWaiters = new Map<string, {
      resolve: (value: PaneFirstUsable) => void;
      reject: (reason: Error) => void;
    }>();

    const run = async () => {
      const names = await invoke<string[]>('benchmark_fixture_names');
      if (names.length < 10) {
        throw new Error(`isolated benchmark requires at least 10 PDFs; received ${names.length}`);
      }
      await invoke('benchmark_phase', { name: 'baseline-ready' });
      await new Promise(resolve => window.setTimeout(resolve, 600));

      unlistenReady = await listen<PaneReady>('pdf-pane-ready', event => {
        const key = `${event.payload.slot}:${event.payload.generation}`;
        const waiter = waiters.get(key);
        if (waiter) {
          waiters.delete(key);
          waiter.resolve(event.payload);
        }
      });
      unlistenFirstUsable = await listen<PaneFirstUsable>(
        'pdf-pane-first-usable',
        event => {
          const key = `${event.payload.slot}:${event.payload.generation}`;
          const waiter = firstUsableWaiters.get(key);
          if (waiter) {
            firstUsableWaiters.delete(key);
            waiter.resolve(event.payload);
          }
        },
      );
      unlistenError = await listen<{ message: string }>('pdf-pane-error', event => {
        for (const waiter of waiters.values()) waiter.reject(new Error(event.payload.message));
        for (const waiter of firstUsableWaiters.values()) {
          waiter.reject(new Error(event.payload.message));
        }
        waiters.clear();
        firstUsableWaiters.clear();
      });

      const sidecars: Sidecar[] = [];
      const preprocessingStartedAt = performance.now();
      for (let index = 0; index < names.length; index += 1) {
        if (disposed) return;
        setStatus(`Preprocessing ${index + 1}/${names.length} in disposable PDFium helper…`);
        await invoke('benchmark_phase', { name: `preprocessing-${index + 1}` });
        sidecars.push(await invoke<Sidecar>('benchmark_preprocess_sidecar', { index }));
      }
      const preprocessingMs = performance.now() - preprocessingStartedAt;
      await invoke('benchmark_phase', { name: 'sidecars-ready' });
      await new Promise(resolve => window.setTimeout(resolve, 800));

      const openPane = async (slot: number, generation: number, fixtureIndex: number) => {
        const key = `${slot}:${generation}`;
        const completed = new Promise<PaneReady>((resolve, reject) => {
          waiters.set(key, { resolve, reject });
          window.setTimeout(() => {
            if (waiters.delete(key)) reject(new Error(`renderer ${key} timed out`));
          }, 20_000);
        });
        const firstUsable = new Promise<PaneFirstUsable>((resolve, reject) => {
          firstUsableWaiters.set(key, { resolve, reject });
          window.setTimeout(() => {
            if (firstUsableWaiters.delete(key)) {
              reject(new Error(`renderer ${key} first paint timed out`));
            }
          }, 20_000);
        });
        const label = await invoke<string>('benchmark_open_renderer', {
          slot,
          generation,
          fixtureIndex,
        });
        liveLabels.set(slot, label);
        return { firstUsable, completed };
      };

      const recyclePane = async (slot: number, generation: number, fixtureIndex: number) => {
        const oldLabel = liveLabels.get(slot);
        const startedAt = performance.now();
        if (oldLabel) {
          await invoke('benchmark_close_renderer', { label: oldLabel });
          liveLabels.delete(slot);
          // Give WebKit one frame to observe destruction before replacing it.
          await new Promise(resolve => window.setTimeout(resolve, 16));
        }
        const pane = await openPane(slot, generation, fixtureIndex);
        const firstUsable = await pane.firstUsable;
        const switchMs = performance.now() - startedAt;
        const completed = await pane.completed;
        return { pane: completed, firstUsable, switchMs };
      };

      setStatus('Opening two isolated PDF renderers…');
      const initial = await Promise.all([
        recyclePane(0, 0, 0),
        recyclePane(1, 0, 1),
      ]);
      await invoke('benchmark_phase', { name: 'loaded-all' });
      await new Promise(resolve => window.setTimeout(resolve, 800));

      const cycles = 24;
      const switchTimes = initial.map(value => value.switchMs);
      const rendererLoads = initial.map(value => value.pane.loadMs);
      const firstUsable = initial.map(value => value.firstUsable.firstUsableMs);
      const exactSettle = initial.map(value => value.pane.settleMs);
      let peakPaneCacheBytes = Math.max(...initial.map(value => value.pane.cacheBytes));
      const stressStartedAt = performance.now();
      await invoke('benchmark_phase', { name: 'stress' });
      for (let cycle = 1; cycle <= cycles; cycle += 1) {
        if (disposed) return;
        setStatus(`Recycling split renderers ${cycle}/${cycles}…`);
        const primary = cycle % names.length;
        let secondary = (cycle * 5 + 3) % names.length;
        if (secondary === primary) secondary = (secondary + 1) % names.length;
        const results = await Promise.all([
          recyclePane(0, cycle, primary),
          recyclePane(1, cycle, secondary),
        ]);
        switchTimes.push(...results.map(value => value.switchMs));
        rendererLoads.push(...results.map(value => value.pane.loadMs));
        firstUsable.push(...results.map(value => value.firstUsable.firstUsableMs));
        exactSettle.push(...results.map(value => value.pane.settleMs));
        peakPaneCacheBytes = Math.max(
          peakPaneCacheBytes,
          ...results.map(value => value.pane.cacheBytes),
        );
      }
      const stressMs = performance.now() - stressStartedAt;
      await invoke('benchmark_phase', { name: 'settled' });
      await new Promise(resolve => window.setTimeout(resolve, 2_000));

      const result = {
        schemaVersion: 2,
        policy: 'disk-sidecars-two-disposable-webview-windows',
        documentCount: names.length,
        liveFrontendDocuments: liveLabels.size,
        sidecarBytes: sidecars.reduce((sum, sidecar) => sum + sidecar.bytes, 0),
        preprocessingMs,
        preprocessingPerDocumentMs: summary(sidecars.map(sidecar => sidecar.elapsedMs)),
        stressMs,
        switchLatencyMs: summary(switchTimes),
        firstUsableMs: summary(firstUsable),
        frontendReloadMs: summary(rendererLoads),
        frameIntervals: summary([]),
        exactSettleMs: summary(exactSettle),
        cache: {
          residentBytes: peakPaneCacheBytes,
          peakResidentBytes: peakPaneCacheBytes,
          fallbackBytes: 0,
          residentTiles: 0,
        },
        cycles,
      };
      await invoke('benchmark_report', { payload: result });
      setStatus('Isolated renderer benchmark complete');
    };

    void run().catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Benchmark failed: ${message}`);
      await invoke('benchmark_report', { payload: { error: message } }).catch(() => undefined);
    });

    return () => {
      disposed = true;
      unlistenReady?.();
      unlistenFirstUsable?.();
      unlistenError?.();
      for (const label of liveLabels.values()) {
        void invoke('benchmark_close_renderer', { label });
      }
      liveLabels.clear();
    };
  }, []);

  return (
    <main className="pdfjs-isolated-shell">
      <div className="pdfjs-isolated-shell-card">
        <h1>PDF renderer memory test</h1>
        <p>{status}</p>
        <p>Backend analysis is stored on disk; only two renderer windows stay alive.</p>
      </div>
    </main>
  );
}
