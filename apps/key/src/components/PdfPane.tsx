import { useRef, useState } from 'react';
import { DocumentContent } from '@embedpdf/plugin-document-manager/react';
import {
  GlobalPointerProvider,
  PagePointerProvider,
} from '@embedpdf/plugin-interaction-manager/react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { Rotate } from '@embedpdf/plugin-rotate/react';
import { SearchLayer } from '@embedpdf/plugin-search/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { AnnotationLayer as EmbedAnnotationLayer } from '@embedpdf/plugin-annotation/react';
import { ReaderToolbar } from './ReaderToolbar';
import { SearchPanel } from './SearchPanel';
import { CommentsPanel } from './CommentsPanel';
import { ReferencesPanel } from './ReferencesPanel';
import { SelectionActions } from './SelectionActions';
import { AppAnnotationLayer } from './AnnotationLayer';
import { NativeLinkLayer } from './NativeLinkLayer';
import { CanvasTilingLayer } from './CanvasTilingLayer';
import type { ReaderAnnotation } from '../model/annotations';
import type { BenchmarkResult } from '../benchmark/run-benchmark';
import { downloadBenchmark, runReaderBenchmark } from '../benchmark/run-benchmark';
import { useScroll } from '@embedpdf/plugin-scroll/react';
import { useZoom } from '@embedpdf/plugin-zoom/react';
import { useRenderQuality } from '../performance/use-render-quality';
import { usePaperAnalysis } from '../preprocessing/paper-analysis';

interface Props {
  documentId: string;
  placement: 'primary' | 'secondary' | 'warm-hidden';
  annotations: ReaderAnnotation[];
  onAnnotationsChange: (annotations: ReaderAnnotation[]) => void;
  onBenchmarkResult: (result: BenchmarkResult) => void;
}

export function PdfPane({
  documentId,
  placement,
  annotations,
  onAnnotationsChange,
  onBenchmarkResult,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [benchmarkStatus, setBenchmarkStatus] = useState<string | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
  const scroll = useScroll(documentId);
  const zoom = useZoom(documentId);
  const paneRef = useRef<HTMLElement>(null);
  const paperAnalysis = usePaperAnalysis(documentId);
  const renderQuality = useRenderQuality({
    documentId,
    paneRef,
    currentPage: scroll.state.currentPage,
    visible: placement !== 'warm-hidden',
  });
  const analysisProbe =
    paperAnalysis.status === 'ready'
      ? {
          status: paperAnalysis.status,
          backendMs: paperAnalysis.result.processingMs,
          roundTripMs: paperAnalysis.roundTripMs,
          bytes: paperAnalysis.byteLength,
          isScientific: paperAnalysis.result.isScientific,
          references: paperAnalysis.result.references.length,
          syntheticLinks: paperAnalysis.result.syntheticLinks.length,
          syntheticLinkPages: [
            ...new Set(
              paperAnalysis.result.syntheticLinks.map(link => link.page + 1),
            ),
          ],
        }
      : paperAnalysis.status === 'processing'
        ? {
            status: paperAnalysis.status,
            elapsedMs: performance.now() - paperAnalysis.startedAt,
            bytes: paperAnalysis.byteLength,
          }
        : paperAnalysis;

  const runBenchmark = async () => {
    if (!scroll.provides || !zoom.provides) {
      setBenchmarkStatus('Benchmark controls are not ready');
      return;
    }
    setBenchmarkStatus('Benchmark running…');
    window.__KEY_BENCHMARK_ERROR__ = undefined;
    try {
      const result = await runReaderBenchmark(
        documentId,
        'wasm',
        scroll.provides,
        zoom.provides,
      );
      onBenchmarkResult(result);
      setBenchmarkResult(result);
      setBenchmarkStatus(
        `WASM · ${result.durationMs.toFixed(1)} ms · ` +
          `p95 ${result.frameIntervalMs.p95.toFixed(1)} ms · ` +
          `exact ${result.exactRenderSettleMs.p95.toFixed(1)} ms p95`,
      );
      downloadBenchmark(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.__KEY_BENCHMARK_ERROR__ = message;
      setBenchmarkStatus(message);
    }
  };

  return (
    <section
      ref={paneRef}
      className={`pdf-pane ${placement}`}
      data-document-id={documentId}
      data-render-quality={renderQuality.status}
      data-render-settle-ms={renderQuality.settleMs?.toFixed(1)}
      aria-label={`PDF pane diagnostics ${JSON.stringify({
        render: {
          status: renderQuality.status,
          settleMs: renderQuality.settleMs,
          reason: renderQuality.reason,
          visiblePages: renderQuality.visiblePages,
          visibleImages: renderQuality.visibleImages,
          minimumDeviceDensity: renderQuality.minimumDeviceDensity,
        },
        preprocessing: analysisProbe,
      })}`}
      aria-hidden={placement === 'warm-hidden'}
    >
      <ReaderToolbar
        documentId={documentId}
        searchOpen={searchOpen}
        commentsOpen={commentsOpen}
        referencesOpen={referencesOpen}
        onToggleSearch={() => setSearchOpen(open => !open)}
        onToggleComments={() => setCommentsOpen(open => !open)}
        onToggleReferences={() => setReferencesOpen(open => !open)}
        onBenchmark={() => void runBenchmark()}
      />
      <div className="pane-body">
        {benchmarkStatus && (
          <output
            className="benchmark-status"
            aria-label={benchmarkResult ? JSON.stringify(benchmarkResult) : benchmarkStatus}
            data-benchmark-result={benchmarkResult ? JSON.stringify(benchmarkResult) : undefined}
          >
            {benchmarkStatus}
          </output>
        )}
        <div className="viewer-host">
          <DocumentContent documentId={documentId}>
            {({ isLoading, isError, isLoaded }) => (
              <>
                {isLoading && <div className="loading-state">Opening PDF…</div>}
                {isError && <div className="loading-state error">Could not open this PDF.</div>}
                {isLoaded && (
                  <GlobalPointerProvider documentId={documentId}>
                    <Viewport className="pdf-viewport" documentId={documentId}>
                      <ZoomGestureWrapper documentId={documentId}>
                        <Scroller
                          documentId={documentId}
                          renderPage={({ pageIndex }) => (
                            <Rotate
                              documentId={documentId}
                              pageIndex={pageIndex}
                              className="pdf-page"
                            >
                              <PagePointerProvider documentId={documentId} pageIndex={pageIndex}>
                                <CanvasTilingLayer
                                  documentId={documentId}
                                  pageIndex={pageIndex}
                                />
                                <SearchLayer documentId={documentId} pageIndex={pageIndex} />
                                <SelectionLayer
                                  documentId={documentId}
                                  pageIndex={pageIndex}
                                  selectionMenu={props => (
                                    <SelectionActions
                                      {...props}
                                      documentId={documentId}
                                      onAdd={annotation => {
                                        const next = [...annotations, annotation];
                                        onAnnotationsChange(next);
                                        setCommentsOpen(true);
                                      }}
                                    />
                                  )}
                                />
                                <AppAnnotationLayer
                                  documentId={documentId}
                                  pageIndex={pageIndex}
                                  annotations={annotations}
                                />
                                <EmbedAnnotationLayer
                                  documentId={documentId}
                                  pageIndex={pageIndex}
                                />
                                <NativeLinkLayer
                                  documentId={documentId}
                                  pageIndex={pageIndex}
                                  paper={
                                    paperAnalysis.status === 'ready'
                                      ? paperAnalysis.result
                                      : null
                                  }
                                />
                              </PagePointerProvider>
                            </Rotate>
                          )}
                        />
                      </ZoomGestureWrapper>
                    </Viewport>
                  </GlobalPointerProvider>
                )}
              </>
            )}
          </DocumentContent>
        </div>
        {searchOpen && <SearchPanel documentId={documentId} onClose={() => setSearchOpen(false)} />}
        {commentsOpen && (
          <CommentsPanel
            documentId={documentId}
            annotations={annotations}
            onClose={() => setCommentsOpen(false)}
            onDelete={id => onAnnotationsChange(annotations.filter(annotation => annotation.id !== id))}
          />
        )}
        {referencesOpen && (
          <ReferencesPanel
            documentId={documentId}
            onClose={() => setReferencesOpen(false)}
          />
        )}
      </div>
    </section>
  );
}
