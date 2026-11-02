import { describe, expect, it } from "vitest";
import { History, duplicate, edgeEnds, fitView, group, inkNode, normalizeDoc, removeAll, snapRect, ungroup, withGroups, zoomAt, type CanvasDoc } from "./model";

const doc = (): CanvasDoc => ({
  version: 1,
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, w: 100, h: 40, text: "A", color: "ink" },
    { id: "b", type: "text", x: 300, y: 0, w: 100, h: 40, text: "B", color: "ink" },
    { id: "c", type: "shape", shape: "rect", x: 0, y: 200, w: 80, h: 80, text: "", color: "blue" },
  ],
  edges: [{ id: "e", from: { node: "a" }, to: { node: "b" }, color: "ink" }],
});

describe("canvas model", () => {
  it("snaps edges and centres and reports the guide", () => {
    const snap = snapRect({ x: 4, y: 100, w: 100, h: 40 }, [{ x: 0, y: 0, w: 100, h: 40 }], 6);
    expect(snap.dx).toBe(-4);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([{ axis: "x", at: 0, from: 0, to: 140 }]);
    expect(snapRect({ x: 70, y: 500, w: 10, h: 10 }, [{ x: 0, y: 0, w: 100, h: 40 }], 6).guides).toEqual([]);
  });

  it("puts connector ends on facing card edges so they follow the cards", () => {
    const [a, b] = edgeEnds({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 }, 0);
    expect(a).toEqual([100, 20]);
    expect(b).toEqual([300, 20]);
  });

  it("zooms around the pointer and fits content", () => {
    const view = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, 100, 100);
    expect(view).toEqual({ x: -100, y: -100, zoom: 2 });
    const fit = fitView({ x: 0, y: 0, w: 200, h: 100 }, 400, 300, 0);
    expect(fit.zoom).toBe(1.5);
  });

  it("groups select together, deletes take their connectors, copies keep inner connectors", () => {
    let d = group(doc(), new Set(["a", "c"]));
    expect([...withGroups(d, ["a"])].sort()).toEqual(["a", "c"]);
    d = ungroup(d, new Set(["a", "c"]));
    expect([...withGroups(d, ["a"])]).toEqual(["a"]);
    expect(removeAll(doc(), new Set(["b"])).edges).toEqual([]);
    const copy = duplicate(doc(), new Set(["a", "b"]));
    expect(copy.doc.nodes).toHaveLength(5);
    expect(copy.doc.edges).toHaveLength(2);
  });

  it("undoes and redoes whole documents", () => {
    const history = new History();
    const first = doc();
    const second = removeAll(first, new Set(["c"]));
    history.push(first);
    expect(history.undo(second)).toBe(first);
    expect(history.redo(first)).toBe(second);
    expect(history.redo(second)).toBeNull();
  });

  it("wraps ink in a node and drops connectors to missing nodes", () => {
    const ink = inkNode([[10, 10], [20, 30]], "ink", 2)!;
    expect([ink.x, ink.y, ink.w, ink.h]).toEqual([8, 8, 14, 24]);
    expect(normalizeDoc({ nodes: [{ id: "a" }], edges: [{ id: "e", from: { node: "a" }, to: { node: "x" } }] }).edges).toEqual([]);
  });
});
