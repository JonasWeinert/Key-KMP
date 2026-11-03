import { Button, Input } from "@key/design-system";
import { useCallback, useEffect, useRef, useState } from "react";
import PdfJsBenchmarkApp, {
  type PdfJsViewState,
  type PdfReaderChromeState,
  type PdfReaderHandle,
  type PdfReaderPanel,
} from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import {
  registerManagedSource,
  type ManagedSource,
} from "@key-reader/pdfjs/reader-model";
import "@key-reader/styles.css";
import "./pdf-reader.css";
import "./pdf-ui-adapter.css";
import { Icon } from "./icons";

type Target = {
  id: string;
  documentHash: string;
  page: number;
  rects: number[][];
  targetText: string;
};
type Focus = { page?: number; annotationId?: string };
interface Ready {
  source: ManagedSource;
  focus?: Focus;
  notesOpen?: boolean;
  viewState?: PdfJsViewState;
  searchTarget?: Target;
  searchNavigation?: Navigation;
}
type Navigation = { index: number; total: number; shared?: boolean; query?: string };
interface ReaderBridge {
  readerReady(): Promise<Ready>;
  readerState(state: PdfJsViewState): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  readerBack?(): void;
  readerDismiss?(): Promise<void>;
  readerNotes?(): Promise<boolean>;
  readerAddToNote?(passage: { text: string; page: number; color?: string }): Promise<void>;
  readerSendTo?(highlight: { annotationId: string; text: string; page: number; color?: string }): Promise<void>;
  readerAnalysis?(): Promise<AnalysisReport | null>;
  readerReanalyze?(): Promise<void>;
  readerOpenSource?(sourceId: string): Promise<void>;
  readerResult?(direction: number): Promise<void>;
}
const bridge = () => (window as unknown as { key: ReaderBridge }).key;

/** What the library knows about this PDF's analysis (key-store). */
interface AnalysisReport {
  analysis: {
    engine: string;
    analyzedAt: number;
    referencesStatus: string;
    referencesError?: string | null;
    referencesTotal: number;
    referencesDone: number;
    referencesMatched: number;
  } | null;
  references: {
    number?: number | null;
    page?: number | null;
    rects?: number[][];
    text: string;
    metadata?: { title?: string; year?: number | string; authors?: string[]; doi?: string } | null;
    matchedSourceId?: string | null;
  }[];
  layoutModel: boolean;
  indexStatus?: string | null;
}
const ENGINES: Record<string, string> = {
  "layout-onnx": "Layout analysis with the layout model",
  layout: "Layout analysis",
  pdfium: "Plain PDF text",
};
const working = (report: AnalysisReport | null | undefined) =>
  !!report &&
  (["pending", "indexing"].includes(report.indexStatus ?? "") ||
    ["pending", "detecting", "resolving"].includes(report.analysis?.referencesStatus ?? ""));

/** How far analysis has got, and a way to run it again. */
function AnalysisStatus({ report, onRerun }: { report: AnalysisReport | null | undefined; onRerun: () => void }) {
  if (report === undefined) return null;
  const a = report?.analysis;
  const indexing = ["pending", "indexing"].includes(report?.indexStatus ?? "");
  let line: string;
  let progress: number | undefined;
  if (!report) line = "This PDF is not in a library, so it is analysed only while open.";
  else if (indexing) line = report.layoutModel ? "Analysing the layout of this PDF…" : "Reading this PDF…";
  else if (!a) line = "Not analysed with the current method yet.";
  else if (a.referencesStatus === "detecting" || a.referencesStatus === "pending") line = "Finding references…";
  else if (a.referencesStatus === "resolving") {
    line = `Looking up references · ${a.referencesDone} of ${a.referencesTotal}`;
    progress = a.referencesTotal ? a.referencesDone / a.referencesTotal : 0;
  } else if (a.referencesStatus === "none") line = "No reference list found.";
  else if (a.referencesStatus === "failed") line = `Reference lookup failed: ${a.referencesError ?? "unknown error"}`;
  else line = `${a.referencesTotal} references looked up${a.referencesMatched ? ` · ${a.referencesMatched} in your library` : ""}`;
  return (
    <div className="key-pdf-analysis" role="status" data-working={working(report) || undefined}>
      <div>
        <span>{line}</span>
        {a && !indexing && <small>{ENGINES[a.engine] ?? a.engine} · {new Date(a.analyzedAt).toLocaleDateString()}</small>}
      </div>
      {report && !indexing && (
        <button type="button" onClick={onRerun} title="Read this PDF again and look up its references">
          {a ? "Re-run" : "Analyse"}
        </button>
      )}
      {progress !== undefined && (
        <span className="key-pdf-analysis-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

export default function PdfReader() {
  const reader = useRef<PdfReaderHandle>(null);
  const [document, setDocument] = useState<{ file: File; initial: Ready }>();
  const [error, setError] = useState("");
  const [chrome, setChrome] = useState<PdfReaderChromeState>();
  const [target, setTarget] = useState<Target>();
  const [navigation, setNavigation] = useState<Navigation>({ index: -1, total: 0 });
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [page, setPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState<AnalysisReport | null>();
  // "Show in PDF": go to the place once the document is ready. Annotations load just after
  // the document, so a second try lights the highlight up if the first was too early.
  const [focus, setFocus] = useState<Focus>();
  useEffect(() => bridge().on("reader-focus", (payload) => setFocus({ ...(payload as Focus) })), []);
  useEffect(() => {
    if (!focus || !chrome?.ready) return;
    const go = () => reader.current?.focusAnnotation(focus.annotationId, focus.page);
    go();
    setTimeout(go, 700);
    setFocus(undefined);
  }, [focus, chrome?.ready]);
  const refreshAnalysis = useCallback(() => {
    void bridge()
      .readerAnalysis?.()
      .then((next) => setReport(next ?? null))
      .catch(() => setReport(null));
  }, []);
  useEffect(() => {
    if (!document) return;
    refreshAnalysis();
  }, [document, refreshAnalysis]);
  // Poll while the library is still analysing this PDF.
  useEffect(() => {
    if (!working(report)) return;
    const timer = setTimeout(refreshAnalysis, 2000);
    return () => clearTimeout(timer);
  }, [report, refreshAnalysis]);
  const rerun = () => {
    setReport((r) => (r ? { ...r, analysis: null, references: [], indexStatus: "pending" } : r));
    void bridge()
      .readerReanalyze?.()
      .then(refreshAnalysis)
      .catch((e) => setNotice(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "")));
  };
  const latestState = useRef<PdfJsViewState | undefined>(undefined);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    let alive = true;
    const stop = bridge().on("search-target", (payload) => {
      if (alive) {
        setTarget(payload as Target | undefined);
        if (!payload) reader.current?.closeSearch();
      }
    });
    const stopNavigation = bridge().on("search-navigation", (payload) => {
      if (alive) setNavigation(payload as Navigation);
    });
    void bridge()
      .readerReady()
      .then((initial) => {
        if (!alive) return;
        const file = new File(
          [],
          /\.pdf$/i.test(initial.source.title)
            ? initial.source.title
            : `${initial.source.title}.pdf`,
          { type: "application/pdf", lastModified: 0 },
        );
        registerManagedSource(file, initial.source);
        setDocument({ file, initial });
        setNotesOpen(!!initial.notesOpen);
        if (initial.focus) setFocus(initial.focus);
        setTarget((current) => current ?? initial.searchTarget);
        if (initial.searchNavigation) setNavigation(initial.searchNavigation);
        setPage((initial.viewState?.pageIndex ?? 0) + 1);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
      stop();
      stopNavigation();
      clearTimeout(stateTimer.current);
      if (latestState.current) bridge().readerState(latestState.current);
    };
  }, []);
  const viewChanged = useCallback((state: PdfJsViewState) => {
    latestState.current = state;
    setPage(state.pageIndex + 1);
    bridge().readerState(state);
  }, []);
  const panel = (name: PdfReaderPanel) => reader.current?.togglePanel(name);
  const navigate = async (direction: number) => {
    setNavigating(true);
    setNavigationError("");
    try {
      await bridge().readerResult?.(direction);
    } catch (e) {
      setNavigationError(String(e));
    } finally {
      setNavigating(false);
    }
  };
  const closeSearch = () => {
    reader.current?.closeSearch();
    setShowSearch(false);
    setQuery("");
  };
  if (error)
    return (
      <main className="key-ui-root key-pdf-error">
        <h2>Unable to open PDF</h2>
        <p>{error}</p>
        <Button variant="secondary" onClick={() => location.reload()}>
          Retry
        </Button>
      </main>
    );
  if (!document)
    return (
      <main className="key-ui-root key-pdf-loading" role="status">
        Opening PDF…
      </main>
    );
  return (
    <main className="key-ui-root key-pdf-reader">
      <header className="key-pdf-toolbar" aria-label="PDF controls">
        <div className="key-pdf-toolbar-group">
          <span className="key-pdf-seg">
            <button
              className="key-pdf-tool"
              title="Document outline"
              aria-label="Document outline"
              aria-pressed={chrome?.activePanel === "outline"}
              onClick={() => panel("outline")}
            >
              <Icon name="list" />
            </button>
          </span>
          <span className="key-pdf-page" aria-label={`Page ${page} of ${chrome?.pageCount || "…"}`}>
            {page}
            <span> of {chrome?.pageCount || "…"}</span>
          </span>
        </div>
        <div className="key-pdf-toolbar-group key-pdf-toolbar-middle">
          <span className="key-pdf-seg">
            <button className="key-pdf-tool" aria-label="Zoom out" title="Zoom out" onClick={() => reader.current?.zoomOut()}>
              <Icon name="minus" />
            </button>
            <button className="key-pdf-tool key-pdf-zoom" title="Actual size" onClick={() => reader.current?.actualSize()}>
              {Math.round((chrome?.zoom ?? 1) * 100)}%
            </button>
            <button className="key-pdf-tool" aria-label="Zoom in" title="Zoom in" onClick={() => reader.current?.zoomIn()}>
              <Icon name="plus" />
            </button>
            <span className="key-pdf-seg-divider" aria-hidden="true" />
            <button className="key-pdf-tool" aria-label="Fit width" title="Fit width" onClick={() => reader.current?.fitWidth()}>
              <Icon name="fitWidth" />
            </button>
          </span>
        </div>
        <div className="key-pdf-toolbar-group key-pdf-toolbar-end">
          <span className="key-pdf-seg">
            <button
              className="key-pdf-tool"
              aria-label="Find"
              title="Find in this PDF (⌘F)"
              aria-pressed={showSearch}
              onClick={() => {
                setShowSearch(!showSearch);
                if (showSearch) closeSearch();
              }}
            >
              <Icon name="search" />
            </button>
            <button
              className="key-pdf-tool key-pdf-tool-label"
              aria-label="References"
              title="References cited in this PDF"
              aria-pressed={chrome?.activePanel === "references"}
              onClick={() => panel("references")}
            >
              <Icon name="book" />
              {chrome?.referenceCount ? <span className="key-pdf-count">{chrome.referenceCount}</span> : null}
            </button>
          </span>
          {bridge().readerNotes && (
            <button
              className="key-pdf-details"
              aria-pressed={notesOpen}
              title="Show or hide this source's details and note beside the PDF"
              onClick={() => void bridge().readerNotes?.().then((open) => setNotesOpen(open))}
            >
              <Icon name="panelRight" />
              <span>Details &amp; notes</span>
            </button>
          )}
        </div>
      </header>
      {showSearch && (
        <form
          className="key-pdf-find"
          onSubmit={(event) => {
            event.preventDefault();
            reader.current?.nextSearchResult();
          }}
        >
          <Input
            density="compact"
            autoFocus
            aria-label="Find in PDF"
            placeholder="Find in this PDF"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              reader.current?.setSearchQuery(event.target.value);
            }}
          />
          <span role="status">
            {chrome?.searching
              ? "Searching…"
              : `${chrome?.searchCount ? chrome.activeSearchIndex + 1 : 0} of ${chrome?.searchCount ?? 0}`}
          </span>
          <Button
            size="icon"
            variant="ghost"
            type="button"
            aria-label="Previous match"
            onClick={() => reader.current?.previousSearchResult()}
          >
            ↑
          </Button>
          <Button
            size="icon"
            variant="ghost"
            type="submit"
            aria-label="Next match"
          >
            ↓
          </Button>
          <Button
            size="icon"
            variant="ghost"
            type="button"
            aria-label="Close find"
            onClick={closeSearch}
          >
            ×
          </Button>
        </form>
      )}
      <section className="key-pdf-surface">
        {notice && (
          <div className="key-pdf-notice" role="alert">
            {notice}
          </div>
        )}
        {/* The search result bar floats under the toolbar, over the page. */}
        {target && (
          <div className="key-pdf-result" role="toolbar" aria-label="Search result">
            {bridge().readerBack && (
              <button className="key-pdf-result-back" onClick={() => bridge().readerBack?.()} title="Back to the search results">
                <span aria-hidden="true">←</span>
                <span>Back to search</span>
              </button>
            )}
            <span className="key-pdf-result-label" title={navigation.query}>
              {navigation.query ? <strong>“{navigation.query}”</strong> : <strong>Search passage</strong>}
              <span>p. {target.page + 1}</span>
            </span>
            {navigation.total > 0 && (
              <span className="key-pdf-result-steps">
                <button aria-label="Previous result" title="Previous result" disabled={navigating || navigation.index <= 0} onClick={() => void navigate(-1)}>
                  ↑
                </button>
                <span className="key-pdf-result-count">
                  {navigation.index + 1} / {navigation.total}
                </span>
                <button
                  aria-label="Next result"
                  title="Next result"
                  disabled={navigating || navigation.index >= navigation.total - 1}
                  onClick={() => void navigate(1)}
                >
                  ↓
                </button>
              </span>
            )}
            {navigationError && <span role="alert" className="key-pdf-result-error">{navigationError}</span>}
            <button
              className="key-pdf-result-close"
              aria-label="Close search result"
              title="Close: keep the document, drop the highlight"
              onClick={() => {
                setTarget(undefined);
                reader.current?.closeSearch();
                void bridge().readerDismiss?.();
              }}
            >
              ×
            </button>
          </div>
        )}
        <PdfJsBenchmarkApp
          ref={reader}
          embedded
          initialFile={document.file}
          paneTitle={document.initial.source.title}
          initialViewState={document.initial.viewState}
          searchTarget={target}
          onViewStateChange={viewChanged}
          onChromeStateChange={setChrome}
          onRequestControlMode={(mode) => {
            setShowSearch(mode === "search");
          }}
          references={
            report?.references.length || ["done", "none", "failed"].includes(report?.analysis?.referencesStatus ?? "")
              ? report!.references
                  .filter((r) => r.number != null && r.page != null)
                  .map((r) => ({
                    number: r.number!,
                    page: r.page!,
                    xFraction: r.rects?.[0] ? r.rects[0][0] / 65535 : undefined,
                    yFraction: r.rects?.[0] ? r.rects[0][1] / 65535 : undefined,
                    text: r.text,
                  }))
              : undefined
          }
          referencesHeader={bridge().readerAnalysis ? <AnalysisStatus report={report} onRerun={rerun} /> : undefined}
          referenceAside={(reference) => {
            const known = report?.references.find((r) => r.number === reference.number);
            const meta = known?.metadata;
            if (!meta?.title && !known?.matchedSourceId) return null;
            return (
              <div className="key-pdf-reference-aside">
                {meta?.title && (
                  <span title={meta.doi ? `doi:${meta.doi}` : undefined}>
                    {meta.title}
                    {meta.year ? ` (${meta.year})` : ""}
                  </span>
                )}
                {known?.matchedSourceId && (
                  <button type="button" onClick={() => void bridge().readerOpenSource?.(known.matchedSourceId!)}>
                    In your library →
                  </button>
                )}
              </div>
            );
          }}
          onSendTo={bridge().readerSendTo ? (highlight) => void bridge().readerSendTo?.(highlight).catch(() => {}) : undefined}
          onAddToNote={
            bridge().readerAddToNote
              ? (passage) =>
                  void bridge()
                    .readerAddToNote?.(passage)
                    .then(() => setNotesOpen(true))
                    .catch((e) => {
                      setNotice(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
                      setTimeout(() => setNotice(""), 4000);
                    })
              : undefined
          }
        />
      </section>
    </main>
  );
}
