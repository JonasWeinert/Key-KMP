import { describe, expect, it } from 'vitest';
import type { Tile } from '@embedpdf/plugin-tiling/react';
import {
  imageHasExactDeviceDensity,
  visibleTilesAreExact,
} from './render-quality';

function tile(overrides: Partial<Tile> = {}): Tile {
  return {
    id: 'tile',
    status: 'ready',
    screenRect: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
    pageRect: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
    isFallback: false,
    srcScale: 2,
    col: 0,
    row: 0,
    ...overrides,
  };
}

describe('render quality acceptance checks', () => {
  it('requires every visible page to have ready current-scale tiles', () => {
    expect(
      visibleTilesAreExact(
        {
          0: [tile()],
          1: [tile({ id: 'second' })],
        },
        [1, 2],
      ),
    ).toBe(true);
    expect(
      visibleTilesAreExact(
        { 0: [tile({ isFallback: true })] },
        [1],
      ),
    ).toBe(false);
    expect(
      visibleTilesAreExact(
        { 0: [tile({ status: 'rendering' })] },
        [1],
      ),
    ).toBe(false);
  });

  it('rejects images below the display device pixel density', () => {
    const retinaRect = { width: 100, height: 50 } as DOMRect;
    expect(
      imageHasExactDeviceDensity(
        { naturalWidth: 200, naturalHeight: 100 },
        retinaRect,
        2,
      ),
    ).toBe(true);
    expect(
      imageHasExactDeviceDensity(
        { naturalWidth: 120, naturalHeight: 60 },
        retinaRect,
        2,
      ),
    ).toBe(false);
  });
});
