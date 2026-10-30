// First-run welcome: where the library lives, bringing sources in, on-device search and
// appearance. Every step can be skipped; nothing here is needed to start working.
import { useState, type ReactNode } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { bridge, type AppInfo, type Invoke, type Theme, type WorkspaceSummary } from "./library-api";
import { ModelProgressCard, useModelProgress } from "./model-progress";
import { ThemePicker } from "./Settings";

const STEPS = ["welcome", "library", "import", "search", "appearance", "done"] as const;
type Step = (typeof STEPS)[number];

export default function Onboarding({
  invoke,
  workspaces,
  info,
  theme,
  onTheme,
  onFinish,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** Called with the library to open, if any. */
  onFinish: (workspaceId?: string) => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [library, setLibrary] = useState<WorkspaceSummary | undefined>(workspaces[0]);
  const [imported, setImported] = useState<string>();
  const [importing, setImporting] = useState<"zotero" | "files">();
  const [error, setError] = useState("");
  const model = useModelProgress(invoke, library?.id);
  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]);
  const back = () => setStep(STEPS[Math.max(0, index - 1)]);
  const finish = () => onFinish(library?.id);
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

  return (
    <GlobalDrawer presentation="window" label="Welcome to Key" onClose={finish}>
      <div className="kx-onboarding" data-step={step}>
        <div className="kx-onboarding-stage" key={step}>
          {step === "welcome" && (
            <Hero icon="books" title="Welcome to Key" lead="A calm place to collect, read and search your research.">
              <ul className="kx-onboarding-points">
                <Point icon="layers" title="Everything in one library">
                  PDFs, references, web pages, notes, audio, video and images, with collections, tags and your own properties.
                </Point>
                <Point icon="search" title="Find anything, by words or meaning">
                  Search titles, notes and the full text at once. Results show exactly where each match is.
                </Point>
                <Point icon="lock" title="Private by default">
                  Files stay where they are. Text extraction, the search index and the search model all run on this Mac.
                </Point>
              </ul>
            </Hero>
          )}
          {step === "library" && (
            <Hero icon="folder" title="Where your library lives" lead="A library is a folder on this Mac. You can add more later, for example one per project.">
              {library && (
                <div className="kx-onboarding-card">
                  <span className="kx-settings-swatch" style={{ background: library.color || undefined }}>
                    {library.icon || library.name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>{library.name}</strong>
                    <small>{home(library.root)}</small>
                  </div>
                  <button
                    className="kx-settings-button"
                    onClick={async () => {
                      const added = await bridge().addWorkspace();
                      if (added) setLibrary(added);
                    }}
                  >
                    Choose another folder…
                  </button>
                </div>
              )}
              <p className="kx-onboarding-note">Linked files are never moved or changed. Key keeps its index in a hidden .key folder inside the library.</p>
            </Hero>
          )}
          {step === "import" && (
            <Hero icon="upload" title="Bring in your sources" lead="Start from what you already have, or begin with an empty library.">
              <div className="kx-onboarding-choices">
                <Choice
                  icon="books"
                  title={info.zoteroFound ? "Import your Zotero library" : "Zotero"}
                  detail={
                    info.zoteroFound
                      ? `Found at ${home(info.zoteroDir)}. Items, collections, notes, tags and PDFs come across; Zotero is not changed.`
                      : "No Zotero library was found in your home folder."
                  }
                  busy={importing === "zotero"}
                  disabled={!info.zoteroFound || !!importing}
                  onClick={async () => {
                    setImporting("zotero");
                    setError("");
                    try {
                      const { workspace, report } = await bridge().importZotero();
                      setLibrary(workspace as WorkspaceSummary);
                      setImported(`Imported ${report.items?.toLocaleString() ?? "your"} items from Zotero into “${workspace.name}”.`);
                    } catch (e) {
                      setError(String(e).replace(/^Error: /, ""));
                    } finally {
                      setImporting(undefined);
                    }
                  }}
                />
                <Choice
                  icon="doc"
                  title="Add files"
                  detail="PDFs, web pages, text, audio, video and images. You can also drop files on the library at any time."
                  busy={importing === "files"}
                  disabled={!library || !!importing}
                  onClick={async () => {
                    if (!library) return;
                    setImporting("files");
                    setError("");
                    try {
                      const created = await bridge().addFiles(library.id);
                      if (created.length) setImported(`Added ${created.length} ${created.length === 1 ? "source" : "sources"} to “${library.name}”.`);
                    } catch (e) {
                      setError(String(e).replace(/^Error: /, ""));
                    } finally {
                      setImporting(undefined);
                    }
                  }}
                />
              </div>
              {imported && (
                <p className="kx-onboarding-done">
                  <Icon name="check" size={13} /> {imported} Indexing has started.
                </p>
              )}
              {error && <p className="kx-inline-error">{error}</p>}
            </Hero>
          )}
          {step === "search" && (
            <Hero icon="sparkle" title="Search that understands your sources" lead="Key reads each source, splits it into passages and indexes them, so you can find a sentence by its words or by what it means.">
              {model && model.state !== "ready" ? (
                <ModelProgressCard progress={model} />
              ) : (
                <p className="kx-onboarding-done">
                  <Icon name="check" size={13} /> The on-device search model is ready.
                </p>
              )}
              <ul className="kx-onboarding-points kx-onboarding-points-compact">
                <Point icon="activity" title="Indexing follows you">
                  Sources you open, select or scroll to are indexed first. Progress shows at the bottom of the library.
                </Point>
                <Point icon="chip" title="Runs on this Mac">
                  The model (about 310 MB) downloads once and uses your Mac’s graphics chip. Searching by words works before it finishes.
                </Point>
              </ul>
            </Hero>
          )}
          {step === "appearance" && (
            <Hero icon="display" title="Choose a look" lead="You can change this any time in Settings.">
              <ThemePicker value={theme} onChange={onTheme} />
            </Hero>
          )}
          {step === "done" && (
            <Hero icon="check" title="You’re all set" lead="A few things worth knowing:">
              <ul className="kx-onboarding-tips">
                <li>
                  <kbd>⌘F</kbd> Search the library as you type, across details and full text.
                </li>
                <li>
                  <kbd>↵</kbd> Open the selected source; click a passage to jump to its page.
                </li>
                <li>
                  <kbd>⌘,</kbd> Settings: libraries, search, appearance and an optional AI provider.
                </li>
              </ul>
            </Hero>
          )}
        </div>
        <footer className="kx-onboarding-footer">
          <div className="kx-onboarding-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <span key={s} data-active={i === index} data-done={i < index} />
            ))}
          </div>
          <div className="kx-onboarding-actions">
            {step !== "done" && step !== "welcome" && (
              <button className="kx-settings-button kx-onboarding-skip" onClick={finish}>
                Skip setup
              </button>
            )}
            {index > 0 && (
              <button className="kx-settings-button" onClick={back}>
                Back
              </button>
            )}
            <button className="kx-button-primary" disabled={!!importing} onClick={step === "done" ? finish : next}>
              {step === "welcome" ? "Get started" : step === "done" ? "Open my library" : "Continue"}
            </button>
          </div>
        </footer>
      </div>
    </GlobalDrawer>
  );
}

function Hero({ icon, title, lead, children }: { icon: IconName; title: string; lead: string; children?: ReactNode }) {
  return (
    <>
      <span className="kx-onboarding-icon">
        <Icon name={icon} size={26} />
      </span>
      <h1>{title}</h1>
      <p className="kx-onboarding-lead">{lead}</p>
      <div className="kx-onboarding-content">{children}</div>
    </>
  );
}
function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li>
      <span>
        <Icon name={icon} size={15} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </li>
  );
}
function Choice({ icon, title, detail, busy, disabled, onClick }: { icon: IconName; title: string; detail: string; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="kx-onboarding-choice" disabled={disabled} onClick={onClick}>
      <span>
        <Icon name={icon} size={17} />
      </span>
      <div>
        <strong>{busy ? "Working…" : title}</strong>
        <small>{detail}</small>
      </div>
      <Icon name="chevronRight" size={12} />
    </button>
  );
}
