import { Button } from "@key/design-system";
export interface SearchPreviewState {
  sourceViewId: string;
  previewViewId?: string;
  index: number;
  total: number;
  query: string;
  busy: boolean;
  error?: string;
  hit?: {
    id: string;
    documentHash: string;
    documentTitle?: string;
    workspaceId: string;
    page: number;
  };
}
export default function SearchPreviewBar({
  preview,
  action,
}: {
  preview: SearchPreviewState;
  action: (name: string, payload?: Record<string, unknown>) => void;
}) {
  return (
    <div className="key-search-session" aria-label="Search result navigation">
      <Button
        className="key-search-session-origin"
        title="Focus the results list"
        onClick={() => action("preview-focus-list")}
      >
        <span aria-hidden="true">⌕</span>{" "}
        {preview.query ? `“${preview.query}”` : "Search results"}
      </Button>
      <span
        className="key-search-session-document"
        title={preview.hit?.documentTitle}
      >
        {preview.busy
          ? "Opening passage…"
          : preview.error ||
            `${preview.hit?.documentTitle || "PDF"} · Page ${(preview.hit?.page ?? 0) + 1}`}
      </span>
      <div className="key-search-session-controls">
        <Button
          aria-label="Previous result"
          title="Previous result"
          disabled={preview.busy || preview.index <= 0}
          onClick={() => action("preview-step", { direction: -1 })}
        >
          ↑
        </Button>
        <span role="status">
          {preview.index + 1} / {preview.total}
          <span className="key-search-session-loaded"> loaded results</span>
        </span>
        <Button
          aria-label="Next result"
          title="Next result"
          disabled={preview.busy || preview.index >= preview.total - 1}
          onClick={() => action("preview-step", { direction: 1 })}
        >
          ↓
        </Button>
        <Button
          aria-label="Dismiss search navigation"
          title="Dismiss search navigation — keep this split"
          onClick={() =>
            action("preview-dismiss", { sourceViewId: preview.sourceViewId })
          }
        >
          ×
        </Button>
      </div>
    </div>
  );
}
