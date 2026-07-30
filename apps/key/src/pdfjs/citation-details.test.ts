import { describe, expect, it } from 'vitest';
import type { ScholarlyMetadata } from '../engines/types';
import {
  citationAuthorsSnippet,
  citationBibliographyLine,
  citationLinks,
  citationSummary,
  citationTabLabel,
  isScholarlyResourceUrl,
} from './citation-details';

const metadata: ScholarlyMetadata = {
  source: 'OpenAlex',
  title: 'A resolved academic work',
  authors: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing'],
  year: 2026,
  journal: 'Journal of Careful Interfaces',
  journalShort: 'J. Careful Interfaces',
  doi: '10.1000/example',
  openAccess: true,
  fullTextUrl: 'https://papers.example/full.pdf',
  landingUrl: 'https://openalex.org/W123',
  tldrText: 'A concise provider summary.',
  abstractText: 'A longer abstract.',
};

describe('citation detail presentation', () => {
  it('keeps compact authorship and tabs readable for combined citations', () => {
    expect(citationAuthorsSnippet(metadata.authors)).toBe(
      'Ada Lovelace, Grace Hopper et al.',
    );
    expect(citationBibliographyLine(metadata)).toBe(
      'Ada Lovelace, Grace Hopper et al. · 2026 · J. Careful Interfaces',
    );
    expect(citationTabLabel(17, metadata)).toBe('[17] Lovelace 2026');
  });

  it('prefers a TLDR for the compact preview and retains the abstract separately', () => {
    expect(citationSummary(metadata)).toEqual({
      label: 'TLDR',
      text: 'A concise provider summary.',
    });
    expect(citationSummary({ ...metadata, tldrText: undefined })).toEqual({
      label: 'Abstract',
      text: 'A longer abstract.',
    });
  });

  it('orders reading links first and removes duplicate destinations', () => {
    expect(
      citationLinks({
        ...metadata,
        landingUrl: metadata.fullTextUrl,
      }),
    ).toEqual([
      {
        label: 'Read full text',
        url: 'https://papers.example/full.pdf',
        emphasis: 'primary',
      },
      {
        label: 'Open DOI',
        url: 'https://doi.org/10.1000/example',
        emphasis: 'secondary',
      },
    ]);
  });

  it('recognizes DOI and Crossref document links without intercepting ordinary URLs', () => {
    expect(isScholarlyResourceUrl('https://doi.org/10.1000/example')).toBe(true);
    expect(
      isScholarlyResourceUrl(
        'https://api.crossref.org/works/10.1000%2Fexample',
      ),
    ).toBe(true);
    expect(
      isScholarlyResourceUrl(
        'https://publisher.example/article/10.1000/example',
      ),
    ).toBe(true);
    expect(isScholarlyResourceUrl('https://example.com/about')).toBe(false);
  });
});
