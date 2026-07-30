import { useSearch } from '@embedpdf/plugin-search/react';

export function SearchPanel({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { state, provides } = useSearch(documentId);
  return (
    <aside className="side-panel">
      <div className="panel-title">
        <div>
          <strong>Search</strong>
          <small>{state.loading ? 'Searching…' : `${state.total} results`}</small>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <div className="panel-list">
        {state.results.map((result, index) => (
          <button
            key={`${result.pageIndex}-${result.charIndex}`}
            className={index === state.activeResultIndex ? 'result active' : 'result'}
            onClick={() => provides?.goToResult(index)}
          >
            <small>Page {result.pageIndex + 1}</small>
            <span>
              {result.context.before}
              <mark>{result.context.match}</mark>
              {result.context.after}
            </span>
          </button>
        ))}
        {!state.loading && state.results.length === 0 && (
          <p className="panel-empty">Search results will appear here.</p>
        )}
      </div>
    </aside>
  );
}
