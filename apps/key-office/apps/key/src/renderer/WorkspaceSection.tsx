import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "./DatabaseView";
import { Icon, type IconName } from "./icons";
import { setItemDrag } from "./item-links";
import { toast } from "./item-actions";
import { itemAttrs } from "./item-ui";
import type { Invoke } from "./library-api";
import LinkedFolders from "./LinkedFolders";
import { SidebarSelect } from "./ReferencesPanel";
import {
  ROOT,
  addFolder,
  buildTree,
  descendants,
  emptyLayout,
  isFolder,
  moveNodes,
  parentOf,
  parseLayout,
  removeFolder,
  renameFolder,
  sortTree,
  type SidebarLayout,
  type Tree,
} from "./sidebar-tree";

/** A note, canvas, page or document listed in the Workspace section. */
export interface WorkspaceEntry {
  key: string;
  kind: "note" | "canvas" | "record";
  id: string;
  title: string;
  icon: IconName;
  /** note | canvas | page | database | document, for the filter. */
  type: "note" | "canvas" | "page" | "document";
  updatedAt?: number;
  /** What a drag into another app carries. */
  text?: string;
}
type Filter = "all" | WorkspaceEntry["type"];
type Sort = "manual" | "title" | "kind" | "edited";
const FILTERS: [Filter, string][] = [
  ["all", "All items"],
  ["note", "Notes"],
  ["canvas", "Canvases"],
  ["page", "Pages"],
  ["document", "Documents"],
];
const SORTS: [Sort, string][] = [
  ["manual", "Manual order"],
  ["title", "Name"],
  ["kind", "Kind"],
  ["edited", "Last edited"],
];
const NODE_DRAG_TYPE = "application/x-key-sidebar-node";
const LAYOUT_KEY = "sidebar.workspace";
type Place = "before" | "inside" | "after";
const indent = (depth: number) => `min(${8 + depth * 14}px, 30%)`;

/**
 * The sidebar's Workspace section: the workspace's notes, canvases, pages and documents
 * in an order and folders the user arranges by dragging, like Finder or Notion. The
 * arrangement is stored in the workspace (`store_ui_set`), so every window shows the same.
 */
export default function WorkspaceSection({
  invoke,
  workspaceId,
  name,
  entries,
  currentKey,
  onOpen,
  itemDrop,
  createMenu,
  onNewNote,
}: {
  invoke: Invoke;
  workspaceId?: string;
  name: string;
  entries: WorkspaceEntry[];
  /** The focused pane's item. */
  currentKey?: string;
  onOpen: (entry: WorkspaceEntry) => void;
  /** Drop handling for items dragged onto a note or canvas row (link it, add a card). */
  itemDrop: (entry: WorkspaceEntry) => Record<string, unknown>;
  /** The create button and its menu, from the shell. */
  createMenu: ReactNode;
  /** Creates a note and answers it, so it can be filed into a folder. */
  onNewNote: () => Promise<{ id: string } | undefined>;
}) {
  const [layout, setLayout] = useState<SidebarLayout>(emptyLayout);
  const [view, setView] = useState<{ filter: Filter; sort: Sort }>(() => {
    try {
      return { filter: "all", sort: "manual", ...JSON.parse(localStorage.getItem("key.sidebar.workspace.view") || "{}") };
    } catch {
      return { filter: "all", sort: "manual" };
    }
  });
  const openKey = `key.sidebar.folders:${workspaceId}`;
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string>();
  const [drop, setDrop] = useState<{ key: string; place: Place }>();
  const [menu, setMenu] = useState<{ key: string; x: number; y: number }>();
  const dragging = useRef<string | null>(null);
  const hoverOpen = useRef<{ key: string; timer: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("key.sidebar.workspace.view", JSON.stringify(view));
    } catch {}
  }, [view]);
  useEffect(() => {
    try {
      setOpened(new Set(JSON.parse(localStorage.getItem(openKey) || "[]")));
    } catch {
      setOpened(new Set());
    }
  }, [openKey]);
  const toggle = (key: string, open?: boolean) =>
    setOpened((now) => {
      const next = new Set(now);
      (open ?? !next.has(key)) ? next.add(key) : next.delete(key);
      try {
        localStorage.setItem(openKey, JSON.stringify([...next]));
      } catch {}
      return next;
    });

  // The arrangement, from the store; another window's change arrives as a window event.
  const load = useCallback(() => {
    if (!workspaceId) return setLayout(emptyLayout());
    void invoke<unknown>("store_ui_get", { key: LAYOUT_KEY }, workspaceId)
      .then((value) => setLayout(parseLayout(value)))
      .catch(() => setLayout(emptyLayout()));
  }, [invoke, workspaceId]);
  useEffect(() => {
    load();
    window.addEventListener("key:sidebar-layout", load);
    return () => window.removeEventListener("key:sidebar-layout", load);
  }, [load]);
  const save = (next: SidebarLayout, undo?: SidebarLayout, message?: string) => {
    if (next === layout || !workspaceId) return;
    setLayout(next);
    void invoke("store_ui_set", { key: LAYOUT_KEY, value: next }, workspaceId).catch((e) => toast(String(e)));
    if (message && undo) toast(message, () => save(undo));
  };

  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const tree = useMemo(() => buildTree(layout, entries.map((e) => e.key)), [layout, entries]);
  const label = (key: string) => (isFolder(key) ? (layout.folders[key]?.name ?? "Folder") : (byKey.get(key)?.title ?? ""));
  const shown: Tree = useMemo(() => {
    if (view.sort === "manual") return tree;
    const kindOrder = ["note", "canvas", "page", "document"];
    return sortTree(tree, (a, b) => {
      const x = byKey.get(a),
        y = byKey.get(b);
      if (view.sort === "kind" && x && y && x.type !== y.type) return kindOrder.indexOf(x.type) - kindOrder.indexOf(y.type);
      if (view.sort === "edited") return (y?.updatedAt ?? 0) - (x?.updatedAt ?? 0);
      return label(a).localeCompare(label(b), undefined, { sensitivity: "base", numeric: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, view.sort, byKey, layout.folders]);
  // A filter hides other kinds, and folders with nothing of that kind inside.
  const visible = (key: string): boolean =>
    view.filter === "all" || (isFolder(key) ? [...descendants(shown, key)].some((k) => !isFolder(k) && byKey.get(k)?.type === view.filter) : byKey.get(key)?.type === view.filter);

  /** Puts dragged keys before/after/inside `target` (null: the end of the top level). */
  const place = (keys: string[], target: string | null, where: Place) => {
    const parent = !target ? ROOT : where === "inside" ? target : (parentOf(shown, target) ?? ROOT);
    const list = shown.get(parent) ?? [];
    const index = !target || where === "inside" ? list.length : list.indexOf(target) + (where === "after" ? 1 : 0);
    // Dragging in a sorted view keeps what it shows as the new manual order.
    const next = moveNodes(view.sort === "manual" ? layout : { ...layout, children: Object.fromEntries(shown) }, shown, keys, parent, index);
    if (next === layout) return;
    if (view.sort !== "manual") setView({ ...view, sort: "manual" });
    if (where === "inside" && target) toggle(target, true);
    const moved = keys.length === 1 ? `“${label(keys[0])}”` : `${keys.length} items`;
    save(next, layout, where === "inside" && target ? `Moved ${moved} to ${label(target)}` : undefined);
  };
  const newFolder = (parent = ROOT) => {
    const { layout: next, key } = addFolder(layout, shown, "New folder", parent, parent === ROOT ? 0 : undefined);
    if (parent !== ROOT) toggle(parent, true);
    save(next);
    setRenaming(key);
  };
  const deleteFolder = (key: string) => {
    const before = layout;
    save(removeFolder(layout, shown, key), before, `Removed the folder ${label(key)}; its items moved up`);
  };
  const newNoteIn = async (folder: string) => {
    const note = await onNewNote();
    if (!note) return;
    // The new note isn't listed yet: file it by key, the tree picks it up when it arrives.
    const list = [...(tree.get(folder) ?? []), `note:${note.id}`];
    toggle(folder, true);
    save({ ...layout, children: { ...Object.fromEntries(tree), [folder]: list } });
  };

  const dragProps = (key: string, depth: number) => ({
    draggable: renaming !== key,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      dragging.current = key;
      e.dataTransfer.setData(NODE_DRAG_TYPE, key);
      e.dataTransfer.effectAllowed = "copyMove";
      const entry = byKey.get(key);
      if (entry) {
        setItemDrag(e.dataTransfer, [{ kind: entry.kind, id: entry.id, title: entry.title }]);
        if (entry.text) e.dataTransfer.setData("text/plain", entry.text);
      }
    },
    onDragEnd: () => {
      dragging.current = null;
      setDrop(undefined);
    },
    "data-drop": drop?.key === key ? drop.place : undefined,
    "data-depth": depth,
  });
  /** Rows take rows dragged within the section; other item drops go to `fallback` (a note or canvas row). */
  const dropProps = (key: string | null, fallback?: Record<string, unknown>) => {
    const other = (name: string, e: React.DragEvent) => (fallback?.[name] as ((e: React.DragEvent) => void) | undefined)?.(e);
    return {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!e.dataTransfer.types.includes(NODE_DRAG_TYPE) || !dragging.current) return other("onDragOver", e);
        if (key && descendants(shown, dragging.current).has(key)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (!key) return setDrop({ key: "@end", place: "after" });
        const rect = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        const where: Place = isFolder(key) ? (y < 0.28 ? "before" : y > 0.72 ? "after" : "inside") : y < 0.5 ? "before" : "after";
        setDrop({ key, place: where });
        // Hovering a closed folder while dragging opens it, as in Finder.
        if (isFolder(key) && !opened.has(key) && hoverOpen.current?.key !== key) {
          if (hoverOpen.current) clearTimeout(hoverOpen.current.timer);
          hoverOpen.current = { key, timer: window.setTimeout(() => toggle(key, true), 650) };
        }
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDrop(undefined);
        if (hoverOpen.current) clearTimeout(hoverOpen.current.timer);
        hoverOpen.current = null;
        other("onDragLeave", e);
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        const moving = e.dataTransfer.getData(NODE_DRAG_TYPE);
        if (!moving) return other("onDrop", e);
        e.preventDefault();
        e.stopPropagation();
        const where = drop?.place ?? "after";
        setDrop(undefined);
        if (moving !== key) place([moving], key, where);
      },
    };
  };

  const row = (key: string, depth: number): ReactNode => {
    if (!visible(key)) return null;
    if (isFolder(key)) {
      const open = opened.has(key) || view.filter !== "all";
      const kids = shown.get(key) ?? [];
      const name = label(key);
      return (
        <div key={key} role="treeitem" aria-level={depth + 1} aria-expanded={open} aria-selected={false}>
          <div
            className="kx-tree-row kx-folder-row"
            style={{ paddingLeft: indent(depth) }}
            {...dragProps(key, depth)}
            {...dropProps(key)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ key, x: e.clientX, y: e.clientY });
            }}
          >
            <button className="kx-tree-disclosure" tabIndex={-1} aria-label={open ? `Collapse ${name}` : `Expand ${name}`} onClick={() => toggle(key)}>
              <Icon name="chevronRight" size={10} style={{ transform: open ? "rotate(90deg)" : undefined }} />
            </button>
            {renaming === key ? (
              <>
                <Icon name="folder" />
                <FolderName
                  initial={name}
                  onDone={(next) => {
                    setRenaming(undefined);
                    if (next && next !== name) save(renameFolder(layout, key, next));
                  }}
                />
              </>
            ) : (
              <button
                className="kx-tree-label"
                title={`${name} · double-click to rename, drag to move`}
                onClick={() => toggle(key)}
                onDoubleClick={() => setRenaming(key)}
                onKeyDown={(e) => {
                  if (e.key === "F2" || (e.key === "Enter" && e.metaKey)) setRenaming(key);
                  else if (e.key === "ArrowRight") toggle(key, true);
                  else if (e.key === "ArrowLeft") toggle(key, false);
                  else return;
                  e.preventDefault();
                }}
              >
                <Icon name="folder" />
                <span>{name}</span>
                <small>{kids.filter((k) => !isFolder(k)).length || ""}</small>
              </button>
            )}
            {renaming !== key && (
              <span className="kx-tree-actions">
                <button aria-label={`More for ${name}`} title="More" onClick={(e) => setMenu({ key, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}>
                  <Icon name="more" size={11} />
                </button>
              </span>
            )}
          </div>
          {open && (
            <div role="group">
              {kids.map((k) => row(k, depth + 1))}
              {!kids.length && (
                <p className="key-sidebar-hint kx-folder-empty" style={{ paddingLeft: indent(depth + 1) }}>
                  Drag items here
                </p>
              )}
            </div>
          )}
        </div>
      );
    }
    const entry = byKey.get(key);
    if (!entry) return null;
    const fallback = entry.kind === "record" ? undefined : itemDrop(entry);
    return (
      <div key={key} role="treeitem" aria-level={depth + 1} aria-selected={currentKey === key}>
        <button
          className="kx-nav-item kx-workspace-item"
          aria-current={currentKey === key ? "page" : undefined}
          style={{ paddingLeft: `calc(${indent(depth)} + 18px)` }}
          title={entry.title}
          onClick={() => onOpen(entry)}
          {...(fallback ?? {})}
          {...itemAttrs({ kind: entry.kind, id: entry.id, title: entry.title })}
          {...dragProps(key, depth)}
          {...dropProps(key, fallback)}
        >
          <Icon name={entry.icon} />
          <span>{entry.title}</span>
        </button>
      </div>
    );
  };

  const top = shown.get(ROOT) ?? [];
  const menuKey = menu?.key;
  return (
    <section className="kx-workspace-section" aria-label="Workspace items">
      <div className="key-sidebar-section kx-workspace-heading">
        <span title={name}>{name}</span>
        <button aria-label="New folder" title="New folder" disabled={!workspaceId} onClick={() => newFolder()}>
          <Icon name="folder" size={13} />
        </button>
        {createMenu}
      </div>
      {workspaceId && (
        <div className="kx-workspace-toolbar">
          <SidebarSelect label="Show in workspace" icon="filter" value={view.filter} onChange={(filter) => setView({ ...view, filter: filter as Filter })} options={FILTERS} />
          <SidebarSelect label="Sort workspace" icon="sort" value={view.sort} onChange={(sort) => setView({ ...view, sort: sort as Sort })} options={SORTS} />
        </div>
      )}
      <nav className="kx-tree kx-workspace-tree" role="tree" aria-label="Workspace">
        {top.map((key) => row(key, 0))}
        {workspaceId && !entries.length && <p className="key-sidebar-hint">No notes, canvases or pages yet. Create one with +.</p>}
        {workspaceId && view.filter !== "all" && !!entries.length && !top.some(visible) && <p className="key-sidebar-hint">Nothing of this kind yet.</p>}
        {/* The rest of the section takes a row dropped at the end of the top level. */}
        <div className="kx-workspace-end" data-drop={drop?.key === "@end" ? "after" : undefined} {...dropProps(null)} />
      </nav>
      <LinkedFolders invoke={invoke} workspaceId={workspaceId} />
      {menu && menuKey && (
        <ContextMenu x={menu.x} y={menu.y} label={`${label(menuKey)} folder`} onClose={() => setMenu(undefined)}>
          {(close) => {
            const item = (text: string, icon: IconName, run: () => void) => (
              <button
                key={text}
                role="menuitem"
                onClick={() => {
                  close();
                  run();
                }}
              >
                <Icon name={icon} size={13} />
                {text}
              </button>
            );
            return [
              item("New note here", "note", () => void newNoteIn(menuKey)),
              item("New folder inside", "folder", () => newFolder(menuKey)),
              item("Rename", "doc", () => setRenaming(menuKey)),
              parentOf(shown, menuKey) !== ROOT && item("Move to top level", "arrowRight", () => place([menuKey], null, "after")),
              <hr key="rule" />,
              item("Remove folder", "trash", () => deleteFolder(menuKey)),
            ];
          }}
        </ContextMenu>
      )}
    </section>
  );
}

function FolderName({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name.trim());
  };
  return (
    <input
      className="kx-tree-input"
      autoFocus
      aria-label="Folder name"
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(initial);
      }}
    />
  );
}
