// The sidebar's Linked folders: folders elsewhere on the computer, each with its files as a
// tree that loads one level at a time. A folder's menu turns tracking (listed and watched)
// and indexing (searchable) on and off, reveals it in Finder or unlinks it. Files act like
// any other item: hover previews, right-click actions, dragging onto canvases and notes.
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Icon, type IconName } from "./icons";
import { openItemAt, toast } from "./item-actions";
import { itemAttrs, itemMenuEntries, showMenu, type MenuEntry } from "./item-ui";
import { bridge, type Invoke } from "./library-api";
import { ensureFileId, fileShowsAs, linkedEntries, linkedFolders, type LinkedEntries, type LinkedFile, type LinkedFolder } from "./linked-files";
import { setItemDrag } from "./note-editor";
import "./linked-folders.css";

const indent = (depth: number) => `min(${4 + depth * 14}px, 40%)`;
const FILE_ICON: Record<string, IconName> = { markdown: "note", text: "doc", pdf: "doc", image: "image", other: "doc" };

const readOpen = (key: string) => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set<string>();
  }
};

export default function LinkedFolders({ invoke, workspaceId }: { invoke?: Invoke; workspaceId?: string }) {
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [sectionOpen, setSectionOpen] = useState(() => localStorage.getItem("key:linked-section") !== "closed");
  const storageKey = `key:linked-open:${workspaceId ?? ""}`;
  const [open, setOpen] = useState(() => readOpen(storageKey));
  /** Bumped when a folder's files change, so open levels re-read. */
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(() => {
    if (!invoke || !workspaceId) return setFolders([]);
    void linkedFolders(invoke, workspaceId)
      .then(setFolders)
      .catch(() => setFolders([]));
  }, [invoke, workspaceId]);

  useEffect(() => {
    setOpen(readOpen(storageKey));
    reload();
    return bridge().on("linked-folders-changed", (value) => {
      if ((value as { workspaceId?: string })?.workspaceId !== workspaceId) return;
      reload();
      setGeneration((g) => g + 1);
    });
  }, [reload, storageKey]);

  // While a folder is being indexed its count moves; look again now and then.
  const indexing = folders.some((f) => f.indexed && f.pendingFiles > 0);
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, [indexing, reload]);

  const toggle = (key: string, value?: boolean) =>
    setOpen((current) => {
      const next = new Set(current);
      if (value ?? !next.has(key)) next.add(key);
      else next.delete(key);
      localStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });

  const run = async (command: string, args: Record<string, unknown>) => {
    if (!invoke || !workspaceId) return;
    try {
      return await invoke<LinkedFolder | null>(command, args, workspaceId);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
    } finally {
      reload();
      setGeneration((g) => g + 1);
    }
  };

  const link = async () => {
    const folder = await run("linked_folder_choose", {});
    if (folder) {
      toggle(folder.id, true);
      toast(`Linked “${folder.name}” · ${folder.files} files`);
    }
  };

  const folderMenu = (folder: LinkedFolder, e: MouseEvent) => {
    e.preventDefault();
    const entries: (MenuEntry | "-")[] = [
      {
        label: folder.tracked ? "Tracked: listed and watched" : "Track changes",
        icon: folder.tracked ? "check" : "activity",
        run: () => void run("store_linked_set", { id: folder.id, tracked: !folder.tracked }),
      },
      {
        label: folder.indexed ? "Indexed for search" : "Index for search",
        icon: folder.indexed ? "check" : "search",
        run: () => void run("store_linked_set", { id: folder.id, indexed: !folder.indexed }),
      },
      "-",
      { label: "Reveal in Finder", icon: "folder", run: () => void bridge().revealPath(folder.path) },
      {
        label: "Unlink folder…",
        icon: "trash",
        run: () => {
          if (window.confirm(`Unlink “${folder.name}”? Its files stay where they are; links to them in notes and canvases will show as missing.`))
            void run("store_linked_unlink", { id: folder.id });
        },
      },
    ];
    showMenu({ x: e.clientX, y: e.clientY, entries });
  };

  if (!workspaceId) return null;
  return (
    <>
      <div className="key-sidebar-section kx-library-section kx-linked-section">
        <button className="kx-section-toggle" aria-expanded={sectionOpen} onClick={() => {
          localStorage.setItem("key:linked-section", sectionOpen ? "closed" : "open");
          setSectionOpen(!sectionOpen);
        }}>
          <span>Linked folders</span>
          <Icon name="chevronRight" size={9} style={{ transform: sectionOpen ? "rotate(90deg)" : undefined }} />
        </button>
        <button aria-label="Link a folder" title="Link a folder from your computer" onClick={() => void link()}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {sectionOpen && (
        <nav className="kx-tree kx-linked-tree" role="tree" aria-label="Linked folders">
          {!folders.length && <p className="key-sidebar-hint kx-tree-hint">Link a folder to see its files here without copying them.</p>}
          {folders.map((folder) => {
            const expanded = open.has(folder.id);
            const status = folder.missing
              ? "Offline"
              : folder.indexed && folder.pendingFiles > 0
                ? `Indexing ${folder.pendingFiles}`
                : folder.tracked
                  ? String(folder.files || "")
                  : "";
            return (
              <div key={folder.id} role="treeitem" aria-expanded={expanded} aria-level={1} data-folder-id={folder.id}>
                <div className="kx-tree-row" style={{ paddingLeft: 4 }} data-missing={folder.missing || undefined} onContextMenu={(e) => folderMenu(folder, e)}>
                  <button className="kx-tree-disclosure" aria-label={expanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`} tabIndex={-1} onClick={() => toggle(folder.id)}>
                    <Icon name="chevronRight" size={10} style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
                  </button>
                  <button
                    className="kx-tree-label"
                    onClick={() => toggle(folder.id)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowRight") toggle(folder.id, true);
                      else if (e.key === "ArrowLeft") toggle(folder.id, false);
                      else return;
                      e.preventDefault();
                    }}
                    title={`${folder.path}${folder.missing ? " · not available (an unmounted drive?)" : ""}${folder.indexed ? " · searchable" : folder.tracked ? "" : " · not tracked"}`}
                  >
                    <Icon name="folder" />
                    <span>{folder.name}</span>
                    {folder.indexed && <Icon name="search" size={10} className="kx-linked-badge" aria-label="Searchable" />}
                    <small>{status}</small>
                  </button>
                  <span className="kx-tree-actions">
                    <button
                      aria-label={`More for ${folder.name}`}
                      title="More"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        folderMenu(folder, { preventDefault() {}, clientX: rect.left, clientY: rect.bottom + 4 } as MouseEvent);
                      }}
                    >
                      <Icon name="more" size={11} />
                    </button>
                  </span>
                </div>
                {expanded && (
                  <Level invoke={invoke!} workspaceId={workspaceId} folder={folder} dir="" depth={1} open={open} toggle={toggle} generation={generation} />
                )}
              </div>
            );
          })}
        </nav>
      )}
    </>
  );
}

function Level({
  invoke,
  workspaceId,
  folder,
  dir,
  depth,
  open,
  toggle,
  generation,
}: {
  invoke: Invoke;
  workspaceId: string;
  folder: LinkedFolder;
  dir: string;
  depth: number;
  open: Set<string>;
  toggle: (key: string, value?: boolean) => void;
  generation: number;
}) {
  const [entries, setEntries] = useState<LinkedEntries>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void linkedEntries(invoke, workspaceId, folder.id, dir)
      .then((found) => {
        if (!current) return;
        setEntries(found);
        setError("");
      })
      .catch((e) => current && setError(String(e).replace(/^Error: /, "")));
    return () => {
      current = false;
    };
  }, [invoke, workspaceId, folder.id, folder.tracked, dir, generation]);

  const openFile = async (file: LinkedFile, placement: "tab" | "split" = "tab") => {
    try {
      const withId = await ensureFileId(invoke, workspaceId, file);
      openItemAt({ kind: "file", id: withId.id }, placement, withId.name, workspaceId, invoke);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
    }
  };

  if (error) return <p className="key-sidebar-hint kx-tree-hint" style={{ paddingLeft: indent(depth) }}>{folder.missing ? "The folder is not available." : error}</p>;
  if (!entries) return null;
  if (!entries.dirs.length && !entries.files.length)
    return <p className="key-sidebar-hint kx-tree-hint" style={{ paddingLeft: indent(depth) }}>{folder.missing ? "The folder is not available." : "Empty"}</p>;
  return (
    <div role="group">
      {entries.dirs.map((sub) => {
        const key = `${folder.id}:${sub.path}`;
        const expanded = open.has(key);
        return (
          <div key={sub.path} role="treeitem" aria-expanded={expanded} aria-level={depth + 1}>
            <div className="kx-tree-row" style={{ paddingLeft: indent(depth) }}>
              <button className="kx-tree-disclosure" tabIndex={-1} aria-label={expanded ? `Collapse ${sub.name}` : `Expand ${sub.name}`} onClick={() => toggle(key)}>
                <Icon name="chevronRight" size={10} style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
              </button>
              <button className="kx-tree-label" onClick={() => toggle(key)} title={sub.path}>
                <Icon name="folder" />
                <span>{sub.name}</span>
              </button>
            </div>
            {expanded && <Level invoke={invoke} workspaceId={workspaceId} folder={folder} dir={sub.path} depth={depth + 1} open={open} toggle={toggle} generation={generation} />}
          </div>
        );
      })}
      {entries.files.map((file) => {
        const item = file.id ? { kind: "file" as const, id: file.id, title: file.name } : undefined;
        const shows = fileShowsAs(file);
        return (
          <div key={file.path} role="treeitem" aria-level={depth + 1}>
            <div className="kx-tree-row" style={{ paddingLeft: indent(depth) }}>
              <span className="kx-tree-disclosure" />
              <button
                className="kx-tree-label kx-linked-file-row"
                data-kind={shows}
                data-linked-path={file.path}
                {...(item ? itemAttrs(item) : {})}
                draggable={!!item}
                onDragStart={(e) => {
                  if (!item) return;
                  setItemDrag(e.dataTransfer, [{ ...item, detail: shows }]);
                }}
                onClick={(e) => void openFile(file, e.altKey ? "split" : "tab")}
                onContextMenu={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const point = { x: e.clientX, y: e.clientY };
                  const withId = await ensureFileId(invoke, workspaceId, file).catch(() => undefined);
                  if (!withId) return;
                  const extra: MenuEntry[] = [
                    { label: "Open in default app", icon: "external", run: () => void bridge().openPath(withId.absPath) },
                    { label: "Reveal in Finder", icon: "folder", run: () => void bridge().revealPath(withId.absPath) },
                  ];
                  showMenu({ ...point, entries: itemMenuEntries([{ item: { kind: "file", id: withId.id }, title: withId.name }], extra) });
                }}
                title={`${file.path}${file.indexed ? " · searchable" : ""}`}
              >
                <Icon name={FILE_ICON[shows] ?? "doc"} />
                <span>{file.name}</span>
              </button>
            </div>
          </div>
        );
      })}
      {entries.truncated && <p className="key-sidebar-hint kx-tree-hint" style={{ paddingLeft: indent(depth) }}>Showing the first 5,000 files.</p>}
    </div>
  );
}
