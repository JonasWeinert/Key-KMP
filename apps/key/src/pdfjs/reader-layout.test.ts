import { describe, expect, it } from 'vitest';
import { readerHorizontalGeometry } from './reader-layout';

describe('floating reader panel geometry', () => {
  it('adds reachable scroll range without moving or shrinking the page', () => {
    const closed = readerHorizontalGeometry(900, 700, 24, 0);
    const open = readerHorizontalGeometry(900, 700, 24, 338);

    expect(open.pageLeft(700)).toBe(closed.pageLeft(700));
    expect(open.baseContentWidth).toBe(closed.baseContentWidth);
    expect(open.contentWidth - closed.contentWidth).toBe(338);
    expect(open.contentWidth - 900).toBe(338);
  });

  it('keeps zoomed pages padded and adds the panel range after that width', () => {
    const geometry = readerHorizontalGeometry(900, 1200, 24, 338);

    expect(geometry.baseContentWidth).toBe(1248);
    expect(geometry.pageLeft(1200)).toBe(24);
    expect(geometry.contentWidth).toBe(1586);
  });
});
