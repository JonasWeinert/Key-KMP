import { useEffect, useState } from "react";
import type { LibrarySource } from "./LibraryHome";

type Workspace = { id: string; name: string; icon?: string; root: string };
export default function HomeView({
  workspaces,
  active,
  invoke,
  action,
  openSource,
  importSources,
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
}) {
  const [choice, setChoice] = useState("");
  const workspace = workspaces.find((w) => w.id === choice) || workspaces[0];
  const [recent, setRecent] = useState<LibrarySource[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active || !workspace) return;
    let current = true;
    setRecent([]);
    setError("");
    setLoading(true);
    invoke<{ documents: LibrarySource[] }>(
      "semantic_library_page",
      { limit: 6, offset: 0, sort: "updated" },
      workspace.id,
    )
      .then((page) => {
        if (current)
          setRecent(
            page.documents.map((d) => ({ ...d, workspaceId: workspace.id })),
          );
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
  }, [workspace?.id, active, invoke]);
  return (
    <section className="key-home" aria-label="Home">
      <header className="key-home-header">
        <span className="key-home-mark" aria-hidden="true">
          K
        </span>
        <div>
          <h1>Home</h1>
          <p>A place for your reading and research.</p>
        </div>
      </header>
      <div className="key-home-workspace">
        <label htmlFor="home-workspace">Workspace</label>
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
        <span>Saved on this Mac</span>
      </div>
      <div className="key-home-actions">
        <button
          onClick={() =>
            action("open-content", {
              section: "sources",
              workspaceId: workspace?.id,
            })
          }
        >
          <strong>Sources</strong>
          <span>Browse your research library</span>
          <span aria-hidden="true">→</span>
        </button>
        <button
          disabled={!workspace}
          onClick={() => workspace && importSources(workspace.id)}
        >
          <strong>Import PDFs…</strong>
          <span>Add papers from your Mac</span>
          <span aria-hidden="true">＋</span>
        </button>
        <button
          disabled={!workspace}
          onClick={() =>
            action("create-office", {
              kind: "docs",
              workspaceId: workspace?.id,
            })
          }
        >
          <strong>New document</strong>
          <span>Start writing in your workspace</span>
          <span aria-hidden="true">＋</span>
        </button>
      </div>
      <div className="key-home-section-title">
        <h2>Recently updated</h2>
        <button onClick={() => action("open-content", { section: "sources" })}>
          Browse all sources
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : loading ? (
        <p role="status">Loading sources…</p>
      ) : recent.length ? (
        <ul className="key-home-recents">
          {recent.map((source) => (
            <li key={source.documentHash}>
              <button onClick={() => openSource(source)}>
                <span className="key-home-file-icon" aria-hidden="true">
                  PDF
                </span>
                <span>
                  <strong>{source.title}</strong>
                  <small>
                    {workspace?.name} ·{" "}
                    {source.pageCount
                      ? `${source.pageCount} pages`
                      : "Processing PDF…"}
                  </small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="key-home-empty">
          <h3>Your library starts here</h3>
          <p>
            Import a PDF to read, annotate, and search it. Your sources stay in
            your workspace.
          </p>
        </div>
      )}
    </section>
  );
}
