import { useState } from 'react';
import { ZoomMode, useZoom } from '@embedpdf/plugin-zoom/react';
import { useScroll } from '@embedpdf/plugin-scroll/react';
import { useSearch } from '@embedpdf/plugin-search/react';
import { useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/react';

interface Props {
  documentId: string;
  searchOpen: boolean;
  commentsOpen: boolean;
  referencesOpen: boolean;
  onToggleSearch: () => void;
  onToggleComments: () => void;
  onToggleReferences: () => void;
  onBenchmark: () => void;
}

export function ReaderToolbar({
  documentId,
  searchOpen,
  commentsOpen,
  referencesOpen,
  onToggleSearch,
  onToggleComments,
  onToggleReferences,
  onBenchmark,
}: Props) {
  const zoom = useZoom(documentId);
  const scroll = useScroll(documentId);
  const search = useSearch(documentId);
  const documents = useDocumentManagerCapability();
  const [query, setQuery] = useState('');

  const runSearch = () => {
    const value = query.trim();
    if (!value) return;
    search.provides?.searchAllPages(value);
    if (!searchOpen) onToggleSearch();
  };

  return (
    <div className="reader-toolbar">
      <div className="toolbar-group">
        <button onClick={() => zoom.provides?.zoomOut()} aria-label="Zoom out">−</button>
        <button
          className="zoom-value"
          onClick={() => zoom.provides?.requestZoom(ZoomMode.FitWidth)}
          title="Fit width"
        >
          {Math.round(zoom.state.currentZoomLevel * 100)}%
        </button>
        <button onClick={() => zoom.provides?.zoomIn()} aria-label="Zoom in">+</button>
      </div>
      <div className="toolbar-group page-counter">
        <button onClick={() => scroll.provides?.scrollToPreviousPage('smooth')}>‹</button>
        <span>
          {scroll.state.currentPage} / {documents.provides?.getDocument(documentId)?.pageCount ?? scroll.state.totalPages}
        </span>
        <button onClick={() => scroll.provides?.scrollToNextPage('smooth')}>›</button>
      </div>
      <form
        className="search-box"
        onSubmit={event => {
          event.preventDefault();
          runSearch();
        }}
      >
        <span>⌕</span>
        <input
          aria-label="Search PDF"
          placeholder="Search in PDF"
          value={query}
          onChange={event => {
            const value = event.target.value;
            setQuery(value);
            if (value.trim()) {
              search.provides?.searchAllPages(value);
            } else {
              search.provides?.stopSearch();
            }
          }}
        />
        <button type="submit" className="search-submit" aria-label="Run search">↵</button>
        {search.state.loading && <span className="spinner" />}
      </form>
      <div className="toolbar-spacer" />
      <button className={searchOpen ? 'active' : ''} onClick={onToggleSearch}>Results</button>
      <button className={referencesOpen ? 'active' : ''} onClick={onToggleReferences}>References</button>
      <button className={commentsOpen ? 'active' : ''} onClick={onToggleComments}>Comments</button>
      <button onClick={onBenchmark} title="Run the standard scroll and zoom scenario">Benchmark</button>
    </div>
  );
}
