import type {
  PaperPreprocessingResult,
  ScholarlyMetadata,
} from '../engines/types';

export type ScholarlyEntry =
  | { state: 'loading' }
  | { state: 'ready'; metadata: ScholarlyMetadata }
  | { state: 'failed'; error: string };

export function preprocessedScholarlyEntries(
  analysis?: PaperPreprocessingResult,
) {
  const entries = new Map<number, ScholarlyEntry>();
  for (const reference of analysis?.references ?? []) {
    entries.set(
      reference.number,
      reference.metadata
        ? { state: 'ready', metadata: reference.metadata }
        : reference.metadataError
          ? {
            state: 'failed',
              error: reference.metadataError,
            }
          : { state: 'loading' },
    );
  }
  return entries;
}
