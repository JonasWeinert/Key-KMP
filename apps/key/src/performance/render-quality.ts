import type { Tile } from '@embedpdf/plugin-tiling/react';

const DENSITY_TOLERANCE = 0.96;

export function visibleTilesAreExact(
  tilesByPage: Record<number, Tile[]>,
  visiblePageNumbers: number[],
) {
  if (visiblePageNumbers.length === 0) return false;
  return visiblePageNumbers.every(pageNumber => {
    const tiles = tilesByPage[pageNumber - 1] ?? [];
    const current = tiles.filter(tile => !tile.isFallback);
    return (
      current.length > 0 &&
      current.every(tile => tile.status === 'ready') &&
      tiles.every(tile => !tile.isFallback)
    );
  });
}

export function imageHasExactDeviceDensity(
  image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>,
  rect: Pick<DOMRect, 'width' | 'height'>,
  devicePixelRatio: number,
) {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const effectiveDensity = Math.sqrt(
    (image.naturalWidth * image.naturalHeight) / (rect.width * rect.height),
  );
  return effectiveDensity >= devicePixelRatio * DENSITY_TOLERANCE;
}

export function canvasHasExactDeviceDensity(
  canvas: Pick<HTMLCanvasElement, 'width' | 'height' | 'dataset'>,
  rect: Pick<DOMRect, 'width' | 'height'>,
  devicePixelRatio: number,
) {
  if (
    canvas.dataset.renderComplete !== 'true' ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return false;
  }
  const effectiveDensity = Math.sqrt(
    (canvas.width * canvas.height) / (rect.width * rect.height),
  );
  return effectiveDensity >= devicePixelRatio * DENSITY_TOLERANCE;
}
