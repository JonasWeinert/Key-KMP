export interface ReaderHorizontalGeometry {
  baseContentWidth: number;
  contentWidth: number;
  pageLeft: (pageWidth: number) => number;
}

/**
 * Keeps pages centred in the real viewport while adding trailing scroll room
 * for a floating panel. The panel therefore overlays the page at rest, but
 * the user can scroll exactly `panelInset` farther to uncover its right edge.
 */
export function readerHorizontalGeometry(
  viewportWidth: number,
  widestPageWidth: number,
  pagePadding: number,
  panelInset: number,
): ReaderHorizontalGeometry {
  const baseContentWidth = Math.max(
    viewportWidth,
    widestPageWidth + pagePadding * 2,
  );
  return {
    baseContentWidth,
    contentWidth: baseContentWidth + Math.max(0, panelInset),
    pageLeft: pageWidth => (baseContentWidth - pageWidth) / 2,
  };
}

/** Half-open page range intersecting a viewport. No DOM reads; O(log pages). */
export function readerPageWindow(
  pages: ReadonlyArray<{ top: number; height: number }>, top: number, bottom: number,
): [number, number] {
  let low = 0, high = pages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pages[middle].top + pages[middle].height < top) low = middle + 1;
    else high = middle;
  }
  const first = low;
  high = pages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pages[middle].top <= bottom) low = middle + 1;
    else high = middle;
  }
  return [first, low];
}
