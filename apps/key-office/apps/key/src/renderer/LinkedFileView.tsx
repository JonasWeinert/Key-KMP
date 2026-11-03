// A file from a linked folder in its own pane. Markdown opens in the note editor and saves
// back to the file (refusing to overwrite a version changed in another app); other text
// shows as it is; everything else gets a Quick Look preview and "Open in default app".
// The file is re-read when the folder watcher reports a change made elsewhere.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { bridge, type Invoke } from "./library-api";
import LinkedFrom from "./LinkedFrom";
import { fileShowsAs, formatSize, linkedFile, linkedFolders, openLinkedFile, type LinkedFile } from "./linked-files";
import NoteEditor from "./note-editor";
import { noteSources } from "./note-sources";
import "./linked-folders.css";

type Text = { text: string; version: number };

export default function LinkedFileView({ invoke, workspaceId, fileId }: { invoke: Invoke; workspaceId: string; fileId: string }) {
  const [file, setFile] = useState<LinkedFile | null>();
  const [text, setText] = useState<Text>();
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState<"saved" | "saving">("saved");
  const [preview, setPreview] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const sources = useMemo(() => noteSources(invoke, workspaceId), [invoke, workspaceId]);
  /** The mtime of the version on screen; saves must match it. */
  const mtime = useRef(0);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = async (force = false) => {
    const found = await linkedFile(invoke, workspaceId, fileId).catch(() => null);
    setFile(found);
    if (!found) return;
    void linkedFolders(invoke, workspaceId).then((all) => setFolderName(all.find((f) => f.id === found.folderId)?.name ?? ""), () => {});
    const shows = fileShowsAs(found);
    if (shows !== "markdown" && shows !== "text") return;
    // Our own save, or an edit still being saved: nothing new to show.
    if (!force && (found.mtime === mtime.current || pending.current > 0)) return;
    try {
      const read = await invoke<{ file: LinkedFile; text: string }>("store_linked_read", { id: fileId }, workspaceId);
      mtime.current = read.file.mtime;
      setText((t) => ({ text: read.text, version: (t?.version ?? 0) + 1 }));
      setConflict(false);
      setError("");
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };

  useEffect(() => {
    mtime.current = 0;
    setText(undefined);
    void load(true);
    void invoke("store_linked_priority", { id: fileId }, workspaceId).catch(() => {});
    return bridge().on("linked-folders-changed", (value) => {
      if ((value as { workspaceId?: string })?.workspaceId === workspaceId) void load();
    });
  }, [invoke, workspaceId, fileId]);

  useEffect(() => {
    setPreview(null);
    if (!file || file.missing) return;
    const shows = fileShowsAs(file);
    if (shows === "markdown" || shows === "text") return;
    let current = true;
    void bridge()
      .thumbnail(file.absPath, 800)
      .then((url) => current && setPreview(url))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [file?.absPath, file?.mtime, file?.missing]);

  const save = (body: string) => {
    pending.current++;
    setSaved("saving");
    const run = queue.current.then(async () => {
      try {
        const written = await invoke<LinkedFile>("store_linked_write", { id: fileId, text: body, expectedMtime: mtime.current || null }, workspaceId);
        mtime.current = written.mtime;
        setFile(written);
        setSaved("saved");
      } catch (e) {
        const message = String(e);
        if (/changed in another app/i.test(message)) setConflict(true);
        else setError(message.replace(/^Error: /, ""));
      } finally {
        pending.current--;
      }
    });
    queue.current = run;
  };

  if (file === null) return <p className="kx-note-page-error">This file is no longer in its linked folder.</p>;
  if (!file) return <div className="kx-note-page" aria-busy="true" />;
  const shows = fileShowsAs(file);
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  return (
    <article className="kx-note-page kx-linked-file" data-kind={shows}>
      <div className="kx-note-page-inner">
        <header className="kx-note-page-head">
          <span className="kx-note-source" title={file.absPath}>
            <Icon name="folder" size={12} />
            {folderName || "Linked folder"}
            {dir && <strong>/ {dir}</strong>}
          </span>
          <span className="kx-spacer" />
          <span className="kx-note-saved" aria-live="polite">
            {shows === "markdown"
              ? saved === "saving"
                ? "Saving…"
                : `Saved to disk · ${formatSize(file.size)}`
              : [formatSize(file.size), file.indexed ? "Searchable" : ""].filter(Boolean).join(" · ")}
          </span>
          <button className="kx-icon-button" title="Open in default app" aria-label="Open in default app" onClick={() => void bridge().openPath(file.absPath)}>
            <Icon name="external" size={14} />
          </button>
          <button className="kx-icon-button" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void bridge().revealPath(file.absPath)}>
            <Icon name="folder" size={14} />
          </button>
        </header>
        <h1 className="kx-linked-file-title">{file.name}</h1>
        {file.missing && <p className="kx-linked-file-banner">This file is not in its folder any more, or the folder is offline. Links to it come back when it does.</p>}
        {conflict && (
          <p className="kx-linked-file-banner" role="alert">
            This file was changed in another app. Your last edit was not saved.
            <button className="kx-linked-file-banner-action" onClick={() => void load(true)}>
              Reload from disk
            </button>
          </p>
        )}
        {error && <p className="kx-linked-file-banner">{error}</p>}
        {shows === "markdown" && text && (
          <NoteEditor
            key={text.version}
            value={text.text}
            onChange={save}
            readOnly={conflict}
            searchSources={sources.searchSources}
            resolveSource={sources.resolveSource}
            onOpenSource={sources.onOpenSource}
            searchItems={sources.searchItems}
            searchItemsMore={sources.searchItemsMore}
            citeLabel={sources.citeLabel}
            onOpenItem={sources.onOpenItem}
            className="kx-note-page-editor"
          />
        )}
        {shows === "text" && text && <pre className="kx-linked-file-text">{text.text}</pre>}
        {shows !== "markdown" && shows !== "text" && (
          <div className="kx-linked-file-preview">
            {preview ? <img src={preview} alt="" draggable={false} /> : <Icon name={shows === "image" ? "image" : "doc"} size={40} />}
            <div className="kx-linked-file-actions">
              {shows === "pdf" && !file.missing && (
                <button onClick={() => void openLinkedFile(invoke, workspaceId, file.id, file.name)}>
                  Open in reader
                </button>
              )}
              <button disabled={file.missing} onClick={() => void bridge().openPath(file.absPath)}>
                Open in default app
              </button>
            </div>
            <p className="kx-linked-file-note">Files in linked folders stay where they are. Only Markdown can be edited here.</p>
          </div>
        )}
        <LinkedFrom invoke={invoke} workspaceId={workspaceId} item={{ kind: "file", id: file.id }} />
      </div>
    </article>
  );
}
