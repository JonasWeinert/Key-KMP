// A search box over the window for Open Quickly (⌘P), Commands (⌘K), Send to… (⌘⇧S)
// and adding to a canvas: the shared search in its sections, with commands on top.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GlobalDialog } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import type { Invoke } from "./library-api";
import { FoundList, foundKeys, useCollapsedGroups, visibleFound } from "./search-sections";
import { useUnifiedSearch, type Found, type SearchOptions } from "./unified-search";
import { fuzzyScore } from "./note-editor/menus";
import "./palette.css";

export interface Command {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

export interface PaletteProps {
  invoke: Invoke;
  workspaceId: string;
  label: string;
  placeholder: string;
  options?: SearchOptions;
  commands?: Command[];
  /** Return true to keep the palette open (to pick more). */
  onPick: (found: Found, how: { alt: boolean; meta: boolean; shift: boolean }) => boolean | void;
  onClose: () => void;
  /** Under the results: hints, or a choice like Link · Embed · Cite. */
  footer?: ReactNode;
  initialQuery?: string;
}

export default function Palette({ invoke, workspaceId, label, placeholder, options, commands = [], onPick, onClose, footer, initialQuery = "" }: PaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const found = useUnifiedSearch(invoke, workspaceId, query, options);
  const { collapsed, toggle } = useCollapsedGroups();
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim();
  const shownCommands = (q ? commands.map((c) => [c, fuzzyScore(q, `${c.label} ${c.keywords ?? ""}`)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c) : commands).slice(0, q ? 6 : 12);
  const visible = visibleFound(found, collapsed);
  const total = shownCommands.length + visible.length;
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-palette-index="${active}"], .kx-found-row[data-index="${active - shownCommands.length}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, shownCommands.length]);
  const pick = (index: number, how: { alt: boolean; meta: boolean; shift: boolean }) => {
    if (index < shownCommands.length) {
      onClose();
      shownCommands[index].run();
      return;
    }
    const entry = visible[index - shownCommands.length];
    if (entry && !onPick(entry, how)) onClose();
  };
  return (
    <GlobalDialog label={label} onClose={onClose}>
      <div className="kx-palette" data-no-preview>
        <div className="kx-palette-field">
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") return onClose();
              if (e.key === "Enter") {
                e.preventDefault();
                return pick(active, { alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
              }
              // Commands first, then the search entries.
              const inFound = active - shownCommands.length;
              if ((e.key === "ArrowDown" || e.key === "ArrowUp") && total) {
                e.preventDefault();
                setActive((i) => (e.key === "ArrowDown" ? (i + 1) % total : (i - 1 + total) % total));
                return;
              }
              if (inFound >= 0 && foundKeys(e, found, collapsed, inFound, (i) => setActive(i + shownCommands.length), toggle)) e.preventDefault();
            }}
          />
        </div>
        <div className="kx-palette-list" ref={list}>
          {shownCommands.length > 0 && (
            <section className="kx-palette-commands">
              <div className="kx-palette-heading">Commands</div>
              {shownCommands.map((command, i) => (
                <button
                  key={command.id}
                  type="button"
                  className="kx-found-row"
                  data-palette-index={i}
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => pick(i, { alt: false, meta: false, shift: false })}
                >
                  <Icon name={command.icon} size={15} className="kx-found-icon" />
                  <span className="kx-found-text">
                    <span className="kx-found-title">{command.label}</span>
                  </span>
                  {command.shortcut && <kbd className="kx-palette-kbd">{command.shortcut}</kbd>}
                </button>
              ))}
            </section>
          )}
          <FoundList
            found={found}
            active={active - shownCommands.length}
            onActive={(i) => setActive(i + shownCommands.length)}
            onPick={(entry, e) => {
              if (!onPick(entry, { alt: e.altKey, meta: e.metaKey, shift: e.shiftKey })) onClose();
            }}
            empty={shownCommands.length ? null : q ? `Nothing matches “${q}”` : "Type to search notes, sources, highlights, canvases and pages"}
          />
        </div>
        <footer className="kx-palette-foot">
          {footer ?? (
            <span>
              <kbd>↩</kbd> open · <kbd>⌥↩</kbd> beside · <kbd>⌥←</kbd> collapse section
            </span>
          )}
        </footer>
      </div>
    </GlobalDialog>
  );
}
