import { useEffect, useState } from 'react';
import type { PdfEngine } from '@embedpdf/models';

const DEFAULT_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.14.4/dist/pdfium.wasm';

export function usePdfEngine() {
  const [engine, setEngine] = useState<PdfEngine<Blob> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    let owned: PdfEngine<Blob> | null = null;
    setLoading(true);
    setError(null);
    setEngine(null);

    void (async () => {
      const { createPdfiumEngine } = await import('@embedpdf/engines/pdfium-worker-engine');
      owned = createPdfiumEngine(import.meta.env.VITE_EMBEDPDF_WASM_URL || DEFAULT_WASM_URL, {
        fontFallback: null,
        encoderPoolSize: 2,
      });
      if (!disposed) {
        setEngine(owned);
        setLoading(false);
      }
    })().catch(reason => {
      if (!disposed) {
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        setLoading(false);
      }
    });

    return () => {
      disposed = true;
      const current = owned;
      current?.closeAllDocuments?.().wait(
        () => current.destroy?.(),
        () => current.destroy?.(),
      );
    };
  }, []);

  return { engine, error, loading };
}
