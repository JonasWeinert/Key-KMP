import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  PdfReaderRail,
  PdfReaderRailMark,
  PdfReaderRailPosition,
} from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import { PreviewRail, type PreviewRailItem } from "./motion/PreviewRail";
import { Icon } from "./icons";
import "./pdf-rail.css";

interface Stop {
  id: string;
  page: number;
  top: number;
  title?: string;
  depth: number;
  /** Last page this stop stands for, when pages are grouped to fit the rail. */
  until: number;
}

const MIN_SECTION = 7;
const MIN_PAGE = 4;
type Mode = "contents" | "pages";
const MODE_KEY = "key.pdf.rail";
const after = (a: { page: number; top: number }, b: PdfReaderRailPosition) =>
  a.page < b.page || (a.page === b.page && a.top <= b.offset + 0.02);

/** The outline's headings, or page ticks without one, thinned until they fit `height`. */
export function railStops(rail: Pick<PdfReaderRail, "sections" | "pageCount">, height: number, mode: Mode = "contents") {
  if (rail.sections.length && mode === "contents") {
    let sections = rail.sections;
    // Deep headings go first; the full list stays in the outline panel.
    for (let depth = Math.max(...sections.map((s) => s.depth)); depth > 0; depth--) {
      if (sections.length * MIN_SECTION <= height) break;
      sections = sections.filter((s) => s.depth < depth);
    }
    const step = Math.max(1, Math.ceil((sections.length * MIN_SECTION) / Math.max(height, 1)));
    sections = sections.filter((_, i) => i % step === 0);
    const stops: Stop[] = sections.map((s, i) => ({
      id: `s${i}`,
      page: s.page,
      top: s.top,
      title: s.title,
      depth: s.depth,
      until: sections[i + 1]?.page ?? rail.pageCount - 1,
    }));
    return { stops, size: Math.min(24, Math.max(MIN_SECTION, Math.floor(height / stops.length))), thinned: sections.length < rail.sections.length };
  }
  const step = Math.max(1, Math.ceil((rail.pageCount * MIN_PAGE) / Math.max(height, 1)));
  const stops: Stop[] = [];
  for (let page = 0; page < rail.pageCount; page += step)
    stops.push({ id: `p${page}`, page, top: 0, depth: 0, until: Math.min(rail.pageCount - 1, page + step - 1) });
  return { stops, size: Math.min(20, Math.max(MIN_PAGE, Math.floor(height / Math.max(stops.length, 1)))), thinned: false };
}

function Thumbnail({ rail, page }: { rail: PdfReaderRail; page: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    void rail.preview(page).then((url) => alive && setSrc(url));
    return () => {
      alive = false;
    };
  }, [rail, page]);
  return (
    <span className="key-pdf-rail-thumb">
      {src ? <img src={src} alt="" draggable={false} /> : null}
    </span>
  );
}

/** The reader's structure rail: chapters (the outline, else the headings layout analysis
 *  found) or pages, the current place, and marks. A switch beneath it picks which. */
export function PdfRail({ rail: given, detected }: { rail: PdfReaderRail; detected?: { title: string; page: number; top: number }[] }) {
  const sections = useMemo(
    () => (given.sections.length ? given.sections : (detected ?? []).filter((s) => s.page < given.pageCount).map((s) => ({ ...s, depth: 0 }))),
    [given.sections, given.pageCount, detected],
  );
  const rail = useMemo(() => ({ ...given, sections }), [given, sections]) as PdfReaderRail;
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "pages" ? "pages" : "contents";
    } catch {
      return "contents";
    }
  });
  const choose = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {}
  };
  const contents = mode === "contents" && sections.length > 0;
  const host = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => setHeight(element.clientHeight - 12);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const position = useSyncExternalStore(given.subscribe, given.position);
  const { stops, size, thinned } = useMemo(() => railStops(rail, height, mode), [rail, height, mode]);
  const marksByStop = useMemo(() => {
    const result = new Map<string, PdfReaderRailMark[]>();
    for (const mark of rail.marks) {
      let stop: Stop | undefined;
      for (const candidate of stops) if (candidate.page <= mark.page) stop = candidate;
      stop ??= stops[0];
      if (stop) result.set(stop.id, [...(result.get(stop.id) ?? []), mark]);
    }
    return result;
  }, [rail.marks, stops]);
  let activeId: string | undefined;
  for (const stop of stops) if (after(stop, position)) activeId = stop.id;
  if (position.end) activeId = stops.at(-1)?.id;
  activeId ??= stops[0]?.id;

  const items: PreviewRailItem[] = stops.map((stop) => {
    const marks = marksByStop.get(stop.id) ?? [];
    const search = marks.find((m) => m.kind === "search");
    const highlight = marks.find((m) => m.kind === "highlight");
    const pages = stop.until > stop.page ? `Pages ${stop.page + 1}–${stop.until + 1}` : `Page ${stop.page + 1}`;
    return {
      id: stop.id,
      label: stop.title ?? pages,
      ariaLabel: stop.title ? `${stop.title}, page ${stop.page + 1}` : pages,
      rest: stop.title
        ? [0.6, 0.42][stop.depth] ?? 0.28
        : stop.page % 10 === 0
          ? 0.45
          : 0.25,
      mark: search
        ? "var(--key-ui-primary)"
        : highlight?.rgb
          ? `rgb(${highlight.rgb})`
          : undefined,
    };
  });
  const byId = new Map(stops.map((stop) => [stop.id, stop]));

  return (
    <div ref={host} className="key-pdf-rail">
      {height > 0 && stops.length > 0 ? (
        <PreviewRail
          label={contents ? "Contents" : "Pages"}
          items={items}
          itemSize={size}
          activeId={activeId}
          onItemSelect={(item) => {
            const stop = byId.get(item.id);
            if (stop) rail.goTo(stop.page, stop.top);
          }}
          footer={
            contents ? (
              <button
                type="button"
                className="key-pdf-rail-all"
                title={thinned ? "All sections (some are hidden on the rail)" : "All sections"}
                aria-label="All sections"
                onClick={rail.openOutline}
              >
                <Icon name="list" />
              </button>
            ) : null
          }
          renderPreview={(item) => {
            const stop = byId.get(item.id)!;
            const marks = marksByStop.get(item.id) ?? [];
            const notes = [
              marks.some((m) => m.kind === "search") ? "Matches" : "",
              marks.some((m) => m.kind === "highlight") ? "Highlights" : "",
            ].filter(Boolean);
            return (
              <div className="key-pdf-rail-preview" data-mode={contents ? "contents" : "pages"}>
                {!contents && <Thumbnail rail={rail} page={stop.page} />}
                <strong>{item.label}</strong>
                <small>
                  {stop.title ? `Page ${stop.page + 1} of ${rail.pageCount}` : `of ${rail.pageCount}`}
                  {notes.length ? ` · ${notes.join(" · ")}` : ""}
                </small>
              </div>
            );
          }}
        />
      ) : null}
      {sections.length > 0 && (
        <div className="key-pdf-rail-mode" role="radiogroup" aria-label="Rail shows">
          <button type="button" role="radio" aria-checked={contents} aria-label="Contents" title="Contents" onClick={() => choose("contents")}>
            <Icon name="list" />
          </button>
          <button type="button" role="radio" aria-checked={!contents} aria-label="Page thumbnails" title="Page thumbnails" onClick={() => choose("pages")}>
            <Icon name="grid" />
          </button>
        </div>
      )}
    </div>
  );
}
