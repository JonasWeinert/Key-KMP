import { useEffect, useRef, type ChangeEvent } from 'react';
import {
  useDocumentManagerCapability,
  useDocumentManagerPlugin,
} from '@embedpdf/plugin-document-manager/react';
import { discardPaperAnalysis, preprocessPaper } from '../preprocessing/paper-analysis';

type FileRequest = Parameters<
  NonNullable<ReturnType<typeof useDocumentManagerPlugin>['plugin']>['onOpenFileRequest']
>[0] extends (event: infer Event) => void
  ? Event
  : never;

export function PreprocessingFilePicker() {
  const { plugin } = useDocumentManagerPlugin();
  const { provides } = useDocumentManagerCapability();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<FileRequest | null>(null);

  useEffect(() => {
    if (!plugin?.onOpenFileRequest) return;
    return plugin.onOpenFileRequest(request => {
      requestRef.current = request;
      inputRef.current?.click();
    });
  }, [plugin]);

  useEffect(() => {
    if (!provides) return;
    return provides.onDocumentClosed(discardPaperAnalysis);
  }, [provides]);

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file || !provides) return;
    const buffer = await file.arrayBuffer();
    const request = requestRef.current;
    const documentId = request?.options?.documentId ?? crypto.randomUUID();

    // Rendering and backend analysis deliberately start together. The PDF is
    // immediately usable through WASM; references appear when preprocessing
    // completes and never block first paint or interaction.
    void preprocessPaper(documentId, buffer.slice(0)).catch(() => undefined);
    const openTask = provides.openDocumentBuffer({
      name: file.name,
      buffer,
      documentId,
      scale: request?.options?.scale,
      rotation: request?.options?.rotation,
      autoActivate: request?.options?.autoActivate,
    });
    openTask.wait(
      result => request?.task.resolve(result),
      error => request?.task.fail(error),
    );
    event.currentTarget.value = '';
  };

  return (
    <input
      ref={inputRef}
      type="file"
      accept="application/pdf"
      style={{ display: 'none' }}
      onChange={event => void onChange(event)}
    />
  );
}
