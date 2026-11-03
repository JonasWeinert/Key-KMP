// A person, journal or topic as a page of its own, in the style of a note: a quiet header,
// the name, one list of properties (what OpenAlex says, and what the library connects to
// it), then its sources in the library, the notes that mention it, and a button to write
// one. Counts OpenAlex keeps changing are cached and fetched again when the page opens.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EntityLink, ENTITY_ICON, entityFilter, type EntityKind } from "./entity-ui";
import { FilterLink, showInLibrary, sourceFilter } from "./filter-links";
import { Icon } from "./icons";
import { copyItemLink, openItemAt } from "./item-actions";
import { ItemPage } from "./ItemPage";
import LinkedFrom from "./LinkedFrom";
import { libraryChanged } from "./library-nav";
import {
  bridge,
  fetchedAgo,
  shortCreators,
  type Invoke,
  type NamedCount,
  type Note,
  type OpenAlexExtra,
  type PersonPageData,
  type Source,
  type SourcePage,
  type TopicPageData,
  type VenuePageData,
} from "./library-api";
import { itemHref } from "./note-editor";
import { YearBars } from "./work-references";
import "./entity.css";

type Data = PersonPageData | VenuePageData | TopicPageData;
const COMMAND: Record<EntityKind, string> = { person: "store_person", venue: "store_venue", topic: "store_topic" };
const KIND_LABEL: Record<EntityKind, string> = { person: "Person", venue: "Journal", topic: "Topic" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kx-field-row kx-page-chips kx-research-row" data-research={label}>
      <span>{label}</span>
      <div className="kx-research-values">{children}</div>
    </div>
  );
}

function Linked({ kind, items }: { kind: EntityKind; items: NamedCount[] }) {
  return (
    <>
      {items.map((item) => (
        <span key={item.id}>
          <EntityLink entity={{ kind, id: item.id, name: item.name }}>{item.name}</EntityLink>
          <small> {item.count}</small>
        </span>
      ))}
    </>
  );
}

export default function EntityPage({ invoke, workspaceId, kind, id, viewId }: { invoke: Invoke; workspaceId: string; kind: EntityKind; id: string; viewId?: string }) {
  const [data, setData] = useState<Data | null>();
  const [sources, setSources] = useState<Source[]>([]);
  const [total, setTotal] = useState(0);
  const [extra, setExtra] = useState<OpenAlexExtra | "loading" | string>();
  const [error, setError] = useState("");
  const [narrow, setNarrow] = useState(false);
  const pageRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 640));
    observer.observe(el);
  }, []);

  const load = useCallback(async () => {
    try {
      const page = await invoke<Data | null>(COMMAND[kind], { id }, workspaceId);
      setData(page);
      if (!page) return;
      const list = await invoke<SourcePage>("store_sources", { filters: [{ field: kind, op: "is", value: id }], sort: "year", descending: true, limit: 200 }, workspaceId);
      setSources(list.items);
      setTotal(list.total);
    } catch (e) {
      setError(String(e));
    }
  }, [invoke, workspaceId, kind, id]);
  useEffect(() => {
    void load().then(() => {
      // Cached counts that are old are fetched again (the host decides, and respects Settings).
      if (kind !== "topic")
        void invoke<Data | null>("store_refresh", { kind, id }, workspaceId)
          .then((page) => page && setData(page))
          .catch(() => {});
    });
    return bridge().on("library-changed", () => void load());
  }, [load, invoke, workspaceId, kind, id]);
  const name = !data ? "" : kind === "person" ? (data as PersonPageData).person.name : kind === "venue" ? (data as VenuePageData).venue.name : (data as TopicPageData).topic.name;
  useEffect(() => {
    if (name && viewId) void bridge().tabAction("content-title", { viewId, title: name });
  }, [name, viewId]);

  if (error && !data) return <p className="kx-note-page-error">{error}</p>;
  if (data === null) return <p className="kx-note-page-error">This {KIND_LABEL[kind].toLowerCase()} is no longer in the library.</p>;
  if (!data) return <div className="kx-entity-page" aria-busy="true" />;

  const refresh = () =>
    void invoke<Data>("store_refresh", { kind, id, force: true }, workspaceId)
      .then(setData)
      .catch((e) => setError(String(e).replace(/^Error: /, "")));
  const showSources = () => showInLibrary(workspaceId, entityFilter({ kind, id, name }));
  const newNote = async () => {
    const note = await invoke<Note>("store_note_save", { id: null, sourceId: null, title: `On ${name}`, body: `[${name}](${itemHref({ kind, id })})\n\n` }, workspaceId);
    window.dispatchEvent(new CustomEvent("key:notes-changed"));
    openItemAt({ kind: "note", id: note.id }, "tab", note.title);
  };
  const askOpenAlex = () => {
    setExtra("loading");
    void invoke<OpenAlexExtra>("store_openalex_extra", { kind, id }, workspaceId)
      .then(setExtra)
      .catch((e) => setExtra(String(e).replace(/^Error: /, "")));
  };
  const years = (a?: number | null, b?: number | null) => (a && b ? (a === b ? `${a}` : `${a}–${b}`) : undefined);
  const inOpenAlex = kind === "person" ? !!((data as PersonPageData).person.openalexId || (data as PersonPageData).person.orcid) : kind === "venue" ? !!(data as VenuePageData).venue.openalexId : false;

  return (
    <ItemPage
      kind={kind}
      className="kx-entity-page"
      innerClassName="kx-entity-page-inner"
      pageRef={pageRef}
      data-narrow={narrow}
      appearance={{}}
      defaultIcon={ENTITY_ICON[kind]}
      bar={
        <header className="kx-note-page-head">
          <span className="kx-note-source">
            <Icon name={ENTITY_ICON[kind]} size={12} />
            {KIND_LABEL[kind]}
          </span>
          <span className="kx-spacer" />
          <button className="kx-page-action" onClick={showSources}>
            <Icon name="filter" size={12} /> Show sources
          </button>
          <details className="kx-menu kx-source-more">
            <summary className="kx-icon-button" title="More" aria-label="More">
              <Icon name="more" size={14} />
            </summary>
            <div className="kx-menu-popover" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
              <button onClick={() => void newNote()}>New note about {kind === "person" ? "them" : "it"}</button>
              <button onClick={() => void copyItemLink([{ item: { kind, id }, title: name }])}>Copy link</button>
              {inOpenAlex && <button onClick={refresh}>Refresh from OpenAlex</button>}
            </div>
          </details>
        </header>
      }
      title={<h1 className="kx-note-title kx-entity-title">{name}</h1>}
    >
      {kind === "person" && <PersonDetails invoke={invoke} workspaceId={workspaceId} page={data as PersonPageData} onChanged={(next) => (next ? void load() : setData(null))} />}
      {kind === "venue" && <VenueDetails page={data as VenuePageData} />}
      {kind === "topic" && <TopicDetails page={data as TopicPageData} />}
      {kind !== "topic" && (
        <section className="kx-page-properties" aria-label="In your library">
          <Row label="In your library">
            <span>
              {total} {total === 1 ? "source" : "sources"}
              {kind === "person" ? years((data as PersonPageData).firstYear, (data as PersonPageData).lastYear) && ` · ${years((data as PersonPageData).firstYear, (data as PersonPageData).lastYear)}` : ""}
              {kind === "venue" ? years((data as VenuePageData).firstYear, (data as VenuePageData).lastYear) && ` · ${years((data as VenuePageData).firstYear, (data as VenuePageData).lastYear)}` : ""}
            </span>
          </Row>
        </section>
      )}
      {error && <p className="kx-inline-error">{error}</p>}

      <section className="kx-page-section" aria-label="Sources">
        <h3>
          Sources <span className="kx-count">{total}</span>
        </h3>
        <ul className="kx-work-list">
          {sources.map((s) => (
            <li key={s.id} data-in-library="true">
              <span>
                <button className="kx-work-title" onClick={(e) => openItemAt({ kind: "source", id: s.id }, e.altKey ? "split" : "tab", s.title)}>
                  {s.title || "Untitled"}
                </button>
                <small>{[shortCreators(s.creators), s.year, s.containerShort || s.containerTitle, s.retracted === 1 ? "Retracted" : ""].filter(Boolean).join(" · ")}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="kx-page-section" aria-label="Notes">
        <h3>Notes</h3>
        <button className="kx-page-action" onClick={() => void newNote()}>
          <Icon name="plus" size={12} /> New note about {kind === "person" ? "them" : "it"}
        </button>
      </section>
      <LinkedFrom invoke={invoke} workspaceId={workspaceId} item={{ kind, id }} />

      {inOpenAlex && (
        <section className="kx-page-section" aria-label="Citations by year">
          {extra === undefined || typeof extra === "string" ? (
            <button className="kx-page-action" onClick={askOpenAlex}>
              <Icon name="sparkle" size={12} /> {extra === "loading" ? "Asking OpenAlex…" : "Citations by year"}
            </button>
          ) : (
            <>
              <h3>Citations by year</h3>
              <YearBars counts={extra.countsByYear.map((c) => ({ year: c.year, n: c.cited_by_count ?? 0 }))} />
            </>
          )}
          {typeof extra === "string" && extra !== "loading" && <p className="kx-inline-error">{extra}</p>}
        </section>
      )}
    </ItemPage>
  );
}

function Metrics({ works, hIndex, cited, at }: { works?: number | null; hIndex?: number | null; cited?: number | null; at?: number | null }) {
  if (works == null && hIndex == null && cited == null) return null;
  return (
    <Row label="OpenAlex">
      <span>{[works != null && `${works.toLocaleString()} works`, hIndex != null && `h-index ${hIndex}`, cited != null && `${cited.toLocaleString()} citations`].filter(Boolean).join(" · ")}</span>
      <small title="These counts are cached and refreshed when the page is opened">updated {fetchedAgo(at)}</small>
    </Row>
  );
}

function PersonDetails({ invoke, workspaceId, page, onChanged }: { invoke: Invoke; workspaceId: string; page: PersonPageData; onChanged: (exists: boolean) => void }) {
  const { person } = page;
  const merge = async (keep: string, other: string) => {
    await invoke("store_merge_people", { keep, other }, workspaceId);
    libraryChanged();
    onChanged(keep === person.id);
    if (keep !== person.id) openItemAt({ kind: "person", id: keep }, "here");
  };
  const dismiss = async (a: string, b: string) => {
    await invoke("store_merge_dismiss", { personId: a, otherId: b }, workspaceId);
    onChanged(true);
  };
  return (
    <>
      {page.suggestions.map((s) => {
        const other = s.person.id === person.id ? s.other : s.person;
        return (
          <div className="kx-entity-merge" key={other.id} role="group" aria-label={`Possibly the same person as ${other.name}`}>
            <span>
              Might be the same person as{" "}
              <EntityLink entity={{ kind: "person", id: other.id, name: other.name }}>
                <strong>{other.name}</strong>
              </EntityLink>{" "}
              ({other.sourceCount} {other.sourceCount === 1 ? "source" : "sources"}
              {other.orcid ? `, ORCID ${other.orcid}` : ""}).
            </span>
            <button className="kx-page-action kx-page-action-primary" onClick={() => void merge(s.person.id, s.other.id)}>
              Merge
            </button>
            <button className="kx-page-action" onClick={() => void dismiss(s.person.id, s.other.id)}>
              Not the same
            </button>
          </div>
        );
      })}
      <section className="kx-page-properties" aria-label="Properties">
        {person.institution && (
          <Row label="Institution">
            <FilterLink filter={sourceFilter.institution(person.institution.id, person.institution.name)}>{person.institution.name}</FilterLink>
            {person.institution.country && <small>{person.institution.country}</small>}
          </Row>
        )}
        {person.orcid && (
          <Row label="ORCID">
            <a href={`https://orcid.org/${person.orcid}`} target="_blank" rel="noreferrer">
              {person.orcid}
            </a>
          </Row>
        )}
        <Metrics works={person.worksCount} hIndex={person.hIndex} cited={person.citedByCount} at={person.metricsAt} />
        {person.names.length > 0 && <Row label="Also written">{person.names.slice(0, 8).join(", ")}</Row>}
        {page.coauthors.length > 0 && (
          <Row label="Co-authors">
            <Linked kind="person" items={page.coauthors} />
          </Row>
        )}
        {page.venues.length > 0 && (
          <Row label="Journals">
            <Linked kind="venue" items={page.venues} />
          </Row>
        )}
        {page.topics.length > 0 && (
          <Row label="Topics">
            <Linked kind="topic" items={page.topics} />
          </Row>
        )}
      </section>
    </>
  );
}

function VenueDetails({ page }: { page: VenuePageData }) {
  const { venue } = page;
  return (
    <section className="kx-page-properties" aria-label="Properties">
      {venue.publisher && <Row label="Publisher">{venue.publisher.name}</Row>}
      {venue.issnL && <Row label="ISSN">{[venue.issnL, ...venue.issns.filter((i) => i !== venue.issnL)].join(", ")}</Row>}
      {venue.type && <Row label="Type">{venue.type}</Row>}
      {venue.isOa != null && <Row label="Access">{venue.isOa ? `Open access${venue.inDoaj ? " · in DOAJ" : ""}` : "Subscription"}</Row>}
      {venue.homepage && (
        <Row label="Home page">
          <a href={venue.homepage} target="_blank" rel="noreferrer">
            {venue.homepage.replace(/^https?:\/\//, "")}
          </a>
        </Row>
      )}
      <Metrics works={venue.worksCount} hIndex={venue.hIndex} cited={venue.citedByCount} at={venue.metricsAt} />
      {page.people.length > 0 && (
        <Row label="Authors">
          <Linked kind="person" items={page.people} />
        </Row>
      )}
      {page.topics.length > 0 && (
        <Row label="Topics">
          <Linked kind="topic" items={page.topics} />
        </Row>
      )}
    </section>
  );
}

function TopicDetails({ page }: { page: TopicPageData }) {
  const { topic } = page;
  return (
    <section className="kx-page-properties" aria-label="Properties">
      {topic.path.length > 0 && (
        <Row label="Within">
          {topic.path.map((t, i) => (
            <span key={t.id}>
              {i > 0 && "› "}
              <EntityLink entity={{ kind: "topic", id: t.id, name: t.name }}>{t.name}</EntityLink>
            </span>
          ))}
        </Row>
      )}
      <Row label="In your library">
        <span>
          {topic.sourceCount} {topic.sourceCount === 1 ? "source" : "sources"}
        </span>
      </Row>
      {page.children.length > 0 && (
        <Row label="Narrower">
          <Linked kind="topic" items={page.children} />
        </Row>
      )}
      {page.people.length > 0 && (
        <Row label="People">
          <Linked kind="person" items={page.people} />
        </Row>
      )}
      {page.venues.length > 0 && (
        <Row label="Journals">
          <Linked kind="venue" items={page.venues} />
        </Row>
      )}
    </section>
  );
}
