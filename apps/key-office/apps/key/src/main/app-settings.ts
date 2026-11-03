// App-wide preferences (appearance, whether onboarding is done) and the facts the
// Settings page shows about this install. Workspace and AI settings live elsewhere.
import { app, nativeTheme } from 'electron'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type Theme = 'system' | 'light' | 'dark'
export interface AppSettings {
  theme: Theme
  onboarded: boolean
  /** Run the layout model when analysing PDFs (better reading order, tables, headings). */
  layoutModel: boolean
  /** Keep the imported Zotero library in step with Zotero (off: import once). */
  zoteroSync: boolean
  /** Look sources up in OpenAlex when they arrive with a DOI, and refresh counts when viewed. */
  openalex: boolean
  /** Sent with OpenAlex requests (their polite pool); empty uses the app's own address. */
  openalexMailto: string
  /** An OpenAlex API key, for a daily budget of one's own. */
  openalexApiKey: string
}
const DEFAULTS: AppSettings = { theme: 'system', onboarded: false, layoutModel: true, zoteroSync: false, openalex: true, openalexMailto: '', openalexApiKey: '' }

export class AppSettingsStore {
  private value: AppSettings = { ...DEFAULTS }
  constructor(private readonly path: string) {}

  async load(): Promise<AppSettings> {
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8'))
      this.value = sanitize({ ...DEFAULTS, ...stored })
    } catch {
      this.value = { ...DEFAULTS }
    }
    apply(this.value)
    return this.get()
  }
  get(): AppSettings {
    return { ...this.value }
  }
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.value = sanitize({ ...this.value, ...patch })
    apply(this.value)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, null, 2))
    await rename(temporary, this.path)
    return this.get()
  }
}

function sanitize(input: AppSettings): AppSettings {
  return {
    theme: (['system', 'light', 'dark'] as const).includes(input.theme) ? input.theme : 'system',
    onboarded: input.onboarded === true,
    layoutModel: input.layoutModel !== false,
    zoteroSync: input.zoteroSync === true,
    openalex: input.openalex !== false,
    openalexMailto: typeof input.openalexMailto === 'string' && /^[^\s@]+@[^\s@]+$/.test(input.openalexMailto.trim()) ? input.openalexMailto.trim() : '',
    openalexApiKey: typeof input.openalexApiKey === 'string' ? input.openalexApiKey.trim().slice(0, 200) : '',
  }
}

// Every view (shell, readers, office editors) follows prefers-color-scheme, which this sets.
// Library hosts read the layout setting from the environment when they start.
function apply(settings: AppSettings) {
  nativeTheme.themeSource = settings.theme
  process.env.KEY_LAYOUT_MODEL_ENABLED = settings.layoutModel ? '1' : '0'
  process.env.KEY_OPENALEX_ENABLED = settings.openalex ? '1' : '0'
  process.env.KEY_OPENALEX_MAILTO = settings.openalexMailto
  process.env.KEY_OPENALEX_API_KEY = settings.openalexApiKey
}

/** Versions, data locations and whether a Zotero library is present on this Mac. */
export async function appInfo(workspaceParent: string) {
  const zoteroDir = join(homedir(), 'Zotero')
  const zoteroFound = await access(join(zoteroDir, 'zotero.sqlite')).then(
    () => true,
    () => false,
  )
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    userData: app.getPath('userData'),
    workspaceParent,
    // Mirrors key-embed's default model location.
    modelDir: process.env.KEY_MODEL_DIR ?? join(app.getPath('appData'), 'Key', 'models'),
    zoteroDir,
    zoteroFound,
  }
}
