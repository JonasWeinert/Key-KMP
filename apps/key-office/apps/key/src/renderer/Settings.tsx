// Settings: a window-sized sheet with a sidebar of sections, like macOS System Settings.
// General (appearance), Libraries, Search & indexing, AI and About.
import { useEffect, useState, type ReactNode } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { ActivityPanel, useLibraryStatus } from "./index-activity";
import { bridge, type AppInfo, type AppSettings, type Invoke, type Theme, type WorkspaceSummary } from "./library-api";
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
            {section === "libraries" && <Libraries invoke={invoke} workspaces={workspaces} info={info} onOpenLibrary={onOpenLibrary} onChanged={onWorkspacesChanged} />}
            {section === "search" && <SearchSettings invoke={invoke} workspaces={workspaces} info={info} />}
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
  onOpenLibrary,
  onChanged,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  onOpenLibrary: (workspaceId: string) => void;
  onChanged: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    for (const w of workspaces)
      void invoke<{ counts: { all: number } }>("store_status", {}, w.id)
        .then((s) => setCounts((c) => ({ ...c, [w.id]: s.counts.all })))
        .catch(() => {});
  }, [invoke, workspaces]);
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
      <Group title="Import" footer={message || undefined}>
        <Row
          label="Zotero"
          detail={info.zoteroFound ? `Library found at ${info.zoteroDir.replace(/^\/Users\/[^/]+/, "~")}. Items, collections, notes, tags and PDFs come across; Zotero itself is not changed.` : "No Zotero library found in your home folder."}
        >
          <button
            className="kx-settings-button"
            disabled={!info.zoteroFound || importing}
            onClick={async () => {
              setImporting(true);
              setMessage("");
              try {
                const { workspace, report } = await bridge().importZotero();
                setMessage(`Imported ${report.items?.toLocaleString() ?? "your"} items into “${workspace.name}”.`);
                onChanged();
              } catch (e) {
                setMessage(String(e).replace(/^Error: /, ""));
              } finally {
                setImporting(false);
              }
            }}
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </Row>
      </Group>
    </>
  );
}

function SearchSettings({ invoke, workspaces, info }: { invoke: Invoke; workspaces: WorkspaceSummary[]; info: AppInfo }) {
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
