import { mkdir, open, readFile, rename } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Enough to open a view again: never its live content or drafts. */
export type SavedView =
  | { type: "home" }
  | {
      type: "content";
      section: "sources" | "records" | "record" | "note" | "source" | "canvas" | "search";
      workspaceId?: string;
      projectId?: string;
      noteId?: string;
      canvasId?: string;
      sourceId?: string;
      recordId?: string;
      title: string;
    }
  | { type: "pdf"; workspaceId: string; hash: string; title: string }
  | { type: "office"; kind: string; path: string; workspaceId?: string };
export type SavedLayout =
  | { view: SavedView }
  | { split: "row" | "column"; ratio: number; a: SavedLayout; b: SavedLayout };
export interface SavedTabs {
  /** Each tab's layout, and which of its panes (in reading order) had focus. */
  tabs: { layout: SavedLayout; active: number }[];
  active: number;
}
export interface SavedWindow {
  workspaceId: string;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  fullScreen?: boolean;
  sidebarWidth?: number;
  tabs: SavedTabs;
}
export interface WindowState {
  version: 1;
  /** Open windows, front-most first. */
  windows: SavedWindow[];
  /** The arrangement last left behind in each workspace, for switching back. */
  layouts: Record<string, SavedTabs>;
  /** Workspace ids, most recently used first. */
  recent: string[];
}

const empty = (): WindowState => ({ version: 1, windows: [], layouts: {}, recent: [] });
const MAX_DEPTH = 8;

function validLayout(value: any, depth = 0): value is SavedLayout {
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return false;
  if ("view" in value) return !!value.view && typeof value.view === "object" && typeof value.view.type === "string";
  return (
    (value.split === "row" || value.split === "column") &&
    Number.isFinite(value.ratio) &&
    validLayout(value.a, depth + 1) &&
    validLayout(value.b, depth + 1)
  );
}
function validTabs(value: any): value is SavedTabs {
  return (
    !!value &&
    Array.isArray(value.tabs) &&
    value.tabs.length <= 200 &&
    value.tabs.every((t: any) => t && validLayout(t.layout) && Number.isInteger(t.active))
  );
}

/** `window-state.json`: written atomically shortly after changes, and synchronously at quit. */
export class WindowStateStore {
  private state = empty();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => WindowState;
  constructor(private readonly file: string) {}
  async load(): Promise<WindowState> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data?.version !== 1) throw Error("Unknown window state version");
      this.state = {
        version: 1,
        windows: (Array.isArray(data.windows) ? data.windows : [])
          .filter((w: any) => w && typeof w.workspaceId === "string" && validTabs(w.tabs))
          .slice(0, 16),
        layouts: Object.fromEntries(
          Object.entries(data.layouts ?? {}).filter(([id, tabs]) => typeof id === "string" && validTabs(tabs)),
        ) as Record<string, SavedTabs>,
        recent: (Array.isArray(data.recent) ? data.recent : []).filter((id: unknown) => typeof id === "string").slice(0, 32),
      };
    } catch {
      // A missing or unreadable file starts fresh; it is only a convenience.
      this.state = empty();
    }
    return this.get();
  }
  get(): WindowState {
    return structuredClone(this.state);
  }
  /** Replaces the state; `build` runs when the debounced write happens, so it sees the latest windows. */
  schedule(build: () => WindowState) {
    this.pending = build;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }
  async flush() {
    clearTimeout(this.timer);
    const build = this.pending;
    this.pending = undefined;
    if (!build) return;
    this.state = build();
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.state));
    } finally {
      await handle.close();
    }
    await rename(temp, this.file);
  }
  /** At quit there is no time for async work. */
  writeNow(state: WindowState) {
    clearTimeout(this.timer);
    this.pending = undefined;
    this.state = state;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      // Losing the arrangement must never block quitting.
    }
  }
}
