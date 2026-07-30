import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocumentState } from '@embedpdf/core/react';
import { useRenderCapability } from '@embedpdf/plugin-render/react';
import {
  useTilingCapability,
  type Tile,
} from '@embedpdf/plugin-tiling/react';
import { PdfErrorCode, type ImageDataLike, type PdfErrorReason, type Task } from '@embedpdf/models';

const cancelled = {
  code: PdfErrorCode.Cancelled,
  message: 'canvas tile is no longer visible',
};

interface TileUnion {
  left: number;
  top: number;
  width: number;
  height: number;
}

function unionForTiles(tiles: Tile[]): TileUnion | null {
  if (tiles.length === 0) return null;
  const left = Math.min(...tiles.map(tile => tile.screenRect.origin.x));
  const top = Math.min(...tiles.map(tile => tile.screenRect.origin.y));
  const right = Math.max(
    ...tiles.map(tile => tile.screenRect.origin.x + tile.screenRect.size.width),
  );
  const bottom = Math.max(
    ...tiles.map(tile => tile.screenRect.origin.y + tile.screenRect.size.height),
  );
  return { left, top, width: right - left, height: bottom - top };
}

export function CanvasTilingLayer({
  documentId,
  pageIndex,
}: {
  documentId: string;
  pageIndex: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tasksRef = useRef(new Map<string, Task<ImageDataLike, PdfErrorReason>>());
  const generationRef = useRef(0);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const documentState = useDocumentState(documentId);
  const { provides: tiling } = useTilingCapability();
  const { provides: render } = useRenderCapability();
  const scale = documentState?.scale ?? 1;
  const dpr = window.devicePixelRatio;
  const exactTiles = useMemo(
    () => tiles.filter(tile => !tile.isFallback && tile.srcScale === scale),
    [scale, tiles],
  );
  const union = useMemo(() => unionForTiles(exactTiles), [exactTiles]);
  const layoutKey = union
    ? `${scale}:${union.left}:${union.top}:${union.width}:${union.height}:${exactTiles
        .map(tile => tile.id)
        .join('|')}`
    : `${scale}:empty`;

  useEffect(() => {
    if (!tiling) return;
    return tiling.forDocument(documentId).onTileRendering(tilesByPage => {
      setTiles(tilesByPage[pageIndex] ?? []);
    });
  }, [documentId, pageIndex, tiling]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !render || !union || exactTiles.length === 0) return;

    generationRef.current += 1;
    const generation = generationRef.current;
    for (const task of tasksRef.current.values()) task.abort(cancelled);
    tasksRef.current.clear();

    canvas.dataset.renderComplete = 'false';
    canvas.style.left = `${union.left}px`;
    canvas.style.top = `${union.top}px`;
    canvas.style.width = `${union.width}px`;
    canvas.style.height = `${union.height}px`;
    canvas.width = Math.max(1, Math.ceil(union.width * dpr));
    canvas.height = Math.max(1, Math.ceil(union.height * dpr));
    canvas.dataset.deviceDensity = String(dpr);
    canvas.dataset.tileCount = String(exactTiles.length);

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    let completed = 0;
    for (const tile of exactTiles) {
      const task = render.forDocument(documentId).renderPageRectRaw({
        pageIndex,
        rect: tile.pageRect,
        options: { scaleFactor: tile.srcScale, dpr },
      });
      tasksRef.current.set(tile.id, task);
      task.wait(
        image => {
          tasksRef.current.delete(tile.id);
          if (generationRef.current !== generation) return;
          const x = Math.round((tile.screenRect.origin.x - union.left) * dpr);
          const y = Math.round((tile.screenRect.origin.y - union.top) * dpr);
          context.putImageData(new ImageData(image.data, image.width, image.height), x, y);
          completed += 1;
          if (completed === exactTiles.length) {
            canvas.dataset.renderComplete = 'true';
            canvas.dispatchEvent(new CustomEvent('key-canvas-render', { bubbles: true }));
          }
        },
        () => {
          tasksRef.current.delete(tile.id);
        },
      );
    }

    return () => {
      generationRef.current += 1;
      for (const task of tasksRef.current.values()) task.abort(cancelled);
      tasksRef.current.clear();
    };
  }, [documentId, dpr, exactTiles, layoutKey, pageIndex, render, union]);

  return (
    <canvas
      ref={canvasRef}
      className="crisp-canvas-layer"
      data-page-index={pageIndex}
      data-render-complete="false"
      aria-hidden="true"
    />
  );
}
