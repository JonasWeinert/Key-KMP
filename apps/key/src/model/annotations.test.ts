import { beforeEach, describe, expect, it } from 'vitest';
import { loadAnnotations, saveAnnotations, type ReaderAnnotation } from './annotations';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('annotation persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('round-trips app-owned comments and highlight geometry', () => {
    const annotation: ReaderAnnotation = {
      id: 'annotation-1',
      documentId: 'document-1',
      page: 2,
      rects: [
        {
          origin: { x: 12, y: 34 },
          size: { width: 56, height: 18 },
        },
      ],
      text: 'Linked reference',
      comment: 'Follow this citation',
      color: 'purple',
      createdAt: '2026-07-26T12:00:00.000Z',
    };

    saveAnnotations([annotation]);

    expect(loadAnnotations()).toEqual([annotation]);
  });

  it('recovers from malformed persisted JSON', () => {
    localStorage.setItem('key.annotations.v1', '{');

    expect(loadAnnotations()).toEqual([]);
  });
});
