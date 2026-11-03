// Search as a tab: everything in the workspace, in the three sections or by kind, with
// kind chips and the library's filter tokens. While the tab is focused, a click in the
// sidebar narrows the search (a collection, the library, a note …) instead of leaving;
// clicking the same thing again opens it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EMPTY_FIND, FIND_KINDS, KIND_LABEL, kindOf, onPendingFind, sidebarFilter, takePendingFind, useFind, type FindKind, type FindResult, type FindState } from "./global-search";
import { Icon } from "./icons";
import { openItemAt } from "./item-actions";
import { itemAttrs } from "./item-ui";
import { bridge, type Invoke } from "./library-api";
import SearchField from "./search-suggest";
import { SectionHeader, Snippet, foundIcon, useCollapsedGroups } from "./search-sections";
import { claimSidebar } from "./sidebar-intent";
import { GROUPS, GROUP_LABEL, type Found } from "./unified-search";
import "./reference-library.css";
import "./search-page.css";

const ONE: Record<FindKind, string> = { source: "Source", note: "Note", record: "Page", canvas: "Canvas", highlight: "Highlight" };

/** All · Sources · Notes …, each with its count; a click shows only that kind (⌘-click adds it). */
export function KindChips({ result, kinds, onKinds }: { result: FindResult; kinds: FindKind[]; onKinds: (kinds: FindKind[]) => void }) {
  return (
    <div className="kx-kind-chips" role="group" aria-label="Show">
      <button type="button" aria-pressed={!kinds.length} onMouseDown={(e) => e.preventDefault()} onClick={() => onKinds([])}>
        All <span className="kx-count">{result.all}</span>
      </button>
      {FIND_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          data-kind={kind}
          aria-pressed={kinds.includes(kind)}
          disabled={!result.counts[kind] && !kinds.includes(kind)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) =>
            onKinds(
              e.metaKey || e.shiftKey
                ? kinds.includes(kind)
                  ? kinds.filter((k) => k !== kind)
                  : [...kinds, kind]
                : kinds.length === 1 && kinds[0] === kind
                  ? []
                  : [kind],
            )
          }
        >
          {KIND_LABEL[kind]} <span className="kx-count">{result.counts[kind]}</span>
        </button>
      ))}
    </div>
  );
}

type GroupBy = "section" | "kind";
const GROUP_BY = "key.search.groupBy";

/** The results of one item in one section: the item, and each place it matched. */
interface ItemGroup {
  key: string;
  item: Found;
  matches: Found[];
}
/** Results by item, like the library's search: a source once, its passages beneath it. */
function byItem(entries: Found[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const entry of entries) {
    // A highlight is an item of its own; a page of a document belongs to the document.
    const key = entry.anchor?.startsWith("highlight:") ? `${entry.kind}:${entry.id}:${entry.anchor}` : `${entry.kind}:${entry.id}`;
    const group = groups.get(key) ?? { key, item: { ...entry, anchor: entry.anchor?.startsWith("highlight:") ? entry.anchor : undefined, snippet: undefined, where: undefined }, matches: [] };
    if (entry.snippet || entry.where) group.matches.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export default function SearchPage({ invoke, workspaceId, active, viewId }: { invoke: Invoke; workspaceId: string; active: boolean; viewId?: string }) {
  const [state, setState] = useState<FindState>(() => takePendingFind(workspaceId) ?? EMPTY_FIND);
  useEffect(() => onPendingFind(workspaceId, setState), [workspaceId]);
  const result = useFind(invoke, workspaceId, state, 40);
  const [groupBy, setGroupByState] = useState<GroupBy>(() => {
    try {
      return localStorage.getItem(GROUP_BY) === "kind" ? "kind" : "section";
    } catch {
      return "section";
    }
  });
  const setGroupBy = (next: GroupBy) => {
    setGroupByState(next);
    try {
      localStorage.setItem(GROUP_BY, next);
    } catch {}
  };
  const { collapsed, toggle } = useCollapsedGroups();
  const [shutKinds, setShutKinds] = useState<FindKind[]>([]);
  const [current, setCurrent] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // While focused, the sidebar's clicks become filters.
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (!active) return;
    return claimSidebar((target) => {
      const next = sidebarFilter(latest.current, target);
      if (!next) return false;
      setState(next);
      return true;
    });
  }, [active]);
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);

  const all = [...result.found.titles, ...result.found.text, ...result.found.meaning];
  const sections: { id: string; header: ReactNode; entries: Found[] }[] =
    groupBy === "section"
      ? GROUPS.filter((g) => result.found[g].length || (result.found.pending && g !== "titles")).map((g) => ({
          id: g,
          header: <SectionHeader group={g} count={result.found[g].length} collapsed={collapsed.includes(g)} pending={result.found.pending && g !== "titles" && !result.found[g].length} onToggle={() => toggle(g)} />,
          entries: collapsed.includes(g) ? [] : result.found[g],
        }))
      : FIND_KINDS.map((kind) => ({ kind, entries: all.filter((f) => kindOf(f) === kind) }))
          .filter((s) => s.entries.length)
          .map(({ kind, entries }) => ({
            id: kind,
            header: (
              <button type="button" className="kx-search-head" data-kind={kind} aria-expanded={!shutKinds.includes(kind)} onClick={() => setShutKinds((s) => (s.includes(kind) ? s.filter((k) => k !== kind) : [...s, kind]))}>
                <Icon name="chevronRight" size={11} className="kx-section-chevron" />
                <span>{KIND_LABEL[kind]}</span>
                <span className="kx-count">{entries.length}</span>
              </button>
            ),
            entries: shutKinds.includes(kind) ? [] : entries,
          }));
  const grouped = sections.map((section) => ({ ...section, items: byItem(section.entries) }));
  const visible = grouped.flatMap((s) => s.items);
  useEffect(() => setCurrent(-1), [state.text, state.kinds.join(), JSON.stringify(state.filters), groupBy]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  // Results open beside the search, which stays where it is. A passage of a PDF opens the
  // reader there with the result bar to step through every passage found.
  const passages = all.filter((f) => f.passageId && f.documentHash && f.sourceKind === "pdf");
  const openMatch = (entry: Found | undefined, newTab = false) => {
    if (!entry) return;
    if (!newTab && entry.passageId && entry.documentHash && entry.sourceKind === "pdf") {
      const page = entry.anchor?.startsWith("page:") ? Number(entry.anchor.slice(5)) : 0;
      void bridge().tabAction("preview-result", {
        sourceViewId: viewId,
        source: { documentHash: entry.documentHash, documentId: entry.documentHash, title: entry.title, workspaceId },
        hit: { id: entry.passageId, documentHash: entry.documentHash, documentTitle: entry.title, page, workspaceId },
        results: passages.map((p) => ({
          id: p.passageId,
          documentHash: p.documentHash,
          documentTitle: p.title,
          page: p.anchor?.startsWith("page:") ? Number(p.anchor.slice(5)) : 0,
          workspaceId,
        })),
        query: state.text,
        beside: true,
      });
      return;
    }
    openItemAt(entry, newTab ? "tab" : "split", entry.title, workspaceId, invoke);
  };
  const open = (group: ItemGroup | undefined, newTab = false) => group && openMatch(group.matches.find((m) => m.passageId) ?? group.item, newTab);

  return (
    <section className="kx-search-page" aria-label="Search">
      <header className="kx-search-page-head">
        <h1>Search</h1>
        <SearchField
          invoke={invoke}
          workspaceId={workspaceId}
          view={{}}
          text={state.text}
          onText={(text) => setState((s) => ({ ...s, text }))}
          filters={state.filters}
          onFilters={(filters) => setState((s) => ({ ...s, filters }))}
          busy={result.found.pending}
          inputRef={input}
          label="Search everything"
          placeholder="Search sources, notes, pages, canvases and highlights"
          onSubmit={() => open(visible[Math.max(0, current)])}
          onArrowIntoResults={() => {
            if (!visible.length) return;
            setCurrent(0);
            list.current?.focus();
          }}
        />
        <div className="kx-search-page-bar">
          <KindChips result={result} kinds={state.kinds} onKinds={(kinds) => setState((s) => ({ ...s, kinds }))} />
          <span className="kx-spacer" />
          <div className="kx-segmented" role="group" aria-label="Group by">
            <button type="button" aria-pressed={groupBy === "section"} onClick={() => setGroupBy("section")}>
              Sections
            </button>
            <button type="button" aria-pressed={groupBy === "kind"} onClick={() => setGroupBy("kind")}>
              Kinds
            </button>
          </div>
        </div>
        <p className="kx-search-page-hint">Click the sidebar to filter: a collection, Sources, Highlights or a note. Click again to open it.</p>
      </header>
      <div
        ref={list}
        className="kx-search-page-results"
        role="listbox"
        aria-label="Results"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setCurrent((i) => Math.min(visible.length - 1, i + 1));
          else if (e.key === "ArrowUp") {
            if (current <= 0) {
              setCurrent(-1);
              input.current?.focus();
            } else setCurrent((i) => i - 1);
          } else if (e.key === "Enter") open(visible[current], e.altKey);
          else return;
          e.preventDefault();
        }}
      >
        {!sections.length && !result.found.pending ? (
          <p className="kx-found-empty">{state.text.trim() || state.filters.length || state.kinds.length ? "Nothing matches" : "Nothing in this workspace yet"}</p>
        ) : (
          grouped.map((section) => (
            <section key={section.id} className="kx-found-group" data-group={section.id}>
              {section.header}
              {section.items.map((group) => {
                const index = visible.indexOf(group);
                const { item } = group;
                const kind = kindOf(item);
                return (
                  <article
                    key={group.key}
                    role="option"
                    aria-selected={index === current}
                    data-index={index}
                    className="kx-hit kx-found-hit"
                    {...itemAttrs(item)}
                    onMouseMove={() => index !== current && setCurrent(index)}
                  >
                    <span className="kx-row-kind" data-kind={item.sourceKind ?? kind}>
                      <Icon name={foundIcon(item)} size={15} data-color={item.color} />
                    </span>
                    <div className="kx-hit-body">
                      <button type="button" className="kx-found-open" title="Open beside the search (⌘-click: in a new tab)" onClick={(e) => openMatch(item, e.metaKey)}>
                        <strong className="kx-hit-title">{item.title}</strong>
                        <span className="kx-found-kind">{ONE[kind]}</span>
                      </button>
                      {item.byline && <span className="kx-hit-meta">{item.byline}</span>}
                      {group.matches.length > 0 && (
                        <ul className="kx-hit-matches">
                          {group.matches.map((match, i) => (
                            <li key={`${match.anchor ?? ""}:${match.passageId ?? i}`}>
                              <button type="button" className="kx-passage" data-related={match.group === "meaning"} onClick={(e) => openMatch(match, e.metaKey)}>
                                {match.where && <span className="kx-match-where">{match.where}</span>}
                                {match.snippet && (
                                  <span className="kx-match-text">
                                    <Snippet text={match.snippet} />
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          ))
        )}
      </div>
    </section>
  );
}
