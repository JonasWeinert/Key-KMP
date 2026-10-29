import { useEffect, useState } from "react";
import type { LibrarySource } from "./LibraryHome";
import { Icon, type IconName } from "./icons";

type Workspace = { id: string; name: string; icon?: string; root: string };
type Counts = { all: number; searchable: number; processing: number; attention: number };

const greeting = (hour: number) =>
  hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
// Stable cover tint per document; the palette lives in native.css tokens.
const coverTone = (hash: string) => (parseInt(hash.slice(0, 6), 16) || 0) % 6;
const byline = (source: LibrarySource) => {
  const [first, ...rest] = source.authors || [];
  const who = first ? `${first.split(",")[0]}${rest.length ? " et al." : ""}` : "";
  return [who, source.year].filter(Boolean).join(" · ");
};
function statusChip(source: LibrarySource) {
  if (source.status === "indexed") return { tone: "ready", label: "Searchable" };
  if (["failed", "needs_source", "no_text"].includes(source.status))
    return { tone: "attention", label: source.status === "no_text" ? "No text" : "Needs attention" };
  if (source.status === "paused") return { tone: "idle", label: "Paused" };
  if (source.status === "queued") return { tone: "idle", label: "Queued" };
  return { tone: "busy", label: "Indexing" };
}

export default function HomeView({
  workspaces,
  active,
  invoke,
  action,
  openSource,
  importSources,
  refreshKey,
}: {
  workspaces: Workspace[];
  active: boolean;
  invoke: <T>(
    command: string,
    args?: Record<string, unknown>,
    workspaceId?: string,
  ) => Promise<T>;
  action: (name: string, args: Record<string, unknown>) => void;
  openSource: (source: LibrarySource) => void;
  importSources: (workspaceId: string) => void;
  refreshKey?: number;
}) {
  const [choice, setChoice] = useState("");
  const workspace = workspaces.find((w) => w.id === choice) || workspaces[0];
  const [recent, setRecent] = useState<LibrarySource[]>([]);
  const [summary, setSummary] = useState<{ total: number; counts?: Counts }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const now = new Date();
  useEffect(() => {
    setRecent([]);
    setSummary(undefined);
  }, [workspace?.id]);
  useEffect(() => {
    if (!active || !workspace) return;
    let current = true;
    setError("");
    setLoading(true);
    invoke<{ documents: LibrarySource[]; total: number; counts?: Counts }>(
      "semantic_library_page",
      { limit: 6, offset: 0, sort: "updated" },
      workspace.id,
    )
      .then((page) => {
        if (!current) return;
        setRecent(page.documents.map((d) => ({ ...d, workspaceId: workspace.id })));
        setSummary({ total: page.total, counts: page.counts });
      })
      .catch((e) => {
        if (current) setError(String(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [workspace?.id, active, invoke, refreshKey]);
  const total = summary?.total ?? 0,
    searchable = summary?.counts?.searchable ?? recent.filter((d) => d.status === "indexed").length,
    processing = summary?.counts?.processing ?? 0;
  const actions: { label: string; hint: string; icon: IconName; tone: string; run: () => void; disabled?: boolean }[] = [
    {
      label: "Import PDFs",
      hint: "Add papers from your Mac",
      icon: "upload",
      tone: "blue",
      disabled: !workspace,
      run: () => workspace && importSources(workspace.id),
    },
    {
      label: "New document",
      hint: "Write in your workspace",
      icon: "doc",
      tone: "indigo",
      disabled: !workspace,
      run: () => action("create-office", { kind: "docs", workspaceId: workspace?.id }),
    },
    {
      label: "New note",
      hint: "Capture a quick thought",
      icon: "note",
      tone: "amber",
      disabled: !workspace,
      run: () =>
        action("open-content", {
          section: "record",
          workspaceId: workspace?.id,
          record: { id: "", kind: "note", title: "", body: "", properties: {}, revision: 0 },
        }),
    },
    {
      label: "Sources",
      hint: "Browse your library",
      icon: "books",
      tone: "green",
      run: () => action("open-content", { section: "sources", workspaceId: workspace?.id }),
    },
  ];
  return (
    <section className="kx-home" aria-label="Home">
      <div className="kx-home-inner">
        <header className="kx-home-hero">
          <div>
            <p className="kx-eyebrow">
              {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <h1>{greeting(now.getHours())}</h1>
            <p className="kx-home-sub">
              {!workspace
                ? "Add a workspace to start your library."
                : summary
                  ? total
                    ? `${total.toLocaleString()} source${total === 1 ? "" : "s"} in ${workspace.name} · ${searchable.toLocaleString()} ready to search`
                    : `${workspace.name} is ready for its first source.`
                  : `Opening ${workspace.name}…`}
            </p>
          </div>
          {workspaces.length > 1 && (
            <label className="kx-pill-select">
              <span className="kx-visually-hidden">Workspace</span>
              <select
                id="home-workspace"
                value={workspace?.id || ""}
                onChange={(e) => setChoice(e.target.value)}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <Icon name="chevronUpDown" size={13} />
            </label>
          )}
        </header>
        <div className="kx-home-actions">
          {actions.map((a) => (
            <button key={a.label} disabled={a.disabled} onClick={a.run} data-tone={a.tone}>
              <span className="kx-tile-icon">
                <Icon name={a.icon} size={17} />
              </span>
              <strong>{a.label}</strong>
              <span>{a.hint}</span>
            </button>
          ))}
        </div>
        {processing > 0 && total > 0 && (
          <div className="kx-home-progress" role="status">
            <div>
              <strong>
                Indexing {processing.toLocaleString()} source{processing === 1 ? "" : "s"}
              </strong>
              <span>Full-text search becomes available as each source finishes.</span>
            </div>
            <div className="kx-meter" aria-hidden="true">
              <span style={{ width: `${Math.round((searchable / total) * 100)}%` }} />
            </div>
            <small>
              {searchable} of {total} ready
            </small>
          </div>
        )}
        <div className="kx-section-head">
          <h2>Recently updated</h2>
          <button
            className="kx-link-button"
            onClick={() => action("open-content", { section: "sources" })}
          >
            Browse all sources
            <Icon name="arrowRight" size={13} />
          </button>
        </div>
        {error ? (
          <p className="kx-inline-error" role="alert">
            {error}
          </p>
        ) : loading && !recent.length ? (
          <div className="kx-cover-grid" role="status" aria-label="Loading sources">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="kx-cover-card kx-skeleton">
                <span className="kx-cover" />
                <span className="kx-skeleton-line" />
                <span className="kx-skeleton-line short" />
              </div>
            ))}
          </div>
        ) : recent.length ? (
          <ul className="kx-cover-grid">
            {recent.map((source) => {
              const chip = statusChip(source);
              return (
                <li key={source.documentHash}>
                  <button className="kx-cover-card" onClick={() => openSource(source)} title={source.title}>
                    <span className="kx-cover" data-tone={coverTone(source.documentHash)} aria-hidden="true">
                      <span className="kx-cover-kind">PDF</span>
                      <span className="kx-cover-title">{source.title.replace(/\.pdf$/i, "").replace(/_+/g, " ")}</span>
                      {source.pageCount > 0 && <span className="kx-cover-pages">{source.pageCount} pp.</span>}
                    </span>
                    <strong>{source.title}</strong>
                    <span className="kx-cover-meta">
                      <span className="kx-status-dot" data-tone={chip.tone} />
                      {byline(source) || chip.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="kx-empty-hero">
            <span className="kx-empty-icon">
              <Icon name="books" size={22} />
            </span>
            <h3>Your library starts here</h3>
            <p>Import a PDF to read, annotate and search it. Your sources stay in your workspace on this Mac.</p>
            {workspace && (
              <button className="kx-button-primary" onClick={() => importSources(workspace.id)}>
                <Icon name="upload" size={14} />
                Import PDFs…
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
