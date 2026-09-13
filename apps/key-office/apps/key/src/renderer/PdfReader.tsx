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
  searchNavigation?: { index: number; total: number; shared?: boolean };
}
interface ReaderBridge {
  readerReady(): Promise<Ready>;
  readerState(state: PdfJsViewState): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  readerBack?(): void;
  readerResult?(direction: number): Promise<void>;
}
const bridge = () => (window as unknown as { key: ReaderBridge }).key;

export default function PdfReader() {
  const reader = useRef<PdfReaderHandle>(null);
  const [document, setDocument] = useState<{ file: File; initial: Ready }>();
  const [error, setError] = useState("");
  const [chrome, setChrome] = useState<PdfReaderChromeState>();
  const [target, setTarget] = useState<Target>();
  const [navigation, setNavigation] = useState<{
    index: number;
    total: number;
    shared?: boolean;
  }>({ index: -1, total: 0 });
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState("");
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
      if (alive) {
        setTarget(payload as Target | undefined);
        if (!payload) reader.current?.closeSearch();
      }
    });
    const stopNavigation = bridge().on("search-navigation", (payload) => {
      if (alive)
        setNavigation(
          payload as { index: number; total: number; shared?: boolean },
        );
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
          <Button
            size="icon"
            variant="ghost"
            title="Document outline"
            aria-label="Document outline"
            aria-pressed={chrome?.activePanel === "outline"}
            onClick={() => panel("outline")}
          >
            ☷
          </Button>
          <span className="key-pdf-page">
            {page} <span>/ {chrome?.pageCount || "…"}</span>
          </span>
        </div>
        <div className="key-pdf-toolbar-group">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => reader.current?.zoomOut()}
          >
            −
          </Button>
          <Button
            size="compact"
            variant="ghost"
            className="key-pdf-zoom"
            title="Actual size"
            onClick={() => reader.current?.actualSize()}
          >
            {Math.round((chrome?.zoom ?? 1) * 100)}%
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => reader.current?.zoomIn()}
          >
            +
          </Button>
          <Button
            size="compact"
            variant="ghost"
            title="Fit width"
            onClick={() => reader.current?.fitWidth()}
          >
            Fit width
          </Button>
        </div>
        <div className="key-pdf-toolbar-group key-pdf-toolbar-end">
          <Button
            size="compact"
            variant="ghost"
            aria-pressed={showSearch}
            onClick={() => {
              setShowSearch(!showSearch);
              if (showSearch) closeSearch();
            }}
          >
            Find
          </Button>
          <Button
            size="compact"
            variant="ghost"
            aria-pressed={chrome?.activePanel === "references"}
            onClick={() => panel("references")}
          >
            References
            {chrome?.referenceCount ? ` ${chrome.referenceCount}` : ""}
          </Button>
          <Button
            size="compact"
            variant="ghost"
            aria-pressed={chrome?.activePanel === "comments"}
            onClick={() => panel("comments")}
          >
            Comments{chrome?.commentCount ? ` ${chrome.commentCount}` : ""}
          </Button>
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
      {target && !navigation.shared && (
        <div className="key-pdf-target" role="status">
          {bridge().readerBack && (
            <Button
              size="compact"
              variant="ghost"
              onClick={() => bridge().readerBack?.()}
            >
              Back to results
            </Button>
          )}
          <span>Search passage · page {target.page + 1}</span>
          {navigation.total > 0 && (
            <>
              <Button
                size="compact"
                variant="ghost"
                disabled={navigating || navigation.index <= 0}
                onClick={() => void navigate(-1)}
              >
                Previous result
              </Button>
              <span>
                {navigation.index + 1} / {navigation.total} loaded results
              </span>
              <Button
                size="compact"
                variant="ghost"
                disabled={
                  navigating || navigation.index >= navigation.total - 1
                }
                onClick={() => void navigate(1)}
              >
                Next result
              </Button>
            </>
          )}
          {navigationError && <span role="alert">{navigationError}</span>}
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              setTarget(undefined);
              reader.current?.closeSearch();
            }}
          >
            Dismiss highlight
          </Button>
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
