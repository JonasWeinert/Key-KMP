import type {
  NativeBounds,
  NativeLink,
  NativeTextPage,
  ScientificCitation,
} from '../engines/types';
import {
  boundsForRange,
  fetchTextPage,
  normalizeRange,
  textForRange,
  type PageHost,
  type ReaderAnnotation,
  type ReaderSearchMatch,
  type SelectionSnapshot,
  type TextPosition,
  type TextRange,
} from './reader-model';

function rectStyle(element: HTMLElement, bounds: NativeBounds) {
  element.style.left = `${bounds.left * 100}%`;
  element.style.top = `${bounds.top * 100}%`;
  element.style.width = `${Math.max(0, bounds.right - bounds.left) * 100}%`;
  element.style.height = `${Math.max(0, bounds.bottom - bounds.top) * 100}%`;
}

function viewportRectForBounds(host: HTMLElement, bounds: NativeBounds[]) {
  if (bounds.length === 0) return;
  const page = host.getBoundingClientRect();
  const left = Math.min(...bounds.map(bound => bound.left));
  const top = Math.min(...bounds.map(bound => bound.top));
  const right = Math.max(...bounds.map(bound => bound.right));
  const bottom = Math.max(...bounds.map(bound => bound.bottom));
  return new DOMRect(
    page.left + left * page.width,
    page.top + top * page.height,
    Math.max(1, (right - left) * page.width),
    Math.max(1, (bottom - top) * page.height),
  );
}

export function characterIndexAtPoint(
  text: NativeTextPage,
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number,
  maximumDistance = 24,
) {
  let closest: { index: number; distance: number } | null = null;
  for (let index = 0; index < text.characters.length; index += 1) {
    const bounds = text.characters[index]?.bounds;
    if (!bounds) continue;
    const dx =
      x < bounds.left
        ? (bounds.left - x) * pageWidth
        : x > bounds.right
          ? (x - bounds.right) * pageWidth
          : 0;
    const dy =
      y < bounds.top
        ? (bounds.top - y) * pageHeight
        : y > bounds.bottom
          ? (y - bounds.bottom) * pageHeight
          : 0;
    const distance = Math.hypot(dx, dy);
    if (
      !closest ||
      distance < closest.distance ||
      (distance === closest.distance &&
        Math.abs(x - (bounds.left + bounds.right) / 2) <
          Math.abs(
            x -
              ((text.characters[closest.index]?.bounds?.left ?? 0) +
                (text.characters[closest.index]?.bounds?.right ?? 0)) /
                2,
          ))
    ) {
      closest = { index, distance };
    }
  }
  return closest && closest.distance <= maximumDistance ? closest.index : null;
}

interface SelectionDrag {
  pointerId: number;
  anchor: TextPosition;
  latest: TextPosition;
  originX: number;
  originY: number;
  moved: boolean;
}

export class PdfJsTextOverlayManager {
  readonly textPages = new Map<number, NativeTextPage>();
  private readonly documentId: string;
  private readonly hosts: PageHost[];
  private readonly pending = new Map<number, Promise<NativeTextPage>>();
  private annotations: ReaderAnnotation[] = [];
  private searchMatches: ReaderSearchMatch[] = [];
  private activeSearchId: string | null = null;
  private links: Array<NativeLink & { synthetic?: boolean }> = [];
  private citations: ScientificCitation[] = [];
  private liveSelection: TextRange | null = null;
  private selectionListener?: (snapshot: SelectionSnapshot | null) => void;
  private annotationListener?: (annotation: ReaderAnnotation | null, rect?: DOMRect) => void;
  private linkListener?: (
    link: NativeLink & { synthetic?: boolean },
    rect: DOMRect,
  ) => void;
  private linkHoverListener?: (
    link: (NativeLink & { synthetic?: boolean }) | null,
    rect?: DOMRect,
  ) => void;
  private citationListener?: (citation: ScientificCitation, rect: DOMRect) => void;
  private citationHoverListener?: (
    citation: ScientificCitation | null,
    rect?: DOMRect,
  ) => void;
  private selectionDrag: SelectionDrag | null = null;
  private suppressActivationPointer: number | null = null;
  private destroyed = false;

  constructor(documentId: string, hosts: PageHost[]) {
    this.documentId = documentId;
    this.hosts = hosts;
    document.addEventListener('pointermove', this.onSelectionPointerMove, true);
    document.addEventListener('pointerup', this.onSelectionPointerUp, true);
    document.addEventListener('pointercancel', this.onSelectionPointerUp, true);
    for (const host of hosts) {
      host.element.addEventListener('pointerdown', this.onSelectionPointerDown);
      host.element.addEventListener('pointerup', this.onPointerUp);
      host.element.addEventListener('pointermove', this.onPointerMove);
      host.element.addEventListener('pointerleave', this.onPointerLeave);
    }
  }

  onSelection(listener: (snapshot: SelectionSnapshot | null) => void) {
    this.selectionListener = listener;
  }

  onAnnotationActivation(
    listener: (annotation: ReaderAnnotation | null, rect?: DOMRect) => void,
  ) {
    this.annotationListener = listener;
  }

  onLinkActivation(
    listener: (
      link: NativeLink & { synthetic?: boolean },
      rect: DOMRect,
    ) => void,
  ) {
    this.linkListener = listener;
  }

  onLinkHover(
    listener: (
      link: (NativeLink & { synthetic?: boolean }) | null,
      rect?: DOMRect,
    ) => void,
  ) {
    this.linkHoverListener = listener;
  }

  onCitationActivation(
    listener: (citation: ScientificCitation, rect: DOMRect) => void,
  ) {
    this.citationListener = listener;
  }

  onCitationHover(
    listener: (citation: ScientificCitation | null, rect?: DOMRect) => void,
  ) {
    this.citationHoverListener = listener;
  }

  async ensurePage(page: number) {
    if (this.destroyed || this.textPages.has(page)) return this.textPages.get(page);
    let request = this.pending.get(page);
    if (!request) {
      const host = this.hosts[page];
      if (!host) return;
      request = fetchTextPage(this.documentId, page, host);
      this.pending.set(page, request);
    }
    try {
      const text = await request;
      if (this.destroyed) return;
      this.textPages.set(page, text);
      this.mountTextLayer(this.hosts[page], text);
      this.renderPage(page);
      return text;
    } finally {
      this.pending.delete(page);
    }
  }

  async ensurePages(pages: Iterable<number>) {
    await Promise.all([...new Set(pages)].map(page => this.ensurePage(page)));
  }

  async ensureAllPages() {
    await this.ensurePages(this.hosts.map((_, page) => page));
  }

  setAnnotations(annotations: ReaderAnnotation[]) {
    this.annotations = annotations;
    this.renderAll();
  }

  setSearch(matches: ReaderSearchMatch[], activeId: string | null) {
    this.searchMatches = matches;
    this.activeSearchId = activeId;
    this.renderAll();
  }

  setLinks(links: Array<NativeLink & { synthetic?: boolean }>) {
    this.links = links;
    this.renderAll();
  }

  setCitations(citations: ScientificCitation[]) {
    this.citations = citations;
    this.renderAll();
  }

  setSelection(range: TextRange | null) {
    this.liveSelection = range;
    this.renderAll();
  }

  clearBrowserSelection() {
    window.getSelection()?.removeAllRanges();
    this.setSelection(null);
  }

  viewportRectForRange(range: TextRange) {
    const rects: DOMRect[] = [];
    for (let page = range.start.page; page <= range.end.page; page += 1) {
      const host = this.hosts[page];
      const text = this.textPages.get(page);
      if (!host || !text) continue;
      const rect = viewportRectForBounds(
        host.element,
        boundsForRange(text, range),
      );
      if (rect) rects.push(rect);
    }
    if (rects.length === 0) return;
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.right));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  }

  viewportRectForPageBounds(page: number, bounds: NativeBounds[]) {
    const host = this.hosts[page];
    return host ? viewportRectForBounds(host.element, bounds) : undefined;
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('pointermove', this.onSelectionPointerMove, true);
    document.removeEventListener('pointerup', this.onSelectionPointerUp, true);
    document.removeEventListener('pointercancel', this.onSelectionPointerUp, true);
    for (const host of this.hosts) {
      host.element.removeEventListener('pointerdown', this.onSelectionPointerDown);
      host.element.removeEventListener('pointerup', this.onPointerUp);
      host.element.removeEventListener('pointermove', this.onPointerMove);
      host.element.removeEventListener('pointerleave', this.onPointerLeave);
      host.element
        .querySelectorAll('.pdfjs-text-layer, .pdfjs-overlay-layer')
        .forEach(element => element.remove());
    }
    this.pending.clear();
    this.textPages.clear();
  }

  private mountTextLayer(host: PageHost, text: NativeTextPage) {
    host.element.querySelector('.pdfjs-text-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'pdfjs-text-layer';
    layer.setAttribute('aria-label', `Selectable text for page ${text.page + 1}`);
    for (const run of selectableRuns(text)) {
      const span = document.createElement('span');
      span.className = 'pdfjs-text-run';
      span.dataset.page = String(text.page);
      span.dataset.startIndex = String(run.start);
      span.dataset.endIndex = String(run.end);
      span.textContent = run.text;
      rectStyle(span, run.bounds);
      span.style.setProperty(
        '--glyph-height',
        String(Math.max(0.001, run.bounds.bottom - run.bounds.top)),
      );
      layer.append(span);
    }
    host.element.append(layer);
  }

  private overlayLayer(page: number) {
    const host = this.hosts[page];
    if (!host) return null;
    let layer = host.element.querySelector<HTMLDivElement>('.pdfjs-overlay-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'pdfjs-overlay-layer';
      host.element.insertBefore(layer, host.element.querySelector('.pdfjs-text-layer'));
    }
    return layer;
  }

  private paintBounds(
    layer: HTMLElement,
    bounds: NativeBounds[],
    className: string,
    id?: string,
  ) {
    for (const bound of bounds) {
      const element = document.createElement('div');
      element.className = className;
      if (id) element.dataset.id = id;
      rectStyle(element, bound);
      layer.append(element);
    }
  }

  private renderPage(page: number) {
    const layer = this.overlayLayer(page);
    const text = this.textPages.get(page);
    if (!layer || !text) return;
    layer.replaceChildren();
    for (const annotation of this.annotations) {
      if (page < annotation.range.start.page || page > annotation.range.end.page) continue;
      const className = `pdfjs-highlight color-${annotation.color}${
        annotation.comment ? ' has-comment' : ''
      }`;
      this.paintBounds(
        layer,
        boundsForRange(text, annotation.range),
        className,
        annotation.id,
      );
    }
    for (const match of this.searchMatches.filter(match => match.page === page)) {
      this.paintBounds(
        layer,
        match.bounds,
        match.id === this.activeSearchId
          ? 'pdfjs-search-match active'
          : 'pdfjs-search-match',
        match.id,
      );
    }
    for (const link of this.links.filter(link => link.page === page)) {
      this.paintBounds(
        layer,
        [link.bounds],
        link.synthetic ? 'pdfjs-link-overlay citation' : 'pdfjs-link-overlay',
        String(link.id),
      );
    }
    for (const citation of this.citations.filter(citation => citation.page === page)) {
      const element = document.createElement('div');
      element.className = 'pdfjs-link-overlay citation';
      element.dataset.id = citation.id;
      rectStyle(element, citation.bounds);
      element.addEventListener('pointerenter', () => {
        const rect = viewportRectForBounds(this.hosts[page].element, [citation.bounds]);
        this.citationHoverListener?.(citation, rect);
      });
      element.addEventListener('pointerleave', () => {
        this.citationHoverListener?.(null);
      });
      element.addEventListener('pointerup', event => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        const rect = viewportRectForBounds(this.hosts[page].element, [citation.bounds]);
        if (rect) this.citationListener?.(citation, rect);
      });
      layer.append(element);
    }
    if (this.liveSelection) {
      this.paintBounds(
        layer,
        boundsForRange(text, this.liveSelection),
        'pdfjs-selection-highlight',
      );
    }
  }

  private renderAll() {
    for (const page of this.textPages.keys()) this.renderPage(page);
  }

  private publishSelection(range: TextRange | null) {
    this.liveSelection = range;
    this.renderAll();
    if (!range) {
      this.selectionListener?.(null);
      return;
    }
    const rect = this.viewportRectForRange(range);
    if (!rect) return;
    this.selectionListener?.({
      range,
      text: textForRange(this.textPages, range),
      viewportRect: rect,
    });
  }

  private textPositionAtPoint(clientX: number, clientY: number) {
    for (let page = 0; page < this.hosts.length; page += 1) {
      const host = this.hosts[page];
      const text = this.textPages.get(page);
      if (!host || !text) continue;
      const rect = host.element.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        continue;
      }
      const index = characterIndexAtPoint(
        text,
        (clientX - rect.left) / rect.width,
        (clientY - rect.top) / rect.height,
        rect.width,
        rect.height,
      );
      if (index !== null) return { page, index };
    }
    return null;
  }

  private readonly onSelectionPointerDown = (event: PointerEvent) => {
    if (
      this.destroyed ||
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest('.pdfjs-text-layer')
    ) {
      return;
    }
    const anchor = this.textPositionAtPoint(event.clientX, event.clientY);
    if (!anchor) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    this.selectionDrag = {
      pointerId: event.pointerId,
      anchor,
      latest: anchor,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    };
  };

  private readonly onSelectionPointerMove = (event: PointerEvent) => {
    const drag = this.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) < 3
    ) {
      return;
    }
    const latest = this.textPositionAtPoint(event.clientX, event.clientY);
    if (!latest) return;
    event.preventDefault();
    drag.moved = true;
    drag.latest = latest;
    this.publishSelection(normalizeRange(drag.anchor, drag.latest));
  };

  private readonly onSelectionPointerUp = (event: PointerEvent) => {
    const drag = this.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.selectionDrag = null;
    if (!drag.moved) {
      this.publishSelection(null);
      return;
    }
    event.preventDefault();
    this.suppressActivationPointer = event.pointerId;
    window.setTimeout(() => {
      if (this.suppressActivationPointer === event.pointerId) {
        this.suppressActivationPointer = null;
      }
    }, 0);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.suppressActivationPointer === event.pointerId) return;
    const currentTarget = event.currentTarget as HTMLElement;
    const { clientX, clientY } = event;
    queueMicrotask(() => {
      const host = currentTarget.closest<HTMLElement>('.pdfjs-page');
      const page = Number(host?.dataset.pageIndex);
      if (!host || !Number.isInteger(page)) return;
      const rect = host.getBoundingClientRect();
      const x = (clientX - rect.left) / rect.width;
      const y = (clientY - rect.top) / rect.height;
      const text = this.textPages.get(page);
      if (!text) return;
      const annotation = [...this.annotations]
        .reverse()
        .find(candidate => {
          if (page < candidate.range.start.page || page > candidate.range.end.page) return false;
          return boundsForRange(text, candidate.range).some(
            bounds =>
              x >= bounds.left &&
              x <= bounds.right &&
              y >= bounds.top &&
              y <= bounds.bottom,
          );
        });
      this.annotationListener?.(
        annotation ?? null,
        annotation
          ? viewportRectForBounds(host, boundsForRange(text, annotation.range))
          : undefined,
      );
      if (annotation) return;
      const citation = [...this.citations]
        .reverse()
        .find(
          candidate =>
            candidate.page === page &&
            x >= candidate.bounds.left &&
            x <= candidate.bounds.right &&
            y >= candidate.bounds.top &&
            y <= candidate.bounds.bottom,
        );
      if (citation) {
        const citationRect = viewportRectForBounds(host, [citation.bounds]);
        if (citationRect) this.citationListener?.(citation, citationRect);
        return;
      }
      const link = [...this.links]
        .reverse()
        .find(
          candidate =>
            candidate.page === page &&
            x >= candidate.bounds.left &&
            x <= candidate.bounds.right &&
            y >= candidate.bounds.top &&
            y <= candidate.bounds.bottom,
        );
      if (link) {
        const linkRect = viewportRectForBounds(host, [link.bounds]);
        if (linkRect) this.linkListener?.(link, linkRect);
      }
    });
  };

  private linkAt(event: PointerEvent) {
    const host = (event.currentTarget as HTMLElement).closest<HTMLElement>('.pdfjs-page');
    const page = Number(host?.dataset.pageIndex);
    if (!host || !Number.isInteger(page)) return null;
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return [...this.links]
      .reverse()
      .find(
        candidate =>
          candidate.page === page &&
          x >= candidate.bounds.left &&
          x <= candidate.bounds.right &&
          y >= candidate.bounds.top &&
          y <= candidate.bounds.bottom,
      ) ?? null;
  }

  private citationAt(event: PointerEvent) {
    const host = (event.currentTarget as HTMLElement).closest<HTMLElement>('.pdfjs-page');
    const page = Number(host?.dataset.pageIndex);
    if (!host || !Number.isInteger(page)) return null;
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const citation =
      [...this.citations]
        .reverse()
        .find(
          candidate =>
            candidate.page === page &&
            x >= candidate.bounds.left &&
            x <= candidate.bounds.right &&
            y >= candidate.bounds.top &&
            y <= candidate.bounds.bottom,
        ) ?? null;
    return {
      citation,
      rect: citation ? viewportRectForBounds(host, [citation.bounds]) : undefined,
    };
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.selectionDrag) return;
    const citationHit = this.citationAt(event);
    if (citationHit?.citation) {
      this.linkHoverListener?.(null);
      this.citationHoverListener?.(
        citationHit.citation,
        citationHit.rect,
      );
      return;
    }
    this.citationHoverListener?.(null);
    const link = this.linkAt(event);
    this.linkHoverListener?.(
      link,
      link
        ? viewportRectForBounds(
            (event.currentTarget as HTMLElement).closest<HTMLElement>('.pdfjs-page')!,
            [link.bounds],
          )
        : undefined,
    );
  };

  private readonly onPointerLeave = () => {
    if (this.selectionDrag) return;
    this.linkHoverListener?.(null);
    this.citationHoverListener?.(null);
  };
}

interface SelectableRun {
  start: number;
  end: number;
  text: string;
  bounds: NativeBounds;
}

function selectableRuns(text: NativeTextPage): SelectableRun[] {
  const output: SelectableRun[] = [];
  let current: SelectableRun | null = null;
  for (let index = 0; index < text.characters.length; index += 1) {
    const character = text.characters[index];
    const bounds = character.bounds;
    if (!bounds || character.value === '\n' || character.value === '\r') {
      if (current) output.push(current);
      current = null;
      continue;
    }
    const height = bounds.bottom - bounds.top;
    const currentHeight = current
      ? current.bounds.bottom - current.bounds.top
      : height;
    const sameLine =
      current &&
      Math.abs(current.bounds.top - bounds.top) <= Math.max(height, currentHeight) * 0.5 &&
      bounds.left <=
        current.bounds.right + Math.max(0.012, (bounds.right - bounds.left) * 3.2) &&
      bounds.left >= current.bounds.left - 0.01;
    if (!current || !sameLine) {
      if (current) output.push(current);
      current = {
        start: index,
        end: index,
        text: character.value,
        bounds: { ...bounds },
      };
      continue;
    }
    current.end = index;
    current.text += character.value;
    current.bounds.left = Math.min(current.bounds.left, bounds.left);
    current.bounds.top = Math.min(current.bounds.top, bounds.top);
    current.bounds.right = Math.max(current.bounds.right, bounds.right);
    current.bounds.bottom = Math.max(current.bounds.bottom, bounds.bottom);
  }
  if (current) output.push(current);
  return output;
}
