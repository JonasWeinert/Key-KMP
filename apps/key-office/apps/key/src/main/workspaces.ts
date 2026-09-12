import { mkdir, open, readFile, realpath, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RustHost, type InvokeOptions } from './rust-bridge'

export interface WorkspaceInfo {
  id: string
  name: string
  root: string
  icon?: string
  color?: string
}
export interface RegistryOptions {
  registryDir: string
  defaultWorkspaceParent: string
  hostExecutable: string
  pdfiumPath?: string
}
type SearchPage = {
  hits: Record<string, unknown>[]
  nextCursor: string | null
  capped: boolean
}
const LIST_COMMANDS = new Set([
  'semantic_library',
  'workspace_projects',
  'workspace_records',
  'workspace_linked_folders',
  'library_removed_documents',
])
/** Registry JSON locates workspaces; canonical identity and all content stay in each SQLite DB. */
export class Registry {
  private entries: WorkspaceInfo[] = []
  private hosts = new Map<string, RustHost>()
  private lastUsed = new Map<string, number>()
  private retiring = false
  private idleTimer: ReturnType<typeof setInterval>
  private ready: Promise<void>
  private mutations: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private readonly options: RegistryOptions) {
    this.ready = this.load()
    this.idleTimer = setInterval(() => {
      void this.retireIdle()
    }, 30_000)
    this.idleTimer.unref()
  }
  private async load(): Promise<void> {
    await mkdir(this.options.registryDir, { recursive: true })
    try {
      const data = JSON.parse(
        await readFile(join(this.options.registryDir, 'workspaces.json'), 'utf8'),
      ) as { version: number; workspaces: WorkspaceInfo[] }
      if (
        data.version !== 1 ||
        !Array.isArray(data.workspaces) ||
        data.workspaces.length > 128 ||
        data.workspaces.some(
          (w) =>
            !w ||
            typeof w.id !== 'string' ||
            typeof w.root !== 'string' ||
            typeof w.name !== 'string' ||
            resolve(w.root) !== w.root,
        )
      )
        throw new Error('Invalid workspace registry')
      if (
        new Set(data.workspaces.map((w) => w.id)).size !== data.workspaces.length ||
        new Set(data.workspaces.map((w) => w.root)).size !== data.workspaces.length
      )
        throw new Error('Duplicate workspace registry entries')
      this.entries = data.workspaces
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  private async persist(): Promise<void> {
    const temp = join(this.options.registryDir, `workspaces.${process.pid}.tmp`)
    const file = await open(temp, 'w', 0o600)
    try {
      await file.writeFile(JSON.stringify({ version: 1, workspaces: this.entries }, null, 2))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, join(this.options.registryDir, 'workspaces.json'))
    const directory = await open(this.options.registryDir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  async list(): Promise<WorkspaceInfo[]> {
    await this.ready
    if (!this.entries.length)
      await this.add(join(this.options.defaultWorkspaceParent, 'Personal'), 'Personal')
    return this.entries.map((w) => ({ ...w }))
  }
  async setAppearance(
    id: string,
    icon: string,
    color: string,
  ): Promise<WorkspaceInfo> {
    const action = async () => {
      await this.ready;
      const workspace = this.entries.find((w) => w.id === id);
      if (!workspace) throw Error("Choose a workspace");
      const updated = await this.host(workspace).invoke<WorkspaceInfo>(
        "workspace_set_appearance",
        { icon, color },
      );
      // The SQLite identity is authoritative; registry keeps a lightweight display cache.
      Object.assign(workspace, { icon: updated.icon, color: updated.color });
      await this.persist();
      return { ...workspace };
    };
    const result = this.mutations.then(action, action);
    this.mutations = result.catch(() => undefined);
    return result;
  }
  async add(root: string, name: string): Promise<WorkspaceInfo> {
    const action = async (): Promise<WorkspaceInfo> => {
      await this.ready
      if (this.closed) throw new Error('Workspace registry is closed')
      if (!name.trim() || name.length > 256) throw new Error('Enter a workspace name')
      await mkdir(resolve(root), { recursive: true })
      const canonical = await realpath(resolve(root))
      const known = this.entries.find((w) => w.root === canonical)
      if (known) return { ...known }
      if (this.entries.length >= 128)
        throw new Error('Workspace registry supports at most 128 folders')
      const host = new RustHost({
        executable: this.options.hostExecutable,
        libraryRoot: join(canonical, '.key'),
        pdfiumPath: this.options.pdfiumPath,
      })
      try {
        const info = await host.invoke<WorkspaceInfo>('workspace_initialize', {
          name: name.trim(),
          workspaceRoot: canonical,
        })
        if (this.closed) throw new Error('Workspace registry is closed')
        if (this.entries.some((w) => w.id === info.id))
          throw new Error(
            'This copied workspace has the same identity as an existing workspace; open the original',
          )
        // Resolve against the opened path rather than trusting a stale root stored in a moved database.
        const entry = { ...info, root: canonical }
        this.entries.push(entry)
        try {
          await this.persist()
        } catch (error) {
          this.entries.pop()
          throw error
        }
        this.hosts.set(entry.id, host)
        this.lastUsed.set(entry.id, Date.now())
        return { ...entry }
      } catch (error) {
        host.close()
        throw error
      }
    }
    const result = this.mutations.then(action, action)
    this.mutations = result.catch(() => undefined)
    return result
  }
  private host(workspace: WorkspaceInfo): RustHost {
    if (this.closed) throw new Error('Workspace registry is closed')
    this.lastUsed.set(workspace.id, Math.max(this.lastUsed.get(workspace.id) ?? 0, Date.now()))
    let host = this.hosts.get(workspace.id)
    if (!host) {
      host = new RustHost({
        executable: this.options.hostExecutable,
        libraryRoot: join(workspace.root, '.key'),
        pdfiumPath: this.options.pdfiumPath,
      })
      this.hosts.set(workspace.id, host)
    }
    return host
  }
  private scopedArgs(workspace: WorkspaceInfo, args: Record<string, unknown>) {
    if (!Array.isArray(args.documentKeys)) return args
    const hashes = args.documentKeys
      .filter((key): key is string => typeof key === 'string' && key.startsWith(workspace.id + ':'))
      .map((key) => key.slice(workspace.id.length + 1))
    return {
      ...args,
      documentHashes: hashes,
      filter: {
        ...(typeof args.filter === 'object' && args.filter !== null ? args.filter : {}),
        documentHashes: hashes,
      },
    }
  }
  async invoke<T = any>(
    command: string,
    args: Record<string, unknown> = {},
    workspaceId?: string,
    options: InvokeOptions = {},
  ): Promise<T> {
    const entries = await this.list()
    const clean = { ...args }
    if (
      clean.projectId &&
      ['global_search', 'global_search_page', 'semantic_library', 'semantic_library_page'].includes(
        command,
      )
    ) {
      clean.filter = {
        ...(typeof clean.filter === 'object' && clean.filter !== null ? clean.filter : {}),
        projectId: clean.projectId,
      }
    }
    // Reserved transport keys are removed from command arguments and never JSON-encode PDF bytes.
    const binary = clean.__binary as Uint8Array | undefined
    const headers = clean.__headers as Record<string, string> | undefined
    delete clean.__binary
    delete clean.__headers
    const transport = {
      ...options,
      binary: options.binary ?? binary,
      headers: options.headers ?? headers,
    }
    if (workspaceId && workspaceId !== 'all') {
      const workspace = entries.find((w) => w.id === workspaceId)
      if (!workspace) throw new Error('Workspace is not registered')
      const value = await this.host(workspace).invoke(
        command,
        this.scopedArgs(workspace, clean),
        transport,
      )
      return this.annotate(command, value, workspace) as T
    }
    if (entries.length === 1)
      return this.annotate(
        command,
        await this.host(entries[0]).invoke(command, this.scopedArgs(entries[0], clean), transport),
        entries[0],
      ) as T
    if (command === 'workspace_entries') return (await this.entriesAll(entries, clean)) as T
    if (command === 'semantic_library_page') return (await this.sourcesAll(entries, clean)) as T
    if (command === 'global_search_page') return (await this.searchAll(entries, clean)) as T
    if (LIST_COMMANDS.has(command)) {
      const results: unknown[] = []
      for (const workspace of entries) {
        const value = await this.host(workspace).invoke(command, clean, transport)
        if (!Array.isArray(value)) throw new Error(`Unexpected ${command} result`)
        results.push(
          ...value.map((row) => ({
            ...row,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          })),
        )
      }
      return results as T
    }
    throw new Error('Select a workspace for this operation')
  }
  private async entriesAll(entries: WorkspaceInfo[], args: Record<string, unknown>) {
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 50))
    const offset = Math.max(0, Math.trunc(Number(args.offset) || 0))
    let total = 0
    const rows: unknown[] = []
    for (const workspace of entries) {
      const remaining = limit - rows.length
      const page = await this.host(workspace).invoke<any>('workspace_entries', {
        ...args,
        offset: Math.max(0, offset - total),
        limit: Math.max(1, remaining),
      })
      if (remaining > 0)
        rows.push(
          ...page.entries.map((r: object) => ({
            ...r,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          })),
        )
      total += page.total
    }
    const next = offset + rows.length
    return { entries: rows, total, nextOffset: next < total ? next : null }
  }
  private annotate(command: string, value: any, workspace: WorkspaceInfo): any {
    if (command === 'semantic_library_page' && Array.isArray(value?.documents))
      return {
        ...value,
        documents: value.documents.map((row: object) => ({
          ...row,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        })),
      }
    if (LIST_COMMANDS.has(command) && Array.isArray(value))
      return value.map((row) => ({
        ...row,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      }))
    if (command === 'global_search_page' && value?.nextCursor)
      this.lastUsed.set(workspace.id, Date.now() + 4 * 60_000)
    if (command === 'global_search_page' && value?.hits)
      return {
        ...value,
        hits: value.hits.map((hit: object, index: number) => ({
          ...hit,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceRank: index + 1,
        })),
      }
    return value
  }
  private async sourcesAll(
    entries: WorkspaceInfo[],
    args: Record<string, unknown>,
  ): Promise<{
    documents: unknown[]
    total: number
    nextOffset: number | null
    counts: Record<string, number>
  }> {
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 100))
    const offset = Math.max(0, Math.trunc(Number(args.offset) || 0))
    const documents: unknown[] = []
    const counts: Record<string, number> = {
      all: 0,
      removed: 0,
      searchable: 0,
      processing: 0,
      attention: 0,
    }
    let total = 0
    for (const workspace of entries) {
      const localOffset = Math.max(0, offset - total)
      const available = limit - documents.length
      const page = await this.host(workspace).invoke<{
        documents: object[]
        total: number
        counts?: Record<string, number>
      }>('semantic_library_page', {
        ...this.scopedArgs(workspace, args),
        offset: localOffset,
        limit: Math.max(1, available),
      })
      if (available > 0)
        documents.push(
          ...page.documents.map((row) => ({
            ...row,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          })),
        )
      total += page.total
      for (const key of Object.keys(counts)) counts[key] += page.counts?.[key] ?? 0
    }
    const next = offset + documents.length
    return { documents, total, counts, nextOffset: next < total ? next : null }
  }
  private async searchAll(
    entries: WorkspaceInfo[],
    args: Record<string, unknown>,
  ): Promise<SearchPage> {
    let cursors: Record<string, string | null> | undefined
    if (args.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(args.cursor), 'base64url').toString())
        if (
          decoded.version !== 1 ||
          typeof decoded.cursors !== 'object' ||
          decoded.cursors === null
        )
          throw new Error()
        cursors = decoded.cursors
        if (
          Object.entries(cursors!).some(
            ([id, value]) =>
              !entries.some((w) => w.id === id) || (value !== null && typeof value !== 'string'),
          )
        )
          throw new Error()
      } catch {
        throw new Error('Search context expired; search again')
      }
    }
    const next: Record<string, string | null> = {}
    const hits: Record<string, unknown>[] = []
    let capped = false
    // Preserve per-workspace rank; local relevance scores are not globally comparable.
    for (const workspace of entries) {
      if (cursors && !cursors[workspace.id]) {
        next[workspace.id] = null
        continue
      }
      const page = await this.host(workspace).invoke<SearchPage>('global_search_page', {
        ...args,
        cursor: cursors?.[workspace.id] ?? null,
      })
      hits.push(
        ...page.hits.map((hit, index) => ({
          ...hit,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceRank: index + 1,
        })),
      )
      if (page.nextCursor) this.lastUsed.set(workspace.id, Date.now() + 4 * 60_000)
      next[workspace.id] = page.nextCursor
      capped ||= page.capped
    }
    return {
      hits,
      capped,
      nextCursor: Object.values(next).some(Boolean)
        ? Buffer.from(JSON.stringify({ version: 1, cursors: next })).toString('base64url')
        : null,
    }
  }
  private async retireIdle(): Promise<void> {
    if (this.closed || this.retiring) return
    this.retiring = true
    try {
      for (const [id, host] of this.hosts) {
        const used = this.lastUsed.get(id) ?? 0
        if (Date.now() - used < 60_000 || !host.isIdle()) continue
        try {
          const safe = await host.invoke<boolean>('host_can_suspend', {}, { timeoutMs: 5000 })
          if (safe && !this.closed && this.lastUsed.get(id) === used && host.isIdle()) {
            host.close()
            this.hosts.delete(id)
            this.lastUsed.delete(id)
          }
        } catch {
          /* An old or busy backend remains alive; never interrupt work to save memory. */
        }
      }
    } finally {
      this.retiring = false
    }
  }
  close(): void {
    clearInterval(this.idleTimer)
    this.closed = true
    for (const host of this.hosts.values()) host.close()
    this.hosts.clear()
  }
}
