// An infinite canvas in its own tab: cards for notes, sources, highlights and other
// canvases, free text, shapes, ink and connectors that follow their cards. Pan with the
// wheel, space-drag or the hand tool; zoom with ⌘/pinch. Moves snap to other cards with
// alignment guides. The scene saves to key-store as you work, and every card and every
// connector between two cards is a link, so the items show it under "Linked from".
// Anything dragged in (library rows, sidebar items, files, web links) lands as cards where
// it is dropped, and notes and pages show their whole text, rendered.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Icon, type IconName } from "../icons";
import { hasExternalDrop, hasItemDrag, importDrop, itemLinks, linkTargets, openItem, readItemDrag, type DraggedItem, type LinkEnd, type LinkTarget } from "../item-links";
import { bridge as libraryBridge, shortCreators, type Invoke, type Note, type Source } from "../library-api";
import NoteEditor from "../note-editor";
import { noteSources } from "../note-sources";
import { quickLook } from "../item-ui";
import { CHROME, CONTENT_COLORS, contentColor, currentTheme, highlightColor, type Theme } from "./canvas-colors";
import {
  EMPTY_DOC,
  History,
  PREVIEW_KINDS,
  layoutCards,
  SNAP_PX,
  arrowHead,
  bounds,
  duplicate,
  edgeEnds,
  edgePath,
  fitView,
  group,
  inkNode,
  inkPath,
  intersects,
  moveNodes,
  newId,
  normalizeDoc,
  rectFrom,
  removeAll,
  snapRect,
  toWorld,
  ungroup,
  updateNode,
  withGroups,
  zoomAt,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type Guide,
  type ItemNode,
  type Point,
  type Rect,
  type Viewport,
} from "./model";
import "./canvas.css";

type Tool = "select" | "hand" | "text" | "rect" | "ellipse" | "connector" | "pen";
const TOOLS: { tool: Tool; icon: IconName; label: string; key: string }[] = [
  { tool: "select", icon: "cursor", label: "Select", key: "v" },
  { tool: "hand", icon: "hand", label: "Pan", key: "h" },
  { tool: "text", icon: "text", label: "Text", key: "t" },
  { tool: "rect", icon: "square", label: "Rectangle", key: "r" },
  { tool: "ellipse", icon: "circle", label: "Ellipse", key: "o" },
  { tool: "connector", icon: "connector", label: "Connector", key: "a" },
  { tool: "pen", icon: "pen", label: "Draw", key: "p" },
];
const ITEM_ICON: Record<string, IconName> = { note: "note", canvas: "canvas", record: "doc", source: "doc" };
const SOURCE_ICON: Record<string, IconName> = { book: "book", web: "globe", image: "image", video: "video", audio: "audio" };
/** A new card's size: notes and pages are big enough to read, sources leave room for a preview. */
type Gesture =
  | { kind: "pan"; start: Point; view: Viewport }
  | { kind: "move"; start: Point; before: CanvasDoc; ids: Set<string>; box: Rect; others: Rect[]; moved: boolean }
  | { kind: "resize"; start: Point; before: CanvasDoc; id: string; rect: Rect }
  | { kind: "marquee"; start: Point; base: Set<string> }
  | { kind: "shape"; start: Point; shape: "rect" | "ellipse" }
  | { kind: "connect"; from: string }
  | { kind: "ink"; points: Point[] };

const bridge = () =>
  (window as unknown as {
    key: { on(event: string, cb: (value: unknown) => void): () => void; tabAction(action: string, payload?: unknown): Promise<unknown> };
  }).key;

/** Lets the sidebar list refresh when a canvas is created, renamed or deleted. */
export const canvasesChanged = () => window.dispatchEvent(new Event("key:canvases-changed"));

function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const update = () => setTheme(currentTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, []);
  return theme;
}

export default function CanvasPage({ invoke, workspaceId, canvasId, viewId }: { invoke: Invoke; workspaceId: string; canvasId: string; viewId: string }) {
  const theme = useTheme();
  const [doc, setDocState] = useState<CanvasDoc>(EMPTY_DOC);
  const [title, setTitle] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<{ ink?: Point[]; shape?: Rect; connect?: { from: string; to: Point; target?: string } }>({});
  const [adding, setAdding] = useState(false);
  const [live, setLive] = useState<Map<string, LinkEnd>>(new Map());
  const [saved, setSaved] = useState<"saved" | "saving">("saved");
  const [color, setColor] = useState<string>("ink");
  const [space, setSpace] = useState(false);
  const spacePanned = useRef(false);
  const [dropping, setDropping] = useState(false);
  const sources = useMemo(() => noteSources(invoke, workspaceId), [invoke, workspaceId]);
  /** Cards just placed, which take their content's height once it has loaded. */
  const fitting = useRef(new Set<string>());
  const fitCard = (id: string, height: number) => {
    if (!fitting.current.delete(id)) return;
    const h = Math.round(Math.min(480, Math.max(90, height)));
    const node = docRef.current.nodes.find((n) => n.id === id);
    if (!node || node.h === h) return;
    // A gesture that started before the content loaded must not put the old size back.
    const g = gesture.current;
    if (g && "before" in g) g.before = updateNode(g.before, id, { h });
    preview(updateNode(docRef.current, id, { h }));
    scheduleSave();
  };

  const root = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const viewRef = useRef(view);
  viewRef.current = view;
  const history = useRef(new History());
  const gesture = useRef<Gesture | null>(null);
  const [, setHistoryTick] = useState(0);

  // ── loading and saving ───────────────────────────────────────────────────
  const refreshLive = useCallback(
    () =>
      itemLinks(invoke, workspaceId, { kind: "canvas", id: canvasId })
        .then(({ outgoing }) => {
          const map = new Map<string, LinkEnd>();
          for (const link of outgoing) if (link.from.anchor?.startsWith("node:")) map.set(link.from.anchor.slice(5), link.to);
          setLive(map);
        })
        .catch(() => {}),
    [invoke, workspaceId, canvasId],
  );
  useEffect(() => {
    let current = true;
    void invoke<{ title: string; doc: unknown } | null>("store_canvas", { id: canvasId }, workspaceId)
      .then((canvas) => {
        if (!current) return;
        if (!canvas) return setError("This canvas no longer exists.");
        const loadedDoc = normalizeDoc(canvas.doc);
        setDocState(loadedDoc);
        setTitle(canvas.title);
        const box = root.current?.getBoundingClientRect();
        setView(fitView(bounds(loadedDoc.nodes), box?.width || 1000, box?.height || 700));
        setLoaded(true);
        void refreshLive();
      })
      .catch((e) => current && setError(String(e)));
    return () => {
      current = false;
    };
  }, [invoke, workspaceId, canvasId, refreshLive]);
  useEffect(() => bridge().on("links-changed", (p) => (p as { workspaceId?: string })?.workspaceId === workspaceId && void refreshLive()), [workspaceId, refreshLive]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (!dirty.current) return queue.current;
    dirty.current = false;
    setSaved("saving");
    const docToSave = docRef.current;
    const run = queue.current.then(() => invoke("store_canvas_save", { id: canvasId, doc: docToSave }, workspaceId));
    queue.current = run.catch(() => {});
    return run.then(() => setSaved("saved")).catch((e) => setError(String(e)));
  }, [invoke, workspaceId, canvasId]);
  useEffect(() => () => void flush(), [flush]);
  const scheduleSave = () => {
    dirty.current = true;
    setSaved("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 400);
  };

  /** A finished edit: undoable and saved. */
  const commit = (next: CanvasDoc, before: CanvasDoc = docRef.current) => {
    if (next === before) return;
    history.current.push(before);
    setHistoryTick((t) => t + 1);
    docRef.current = next;
    setDocState(next);
    scheduleSave();
  };
  /** A change while a gesture runs; the gesture commits once at the end. */
  const preview = (next: CanvasDoc) => {
    docRef.current = next;
    setDocState(next);
  };
  const undo = () => {
    const previous = history.current.undo(docRef.current);
    if (!previous) return;
    preview(previous);
    setSelected(new Set([...selected].filter((id) => previous.nodes.some((n) => n.id === id) || previous.edges.some((e) => e.id === id))));
    setHistoryTick((t) => t + 1);
    scheduleSave();
  };
  const redo = () => {
    const next = history.current.redo(docRef.current);
    if (!next) return;
    preview(next);
    setHistoryTick((t) => t + 1);
    scheduleSave();
  };

  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rename = (value: string) => {
    setTitle(value);
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      void invoke("store_canvas_save", { id: canvasId, title: value }, workspaceId).then(() => {
        canvasesChanged();
        void bridge().tabAction("content-title", { viewId, title: value });
      });
    }, 300);
  };

  // ── geometry helpers ─────────────────────────────────────────────────────
  const screenPoint = (e: { clientX: number; clientY: number }): Point => {
    const box = root.current!.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  const worldPoint = (e: { clientX: number; clientY: number }): Point => {
    const [sx, sy] = screenPoint(e);
    return toWorld(viewRef.current, sx, sy);
  };
  const nodeById = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes]);
  const nodeAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-node]")?.dataset.node;
  const viewportCentre = (): Point => {
    const box = root.current?.getBoundingClientRect();
    return toWorld(viewRef.current, (box?.width ?? 800) / 2, (box?.height ?? 600) / 2);
  };

  // ── adding things ────────────────────────────────────────────────────────
  /** Places items as cards in rows of four, the first centred on `at` (or the middle of the view). */
  const addItems = (items: DraggedItem[], at?: Point) => {
    const placing = items.filter((item) => !(item.kind === "canvas" && item.id === canvasId));
    if (!placing.length) return;
    const offset = at ? 0 : (docRef.current.nodes.length % 6) * 24;
    const [cx, cy] = at ?? viewportCentre();
    const nodes = layoutCards(placing, [cx + offset, cy + offset]);
    for (const node of nodes) fitting.current.add(node.id);
    commit({ ...docRef.current, nodes: [...docRef.current.nodes, ...nodes] });
    setSelected(new Set(nodes.map((n) => n.id)));
    setAdding(false);
    setTool("select");
    root.current?.focus({ preventScroll: true });
  };
  const addItem = (target: LinkTarget) => {
    const highlight = target.anchor?.startsWith("highlight:");
    addItems([{ kind: target.kind, id: target.id, anchor: target.anchor, title: target.title, detail: highlight ? target.context : target.detail, color: target.color }]);
  };
  // Dragged in from the library, the sidebar or a note; files and web links join the library first.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasItemDrag(e.dataTransfer) && !hasExternalDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    setDropping(false);
    const at = worldPoint(e);
    if (hasItemDrag(e.dataTransfer)) {
      e.preventDefault();
      addItems(readItemDrag(e.dataTransfer), at);
    } else if (hasExternalDrop(e.dataTransfer)) {
      e.preventDefault();
      void importDrop(invoke, workspaceId, e.dataTransfer)
        .then((items) => addItems(items, at))
        .catch((error) => setError(String(error)));
    }
  };
  const addText = (at: Point) => {
    const node: CanvasNode = { id: newId(), type: "text", x: Math.round(at[0]), y: Math.round(at[1] - 14), w: 200, h: 40, text: "", color };
    commit({ ...docRef.current, nodes: [...docRef.current.nodes, node] });
    setSelected(new Set([node.id]));
    setEditing(node.id);
    setTool("select");
  };

  // ── pointer gestures ─────────────────────────────────────────────────────
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".kx-canvas-chrome, textarea, input")) return;
    const at = worldPoint(e);
    if (e.button === 1 || (e.button === 0 && (tool === "hand" || space))) {
      if (space) spacePanned.current = true;
      gesture.current = { kind: "pan", start: screenPoint(e), view: viewRef.current };
    } else if (e.button !== 0) {
      return;
    } else {
      const nodeId = nodeAt(e.target);
      const edgeId = (e.target as Element).closest?.<SVGElement>("[data-edge]")?.dataset.edge;
      const handle = (e.target as HTMLElement).closest?.("[data-handle]");
      if (editing && nodeId === editing) return;
      setEditing(null);
      if (tool === "pen") {
        gesture.current = { kind: "ink", points: [at] };
        setDraft({ ink: [at] });
      } else if (tool === "connector") {
        if (!nodeId) return;
        gesture.current = { kind: "connect", from: nodeId };
        setDraft({ connect: { from: nodeId, to: at } });
      } else if (tool === "rect" || tool === "ellipse") {
        gesture.current = { kind: "shape", start: at, shape: tool };
        setDraft({ shape: { x: at[0], y: at[1], w: 0, h: 0 } });
      } else if (tool === "text" && !nodeId) {
        addText(at);
        return;
      } else if (handle && nodeId) {
        const node = nodeById.get(nodeId)!;
        gesture.current = { kind: "resize", start: at, before: docRef.current, id: nodeId, rect: { x: node.x, y: node.y, w: node.w, h: node.h } };
      } else if (nodeId) {
        let next = selected;
        if (e.shiftKey || e.metaKey) {
          next = new Set(selected);
          const members = withGroups(docRef.current, [nodeId]);
          for (const id of members) selected.has(nodeId) ? next.delete(id) : next.add(id);
        } else if (!selected.has(nodeId)) {
          next = withGroups(docRef.current, [nodeId]);
        }
        setSelected(next);
        if (next.has(nodeId)) {
          const moving = docRef.current.nodes.filter((n) => next.has(n.id));
          // Snap against what is on screen, so far-away cards do not pull.
          const box = root.current!.getBoundingClientRect();
          const [vx, vy] = toWorld(viewRef.current, 0, 0);
          const onScreen = { x: vx, y: vy, w: box.width / viewRef.current.zoom, h: box.height / viewRef.current.zoom };
          const others = docRef.current.nodes.filter((n) => !next.has(n.id) && intersects(n, onScreen));
          gesture.current = { kind: "move", start: at, before: docRef.current, ids: next, box: bounds(moving)!, others, moved: false };
        }
      } else if (edgeId) {
        setSelected(e.shiftKey ? new Set([...selected, edgeId]) : new Set([edgeId]));
        return;
      } else {
        const base = e.shiftKey ? new Set(selected) : new Set<string>();
        setSelected(base);
        gesture.current = { kind: "marquee", start: at, base };
      }
    }
    root.current?.setPointerCapture(e.pointerId);
    root.current?.focus({ preventScroll: true });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const at = worldPoint(e);
    switch (g.kind) {
      case "pan": {
        const [sx, sy] = screenPoint(e);
        setView({ ...g.view, x: g.view.x + sx - g.start[0], y: g.view.y + sy - g.start[1] });
        break;
      }
      case "move": {
        let dx = at[0] - g.start[0];
        let dy = at[1] - g.start[1];
        if (!g.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return;
        g.moved = true;
        // Hold ⌥ to place freely.
        const snap = e.altKey ? { dx: 0, dy: 0, guides: [] } : snapRect({ ...g.box, x: g.box.x + dx, y: g.box.y + dy }, g.others, SNAP_PX / viewRef.current.zoom);
        dx += snap.dx;
        dy += snap.dy;
        setGuides(snap.guides);
        preview(moveNodes(g.before, g.ids, Math.round(dx), Math.round(dy)));
        break;
      }
      case "resize": {
        const node = g.before.nodes.find((n) => n.id === g.id)!;
        let w = Math.max(40, g.rect.w + at[0] - g.start[0]);
        let h = Math.max(24, g.rect.h + at[1] - g.start[1]);
        if (e.shiftKey || node.type === "ink") {
          const ratio = g.rect.w / g.rect.h;
          if (w / h > ratio) h = w / ratio;
          else w = h * ratio;
        }
        // The right and bottom edges snap like a move does.
        const others = g.before.nodes.filter((n) => n.id !== g.id);
        const snap = e.altKey ? { dx: 0, dy: 0, guides: [] } : snapRect({ x: g.rect.x + w, y: g.rect.y + h, w: 0, h: 0 }, others, SNAP_PX / viewRef.current.zoom);
        setGuides(snap.guides);
        preview(updateNode(g.before, g.id, { w: Math.round(w + snap.dx), h: Math.round(h + snap.dy) }));
        break;
      }
      case "marquee": {
        const rect = rectFrom(g.start, at);
        setMarquee(rect);
        const hit = docRef.current.nodes.filter((n) => intersects(n, rect)).map((n) => n.id);
        setSelected(new Set([...g.base, ...withGroups(docRef.current, hit)]));
        break;
      }
      case "shape":
        setDraft({ shape: rectFrom(g.start, at) });
        break;
      case "connect": {
        const target = nodeAt(document.elementFromPoint(e.clientX, e.clientY));
        setDraft({ connect: { from: g.from, to: at, target: target && target !== g.from ? target : undefined } });
        break;
      }
      case "ink":
        g.points.push(at);
        setDraft({ ink: [...g.points] });
        break;
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setGuides([]);
    setMarquee(null);
    setDraft({});
    if (!g) return;
    switch (g.kind) {
      case "move":
      case "resize":
        if (docRef.current !== g.before) commit(docRef.current, g.before);
        break;
      case "shape": {
        const at = worldPoint(e);
        let rect = rectFrom(g.start, at);
        if (rect.w < 8 && rect.h < 8) rect = { x: g.start[0] - 60, y: g.start[1] - 40, w: 120, h: 80 };
        const node: CanvasNode = { id: newId(), type: "shape", shape: g.shape, ...roundRect(rect), text: "", color };
        commit({ ...docRef.current, nodes: [...docRef.current.nodes, node] });
        setSelected(new Set([node.id]));
        setTool("select");
        break;
      }
      case "connect": {
        const target = nodeAt(document.elementFromPoint(e.clientX, e.clientY));
        if (target && target !== g.from) {
          const edge: CanvasEdge = { id: newId(), from: { node: g.from }, to: { node: target }, color: color === "ink" ? "gray" : color };
          commit({ ...docRef.current, edges: [...docRef.current.edges, edge] });
          setSelected(new Set([edge.id]));
          setTool("select");
        }
        break;
      }
      case "ink": {
        const node = inkNode(g.points, color, 2.5);
        if (node) commit({ ...docRef.current, nodes: [...docRef.current.nodes, node] });
        break;
      }
    }
  };

  // Wheel: pan, or zoom with ⌘/ctrl (trackpad pinch arrives as ctrl+wheel).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".kx-canvas-chrome, textarea")) return;
      // A selected card whose text runs on scrolls itself until it reaches an end.
      const body = (e.target as HTMLElement).closest<HTMLElement>("[aria-selected='true'] .kx-canvas-card-body");
      if (body && !e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const room = e.deltaY > 0 ? body.scrollHeight - body.clientHeight - body.scrollTop : body.scrollTop;
        if (room > 1) return;
      }
      e.preventDefault();
      const box = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [loaded]);

  // ── keyboard ─────────────────────────────────────────────────────────────
  const selectedNodes = doc.nodes.filter((n) => selected.has(n.id));
  const selectedEdges = doc.edges.filter((e) => selected.has(e.id));
  const zoomBy = (factor: number) => {
    const box = root.current!.getBoundingClientRect();
    setView((v) => zoomAt(v, factor, box.width / 2, box.height / 2));
  };
  const fit = () => {
    const box = root.current!.getBoundingClientRect();
    setView(fitView(bounds(selectedNodes.length ? selectedNodes : docRef.current.nodes), box.width, box.height));
  };
  const setSelectionColor = (key: string) => {
    setColor(key);
    if (!selected.size) return;
    commit({
      ...docRef.current,
      nodes: docRef.current.nodes.map((n) => (selected.has(n.id) && n.type !== "item" ? { ...n, color: key } : n)),
      edges: docRef.current.edges.map((edge) => (selected.has(edge.id) ? { ...edge, color: key } : edge)),
    });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("textarea, input")) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (key === " ") {
      // Held, Space pans; a tap with one card selected previews it (see onKeyUp).
      e.preventDefault();
      if (!space) {
        setSpace(true);
        spacePanned.current = false;
      }
      return;
    }
    if (mod && key === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && key === "y") return redo();
    if (mod && key === "a") {
      e.preventDefault();
      return setSelected(new Set(doc.nodes.map((n) => n.id)));
    }
    if (mod && key === "g") {
      e.preventDefault();
      return commit(e.shiftKey ? ungroup(doc, selected) : group(doc, selected));
    }
    if (mod && key === "d") {
      e.preventDefault();
      const copy = duplicate(doc, selected);
      commit(copy.doc);
      return setSelected(copy.ids);
    }
    if (mod && (key === "=" || key === "+")) return zoomBy(1.2);
    if (mod && key === "-") return zoomBy(1 / 1.2);
    if (e.shiftKey && key === "1") return fit();
    if (key === "backspace" || key === "delete") {
      e.preventDefault();
      if (selected.size) commit(removeAll(doc, selected));
      return setSelected(new Set());
    }
    if (key === "escape") {
      setSelected(new Set());
      setAdding(false);
      return setTool("select");
    }
    if (key === "enter" && selectedNodes.length === 1 && selectedNodes[0].type !== "item" && selectedNodes[0].type !== "ink") {
      e.preventDefault();
      return setEditing(selectedNodes[0].id);
    }
    if (key.startsWith("arrow") && selectedNodes.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const [dx, dy] = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key] ?? [0, 0];
      return commit(moveNodes(doc, selected, dx, dy));
    }
    if (!mod && !e.altKey) {
      const picked = TOOLS.find((t) => t.key === key);
      if (picked) return setTool(picked.tool);
      if (key === "i") return setAdding(true);
    }
  };

  // ── rendering ────────────────────────────────────────────────────────────
  if (error) return <p className="kx-note-page-error">{error}</p>;
  const chrome = {
    "--cv-selection": CHROME.selection,
    "--cv-selection-fill": CHROME.selectionFill,
    "--cv-guide": CHROME.guide,
    "--cv-handle": CHROME.handle,
    "--cv-preview": CHROME.connectorPreview,
    "--cv-grid": CHROME.grid,
    "--cv-zoom": view.zoom,
    backgroundPosition: `${view.x}px ${view.y}px`,
    backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
  } as CSSProperties;
  const single = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : null;
  const grouped = selectedNodes.some((n) => n.group);
  const connectTo = draft.connect && (draft.connect.target ? nodeById.get(draft.connect.target) : undefined);

  return (
    <div
      ref={root}
      className="kx-canvas"
      data-tool={space ? "hand" : tool}
      data-panning={gesture.current?.kind === "pan" || undefined}
      data-dropping={dropping || undefined}
      tabIndex={0}
      aria-label="Canvas"
      style={chrome}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (e.key !== " ") return;
        setSpace(false);
        const only = selected.size === 1 ? nodeById.get([...selected][0]) : undefined;
        if (!spacePanned.current && only?.type === "item") quickLook(only.ref);
      }}
      onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={onDrop}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".kx-canvas-chrome, textarea, input")) return;
        // Pointer capture sends the click to the canvas itself; find the card under it.
        const id = nodeAt(document.elementFromPoint(e.clientX, e.clientY));
        const node = id ? nodeById.get(id) : undefined;
        if (!node) return addText(worldPoint(e));
        if (node.type === "item") openItem(invoke, workspaceId, node.ref, live.get(node.id)?.title ?? node.title, e.altKey ? "split" : "tab");
        else if (node.type !== "ink") setEditing(node.id);
      }}
    >
      <div className="kx-canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="kx-canvas-svg" width="1" height="1" aria-hidden="true">
          {doc.edges.map((edge) => {
            const from = nodeById.get(edge.from.node);
            const to = nodeById.get(edge.to.node);
            if (!from || !to) return null;
            const ends = edgeEnds(from, to);
            const stroke = contentColor(edge.color, theme);
            const mid: Point = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
            return (
              <g key={edge.id} data-edge={edge.id} className="kx-canvas-edge" aria-selected={selected.has(edge.id)}>
                <path className="kx-canvas-edge-hit" d={edgePath(ends)} />
                <path d={edgePath(ends)} stroke={stroke} fill="none" strokeWidth={2} />
                <path d={arrowHead(mid, ends[1])} stroke={stroke} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}
          {draft.connect && nodeById.get(draft.connect.from) && (
            <path
              className="kx-canvas-preview"
              d={edgePath(connectTo ? edgeEnds(nodeById.get(draft.connect.from)!, connectTo) : [edgeEnds(nodeById.get(draft.connect.from)!, { x: draft.connect.to[0], y: draft.connect.to[1], w: 0, h: 0 })[0], draft.connect.to])}
            />
          )}
          {draft.ink && <path d={inkPath(draft.ink)} stroke={contentColor(color, theme)} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
          {guides.map((g, i) =>
            g.axis === "x" ? (
              <line key={i} className="kx-canvas-guide" x1={g.at} x2={g.at} y1={g.from - 12} y2={g.to + 12} />
            ) : (
              <line key={i} className="kx-canvas-guide" y1={g.at} y2={g.at} x1={g.from - 12} x2={g.to + 12} />
            ),
          )}
        </svg>

        {doc.nodes.map((node) => (
          <div
            key={node.id}
            data-node={node.id}
            data-type={node.type}
            className="kx-canvas-node"
            aria-selected={selected.has(node.id)}
            data-target={draft.connect?.target === node.id || undefined}
            style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
          >
            {node.type === "item" && <ItemCard node={node} live={live.get(node.id)} invoke={invoke} workspaceId={workspaceId} theme={theme} sources={sources} onContent={fitting.current.has(node.id) ? (h) => fitCard(node.id, h) : undefined} />}
            {node.type === "text" && (
              <TextBody
                value={node.text}
                editing={editing === node.id}
                color={contentColor(node.color, theme)}
                onStart={() => history.current.push(docRef.current)}
                onChange={(text) => {
                  preview(updateNode(docRef.current, node.id, { text }));
                  scheduleSave();
                }}
                onDone={(text) => {
                  setEditing(null);
                  if (!text.trim()) {
                    preview(removeAll(docRef.current, new Set([node.id])));
                    scheduleSave();
                  }
                }}
                onSize={(h) => h > node.h && preview(updateNode(docRef.current, node.id, { h }))}
              />
            )}
            {node.type === "shape" && (
              <>
                <svg className="kx-canvas-shape" viewBox={`0 0 ${node.w} ${node.h}`} preserveAspectRatio="none" aria-hidden="true">
                  {shapeOutline(node.shape, node.w, node.h, contentColor(node.color, theme))}
                </svg>
                <TextBody
                  value={node.text}
                  editing={editing === node.id}
                  centered
                  color={contentColor("ink", theme)}
                  onStart={() => history.current.push(docRef.current)}
                  onChange={(text) => {
                    preview(updateNode(docRef.current, node.id, { text }));
                    scheduleSave();
                  }}
                  onDone={() => setEditing(null)}
                />
              </>
            )}
            {node.type === "ink" && (
              <svg className="kx-canvas-ink" viewBox={`0 0 ${node.vw} ${node.vh}`} preserveAspectRatio="none" aria-hidden="true">
                <path d={inkPath(node.points)} stroke={contentColor(node.color, theme)} strokeWidth={node.width} fill="none" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
            {single?.id === node.id && <span className="kx-canvas-handle" data-handle="se" aria-hidden="true" />}
          </div>
        ))}

        {draft.shape && <div className="kx-canvas-draft" data-shape={tool} style={rectStyle(draft.shape)} />}
        {marquee && <div className="kx-canvas-marquee" style={rectStyle(marquee)} />}
        {selectedEdges.length === 1 && selectedNodes.length === 0 && (
          <EdgeLabel
            edge={selectedEdges[0]}
            nodes={nodeById}
            onCommit={(label) => commit({ ...docRef.current, edges: docRef.current.edges.map((e) => (e.id === selectedEdges[0].id ? { ...e, label: label || undefined } : e)) })}
          />
        )}
        {doc.edges
          .filter((edge) => edge.label && !(selectedEdges.length === 1 && selectedEdges[0].id === edge.id))
          .map((edge) => {
            const from = nodeById.get(edge.from.node);
            const to = nodeById.get(edge.to.node);
            if (!from || !to) return null;
            const [a, b] = edgeEnds(from, to);
            return (
              <span key={edge.id} className="kx-canvas-edge-label" style={{ left: (a[0] + b[0]) / 2, top: (a[1] + b[1]) / 2 }}>
                {edge.label}
              </span>
            );
          })}
      </div>

      <header className="kx-canvas-chrome kx-canvas-head">
        <Icon name="canvas" size={14} />
        <input className="kx-canvas-title" aria-label="Canvas title" placeholder="Untitled canvas" value={title} onChange={(e) => rename(e.target.value)} />
        <span className="kx-note-saved" aria-live="polite">
          {saved === "saving" ? "Saving…" : "Saved"}
        </span>
        <button
          className="kx-icon-button"
          title="Delete canvas"
          aria-label="Delete canvas"
          onClick={async () => {
            if (!window.confirm("Delete this canvas? Links from it are removed. This cannot be undone.")) return;
            await invoke("store_canvas_delete", { id: canvasId }, workspaceId);
            canvasesChanged();
            setError("This canvas was deleted.");
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </header>

      <div className="kx-canvas-chrome kx-canvas-toolbar" role="toolbar" aria-label="Canvas tools">
        {TOOLS.map((t) => (
          <button key={t.tool} aria-pressed={tool === t.tool} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label} onClick={() => setTool(t.tool)}>
            <Icon name={t.icon} size={15} />
          </button>
        ))}
        <span className="kx-canvas-sep" />
        <button aria-pressed={adding} title="Add a note, source, highlight or canvas (I)" aria-label="Add item" onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={15} />
        </button>
        <span className="kx-canvas-sep" />
        <div className="kx-canvas-colors" role="group" aria-label="Colour">
          {CONTENT_COLORS.map((key) => (
            <button key={key} aria-label={key} title={key} aria-pressed={color === key} onClick={() => setSelectionColor(key)}>
              <span style={{ background: contentColor(key, theme) }} />
            </button>
          ))}
        </div>
        <span className="kx-canvas-sep" />
        <button title={grouped ? "Ungroup (⇧⌘G)" : "Group (⌘G)"} aria-label={grouped ? "Ungroup" : "Group"} disabled={selectedNodes.length < 2 && !grouped} onClick={() => commit(grouped ? ungroup(doc, selected) : group(doc, selected))}>
          <Icon name="group" size={15} />
        </button>
        <button title="Undo (⌘Z)" aria-label="Undo" disabled={!history.current.canUndo} onClick={undo}>
          <Icon name="undo" size={15} />
        </button>
        <button title="Redo (⇧⌘Z)" aria-label="Redo" disabled={!history.current.canRedo} onClick={redo}>
          <Icon name="redo" size={15} />
        </button>
      </div>

      <div className="kx-canvas-chrome kx-canvas-zoom" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <Icon name="minus" size={13} />
        </button>
        <button className="kx-canvas-zoom-value" title="Fit (⇧1)" onClick={fit}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
          <Icon name="plus" size={13} />
        </button>
      </div>

      {adding && <AddItem invoke={invoke} workspaceId={workspaceId} exclude={canvasId} onPick={addItem} onClose={() => setAdding(false)} />}
      {loaded && !doc.nodes.length && (
        <p className="kx-canvas-empty">Drag in notes, sources, pages or files, add them with +, draw with P, or double-click to write.</p>
      )}
    </div>
  );
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}
const rectStyle = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

function shapeOutline(shape: "rect" | "ellipse" | "diamond", w: number, h: number, stroke: string) {
  const fill = `color-mix(in srgb, ${stroke} 12%, transparent)`;
  const common = { stroke, fill, strokeWidth: 2, vectorEffect: "non-scaling-stroke" as const };
  if (shape === "ellipse") return <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 1} ry={h / 2 - 1} {...common} />;
  if (shape === "diamond") return <path d={`M${w / 2},1 L${w - 1},${h / 2} L${w / 2},${h - 1} L1,${h / 2} Z`} {...common} />;
  return <rect x={1} y={1} width={w - 2} height={h - 2} rx={10} {...common} />;
}

function TextBody({
  value,
  editing,
  centered,
  color,
  onStart,
  onChange,
  onDone,
  onSize,
}: {
  value: string;
  editing: boolean;
  centered?: boolean;
  color: string;
  onStart: () => void;
  onChange: (text: string) => void;
  onDone: (text: string) => void;
  onSize?: (height: number) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  useEffect(() => {
    if (!editing) return;
    onStart();
    area.current?.focus();
    area.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const style = { color } as CSSProperties;
  if (!editing) return <div className="kx-canvas-text" data-centered={centered || undefined} style={style}>{value}</div>;
  return (
    <textarea
      ref={area}
      className="kx-canvas-text"
      data-centered={centered || undefined}
      aria-label="Text"
      style={style}
      value={text}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
        onSize?.(e.target.scrollHeight);
      }}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) area.current?.blur();
      }}
    />
  );
}

function EdgeLabel({ edge, nodes, onCommit }: { edge: CanvasEdge; nodes: Map<string, CanvasNode>; onCommit: (label: string) => void }) {
  const [value, setValue] = useState(edge.label ?? "");
  useEffect(() => setValue(edge.label ?? ""), [edge.id, edge.label]);
  const from = nodes.get(edge.from.node);
  const to = nodes.get(edge.to.node);
  if (!from || !to) return null;
  const [a, b] = edgeEnds(from, to);
  return (
    <input
      className="kx-canvas-chrome kx-canvas-edge-input"
      aria-label="Connector label"
      placeholder="Label"
      style={{ left: (a[0] + b[0]) / 2, top: (a[1] + b[1]) / 2 }}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== (edge.label ?? "") && onCommit(value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/**
 * A note, page, source, highlight or canvas as a card. The title follows the item by id;
 * notes and pages show their whole text rendered (scroll a selected card to read on),
 * sources their details, abstract and a preview of the file.
 */
function ItemCard({
  node,
  live,
  invoke,
  workspaceId,
  theme,
  sources,
  onContent,
}: {
  node: ItemNode;
  live?: LinkEnd;
  invoke: Invoke;
  workspaceId: string;
  theme: Theme;
  sources: ReturnType<typeof noteSources>;
  /** Called once the content has loaded, with the height the card needs to show all of it. */
  onContent?: (height: number) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [markdown, setMarkdown] = useState<string>();
  const [abstract, setAbstract] = useState<string>();
  const [meta, setMeta] = useState<string>();
  const [preview, setPreview] = useState<string | null>(null);
  const highlight = node.ref.anchor?.startsWith("highlight:");
  const { kind, id } = node.ref;
  useEffect(() => {
    let current = true;
    const loadNote = () =>
      void invoke<Note | null>("store_note", { id }, workspaceId)
        .then((note) => current && (setMarkdown(note?.body ?? ""), setLoaded(true)))
        .catch(() => {});
    if (kind === "note") loadNote();
    if (kind === "record")
      void invoke<{ kind: string; body: string } | null>("workspace_record", { id }, workspaceId)
        .then((record) => current && (setMarkdown(record && record.kind !== "database" ? record.body : ""), setLoaded(true)))
        .catch(() => {});
    if (kind === "source" && !highlight)
      void invoke<Source | null>("store_source", { id }, workspaceId)
        .then((source) => {
          if (!current || !source) return;
          setMeta([shortCreators(source.creators), source.year, source.containerShort || source.containerTitle].filter(Boolean).join(" · "));
          setAbstract(source.abstract || (source.kind === "web" && source.url !== source.title ? source.url : undefined));
          if (source.filePath && PREVIEW_KINDS.has(source.kind))
            void libraryBridge()
              .thumbnail(source.filePath, 560)
              .then((url) => current && setPreview(url))
              .catch(() => {})
              .finally(() => current && setLoaded(true));
          else setLoaded(true);
        })
        .catch(() => {});
    const onSaved = (e: Event) => kind === "note" && (e as CustomEvent<string>).detail === id && loadNote();
    window.addEventListener("key:note-saved", onSaved);
    return () => {
      current = false;
      window.removeEventListener("key:note-saved", onSaved);
    };
  }, [invoke, workspaceId, kind, id, highlight, live?.title]);
  // Highlights and canvases have nothing to load.
  useEffect(() => {
    if (highlight || kind === "canvas") setLoaded(true);
  }, [highlight, kind]);
  useEffect(() => {
    const el = card.current;
    if (!loaded || !onContent || !el) return;
    // After the editor and any preview image have laid out.
    const measure = () => {
      // Where the content ends, in the card's own (unscaled) units, plus its padding and border.
      const body = el.querySelector<HTMLElement>(".kx-canvas-card-body");
      const inner = body?.firstElementChild as HTMLElement | null | undefined;
      const last = [...el.children].filter((c) => !c.classList.contains("kx-canvas-card-bar")).at(-1) as HTMLElement | undefined;
      const bottom = body && inner ? body.offsetTop + inner.offsetHeight : last ? last.offsetTop + last.offsetHeight : 0;
      onContent(bottom + 12);
    };
    const image = el.querySelector("img");
    if (image && !image.complete) image.addEventListener("load", measure, { once: true });
    else requestAnimationFrame(measure);
  }, [loaded, onContent, preview]);
  const missing = live ? !live.exists : false;
  const title = highlight ? (live?.anchorLabel ?? node.title) : (live?.title ?? node.title);
  const icon: IconName = highlight ? "quote" : kind === "source" ? (SOURCE_ICON[live?.detail ?? node.detail ?? ""] ?? "doc") : ITEM_ICON[kind];
  const kindLabel = highlight ? `Highlight · ${live?.title ?? node.detail ?? ""}` : kind === "source" ? "Source" : kind === "note" ? "Note" : kind === "canvas" ? "Canvas" : "Page";
  return (
    <div ref={card} className="kx-canvas-card" data-kind={highlight ? "highlight" : kind} data-missing={missing || undefined}>
      {highlight && <span className="kx-canvas-card-bar" style={{ background: highlightColor(node.color, theme) }} />}
      <div className="kx-canvas-card-kind">
        <Icon name={icon} size={12} />
        <span>{missing ? "Missing — deleted" : kindLabel}</span>
      </div>
      {title && <div className="kx-canvas-card-title">{title}</div>}
      {meta && <div className="kx-canvas-card-meta">{meta}</div>}
      {preview && <img className="kx-canvas-card-preview" src={preview} alt="" draggable={false} />}
      {(markdown || abstract) && (
        <div className="kx-canvas-card-body">
          {markdown !== undefined ? (
            <NoteEditor
              readOnly
              compact
              value={markdown}
              onChange={() => {}}
              searchSources={sources.searchSources}
              resolveSource={sources.resolveSource}
              onOpenSource={sources.onOpenSource}
              media={sources.media}
              searchItems={sources.searchItems}
              onOpenItem={sources.onOpenItem}
              className="kx-canvas-card-note"
            />
          ) : (
            <p className="kx-canvas-card-excerpt">{abstract}</p>
          )}
        </div>
      )}
    </div>
  );
}

function AddItem({ invoke, workspaceId, exclude, onPick, onClose }: { invoke: Invoke; workspaceId: string; exclude: string; onPick: (t: LinkTarget) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LinkTarget[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () =>
        void linkTargets(invoke, workspaceId, query, undefined, 8)
          .then((found) => {
            if (!current) return;
            setResults(found.filter((t) => !(t.kind === "canvas" && t.id === exclude)));
            setIndex(0);
          })
          .catch(() => {}),
      query ? 120 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [invoke, workspaceId, query, exclude]);
  return (
    <div className="kx-canvas-chrome kx-canvas-add" role="dialog" aria-label="Add to canvas">
      <input
        autoFocus
        aria-label="Search items"
        placeholder="Search notes, sources, highlights, canvases"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") setIndex((i) => Math.min(results.length - 1, i + 1));
          else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
          else if (e.key === "Enter" && results[index]) onPick(results[index]);
        }}
      />
      <ul role="listbox">
        {results.map((t, i) => {
          const highlight = t.anchor?.startsWith("highlight:");
          return (
            <li key={`${t.kind}:${t.id}:${t.anchor ?? ""}`}>
              <button role="option" aria-selected={i === index} onMouseMove={() => setIndex(i)} onClick={() => onPick(t)}>
                <Icon name={highlight ? "quote" : t.kind === "source" ? (SOURCE_ICON[t.detail ?? ""] ?? "doc") : ITEM_ICON[t.kind]} size={14} />
                <span>
                  <span className="kx-canvas-add-title">{t.title}</span>
                  <span className="kx-canvas-add-hint">{highlight ? t.context : t.kind === "source" ? "Source" : t.kind === "note" ? "Note" : "Canvas"}</span>
                </span>
              </button>
            </li>
          );
        })}
        {!results.length && <li className="kx-canvas-add-empty">{query ? "Nothing matches" : "Nothing in this workspace yet"}</li>}
      </ul>
    </div>
  );
}
