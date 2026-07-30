import { useScroll } from '@embedpdf/plugin-scroll/react';
import { usePaperAnalysis } from '../preprocessing/paper-analysis';

export function ReferencesPanel({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const analysis = usePaperAnalysis(documentId);
  const { provides: scroll } = useScroll(documentId);

  return (
    <aside className="side-panel" aria-label="Backend paper references">
      <div className="panel-title">
        <div>
          <strong>Paper references</strong>
          <small>
            {analysis.status === 'ready'
              ? `${analysis.result.references.length} references · ${analysis.roundTripMs.toFixed(0)} ms`
              : analysis.status === 'processing'
                ? 'Backend preprocessing…'
                : analysis.status === 'error'
                  ? 'Preprocessing failed'
                  : 'Waiting for paper'}
          </small>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <div className="panel-list">
        {analysis.status === 'ready' && (
          <>
            <div className="analysis-summary">
              <strong>{analysis.result.isScientific ? 'Scientific paper' : 'No paper structure detected'}</strong>
              <span>
                Backend {analysis.result.processingMs.toFixed(0)} ms · IPC total{' '}
                {analysis.roundTripMs.toFixed(0)} ms
              </span>
              <span>
                {analysis.result.syntheticLinks.length} inferred citation links ·{' '}
                {analysis.result.signals.doiEntries} DOI signals
              </span>
            </div>
            {analysis.result.references.map(reference => (
              <button
                className="result reference-result"
                key={reference.number}
                onClick={() =>
                  scroll?.scrollToPage({
                    pageNumber: reference.page + 1,
                    behavior: 'smooth',
                  })
                }
              >
                <strong>[{reference.number}]</strong>
                <span>{reference.text}</span>
                <small>Page {reference.page + 1}</small>
              </button>
            ))}
            {analysis.result.references.length === 0 && (
              <p className="panel-empty">
                The backend completed, but did not find a sufficiently reliable reference section.
              </p>
            )}
          </>
        )}
        {analysis.status === 'processing' && (
          <p className="panel-empty">
            The WASM viewer remains interactive while the Rust/PDFium backend extracts layout and
            references.
          </p>
        )}
        {analysis.status === 'error' && <p className="panel-empty">{analysis.message}</p>}
      </div>
    </aside>
  );
}
