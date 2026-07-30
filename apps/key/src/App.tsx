import { useMemo, useState } from 'react';
import { EmbedPDF, type PluginBatchRegistrations } from '@embedpdf/core/react';
import { createPluginRegistration } from '@embedpdf/core';
import {
  DocumentManagerPluginPackage,
} from '@embedpdf/plugin-document-manager/react';
import { ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { ScrollPluginPackage, ScrollStrategy } from '@embedpdf/plugin-scroll/react';
import { InteractionManagerPluginPackage } from '@embedpdf/plugin-interaction-manager/react';
import { ZoomMode, ZoomPluginPackage } from '@embedpdf/plugin-zoom/react';
import { PanPluginPackage } from '@embedpdf/plugin-pan/react';
import { SpreadMode, SpreadPluginPackage } from '@embedpdf/plugin-spread/react';
import { RotatePluginPackage } from '@embedpdf/plugin-rotate/react';
import { RenderPluginPackage } from '@embedpdf/plugin-render/react';
import { TilingPluginPackage } from '@embedpdf/plugin-tiling/react';
import { SelectionPluginPackage } from '@embedpdf/plugin-selection/react';
import { SearchPluginPackage } from '@embedpdf/plugin-search/react';
import { ThumbnailPluginPackage } from '@embedpdf/plugin-thumbnail/react';
import { AnnotationPluginPackage } from '@embedpdf/plugin-annotation/react';
import { AffineTabs } from './components/AffineTabs';
import { PdfPane } from './components/PdfPane';
import { PreprocessingFilePicker } from './components/PreprocessingFilePicker';
import { usePdfEngine } from './engines/use-pdf-engine';
import {
  loadAnnotations,
  saveAnnotations,
  type ReaderAnnotation,
} from './model/annotations';
import type { BenchmarkResult } from './benchmark/run-benchmark';

declare global {
  interface Window {
    __KEY_LAST_BENCHMARK__?: BenchmarkResult;
    __KEY_BENCHMARK_ERROR__?: string;
  }
}

function plugins(): PluginBatchRegistrations {
  return [
    createPluginRegistration(DocumentManagerPluginPackage, { maxDocuments: 16 }),
    createPluginRegistration(ViewportPluginPackage, { viewportGap: 12 }),
    createPluginRegistration(ScrollPluginPackage, {
      defaultStrategy: ScrollStrategy.Vertical,
      defaultBufferSize: 2,
    }),
    createPluginRegistration(InteractionManagerPluginPackage),
    createPluginRegistration(ZoomPluginPackage, {
      defaultZoomLevel: ZoomMode.FitWidth,
      minZoom: 0.2,
      maxZoom: 5,
    }),
    createPluginRegistration(PanPluginPackage),
    createPluginRegistration(SpreadPluginPackage, {
      defaultSpreadMode: SpreadMode.None,
    }),
    createPluginRegistration(RotatePluginPackage),
    createPluginRegistration(RenderPluginPackage, {
      defaultImageType: 'image/png',
    }),
    createPluginRegistration(TilingPluginPackage, {
      // Native key-pdfium accepts render rectangles up to 1,088 physical
      // pixels. 512 CSS pixels stays inside that boundary on a 2× Retina
      // display while retaining exact device-pixel-density output.
      tileSize: 512,
      overlapPx: 3,
      extraRings: 0,
    }),
    createPluginRegistration(SelectionPluginPackage),
    createPluginRegistration(SearchPluginPackage, { showAllResults: true }),
    createPluginRegistration(ThumbnailPluginPackage, { width: 120, paddingY: 8 }),
    createPluginRegistration(AnnotationPluginPackage),
  ];
}

export default function App() {
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>(loadAnnotations);
  const [splitEnabled, setSplitEnabled] = useState(false);
  const { engine, loading, error } = usePdfEngine();
  const registrations = useMemo(plugins, []);

  const updateAnnotations = (next: ReaderAnnotation[]) => {
    setAnnotations(next);
    saveAnnotations(next);
  };

  return (
    <main className="app-shell">
      <div className="engine-switcher">
        <span>Renderer</span>
        <strong>PDFium WASM worker</strong>
        <span>Backend</span>
        <strong>Key paper preprocessing</strong>
      </div>
      {loading && <div className="boot-state">Starting PDFium WASM…</div>}
      {error && <div className="boot-state error">{error.message}</div>}
      {engine && (
        <EmbedPDF engine={engine} plugins={registrations}>
          {({ pluginsReady, activeDocumentId, documentStates }) => {
            if (!pluginsReady) return <div className="boot-state">Preparing PDF workspace…</div>;
            const secondary =
              splitEnabled && documentStates.length > 1
                ? documentStates.find(document => document.id !== activeDocumentId)?.id ?? null
                : null;
            return (
              <div className="workspace">
                <PreprocessingFilePicker />
                <AffineTabs
                  documents={documentStates}
                  activeDocumentId={activeDocumentId}
                  splitDocumentId={secondary}
                  onToggleSplit={() => setSplitEnabled(value => !value)}
                />
                {activeDocumentId ? (
                  <div className={`pane-grid ${secondary ? 'split' : ''}`}>
                    {documentStates.map(document => {
                      const placement =
                        document.id === activeDocumentId
                          ? 'primary'
                          : document.id === secondary
                            ? 'secondary'
                            : 'warm-hidden';
                      return (
                        <PdfPane
                          key={document.id}
                          documentId={document.id}
                          placement={placement}
                          annotations={annotations}
                          onAnnotationsChange={updateAnnotations}
                          onBenchmarkResult={result => {
                            window.__KEY_LAST_BENCHMARK__ = result;
                          }}
                        />
                      );
                    })}
                    {secondary && <div className="split-gutter" />}
                  </div>
                ) : (
                  <button className="empty-state" onClick={() => document.querySelector<HTMLInputElement>('input[type=file]')?.click()}>
                    <span className="empty-icon">PDF</span>
                    <strong>Open a PDF to begin</strong>
                    <small>WASM rendering with backend layout and reference preprocessing.</small>
                  </button>
                )}
              </div>
            );
          }}
        </EmbedPDF>
      )}
    </main>
  );
}
