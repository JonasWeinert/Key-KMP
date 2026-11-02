import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
interface Details { tags: string[]; collections: string[]; properties: Record<string, string | number | boolean | null> }
export default function LibraryMetadataDetails({ hash }: { hash: string }) {
  const [data, setData] = useState<Details>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = async () => { try { setData(await invoke('library_metadata_details', { hash })); } catch (e) { setError(String(e)); } };
  return <details className="library-metadata" onToggle={e => { if (e.currentTarget.open && !data) void load(); }}>
    <summary>Tags, collections and properties</summary>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <form onSubmit={async e => {
        e.preventDefault(); const form = new FormData(e.currentTarget); setError(''); setMessage('');
        const labels = (name: string) => String(form.get(name)).split(';').map(s => s.trim()).filter(Boolean);
        try { await invoke('library_set_labels', { hash, tags: labels('tags'), collections: labels('collections') }); await load(); setMessage('Labels saved'); } catch (e) { setError(String(e)); }
      }}>
        <input name="tags" aria-label="Document tags" defaultValue={data.tags.join('; ')} placeholder="Tags; separated by ;" />
        <input name="collections" aria-label="Document collections" defaultValue={data.collections.join('; ')} placeholder="Collections; separated by ;" />
        <button type="submit" className="library-action">Save labels</button>
      </form>
      {Object.entries(data.properties).map(([name, value]) => <p key={name}>{name}: {String(value)}</p>)}
      <form onSubmit={async e => {
        e.preventDefault(); const form = new FormData(e.currentTarget); setError(''); setMessage('');
        const type = form.get('type'); const raw = String(form.get('value'));
        const value = type === 'number' ? Number(raw) : type === 'boolean' ? raw.toLowerCase() === 'true' : raw;
        if (type === 'number' && (!raw.trim() || !Number.isFinite(value))) { setError('Enter a finite number'); return; }
        if (type === 'boolean' && !['true', 'false'].includes(raw.toLowerCase())) { setError('Enter true or false'); return; }
        try { await invoke('library_set_property', { hash, name: String(form.get('name')).trim(), value }); await load(); setMessage('Property saved'); } catch (e) { setError(String(e)); }
      }}>
        <input name="name" aria-label="Property name" required placeholder="Property name" />
        <select name="type" aria-label="Property type"><option value="text">Text</option><option value="number">Number</option><option value="boolean">True / false</option></select>
        <input name="value" aria-label="Property value" required placeholder="Value" />
        <button type="submit" className="library-action">Save property</button>
      </form>
      <small role="status">{message}</small>
    </>}
  </details>;
}
