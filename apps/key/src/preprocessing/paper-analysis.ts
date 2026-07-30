import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaperPreprocessingResult } from '../engines/types';

export type PaperAnalysisState =
  | { status: 'idle' }
  | { status: 'processing'; startedAt: number; byteLength: number }
  | {
      status: 'ready';
      result: PaperPreprocessingResult;
      roundTripMs: number;
      byteLength: number;
    }
  | { status: 'error'; message: string; roundTripMs: number; byteLength: number };

const states = new Map<string, PaperAnalysisState>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function paperAnalysisState(documentId: string): PaperAnalysisState {
  return states.get(documentId) ?? { status: 'idle' };
}

export function usePaperAnalysis(documentId: string) {
  return useSyncExternalStore(
    callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => paperAnalysisState(documentId),
  );
}

export async function preprocessPaper(
  documentId: string,
  source: ArrayBuffer,
): Promise<PaperPreprocessingResult> {
  const startedAt = performance.now();
  states.set(documentId, {
    status: 'processing',
    startedAt,
    byteLength: source.byteLength,
  });
  emit();
  try {
    // Tauri serializes Uint8Array efficiently as the command's byte vector.
    // Copy here so EmbedPDF and the backend can consume the same source
    // concurrently without either side transferring/detaching the original.
    const result = await invoke<PaperPreprocessingResult>('preprocess_paper', {
      id: documentId,
      bytes: Array.from(new Uint8Array(source)),
    });
    states.set(documentId, {
      status: 'ready',
      result,
      roundTripMs: performance.now() - startedAt,
      byteLength: source.byteLength,
    });
    emit();
    return result;
  } catch (error) {
    states.set(documentId, {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      roundTripMs: performance.now() - startedAt,
      byteLength: source.byteLength,
    });
    emit();
    throw error;
  }
}

export function discardPaperAnalysis(documentId: string) {
  states.delete(documentId);
  emit();
}
