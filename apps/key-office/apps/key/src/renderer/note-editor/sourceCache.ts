import type { SourceRef } from "./types";

// Resolved sources, shared by every note editor. Serialisation is synchronous,
// so the source-embed fallback line is written from whatever is cached here.

const cache = new Map<string, SourceRef | null>();
const pending = new Map<string, Promise<SourceRef | null>>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** undefined: not looked up yet; null: lookup finished without a result. */
export function peekSource(id: string): SourceRef | null | undefined {
  return cache.get(id);
}

export function rememberSource(ref: SourceRef) {
  cache.set(ref.id, ref);
  notify();
}

export function resolveSourceCached(
  id: string,
  resolve: (id: string) => Promise<SourceRef | undefined>,
): Promise<SourceRef | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  const running = pending.get(id);
  if (running) return running;
  const job = resolve(id)
    .then((ref) => ref ?? null)
    .catch(() => null)
    .then((ref) => {
      pending.delete(id);
      cache.set(id, ref);
      notify();
      return ref;
    });
  pending.set(id, job);
  return job;
}

export function subscribeSources(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Human-readable line, e.g. "Palma et al. 2022 — Health versus income amid COVID-19". */
export function sourceLine(ref: SourceRef): string {
  return ref.detail ? `${ref.detail} — ${ref.title}` : ref.title;
}

/** Short label for a mention chip. */
export function mentionLabel(ref: SourceRef): string {
  // A source's "Palma et al. 2022"; anything the item picker found goes by its title.
  const pick = !ref.itemKind && ref.detail && ref.detail.length <= 48 ? ref.detail : ref.title;
  return pick.length > 60 ? `${pick.slice(0, 57).trimEnd()}…` : pick;
}
