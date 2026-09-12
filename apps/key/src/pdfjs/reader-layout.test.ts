import { describe, expect, it } from 'vitest';
import { readerHorizontalGeometry, readerPageWindow } from './reader-layout';

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

describe('large-document viewport selection', () => {
  it('matches intersection across variable-height pages, gaps and document edges', () => {
    let top = 24;
    const pages = Array.from({ length: 10_000 }, (_, index) => {
      const page = { top, height: 400 + index % 600 }; top += page.height + 16; return page;
    });
    for (const y of [-1000, 25, 500, 70123, top - 300, top + 500]) {
      const [start, end] = readerPageWindow(pages, y, y + 800);
      expect(pages.slice(start, end)).toEqual(pages.filter(p => p.top + p.height >= y && p.top <= y + 800));
    }
    expect(readerPageWindow([], 0, 100)).toEqual([0, 0]);
  });
});
