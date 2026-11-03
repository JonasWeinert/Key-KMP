import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../icons";
import type { IconName } from "../icons";
import { SLASH_GROUPS } from "./menus";
import type { MenuState, SlashItem } from "./menus";
import type { SourceRef } from "./types";
import { SectionHeader, Snippet, useCollapsedGroups } from "../search-sections";

export interface SuggestionMenuHandle {
  handleKey(event: KeyboardEvent): boolean;
}

const MODE_TITLE = { link: "Link to", embed: "Embed", quote: "Quote from a source", cite: "Cite or mention" } as const;
const GROUP_ORDER = ["titles", "text", "meaning"] as const;
const refGroup = (ref: SourceRef) => ref.group ?? "titles";
const ITEM_ICON = { note: "note", canvas: "canvas", record: "doc" } as const;

function refIcon(ref: SourceRef, mode: MenuState["mode"]): IconName {
  if (mode === "quote") return "quote";
  if (ref.itemKind && ref.itemKind !== "source") return ITEM_ICON[ref.itemKind];
  if (ref.anchor?.startsWith("highlight:")) return "quote";
  return ref.kind === "book" ? "book" : ref.kind === "image" ? "image" : ref.kind === "web" ? "globe" : "doc";
}

/** Places a popover under (or above) an anchor rect, kept inside the viewport. */
export function usePopoverPosition(rect: DOMRect | null, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !rect) return;
    const gap = 6;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + gap;
    if (top + h > vh - 8 && rect.top - gap - h > 8) top = rect.top - gap - h;
    const left = Math.max(8, Math.min(rect.left, vw - w - 8));
    setStyle({ top, left });
  }, [rect?.top, rect?.left, rect?.bottom, ...deps]);
  return { ref, style };
}

function SlashIcon({ icon }: { icon: SlashItem["icon"] }): ReactNode {
  if (typeof icon === "object") return <span className="ne-menu-glyph">{icon.glyph}</span>;
  if (icon === "warning") return <span className="ne-menu-glyph">!</span>;
  return <Icon name={icon} size={16} />;
}

export const SuggestionMenu = forwardRef<SuggestionMenuHandle, { state: MenuState | null }>(function SuggestionMenu({ state }, ref) {
  const [index, setIndex] = useState(0);
  const { collapsed, toggle } = useCollapsedGroups();
  // Source pickers group their entries in sections; collapsed sections can't be chosen.
  const all = state?.items ?? [];
  const items = state?.kind === "source" ? GROUP_ORDER.flatMap((g) => (collapsed.includes(g) ? [] : (all as SourceRef[]).filter((r) => refGroup(r) === g))) : all;
  const count = items.length;
  const listRef = useRef<HTMLDivElement>(null);
  const { ref: boxRef, style } = usePopoverPosition(state?.rect ?? null, [count, state?.kind, state?.loading]);

  useEffect(() => setIndex(0), [state?.items, state?.kind]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useImperativeHandle(
    ref,
    () => ({
      handleKey(event: KeyboardEvent): boolean {
        if (!state || (state.kind === "slash" && count === 0)) return false;
        if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
          setIndex((i) => (count === 0 ? 0 : (i + 1) % count));
          return true;
        }
        if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
          setIndex((i) => (count === 0 ? 0 : (i - 1 + count) % count));
          return true;
        }
        if (state.kind === "source" && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          const group = refGroup((items[index] as SourceRef | undefined) ?? (all[0] as SourceRef));
          if (event.key === "ArrowLeft") toggle(group, false);
          else GROUP_ORDER.forEach((g) => collapsed.includes(g) && toggle(g, true));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[index];
          if (item) {
            state.command(item);
            return true;
          }
          // nothing to pick: let Enter behave normally for slash, swallow it for the picker
          return state.kind === "source" && event.key === "Enter" && state.loading;
        }
        return false;
      },
    }),
    [state, index, count, items, collapsed],
  );

  if (!state || !state.rect) return null;
  // an unmatched slash query is probably just text: hide instead of nagging
  if (state.kind === "slash" && count === 0 && state.query.length > 2) return null;

  let body: ReactNode;
  if (state.kind === "slash") {
    const slashItems = items as SlashItem[];
    body =
      count === 0 ? (
        <div className="ne-menu-empty">No matching blocks</div>
      ) : (
        SLASH_GROUPS.map((group) => {
          const inGroup = slashItems.filter((item) => item.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div className="ne-menu-group" key={group} role="group" aria-label={group}>
              <div className="ne-menu-heading">{group}</div>
              {inGroup.map((item) => {
                const i = slashItems.indexOf(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={i === index}
                    data-index={i}
                    className={`ne-menu-item${i === index ? " is-active" : ""}`}
                    onMouseMove={() => i !== index && setIndex(i)}
                    onClick={() => state.command(item)}
                  >
                    <span className="ne-menu-icon">
                      <SlashIcon icon={item.icon} />
                    </span>
                    <span className="ne-menu-text">
                      <span className="ne-menu-label">{item.label}</span>
                      <span className="ne-menu-hint">{item.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })
      );
  } else {
    const sources = all as SourceRef[];
    const row = (ref: SourceRef) => {
      const i = items.indexOf(ref);
      return (
        <button
          key={`${ref.itemKind ?? "source"}:${ref.id}:${ref.anchor ?? ""}`}
          type="button"
          role="option"
          aria-selected={i === index}
          data-index={i}
          className={`ne-menu-item${i === index ? " is-active" : ""}`}
          onMouseMove={() => i !== index && setIndex(i)}
          onClick={() => state.command(ref)}
        >
          <span className="ne-menu-icon">
            <Icon name={refIcon(ref, state.mode)} size={16} data-color={ref.color} />
          </span>
          <span className="ne-menu-text">
            <span className="ne-menu-label">{ref.title}</span>
            {(ref.where || ref.snippet) ? (
              <span className="ne-menu-hint ne-menu-snippet">
                {ref.where && <strong>{ref.where} </strong>}
                {ref.snippet && <Snippet text={ref.snippet} />}
              </span>
            ) : ref.detail ? (
              <span className="ne-menu-hint">{ref.detail}</span>
            ) : null}
          </span>
        </button>
      );
    };
    const groups = GROUP_ORDER.map((g) => [g, sources.filter((r) => refGroup(r) === g)] as const).filter(([g, list]) => list.length || (g !== "titles" && state.more));
    body = (
      <div className="ne-menu-group">
        <div className="ne-menu-heading">{MODE_TITLE[state.mode]}</div>
        {sources.length === 0 && !state.more ? (
          <div className="ne-menu-empty">
            {state.loading ? "Searching…" : state.query ? "Nothing matches" : "Type to search notes, sources, highlights, canvases and pages"}
          </div>
        ) : (
          groups.map(([group, list]) => (
            <div key={group} className="ne-menu-section" data-group={group}>
              {(groups.length > 1 || group !== "titles") && <SectionHeader group={group} count={list.length} collapsed={collapsed.includes(group)} pending={!list.length && state.more} onToggle={() => toggle(group)} />}
              {!collapsed.includes(group) && list.map(row)}
            </div>
          ))
        )}
        {state.mode === "cite" && <div className="ne-menu-foot">Add “p. 12” to cite a page · ⌥← collapse a section</div>}
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className={`ne-popover ne-menu ne-menu--${state.kind}`}
      style={style}
      role="listbox"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ne-menu-scroll" ref={listRef}>
        {body}
      </div>
    </div>
  );
});
