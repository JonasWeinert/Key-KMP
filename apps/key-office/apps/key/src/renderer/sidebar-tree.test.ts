import { describe, expect, it } from "vitest";
import { ROOT, addFolder, buildTree, emptyLayout, moveNodes, parseLayout, removeFolder, sortTree } from "./sidebar-tree";

const items = ["note:a", "note:b", "canvas:c", "record:d"];

describe("sidebar tree", () => {
  it("lists new items at the end and drops missing ones", () => {
    const layout = parseLayout({ folders: {}, children: { root: ["note:b", "note:gone"] } });
    expect(buildTree(layout, items).get(ROOT)).toEqual(["note:b", "note:a", "canvas:c", "record:d"]);
    expect(parseLayout(null)).toEqual(emptyLayout());
  });

  it("reorders and files items into folders", () => {
    let tree = buildTree(emptyLayout(), items);
    const added = addFolder(emptyLayout(), tree, "Drafts");
    tree = buildTree(added.layout, items);
    expect(tree.get(ROOT)).toEqual([...items, added.key]);
    // record:d before note:a; then note:b into the folder.
    let layout = moveNodes(added.layout, tree, ["record:d"], ROOT, 0);
    tree = buildTree(layout, items);
    expect(tree.get(ROOT)).toEqual(["record:d", "note:a", "note:b", "canvas:c", added.key]);
    layout = moveNodes(layout, tree, ["note:b"], added.key, 0);
    tree = buildTree(layout, items);
    expect(tree.get(added.key)).toEqual(["note:b"]);
    expect(tree.get(ROOT)).toEqual(["record:d", "note:a", "canvas:c", added.key]);
    // Moving down within the same list counts the index before the move.
    layout = moveNodes(layout, tree, ["record:d"], ROOT, 3);
    expect(buildTree(layout, items).get(ROOT)).toEqual(["note:a", "canvas:c", "record:d", added.key]);
  });

  it("keeps folders out of themselves and empties removed folders into their parent", () => {
    let tree = buildTree(emptyLayout(), items);
    const outer = addFolder(emptyLayout(), tree, "Outer");
    tree = buildTree(outer.layout, items);
    const inner = addFolder(outer.layout, tree, "Inner", outer.key);
    tree = buildTree(inner.layout, items);
    expect(moveNodes(inner.layout, tree, [outer.key], inner.key, 0)).toBe(inner.layout);
    let layout = moveNodes(inner.layout, tree, ["note:a"], inner.key, 0);
    tree = buildTree(layout, items);
    layout = removeFolder(layout, tree, outer.key);
    tree = buildTree(layout, items);
    expect(tree.get(ROOT)).toEqual(["note:b", "canvas:c", "record:d", inner.key]);
    expect(tree.get(inner.key)).toEqual(["note:a"]);
    expect(layout.folders[outer.key]).toBeUndefined();
  });

  it("brings back folders whose parent was lost", () => {
    const layout = parseLayout({ folders: { "folder:x": { name: "X" } }, children: { "folder:y": ["folder:x"] } });
    expect(buildTree(layout, []).get(ROOT)).toEqual(["folder:x"]);
  });

  it("sorts with folders first", () => {
    const tree = new Map([[ROOT, ["note:b", "folder:z", "note:a"]]]);
    expect(sortTree(tree, (a, b) => a.localeCompare(b)).get(ROOT)).toEqual(["folder:z", "note:a", "note:b"]);
  });
});
