// The same affordances for an item wherever it appears: a preview on hover, a menu on
// right-click, a larger preview on Space, and toasts that can undo. Any element marked
// with `itemAttrs()` (or a key:// link in a note) takes part; App mounts `ItemLayer` once.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { coverBackground, readAppearance } from "./page-appearance";
import { GlobalDialog } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import {
  copyCitation,
  copyItemLink,
  describeItem,
  onToast,
  openItemAt,
  shellContext,
  type ItemInfo,
  type Toast,
} from "./item-actions";
import { itemLinks } from "./item-links";
import { bridge, type Invoke } from "./library-api";
import NoteEditor, { itemFromHref, itemHref, setEmbedRenderer, type DraggedItem, type ItemLink } from "./note-editor";
import { noteSources } from "./note-sources";
import { currentTheme, highlightColor } from "./canvas/canvas-colors";
import "./item-ui.css";

/** Marks an element as showing `item`: hover previews it, right-click offers its actions. */
export function itemAttrs(item: ItemLink & { title?: string }) {
  return { "data-item": itemHref(item), "data-item-title": item.title || undefined };
}

/** The item an element shows, from `itemAttrs` or a key:// link. */
function itemAt(target: EventTarget | null): { el: HTMLElement; item: ItemLink; title?: string } | undefined {
  const el = (target as Element | null)?.closest?.<HTMLElement>("[data-item], a[href^='key://']");
  if (!el) return undefined;
  const item = itemFromHref(el.getAttribute("data-item") ?? el.getAttribute("href"));
  return item ? { el, item, title: el.getAttribute("data-item-title") ?? el.textContent?.trim() ?? undefined } : undefined;
}

// ── Selection shared with the inspector and commands ─────────────────────────

export interface Selected extends DraggedItem {}
type SelectionListener = (items: Selected[]) => void;
const selectionListeners = new Set<SelectionListener>();
let selection: Selected[] = [];
/** Views report what is selected in them; the inspector and ⌘K act on it. */
export function selectItems(items: Selected[]) {
  const same = items.length === selection.length && items.every((item, i) => itemHref(item) === itemHref(selection[i]));
  if (same) return;
  selection = items;
  selectionListeners.forEach((listener) => listener(items));
}
export const selectedItems = () => selection;
export function useSelectedItems() {
  const [items, setItems] = useState(selection);
  useEffect(() => {
    selectionListeners.add(setItems);
    return () => {
      selectionListeners.delete(setItems);
    };
  }, []);
  return items;
}

// ── The preview body (hover card, quick look, inspector) ─────────────────────

export function useItemInfo(invoke: Invoke | undefined, workspaceId: string | undefined, item: ItemLink | undefined) {
  const [info, setInfo] = useState<ItemInfo>();
  const href = item && itemHref(item);
  useEffect(() => {
    setInfo(undefined);
    if (!invoke || !workspaceId || !item) return;
    let current = true;
    const load = () => void describeItem(invoke, workspaceId, item).then((found) => current && setInfo(found));
    load();
    const reload = () => setTimeout(load, 50);
    window.addEventListener("key:note-saved", reload);
    const stop = bridge().on("annotations-changed", reload);
    return () => {
      current = false;
      window.removeEventListener("key:note-saved", reload);
      stop();
    };
  }, [invoke, workspaceId, href]);
  return info;
}

function Thumbnail({ path, size }: { path?: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!path) return;
    let current = true;
    void bridge()
      .thumbnail(path, size)
      .then((url) => current && setSrc(url))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [path, size]);
  return src ? <img className="kx-item-thumb" src={src} alt="" draggable={false} /> : null;
}

/** A canvas in miniature: its objects as boxes. */
export function CanvasMinimap({ nodes }: { nodes: NonNullable<ItemInfo["canvas"]>["nodes"] }) {
  if (!nodes.length) return <p className="kx-item-empty">An empty canvas</p>;
  const minX = Math.min(...nodes.map((n) => n.x)),
    minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w)),
    maxY = Math.max(...nodes.map((n) => n.y + n.h));
  const pad = 20;
  return (
    <svg className="kx-item-minimap" viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`} preserveAspectRatio="xMidYMid meet">
      {nodes.map((n, i) => (
        <rect key={i} x={n.x} y={n.y} width={n.w} height={n.h} rx={8} data-type={n.type} />
      ))}
    </svg>
  );
}

export function HighlightQuote({ text, color, comment }: { text?: string; color?: string; comment?: string }) {
  return (
    <figure className="kx-item-quote" style={{ "--kx-quote-color": highlightColor(color, currentTheme()) } as CSSProperties}>
      <blockquote>{text || "Highlight"}</blockquote>
      {comment && <figcaption>{comment}</figcaption>}
    </figure>
  );
}

/** What an item shows of itself: a note's text, a source's preview and abstract, a highlight's words. */
export function ItemBody({ info, invoke, workspaceId, size = "card" }: { info: ItemInfo; invoke: Invoke; workspaceId: string; size?: "card" | "large" }) {
  const sources = noteSourcesFor(invoke, workspaceId);
  if (!info.exists) return <p className="kx-item-empty">It may have been deleted.</p>;
  if (info.highlight) return <HighlightQuote text={info.highlight.text} color={info.highlight.color} comment={info.highlight.comment} />;
  if (info.body !== undefined)
    return info.body.trim() ? (
      <div className="kx-item-note">
        <NoteEditor
          value={info.body}
          onChange={() => {}}
          readOnly
          compact={size === "card"}
          searchSources={sources.searchSources}
          resolveSource={sources.resolveSource}
          onOpenSource={sources.onOpenSource}
          media={sources.media}
          searchItems={sources.searchItems}
          searchItemsMore={sources.searchItemsMore}
          citeLabel={sources.citeLabel}
          onOpenItem={sources.onOpenItem}
        />
      </div>
    ) : (
      <p className="kx-item-empty">Empty</p>
    );
  if (info.canvas) return <CanvasMinimap nodes={info.canvas.nodes} />;
  if (info.source)
    return (
      <div className="kx-item-source">
        {info.source.filePath && <Thumbnail path={info.source.filePath} size={size === "large" ? 720 : 360} />}
        {info.summary && <p className="kx-item-summary">{info.summary}</p>}
        {!info.summary && info.source.url && <p className="kx-item-summary">{info.source.url}</p>}
      </div>
    );
  return null;
}
const sourcesCache = new Map<string, ReturnType<typeof noteSources>>();
function noteSourcesFor(invoke: Invoke, workspaceId: string) {
  if (!sourcesCache.has(workspaceId)) sourcesCache.set(workspaceId, noteSources(invoke, workspaceId));
  return sourcesCache.get(workspaceId)!;
}

export function ItemHeader({ info, children }: { info: ItemInfo; children?: ReactNode }) {
  // A page's own icon and cover colour, when it has them.
  const look = readAppearance(info.note?.appearance ?? info.source?.appearance);
  const cover = look.cover?.kind === "image" ? undefined : coverBackground(look.cover);
  return (
    <header className="kx-item-head">
      {cover && <span className="kx-item-cover" style={{ background: cover }} aria-hidden />}
      <span className="kx-item-kind" data-kind={info.item.kind}>
        {look.icon ? <span className="kx-item-emoji">{look.icon}</span> : <Icon name={info.icon} size={13} />}
        {info.kindLabel}
      </span>
      <strong className="kx-item-title">{info.title}</strong>
      {info.subtitle && <span className="kx-item-subtitle">{info.subtitle}</span>}
      {children}
    </header>
  );
}

function UsedIn({ invoke, workspaceId, item }: { invoke: Invoke; workspaceId: string; item: ItemLink }) {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    let current = true;
    void itemLinks(invoke, workspaceId, { kind: item.kind, id: item.id })
      .then((links) => current && setCount(new Set(links.backlinks.map((l) => `${l.from.kind}:${l.from.id}`)).size))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [invoke, workspaceId, item.kind, item.id]);
  if (!count) return null;
  return <span>Used in {count === 1 ? "1 place" : `${count} places`}</span>;
}

// ── Embeds in notes ──────────────────────────────────────────────────────────

/** An item embedded in a note: its header and, one level deep, its live content. */
function EmbedBody({ item, depth, label }: { item: ItemLink; depth: number; label: string }) {
  const { invoke, workspaceId } = shellContext();
  const info = useItemInfo(invoke, workspaceId, item);
  if (!invoke || !workspaceId) return null;
  return (
    <div className="kx-embed" data-kind={item.kind}>
      <div className="kx-embed-head">
        <Icon name={info?.icon ?? "doc"} size={13} />
        <span className="kx-embed-title">{info?.title ?? label}</span>
        {info?.subtitle && <span className="kx-embed-sub">{info.subtitle}</span>}
        <button
          type="button"
          className="kx-embed-open"
          title="Open (⌥-click: beside)"
          aria-label="Open embedded item"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => openItemAt(item, e.altKey ? "split" : "here", info?.title)}
        >
          <Icon name="external" size={13} />
        </button>
      </div>
      {info && depth < 2 && (
        <div className="kx-embed-body">
          <ItemBody info={info} invoke={invoke} workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}
setEmbedRenderer((item, depth, label) => <EmbedBody item={item} depth={depth} label={label} />);

// ── Hover card ───────────────────────────────────────────────────────────────

const HOVER_DELAY = 550;

function placeNear(rect: DOMRect, box: HTMLElement | null): CSSProperties {
  if (!box) return { visibility: "hidden" };
  const w = box.offsetWidth,
    h = box.offsetHeight;
  const below = rect.bottom + 8 + h < window.innerHeight - 8;
  const top = below ? rect.bottom + 8 : Math.max(8, rect.top - 8 - h);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  return { top, left };
}

function HoverCard({ target, onEnter, onLeave }: { target: { rect: DOMRect; item: ItemLink }; onEnter: () => void; onLeave: () => void }) {
  const { invoke, workspaceId } = shellContext();
  const info = useItemInfo(invoke, workspaceId, target.item);
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => setStyle(placeNear(target.rect, box.current)), [target.rect, info]);
  if (!invoke || !workspaceId) return null;
  return (
    <div ref={box} className="kx-hover-card" style={style} role="tooltip" onPointerEnter={onEnter} onPointerLeave={onLeave}>
      {info ? (
        <>
          <ItemHeader info={info} />
          <div className="kx-hover-body">
            <ItemBody info={info} invoke={invoke} workspaceId={workspaceId} />
          </div>
          <footer className="kx-item-foot">
            <UsedIn invoke={invoke} workspaceId={workspaceId} item={target.item} />
            <span className="kx-item-keys">Space to preview · ⌥-click opens beside</span>
          </footer>
        </>
      ) : (
        <div className="kx-skeleton-line" />
      )}
    </div>
  );
}

// ── Context menu ─────────────────────────────────────────────────────────────

export interface MenuEntry {
  label: string;
  icon?: IconName;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
}
type MenuRequest = { x: number; y: number; entries: (MenuEntry | "-")[] };
const menuListeners = new Set<(request: MenuRequest | undefined) => void>();
/** Shows a menu of actions at a point (views add their own entries to an item's). */
export function showMenu(request: MenuRequest) {
  menuListeners.forEach((listener) => listener(request));
}

/** The actions every item has; `extra` comes first (a view's own, like Remove from canvas). */
export function itemMenuEntries(items: { item: ItemLink; title: string }[], extra: (MenuEntry | "-")[] = []): (MenuEntry | "-")[] {
  const { invoke, workspaceId } = shellContext();
  const first = items[0];
  const sourceLike = items.some(({ item }) => item.kind === "source");
  const asDragged = items.map(({ item, title }) => ({ ...item, title }));
  return [
    ...extra,
    ...(extra.length ? ["-" as const] : []),
    { label: "Open", icon: "arrowRight", shortcut: "↩", run: () => openItemAt(first.item, "tab", first.title) },
    { label: "Open beside", icon: "split", shortcut: "⌥↩", run: () => openItemAt(first.item, "split", first.title) },
    { label: "Quick look", icon: "search", shortcut: "Space", run: () => quickLook(first.item) },
    "-",
    { label: items.length > 1 ? `Copy ${items.length} links` : "Copy link", icon: "link", shortcut: "⌘L", run: () => void copyItemLink(items) },
    { label: "Copy citation", icon: "quote", shortcut: "⌘⇧C", disabled: !sourceLike, run: () => invoke && workspaceId && void copyCitation(invoke, workspaceId, items.map((i) => i.item)) },
    "-",
    { label: "Send to canvas or note…", icon: "canvas", shortcut: "⌘⇧S", run: () => sendTo(asDragged) },
    { label: "Show in inspector", icon: "panelRight", shortcut: "⌘⇧I", run: () => showInInspector(asDragged) },
  ];
}

function ContextMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const [index, setIndex] = useState(-1);
  const entries = request.entries;
  const actionable = entries.map((e, i) => (e !== "-" && !e.disabled ? i : -1)).filter((i) => i >= 0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setStyle({
      left: Math.min(request.x, window.innerWidth - el.offsetWidth - 8),
      top: Math.min(request.y, window.innerHeight - el.offsetHeight - 8),
    });
    el.focus();
  }, [request]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof PointerEvent && box.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  const run = (entry: MenuEntry) => {
    onClose();
    entry.run();
  };
  return (
    <div
      ref={box}
      className="kx-context-menu"
      role="menu"
      tabIndex={-1}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const at = actionable.indexOf(index);
          const next = e.key === "ArrowDown" ? actionable[(at + 1) % actionable.length] : actionable[(at - 1 + actionable.length) % actionable.length];
          setIndex(next ?? -1);
        } else if (e.key === "Enter" && index >= 0) run(entries[index] as MenuEntry);
      }}
    >
      {entries.map((entry, i) =>
        entry === "-" ? (
          <hr key={i} />
        ) : (
          <button key={i} role="menuitem" disabled={entry.disabled} data-active={i === index || undefined} onPointerEnter={() => setIndex(i)} onClick={() => run(entry)}>
            {entry.icon ? <Icon name={entry.icon} size={14} /> : <span />}
            <span>{entry.label}</span>
            {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

// ── Quick look ───────────────────────────────────────────────────────────────

const lookListeners = new Set<(item: ItemLink | undefined) => void>();
export function quickLook(item: ItemLink) {
  lookListeners.forEach((listener) => listener(item));
}

function QuickLook({ item, onClose }: { item: ItemLink; onClose: () => void }) {
  const { invoke, workspaceId } = shellContext();
  const info = useItemInfo(invoke, workspaceId, item);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onClose();
        openItemAt(item, e.altKey ? "split" : "tab", info?.title);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [item, info?.title, onClose]);
  if (!invoke || !workspaceId) return null;
  return (
    <GlobalDialog label="Quick look" onClose={onClose}>
      <div className="kx-quick-look">
        {info ? (
          <>
            <ItemHeader info={info}>
              <span className="kx-quick-look-actions">
                <button onClick={() => (onClose(), openItemAt(item, "split", info.title))}>
                  <Icon name="split" size={13} /> Open beside
                </button>
                <button className="kx-primary" onClick={() => (onClose(), openItemAt(item, "tab", info.title))}>
                  Open <kbd>↩</kbd>
                </button>
              </span>
            </ItemHeader>
            <div className="kx-quick-look-body">
              <ItemBody info={info} invoke={invoke} workspaceId={workspaceId} size="large" />
            </div>
          </>
        ) : (
          <div className="kx-skeleton-line" />
        )}
      </div>
    </GlobalDialog>
  );
}

// ── Inspector and send-to requests (handled by App) ──────────────────────────

const inspectListeners = new Set<(items: DraggedItem[]) => void>();
export function showInInspector(items: DraggedItem[]) {
  selectItems(items);
  inspectListeners.forEach((listener) => listener(items));
}
export function onShowInInspector(listener: (items: DraggedItem[]) => void) {
  inspectListeners.add(listener);
  return () => {
    inspectListeners.delete(listener);
  };
}
const sendListeners = new Set<(items: DraggedItem[]) => void>();
/** Opens the Send to… picker for items. */
export function sendTo(items: DraggedItem[]) {
  if (items.length) sendListeners.forEach((listener) => listener(items));
}
export function onSendTo(listener: (items: DraggedItem[]) => void) {
  sendListeners.add(listener);
  return () => {
    sendListeners.delete(listener);
  };
}

// ── Toasts ───────────────────────────────────────────────────────────────────

function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(
    () =>
      onToast((next) => {
        setToasts((list) => [...list.slice(-2), next]);
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== next.id)), next.undo ? 6000 : 2600);
      }),
    [],
  );
  if (!toasts.length) return null;
  return (
    <div className="kx-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="kx-toast">
          <span>{t.message}</span>
          {t.undo && (
            <button
              onClick={() => {
                t.undo!();
                setToasts((list) => list.filter((x) => x.id !== t.id));
              }}
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── The layer ────────────────────────────────────────────────────────────────

const typing = (el: Element | null) => !!el?.closest?.("input, textarea, select, [contenteditable='true']");

/** Hover previews, item menus, quick look and toasts for the whole window. */
export function ItemLayer() {
  const [hover, setHover] = useState<{ rect: DOMRect; item: ItemLink }>();
  const [menu, setMenu] = useState<MenuRequest>();
  const [look, setLook] = useState<ItemLink>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pointed = useRef<ItemLink | undefined>(undefined);
  useEffect(() => {
    const listener = (request: MenuRequest | undefined) => setMenu(request);
    const looking = (item: ItemLink | undefined) => {
      setHover(undefined);
      setLook(item);
    };
    menuListeners.add(listener);
    lookListeners.add(looking);
    return () => {
      menuListeners.delete(listener);
      lookListeners.delete(looking);
    };
  }, []);
  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      setHover(undefined);
    };
    const over = (e: PointerEvent) => {
      const found = itemAt(e.target);
      if ((e.target as Element).closest?.(".kx-hover-card")) return clearTimeout(leave.current);
      pointed.current = found?.item;
      clearTimeout(timer.current);
      if (!found || e.buttons || found.el.closest("[data-no-preview]")) {
        clearTimeout(leave.current);
        leave.current = setTimeout(() => setHover(undefined), 180);
        return;
      }
      clearTimeout(leave.current);
      timer.current = setTimeout(() => {
        if (found.el.isConnected) setHover({ rect: found.el.getBoundingClientRect(), item: found.item });
      }, HOVER_DELAY);
    };
    const context = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const found = itemAt(e.target);
      if (!found || typing(found.el) && found.el.tagName !== "A") return;
      e.preventDefault();
      hide();
      // A row in a multiple selection acts for the selection.
      const chosen = selection.some((s) => itemHref(s) === itemHref(found.item)) && selection.length > 1 ? selection.map((s) => ({ item: s as ItemLink, title: s.title })) : [{ item: found.item, title: found.title ?? "Untitled" }];
      setMenu({ x: e.clientX, y: e.clientY, entries: itemMenuEntries(chosen) });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return;
      const target = pointed.current ?? (selection.length ? selection[0] : undefined);
      if (!target) return;
      e.preventDefault();
      setHover(undefined);
      setLook((open) => (open ? undefined : { kind: target.kind, id: target.id, anchor: target.anchor }));
    };
    const click = (e: MouseEvent) => {
      // ⌥-click on any item link opens it beside; ⌘-click in a new tab.
      if (!(e.altKey || e.metaKey) || e.button !== 0) return;
      const found = itemAt(e.target);
      if (!found || found.el.tagName !== "A") return;
      e.preventDefault();
      e.stopPropagation();
      openItemAt(found.item, e.altKey ? "split" : "tab", found.title);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("dragstart", hide, true);
    document.addEventListener("wheel", hide, { passive: true, capture: true });
    document.addEventListener("contextmenu", context);
    document.addEventListener("click", click, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("dragstart", hide, true);
      document.removeEventListener("wheel", hide, { capture: true });
      document.removeEventListener("contextmenu", context);
      document.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", hide);
    };
  }, []);
  return (
    <>
      {hover && !menu && !look && (
        <HoverCard
          target={hover}
          onEnter={() => clearTimeout(leave.current)}
          onLeave={() => {
            leave.current = setTimeout(() => setHover(undefined), 180);
          }}
        />
      )}
      {menu && <ContextMenu request={menu} onClose={() => setMenu(undefined)} />}
      {look && <QuickLook item={look} onClose={() => setLook(undefined)} />}
      <Toasts />
    </>
  );
}
