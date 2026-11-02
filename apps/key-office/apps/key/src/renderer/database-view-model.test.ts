import { describe, expect, it } from "vitest";
import { clickSort, moveColumn, resolveColumns, updateColumn } from "./database-view-model";

const columns = [
  { id: "title", width: 300, pinned: true },
  { id: "authors", width: 160 },
  { id: "year", width: 60 },
  { id: "tags", width: 140, hidden: true },
];
const ids = (list: { column: { id: string } }[]) => list.map((r) => r.column.id);

describe("database view columns", () => {
  it("applies saved order and settings, adding new columns beside their default neighbour", () => {
    const resolved = resolveColumns(columns, [
      { id: "year", width: 90 },
      { id: "title", pinned: true },
      { id: "authors", hidden: true },
    ]);
    // "tags" was never saved, so it follows "year", its neighbour in the defaults.
    expect(ids(resolved)).toEqual(["title", "year", "tags", "authors"]);
    expect(resolved[1].width).toBe(90);
    expect(resolved[2].hidden).toBe(true);
    expect(resolved[3].hidden).toBe(true);
  });

  it("moves columns, pinning those dropped into the pinned group", () => {
    const resolved = resolveColumns(columns, []);
    expect(moveColumn(resolved, "year", 1).map((s) => s.id)).toEqual(["title", "year", "authors", "tags"]);
    const pinned = moveColumn(resolved, "year", 0);
    expect(pinned[0]).toMatchObject({ id: "year", pinned: true });
    const unpinned = moveColumn(resolved, "title", 3);
    expect(unpinned.find((s) => s.id === "title")?.pinned).toBe(false);
  });

  it("clamps widths and hides columns", () => {
    const resolved = resolveColumns(columns, []);
    expect(updateColumn(resolved, "year", { width: 5 }).find((s) => s.id === "year")?.width).toBe(56);
    expect(updateColumn(resolved, "authors", { hidden: true }).find((s) => s.id === "authors")?.hidden).toBe(true);
  });
});

describe("database view sorting", () => {
  it("sorts by one field on a plain click and flips it on a second", () => {
    const once = clickSort([{ field: "added", descending: true }], "year", false);
    expect(once).toEqual([{ field: "year", descending: false }]);
    expect(clickSort(once, "year", false)).toEqual([{ field: "year", descending: true }]);
  });

  it("adds, flips and removes levels with Shift", () => {
    let sorts = clickSort([{ field: "year", descending: true }], "title", true);
    expect(sorts).toEqual([
      { field: "year", descending: true },
      { field: "title", descending: false },
    ]);
    sorts = clickSort(sorts, "title", true);
    expect(sorts[1]).toEqual({ field: "title", descending: true });
    expect(clickSort(sorts, "title", true)).toEqual([{ field: "year", descending: true }]);
  });
});
