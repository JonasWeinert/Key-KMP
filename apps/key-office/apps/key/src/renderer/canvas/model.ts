// The canvas scene as stored in key-store (`canvases.doc`), and the geometry the editor
// needs: snapping with alignment guides, connector end points, groups and undo history.
// Pure functions only, so they are tested without a DOM.
import type { ItemLink } from "../note-editor";

export type Point = [number, number];
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface NodeBase extends Rect {
  id: string;
  /** Nodes sharing a group move and select together. */
  group?: string;
}
/** A note, source, highlight, image source or another canvas, shown as a card. */
export interface ItemNode extends NodeBase {
  type: "item";
  ref: ItemLink;
  /** The title when it was placed; the live title is looked up by id. */
  title: string;
  detail?: string;
  /** A highlight's colour (document data). */
  color?: string;
}
export interface TextNode extends NodeBase {
  type: "text";
  text: string;
  color: string;
}
export interface ShapeNode extends NodeBase {
  type: "shape";
  shape: "rect" | "ellipse" | "diamond";
  text: string;
  color: string;
}
/** Freehand ink; points are relative to the node's corner. */
export interface InkNode extends NodeBase {
  type: "ink";
  points: Point[];
  color: string;
  width: number;
  /** The size the points were drawn at; a resized stroke scales to the node. */
  vw: number;
  vh: number;
}
export type CanvasNode = ItemNode | TextNode | ShapeNode | InkNode;

export interface CanvasEdge {
  id: string;
  from: { node: string };
  to: { node: string };
  label?: string;
  color: string;
}
export interface CanvasDoc {
  version: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** A card's size when placed: notes and pages show their text, sources a preview. */
export function cardSize(item: { kind: string; anchor?: string; detail?: string }): { w: number; h: number } {
  if (item.anchor?.startsWith("highlight:")) return { w: 260, h: 160 };
  if (item.anchor?.startsWith("page:")) return { w: 260, h: 320 };
  if (item.kind === "note" || item.kind === "record") return { w: 320, h: 300 };
  if (item.kind === "source") return PREVIEW_KINDS.has(item.detail ?? "") ? { w: 280, h: 320 } : { w: 280, h: 180 };
  return { w: 240, h: 120 };
}
/** Sources whose file has a Quick Look preview worth showing on the card. */
export const PREVIEW_KINDS = new Set(["pdf", "image", "video", "book", "document"]);
export const CARD_GAP = 24;

/** Cards for `items` in rows of four, the first one centred on `centre`. */
export function layoutCards(items: (ItemLink & { title: string; detail?: string; color?: string })[], [cx, cy]: Point): ItemNode[] {
  let x = 0,
    y = 0,
    rowHeight = 0;
  const first = items.length ? cardSize(items[0]) : { w: 0, h: 0 };
  return items.map((item, i) => {
    const size = cardSize(item);
    if (i && i % 4 === 0) {
      x = 0;
      y += rowHeight + CARD_GAP;
      rowHeight = 0;
    }
    const node: ItemNode = {
      id: newId(),
      type: "item",
      ref: { kind: item.kind, id: item.id, ...(item.anchor ? { anchor: item.anchor } : {}) },
      title: item.title,
      detail: item.detail,
      color: item.color,
      x: Math.round(cx - first.w / 2 + x),
      y: Math.round(cy - first.h / 2 + y),
      ...size,
    };
    x += size.w + CARD_GAP;
    rowHeight = Math.max(rowHeight, size.h);
    return node;
  });
}

/** Where cards added from outside a canvas go: below everything on it. */
export function belowContent(doc: CanvasDoc): Point {
  const box = bounds(doc.nodes);
  return box ? [box.x + 160, box.y + box.h + 200] : [0, 0];
}

export const EMPTY_DOC: CanvasDoc = { version: 1, nodes: [], edges: [] };
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const SNAP_PX = 6;

export function normalizeDoc(value: unknown): CanvasDoc {
  const doc = (value ?? {}) as Partial<CanvasDoc>;
  const nodes = Array.isArray(doc.nodes) ? doc.nodes.filter((n) => n && typeof n.id === "string") : [];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = Array.isArray(doc.edges) ? doc.edges.filter((e) => e && ids.has(e.from?.node) && ids.has(e.to?.node)) : [];
  return { version: 1, nodes, edges };
}

export const newId = () => crypto.randomUUID().slice(0, 12);

// ── Viewport ───────────────────────────────────────────────────────────────

export const toWorld = (view: Viewport, x: number, y: number): Point => [(x - view.x) / view.zoom, (y - view.y) / view.zoom];

/** Zooms by `factor` keeping the screen point (x, y) still. */
export function zoomAt(view: Viewport, factor: number, x: number, y: number): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const [wx, wy] = toWorld(view, x, y);
  return { zoom, x: x - wx * zoom, y: y - wy * zoom };
}

/** A viewport that shows `rect` inside a screen of `width` × `height`, with a margin. */
export function fitView(rect: Rect | null, width: number, height: number, margin = 64): Viewport {
  if (!rect || rect.w <= 0 || rect.h <= 0) return { x: width / 2, y: height / 2, zoom: 1 };
  const zoom = Math.min(1.5, Math.max(MIN_ZOOM, Math.min((width - margin * 2) / rect.w, (height - margin * 2) / rect.h)));
  return { zoom, x: width / 2 - (rect.x + rect.w / 2) * zoom, y: height / 2 - (rect.y + rect.h / 2) * zoom };
}

// ── Geometry ───────────────────────────────────────────────────────────────

export function bounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** Where the line from the rect's centre towards `target` leaves the rect. */
export function boxExit(rect: Rect, target: Point): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target[0] - cx;
  const dy = target[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const scale = Math.min(dx ? rect.w / 2 / Math.abs(dx) : Infinity, dy ? rect.h / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * scale, cy + dy * scale];
}

/** A connector's two ends: on the edges of its cards, facing each other, so it follows them. */
export function edgeEnds(from: Rect, to: Rect, gap = 4): [Point, Point] {
  const centre = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];
  const pad = (r: Rect): Rect => ({ x: r.x - gap, y: r.y - gap, w: r.w + gap * 2, h: r.h + gap * 2 });
  return [boxExit(pad(from), centre(to)), boxExit(pad(to), centre(from))];
}

/** A gentle curve between two points (SVG path). */
export function edgePath([a, b]: [Point, Point]): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const k = 0.35;
  const c1: Point = horizontal ? [a[0] + dx * k, a[1]] : [a[0], a[1] + dy * k];
  const c2: Point = horizontal ? [b[0] - dx * k, b[1]] : [b[0], b[1] - dy * k];
  return `M${a[0]},${a[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${b[0]},${b[1]}`;
}

/** The arrow head at `b`, pointing away from `a`. */
export function arrowHead(a: Point, b: Point, size = 9): string {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const left: Point = [b[0] - size * Math.cos(angle - 0.45), b[1] - size * Math.sin(angle - 0.45)];
  const right: Point = [b[0] - size * Math.cos(angle + 0.45), b[1] - size * Math.sin(angle + 0.45)];
  return `M${left[0]},${left[1]} L${b[0]},${b[1]} L${right[0]},${right[1]}`;
}

// ── Snapping ───────────────────────────────────────────────────────────────

export interface Guide {
  axis: "x" | "y";
  /** The guide's position on its axis, and its extent on the other. */
  at: number;
  from: number;
  to: number;
}
export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * Nudges a moving box so its left, centre or right (top, middle, bottom) lines up with
 * another box's, when within `threshold` world units, and returns the guides to draw.
 */
export function snapRect(moving: Rect, others: Rect[], threshold: number): Snap {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  const best = (mine: number[], theirs: (r: Rect) => number[]) => {
    let found: { delta: number; at: number } | null = null;
    for (const other of others) {
      for (const line of theirs(other)) {
        for (const own of mine) {
          const delta = line - own;
          if (Math.abs(delta) <= threshold && (!found || Math.abs(delta) < Math.abs(found.delta))) found = { delta, at: line };
        }
      }
    }
    return found;
  };
  const sx = best(xs(moving), xs);
  const sy = best(ys(moving), ys);
  const dx = sx?.delta ?? 0;
  const dy = sy?.delta ?? 0;
  const placed = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  if (sx) {
    const aligned = others.filter((o) => xs(o).some((l) => near(l, sx.at)));
    const span = bounds([placed, ...aligned])!;
    guides.push({ axis: "x", at: sx.at, from: span.y, to: span.y + span.h });
  }
  if (sy) {
    const aligned = others.filter((o) => ys(o).some((l) => near(l, sy.at)));
    const span = bounds([placed, ...aligned])!;
    guides.push({ axis: "y", at: sy.at, from: span.x, to: span.x + span.w });
  }
  return { dx, dy, guides };
}

// ── Editing ────────────────────────────────────────────────────────────────

/** A selection widened to whole groups. */
export function withGroups(doc: CanvasDoc, ids: Iterable<string>): Set<string> {
  const picked = new Set(ids);
  const groups = new Set(doc.nodes.filter((n) => picked.has(n.id) && n.group).map((n) => n.group));
  for (const node of doc.nodes) if (node.group && groups.has(node.group)) picked.add(node.id);
  return picked;
}

export function moveNodes(doc: CanvasDoc, ids: Set<string>, dx: number, dy: number): CanvasDoc {
  return { ...doc, nodes: doc.nodes.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) };
}

export function updateNode(doc: CanvasDoc, id: string, patch: Partial<CanvasNode>): CanvasDoc {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)) };
}

/** Removes nodes with the connectors that touch them, and connectors by id. */
export function removeAll(doc: CanvasDoc, ids: Set<string>): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !ids.has(n.id)),
    edges: doc.edges.filter((e) => !ids.has(e.id) && !ids.has(e.from.node) && !ids.has(e.to.node)),
  };
}

export function group(doc: CanvasDoc, ids: Set<string>): CanvasDoc {
  if (ids.size < 2) return doc;
  const id = newId();
  return { ...doc, nodes: doc.nodes.map((n) => (ids.has(n.id) ? { ...n, group: id } : n)) };
}

export function ungroup(doc: CanvasDoc, ids: Set<string>): CanvasDoc {
  return { ...doc, nodes: doc.nodes.map((n) => (ids.has(n.id) && n.group ? { ...n, group: undefined } : n)) };
}

/** Copies nodes (and the connectors among them) offset by `offset`, with fresh ids. */
export function duplicate(doc: CanvasDoc, ids: Set<string>, offset = 24): { doc: CanvasDoc; ids: Set<string> } {
  const map = new Map<string, string>();
  const groups = new Map<string, string>();
  const copies = doc.nodes
    .filter((n) => ids.has(n.id))
    .map((n) => {
      const id = newId();
      map.set(n.id, id);
      const grouped = n.group ? (groups.get(n.group) ?? groups.set(n.group, newId()).get(n.group)) : undefined;
      return { ...n, id, x: n.x + offset, y: n.y + offset, group: grouped } as CanvasNode;
    });
  const edges = doc.edges
    .filter((e) => map.has(e.from.node) && map.has(e.to.node))
    .map((e) => ({ ...e, id: newId(), from: { node: map.get(e.from.node)! }, to: { node: map.get(e.to.node)! } }));
  return { doc: { ...doc, nodes: [...doc.nodes, ...copies], edges: [...doc.edges, ...edges] }, ids: new Set(map.values()) };
}

/** Ink points in world space become a node around them. */
export function inkNode(points: Point[], color: string, width: number): InkNode | null {
  if (points.length < 2) return null;
  const box = bounds(points.map(([x, y]) => ({ x, y, w: 0, h: 0 })))!;
  const pad = width;
  const w = Math.max(box.w + pad * 2, 1);
  const h = Math.max(box.h + pad * 2, 1);
  return {
    id: newId(),
    type: "ink",
    x: box.x - pad,
    y: box.y - pad,
    w,
    h,
    vw: w,
    vh: h,
    points: points.map(([x, y]) => [Math.round((x - box.x + pad) * 10) / 10, Math.round((y - box.y + pad) * 10) / 10]),
    color,
    width,
  };
}

export function inkPath(points: Point[]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
}

// ── History ────────────────────────────────────────────────────────────────

/** Undo and redo over whole documents (they are small and immutable). */
export class History {
  private past: CanvasDoc[] = [];
  private future: CanvasDoc[] = [];
  constructor(private limit = 200) {}

  /** Records `before` as the state to return to. */
  push(before: CanvasDoc) {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: CanvasDoc): CanvasDoc | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(current);
    return previous;
  }
  redo(current: CanvasDoc): CanvasDoc | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
