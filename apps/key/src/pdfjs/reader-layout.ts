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
