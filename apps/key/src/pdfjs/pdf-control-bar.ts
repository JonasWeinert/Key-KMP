/**
 * What the PDF view asks the window chrome for.
 *
 * Mirrors `experiments/gpui-pdf-reader/src/reader/control_bar.rs`: the view declares
 * region, priority and three measured widths per control and knows nothing
 * about the window's actual width. Widths are the rendered pixel sizes of the
 * corresponding presentation in `ControlBar.tsx`.
 *
 * A zero icon-mode width means "drop this control entirely rather than shrink
 * it" — the host skips any item the solver gives zero width.
 */
import {
  controlBarItem,
  type ControlBarItem,
  type ControlBarSnapshot,
} from '../workspace/control-bar';
import { controlBarCardRange } from '../workspace/control-bar';
import type { PdfReaderChromeState } from './PdfJsBenchmarkApp';

export const PDF_CONTROL_TITLE = 'pdf.title';
export const PDF_CONTROL_ZOOM_OUT = 'pdf.zoom-out';
export const PDF_CONTROL_ZOOM_VALUE = 'pdf.zoom-value';
export const PDF_CONTROL_ZOOM_IN = 'pdf.zoom-in';
export const PDF_CONTROL_FIT_WIDTH = 'pdf.fit-width';
export const PDF_CONTROL_SEARCH = 'pdf.search';
export const PDF_CONTROL_OUTLINE = 'pdf.outline';
export const PDF_CONTROL_REFERENCES = 'pdf.references';
export const PDF_CONTROL_COMMENTS = 'pdf.comments';

export const PDF_SEARCH_EXPANDED_WIDTHS: [number, number, number] = [340, 240, 148];
const MAX_CONTROL_BAR_SEARCH_CARDS = 256;
export type PdfControlMode = 'search' | 'comments' | null;

export function pdfControlBarSnapshot(
  owner: string,
  chrome: PdfReaderChromeState,
  controlMode: PdfControlMode,
  revision: number,
): ControlBarSnapshot {
  const open = chrome.ready;
  const searchExpanded = controlMode === 'search';
  const items: ControlBarItem[] = [];

  items.push(
    controlBarItem(
      PDF_CONTROL_TITLE,
      'leading',
      'display',
      {
        label: chrome.title || 'Open a PDF',
        shortLabel: 'PDF',
        icon: 'document',
        tooltip: chrome.title,
        widths: [0, 0, 0],
        priority: 100,
        width: 'max',
      },
      { enabled: open },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_ZOOM_OUT,
      'leading',
      'button',
      {
        label: 'Zoom out',
        shortLabel: 'Out',
        icon: 'minus',
        tooltip: 'Zoom out',
        widths: [30, 30, 30],
        priority: 70,
        iconOnly: true,
      },
      { enabled: open },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_ZOOM_VALUE,
      'leading',
      'display',
      {
        label: `${Math.round(chrome.zoom * 100)}%`,
        tooltip: 'Actual size',
        // The percentage readout is the first thing worth losing.
        widths: [50, 44, 0],
        priority: 40,
      },
      { enabled: open },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_ZOOM_IN,
      'leading',
      'button',
      {
        label: 'Zoom in',
        shortLabel: 'In',
        icon: 'add',
        tooltip: 'Zoom in',
        widths: [30, 30, 30],
        priority: 70,
        iconOnly: true,
      },
      { enabled: open },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_FIT_WIDTH,
      'leading',
      'button',
      {
        label: 'Fit width',
        icon: 'fitWidth',
        tooltip: 'Fit width',
        widths: [30, 30, 30],
        priority: 55,
        iconOnly: true,
      },
      { enabled: open },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_SEARCH,
      'trailing',
      searchExpanded ? 'textInput' : 'button',
      {
        label: 'Search',
        shortLabel: 'Find',
        icon: 'search',
        tooltip: 'Search this document',
        widths: searchExpanded ? PDF_SEARCH_EXPANDED_WIDTHS : [30, 30, 30],
        priority: 100,
        iconOnly: true,
      },
      {
        enabled: open,
        selected: searchExpanded,
        expanded: searchExpanded,
        loading: chrome.searching,
        value: chrome.searchQuery,
      },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_OUTLINE,
      'trailing',
      'button',
      {
        label: 'Outline',
        icon: 'book',
        tooltip: 'Document outline',
        widths: [30, 30, 0],
        priority: 50,
        iconOnly: true,
      },
      {
        enabled: open && chrome.outlineCount > 0,
        selected: chrome.activePanel === 'outline',
      },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_REFERENCES,
      'trailing',
      'button',
      {
        label: 'References',
        icon: 'highlight',
        tooltip: 'Paper references',
        widths: [30, 30, 0],
        priority: 52,
        iconOnly: true,
      },
      {
        enabled: open && chrome.referenceCount > 0,
        selected: chrome.activePanel === 'references',
      },
    ),
  );

  items.push(
    controlBarItem(
      PDF_CONTROL_COMMENTS,
      'trailing',
      'button',
      {
        label: 'Comments',
        shortLabel: 'Notes',
        icon: 'comments',
        tooltip: chrome.commentCount
          ? `Comments (${chrome.commentCount})`
          : 'Comments',
        widths: [30, 30, 30],
        priority: 60,
        iconOnly: true,
      },
      { enabled: open, selected: controlMode === 'comments' },
    ),
  );

  const snapshot: ControlBarSnapshot = { owner, revision, items };

  if (searchExpanded) {
    const [start, end] = controlBarCardRange(
      chrome.searchResults.length,
      chrome.activeSearchIndex >= 0 ? chrome.activeSearchIndex : null,
      MAX_CONTROL_BAR_SEARCH_CARDS,
    );
    const cards = chrome.searchResults.slice(start, end).map((result, offset) => ({
      id: result.id,
      eyebrow: `p ${result.page + 1}`,
      text: result.preview,
      selected: start + offset === chrome.activeSearchIndex,
    }));
    const total = chrome.searchResults.length;
    const label = !chrome.searchQuery.trim()
      ? 'Type to search'
      : chrome.searching
        ? 'Searching document…'
        : total > cards.length
          ? `${total} results · showing ${start + 1}–${end}`
          : `${total} result${total === 1 ? '' : 's'}`;
    snapshot.auxiliary = {
      id: 'search',
      label,
      loading: chrome.searching,
      cards,
    };
  } else if (controlMode === 'comments') {
    snapshot.auxiliary = {
      id: 'comments',
      label: chrome.comments.length
        ? `${chrome.comments.length} comment${chrome.comments.length === 1 ? '' : 's'}`
        : 'No comments yet',
      loading: false,
      cards: chrome.comments.map(comment => ({
        id: comment.id,
        kind: 'comment' as const,
        text: comment.text || 'Highlighted passage',
        detail: comment.comment,
        accentRgb: comment.accentRgb,
        footer: `Page ${comment.page + 1}`,
        selected: comment.id === chrome.activeCommentId,
      })),
    };
  }

  return snapshot;
}
