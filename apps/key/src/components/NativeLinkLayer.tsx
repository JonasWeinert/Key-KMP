import { useEffect, useRef, useState } from 'react';
import { useScroll } from '@embedpdf/plugin-scroll/react';
import type { PaperPreprocessingResult } from '../engines/types';
import { HoverCardBridge } from '../pdfjs/floating-card';

export function NativeLinkLayer({
  documentId,
  pageIndex,
  paper,
}: {
  documentId: string;
  pageIndex: number;
  paper: PaperPreprocessingResult | null;
}) {
  const { provides } = useScroll(documentId);
  const [hovered, setHovered] = useState<number | null>(null);
  const hoverBridge = useRef<HoverCardBridge | null>(null);
  hoverBridge.current ??= new HoverCardBridge();
  const showHover = (id: number) => {
    hoverBridge.current?.cancel();
    setHovered(id);
  };
  const scheduleHoverExit = () => {
    hoverBridge.current?.schedule(() => setHovered(null));
  };
  useEffect(() => () => hoverBridge.current?.dispose(), []);
  const links = paper?.syntheticLinks.filter(link => link.page === pageIndex) ?? [];
  const referenceForTarget = (page: number, yFraction?: number) => {
    const candidates = paper?.references.filter(reference => reference.page === page) ?? [];
    if (yFraction === undefined) return candidates[0];

    return candidates.reduce<(typeof candidates)[number] | undefined>(
      (nearest, reference) => {
        if (reference.yFraction === undefined) return nearest;
        if (nearest?.yFraction === undefined) return reference;
        return Math.abs(reference.yFraction - yFraction) <
          Math.abs(nearest.yFraction - yFraction)
          ? reference
          : nearest;
      },
      undefined,
    );
  };

  return (
    <div
      className="native-link-layer"
      role="group"
      aria-label={`Backend citation overlays page ${pageIndex + 1}: ${links.length}`}
      data-citation-overlays={links.length}
    >
      <span className="sr-only">
        Backend citation overlays page {pageIndex + 1}: {links.length}
      </span>
      {links.map(link => {
        const reference =
          link.target.kind === 'internal'
            ? referenceForTarget(link.target.page, link.target.yFraction)
            : undefined;
        const preview =
          link.target.kind === 'internal'
            ? reference?.text ?? `reference on page ${link.target.page + 1}`
            : link.target.url;

        return (
          <button
            key={link.id}
            className="native-link"
            aria-label={
              link.target.kind === 'internal'
                ? `Inferred citation to page ${link.target.page + 1}: ${preview}`
                : `Backend link: ${preview}`
            }
            title={preview}
            style={{
              left: `${link.bounds.left * 100}%`,
              top: `${link.bounds.top * 100}%`,
              width: `${(link.bounds.right - link.bounds.left) * 100}%`,
              height: `${(link.bounds.bottom - link.bounds.top) * 100}%`,
            }}
            onPointerEnter={() => showHover(link.id)}
            onPointerLeave={scheduleHoverExit}
            onClick={() => {
              if (link.target.kind === 'internal') {
                const targetPage = paper?.document.pages[link.target.page];
                const hasCoordinates =
                  targetPage &&
                  link.target.xFraction !== undefined &&
                  link.target.yFraction !== undefined;
                provides?.scrollToPage({
                  pageNumber: link.target.page + 1,
                  pageCoordinates: hasCoordinates
                    ? {
                        x: targetPage.width * link.target.xFraction!,
                        y: targetPage.height * link.target.yFraction!,
                      }
                    : undefined,
                  behavior: 'smooth',
                  alignY: 20,
                });
              } else {
                window.open(link.target.url, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            <span className="sr-only">
              {link.target.kind === 'internal'
                ? `Inferred citation to reference on page ${link.target.page + 1}`
                : `Backend link to ${link.target.url}`}
            </span>
            {hovered === link.id && (
              <span
                className="link-preview"
                onPointerEnter={() => showHover(link.id)}
                onPointerLeave={scheduleHoverExit}
              >
                {link.target.kind === 'internal'
                  ? preview
                  : new URL(link.target.url).hostname}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
