// Watches the tracked linked folders of the workspaces shown in windows and tells the host
// what changed (see key-store's linked.rs for the design). One recursive FSEvents watch per
// folder; changes are collected for a moment and sent as one `store_linked_sync` with the
// relative paths (the whole folder when there are many). A folder that disappears (an
// unmounted drive) is synced once, which marks it missing, then checked for every 15 s and
// synced in full when it is back. Nothing is watched for workspaces no window shows; they
// are synced in full when a window shows them again.
import { existsSync, watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import { dialog, type BrowserWindow } from "electron";

type Invoke = <T = unknown>(command: string, args: Record<string, unknown>, workspaceId: string) => Promise<T>;
type Folder = { id: string; path: string; tracked: boolean; missing: boolean };
type Watched = { folder: Folder; watcher?: FSWatcher; poll?: ReturnType<typeof setInterval>; paths: Set<string>; timer?: ReturnType<typeof setTimeout>; first?: number };

const SETTLE_MS = 400;
const MAX_WAIT_MS = 3000;
/** More changed paths than this are synced as the whole folder. */
const MAX_PATHS = 400;
const POLL_MS = 15_000;

/** Commands the renderer sends that change which folders are watched. */
const CHANGES_FOLDERS = new Set(["store_linked_link", "store_linked_set", "store_linked_unlink"]);

export class LinkedFolders {
  private watched = new Map<string, Map<string, Watched>>();
  private loading = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly invoke: Invoke,
    private readonly workspaces: () => string[],
    private readonly changed: (value: { workspaceId: string; folderId?: string }) => void,
  ) {
    // Cheap: compares window workspaces with what is watched; no disk access.
    this.timer = setInterval(() => this.follow(), 2000);
    this.timer.unref();
    setTimeout(() => this.follow(), 500).unref();
  }

  /** Commands handled here rather than passed to the host as they are. */
  handles(command: string) {
    return command === "linked_folder_choose" || CHANGES_FOLDERS.has(command);
  }

  async handle(command: string, args: any, workspaceId: string, window?: BrowserWindow): Promise<unknown> {
    if (command === "linked_folder_choose") {
      const options = { title: "Link a folder", buttonLabel: "Link Folder", properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
      const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (chosen.canceled || !chosen.filePaths[0]) return null;
      return this.handle("store_linked_link", { path: chosen.filePaths[0] }, workspaceId);
    }
    const result = await this.invoke<any>(command, args, workspaceId);
    await this.reload(workspaceId);
    this.changed({ workspaceId, folderId: result?.id ?? args?.id });
    return result;
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.watched.keys()]) this.stop(id);
  }

  private follow() {
    const shown = new Set(this.workspaces().filter(Boolean));
    for (const id of [...this.watched.keys()]) if (!shown.has(id)) this.stop(id);
    for (const id of shown) if (!this.watched.has(id) && !this.loading.has(id)) void this.reload(id, true);
  }

  /** Reads the workspace's folders and watches the tracked ones; `full` syncs each first. */
  private reload(workspaceId: string, full = false) {
    const running = (this.loading.get(workspaceId) ?? Promise.resolve()).then(async () => {
      let folders: Folder[];
      try {
        folders = await this.invoke<Folder[]>("store_linked_folders", {}, workspaceId);
      } catch {
        return;
      }
      if (!this.workspaces().includes(workspaceId)) return;
      const current = this.watched.get(workspaceId) ?? new Map<string, Watched>();
      this.watched.set(workspaceId, current);
      for (const [id, entry] of current) {
        const now = folders.find((f) => f.id === id);
        if (!now || !now.tracked || now.path !== entry.folder.path) this.unwatch(current, id);
      }
      for (const folder of folders.filter((f) => f.tracked)) {
        if (current.has(folder.id)) continue;
        const entry: Watched = { folder, paths: new Set() };
        current.set(folder.id, entry);
        // Changes made while nothing watched (the app closed, another workspace shown).
        if (full) await this.sync(workspaceId, entry, []);
        this.start(workspaceId, entry);
      }
    });
    const settled = running.finally(() => {
      if (this.loading.get(workspaceId) === settled) this.loading.delete(workspaceId);
    });
    this.loading.set(workspaceId, settled);
    return settled;
  }

  private start(workspaceId: string, entry: Watched) {
    if (!existsSync(entry.folder.path)) return this.poll(workspaceId, entry);
    try {
      entry.watcher = watch(entry.folder.path, { recursive: true, persistent: false }, (_event, name) => {
        const rel = typeof name === "string" ? name : name ? String(name) : "";
        // Hidden files (and Key's own `.name.key-saving` while writing) never matter.
        if (rel.split(/[\\/]/).some((part) => part.startsWith("."))) return;
        this.queue(workspaceId, entry, rel);
      });
      entry.watcher.on("error", () => {
        entry.watcher?.close();
        entry.watcher = undefined;
        void this.sync(workspaceId, entry, []).then(() => this.poll(workspaceId, entry));
      });
    } catch {
      this.poll(workspaceId, entry);
    }
  }

  /** Waits for a missing folder to come back. */
  private poll(workspaceId: string, entry: Watched) {
    if (entry.poll) return;
    entry.poll = setInterval(() => {
      if (!existsSync(entry.folder.path)) return;
      clearInterval(entry.poll);
      entry.poll = undefined;
      void this.sync(workspaceId, entry, []).then(() => this.start(workspaceId, entry));
    }, POLL_MS);
    entry.poll.unref();
  }

  private queue(workspaceId: string, entry: Watched, rel: string) {
    if (rel && !rel.startsWith("..")) entry.paths.add(rel.split(sep).join("/"));
    else entry.paths.add("");
    entry.first ??= Date.now();
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(SETTLE_MS, entry.first + MAX_WAIT_MS - Date.now()));
    entry.timer = setTimeout(() => {
      const paths = [...entry.paths];
      entry.paths.clear();
      entry.first = undefined;
      // The folder itself went away (renamed, unmounted): stop watching and wait for it.
      if (!existsSync(entry.folder.path)) {
        entry.watcher?.close();
        entry.watcher = undefined;
        void this.sync(workspaceId, entry, []).then(() => this.poll(workspaceId, entry));
        return;
      }
      void this.sync(workspaceId, entry, paths.includes("") || paths.length > MAX_PATHS ? [] : paths);
    }, wait);
  }

  private async sync(workspaceId: string, entry: Watched, paths: string[]) {
    try {
      const report = await this.invoke<{ added: number; changed: number; moved: number; removed: number; missing: boolean }>(
        "store_linked_sync",
        { id: entry.folder.id, paths },
        workspaceId,
      );
      const missingChanged = report.missing !== entry.folder.missing;
      entry.folder.missing = report.missing;
      if (report.added + report.changed + report.moved + report.removed > 0 || missingChanged) this.changed({ workspaceId, folderId: entry.folder.id });
    } catch (error) {
      console.warn("Linked folder sync failed", entry.folder.path, error);
    }
  }

  private unwatch(current: Map<string, Watched>, id: string) {
    const entry = current.get(id);
    if (!entry) return;
    entry.watcher?.close();
    clearInterval(entry.poll);
    clearTimeout(entry.timer);
    current.delete(id);
  }

  private stop(workspaceId: string) {
    const current = this.watched.get(workspaceId);
    if (current) for (const id of [...current.keys()]) this.unwatch(current, id);
    this.watched.delete(workspaceId);
  }
}
