import { describe, expect, it } from 'vitest';
import type { PaperPreprocessingResult } from '../engines/types';
import { preprocessedScholarlyEntries } from './scholarly-metadata';

function analysis(): PaperPreprocessingResult {
  return {
    document: {
      id: 'paper',
      pages: [],
      toc: [],
      links: [],
    },
    isScientific: true,
    syntheticLinks: [],
    citations: [],
    references: [
      {
        number: 1,
        page: 4,
        text: 'An enriched paper',
        textRuns: [],
        metadata: {
          source: 'OpenAlex',
          title: 'Resolved paper title',
          authors: ['Ada Author'],
          year: 2024,
          doi: '10.1234/resolved',
        },
      },
      {
        number: 2,
        page: 4,
        text: 'A non-scholarly web resource',
        textRuns: [],
        metadataError: 'provider returned HTTP 404',
      },
    ],
    signals: {
      referenceEntries: 2,
      doiEntries: 1,
      bracketCitations: 1,
      superscriptCitations: 0,
      concentratedInternalLinks: 0,
    },
    processingMs: 12,
  };
}

describe('preprocessed scholarly metadata', () => {
  it('hydrates resolved references without any panel-time lookup state', () => {
    const entries = preprocessedScholarlyEntries(analysis());

    expect(entries.get(1)).toEqual({
      state: 'ready',
      metadata: expect.objectContaining({
        title: 'Resolved paper title',
        doi: '10.1234/resolved',
      }),
    });
    expect(entries.get(2)).toEqual({
      state: 'failed',
      error: 'provider returned HTTP 404',
    });
    expect([...entries.values()].map(entry => entry.state)).toEqual([
      'ready',
      'failed',
    ]);
  });
});
