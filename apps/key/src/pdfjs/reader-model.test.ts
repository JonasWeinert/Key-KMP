import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeTextPage } from '../engines/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  closeNativeCompanion,
  DEFAULT_HIGHLIGHT_COLOR,
  harmonizeBounds,
  loadReaderAnnotations,
  openNativeCompanion,
  searchReaderDocument,
  upsertAnnotationComment,
} from './reader-model';

function textPage(text: string): NativeTextPage {
  return {
    page: 0,
    text,
    characters: Array.from(text, value => ({ value })),
  };
}

describe('PDF.js reader search source selection', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  });

  it('falls back to PDF.js text when disposable preprocessing omits text', async () => {
    invoke
      .mockResolvedValueOnce({
        generation: 1,
        revision: 1,
        stage: 'analyzing',
        document: { pages: [], toc: [], links: [] },
        hasNativeText: false,
        completedReferences: 0,
        totalReferences: 0,
      })
      .mockRejectedValueOnce(new Error('native text unavailable'))
      .mockResolvedValue(undefined);
    const file = new File(['pdf'], 'paper.pdf', {
      type: 'application/pdf',
      lastModified: 1,
    });
    const companion = await openNativeCompanion(
      file,
      new Uint8Array([1, 2, 3]),
      false,
    );
    const pages = new Map([[0, textPage('Alpha beta alpha')]]);

    const matches = await searchReaderDocument(companion.id, 'alpha', pages);

    expect(matches).toHaveLength(2);
    expect(matches.map(match => match.start)).toEqual([0, 11]);
    await closeNativeCompanion(companion.id);
  });

  it('keeps PDFium text in the backend and searches it without loading every page', async () => {
    invoke
      .mockResolvedValueOnce({
        generation: 1,
        revision: 1,
        stage: 'analyzing',
        document: { pages: [], toc: [], links: [] },
        hasNativeText: false,
        completedReferences: 0,
        totalReferences: 0,
      })
      .mockResolvedValueOnce([
        {
          page: 2,
          start: 4,
          end: 8,
          preview: 'PDFium alpha result',
          bounds: [{ left: 0.1, top: 0.2, right: 0.2, bottom: 0.22 }],
        },
      ])
      .mockResolvedValue(undefined);
    const file = new File(['pdf'], 'native-paper.pdf', {
      type: 'application/pdf',
      lastModified: 2,
    });
    const companion = await openNativeCompanion(
      file,
      new Uint8Array([4, 5, 6]),
      false,
    );

    const matches = await searchReaderDocument(companion.id, 'alpha', new Map());

    expect(matches).toMatchObject([{ id: '2:4:8', page: 2, start: 4, end: 8 }]);
    expect(invoke).toHaveBeenNthCalledWith(2, 'native_search', {
      id: companion.id,
      query: 'alpha',
    });
    await closeNativeCompanion(companion.id);
    expect(invoke).toHaveBeenCalledWith('release_disposable_document', {
      id: companion.id,
    });
    expect(invoke).toHaveBeenCalledWith('native_close', { id: companion.id });
  });
});

describe('text overlay geometry', () => {
  it('bridges small whitespace gaps and harmonizes line height', () => {
    const bounds = harmonizeBounds([
      { left: 0.1, right: 0.14, top: 0.2, bottom: 0.22 },
      { left: 0.145, right: 0.18, top: 0.201, bottom: 0.221 },
      { left: 0.188, right: 0.23, top: 0.198, bottom: 0.219 },
    ]);

    expect(bounds).toHaveLength(1);
    expect(bounds[0]!.left).toBe(0.1);
    expect(bounds[0]!.right).toBe(0.23);
    expect(bounds[0]!.bottom - bounds[0]!.top).toBeGreaterThan(0.02);
  });

  it('keeps separate lines separate', () => {
    expect(
      harmonizeBounds([
        { left: 0.1, right: 0.2, top: 0.2, bottom: 0.22 },
        { left: 0.1, right: 0.2, top: 0.25, bottom: 0.27 },
      ]),
    ).toHaveLength(2);
  });
});

describe('annotation comments', () => {
  const range = {
    start: { page: 1, index: 10 },
    end: { page: 1, index: 20 },
  };

  it('adds a note to an existing highlight without replacing its identity or color', () => {
    const existing = {
      id: 'highlight-1',
      documentId: 'document-1',
      range,
      text: 'highlighted passage',
      color: 'blue' as const,
      createdAt: 'earlier',
      updatedAt: 'earlier',
    };

    expect(
      upsertAnnotationComment([existing], {
        annotationId: existing.id,
        documentId: existing.documentId,
        range,
        text: existing.text,
        comment: 'New note',
        timestamp: 'now',
      }),
    ).toEqual([
      {
        ...existing,
        comment: 'New note',
        updatedAt: 'now',
      },
    ]);
  });

  it('edits the note on an existing annotation in place', () => {
    const existing = {
      id: 'note-1',
      documentId: 'document-1',
      range,
      text: 'highlighted passage',
      color: 'green' as const,
      comment: 'Old note',
      createdAt: 'earlier',
      updatedAt: 'earlier',
    };

    const [updated] = upsertAnnotationComment([existing], {
      annotationId: existing.id,
      documentId: existing.documentId,
      range,
      text: existing.text,
      comment: 'Edited note',
      timestamp: 'now',
    });

    expect(updated).toMatchObject({
      id: existing.id,
      comment: 'Edited note',
      createdAt: 'earlier',
      updatedAt: 'now',
    });
  });

  it('defaults a directly-created note to orange', () => {
    const [created] = upsertAnnotationComment([], {
      documentId: 'document-1',
      range,
      text: 'highlighted passage',
      comment: 'New note',
      timestamp: 'now',
    });

    expect(created.color).toBe(DEFAULT_HIGHLIGHT_COLOR);
  });

  it('migrates old yellow and colorless notes to orange', () => {
    const localStorage = {
      getItem: vi.fn().mockReturnValue(
        JSON.stringify([
          {
            id: 'yellow',
            documentId: 'document-1',
            range,
            text: 'old highlight',
            color: 'yellow',
          },
          {
            id: 'colorless',
            documentId: 'document-1',
            range,
            text: 'old note',
            comment: 'note',
          },
        ]),
      ),
    };
    vi.stubGlobal('localStorage', localStorage);

    expect(loadReaderAnnotations('document-1').map(annotation => annotation.color))
      .toEqual(['orange', 'orange']);
  });
});
