import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useDocumentState } from '@embedpdf/core/react';
import {
  useTilingCapability,
} from '@embedpdf/plugin-tiling/react';
import { canvasHasExactDeviceDensity } from './render-quality';

type RenderQualityStatus = 'warm' | 'settling' | 'exact';

interface RenderQualitySnapshot {
  status: RenderQualityStatus;
  settleMs: number | null;
  reason: 'hidden' | 'no-visible-pages' | 'tiles-pending' | 'images-pending' | 'exact';
  visiblePages: number;
  visibleImages: number;
  minimumDeviceDensity: number | null;
  tileSummary: string;
}

interface Options {
  documentId: string;
  paneRef: RefObject<HTMLElement | null>;
  currentPage: number;
  visible: boolean;
}

declare global {
  interface Window {
    __KEY_RENDER_QUALITY__?: Record<string, RenderQualitySnapshot>;
  }
}

export function useRenderQuality({
  documentId,
  paneRef,
  currentPage,
  visible,
}: Options) {
  const documentState = useDocumentState(documentId);
  const { provides: tiling } = useTilingCapability();
  const [snapshot, setSnapshot] = useState<RenderQualitySnapshot>({
    status: visible ? 'settling' : 'warm',
    settleMs: null,
    reason: visible ? 'images-pending' : 'hidden',
    visiblePages: 0,
    visibleImages: 0,
    minimumDeviceDensity: null,
    tileSummary: '',
  });
  const scaleRef = useRef(documentState?.scale ?? 1);
  const startedRef = useRef(performance.now());
  const settleRef = useRef<number | null>(null);
  const statusRef = useRef<RenderQualityStatus>(visible ? 'settling' : 'warm');

  const publish = useCallback(
    (next: RenderQualitySnapshot) => {
      statusRef.current = next.status;
      settleRef.current = next.settleMs;
      setSnapshot(current =>
        JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next,
      );
      window.__KEY_RENDER_QUALITY__ = {
        ...window.__KEY_RENDER_QUALITY__,
        [documentId]: next,
      };
    },
    [documentId],
  );

  const evaluate = useCallback(() => {
    if (!visible) {
      publish({
        status: 'warm',
        settleMs: settleRef.current,
        reason: 'hidden',
        visiblePages: 0,
        visibleImages: 0,
        minimumDeviceDensity: null,
        tileSummary: '',
      });
      return;
    }
    if (currentPage <= 0) {
      publish({
        status: 'settling',
        settleMs: null,
        reason: 'no-visible-pages',
        visiblePages: 0,
        visibleImages: 0,
        minimumDeviceDensity: null,
        tileSummary: '',
      });
      return;
    }
    // Actual canvas backing-store density is the acceptance criterion.
    const viewportRect = paneRef.current
      ?.querySelector<HTMLElement>('.pdf-viewport')
      ?.getBoundingClientRect();
    const canvases = [
      ...(paneRef.current?.querySelectorAll<HTMLCanvasElement>(
        '.crisp-canvas-layer',
      ) ?? []),
    ].filter(canvas => {
      if (!viewportRect) return false;
      const rect = canvas.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > viewportRect.top &&
        rect.top < viewportRect.bottom &&
        rect.right > viewportRect.left &&
        rect.left < viewportRect.right
      );
    });
    const densityRatios = canvases.map(canvas => {
      const rect = canvas.getBoundingClientRect();
      return Math.sqrt(
        (canvas.width * canvas.height) /
          (Math.max(rect.width, 1) * Math.max(rect.height, 1)),
      );
    });
    if (canvases.length === 0 || !canvases.every(canvas =>
      canvasHasExactDeviceDensity(
        canvas,
        canvas.getBoundingClientRect(),
        window.devicePixelRatio,
      ),
    )) {
      publish({
        status: 'settling',
        settleMs: null,
        reason: 'images-pending',
        visiblePages: 1,
        visibleImages: canvases.length,
        minimumDeviceDensity:
          densityRatios.length > 0 ? Math.min(...densityRatios) : null,
        tileSummary: 'ready-current',
      });
      return;
    }
    publish({
      status: 'exact',
      settleMs: performance.now() - startedRef.current,
      reason: 'exact',
      visiblePages: 1,
      visibleImages: canvases.length,
      minimumDeviceDensity: Math.min(...densityRatios),
      tileSummary: 'ready-current',
    });
  }, [
    currentPage,
    documentId,
    paneRef,
    publish,
    visible,
  ]);

  useEffect(() => {
    const scale = documentState?.scale ?? 1;
    if (scale !== scaleRef.current || visible) {
      scaleRef.current = scale;
      startedRef.current = performance.now();
      publish({
        status: visible ? 'settling' : 'warm',
        settleMs: null,
        reason: visible ? 'images-pending' : 'hidden',
        visiblePages: 0,
        visibleImages: 0,
        minimumDeviceDensity: null,
        tileSummary: '',
      });
    }
  }, [documentState?.scale, publish, visible]);

  useEffect(() => {
    if (!tiling) return;
    return tiling.forDocument(documentId).onTileRendering(() => {
      if (visible && statusRef.current === 'exact') {
        startedRef.current = performance.now();
        publish({
          status: 'settling',
          settleMs: null,
          reason: 'images-pending',
          visiblePages: 0,
          visibleImages: 0,
          minimumDeviceDensity: null,
          tileSummary: '',
        });
      }
      requestAnimationFrame(evaluate);
    });
  }, [documentId, evaluate, publish, tiling, visible]);

  useEffect(() => {
    requestAnimationFrame(evaluate);
  }, [evaluate, visible]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const onCanvasRender = () => requestAnimationFrame(evaluate);
    pane.addEventListener('key-canvas-render', onCanvasRender);
    return () => pane.removeEventListener('key-canvas-render', onCanvasRender);
  }, [evaluate, paneRef]);

  useEffect(() => {
    if (!visible || statusRef.current === 'exact') return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      evaluate();
      attempts += 1;
      if (statusRef.current === 'exact' || attempts >= 50) {
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [documentState?.scale, evaluate, visible]);

  return snapshot;
}
