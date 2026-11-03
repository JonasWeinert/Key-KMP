// What a source cites and what in the library cites it. One list for the PDF's own
// bibliography and OpenAlex's: works in the library link to their page; the others are
// faint, with Add to put them in the library in one click. Related works come from OpenAlex
// when asked for and are not stored.
import { useState } from "react";
import { Icon } from "./icons";
import { openItemAt } from "./item-actions";
import { itemAttrs } from "./item-ui";
import { libraryChanged } from "./library-nav";
import type { Invoke, OpenAlexExtra, SourceGraph, WorkReference } from "./library-api";
import "./entity.css";

const SHOWN = 12;

type Work = Pick<WorkReference, "title" | "byline" | "year" | "container" | "doi" | "openalexId" | "matchedSourceId" | "text">;

function WorkRow({ work, onAdd }: { work: Work; onAdd?: () => void }) {
  const title = work.title || work.text || work.doi || "Untitled work";
  const detail = [work.byline, work.year, work.container].filter(Boolean).join(" · ");
  const inLibrary = !!work.matchedSourceId;
  return (
    <li data-in-library={inLibrary} {...(inLibrary ? itemAttrs({ kind: "source", id: work.matchedSourceId!, title }) : {})}>
      <span>
        {inLibrary ? (
          <button className="kx-work-title" onClick={(e) => openItemAt({ kind: "source", id: work.matchedSourceId! }, e.altKey ? "split" : "tab", title)}>
            {title}
          </button>
        ) : (
          <span className="kx-work-title" title="Not in your library">
            {title}
          </span>
        )}
        {detail && <small>{detail}</small>}
      </span>
      {!inLibrary && onAdd && (
        <button className="kx-work-add" onClick={onAdd} aria-label={`Add “${title}” to the library`}>
          Add
        </button>
      )}
    </li>
  );
}

export function WorkReferences({ invoke, workspaceId, sourceId, graph, hasWork, onChanged }: { invoke: Invoke; workspaceId: string; sourceId: string; graph: SourceGraph; hasWork: boolean; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [extra, setExtra] = useState<OpenAlexExtra | "loading" | string>();
  const add = async (work: Work) => {
    if (!work.openalexId) return;
    await invoke("store_add_work", { openalexId: work.openalexId, title: work.title, doi: work.doi, year: work.year }, workspaceId);
    libraryChanged();
    onChanged();
  };
  // Works already in the library first, each group in the bibliography's order.
  const references = [...graph.references.filter((r) => r.matchedSourceId), ...graph.references.filter((r) => !r.matchedSourceId)];
  const inLibrary = references.filter((r) => r.matchedSourceId).length;
  const shown = all ? references : references.slice(0, SHOWN);
  return (
    <>
      {references.length > 0 && (
        <section className="kx-page-section kx-work-references" aria-label="References">
          <h3>
            References <span className="kx-count">{references.length}</span>
            {inLibrary > 0 && <span className="kx-count"> · {inLibrary} in your library</span>}
          </h3>
          <ul className="kx-work-list">
            {shown.map((work) => (
              <WorkRow key={`${work.origin}:${work.seq}`} work={work} onAdd={work.openalexId ? () => void add(work) : undefined} />
            ))}
          </ul>
          {references.length > SHOWN && (
            <button className="kx-page-parts-hint kx-work-more" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${references.length}`}
            </button>
          )}
        </section>
      )}
      {graph.citedBy.length > 0 && (
        <section className="kx-page-section" aria-label="Cited by">
          <h3>
            Cited by in your library <span className="kx-count">{graph.citedBy.length}</span>
          </h3>
          <ul className="kx-work-list">
            {graph.citedBy.map((s) => (
              <WorkRow key={s.id} work={{ title: s.title, year: s.year, matchedSourceId: s.id }} />
            ))}
          </ul>
        </section>
      )}
      {hasWork && (
        <section className="kx-page-section" aria-label="Related works">
          {extra === undefined || typeof extra === "string" ? (
            <button
              className="kx-page-action"
              onClick={() => {
                setExtra("loading");
                void invoke<OpenAlexExtra>("store_openalex_extra", { kind: "source", id: sourceId }, workspaceId)
                  .then(setExtra)
                  .catch((e) => setExtra(String(e).replace(/^Error: /, "")));
              }}
            >
              <Icon name="sparkle" size={12} /> {extra === "loading" ? "Asking OpenAlex…" : "Related works and citations by year"}
            </button>
          ) : (
            <>
              <h3>Citations by year</h3>
              <YearBars counts={extra.countsByYear.map((c) => ({ year: c.year, n: c.cited_by_count ?? 0 }))} />
              {extra.related.length > 0 && (
                <>
                  <h3>
                    Related works <span className="kx-count">{extra.related.length}</span>
                  </h3>
                  <ul className="kx-work-list">
                    {extra.related.map((work) => (
                      <WorkRow key={work.openalexId} work={work} onAdd={() => void add(work)} />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          {typeof extra === "string" && extra !== "loading" && <p className="kx-inline-error">{extra}</p>}
        </section>
      )}
    </>
  );
}

/** A small bar per year, oldest first. */
export function YearBars({ counts }: { counts: { year: number; n: number }[] }) {
  const sorted = [...counts].sort((a, b) => a.year - b.year);
  if (!sorted.length) return <p className="kx-page-parts-hint">No counts yet.</p>;
  const max = Math.max(1, ...sorted.map((c) => c.n));
  return (
    <>
      <div className="kx-year-bars" role="img" aria-label={sorted.map((c) => `${c.year}: ${c.n}`).join(", ")}>
        {sorted.map((c) => (
          <span key={c.year} style={{ height: `${(c.n / max) * 100}%` }} title={`${c.year}: ${c.n}`} />
        ))}
      </div>
      <div className="kx-year-axis">
        <span>{sorted[0].year}</span>
        <span>{sorted.at(-1)!.year}</span>
      </div>
    </>
  );
}
