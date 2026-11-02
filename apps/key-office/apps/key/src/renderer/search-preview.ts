// The active search session as the main process reports it in each window's tab snapshot.
// The result bar itself lives in the PDF reader, floating under its toolbar.
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
