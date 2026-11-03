import { useCallback, useEffect, useReducer, useState } from "react";
import { CITATION_STYLES, inTextCitationFor, narrativeCitation, referenceEntry, type CitationStyle } from "./citation-styles";
import { bibtex } from "./citation";
import { ContextMenu } from "./DatabaseView";
import { Icon, type IconName } from "./icons";
import { openItemAt, sendToCanvas, sendToNote, toast } from "./item-actions";
import { itemAttrs } from "./item-ui";
import { setItemDrag, sourceItem } from "./item-links";
import { bridge, type Invoke, type Source, type SourcePage } from "./library-api";
import { SOURCE_DRAG_TYPE, onLibraryChanged } from "./library-nav";
import { editorTargetIn, itemHref, onEditorTargets } from "./note-editor";

/** What the focused pane shows, which decides each row's action. */
export interface ReferenceContext {
  viewId?: string;
  note?: { id: string; title: string };
  canvas?: { id: string; title: string };
}
type Sort = { field: "title" | "creator" | "year" | "added"; descending: boolean };
const SORTS: { field: Sort["field"]; label: string }[] = [
  { field: "creator", label: "Author" },
  { field: "title", label: "Title" },
  { field: "year", label: "Year" },
  { field: "added", label: "Date added" },
];
const SCOPES: { scope: string; label: string; count: keyof SourcePage["counts"] }[] = [
  { scope: "all", label: "All", count: "all" },
  { scope: "starred", label: "Starred", count: "starred" },
  { scope: "unfiled", label: "Unfiled", count: "unfiled" },
  { scope: "attention", label: "Needs attention", count: "attention" },
];
const LIMIT = 200;
const read = <T,>(key: string, fallback: T): T => {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "null") } as T;
  } catch {
    return fallback;
  }
};

/**
 * The sidebar's References: the library as a compact reference list (title, then
 * "Author et al. (Year)") with search, sort, a filter, the citation style, export and add.
 * Rows drag anywhere an item can go; hovering one offers what fits the focused pane:
 * Cite at the cursor of a note being written, Add to a canvas, or else Open.
 */
export default function ReferencesPanel({
  invoke,
  workspaceId,
  context,
  refreshKey,
  onOpenLibrary,
}: {
  invoke: Invoke;
  workspaceId?: string;
  /** Changes when the shell hears the library changed. */
  refreshKey?: number;
  context: ReferenceContext;
  onOpenLibrary: () => void;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem("key.sidebar.references") !== "closed");
  const [prefs, setPrefs] = useState(() => read("key.references", { sort: { field: "creator", descending: false } as Sort, scope: "all", style: "apa" as CitationStyle }));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<SourcePage>();
  const [menu, setMenu] = useState<{ kind: "sort" | "export" | "add"; x: number; y: number }>();
  // Editors register as they mount; the row action follows the one in the focused pane.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onEditorTargets(rerender), []);
  useEffect(() => {
    try {
      localStorage.setItem("key.sidebar.references", open ? "open" : "closed");
      localStorage.setItem("key.references", JSON.stringify(prefs));
    } catch {}
  }, [open, prefs]);

  const list = useCallback(
    (limit: number) =>
      invoke<SourcePage>("store_sources", { text: query.trim() || null, scope: prefs.scope, sort: prefs.sort.field, descending: prefs.sort.descending, limit }, workspaceId),
    [invoke, workspaceId, query, prefs.scope, prefs.sort.field, prefs.sort.descending],
  );
  useEffect(() => {
    if (!workspaceId || !open) return setPage(undefined);
    let current = true;
    let known: number | undefined;
    const load = () =>
      void list(LIMIT)
        .then((p) => {
          if (!current) return;
          known = p.counts.all;
          setPage(p);
        })
        .catch(() => current && setPage(undefined));
    const timer = window.setTimeout(load, query ? 150 : 0);
    const off = onLibraryChanged(load);
    // Sources added elsewhere (another window, an import, the agent) appear without a reload.
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      void list(1)
        .then((p) => current && known !== undefined && p.counts.all !== known && load())
        .catch(() => {});
    }, 4000);
    window.addEventListener("focus", load);
    return () => {
      current = false;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", load);
      off();
    };
  }, [list, workspaceId, open, query, refreshKey]);

  const style = prefs.style;
  const pane = context.viewId ? document.querySelector(`[data-content-view="${CSS.escape(context.viewId)}"]`) : null;
  const editor = editorTargetIn(pane);
  const action: { label: string; icon: IconName; run: (source: Source) => void } =
    editor || context.note
      ? {
          label: "Cite",
          icon: "quote",
          run: (source) => {
            const cite = inTextCitationFor(source, style);
            const undo = editor ? editor.insertLinks([{ text: cite, href: itemHref({ kind: "source", id: source.id }) }]) : null;
            if (undo) return toast(`Cited ${cite}`, undo);
            if (context.note && workspaceId)
              void sendToNote(invoke, workspaceId, context.note.id, [sourceItem(source)], "cite")
                .then((back) => toast(`Cited ${cite} in ${context.note!.title}`, back))
                .catch((e) => toast(String(e)));
          },
        }
      : context.canvas
        ? {
            label: "Add to canvas",
            icon: "canvas",
            run: (source) =>
              workspaceId &&
              void sendToCanvas(invoke, workspaceId, context.canvas!.id, [sourceItem(source)])
                .then((undo) => toast(`Added ${source.title || "the source"} to ${context.canvas!.title}`, undo))
                .catch((e) => toast(String(e))),
          }
        : { label: "Open", icon: "arrowRight", run: (source) => openItemAt(sourceItem(source), "tab", source.title || "Untitled") };

  const copy = async (what: string, plain: string, html?: string) => {
    try {
      const parts: Record<string, Blob> = { "text/plain": new Blob([plain], { type: "text/plain" }) };
      if (html) parts["text/html"] = new Blob([html], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem(parts)]);
    } catch {
      await navigator.clipboard.writeText(plain);
    }
    toast(`${what} copied`);
  };
  const exportAll = async (format: "bibliography" | "bibtex") => {
    const all = page && page.total > page.items.length ? (await list(page.total)).items : (page?.items ?? []);
    if (!all.length) return toast("No references to export");
    const sorted = format === "bibliography" ? [...all].sort((a, b) => referenceEntry(a, style).localeCompare(referenceEntry(b, style))) : all;
    if (format === "bibtex") return copy(`BibTeX for ${all.length} references`, sorted.map(bibtex).join("\n\n"));
    await copy(
      `${CITATION_STYLES.find((s) => s.id === style)?.label ?? "Reference"} list`,
      sorted.map((s) => referenceEntry(s, style)).join("\n\n"),
      sorted.map((s) => `<p>${referenceEntry(s, style, true)}</p>`).join(""),
    );
  };
  const at = (e: React.MouseEvent<HTMLElement>, kind: "sort" | "export" | "add") => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ kind, x: rect.left, y: rect.bottom + 4 });
  };

  const total = page?.counts.all ?? 0;
  const items = page?.items ?? [];
  return (
    <section className="kx-references" aria-label="References">
      <div className="kx-sidebar-group">
        <button className="kx-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevronRight" size={9} style={{ transform: open ? "rotate(90deg)" : undefined }} />
          <span>References</span>
          {!!total && <small>{total}</small>}
        </button>
        <button className="kx-group-text-button" disabled={!workspaceId} title="Copy the reference list or BibTeX" onClick={(e) => at(e, "export")}>
          <Icon name="upload" size={12} />
          <span>Export</span>
        </button>
      </div>
      {open && workspaceId && (
        <>
          <div className="kx-ref-search">
            <label>
              <Icon name="search" size={12} />
              <input type="search" aria-label="Search references" placeholder="Search references…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button className="kx-group-text-button" title="Add sources to the library" aria-label="Add references" onClick={(e) => at(e, "add")}>
              <Icon name="plus" size={12} />
              <span>Add</span>
            </button>
          </div>
          <div className="kx-ref-toolbar">
            <button
              aria-label={`Sort by ${SORTS.find((s) => s.field === prefs.sort.field)?.label}, ${prefs.sort.descending ? "descending" : "ascending"}`}
              title="Sort"
              onClick={(e) => at(e, "sort")}
            >
              <Icon name="sort" size={13} />
            </button>
            <SidebarSelect label="Show" value={prefs.scope} onChange={(scope) => setPrefs({ ...prefs, scope })} options={SCOPES.map((s) => [s.scope, `${s.label} ${page?.counts[s.count] ?? ""}`])} />
            <span />
            <SidebarSelect label="Citation style" value={style} onChange={(id) => setPrefs({ ...prefs, style: id as CitationStyle })} options={CITATION_STYLES.map((s) => [s.id, s.label])} />
          </div>
          <div className="kx-ref-list" role="list" aria-label="Reference list">
            {items.map((source) => {
              const item = sourceItem(source);
              const title = source.title || "Untitled";
              return (
                <div
                  key={source.id}
                  role="listitem"
                  className="kx-ref-row"
                  draggable
                  {...itemAttrs({ ...item, title })}
                  onDragStart={(e) => {
                    setItemDrag(e.dataTransfer, [item]);
                    e.dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify([source.id]));
                    // Dropped into another app, a reference is its citation.
                    e.dataTransfer.setData("text/plain", referenceEntry(source, style));
                  }}
                >
                  <button className="kx-ref-main" title={referenceEntry(source, style)} onClick={() => openItemAt(item, "tab", title)}>
                    <span className="kx-ref-title">{title}</span>
                    <span className="kx-ref-byline">{narrativeCitation(source, style)}</span>
                  </button>
                  <button className="kx-ref-action" data-action={action.label} title={`${action.label} · ${inTextCitationFor(source, style)}`} onClick={() => action.run(source)}>
                    <Icon name={action.icon} size={12} />
                    <span>{action.label}</span>
                  </button>
                </div>
              );
            })}
            {page && !items.length && <p className="key-sidebar-hint">{query ? "No matching references." : "No references yet. Add PDFs, links or a Zotero library."}</p>}
            {page && page.total > items.length && (
              <button className="kx-ref-more" onClick={onOpenLibrary}>
                Show all {page.total} in the library
              </button>
            )}
          </div>
        </>
      )}
      {menu && workspaceId && (
        <ContextMenu x={menu.x} y={menu.y} label={menu.kind === "sort" ? "Sort references" : menu.kind === "export" ? "Export references" : "Add references"} onClose={() => setMenu(undefined)}>
          {(close) => {
            const entry = (text: string, icon: IconName, run: () => void, checked?: boolean) => (
              <button
                key={text}
                role={checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={checked}
                onClick={() => {
                  close();
                  run();
                }}
              >
                <Icon name={checked ? "check" : icon} size={13} />
                {text}
              </button>
            );
            if (menu.kind === "sort")
              return [
                ...SORTS.map((s) => entry(s.label, "sort", () => setPrefs({ ...prefs, sort: { ...prefs.sort, field: s.field } }), prefs.sort.field === s.field)),
                <hr key="rule" />,
                entry("Ascending", "sort", () => setPrefs({ ...prefs, sort: { ...prefs.sort, descending: false } }), !prefs.sort.descending),
                entry("Descending", "sort", () => setPrefs({ ...prefs, sort: { ...prefs.sort, descending: true } }), prefs.sort.descending),
              ];
            if (menu.kind === "export")
              return [
                entry(`Copy ${CITATION_STYLES.find((s) => s.id === style)?.label ?? ""} reference list`, "copy", () => void exportAll("bibliography")),
                entry("Copy BibTeX", "copy", () => void exportAll("bibtex")),
              ];
            return [
              entry("Add files…", "upload", () => void bridge().addFiles(workspaceId)),
              entry("DOI, ISBN, URL or Zotero…", "books", onOpenLibrary),
            ];
          }}
        </ContextMenu>
      )}
    </section>
  );
}

/** A compact select that reads as text with a chevron, for sidebar toolbars. */
export function SidebarSelect({ label, value, options, onChange, icon }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void; icon?: IconName }) {
  return (
    <label className="kx-select" title={label}>
      {icon && <Icon name={icon} size={12} />}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={10} />
    </label>
  );
}
