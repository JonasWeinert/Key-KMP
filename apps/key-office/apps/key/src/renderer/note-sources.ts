// How notes reach the library: find sources for @-links and embeds, describe them for
// cards and quotes, and open them (at a page when a quote has one).
import { bridge, shortCreators, type Invoke, type Source, type SourcePage } from "./library-api";
import type { SourceRef } from "./note-editor";

type OpenSource = (source: unknown, hit?: unknown) => Promise<unknown>;

export function sourceRef(source: Source): SourceRef {
  return {
    id: source.id,
    title: source.title || "Untitled",
    detail: [shortCreators(source.creators), source.year].filter(Boolean).join(" "),
    kind: source.kind,
  };
}

export function noteSources(invoke: Invoke, workspaceId: string) {
  const cache = new Map<string, Promise<Source | undefined>>();
  const load = (id: string) => {
    if (!cache.has(id)) cache.set(id, invoke<Source | null>("store_source", { id }, workspaceId).then((s) => s ?? undefined).catch(() => undefined));
    return cache.get(id)!;
  };
  return {
    searchSources: async (query: string): Promise<SourceRef[]> => {
      const page = await invoke<SourcePage>("store_sources", { text: query.trim() || null, limit: 8, offset: 0, sort: query.trim() ? "title" : "added", descending: !query.trim() }, workspaceId);
      return page.items.map(sourceRef);
    },
    resolveSource: async (id: string) => {
      const source = await load(id);
      return source && sourceRef(source);
    },
    onOpenSource: (id: string, page?: number, annotationId?: string) => {
      void (async () => {
        const source = await load(id);
        if (!source) return;
        if (source.filePath && source.kind === "pdf") {
          const documentHash = source.fileHash ?? source.id;
          const key = (window as unknown as { key: { openSource: OpenSource; tabAction(action: string, payload?: unknown): Promise<unknown> } }).key;
          await key.openSource({
            documentId: documentHash,
            documentHash,
            title: source.title || "Untitled",
            status: "indexed",
            pageCount: source.pageCount ?? 0,
            completed: 0,
            total: 0,
            workspaceId,
          });
          // A place in the PDF (a highlight or a quoted page): scroll there and light it up.
          if (page !== undefined || annotationId) await key.tabAction("reader-focus", { workspaceId, documentHash, page, annotationId });
        } else if (source.filePath) await bridge().openPath(source.filePath);
        else if (source.url || source.doi) window.open(source.url || `https://doi.org/${source.doi}`, "_blank");
      })();
    },
  };
}
