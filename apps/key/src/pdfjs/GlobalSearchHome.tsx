import LibraryMetadataDetails from './LibraryMetadataDetails';
import { useEffect, useMemo, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from '../ui/Icon';

export interface SearchHit {
  id: string;
  documentId: string;
  documentHash: string;
  documentTitle?: string;
  page: number;
  text: string;
  targetText: string;
  score: number;
}

interface LibraryDocument {
  documentId: string;
  documentHash: string;
  title: string;
  pageCount: number;
  status: 'no_text' | 'queued' | 'processing' | 'indexing' | 'indexed' | 'failed' | 'paused' | 'needs_source';
  keywordReady: boolean;
  year?: number;
  authors: string[];
  completed: number;
  total: number;
  error?: string;
  updatedAtMs: number;
}

interface Props {
  openDocumentIds: ReadonlySet<string>;
  onActivateDocument: (documentId: string) => void;
  onOpenFile: () => void;
  onActivateResult: (hit: SearchHit) => void;
  onResults: (hits: SearchHit[]) => void;
}

function isTauri() {
  return '__TAURI_INTERNALS__' in window;
}

function progressOf(document: LibraryDocument) {
  if (['indexed', 'no_text'].includes(document.status)) return 100;
  if (document.total <= 0) return 0;
  return Math.min(99, Math.round((document.completed / document.total) * 100));
}

function statusCopy(document: LibraryDocument) {
  if (document.status === 'no_text') return 'No extractable text · PDF and metadata remain available';
  if (document.status === 'indexed') return `${document.total.toLocaleString()} searchable passages`;
  if (document.status === 'needs_source') return 'Open the original PDF to restore search and annotations';
  if (document.status === 'paused') return 'Paused · resume when you’re ready';
  if (document.status === 'queued') return 'Waiting to process';
  if (document.status === 'failed') return document.error || 'Indexing failed';
  if (document.status === 'indexing' && document.total > 0) {
    return `${document.completed.toLocaleString()} of ${document.total.toLocaleString()} passages embedded${document.keywordReady ? ' · keyword search ready' : ''}`;
  }
  return 'Extracting text and reading order…';
}

export default function GlobalSearchHome({
  openDocumentIds,
  onActivateDocument,
  onOpenFile,
  onActivateResult,
  onResults,
}: Props) {
  const [removedHash, setRemovedHash] = useState<string>();
  const [purgingHash, setPurgingHash] = useState<string>();
  const [removedDocuments, setRemovedDocuments] = useState<LibraryDocument[]>([]);
  const loadRemoved = async () => { try { setRemovedDocuments(await invoke('library_removed_documents')); } catch (e) { setSearchError(String(e)); } };
  const purgeDocument = async (document: LibraryDocument) => {
    if (purgingHash) return;
    if (openDocumentIds.has(document.documentHash)) { setSearchError("Close this PDF in every tab before permanently deleting it."); return; }
    if (!window.confirm(`Permanently delete “${document.title}”, its saved PDF, annotations and metadata? This cannot be undone.`)) return;
    setPurgingHash(document.documentHash);
    try { await invoke('library_purge', { hash: document.documentHash }); await loadRemoved(); setRemovedHash(undefined); }
    catch (error) { setSearchError(String(error)); }
    finally { setPurgingHash(undefined); }
  };
  const removeDocument = async (hash: string, removed: boolean) => {
    try { await invoke('library_set_removed', { hash, removed }); setRemovedHash(removed ? hash : undefined); await loadRemoved(); setDocuments(await invoke('semantic_library')); setHits([]); onResults([]); } catch (error) { setSearchError(String(error)); }
  };
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [author, setAuthor] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [annotationFilter, setAnnotationFilter] = useState('any');
  const [metadataText, setMetadataText] = useState('');
  const [tag, setTag] = useState('');
  const [collection, setCollection] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [propertyValue, setPropertyValue] = useState('');
  const [propertyType, setPropertyType] = useState('text');
  const requestSequence = useRef(0);
  const control = async (hash: string, action: string) => {
    try { await invoke('library_processing_control', { hash, action }); setDocuments(await invoke('semantic_library')); }
    catch (error) { setSearchError(String(error)); }
  };
  const saveMetadata = async (event: React.FormEvent<HTMLFormElement>, document: LibraryDocument) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await invoke('library_update_metadata', { hash: document.documentHash, title: String(data.get('title')), year: data.get('year') ? Number(data.get('year')) : null, authors: String(data.get('authors')).split(';').map(a => a.trim()).filter(Boolean) });
      setDocuments(await invoke('semantic_library'));
    } catch (error) { setSearchError(String(error)); }
  };

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const library = await invoke<LibraryDocument[]>('semantic_library');
        if (!cancelled) setDocuments(library);
      } catch (error) { if (!cancelled) setSearchError(`Could not read the library: ${error}`); }
      if (!cancelled) timer = window.setTimeout(poll, 700);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const indexedCount = useMemo(
    () => documents.filter(document => document.status === 'indexed').length,
    [documents],
  );
  const indexingCount = useMemo(
    () => documents.filter(document => ['queued', 'processing', 'indexing'].includes(document.status)).length,
    [documents],
  );
  const titles = useMemo(
    () => new Map(documents.map(document => [document.documentHash, document.title])),
    [documents],
  );

  const search = async (cursor: string | null = null) => {
    const trimmed = query.trim();
    if (!trimmed || !isTauri()) return;
    if (!cursor && propertyName.trim()) {
      if (propertyType === 'number' && (!propertyValue.trim() || !Number.isFinite(Number(propertyValue)))) { setSearchError('Enter a finite number for the property filter'); return; }
      if (propertyType === 'boolean' && !['true', 'false'].includes(propertyValue)) { setSearchError('Enter true or false for the property filter'); return; }
    }
    const sequence = ++requestSequence.current;
    setSearching(true);
    setSearchError('');
    setSearchedQuery(trimmed);
    try {
      const page = await invoke<{ hits: SearchHit[]; nextCursor: string | null; capped: boolean }>('global_search_page', { query: trimmed, cursor, filter: { author: author.trim() || null, yearFrom: yearFrom ? Number(yearFrom) : null, yearTo: yearTo ? Number(yearTo) : null, hasAnnotations: annotationFilter === 'any' ? null : annotationFilter === 'yes', tag: tag.trim() || null, collection: collection.trim() || null, properties: propertyName.trim() ? { [propertyName.trim()]: propertyType === 'number' ? Number(propertyValue) : propertyType === 'boolean' ? propertyValue === 'true' : propertyValue } : {}, metadataText: metadataText.trim() || null } });
      if (sequence !== requestSequence.current) return;
      const results = cursor ? [...hits, ...page.hits] : page.hits;
      setNextCursor(page.nextCursor); setCapped(page.capped); setHits(results); onResults(results);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setHits([]); onResults([]);
      setSearchError(String(error));
    } finally {
      if (sequence === requestSequence.current) setSearching(false);
    }
  };

  return (
    <section className="global-search-home" aria-label="PDF library and global search">
      <div className="global-search-layout">
        <header className="global-search-hero">
          <div className="global-search-heading">
            <span className="global-search-eyebrow">Library</span>
            <h1>Find anything in your PDFs</h1>
            <p>
              Search every indexed document, or add another PDF while the library keeps working.
            </p>
          </div>
          <button type="button" className="global-search-open" onClick={onOpenFile}>
            <Icon name="add" />
            <span>Open PDF</span>
          </button>
        </header>

        <form
          className="global-search-form"
          onSubmit={event => {
            event.preventDefault();
            void search();
          }}
        >
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={indexedCount ? `Search ${indexedCount} indexed ${indexedCount === 1 ? 'document' : 'documents'}…` : 'Search your documents…'}
            aria-label="Search your documents"
          />
          <button type="submit" disabled={searching || !query.trim()}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        <div className="global-search-filters" aria-label="Search filters">
          <label>Tag<input aria-label="Tag filter" value={tag} onChange={e => setTag(e.target.value)} /></label>
          <label>Collection<input aria-label="Collection filter" value={collection} onChange={e => setCollection(e.target.value)} /></label>
          <label>Property<input aria-label="Property filter" placeholder="Name" value={propertyName} onChange={e => setPropertyName(e.target.value)} /></label>
          <label>Type<select aria-label="Property filter type" value={propertyType} onChange={e => setPropertyType(e.target.value)}><option value="text">Text</option><option value="number">Number</option><option value="boolean">True / false</option></select></label>
          <label>Value<input aria-label="Property filter value" value={propertyValue} onChange={e => setPropertyValue(e.target.value)} /></label>
          <label>Author<input aria-label="Author filter" value={author} onChange={e => setAuthor(e.target.value)} placeholder="Exact author name" /></label>
          <label>Year from<input aria-label="Year from" type="number" value={yearFrom} onChange={e => setYearFrom(e.target.value)} /></label>
          <label>Year to<input aria-label="Year to" type="number" value={yearTo} onChange={e => setYearTo(e.target.value)} /></label>
          <label>Annotations<select aria-label="Annotations filter" value={annotationFilter} onChange={e => setAnnotationFilter(e.target.value)}><option value="any">Any document</option><option value="yes">With annotations</option><option value="no">Without annotations</option></select></label>
          <label>Metadata or comments<input aria-label="Metadata or comments filter" value={metadataText} onChange={e => setMetadataText(e.target.value)} placeholder="Contains phrase" /></label>
        </div>
        {searchError && !searchedQuery && <div className="global-search-message error" role="alert">{searchError}</div>}
        {searchedQuery && (
          <section className="global-search-results" aria-live="polite">
            <div className="global-search-section-head">
              <div>
                <span className="global-search-section-title">Results</span>
                <strong>{searching ? 'Searching your library…' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for “${searchedQuery}”`}</strong>
              </div>
            </div>
            {searchError && <div className="global-search-message error">{searchError}</div>}
            {!searching && !searchError && hits.length === 0 && (
              <div className="global-search-message">No indexed passage matched this search.</div>
            )}
            {capped && <small>Showing the best 1,000 candidate passages. Add filters to narrow the search.</small>}
            <div className="global-search-result-list">
              {hits.map(hit => {
                return (
                  <button
                    type="button"
                    className="global-search-result"
                    key={hit.id}
                    title="Open and highlight this passage"
                    onClick={() => onActivateResult({ ...hit, documentTitle: titles.get(hit.documentHash) })}
                  >
                    <div>
                      <strong>{titles.get(hit.documentHash) || hit.documentId}</strong>
                      <span>Page {hit.page + 1}</span>
                    </div>
                    <p>{hit.targetText || hit.text}</p>
                  </button>
                );
              })}
            </div>
            {nextCursor && <button disabled={searching} className="library-action" onClick={() => void search(nextCursor)}>Load more results</button>}
          </section>
        )}

        <details className="library-metadata" onToggle={e => { if (e.currentTarget.open) void loadRemoved(); }}><summary>Removed documents</summary>{removedDocuments.map(document => <p key={document.documentHash}>{document.title} <button onClick={() => void removeDocument(document.documentHash, false)}>Restore</button> <button disabled={Boolean(purgingHash)} onClick={() => void purgeDocument(document)}>{purgingHash === document.documentHash ? 'Deleting…' : 'Delete permanently'}</button></p>)}</details>
        {removedHash && <p role="status">Document removed from the library. <button onClick={() => void removeDocument(removedHash, false)}>Undo</button></p>}
        <section className="global-search-library" aria-label="Document searchability">
          <div className="global-search-section-head">
            <div>
              <span className="global-search-section-title">Documents</span>
              <strong>{documents.length ? `${documents.length} in your library` : 'Your library is empty'}</strong>
            </div>
            {documents.length > 0 && (
              <div className="global-search-summary">
                <span>{indexedCount} indexed</span>
                {indexingCount > 0 && <span className="active">{indexingCount} processing</span>}
              </div>
            )}
          </div>

          {documents.length === 0 ? (
            <button type="button" className="global-search-empty" onClick={onOpenFile}>
              <span className="global-search-empty-icon"><Icon name="document" /></span>
              <strong>Open your first PDF</strong>
              <small>It will appear here while extraction and indexing run in the background.</small>
            </button>
          ) : (
            <div className="global-search-document-list">
              {documents.map(document => {
                const percent = progressOf(document);
                const isOpen = openDocumentIds.has(document.documentId);
                return (
                  <article className="global-search-document" key={document.documentHash}>
                    <span className="global-search-document-icon"><Icon name="document" /></span>
                    <div className="global-search-document-main">
                      <div className="global-search-document-head">
                        <strong title={document.title}>{document.title}</strong>
                        <span>{document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'}</span>
                      </div>
                      <div
                        className={`global-search-bar ${document.status}`}
                        role="progressbar"
                        aria-label={`${document.title} indexing progress`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={document.total > 0 || document.status === 'indexed' ? percent : undefined}
                        aria-valuetext={statusCopy(document)}
                      >
                        <i style={{ width: `${percent}%` }} />
                      </div>
                      <small>{statusCopy(document)}</small>
                      <LibraryMetadataDetails hash={document.documentHash} />
                      <details className="library-metadata"><summary>Edit metadata</summary>
                        <form onSubmit={event => void saveMetadata(event, document)}>
                          <input name="title" aria-label={`Title for ${document.title}`} defaultValue={document.title} required />
                          <input name="authors" aria-label={`Authors for ${document.title}`} defaultValue={document.authors?.join('; ')} placeholder="Authors; separated by ;" />
                          <input name="year" aria-label={`Year for ${document.title}`} type="number" defaultValue={document.year ?? ''} placeholder="Year" />
                          <button className="library-action" type="submit">Save metadata</button>
                        </form>
                      </details>
                    </div>
                    <div className="global-search-document-state">
                      <span className={`global-search-status ${document.status}`}>{document.status}</span>
                      {document.status === 'needs_source' && <button className="library-action" onClick={onOpenFile}>Relink PDF</button>}
                      {document.status !== 'indexed' && document.status !== 'needs_source' && <button className="library-action" onClick={() => void control(document.documentHash, document.status === 'paused' ? 'resume' : document.status === 'failed' ? 'retry' : 'pause')}>{document.status === 'paused' ? 'Resume' : document.status === 'failed' ? 'Retry' : 'Pause'}</button>}
                      <button className="library-action" onClick={() => void removeDocument(document.documentHash, true)}>Remove from library</button>
                      <span className={`global-search-presence ${isOpen ? 'open' : ''}`}>{isOpen ? 'Open' : 'Closed'}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
