import { useEffect, useState } from "react";
import type {
  LibrarySource,
  LibraryHit,
  LibraryHomeProps,
} from "./LibraryHome";
export default function SearchSourceMetadata({
  hit,
  invoke,
  workspaceId,
  onClose,
  onEdit,
}: {
  hit: LibraryHit;
  invoke: LibraryHomeProps["invoke"];
  workspaceId?: string;
  onClose: () => void;
  onEdit: (source: LibrarySource) => void;
}) {
  const [source, setSource] = useState<LibrarySource>();
  const [metadata, setMetadata] = useState<{
    tags: string[];
    collections: string[];
    properties: Record<string, unknown>;
  }>();
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    setSource(undefined);
    setMetadata(undefined);
    setError("");
    const scope = hit.workspaceId || workspaceId;
    void Promise.all([
      invoke<{ documents: LibrarySource[] }>(
        "semantic_library_page",
        { documentHashes: [hit.documentHash], offset: 0, limit: 1 },
        scope,
      ),
      invoke<{
        tags: string[];
        collections: string[];
        properties: Record<string, unknown>;
      }>("library_metadata_details", { hash: hit.documentHash }, scope),
    ])
      .then(([page, meta]) => {
        if (live) {
          setSource(page.documents[0]);
          setMetadata(meta);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [hit.documentHash, hit.workspaceId, workspaceId, invoke]);
  return (
    <aside
      className={`key-library-detail key-search-metadata ${expanded ? "metadata-expanded" : ""}`}
      aria-label="Source metadata"
    >
      <header>
        <strong>Source metadata</strong>
        <button aria-label="Close source metadata" onClick={onClose}>
          ×
        </button>
      </header>
      <h2>{source?.title || hit.documentTitle || "Document"}</h2>
      {error && <p role="alert">{error}</p>}
      <dl>
        <div>
          <dt>Authors</dt>
          <dd>{source?.authors?.join(", ") || "Not set"}</dd>
        </div>
        <div>
          <dt>Year</dt>
          <dd>{source?.year ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd>{source?.pageCount ?? "…"}</dd>
        </div>
        <div>
          <dt>Indexing</dt>
          <dd>{source?.status?.replaceAll("_", " ") || "…"}</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>{metadata?.tags.length ? metadata.tags.join(" · ") : "None"}</dd>
        </div>
        {metadata?.collections.length ? (
          <div>
            <dt>Collections</dt>
            <dd>{metadata.collections.join(" · ")}</dd>
          </div>
        ) : null}
        {Object.entries(metadata?.properties || {}).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {value === null
                ? "Empty"
                : typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value)}
            </dd>
          </div>
        ))}
      </dl>
      <button
        className="key-metadata-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Less metadata" : "All metadata"}
      </button>
      <button
        disabled={!source}
        onClick={() =>
          source &&
          onEdit({ ...source, workspaceId: hit.workspaceId || workspaceId })
        }
      >
        Edit source properties
      </button>
    </aside>
  );
}
