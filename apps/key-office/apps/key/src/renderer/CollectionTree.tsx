import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "./DatabaseView";
import { Icon } from "./icons";
import type { Collection, Invoke } from "./library-api";
import { SOURCE_DRAG_TYPE, currentSelection, libraryChanged, onLibraryChanged, onLibrarySelection, selectLibrary } from "./library-nav";

/** Nesting indent, capped so deep levels still leave room for the name in a narrow sidebar. */
const indent = (depth: number) => `min(${4 + depth * 14}px, 30%)`;
const COLLECTION_DRAG_TYPE = "application/x-key-collection";
type Place = "before" | "inside" | "after";

const readSet = (key: string, fallback: string[] = []) => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)));
  } catch {
    return new Set<string>(fallback);
  }
};

/**
 * The sidebar's Library section: Sources with the workspace's collections nested under it,
 * then `children` (further library views). Collections are added, renamed, deleted, nested
 * and reordered here, and sources dropped on one are filed into it.
 */
export default function CollectionTree({
  invoke,
  workspaceId,
  sourcesCurrent,
  onShowSources,
  children,
}: {
  invoke: Invoke;
  workspaceId?: string;
  /** The Sources view is the active tab. */
  sourcesCurrent: boolean;
  onShowSources: () => void;
  children?: ReactNode;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selection, setSelection] = useState(currentSelection(workspaceId));
  const openKey = `key.collections.open:${workspaceId}`;
  // "@sources" stands for the Sources row's own disclosure; the section starts open.
  const [expanded, setExpanded] = useState<Set<string>>(() => readSet(openKey, ["@sources"]));
  const [sectionOpen, setSectionOpen] = useState(() => localStorage.getItem("key.sidebar.library") !== "closed");
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [renaming, setRenaming] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; place: Place }>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const dragging = useRef<string | null>(null);
  const hoverOpen = useRef<{ id: string; timer: number } | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return setCollections([]);
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => setCollections([]));
  }, [invoke, workspaceId]);
  useEffect(() => {
    load();
    setSelection(currentSelection(workspaceId));
    setExpanded(readSet(openKey, ["@sources"]));
    return onLibraryChanged(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, workspaceId]);
  useEffect(() => onLibrarySelection((s) => s.workspaceId === workspaceId && setSelection(s)), [workspaceId]);
  useEffect(() => {
    try {
      localStorage.setItem(openKey, JSON.stringify([...expanded]));
    } catch {}
  }, [expanded, openKey]);
  useEffect(() => {
    try {
      localStorage.setItem("key.sidebar.library", sectionOpen ? "open" : "closed");
    } catch {}
  }, [sectionOpen]);

  // Children in their stored order (position, then name).
  const children_ = useMemo(() => {
    const map = new Map<string | null, Collection[]>();
    for (const c of collections) {
      const list = map.get(c.parentId) ?? [];
      list.push(c);
      map.set(c.parentId, list);
    }
    return map;
  }, [collections]);
  const descendants = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    const walk = (parent: string) => (children_.get(parent) ?? []).forEach((c) => (out.add(c.id), walk(c.id)));
    walk(id);
    return out;
  };
  const toggle = (id: string, open?: boolean) =>
    setExpanded((e) => {
      const next = new Set(e);
      (open ?? !next.has(id)) ? next.add(id) : next.delete(id);
      return next;
    });

  const choose = (collectionId?: string) => {
    if (workspaceId) selectLibrary({ workspaceId, collectionId });
    onShowSources();
  };
  const run = (command: string, args: Record<string, unknown>) => invoke(command, args, workspaceId).then(() => libraryChanged());
  const create = async (name: string, parentId?: string) => {
    setCreating(null);
    if (!name.trim() || !workspaceId) return;
    const created = await invoke<Collection>("store_collection_create", { name, parentId: parentId ?? null }, workspaceId);
    toggle("@sources", true);
    if (parentId) toggle(parentId, true);
    libraryChanged();
    choose(created.id);
  };
  const remove = (c: Collection) => {
    const nested = descendants(c.id).size - 1;
    const what = nested ? ` and its ${nested === 1 ? "sub-collection" : `${nested} sub-collections`}` : "";
    if (!window.confirm(`Delete the collection “${c.name}”${what}?\n\nThe ${c.sourceCount === 1 ? "item stays" : "items stay"} in your library.`)) return;
    void run("store_collection_delete", { id: c.id }).then(() => {
      if (selection?.collectionId && descendants(c.id).has(selection.collectionId)) choose(undefined);
    });
  };
  const startCreate = (parentId?: string) => {
    toggle("@sources", true);
    if (parentId) toggle(parentId, true);
    setSectionOpen(true);
    setCreating({ parentId });
  };

  /** Moves a dragged collection before/after a sibling, or into a collection (null = top level). */
  const place = (id: string, target: Collection | null, where: Place) => {
    if (target && descendants(id).has(target.id)) return;
    if (!target || where === "inside") {
      const parentId = target?.id ?? null;
      const siblings = (children_.get(parentId) ?? []).map((c) => c.id).filter((s) => s !== id);
      if (target) toggle(target.id, true);
      return void run("store_collection_reorder", { parentId, ids: [...siblings, id] });
    }
    const siblings = (children_.get(target.parentId) ?? []).map((c) => c.id).filter((s) => s !== id);
    siblings.splice(siblings.indexOf(target.id) + (where === "after" ? 1 : 0), 0, id);
    void run("store_collection_reorder", { parentId: target.parentId, ids: siblings });
  };

  const dropProps = (target: Collection | null) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      const types = e.dataTransfer.types;
      const id = target?.id ?? "@sources";
      if (types.includes(SOURCE_DRAG_TYPE) && target) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDrop({ id, place: "inside" });
      } else if (types.includes(COLLECTION_DRAG_TYPE) && dragging.current) {
        if (target && descendants(dragging.current).has(target.id)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        setDrop({ id, place: !target ? "inside" : y < 0.28 ? "before" : y > 0.72 ? "after" : "inside" });
      } else return;
      // Hovering a closed collection while dragging opens it, as in Finder.
      if (target && (children_.get(target.id)?.length ?? 0) && !expanded.has(target.id) && hoverOpen.current?.id !== target.id) {
        if (hoverOpen.current) clearTimeout(hoverOpen.current.timer);
        hoverOpen.current = { id: target.id, timer: window.setTimeout(() => toggle(target.id, true), 650) };
      }
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDrop(undefined);
      if (hoverOpen.current) clearTimeout(hoverOpen.current.timer);
      hoverOpen.current = null;
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      const where = drop?.place ?? "inside";
      setDrop(undefined);
      if (e.dataTransfer.types.includes(COLLECTION_DRAG_TYPE)) {
        const id = e.dataTransfer.getData(COLLECTION_DRAG_TYPE);
        if (id && id !== target?.id) place(id, target, where);
        return;
      }
      const ids = JSON.parse(e.dataTransfer.getData(SOURCE_DRAG_TYPE) || "[]");
      if (ids.length && target) void run("store_membership", { collectionId: target.id, ids, present: true });
    },
  });

  const row = (c: Collection, depth: number): ReactNode => {
    const kids = children_.get(c.id) ?? [];
    const open = expanded.has(c.id);
    const current = sourcesCurrent && selection?.collectionId === c.id;
    return (
      <div key={c.id} role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={current} aria-level={depth + 2}>
        <div
          className="kx-tree-row"
          data-current={current}
          data-drop={drop?.id === c.id ? drop.place : undefined}
          style={{ paddingLeft: indent(depth) }}
          draggable={renaming !== c.id}
          onDragStart={(e) => {
            dragging.current = c.id;
            e.dataTransfer.setData(COLLECTION_DRAG_TYPE, c.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            dragging.current = null;
            setDrop(undefined);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ id: c.id, x: e.clientX, y: e.clientY });
          }}
          {...dropProps(c)}
        >
          <button
            className="kx-tree-disclosure"
            aria-label={open ? `Collapse ${c.name}` : `Expand ${c.name}`}
            tabIndex={-1}
            style={{ visibility: kids.length ? "visible" : "hidden" }}
            onClick={() => toggle(c.id)}
          >
            <Icon name="chevronRight" size={10} style={{ transform: open ? "rotate(90deg)" : undefined }} />
          </button>
          {renaming === c.id ? (
            <>
              <Icon name="folder" />
              <NameInput
                initial={c.name}
                label={`Rename ${c.name}`}
                onDone={(name) => {
                  setRenaming(undefined);
                  if (name && name !== c.name) void run("store_collection_update", { id: c.id, name });
                }}
              />
            </>
          ) : (
            <button
              className="kx-tree-label"
              onClick={() => choose(c.id)}
              onDoubleClick={() => setRenaming(c.id)}
              onKeyDown={(e) => {
                if (e.key === "F2" || (e.key === "Enter" && e.metaKey)) setRenaming(c.id);
                else if (e.key === "Backspace" && e.metaKey) remove(c);
                else if (e.key === "ArrowRight" && kids.length) toggle(c.id, true);
                else if (e.key === "ArrowLeft") toggle(c.id, false);
                else return;
                e.preventDefault();
              }}
              title={`${c.name} · double-click to rename, drag to move`}
            >
              <Icon name="folder" />
              <span>{c.name}</span>
              <small>{c.sourceCount || ""}</small>
            </button>
          )}
          {renaming !== c.id && (
            <span className="kx-tree-actions">
              <button aria-label={`New collection in ${c.name}`} title="New sub-collection" onClick={() => startCreate(c.id)}>
                <Icon name="plus" size={11} />
              </button>
              <button
                aria-label={`More for ${c.name}`}
                title="More"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ id: c.id, x: rect.left, y: rect.bottom + 4 });
                }}
              >
                <Icon name="more" size={11} />
              </button>
            </span>
          )}
        </div>
        {open && (
          <div role="group">
            {kids.map((kid) => row(kid, depth + 1))}
            {creating?.parentId === c.id && <NewRow depth={depth + 1} onDone={(name) => void create(name, c.id)} />}
          </div>
        )}
        {!open && creating?.parentId === c.id && <NewRow depth={depth + 1} onDone={(name) => void create(name, c.id)} />}
      </div>
    );
  };

  const top = children_.get(null) ?? [];
  const sourcesOpen = expanded.has("@sources");
  const menuCollection = menu && collections.find((c) => c.id === menu.id);
  return (
    <>
      <div className="key-sidebar-section kx-library-section">
        <button className="kx-section-toggle" aria-expanded={sectionOpen} onClick={() => setSectionOpen(!sectionOpen)}>
          <span>Library</span>
          <Icon name="chevronRight" size={9} style={{ transform: sectionOpen ? "rotate(90deg)" : undefined }} />
        </button>
        <button aria-label="New collection" title="New collection" disabled={!workspaceId} onClick={() => startCreate()}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {sectionOpen && (
        <nav className="kx-tree" role="tree" aria-label="Library">
          <div role="treeitem" aria-expanded={top.length ? sourcesOpen : undefined} aria-selected={sourcesCurrent && !selection?.collectionId} aria-level={1}>
            <div
              className="kx-tree-row kx-tree-root"
              data-current={sourcesCurrent && !selection?.collectionId}
              data-drop={drop?.id === "@sources" ? "inside" : undefined}
              style={{ paddingLeft: 4 }}
              {...dropProps(null)}
            >
              <button
                className="kx-tree-disclosure"
                aria-label={sourcesOpen ? "Collapse collections" : "Expand collections"}
                tabIndex={-1}
                style={{ visibility: top.length || creating ? "visible" : "hidden" }}
                onClick={() => toggle("@sources")}
              >
                <Icon name="chevronRight" size={10} style={{ transform: sourcesOpen ? "rotate(90deg)" : undefined }} />
              </button>
              <button className="kx-tree-label kx-nav-item" onClick={() => choose(undefined)} title="All sources · drop a collection here to move it to the top level">
                <Icon name="books" />
                <span>Sources</span>
              </button>
            </div>
            {sourcesOpen && (
              <div role="group">
                {top.map((c) => row(c, 1))}
                {creating && !creating.parentId && <NewRow depth={1} onDone={(name) => void create(name)} />}
                {workspaceId && !collections.length && !creating && <p className="key-sidebar-hint kx-tree-hint">Add a collection with +, then drag items onto it.</p>}
              </div>
            )}
          </div>
          {children}
        </nav>
      )}
      {menu && menuCollection && (
        <ContextMenu x={menu.x} y={menu.y} label={`${menuCollection.name} collection`} onClose={() => setMenu(undefined)}>
          {(close) => {
            const item = (text: string, icon: Parameters<typeof Icon>[0]["name"], action: () => void) => (
              <button
                key={text}
                role="menuitem"
                onClick={() => {
                  close();
                  action();
                }}
              >
                <Icon name={icon} size={13} />
                {text}
              </button>
            );
            return [
              item("Open", "folder", () => choose(menuCollection.id)),
              item("New sub-collection", "plus", () => startCreate(menuCollection.id)),
              item("Rename", "doc", () => setRenaming(menuCollection.id)),
              menuCollection.parentId && item("Move to top level", "arrowRight", () => place(menuCollection.id, null, "inside")),
              <hr key="rule" />,
              item("Delete collection…", "trash", () => remove(menuCollection)),
            ];
          }}
        </ContextMenu>
      )}
    </>
  );
}

function NameInput({ initial = "", label, onDone }: { initial?: string; label: string; onDone: (name: string) => void }) {
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
      aria-label={label}
      placeholder="Collection name"
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

function NewRow({ depth, onDone }: { depth: number; onDone: (name: string) => void }) {
  return (
    <div className="kx-tree-row" style={{ paddingLeft: indent(depth) }}>
      <span className="kx-tree-disclosure" />
      <Icon name="folder" />
      <NameInput label="New collection name" onDone={onDone} />
    </div>
  );
}
