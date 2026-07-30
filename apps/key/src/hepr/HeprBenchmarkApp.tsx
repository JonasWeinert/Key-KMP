import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  pdfObjectGenerator,
  type HeprThreePdfObject,
  type PDFLoadProgress,
} from '@soadzoor/hepr';

interface FrameSummary {
  median: number;
  p95: number;
  maximum: number;
  framesOver20Ms: number;
}

export interface HeprBenchmarkResult {
  schemaVersion: 1;
  renderer: 'hepr-webgl';
  userAgent: string;
  startedAt: string;
  pageCount: number;
  sourceBytes: number;
  segmentCount: number;
  scene: {
    fillPathCount: number;
    textInstanceCount: number;
    textGlyphCount: number;
    rasterLayerCount: number;
    rasterPixelBytes: number;
  };
  loadMs: {
    objectReady: number;
    firstPaint: number;
    total: number;
  };
  interactionMs: number;
  frameIntervals: FrameSummary;
  scenario: {
    scrollJumps: 8;
    zoomChanges: 6;
    framesPerAction: 4;
  };
}

declare global {
  interface Window {
    __HEPR_READY__?: boolean;
    __HEPR_LOAD_RESULT__?: Omit<HeprBenchmarkResult, 'startedAt' | 'interactionMs' | 'frameIntervals' | 'scenario'>;
    __HEPR_BENCHMARK_RESULT__?: HeprBenchmarkResult;
    __HEPR_ERROR__?: string;
  }
}

interface ViewerRuntime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  object: HeprThreePdfObject | null;
  frameId: number;
  resizeObserver: ResizeObserver;
  bounds: THREE.Box3;
  center: THREE.Vector3;
  baseDistance: number;
  pageCount: number;
  sourceBytes: number;
  segmentCount: number;
  sceneMetrics: HeprBenchmarkResult['scene'];
  loadMs: HeprBenchmarkResult['loadMs'];
  needsRender: boolean;
  renderOnce: () => void;
}

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const nextFrames = (count: number) =>
  new Promise<void>(resolve => {
    const tick = () => {
      count -= 1;
      if (count <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

function resize(runtime: ViewerRuntime, canvas: HTMLCanvasElement) {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  runtime.renderer.setSize(width, height, false);
  runtime.camera.aspect = width / height;
  runtime.camera.updateProjectionMatrix();
  runtime.needsRender = true;
}

function frameDocument(runtime: ViewerRuntime) {
  if (!runtime.object) return;
  runtime.scene.updateMatrixWorld(true);
  runtime.bounds.setFromObject(runtime.object);
  runtime.bounds.getCenter(runtime.center);
  const size = runtime.bounds.getSize(new THREE.Vector3());
  const verticalFov = THREE.MathUtils.degToRad(runtime.camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * runtime.camera.aspect);
  runtime.baseDistance =
    Math.max(
      size.x / (2 * Math.tan(horizontalFov / 2)),
      Math.min(size.y, size.x * 1.35) / (2 * Math.tan(verticalFov / 2)),
    ) * 1.06;
  runtime.camera.position.set(runtime.center.x, runtime.bounds.max.y - size.x * 0.65, runtime.baseDistance);
  runtime.camera.near = Math.max(0.01, runtime.baseDistance / 100);
  runtime.camera.far = runtime.baseDistance + Math.max(size.y, size.x) * 4;
  runtime.camera.lookAt(runtime.camera.position.x, runtime.camera.position.y, 0);
  runtime.camera.updateProjectionMatrix();
  runtime.needsRender = true;
}

function setScrollFraction(runtime: ViewerRuntime, fraction: number) {
  const y = THREE.MathUtils.lerp(runtime.bounds.max.y, runtime.bounds.min.y, fraction);
  runtime.camera.position.y = y;
  runtime.camera.lookAt(runtime.camera.position.x, y, 0);
  runtime.needsRender = true;
}

function setZoom(runtime: ViewerRuntime, zoom: number) {
  runtime.camera.position.z = runtime.baseDistance / zoom;
  runtime.camera.lookAt(runtime.camera.position.x, runtime.camera.position.y, 0);
  runtime.needsRender = true;
}

export default function HeprBenchmarkApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const [status, setStatus] = useState('Choose the benchmark PDF');
  const [progress, setProgress] = useState<PDFLoadProgress | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x9ea7ae, 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
    camera.position.set(0, 0, 10);
    const runtime: ViewerRuntime = {
      renderer,
      scene,
      camera,
      object: null,
      frameId: 0,
      resizeObserver: new ResizeObserver(() => resize(runtime, canvas)),
      bounds: new THREE.Box3(),
      center: new THREE.Vector3(),
      baseDistance: 10,
      pageCount: 0,
      sourceBytes: 0,
      segmentCount: 0,
      sceneMetrics: {
        fillPathCount: 0,
        textInstanceCount: 0,
        textGlyphCount: 0,
        rasterLayerCount: 0,
        rasterPixelBytes: 0,
      },
      loadMs: { objectReady: 0, firstPaint: 0, total: 0 },
      needsRender: true,
      renderOnce: () => renderer.render(scene, camera),
    };
    runtimeRef.current = runtime;
    resize(runtime, canvas);
    runtime.resizeObserver.observe(canvas);
    const animate = () => {
      if (runtime.needsRender) {
        runtime.renderOnce();
        runtime.needsRender = false;
      }
      runtime.frameId = requestAnimationFrame(animate);
    };
    runtime.frameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(runtime.frameId);
      runtime.resizeObserver.disconnect();
      if (runtime.object) {
        runtime.scene.remove(runtime.object);
        runtime.object.dispose();
      }
      runtime.renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

  const load = useCallback(async (file: File) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setReady(false);
    setStatus('HEPR: reading and extracting');
    setProgress(null);
    window.__HEPR_READY__ = false;
    window.__HEPR_BENCHMARK_RESULT__ = undefined;
    window.__HEPR_ERROR__ = undefined;
    if (runtime.object) {
      runtime.scene.remove(runtime.object);
      runtime.object.dispose();
      runtime.object = null;
    }

    const loadStart = performance.now();
    try {
      const object = await pdfObjectGenerator(
        file,
        {
          maxPagesPerRow: 1,
          vectorLod: 'auto',
          extractText: false,
          onProgress: value => {
            setProgress(value);
            setStatus(`HEPR: ${value.stage}`);
          },
        },
        'webgl',
      );
      const objectReady = performance.now() - loadStart;
      runtime.object = object;
      runtime.pageCount = Math.max(1, Math.floor(object.sceneData.pageRects.length / 4));
      runtime.sourceBytes = file.size;
      runtime.segmentCount = object.sceneData.segmentCount;
      runtime.sceneMetrics = {
        fillPathCount: object.sceneData.fillPathCount,
        textInstanceCount: object.sceneData.textInstanceCount,
        textGlyphCount: object.sceneData.textGlyphCount,
        rasterLayerCount: object.sceneData.rasterLayers.length,
        rasterPixelBytes: object.sceneData.rasterLayers.reduce(
          (sum, layer) => sum + layer.data.byteLength,
          0,
        ),
      };
      runtime.scene.add(object);
      frameDocument(runtime);
      const firstPaintStart = performance.now();
      await nextFrames(2);
      runtime.needsRender = true;
      await nextFrames(1);
      const firstPaint = performance.now() - firstPaintStart;
      runtime.loadMs = {
        objectReady,
        firstPaint,
        total: performance.now() - loadStart,
      };
      window.__HEPR_LOAD_RESULT__ = {
        schemaVersion: 1,
        renderer: 'hepr-webgl',
        userAgent: navigator.userAgent,
        pageCount: runtime.pageCount,
        sourceBytes: runtime.sourceBytes,
        segmentCount: runtime.segmentCount,
        scene: runtime.sceneMetrics,
        loadMs: runtime.loadMs,
      };
      window.__HEPR_READY__ = true;
      setReady(true);
      setStatus(
        `Ready · ${runtime.pageCount} pages · ${runtime.segmentCount.toLocaleString()} segments · ${Math.round(runtime.loadMs.total)} ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.__HEPR_ERROR__ = message;
      setStatus(`HEPR failed: ${message}`);
    }
  }, []);

  const benchmark = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime?.object || running) return;
    setRunning(true);
    setStatus('Running identical scroll/zoom sequence');
    const intervals: number[] = [];
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
    const scrollTargets = [0, 0.25, 0.5, 1];
    for (const target of scrollTargets) {
      setScrollFraction(runtime, target);
      await nextFrames(4);
    }
    const zoomLevels = [1, 1.5, 2, 0.8, 1.25, 1];
    for (const zoom of zoomLevels) {
      setZoom(runtime, zoom);
      await nextFrames(4);
    }
    for (const target of [...scrollTargets].reverse()) {
      setScrollFraction(runtime, target);
      await nextFrames(4);
    }
    await nextFrames(10);
    collecting = false;
    const usable = intervals.slice(1);
    const result: HeprBenchmarkResult = {
      schemaVersion: 1,
      renderer: 'hepr-webgl',
      userAgent: navigator.userAgent,
      startedAt,
      pageCount: runtime.pageCount,
      sourceBytes: runtime.sourceBytes,
      segmentCount: runtime.segmentCount,
      scene: runtime.sceneMetrics,
      loadMs: runtime.loadMs,
      interactionMs: performance.now() - start,
      frameIntervals: {
        median: percentile(usable, 0.5),
        p95: percentile(usable, 0.95),
        maximum: Math.max(0, ...usable),
        framesOver20Ms: usable.filter(value => value > 20).length,
      },
      scenario: {
        scrollJumps: 8,
        zoomChanges: 6,
        framesPerAction: 4,
      },
    };
    window.__HEPR_BENCHMARK_RESULT__ = result;
    setRunning(false);
    setStatus(`Done · ${Math.round(result.interactionMs)} ms · p95 ${result.frameIntervals.p95.toFixed(1)} ms`);
  }, [running]);

  return (
    <main className="hepr-benchmark">
      <header className="hepr-benchmark-toolbar">
        <strong>HEPR isolated benchmark</strong>
        <label className="hepr-file-button">
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
        <button type="button" disabled={!ready || running} onClick={() => void benchmark()}>
          {running ? 'Benchmarking…' : 'Benchmark'}
        </button>
        <span className="hepr-status">{status}</span>
        {progress && <span>{Math.round(progress.value * 100)}%</span>}
      </header>
      <canvas ref={canvasRef} className="hepr-canvas" />
    </main>
  );
}
