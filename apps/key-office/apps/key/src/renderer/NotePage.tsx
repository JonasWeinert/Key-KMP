// A note in its own tab: a large title and the block editor, saved as Markdown as you type.
// Works for standalone notes and for notes that belong to a source.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import type { Invoke, Note, Source } from "./library-api";
import NoteEditor from "./note-editor";
import { noteSources } from "./note-sources";

/** Lets the sidebar list refresh when a note is created, renamed or deleted. */
export const notesChanged = () => window.dispatchEvent(new Event("key:notes-changed"));

export default function NotePage({ invoke, workspaceId, noteId, viewId }: { invoke: Invoke; workspaceId: string; noteId: string; viewId: string }) {
  const [note, setNote] = useState<Note>();
  const [source, setSource] = useState<Source>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving">("saved");
  const latest = useRef<{ title: string; body: string }>({ title: "", body: "" });
  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sources = useMemo(() => noteSources(invoke, workspaceId), [invoke, workspaceId]);

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
  // earlier save can never land after a later one.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = async (patch: Partial<{ title: string; body: string }>) => {
    latest.current = { ...latest.current, ...patch };
    setSaved("saving");
    try {
      const run = queue.current.then(() =>
        invoke("store_note_save", { id: noteId, title: latest.current.title, body: latest.current.body }, workspaceId),
      );
      queue.current = run.catch(() => {});
      await run;
      setSaved("saved");
      if (patch.title !== undefined) {
        void (window as unknown as { key: { tabAction: (a: string, p: unknown) => Promise<unknown> } }).key.tabAction("content-title", { viewId, title: patch.title });
        notesChanged();
      }
    } catch (e) {
      setError(String(e));
    }
  };

  if (error) return <p className="kx-note-page-error">{error}</p>;
  if (!note) return <div className="kx-note-page" aria-busy="true" />;
  return (
    <article className="kx-note-page">
      <div className="kx-note-page-inner">
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
          <button
            className="kx-icon-button"
            title="Delete note"
            aria-label="Delete note"
            onClick={async () => {
              if (!window.confirm("Delete this note? This cannot be undone.")) return;
              await invoke("store_note_delete", { id: noteId }, workspaceId);
              notesChanged();
              setError("This note was deleted.");
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </header>
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
        <NoteEditor
          value={note.body}
          onChange={(body) => void save({ body })}
          searchSources={sources.searchSources}
          resolveSource={sources.resolveSource}
          onOpenSource={sources.onOpenSource}
          media={sources.media}
          className="kx-note-page-editor"
        />
      </div>
    </article>
  );
}
