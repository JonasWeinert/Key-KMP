import { describe, expect, it } from "vitest";
import { History, alignNodes, belowContent, drawOrder, duplicate, edgeEnds, fitView, frameAround, group, inkNode, intersects, layoutCards, normalizeDoc, removeAll, snapRect, tidyNodes, ungroup, unfoldPositions, withFrameContents, withGroups, zoomAt, type CanvasDoc, type CanvasNode } from "./model";

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

describe("frames, alignment and layout", () => {
  const card = (id: string, x: number, y: number, w = 100, h = 60): CanvasNode => ({ id, type: "text", text: id, color: "ink", x, y, w, h });
  const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ version: 1, nodes, edges: [] });

  it("frames a selection behind it, and a moved frame carries what is inside", () => {
    const framed = frameAround(doc(card("a", 0, 0), card("b", 200, 100)), new Set(["a", "b"]))!;
    const frame = framed.doc.nodes[0];
    expect(frame.type === "shape" && frame.shape).toBe("frame");
    expect(frame.x).toBeLessThan(0);
    expect(frame.x + frame.w).toBeGreaterThan(300);
    const outside = { ...framed.doc, nodes: [...framed.doc.nodes, card("c", 900, 900)] };
    expect([...withFrameContents(outside, new Set([framed.id]))].sort()).toEqual(["a", "b", framed.id].sort());
    expect(drawOrder(outside.nodes)[0].id).toBe(framed.id);
  });

  it("aligns and tidies", () => {
    const d = doc(card("a", 10, 0), card("b", 50, 80, 200), card("c", 400, 30));
    const left = alignNodes(d, new Set(["a", "b", "c"]), "left");
    expect(left.nodes.map((n) => n.x)).toEqual([10, 10, 10]);
    const right = alignNodes(d, new Set(["a", "b"]), "right");
    expect(right.nodes[0].x + right.nodes[0].w).toBe(right.nodes[1].x + right.nodes[1].w);
    const tidy = tidyNodes(d, new Set(["a", "b", "c"]));
    const ys = new Set(tidy.nodes.map((n) => n.y));
    expect(ys.size).toBeLessThanOrEqual(2);
    for (const n of tidy.nodes) for (const m of tidy.nodes) if (n !== m) expect(intersects(n, m)).toBe(false);
  });

  it("unfolds to either side of a source without overlapping", () => {
    const source = { x: 0, y: 0, w: 280, h: 320 };
    const right = unfoldPositions(source, [{ w: 260, h: 160 }, { w: 260, h: 160 }], "right");
    expect(right.every(([x]) => x > source.x + source.w)).toBe(true);
    expect(right[1][1] - right[0][1]).toBeGreaterThanOrEqual(160);
    const left = unfoldPositions(source, [{ w: 320, h: 300 }], "left");
    expect(left[0][0] + 320).toBeLessThan(source.x);
  });

  it("lays cards out below a canvas's content", () => {
    const [x, y] = belowContent(doc(card("a", 0, 0, 100, 100)));
    expect(y).toBeGreaterThan(100);
    const cards = layoutCards([{ kind: "note", id: "n", title: "N" }, { kind: "source", id: "s", title: "S", detail: "pdf" }], [x, y]);
    expect(cards).toHaveLength(2);
    expect(cards[1].x).toBeGreaterThan(cards[0].x + cards[0].w);
  });
});
