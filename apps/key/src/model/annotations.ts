import type { Rect } from '@embedpdf/models';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export interface ReaderAnnotation {
  id: string;
  documentId: string;
  page: number;
  rects: Rect[];
  text: string;
  comment: string;
  color: HighlightColor;
  createdAt: string;
}

const STORAGE_KEY = 'key.annotations.v1';
const LEGACY_STORAGE_KEY = 'gpuipdf.tauri-experiment.annotations.v1';

export function loadAnnotations(): ReaderAnnotation[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY) ??
        '[]',
    );
    return Array.isArray(parsed) ? (parsed as ReaderAnnotation[]) : [];
  } catch {
    return [];
  }
}

export function saveAnnotations(annotations: ReaderAnnotation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
}
