// A note in its own tab, as a page: an optional cover and icon, a large title, its
// properties (Author, then any field or property the user adds) and the block editor,
// saved as Markdown as you type. Works for standalone notes and for notes on a source.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import "./entity.css";
import { ItemPage, ItemProperties, type AppearancePatch } from "./ItemPage";
import { shortCreators, type Invoke, type Note, type Source } from "./library-api";
import type { Creator } from "./citation";
import NoteEditor from "./note-editor";
import { noteSources } from "./note-sources";
import LinkedFrom from "./LinkedFrom";
import { readAppearance } from "./page-appearance";
import { PropertySheet, usePropertyDefinitions, type PropertySheetState } from "./PropertySheets";

/** Lets the sidebar list refresh when a note is created, renamed or deleted. */
export const notesChanged = () => window.dispatchEvent(new Event("key:notes-changed"));
/** A note's text was saved; canvases showing it re-read it. */
export const noteSaved = (id: string) => window.dispatchEvent(new CustomEvent("key:note-saved", { detail: id }));

type MetaPatch = { fields?: Record<string, unknown>; properties?: Record<string, unknown>; appearance?: AppearancePatch };

export default function NotePage({ invoke, workspaceId, noteId, viewId }: { invoke: Invoke; workspaceId: string; noteId: string; viewId: string }) {
  const [note, setNote] = useState<Note>();
  const [source, setSource] = useState<Source>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving">("saved");
  const [sheet, setSheet] = useState<PropertySheetState>();
  const latest = useRef<{ title: string; body: string }>({ title: "", body: "" });
  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sources = useMemo(() => noteSources(invoke, workspaceId), [invoke, workspaceId]);
  const { definitions, reload: reloadDefinitions } = usePropertyDefinitions(invoke, workspaceId);

  useEffect(() => {
    let current = true;
    void invoke<Note | null>("store_note", { id: noteId }, workspaceId)
      .then((loaded) => {
        if (!current) return;
        if (!loaded) return setError("This note no longer exists.");
        latest.current = { title: loaded.title, body: loaded.body };
        setNote(loaded);
        if (loaded.sourceId) void invoke<Source | null>("store_source", { id: loaded.sourceId }, workspaceId).then((s) => current && setSource(s ?? undefined));
      })
      .catch((e) => current && setError(String(e)));
    return () => {
      current = false;
    };
  }, [invoke, workspaceId, noteId]);

  // Saves run one at a time and each sends the newest title and body, so a slower
  // earlier save can never land after a later one. Property and header edits share the
  // queue but only send their own patch, so they never carry old text.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = async <T,>(work: () => Promise<T>) => {
    setSaved("saving");
    const run = queue.current.then(work);
    queue.current = run.catch(() => {});
    const result = await run;
    setSaved("saved");
    return result;
  };
  const save = async (patch: Partial<{ title: string; body: string }>) => {
    latest.current = { ...latest.current, ...patch };
    try {
      await enqueue(() => invoke("store_note_save", { id: noteId, title: latest.current.title, body: latest.current.body }, workspaceId));
      noteSaved(noteId);
      if (patch.title !== undefined) {
        void (window as unknown as { key: { tabAction: (a: string, p: unknown) => Promise<unknown> } }).key.tabAction("content-title", { viewId, title: patch.title });
        notesChanged();
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const saveMeta = async (patch: MetaPatch) => {
    try {
      const next = await enqueue(() => invoke<Note>("store_note_meta", { id: noteId, patch }, workspaceId));
      // Only the metadata: the editor keeps what it shows, which may be newer than the row.
      setNote((old) => old && { ...old, fields: next.fields, properties: next.properties, appearance: next.appearance, updatedAt: next.updatedAt });
      noteSaved(noteId);
      if (patch.appearance) notesChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  if (error && !note) return <p className="kx-note-page-error">{error}</p>;
  if (!note) return <div className="kx-note-page" aria-busy="true" />;
  return (
    <ItemPage
      kind="note"
      className="kx-note-page"
      innerClassName="kx-note-page-inner"
      appearance={readAppearance(note.appearance)}
      onAppearance={(appearance) => void saveMeta({ appearance })}
      media={sources.media}
      defaultIcon="note"
      bar={
        <header className="kx-note-page-head">
          {source ? (
            <button className="kx-note-source" onClick={() => sources.onOpenSource(source.id)}>
              <Icon name="quote" size={12} />
              Note on <strong>{source.title || "Untitled"}</strong>
            </button>
          ) : (
            <span className="kx-note-source">
              <Icon name="note" size={12} />
              Note
            </span>
          )}
          <span className="kx-spacer" />
          <span className="kx-note-saved" aria-live="polite">
            {saved === "saving" ? "Saving…" : `Saved · ${new Date(note.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
          </span>
          <details className="kx-menu kx-source-more">
            <summary className="kx-icon-button" title="More" aria-label="More">
              <Icon name="more" size={14} />
            </summary>
            <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
              <button
                onClick={async () => {
                  if (!window.confirm("Delete this note? This cannot be undone.")) return;
                  await invoke("store_note_delete", { id: noteId }, workspaceId);
                  notesChanged();
                  setError("This note was deleted.");
                  setNote(undefined);
                }}
              >
                Delete note…
              </button>
            </div>
          </details>
        </header>
      }
      titleText={note.title}
      details={{
        summary: noteSummary(note.fields ?? {}, note.properties ?? {}),
        content: (
          <ItemProperties
            id={note.id}
            fields={note.fields ?? {}}
            properties={note.properties ?? {}}
            definitions={definitions}
            onFields={(fields) => void saveMeta({ fields })}
            onProperties={(properties) => void saveMeta({ properties })}
            onEditDefinition={(definition) => setSheet({ mode: "edit", definition, targets: [] })}
            onNewProperty={() => setSheet({ mode: "new", targets: [] })}
          />
        ),
      }}
      title={
        <input
          className="kx-note-title"
          aria-label="Note title"
          placeholder="Untitled"
          defaultValue={note.title}
          onChange={(e) => {
            const title = e.target.value;
            clearTimeout(titleTimer.current);
            titleTimer.current = setTimeout(() => void save({ title }), 300);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.closest(".kx-note-page-inner")?.querySelector<HTMLElement>(".ProseMirror")?.focus();
            }
          }}
          autoFocus={!note.title && !note.body}
        />
      }
    >
      {error && <p className="kx-inline-error">{error}</p>}
      <NoteEditor
        value={note.body}
        onChange={(body) => void save({ body })}
        searchSources={sources.searchSources}
        resolveSource={sources.resolveSource}
        onOpenSource={sources.onOpenSource}
        media={sources.media}
        searchItems={sources.searchItems}
        searchItemsMore={sources.searchItemsMore}
        citeLabel={sources.citeLabel}
        onOpenItem={sources.onOpenItem}
        className="kx-note-page-editor"
      />
      <LinkedFrom invoke={invoke} workspaceId={workspaceId} item={{ kind: "note", id: noteId }} />
      {sheet && (
        <PropertySheet
          state={sheet}
          invoke={invoke}
          workspaceId={workspaceId}
          definitions={definitions}
          onClose={() => setSheet(undefined)}
          onSaved={reloadDefinitions}
          onCreated={(name) => void saveMeta({ properties: { [name]: "" } })}
        />
      )}
    </ItemPage>
  );
}

/** The folded details' one line: who wrote it and how many fields and properties it has. */
function noteSummary(fields: Record<string, unknown>, properties: Record<string, unknown>) {
  const creators = Array.isArray(fields.creators) ? (fields.creators as Creator[]) : [];
  const count = Object.keys(fields).filter((k) => k !== "creators").length + Object.keys(properties).length;
  return [shortCreators(creators), count && `${count} ${count === 1 ? "property" : "properties"}`].filter(Boolean).join(" · ") || undefined;
}
