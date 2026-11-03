// Possible duplicate people, one pair at a time: both side by side with what tells them apart
// (identifiers, institution, spellings, years, co-authors, journals and a few of their
// sources), the one to keep picked by clicking it, then Merge, Not the same or Skip.
// Nothing is merged unless the user says so (see key-store's graph.rs).
import { useCallback, useEffect, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { libraryChanged } from "./library-nav";
import { shortCreators, type Invoke, type MergeSuggestion, type Person, type PersonPageData, type Source, type SourcePage } from "./library-api";
import "./entity.css";

interface Profile {
  page: PersonPageData;
  sources: Source[];
}

function useProfile(invoke: Invoke, workspaceId: string, id: string) {
  const [profile, setProfile] = useState<Profile>();
  useEffect(() => {
    let live = true;
    setProfile(undefined);
    void Promise.all([
      invoke<PersonPageData | null>("store_person", { id }, workspaceId),
      invoke<SourcePage>("store_sources", { filters: [{ field: "person", op: "is", value: id }], sort: "year", descending: true, limit: 4 }, workspaceId),
    ])
      .then(([page, list]) => live && page && setProfile({ page, sources: list.items }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, id]);
  return profile;
}

function PersonCard({ invoke, workspaceId, person, keep, onKeep }: { invoke: Invoke; workspaceId: string; person: Person; keep: boolean; onKeep: () => void }) {
  const profile = useProfile(invoke, workspaceId, person.id);
  const page = profile?.page;
  const years = page?.firstYear && page.lastYear ? (page.firstYear === page.lastYear ? `${page.firstYear}` : `${page.firstYear}–${page.lastYear}`) : undefined;
  const facts: [string, string | undefined][] = [
    ["ORCID", person.orcid ?? undefined],
    ["Institution", person.institution?.name],
    ["Also written", person.names.length ? person.names.slice(0, 4).join(", ") : undefined],
    ["Co-authors", page?.coauthors.length ? page.coauthors.slice(0, 4).map((c) => c.name).join(", ") : undefined],
    ["Journals", page?.venues.length ? page.venues.slice(0, 3).map((v) => v.name).join(", ") : undefined],
  ];
  return (
    <button type="button" className="kx-merge-card" aria-pressed={keep} onClick={onKeep} title={keep ? "This one is kept" : "Keep this one"}>
      <span className="kx-merge-keep">{keep ? <><Icon name="check" size={11} /> Keep</> : "Keep this one"}</span>
      <strong className="kx-merge-name">{person.name}</strong>
      <span className="kx-merge-sub">
        {person.sourceCount} {person.sourceCount === 1 ? "source" : "sources"}
        {years && ` · ${years}`}
        {person.openalexId && " · in OpenAlex"}
      </span>
      <dl className="kx-merge-facts">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <ul className="kx-merge-sources" aria-label={`Sources by ${person.name}`}>
        {profile
          ? profile.sources.map((source) => (
              <li key={source.id}>
                <span className="kx-merge-source-title">{source.title || "Untitled"}</span>
                <small>{[shortCreators(source.creators), source.year, source.containerShort || source.containerTitle].filter(Boolean).join(" · ")}</small>
              </li>
            ))
          : [0, 1].map((i) => <li key={i} className="kx-skeleton-line" />)}
      </ul>
    </button>
  );
}

export default function MergeReview({ invoke, workspaceId, first, onClose }: { invoke: Invoke; workspaceId: string; first?: string; onClose: () => void }) {
  const [pairs, setPairs] = useState<MergeSuggestion[]>();
  const [index, setIndex] = useState(0);
  const [keepOther, setKeepOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => {
    void invoke<MergeSuggestion[]>("store_merge_suggestions", {}, workspaceId)
      .then((list) => {
        // The pair the user came from comes first.
        const at = first ? list.findIndex((s) => s.person.id === first || s.other.id === first) : -1;
        setPairs(at > 0 ? [list[at], ...list.slice(0, at), ...list.slice(at + 1)] : list);
      })
      .catch(() => setPairs([]));
  }, [invoke, workspaceId, first]);
  const pair = pairs?.[index];
  useEffect(() => setKeepOther(false), [index, pair?.person.id]);
  const next = useCallback(
    (drop: boolean) => {
      if (!pairs) return;
      if (drop) setPairs(pairs.filter((_, i) => i !== index));
      else setIndex(index + 1);
    },
    [pairs, index],
  );
  const answer = useCallback(
    async (merge: boolean) => {
      if (!pair || busy) return;
      setBusy(true);
      try {
        if (merge) {
          const [keep, other] = keepOther ? [pair.other, pair.person] : [pair.person, pair.other];
          await invoke("store_merge_people", { keep: keep.id, other: other.id }, workspaceId);
          libraryChanged();
        } else await invoke("store_merge_dismiss", { personId: pair.person.id, otherId: pair.other.id }, workspaceId);
        setDone((n) => n + 1);
        next(true);
      } finally {
        setBusy(false);
      }
    },
    [pair, busy, keepOther, invoke, workspaceId, next],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!pair || e.metaKey || e.ctrlKey) return;
      if (e.key === "Enter" || e.key === "m") void answer(true);
      else if (e.key === "n" || e.key === "Backspace") void answer(false);
      else if (e.key === "ArrowRight" || e.key === "s") next(false);
      else if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      else if (e.key === "Tab") setKeepOther((k) => !k);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pair, answer, next, index]);

  const remaining = pairs ? pairs.length : 0;
  return (
    <GlobalDrawer onClose={onClose} presentation="sheet" label="Possible duplicates">
      <div className="key-property-editor kx-merge-review" role="dialog" aria-label="Possible duplicates">
        <header>
          <h2>Possible duplicates</h2>
          <p>
            {!pairs
              ? "Looking…"
              : pair
                ? `${index + 1} of ${remaining} · ${pair.reason}. Nothing is merged unless you choose to.`
                : done
                  ? `All reviewed: ${done} ${done === 1 ? "answer" : "answers"}.`
                  : "Nothing to review."}
          </p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          {pair ? (
            <>
              <div className="kx-merge-pair">
                <PersonCard invoke={invoke} workspaceId={workspaceId} person={pair.person} keep={!keepOther} onKeep={() => setKeepOther(false)} />
                <span className="kx-merge-into" aria-hidden>
                  <Icon name="arrowRight" size={14} style={{ transform: keepOther ? "none" : "rotate(180deg)" }} />
                </span>
                <PersonCard invoke={invoke} workspaceId={workspaceId} person={pair.other} keep={keepOther} onKeep={() => setKeepOther(true)} />
              </div>
              <p className="kx-merge-explain">
                Merging puts every source of <strong>{(keepOther ? pair.person : pair.other).name}</strong> under <strong>{(keepOther ? pair.other : pair.person).name}</strong>
                ; that spelling is kept, and new sources written that way join them too.
              </p>
            </>
          ) : (
            pairs && (
              <div className="kx-merge-empty">
                <Icon name="check" size={18} />
                <span>{done ? "Every possible duplicate has an answer." : "No people look like duplicates right now."}</span>
              </div>
            )
          )}
        </div>
        <footer className="kx-merge-actions">
          {pair ? (
            <>
              <button className="kx-page-action" disabled={busy} onClick={() => next(false)} title="Decide later (→)">
                Skip
              </button>
              <span className="kx-spacer" />
              <button className="kx-page-action" disabled={busy} onClick={() => void answer(false)} title="They are different people (N)">
                Not the same
              </button>
              <button className="kx-page-action kx-page-action-primary" disabled={busy} onClick={() => void answer(true)} title="Merge into the kept one (Return)">
                Merge
              </button>
            </>
          ) : (
            <>
              <span className="kx-spacer" />
              <button className="kx-page-action kx-page-action-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </footer>
      </div>
    </GlobalDrawer>
  );
}
