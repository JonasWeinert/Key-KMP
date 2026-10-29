import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import type { Collection, Invoke } from "./library-api";
import { SOURCE_DRAG_TYPE, currentSelection, libraryChanged, onLibraryChanged, onLibrarySelection, selectLibrary } from "./library-nav";

/** The sidebar's collection tree for one workspace library. */
export default function CollectionTree({
  invoke,
  workspaceId,
  onShowSources,
}: {
  invoke: Invoke;
  workspaceId: string;
  onShowSources: () => void;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selection, setSelection] = useState(currentSelection(workspaceId));
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`key.collections.open:${workspaceId}`) || "[]"));
    } catch {
      return new Set();
    }
  });
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [renaming, setRenaming] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();

  const load = useCallback(() => {
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => setCollections([]));
  }, [invoke, workspaceId]);
  useEffect(() => {
    load();
    setSelection(currentSelection(workspaceId));
    return onLibraryChanged(load);
  }, [load, workspaceId]);
  useEffect(() => onLibrarySelection((s) => s.workspaceId === workspaceId && setSelection(s)), [workspaceId]);
  useEffect(() => {
    try {
      localStorage.setItem(`key.collections.open:${workspaceId}`, JSON.stringify([...expanded]));
    } catch {}
  }, [expanded, workspaceId]);

  const children = useMemo(() => {
    const map = new Map<string | null, Collection[]>();
    for (const c of collections) {
      const list = map.get(c.parentId) ?? [];
      list.push(c);
      map.set(c.parentId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return map;
  }, [collections]);

  const choose = (collectionId?: string) => {
    selectLibrary({ workspaceId, collectionId });
    onShowSources();
  };
  const create = async (name: string, parentId?: string) => {
    if (name.trim()) {
      const created = await invoke<Collection>("store_collection_create", { name, parentId: parentId ?? null }, workspaceId);
      if (parentId) setExpanded((e) => new Set(e).add(parentId));
      libraryChanged();
      choose(created.id);
    }
    setCreating(null);
  };

  const row = (c: Collection, depth: number) => {
    const kids = children.get(c.id) ?? [];
    const open = expanded.has(c.id);
    const current = selection?.collectionId === c.id;
    return (
      <div key={c.id} role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={current}>
        <div
          className="kx-tree-row"
          data-current={current}
          data-drop={dropTarget === c.id}
          style={{ paddingLeft: 4 + depth * 14 }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(SOURCE_DRAG_TYPE)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropTarget(c.id);
            }
          }}
          onDragLeave={() => setDropTarget(undefined)}
          onDrop={(e) => {
            setDropTarget(undefined);
            const ids = JSON.parse(e.dataTransfer.getData(SOURCE_DRAG_TYPE) || "[]");
            if (ids.length)
              void invoke("store_membership", { collectionId: c.id, ids, present: true }, workspaceId).then(() => libraryChanged());
          }}
        >
          <button
            className="kx-tree-disclosure"
            aria-label={open ? "Collapse" : "Expand"}
            style={{ visibility: kids.length ? "visible" : "hidden" }}
            onClick={() => setExpanded((e) => {
              const next = new Set(e);
              next.has(c.id) ? next.delete(c.id) : next.add(c.id);
              return next;
            })}
          >
            <Icon name="chevronRight" size={10} style={{ transform: open ? "rotate(90deg)" : undefined }} />
          </button>
          {renaming === c.id ? (
            <input
              className="kx-tree-input"
              autoFocus
              defaultValue={c.name}
              onBlur={(e) => {
                const name = e.target.value.trim();
                setRenaming(undefined);
                if (name && name !== c.name) void invoke("store_collection_update", { id: c.id, name }, workspaceId).then(() => libraryChanged());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(undefined);
              }}
            />
          ) : (
            <button className="kx-tree-label" onClick={() => choose(c.id)} onDoubleClick={() => setRenaming(c.id)} title={`${c.name} · double-click to rename`}>
              <Icon name="folder" />
              <span>{c.name}</span>
              <small>{c.sourceCount || ""}</small>
            </button>
          )}
          <span className="kx-tree-actions">
            <button aria-label={`New collection in ${c.name}`} title="New sub-collection" onClick={() => setCreating({ parentId: c.id })}>
              <Icon name="plus" size={11} />
            </button>
            <button
              aria-label={`Delete ${c.name}`}
              title="Delete collection (items stay in the library)"
              onClick={() => {
                if (window.confirm(`Delete the collection “${c.name}”${kids.length ? " and its sub-collections" : ""}? Items stay in your library.`))
                  void invoke("store_collection_delete", { id: c.id }, workspaceId).then(() => {
                    if (current) choose(undefined);
                    libraryChanged();
                  });
              }}
            >
              <Icon name="trash" size={11} />
            </button>
          </span>
        </div>
        {creating?.parentId === c.id && <NewRow depth={depth + 1} onDone={(name) => void create(name, c.id)} />}
        {open && kids.map((kid) => row(kid, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="key-sidebar-section">
        <span>Collections</span>
        <button aria-label="New collection" title="New collection" onClick={() => setCreating({})}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <nav className="kx-tree" role="tree" aria-label="Collections">
        <div className="kx-tree-row" data-current={!selection?.collectionId} style={{ paddingLeft: 4 }}>
          <span className="kx-tree-disclosure" />
          <button className="kx-tree-label" onClick={() => choose(undefined)}>
            <Icon name="layers" />
            <span>All sources</span>
          </button>
        </div>
        {(children.get(null) ?? []).map((c) => row(c, 0))}
        {creating && !creating.parentId && <NewRow depth={0} onDone={(name) => void create(name)} />}
        {!collections.length && !creating && <p className="key-sidebar-hint">Group sources into collections, or drag items onto one.</p>}
      </nav>
    </>
  );
}

function NewRow({ depth, onDone }: { depth: number; onDone: (name: string) => void }) {
  return (
    <div className="kx-tree-row" style={{ paddingLeft: 4 + depth * 14 }}>
      <span className="kx-tree-disclosure" />
      <Icon name="folder" />
      <input
        className="kx-tree-input"
        autoFocus
        placeholder="Collection name"
        onBlur={(e) => onDone(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") onDone("");
        }}
      />
    </div>
  );
}
