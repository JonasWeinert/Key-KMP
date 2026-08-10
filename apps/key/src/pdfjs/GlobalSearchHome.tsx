import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { NativeCompanionSnapshot } from '../engines/types';

interface SearchHit {
  id: string;
  documentId: string;
  documentHash: string;
  page: number;
  text: string;
  targetText: string;
  score: number;
}

interface Props { onOpenFile: () => void; }

function isTauri() { return '__TAURI_INTERNALS__' in window; }

export default function GlobalSearchHome({ onOpenFile }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [files, setFiles] = useState<NativeCompanionSnapshot[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const snapshots = await invoke<NativeCompanionSnapshot[]>('pdfjs_companion_list');
        if (!cancelled) setFiles(snapshots);
      } catch { /* Browser preview has no native companion store. */ }
      if (!cancelled) window.setTimeout(poll, 700);
    };
    void poll();
    return () => { cancelled = true; };
  }, []);

  const search = async () => {
    const trimmed = query.trim();
    if (!trimmed || !isTauri()) return;
    setSearching(true);
    try { setHits(await invoke<SearchHit[]>('global_search', { query: trimmed, limit: 30 })); }
    finally { setSearching(false); }
  };

  return (
    <section className="global-search-home" aria-label="Global PDF search">
      <div className="global-search-hero">
        <span className="global-search-eyebrow">Your research library</span>
        <h1>Search across your PDFs</h1>
        <p>Open a PDF to make it searchable. Existing files are identified by content hash and reused.</p>
        <form className="global-search-form" onSubmit={event => { event.preventDefault(); void search(); }}>
          <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your documents…" aria-label="Search your documents" />
          <button type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        <button type="button" className="global-search-open" onClick={onOpenFile}>Open a PDF instead</button>
      </div>
      {files.length > 0 && (
        <div className="global-search-progress">
          <div className="global-search-section-title">Searchability</div>
          {files.map(file => {
            const total = file.semanticTotal;
            const percent = total > 0 ? Math.round((file.semanticCompleted / total) * 100) : 0;
            const title = file.document.title || file.document.id || 'Untitled PDF';
            return <div className="global-search-file" key={`${file.document.id}:${file.generation}`}>
              <div className="global-search-file-head"><strong>{title}</strong><span>{file.semanticStatus}</span></div>
              <div className="global-search-bar"><i style={{ width: `${percent}%` }} /></div>
              <small>{file.semanticStatus === 'ready' || file.semanticStatus === 'indexed' ? 'Ready for global search' : total > 0 ? `${file.semanticCompleted} / ${total} chunks indexed` : 'Preparing semantic extraction…'}</small>
            </div>;
          })}
        </div>
      )}
      {hits.length > 0 && <div className="global-search-results">
        <div className="global-search-section-title">Results</div>
        {hits.map(hit => <article className="global-search-result" key={hit.id}>
          <div><strong>{hit.documentId}</strong><span>Page {hit.page + 1}</span></div>
          <p>{hit.targetText || hit.text}</p><small>score {hit.score.toFixed(3)}</small>
        </article>)}
      </div>}
    </section>
  );
}
