export interface TabWidthMetrics {
  minimumTitleCharacters: number;
  documentIconWidth: number;
  closeButtonWidth: number;
  segmentGap: number;
  horizontalPadding: number;
  separatorWidth: number;
}

/**
 * Measures the readable floor of a tab group. Split tabs contain two title
 * segments, so each side retains its own filename prefix before overflow.
 */
export function readableTabWidth(
  titles: string[],
  metrics: TabWidthMetrics,
  measureText: (text: string) => number,
) {
  const segmentChrome =
    metrics.documentIconWidth +
    metrics.closeButtonWidth +
    metrics.segmentGap * 2;
  const titleWidth = titles.reduce(
    (total, title) => {
      const prefix = title.slice(0, metrics.minimumTitleCharacters);
      const readablePrefix =
        title.length > metrics.minimumTitleCharacters ? `${prefix}…` : prefix;
      return total + measureText(readablePrefix) + segmentChrome;
    },
    0,
  );
  return Math.ceil(
    titleWidth +
      metrics.horizontalPadding * 2 +
      Math.max(titles.length - 1, 0) * metrics.separatorWidth,
  );
}

/**
 * Shares all available width evenly until a tab reaches its readable floor.
 * When the floors no longer fit, returning them unchanged deliberately makes
 * the strip overflow instead of truncating additional filename characters.
 */
export function distributeTabWidths(minimums: number[], availableWidth: number) {
  if (minimums.length === 0) return [];
  if (minimums.reduce((total, width) => total + width, 0) >= availableWidth) {
    return [...minimums];
  }

  const widths = new Array<number>(minimums.length).fill(0);
  const unresolved = new Set(minimums.map((_, index) => index));
  let remaining = availableWidth;

  while (unresolved.size > 0) {
    const equalShare = remaining / unresolved.size;
    const constrained = [...unresolved].filter(
      index => minimums[index]! > equalShare,
    );
    if (constrained.length === 0) {
      unresolved.forEach(index => {
        widths[index] = equalShare;
      });
      break;
    }
    constrained.forEach(index => {
      widths[index] = minimums[index]!;
      remaining -= minimums[index]!;
      unresolved.delete(index);
    });
  }

  return widths;
}
