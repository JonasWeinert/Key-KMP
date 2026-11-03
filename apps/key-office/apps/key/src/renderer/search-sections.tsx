// How search results look everywhere: sections for title and detail matches, text
// matches and related-by-meaning matches, each of which can be collapsed on its own (and
// stays so, in every search, until opened again).
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { snippetParts } from "./library-api";
import { GROUP_LABEL, GROUPS, type Found, type Found3, type SearchGroup } from "./unified-search";
import "./search-sections.css";

const STORAGE = "key.search.collapsed";
const listeners = new Set<(collapsed: SearchGroup[]) => void>();
const read = (): SearchGroup[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) || "[]");
  } catch {
    return [];
  }
};
/** Which sections are collapsed, shared by every search in the window. */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<SearchGroup[]>(read);
  useEffect(() => {
    listeners.add(setCollapsed);
    return () => {
      listeners.delete(setCollapsed);
    };
  }, []);
  const toggle = (group: SearchGroup, open?: boolean) => {
    const now = read();
    const isOpen = !now.includes(group);
    const next = (open ?? !isOpen) ? now.filter((g) => g !== group) : [...now, group];
    try {
      localStorage.setItem(STORAGE, JSON.stringify(next));
    } catch {
      /* private storage: the toggle still applies for now */
    }
    listeners.forEach((listener) => listener(next));
  };
  return { collapsed, toggle };
}

export function SectionHeader({ group, count, collapsed, onToggle, pending, extra }: { group: SearchGroup; count: number; collapsed: boolean; onToggle: () => void; pending?: boolean; extra?: ReactNode }) {
  return (
    <button type="button" className="kx-search-head" data-group={group} aria-expanded={!collapsed} onMouseDown={(e) => e.preventDefault()} onClick={onToggle}>
      <Icon name="chevronRight" size={11} className="kx-section-chevron" />
      <span>{GROUP_LABEL[group]}</span>
      <span className="kx-count">{pending ? "…" : count}</span>
      {group === "meaning" && <span className="kx-section-tag">semantic</span>}
      {extra}
    </button>
  );
}

export function Snippet({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

const SOURCE_ICON: Record<string, IconName> = { pdf: "doc", web: "globe", video: "video", audio: "audio", image: "image", book: "book", reference: "quote" };
export function foundIcon(found: Pick<Found, "kind" | "anchor" | "sourceKind" | "group">): IconName {
  if (found.anchor?.startsWith("highlight:")) return "quote";
  if (found.kind === "note") return "note";
  if (found.kind === "canvas") return "canvas";
  if (found.kind === "record") return "doc";
  return SOURCE_ICON[found.sourceKind ?? ""] ?? "doc";
}

/** The entries that can be chosen, in order, with collapsed sections left out. */
export function visibleFound(found: Found3, collapsed: SearchGroup[]): Found[] {
  return GROUPS.filter((g) => !collapsed.includes(g)).flatMap((g) => found[g]);
}

/** Results in their sections; `active` is an index into `visibleFound`. */
export function FoundList({
  found,
  active,
  onActive,
  onPick,
  empty,
  rowExtra,
}: {
  found: Found3;
  active: number;
  onActive: (index: number) => void;
  onPick: (found: Found, event: React.MouseEvent) => void;
  empty?: ReactNode;
  rowExtra?: (found: Found) => ReactNode;
}) {
  const { collapsed, toggle } = useCollapsedGroups();
  const visible = visibleFound(found, collapsed);
  const any = GROUPS.some((g) => found[g].length) || found.pending;
  if (!any) return <div className="kx-found-empty">{empty ?? "Nothing matches"}</div>;
  return (
    <div className="kx-found" role="listbox">
      {GROUPS.map((group) => {
        const list = found[group];
        if (!list.length && !(found.pending && group !== "titles")) return null;
        const shut = collapsed.includes(group);
        return (
          <section key={group} className="kx-found-group" data-group={group}>
            <SectionHeader group={group} count={list.length} collapsed={shut} pending={found.pending && group !== "titles" && !list.length} onToggle={() => toggle(group)} />
            {!shut &&
              list.map((entry) => {
                const index = visible.indexOf(entry);
                return (
                  <button
                    type="button"
                    key={`${entry.kind}:${entry.id}:${entry.anchor ?? ""}`}
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    className="kx-found-row"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => index !== active && onActive(index)}
                    onClick={(e) => onPick(entry, e)}
                  >
                    <Icon name={foundIcon(entry)} size={15} className="kx-found-icon" data-color={entry.color} />
                    <span className="kx-found-text">
                      <span className="kx-found-title">{entry.title}</span>
                      {(entry.where || entry.snippet) && (
                        <span className="kx-found-detail">
                          {entry.where && <span className="kx-found-where">{entry.where}</span>}
                          {entry.snippet && <Snippet text={entry.snippet} />}
                        </span>
                      )}
                    </span>
                    {rowExtra?.(entry)}
                  </button>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}

/** Arrow keys move through the visible entries; ← and → close and open the active one's section. */
export function foundKeys(event: React.KeyboardEvent | KeyboardEvent, found: Found3, collapsed: SearchGroup[], active: number, setActive: (i: number) => void, toggle: (g: SearchGroup, open?: boolean) => void): boolean {
  const visible = visibleFound(found, collapsed);
  if (event.key === "ArrowDown") {
    setActive(visible.length ? (active + 1) % visible.length : 0);
    return true;
  }
  if (event.key === "ArrowUp") {
    setActive(visible.length ? (active - 1 + visible.length) % visible.length : 0);
    return true;
  }
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.altKey) {
    const group = visible[active]?.group ?? GROUPS.find((g) => found[g].length);
    if (!group) return false;
    if (event.key === "ArrowLeft") toggle(group, false);
    else GROUPS.forEach((g) => collapsed.includes(g) && toggle(g, true));
    return true;
  }
  return false;
}
