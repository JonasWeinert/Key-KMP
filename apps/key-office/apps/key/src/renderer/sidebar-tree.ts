// The order and folders of the sidebar's Workspace section, kept per workspace in the store
// (`store_ui_get`/`store_ui_set`, key `sidebar.workspace`). Items are keyed "note:<id>",
// "canvas:<id>", "record:<id>"; folders "folder:<id>". Items the layout doesn't mention yet
// (new ones) go at the end of the top level; ones that no longer exist are dropped.

export const ROOT = "root";
export interface SidebarLayout {
  folders: Record<string, { name: string }>;
  /** Children of ROOT or a folder key, in order. */
  children: Record<string, string[]>;
}
export type Tree = Map<string, string[]>;
export const emptyLayout = (): SidebarLayout => ({ folders: {}, children: {} });
export const isFolder = (key: string) => key.startsWith("folder:");

export function parseLayout(value: unknown): SidebarLayout {
  const raw = value as Partial<SidebarLayout> | null;
  if (!raw || typeof raw !== "object") return emptyLayout();
  const folders: SidebarLayout["folders"] = {};
  for (const [key, folder] of Object.entries(raw.folders ?? {}))
    if (isFolder(key) && typeof folder?.name === "string") folders[key] = { name: folder.name };
  const children: SidebarLayout["children"] = {};
  for (const [key, list] of Object.entries(raw.children ?? {})) if (Array.isArray(list)) children[key] = list.filter((k) => typeof k === "string");
  return { folders, children };
}

/** Every folder and existing item placed once, top level first, in stored order. */
export function buildTree(layout: SidebarLayout, items: string[]): Tree {
  const exists = new Set([...items, ...Object.keys(layout.folders)]);
  const tree: Tree = new Map();
  const placed = new Set<string>();
  const walk = (parent: string) => {
    const list: string[] = [];
    tree.set(parent, list);
    for (const key of layout.children[parent] ?? []) {
      if (!exists.has(key) || placed.has(key)) continue;
      placed.add(key);
      list.push(key);
      if (isFolder(key)) walk(key);
    }
  };
  walk(ROOT);
  const top = tree.get(ROOT)!;
  // Folders cut off from the top (a stale parent) come back at the top level.
  for (const key of Object.keys(layout.folders))
    if (!placed.has(key)) {
      placed.add(key);
      top.push(key);
      walk(key);
    }
  for (const key of items) if (!placed.has(key)) top.push(key);
  return tree;
}

const toLayout = (layout: SidebarLayout, tree: Tree): SidebarLayout => ({ folders: layout.folders, children: Object.fromEntries(tree) });
const clone = (tree: Tree): Tree => new Map([...tree].map(([k, v]) => [k, [...v]]));
export const parentOf = (tree: Tree, key: string) => [...tree].find(([, list]) => list.includes(key))?.[0];

/** `key` and every folder and item inside it. */
export function descendants(tree: Tree, key: string): Set<string> {
  const out = new Set([key]);
  const walk = (k: string) => (tree.get(k) ?? []).forEach((child) => (out.add(child), walk(child)));
  walk(key);
  return out;
}

/** Moves keys into `parent` at `index` (counted in the list before the move). Folders can't go inside themselves. */
export function moveNodes(layout: SidebarLayout, shown: Tree, keys: string[], parent: string, index: number): SidebarLayout {
  const moving = keys.filter((key) => !descendants(shown, key).has(parent));
  if (!moving.length) return layout;
  const tree = clone(shown);
  const target = tree.get(parent) ?? [];
  let at = Math.max(0, Math.min(index, target.length));
  at -= target.slice(0, at).filter((k) => moving.includes(k)).length;
  for (const list of tree.values()) for (const key of moving) if (list.includes(key)) list.splice(list.indexOf(key), 1);
  const list = tree.get(parent) ?? [];
  list.splice(at, 0, ...moving);
  tree.set(parent, list);
  return toLayout(layout, tree);
}

export function addFolder(layout: SidebarLayout, shown: Tree, name: string, parent = ROOT, index?: number): { layout: SidebarLayout; key: string } {
  const key = `folder:${crypto.randomUUID()}`;
  const tree = clone(shown);
  const list = tree.get(parent) ?? [];
  list.splice(index ?? list.length, 0, key);
  tree.set(parent, list);
  tree.set(key, []);
  return { layout: { ...toLayout(layout, tree), folders: { ...layout.folders, [key]: { name } } }, key };
}

export function renameFolder(layout: SidebarLayout, key: string, name: string): SidebarLayout {
  return { ...layout, folders: { ...layout.folders, [key]: { name } } };
}

/** Removes a folder; what was in it takes its place. */
export function removeFolder(layout: SidebarLayout, shown: Tree, key: string): SidebarLayout {
  const tree = clone(shown);
  const parent = parentOf(tree, key) ?? ROOT;
  const list = tree.get(parent) ?? [];
  const at = list.indexOf(key);
  list.splice(at < 0 ? list.length : at, at < 0 ? 0 : 1, ...(tree.get(key) ?? []));
  tree.delete(key);
  const folders = { ...layout.folders };
  delete folders[key];
  return { folders, children: Object.fromEntries(tree) };
}

/** The tree with every list sorted by `compare` (folders first), for a sorted view or to keep it as the manual order. */
export function sortTree(tree: Tree, compare: (a: string, b: string) => number): Tree {
  const sorted: Tree = new Map();
  for (const [parent, list] of tree)
    sorted.set(parent, [...list].sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || compare(a, b)));
  return sorted;
}
