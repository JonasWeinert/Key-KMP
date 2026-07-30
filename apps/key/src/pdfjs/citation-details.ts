import type { ScholarlyMetadata } from '../engines/types';

export interface CitationLink {
  label: string;
  url: string;
  emphasis: 'primary' | 'secondary';
}

export function isScholarlyResourceUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    return (
      host === 'doi.org' ||
      host.endsWith('.doi.org') ||
      host === 'crossref.org' ||
      host.endsWith('.crossref.org') ||
      /10\.\d{4,9}\/\S+/i.test(decodeURIComponent(url.href))
    );
  } catch {
    return false;
  }
}

export function citationAuthorsSnippet(
  authors: string[],
  visibleAuthors = 2,
) {
  if (authors.length === 0) return '';
  if (authors.length <= visibleAuthors) return authors.join(', ');
  return `${authors.slice(0, visibleAuthors).join(', ')} et al.`;
}

export function citationBibliographyLine(metadata?: ScholarlyMetadata) {
  if (!metadata) return 'Bibliographic details unavailable';
  return [
    citationAuthorsSnippet(metadata.authors),
    metadata.year,
    metadata.journalShort ?? metadata.journal,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function citationTabLabel(
  number: number,
  metadata?: ScholarlyMetadata,
) {
  const author = metadata?.authors[0]?.trim();
  const surname = author?.split(/\s+/).at(-1);
  const identity = [surname, metadata?.year].filter(Boolean).join(' ');
  return identity ? `[${number}] ${identity}` : `Reference [${number}]`;
}

export function citationSummary(metadata?: ScholarlyMetadata) {
  if (metadata?.tldrText?.trim()) {
    return { label: 'TLDR', text: metadata.tldrText.trim() };
  }
  if (metadata?.abstractText?.trim()) {
    return { label: 'Abstract', text: metadata.abstractText.trim() };
  }
  return null;
}

export function citationLinks(metadata?: ScholarlyMetadata): CitationLink[] {
  if (!metadata) return [];
  const candidates: Array<CitationLink | null> = [
    metadata.fullTextUrl
      ? {
          label: metadata.openAccess ? 'Read full text' : 'View full text',
          url: metadata.fullTextUrl,
          emphasis: 'primary',
        }
      : null,
    metadata.doi
      ? {
          label: 'Open DOI',
          url: `https://doi.org/${metadata.doi}`,
          emphasis: 'secondary',
        }
      : null,
    metadata.landingUrl
      ? {
          label: `View on ${metadata.source}`,
          url: metadata.landingUrl,
          emphasis: 'secondary',
        }
      : null,
    metadata.journalUrl
      ? {
          label: 'Journal page',
          url: metadata.journalUrl,
          emphasis: 'secondary',
        }
      : null,
  ];
  const seen = new Set<string>();
  return candidates.filter((link): link is CitationLink => {
    if (!link || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}
