// Search as a tab: everything in the workspace, in the three sections or by kind, with
// kind chips and the library's filter tokens. While the tab is focused, a click in the
// sidebar narrows the search (a collection, the library, a note …) instead of leaving;
// clicking the same thing again opens it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EMPTY_FIND, FIND_KINDS, KIND_LABEL, kindOf, onPendingFind, sidebarFilter, takePendingFind, useFind, type FindKind, type FindResult, type FindState } from "./global-search";
import { Icon } from "./icons";
import { openItemAt } from "./item-actions";
import { itemAttrs } from "./item-ui";
import type { Invoke } from "./library-api";
import SearchField from "./search-suggest";
import { SectionHeader, Snippet, foundIcon, useCollapsedGroups } from "./search-sections";
import { claimSidebar } from "./sidebar-intent";
import { GROUPS, GROUP_LABEL, type Found } from "./unified-search";
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

export default function SearchPage({ invoke, workspaceId, active }: { invoke: Invoke; workspaceId: string; active: boolean }) {
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
  const visible = sections.flatMap((s) => s.entries);
  useEffect(() => setCurrent(-1), [state.text, state.kinds.join(), JSON.stringify(state.filters), groupBy]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const open = (entry: Found | undefined, beside = false) => entry && openItemAt(entry, beside ? "split" : "tab", entry.title, workspaceId, invoke);

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
          sections.map((section) => (
            <section key={section.id} className="kx-found-group" data-group={section.id}>
              {section.header}
              {section.entries.map((entry) => {
                const index = visible.indexOf(entry);
                const kind = kindOf(entry);
                const kindLabel = groupBy === "section" ? ONE[kind] : GROUP_LABEL[entry.group];
                const where = entry.where === kindLabel ? undefined : entry.where;
                return (
                  <button
                    type="button"
                    key={`${entry.kind}:${entry.id}:${entry.anchor ?? ""}:${entry.group}`}
                    role="option"
                    aria-selected={index === current}
                    data-index={index}
                    className="kx-found-row"
                    {...itemAttrs(entry)}
                    onMouseMove={() => index !== current && setCurrent(index)}
                    onClick={(e) => open(entry, e.altKey)}
                  >
                    <Icon name={foundIcon(entry)} size={15} className="kx-found-icon" data-color={entry.color} />
                    <span className="kx-found-text">
                      <span className="kx-found-title">{entry.title}</span>
                      {(where || entry.snippet) && (
                        <span className="kx-found-detail">
                          {where && <span className="kx-found-where">{where}</span>}
                          {entry.snippet && <Snippet text={entry.snippet} />}
                        </span>
                      )}
                    </span>
                    <span className="kx-found-kind">{kindLabel}</span>
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
    </section>
  );
}
