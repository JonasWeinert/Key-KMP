// People, journals and topics wherever a source names them. A click shows a small popover
// first (who or what it is, and what the library holds of it) with "Show sources", which
// filters the library, and "Open page", which opens the person's or journal's own page.
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FilterLinks, showInLibrary, sourceFilter } from "./filter-links";
import { Icon, type IconName } from "./icons";
import { openItemAt, shellContext } from "./item-actions";
import { itemAttrs } from "./item-ui";
import type { PersonPageData, TopicPageData, VenuePageData } from "./library-api";
import type { SearchFilter } from "./search-suggest";
import "./entity.css";

export type EntityKind = "person" | "venue" | "topic";
export const ENTITY_ICON: Record<EntityKind, IconName> = { person: "user", venue: "book", topic: "tag" };
const COMMAND: Record<EntityKind, string> = { person: "store_person", venue: "store_venue", topic: "store_topic" };

export interface EntityRef {
  kind: EntityKind;
  id: string;
  name: string;
}

export const entityFilter = (e: EntityRef): SearchFilter =>
  e.kind === "person" ? sourceFilter.person(e.id, e.name) : e.kind === "venue" ? sourceFilter.venue(e.id, e.name) : sourceFilter.topic(e.id, e.name);

type Facts = { title: string; subtitle?: string; lines: string[]; badge?: string; chips: { label: string; entity?: EntityRef }[] };

function facts(kind: EntityKind, data: PersonPageData | VenuePageData | TopicPageData): Facts {
  const sources = (n: number) => `${n} ${n === 1 ? "source" : "sources"} in your library`;
  const span = (a?: number | null, b?: number | null) => (a && b ? (a === b ? `${a}` : `${a}–${b}`) : "");
  if (kind === "person") {
    const { person, coauthors, firstYear, lastYear } = data as PersonPageData;
    return {
      title: person.name,
      subtitle: person.institution?.name ?? undefined,
      badge: person.orcid ? "ORCID" : undefined,
      lines: [
        [sources(person.sourceCount), span(firstYear, lastYear)].filter(Boolean).join(" · "),
        [person.worksCount != null && `${person.worksCount.toLocaleString()} works`, person.hIndex != null && `h-index ${person.hIndex}`, person.citedByCount != null && `${person.citedByCount.toLocaleString()} citations`]
          .filter(Boolean)
          .join(" · "),
      ].filter(Boolean),
      chips: coauthors.slice(0, 4).map((c) => ({ label: c.name, entity: { kind: "person", id: c.id, name: c.name } })),
    };
  }
  if (kind === "venue") {
    const { venue, firstYear, lastYear, people } = data as VenuePageData;
    return {
      title: venue.name,
      subtitle: [venue.publisher?.name, venue.issnL && `ISSN ${venue.issnL}`].filter(Boolean).join(" · ") || undefined,
      badge: venue.isOa ? "Open access" : undefined,
      lines: [[sources(venue.sourceCount), span(firstYear, lastYear)].filter(Boolean).join(" · "), venue.hIndex != null ? `h-index ${venue.hIndex}` : ""].filter(Boolean),
      chips: people.slice(0, 4).map((c) => ({ label: c.name, entity: { kind: "person", id: c.id, name: c.name } })),
    };
  }
  const { topic, children } = data as TopicPageData;
  return {
    title: topic.name,
    subtitle: topic.path.map((t) => t.name).join(" › ") || undefined,
    lines: [sources(topic.sourceCount)],
    chips: children.slice(0, 4).map((c) => ({ label: c.name, entity: { kind: "topic", id: c.id, name: c.name } })),
  };
}

/** The popover itself, placed under `anchor` and kept on screen. */
export function EntityPopover({ entity, anchor, onClose }: { entity: EntityRef; anchor: HTMLElement; onClose: () => void }) {
  const { invoke, workspaceId } = shellContext();
  const libraryFilter = useContext(FilterLinks);
  const [current, setCurrent] = useState(entity);
  const [data, setData] = useState<Facts | null>();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    let live = true;
    setData(undefined);
    void invoke<PersonPageData | VenuePageData | TopicPageData | null>(COMMAND[current.kind], { id: current.id }, workspaceId)
      .then((page) => live && setData(page ? facts(current.kind, page) : null))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, current.kind, current.id]);
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 300;
    const height = ref.current?.offsetHeight ?? 160;
    const below = box.bottom + 6 + height < window.innerHeight;
    setPlace({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top: below ? box.bottom + 6 : Math.max(8, box.top - height - 6) });
  }, [anchor, data]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  const show = () => {
    const filter = entityFilter({ ...current, name: data?.title ?? current.name });
    if (libraryFilter) libraryFilter(filter);
    else if (workspaceId) showInLibrary(workspaceId, filter);
    onClose();
  };
  const open = () => {
    openItemAt({ kind: current.kind, id: current.id }, "tab", data?.title ?? current.name);
    onClose();
  };
  return createPortal(
    <div
      ref={ref}
      className="kx-entity-popover"
      role="dialog"
      aria-label={data?.title ?? current.name}
      data-kind={current.kind}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
      {...itemAttrs({ kind: current.kind, id: current.id, title: current.name })}
    >
      <header>
        <span className="kx-entity-icon">
          <Icon name={ENTITY_ICON[current.kind]} size={14} />
        </span>
        <span className="kx-entity-heading">
          <strong>{data?.title ?? current.name}</strong>
          {data?.subtitle && <small>{data.subtitle}</small>}
        </span>
        {data?.badge && <span className="kx-entity-badge">{data.badge}</span>}
      </header>
      {data === null ? (
        <p className="kx-entity-line">Not in this library any more.</p>
      ) : (
        <>
          {(data?.lines ?? ["…"]).map((line) => (
            <p className="kx-entity-line" key={line}>
              {line}
            </p>
          ))}
          {!!data?.chips.length && (
            <div className="kx-entity-chips" aria-label={current.kind === "person" ? "Co-authors" : current.kind === "venue" ? "Authors" : "Narrower topics"}>
              {data.chips.map((chip) => (
                <button key={chip.label} className="kx-entity-chip" onClick={() => chip.entity && setCurrent(chip.entity)}>
                  {chip.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <footer>
        <button className="kx-page-action" onClick={show} disabled={data === null}>
          <Icon name="filter" size={12} /> Show sources
        </button>
        <button className="kx-page-action kx-page-action-primary" onClick={open} disabled={data === null}>
          <Icon name="external" size={12} /> Open page
        </button>
      </footer>
    </div>,
    document.body,
  );
}

/** A name, journal or topic that opens its popover; plain text where nothing is known of it. */
export function EntityLink({ entity, children, className }: { entity?: EntityRef; children: ReactNode; className?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  if (!entity) return <span className={className}>{children}</span>;
  return (
    <>
      <button
        type="button"
        className={`kx-filter-link kx-entity-link${className ? ` ${className}` : ""}`}
        data-entity={entity.kind}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const target = e.currentTarget;
          setAnchor((open) => (open ? undefined : target));
        }}
      >
        {children}
      </button>
      {anchor && <EntityPopover entity={entity} anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

/** For a field edited in place (the journal): a small button beside it with the popover. */
export function EntityButton({ entity }: { entity: EntityRef }) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  return (
    <>
      <button
        type="button"
        className="kx-filter-button"
        title={`About ${entity.name}`}
        aria-label={`About ${entity.name}`}
        aria-haspopup="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const target = e.currentTarget;
          setAnchor((open) => (open ? undefined : target));
        }}
      >
        <Icon name={ENTITY_ICON[entity.kind]} size={11} />
      </button>
      {anchor && <EntityPopover entity={entity} anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}
