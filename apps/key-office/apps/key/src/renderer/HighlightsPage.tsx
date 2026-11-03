// Every highlight in the library in one place: filter by colour (each colour can be given a
// meaning, like "Method" or "Disagree"), by words, grouped by source or newest first.
// Highlights drag onto canvases and into notes (where they arrive as quotes with citations).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./icons";
import { highlightPage, openItemAt, type Highlight } from "./item-actions";
import { setItemDrag } from "./item-links";
import { itemAttrs, selectItems } from "./item-ui";
import { bridge, type Invoke, type Source, type SourcePage } from "./library-api";
import type { DraggedItem } from "./note-editor";
import { currentTheme, highlightColor } from "./canvas/canvas-colors";
import "./highlights-page.css";

interface Row extends Highlight {
  source: Source;
  page?: number;
  at: number;
}

const COLOR_NAMES: Record<string, string> = { yellow: "Yellow", orange: "Orange", green: "Green", blue: "Blue", pink: "Pink", red: "Red", purple: "Purple" };

/** What each colour means in this workspace, as the user named them. */
export function useColorLabels(workspaceId: string) {
  const key = `key.highlight.labels.${workspaceId}`;
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  const [labels, setLabels] = useState<Record<string, string>>(read);
  const rename = (color: string, label: string) => {
    const next = { ...read(), [color]: label.trim() };
    if (!label.trim()) delete next[color];
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* kept for this session only */
    }
    setLabels(next);
  };
  return { labels, rename };
}

async function loadAll(invoke: Invoke, workspaceId: string): Promise<Row[]> {
  const sources: Source[] = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await invoke<SourcePage>("store_sources", { limit: 500, offset, sort: "added", descending: true }, workspaceId);
    sources.push(...page.items.filter((s) => s.annotationCount > 0));
    if (page.nextOffset == null) break;
  }
  const rows: Row[] = [];
  for (let i = 0; i < sources.length; i += 8) {
    const batch = await Promise.all(
      sources.slice(i, i + 8).map((source) =>
        invoke<(Highlight & { createdAt?: string; updatedAt?: string })[]>("library_annotations", { hash: source.id }, workspaceId)
          .then((list) => list.filter((h) => h.text || h.comment).map((h): Row => ({ ...h, source, page: highlightPage(h), at: Date.parse(h.updatedAt ?? h.createdAt ?? "") || source.updatedAt })))
          .catch(() => []),
      ),
    );
    rows.push(...batch.flat());
  }
  return rows;
}

export default function HighlightsPage({ invoke, workspaceId }: { invoke: Invoke; workspaceId: string }) {
  const [rows, setRows] = useState<Row[]>();
  const [query, setQuery] = useState("");
  const [colors, setColors] = useState<Set<string>>(new Set());
  const [grouped, setGrouped] = useState(() => localStorage.getItem("key.highlights.grouped") !== "false");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState(false);
  const anchor = useRef<string>(undefined);
  const { labels, rename } = useColorLabels(workspaceId);
  const theme = currentTheme();
  useEffect(() => {
    let current = true;
    const load = () => void loadAll(invoke, workspaceId).then((found) => current && setRows(found));
    load();
    const stop = bridge().on("annotations-changed", load);
    return () => {
      current = false;
      stop();
    };
  }, [invoke, workspaceId]);
  useEffect(() => localStorage.setItem("key.highlights.grouped", String(grouped)), [grouped]);
  const present = useMemo(() => [...new Set((rows ?? []).map((r) => r.color ?? "yellow"))], [rows]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => !colors.size || colors.has(r.color ?? "yellow"))
        .filter((r) => !q || `${r.text ?? ""} ${r.comment ?? ""} ${r.source.title}`.toLowerCase().includes(q))
        .sort((a, b) => b.at - a.at),
    [rows, colors, q],
  );
  const item = (r: Row): DraggedItem => ({ kind: "source", id: r.source.id, anchor: `highlight:${r.id}`, title: r.text || r.comment || "Highlight", detail: r.source.title, color: r.color });
  const chosen = shown.filter((r) => selected.has(r.id));
  useEffect(() => {
    if (chosen.length) selectItems(chosen.map(item));
  }, [[...selected].join(",")]);
  const pick = (r: Row, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const ids = shown.map((x) => x.id);
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(r.id)].sort((x, y) => x - y);
      setSelected(new Set(ids.slice(a, b + 1)));
      return;
    }
    anchor.current = r.id;
    setSelected((now) => (e.metaKey ? new Set(now.has(r.id) ? [...now].filter((id) => id !== r.id) : [...now, r.id]) : new Set([r.id])));
  };
  const groups = grouped
    ? [
        ...shown
          .reduce((map, r) => map.set(r.source.id, [...(map.get(r.source.id) ?? []), r]), new Map<string, Row[]>())
          .values(),
      ]
    : [shown];
  const label = (color: string) => labels[color] || COLOR_NAMES[color] || color;
  return (
    <section className="kx-highlights">
      <header className="kx-highlights-head">
        <div>
          <h1>Highlights</h1>
          <span className="kx-highlights-count">{rows ? `${shown.length} of ${rows.length}` : "Loading…"}</span>
        </div>
        <div className="kx-highlights-tools">
          <label className="kx-highlights-search">
            <Icon name="search" size={13} />
            <input value={query} placeholder="Filter by words or source" aria-label="Filter highlights" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="kx-highlights-toggle" aria-pressed={grouped} onClick={() => setGrouped(!grouped)}>
            {grouped ? "By source" : "Newest first"}
          </button>
        </div>
        <div className="kx-highlights-colors" role="group" aria-label="Colours">
          {present.map((color) => (
            <span key={color} className="kx-highlights-color" style={{ "--kx-hl-chip": highlightColor(color, theme) } as CSSProperties}>
              {naming ? (
                <input defaultValue={labels[color] ?? ""} placeholder={COLOR_NAMES[color] ?? color} aria-label={`Meaning of ${color}`} onBlur={(e) => rename(color, e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
              ) : (
                <button aria-pressed={colors.has(color)} onClick={() => setColors((now) => new Set(now.has(color) ? [...now].filter((c) => c !== color) : [...now, color]))}>
                  {label(color)}
                  <small>{(rows ?? []).filter((r) => (r.color ?? "yellow") === color).length}</small>
                </button>
              )}
            </span>
          ))}
          {present.length > 0 && (
            <button className="kx-highlights-name" onClick={() => setNaming(!naming)}>
              {naming ? "Done" : "Name colours…"}
            </button>
          )}
        </div>
      </header>
      {rows && !rows.length && <p className="kx-highlights-empty">Highlights you make in PDFs appear here. Select text in a PDF and pick a colour.</p>}
      <div className="kx-highlights-list" role="listbox" aria-multiselectable tabIndex={0}>
        {groups.map((list) => (
          <div key={grouped ? list[0]?.source.id : "all"} className="kx-highlights-group">
            {grouped && list[0] && (
              <button className="kx-highlights-source" {...itemAttrs({ kind: "source", id: list[0].source.id, title: list[0].source.title })} onClick={(e) => openItemAt({ kind: "source", id: list[0].source.id }, e.altKey ? "split" : "tab", list[0].source.title)}>
                <Icon name="doc" size={13} />
                <span>{list[0].source.title || "Untitled"}</span>
                <small>{list.length}</small>
              </button>
            )}
            {list.map((r) => (
              <article
                key={r.id}
                role="option"
                aria-selected={selected.has(r.id)}
                className="kx-highlights-row"
                style={{ "--kx-hl-chip": highlightColor(r.color, theme) } as CSSProperties}
                {...itemAttrs(item(r))}
                draggable
                onDragStart={(e) => setItemDrag(e.dataTransfer, selected.has(r.id) ? chosen.map(item) : [item(r)])}
                onMouseDown={(e) => pick(r, e)}
                onDoubleClick={(e) => openItemAt(item(r), e.altKey ? "split" : "tab")}
              >
                <blockquote>{r.text || r.comment}</blockquote>
                {r.text && r.comment && <p className="kx-highlights-comment">{r.comment}</p>}
                <footer>
                  <span className="kx-highlights-tag">{label(r.color ?? "yellow")}</span>
                  {!grouped && <span>{r.source.title}</span>}
                  {r.page !== undefined && <span>p. {r.page + 1}</span>}
                </footer>
              </article>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
