import { useState } from 'react';
import type { DocumentState } from '@embedpdf/core';
import { useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/react';

interface DocumentSwitchMeasurement {
  documentId: string;
  latencyMs: number;
  hadWarmPixels: boolean;
  measuredAt: string;
}

declare global {
  interface Window {
    __KEY_LAST_SWITCH__?: DocumentSwitchMeasurement;
  }
}

interface Props {
  documents: DocumentState[];
  activeDocumentId: string | null;
  splitDocumentId: string | null;
  onToggleSplit: () => void;
}

export function AffineTabs({
  documents,
  activeDocumentId,
  splitDocumentId,
  onToggleSplit,
}: Props) {
  const { provides } = useDocumentManagerCapability();
  const [lastSwitch, setLastSwitch] = useState<DocumentSwitchMeasurement | null>(null);

  const activateDocument = (documentId: string) => {
    if (!provides || documentId === activeDocumentId) return;
    const started = performance.now();
    provides.setActiveDocument(documentId);
    const measure = () => {
      const pane = [...document.querySelectorAll<HTMLElement>('.pdf-pane')].find(
        candidate => candidate.dataset.documentId === documentId,
      );
      if (!pane?.classList.contains('primary')) {
        requestAnimationFrame(measure);
        return;
      }
      const canvas = pane.querySelector<HTMLCanvasElement>('.crisp-canvas-layer');
      const measurement: DocumentSwitchMeasurement = {
        documentId,
        latencyMs: performance.now() - started,
        hadWarmPixels: canvas?.dataset.renderComplete === 'true',
        measuredAt: new Date().toISOString(),
      };
      window.__KEY_LAST_SWITCH__ = measurement;
      setLastSwitch(measurement);
      document.documentElement.dataset.lastSwitchMs = measurement.latencyMs.toFixed(1);
      document.documentElement.dataset.lastSwitchWarm = String(measurement.hadWarmPixels);
    };
    requestAnimationFrame(measure);
  };

  return (
    <header className="affine-header" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-mark">K</span>
        <span>Key</span>
      </div>
      <div className="tab-rail" role="tablist" aria-label="Open PDFs">
        {documents.map(document => {
          const active = document.id === activeDocumentId;
          const paired = document.id === splitDocumentId;
          return (
            <button
              className={`affine-tab ${active ? 'active' : ''} ${paired ? 'paired' : ''}`}
              key={document.id}
              role="tab"
              aria-selected={active}
              onClick={() => activateDocument(document.id)}
            >
              <span className="pdf-glyph">PDF</span>
              <span className="tab-title">{document.name ?? 'Untitled PDF'}</span>
              <span
                className="tab-close"
                role="button"
                aria-label={`Close ${document.name ?? 'document'}`}
                onClick={event => {
                  event.stopPropagation();
                  void provides?.closeDocument(document.id);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
        <button className="add-tab" aria-label="Open PDF" onClick={() => provides?.openFileDialog()}>
          +
        </button>
      </div>
      {lastSwitch && (
        <output
          className={`switch-quality ${lastSwitch.hadWarmPixels ? 'warm' : 'cold'}`}
          aria-label={`Document switch ${JSON.stringify(lastSwitch)}`}
        >
          {lastSwitch.latencyMs.toFixed(1)} ms · {lastSwitch.hadWarmPixels ? 'warm' : 'cold'}
        </output>
      )}
      <button
        className={`icon-button split-button ${splitDocumentId ? 'active' : ''}`}
        onClick={onToggleSplit}
        disabled={documents.length < 2}
        title="Toggle split view"
      >
        ◫
      </button>
    </header>
  );
}
