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

type Target = {
  id: string;
  documentHash: string;
  page: number;
  rects: number[][];
  targetText: string;
};
interface Ready {
  source: ManagedSource;
  viewState?: PdfJsViewState;
  searchTarget?: Target;
}
interface ReaderBridge {
  readerReady(): Promise<Ready>;
  readerState(state: PdfJsViewState): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  readerBack?(): void;
}
const bridge = () => (window as unknown as { key: ReaderBridge }).key;

export default function PdfReader() {
  const reader = useRef<PdfReaderHandle>(null);
  const [document, setDocument] = useState<{ file: File; initial: Ready }>();
  const [error, setError] = useState("");
  const [chrome, setChrome] = useState<PdfReaderChromeState>();
  const [target, setTarget] = useState<Target>();
  const [page, setPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const latestState = useRef<PdfJsViewState | undefined>(undefined);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    let alive = true;
    const stop = bridge().on("search-target", (payload) => {
      if (alive) setTarget(payload as Target);
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
        setTarget((current) => current ?? initial.searchTarget);
        setPage((initial.viewState?.pageIndex ?? 0) + 1);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
      stop();
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
  const closeSearch = () => {
    reader.current?.closeSearch();
    setShowSearch(false);
    setQuery("");
  };
  if (error)
    return (
      <main className="key-pdf-error">
        <h2>Unable to open PDF</h2>
        <p>{error}</p>
        <button onClick={() => location.reload()}>Retry</button>
      </main>
    );
  if (!document)
    return (
      <main className="key-pdf-loading" role="status">
        Opening PDF…
      </main>
    );
  return (
    <main className="key-pdf-reader">
      <header className="key-pdf-toolbar" aria-label="PDF controls">
        <div className="key-pdf-toolbar-group">
          <button
            title="Document outline"
            aria-label="Document outline"
            aria-pressed={chrome?.activePanel === "outline"}
            onClick={() => panel("outline")}
          >
            ☷
          </button>
          <span className="key-pdf-page">
            {page} <span>/ {chrome?.pageCount || "…"}</span>
          </span>
        </div>
        <div className="key-pdf-toolbar-group">
          <button
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => reader.current?.zoomOut()}
          >
            −
          </button>
          <button
            className="key-pdf-zoom"
            title="Actual size"
            onClick={() => reader.current?.actualSize()}
          >
            {Math.round((chrome?.zoom ?? 1) * 100)}%
          </button>
          <button
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => reader.current?.zoomIn()}
          >
            +
          </button>
          <button title="Fit width" onClick={() => reader.current?.fitWidth()}>
            Fit width
          </button>
        </div>
        <div className="key-pdf-toolbar-group key-pdf-toolbar-end">
          <button
            aria-pressed={showSearch}
            onClick={() => {
              setShowSearch(!showSearch);
              if (showSearch) closeSearch();
            }}
          >
            Find
          </button>
          <button
            aria-pressed={chrome?.activePanel === "references"}
            onClick={() => panel("references")}
          >
            References
            {chrome?.referenceCount ? ` ${chrome.referenceCount}` : ""}
          </button>
          <button
            aria-pressed={chrome?.activePanel === "comments"}
            onClick={() => panel("comments")}
          >
            Comments{chrome?.commentCount ? ` ${chrome.commentCount}` : ""}
          </button>
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
          <input
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
          <button
            type="button"
            aria-label="Previous match"
            onClick={() => reader.current?.previousSearchResult()}
          >
            ↑
          </button>
          <button type="submit" aria-label="Next match">
            ↓
          </button>
          <button type="button" aria-label="Close find" onClick={closeSearch}>
            ×
          </button>
        </form>
      )}
      {target && (
        <div className="key-pdf-target" role="status">
          {bridge().readerBack && (
            <button onClick={() => bridge().readerBack?.()}>
              Back to results
            </button>
          )}
          <span>Search passage · page {target.page + 1}</span>
          <button
            onClick={() => {
              setTarget(undefined);
              reader.current?.closeSearch();
            }}
          >
            Dismiss highlight
          </button>
        </div>
      )}
      <section className="key-pdf-surface">
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
        />
      </section>
    </main>
  );
}
