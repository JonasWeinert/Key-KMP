// Settings: a window-sized sheet with a sidebar of sections, like macOS System Settings.
// General (appearance), Libraries, Search & indexing, AI and About.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { ActivityPanel, useLibraryStatus } from "./index-activity";
import { bridge, type AppInfo, type AppSettings, type Invoke, type MergeSuggestion, type Theme, type WorkspaceSummary, type ZoteroStatus } from "./library-api";
import "./entity.css";
import MergeReview from "./MergeReview";
import { Conflicts, ZoteroImport } from "./ZoteroImport";
import { ModelProgressCard, useModelProgress } from "./model-progress";

export type SettingsSection = "general" | "libraries" | "search" | "ai" | "about";
const SECTIONS: [SettingsSection, string, IconName][] = [
  ["general", "General", "gear"],
  ["libraries", "Libraries", "books"],
  ["search", "Search & indexing", "search"],
  ["ai", "AI assistant", "sparkle"],
  ["about", "About Key", "info"],
];

export default function Settings({
  section: initial = "general",
  invoke,
  workspaces,
  settings,
  info,
  onSettings,
  onClose,
  onShowWelcome,
  onOpenLibrary,
  onWorkspacesChanged,
}: {
  section?: SettingsSection;
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  settings: AppSettings;
  info: AppInfo;
  onSettings: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onShowWelcome: () => void;
  onOpenLibrary: (workspaceId: string) => void;
  onWorkspacesChanged: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initial);
  return (
    <GlobalDrawer presentation="window" label="Settings" onClose={onClose}>
      <div className="kx-settings">
        <nav className="kx-settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          {SECTIONS.map(([id, label, icon]) => (
            <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>
              <span className="kx-settings-glyph" data-section={id}>
                <Icon name={icon} size={13} />
              </span>
              {label}
            </button>
          ))}
        </nav>
        <div className="kx-settings-body">
          <header>
            <h1>{SECTIONS.find(([id]) => id === section)?.[1]}</h1>
            <button className="kx-sheet-close" aria-label="Close settings" onClick={onClose}>
              <Icon name="close" size={10} />
            </button>
          </header>
          <div className="kx-settings-scroll">
            {section === "general" && <General settings={settings} onSettings={onSettings} onShowWelcome={onShowWelcome} />}
            {section === "libraries" && (
              <Libraries invoke={invoke} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} onOpenLibrary={onOpenLibrary} onChanged={onWorkspacesChanged} />
            )}
            {section === "search" && <SearchSettings invoke={invoke} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} />}
            {section === "ai" && <AiSettings invoke={invoke} workspaceId={workspaces[0]?.id} />}
            {section === "about" && <About info={info} />}
          </div>
        </div>
      </div>
    </GlobalDrawer>
  );
}

/** A titled, rounded group of rows. */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="kx-settings-group">
      {title && <h3>{title}</h3>}
      <div className="kx-settings-rows">{children}</div>
      {footer && <p className="kx-settings-footnote">{footer}</p>}
    </section>
  );
}
function Row({ label, detail, children }: { label: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="kx-settings-row">
      <div>
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </div>
      {children && <div className="kx-settings-control">{children}</div>}
    </div>
  );
}

const THEMES: [Theme, string, IconName][] = [
  ["system", "Automatic", "display"],
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
];

/** Appearance tiles, shared with onboarding. */
export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="kx-theme-picker" role="radiogroup" aria-label="Appearance">
      {THEMES.map(([id, label, icon]) => (
        <button key={id} role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          <span className="kx-theme-preview" data-theme-preview={id}>
            <span />
            <span />
          </span>
          <span>
            <Icon name={icon} size={12} />
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}

function General({ settings, onSettings, onShowWelcome }: { settings: AppSettings; onSettings: (patch: Partial<AppSettings>) => void; onShowWelcome: () => void }) {
  return (
    <>
      <Group title="Appearance" footer="Automatic follows your Mac’s light and dark setting. Documents keep their own colours.">
        <div className="kx-settings-row kx-settings-row-wide">
          <ThemePicker value={settings.theme} onChange={(theme) => onSettings({ theme })} />
        </div>
      </Group>
      <Group title="Getting started">
        <Row label="Welcome tour" detail="Set up libraries, imports and search again.">
          <button className="kx-settings-button" onClick={onShowWelcome}>
            Show welcome
          </button>
        </Row>
        <Row label="Keyboard" detail="⌘F search the library · ⌘T new tab · ⌘, settings" />
      </Group>
    </>
  );
}

function Libraries({
  invoke,
  workspaces,
  info,
  settings,
  onSettings,
  onOpenLibrary,
  onChanged,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onOpenLibrary: (workspaceId: string) => void;
  onChanged: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    for (const w of workspaces)
      void invoke<{ counts: { all: number } }>("store_status", {}, w.id)
        .then((s) => setCounts((c) => ({ ...c, [w.id]: s.counts.all })))
        .catch(() => {});
  }, [invoke, workspaces]);
  // One sheet at a time: the import dialogue takes the place of this page.
  if (importing)
    return (
      <div className="kx-settings-group kx-settings-zotero-import">
        <ZoteroImport invoke={invoke} workspaceId={workspaces[0]?.id} onClose={() => setImporting(false)} onDone={() => onChanged()} />
      </div>
    );
  return (
    <>
      <Group title="Your libraries" footer="Each library is a folder on this Mac. Linked files stay where they are; Key keeps its index in a hidden .key folder inside.">
        {workspaces.map((w) => (
          <Row
            key={w.id}
            label={
              <>
                <span className="kx-settings-swatch" style={{ background: w.color || undefined }}>
                  {w.icon || w.name.slice(0, 1)}
                </span>
                {w.name}
              </>
            }
            detail={`${counts[w.id] === undefined ? "…" : `${counts[w.id].toLocaleString()} sources`} · ${w.root.replace(/^\/Users\/[^/]+/, "~")}`}
          >
            <button className="kx-settings-button" onClick={() => void bridge().revealPath(w.root)}>
              Show in Finder
            </button>
            <button className="kx-settings-button" onClick={() => onOpenLibrary(w.id)}>
              Open
            </button>
          </Row>
        ))}
        <Row label="Add a library" detail="Use any folder, for example one per project.">
          <button className="kx-settings-button" onClick={() => void bridge().addWorkspace().then((added) => added && onChanged())}>
            Choose folder…
          </button>
        </Row>
      </Group>
      <ZoteroSettings invoke={invoke} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} onImport={() => setImporting(true)} />
    </>
  );
}

/** The Zotero library Key imported into: the workspace in a folder named Zotero. */
const zoteroWorkspaceOf = (workspaces: WorkspaceSummary[]) => workspaces.find((w) => /\/Zotero$/.test(w.root));

function ZoteroSettings({
  invoke,
  workspaces,
  info,
  settings,
  onSettings,
  onImport,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onImport: () => void;
}) {
  const workspace = zoteroWorkspaceOf(workspaces);
  const [status, setStatus] = useState<ZoteroStatus>();
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    if (!workspace) return;
    let stopped = false;
    const load = () =>
      void invoke<ZoteroStatus>("store_zotero_status", {}, workspace.id)
        .then((s) => !stopped && setStatus(s))
        .catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [invoke, workspace?.id]);
  const imported = !!status?.at;
  const report = status?.report;
  const when = status?.at ? new Date(status.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  return (
    <Group
      title="Zotero"
      footer="Key reads a copy of Zotero’s database and never writes to Zotero. Changes made in Zotero come to Key; edits you make in Key are kept, and where both changed, Key’s version stays and is listed here."
    >
      <Row
        label="Import from Zotero"
        detail={
          info.zoteroFound
            ? `Library found at ${info.zoteroDir.replace(/^\/Users\/[^/]+/, "~")}. Choose collections and what comes along; importing again updates what came before.`
            : "No Zotero library found in your home folder."
        }
      >
        <button className="kx-settings-button" disabled={!info.zoteroFound} onClick={onImport}>
          {imported ? "Import again…" : "Import…"}
        </button>
      </Row>
      <Row
        label="Keep in sync with Zotero"
        detail={
          imported
            ? settings.zoteroSync
              ? `Checks for changes every half minute while Key is open. Last ${report && status?.options ? "synced" : "imported"} ${when}.`
              : `Imported once, ${when}. Turn on to bring over later changes, deletions and moves.`
            : "Import your library first."
        }
      >
        <input
          type="checkbox"
          className="kx-switch"
          aria-label="Keep in sync with Zotero"
          disabled={!imported}
          checked={settings.zoteroSync}
          onChange={(e) => onSettings({ zoteroSync: e.target.checked })}
        />
      </Row>
      {imported && settings.zoteroSync && (
        <Row
          label="Sync now"
          detail={
            report
              ? [
                  report.added && `${report.added.toLocaleString()} added`,
                  report.updated && `${report.updated.toLocaleString()} updated`,
                  report.trashed && `${report.trashed.toLocaleString()} moved to the trash`,
                  report.notesUpdated && `${report.notesUpdated.toLocaleString()} notes updated`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Up to date."
              : undefined
          }
        >
          <button
            className="kx-settings-button"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                await bridge().syncZotero();
                if (workspace) setStatus(await invoke<ZoteroStatus>("store_zotero_status", {}, workspace.id));
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </Row>
      )}
      {!!report?.conflictCount && (
        <div className="kx-settings-row kx-settings-row-wide">
          <Conflicts report={report} />
        </div>
      )}
    </Group>
  );
}

function SearchSettings({
  invoke,
  workspaces,
  info,
  settings,
  onSettings,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id);
  const status = useLibraryStatus(invoke, workspaceId);
  const model = useModelProgress(invoke, workspaceId);
  const [message, setMessage] = useState("");
  // The switch answers at once; the next status poll confirms it.
  const [pausing, setPausing] = useState<boolean>();
  const paused = pausing ?? !!status?.activity?.paused;
  useEffect(() => setPausing(undefined), [status?.activity?.paused]);
  const setPaused = (value: boolean) => {
    setPausing(value);
    void invoke("store_index_control", { action: value ? "pause" : "resume" }, workspaceId);
  };
  // PDFs read before the current analysis (or with the other layout setting).
  const [outdated, setOutdated] = useState<number>();
  useEffect(() => {
    void invoke<{ outdated: number }>("store_analysis_options", {}, workspaceId)
      .then((o) => setOutdated(o.outdated))
      .catch(() => setOutdated(undefined));
  }, [invoke, workspaceId, settings.layoutModel]);
  const references = (status as { references?: { title?: string; stage: string; done: number; total: number } | null } | undefined)?.references;
  const accelerator = (status?.model as { accelerator?: string } | undefined)?.accelerator;
  const counts = status?.counts;
  const failed = counts?.attention ?? 0;
  return (
    <>
      <Group
        title="On-device search model"
        footer="EmbeddingGemma 2 runs on this Mac through llama.cpp. Your sources, their text and every search stay here."
      >
        {model && model.state !== "ready" ? (
          <div className="kx-settings-row kx-settings-row-wide">
            <ModelProgressCard progress={model} compact />
          </div>
        ) : (
          <Row label="EmbeddingGemma 2 · 768 dimensions" detail={accelerator ? `Ready · accelerated by ${accelerator}` : "Ready"}>
            <span className="kx-settings-ok">
              <Icon name="check" size={12} /> Ready
            </span>
          </Row>
        )}
        <Row label="Model folder" detail={info.modelDir.replace(/^\/Users\/[^/]+/, "~")}>
          <button className="kx-settings-button" onClick={() => void bridge().revealPath(info.modelDir)}>
            Show in Finder
          </button>
        </Row>
      </Group>
      {workspaces.length > 1 && (
        <Group>
          <Row label="Library">
            <select className="kx-settings-select" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Row>
        </Group>
      )}
      <Group title="Indexing" footer={message || "Key reads each source’s text, splits it into passages and indexes them for search. Sources you open, select or scroll to go first."}>
        {counts && (
          <div className="kx-settings-stats">
            <div>
              <strong>{counts.ready.toLocaleString()}</strong>
              <span>searchable</span>
            </div>
            <div>
              <strong>{counts.indexing.toLocaleString()}</strong>
              <span>waiting</span>
            </div>
            <div>
              <strong>{(status?.vectors ?? 0).toLocaleString()}</strong>
              <span>passages</span>
            </div>
            <div data-tone={failed ? "attention" : undefined}>
              <strong>{failed.toLocaleString()}</strong>
              <span>need attention</span>
            </div>
          </div>
        )}
        {status?.activity && (status.activity.batchTotal > 0 || status.activity.paused) && (
          <div className="kx-settings-row kx-settings-row-wide">
            <ActivityPanel
              activity={status.activity}
              modelReady={status.model.state === "ready"}
              onPause={setPaused}
            />
          </div>
        )}
        {references && (
          <Row
            label={references.stage === "detecting" ? "Finding references" : "Looking up references"}
            detail={`${references.title || "Untitled"}${references.total ? ` · ${references.done} of ${references.total}` : ""}`}
          >
            <span className="kx-search-spinner" aria-hidden="true" />
          </Row>
        )}
        <Row label="Pause indexing" detail="Stops reading and indexing until you resume. Search keeps working.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Pause indexing"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
          />
        </Row>
        <Row label="Retry sources that failed" detail="Files that could not be read are tried again.">
          <button
            className="kx-settings-button"
            disabled={!failed}
            onClick={async () => {
              const count = await invoke<number>("store_index_control", { action: "retry_failed" }, workspaceId);
              setMessage(count ? `Queued ${count} ${count === 1 ? "source" : "sources"} again.` : "Nothing to retry.");
            }}
          >
            Retry
          </button>
        </Row>
      </Group>
      <Group
        title="Document analysis"
        footer="Each PDF is read with layout analysis: reading order, headings, tables and columns, without running headers and page numbers. Its references are then found and looked up, and linked to sources already in your library."
      >
        <Row label="Use the layout model" detail="PP-DocLayout, on this Mac. Recognises complex layouts more reliably; takes about a second per page.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Use the layout model"
            checked={settings.layoutModel}
            onChange={(e) => onSettings({ layoutModel: e.target.checked })}
          />
        </Row>
        <Row
          label="Analyse PDFs again"
          detail={
            outdated === undefined
              ? "Reads PDFs again with the current settings."
              : outdated
                ? `${outdated.toLocaleString()} ${outdated === 1 ? "PDF was" : "PDFs were"} read without the current analysis.`
                : "Every PDF uses the current analysis."
          }
        >
          <button
            className="kx-settings-button"
            disabled={!outdated}
            onClick={async () => {
              const result = await invoke<{ outdated: number }>("store_analysis_options", { reanalyzeOutdated: true }, workspaceId);
              setMessage(`Queued ${outdated?.toLocaleString()} PDFs for analysis.`);
              setOutdated(result.outdated);
            }}
          >
            Analyse
          </button>
        </Row>
      </Group>
      <Group
        title="OpenAlex"
        footer="Sources with a DOI, PMID or OpenAlex id are looked up in OpenAlex, the open catalogue of research: authors with their ORCID, the journal, topics, funding, open-access status, retractions and the works each one cites. Citation counts are refreshed when a page is opened. Only identifiers are sent, never your files or notes."
      >
        <Row label="Look up new sources" detail={status?.enrichment ? `${status.enrichment.toLocaleString()} waiting` : "Off: only when you choose Look up in OpenAlex."}>
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Look up new sources in OpenAlex"
            checked={settings.openalex}
            onChange={(e) => onSettings({ openalex: e.target.checked })}
          />
        </Row>
        <Row label="Contact email" detail="OpenAlex asks for one so it can reach whoever sends many requests.">
          <input
            className="kx-settings-select"
            type="email"
            aria-label="OpenAlex contact email"
            placeholder="you@example.org"
            defaultValue={settings.openalexMailto}
            onBlur={(e) => e.target.value.trim() !== settings.openalexMailto && onSettings({ openalexMailto: e.target.value.trim() })}
          />
        </Row>
        <Row label="API key" detail="Optional. A free key gives you a daily budget of your own.">
          <input
            className="kx-settings-select"
            type="password"
            aria-label="OpenAlex API key"
            defaultValue={settings.openalexApiKey}
            onBlur={(e) => e.target.value.trim() !== settings.openalexApiKey && onSettings({ openalexApiKey: e.target.value.trim() })}
          />
        </Row>
        <PossibleDuplicates invoke={invoke} workspaceId={workspaceId} />
      </Group>
    </>
  );
}

/** People whose names might be one person: reviewed side by side, merged only when the user says so. */
function PossibleDuplicates({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [count, setCount] = useState<number>();
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    if (workspaceId) void invoke<MergeSuggestion[]>("store_merge_suggestions", {}, workspaceId).then((list) => setCount(list.length)).catch(() => setCount(0));
  }, [invoke, workspaceId]);
  useEffect(load, [load]);
  return (
    <>
      <Row label="Possible duplicate people" detail={count ? `${count} to review, side by side` : "None to review."}>
        <button className="kx-settings-button" disabled={!count} onClick={() => setOpen(true)}>
          Review…
        </button>
      </Row>
      {open && workspaceId && (
        <MergeReview
          invoke={invoke}
          workspaceId={workspaceId}
          onClose={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  genspark: "Genspark",
  codex: "Codex",
  anthropic: "Anthropic",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  kimi: "Kimi",
  glm: "GLM",
  custom: "Custom endpoint",
};

function AiSettings({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [status, setStatus] = useState<{ available: boolean; provider?: string; model?: string; reason?: string }>();
  const [endpoint, setEndpoint] = useState("http://localhost:11434/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void invoke<typeof status>("agent_fill_status", {}, workspaceId).then(setStatus).catch(() => {});
  }, [invoke, workspaceId]);
  return (
    <>
      <Group title="Provider" footer="Used only when you ask for it, for example to fill a property or merge tags. Key sends the passages that task needs, never your whole library.">
        <Row
          label={status?.available ? `${PROVIDER_LABEL[status.provider ?? ""] ?? status.provider} · ${status.model}` : "Not connected"}
          detail={status?.available ? "Connected" : status?.reason || "Checking…"}
        >
          {status?.available ? (
            <span className="kx-settings-ok">
              <Icon name="check" size={12} /> Ready
            </span>
          ) : null}
        </Row>
      </Group>
      <Group
        title="Connect an OpenAI-compatible provider"
        footer="Works with local servers such as Ollama or LM Studio (http://localhost) and hosted APIs over HTTPS. The key is stored on this Mac only."
      >
        <form
          className="kx-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setStatus(await invoke("agent_fill_configure", { baseUrl: endpoint, model, apiKey: apiKey || undefined }, workspaceId));
              setApiKey("");
            } catch (err) {
              setError(String(err).replace(/^Error: /, ""));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            <span>Endpoint</span>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label>
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.1:8b" />
          </label>
          <label>
            <span>API key</span>
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optional for local servers" />
          </label>
          {error && <p className="kx-inline-error">{error}</p>}
          <div>
            <button type="submit" className="kx-button-primary" disabled={busy || !model.trim() || !endpoint.trim()}>
              {busy ? "Connecting…" : "Save provider"}
            </button>
          </div>
        </form>
      </Group>
    </>
  );
}

function About({ info }: { info: AppInfo }) {
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
  return (
    <>
      <div className="kx-settings-about">
        <span className="kx-settings-appicon">
          <Icon name="books" size={30} />
        </span>
        <div>
          <strong>Key</strong>
          <span>
            Version {info.version} · Electron {info.electron}
          </span>
        </div>
      </div>
      <Group title="Where your data lives">
        {[
          ["App settings", info.userData],
          ["Libraries", info.workspaceParent],
          ["Search model", info.modelDir],
        ].map(([label, path]) => (
          <Row key={label} label={label} detail={home(path)}>
            <button className="kx-settings-button" onClick={() => void bridge().revealPath(path)}>
              Show in Finder
            </button>
          </Row>
        ))}
      </Group>
    </>
  );
}
