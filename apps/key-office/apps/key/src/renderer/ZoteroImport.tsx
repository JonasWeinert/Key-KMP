// The Zotero import sheet: the whole library or chosen collections (a tree with item
// counts), what comes across with them, a preview count, then progress and a summary.
// Importing again updates what was imported before and keeps edits made in Key.
import { Button } from "@key/design-system";
import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import {
  bridge,
  type Invoke,
  type WorkspaceSummary,
  type ZoteroOptions,
  type ZoteroPreview,
  type ZoteroProgress,
  type ZoteroReport,
} from "./library-api";
import "./zotero-import.css";

type Collection = ZoteroPreview["collections"][number];

const n = (value: number) => value.toLocaleString();
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

export function ZoteroImportSheet(props: Omit<Props, "onDone"> & { onDone?: Props["onDone"] }) {
  const [busy, setBusy] = useState(false);
  return (
    <GlobalDrawer onClose={props.onClose} busy={busy} presentation="sheet" label="Import from Zotero">
      <ZoteroImport {...props} onDone={props.onDone ?? (() => {})} onBusy={setBusy} />
    </GlobalDrawer>
  );
}

interface Props {
  invoke: Invoke;
  /** A workspace whose host reads the Zotero library for the preview. */
  workspaceId?: string;
  onClose: () => void;
  /** After a finished import, with the workspace it went into. */
  onDone: (workspace: WorkspaceSummary, report: ZoteroReport) => void;
  onBusy?: (busy: boolean) => void;
}

export function ZoteroImport({ invoke, workspaceId, onClose, onDone, onBusy }: Props) {
  const [scope, setScope] = useState<"library" | "collections">("library");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<Omit<ZoteroOptions, "collectionKeys">>({
    attachments: true,
    notes: true,
    annotations: true,
    mirrorCollections: true,
  });
  const [preview, setPreview] = useState<ZoteroPreview>();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ZoteroProgress | "starting">();
  const [result, setResult] = useState<{ workspace: WorkspaceSummary; report: ZoteroReport }>();
  const request: ZoteroOptions = useMemo(
    () => ({ ...options, ...(scope === "collections" ? { collectionKeys: [...chosen] } : {}) }),
    [options, scope, chosen],
  );

  // The counts follow every change of choice; the library is read once and kept by the host.
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      void invoke<ZoteroPreview>("store_zotero_preview", request as unknown as Record<string, unknown>, workspaceId)
        .then((p) => !stale && (setPreview(p), setError("")))
        .catch((e) => !stale && setError(String(e).replace(/^Error: /, "")));
    }, preview ? 150 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, request]);

  const running = progress !== undefined && !result;
  useEffect(() => onBusy?.(running), [running, onBusy]);

  const start = async () => {
    setError("");
    setProgress("starting");
    let polling = true;
    try {
      const workspace = await bridge().zoteroWorkspace();
      const poll = async () => {
        while (polling) {
          const p = await invoke<ZoteroProgress | null>("store_zotero_progress", {}, workspace.id).catch(() => null);
          if (polling && p) setProgress(p);
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      void poll();
      const done = await bridge().importZotero(request);
      setResult(done);
      onDone(done.workspace, done.report);
    } catch (e) {
      setProgress(undefined);
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      polling = false;
    }
  };

  const nothingChosen = scope === "collections" && chosen.size === 0;
  return (
    <div className="key-property-editor kx-zotero-import" role="dialog" aria-label="Import from Zotero">
      <header>
        <h2>Import from Zotero</h2>
        <p>
          {preview ? <>From {preview.dataDir.replace(/^\/Users\/[^/]+/, "~")}. Zotero itself is not changed.</> : "Reading your Zotero library…"}
        </p>
        <button className="kx-sheet-close" aria-label="Close" disabled={running} onClick={onClose}>
          <Icon name="close" size={10} />
        </button>
      </header>
      <div className="key-property-body">
        {result ? (
          <Summary report={result.report} workspace={result.workspace} />
        ) : running ? (
          <ProgressView progress={progress} preview={preview} />
        ) : (
          <>
            <section className="kx-form-section">
              <h3>What to import</h3>
              <div className="kx-zotero-scope" role="radiogroup" aria-label="What to import">
                <button role="radio" aria-checked={scope === "library"} onClick={() => setScope("library")}>
                  <Icon name="books" size={14} />
                  <span>
                    <strong>Whole library</strong>
                    <small>{preview ? plural(preview.library.items, "item") : "…"}</small>
                  </span>
                </button>
                <button role="radio" aria-checked={scope === "collections"} disabled={!preview?.collections.length} onClick={() => setScope("collections")}>
                  <Icon name="folder" size={14} />
                  <span>
                    <strong>Chosen collections</strong>
                    <small>{preview ? plural(preview.collections.length, "collection") : "…"}</small>
                  </span>
                </button>
              </div>
              {scope === "collections" && preview && <CollectionTree collections={preview.collections} chosen={chosen} onChange={setChosen} />}
            </section>
            <section className="kx-form-section">
              <h3>Bring along</h3>
              <div className="kx-form-group">
                <Toggle label="PDFs and other files" detail="Linked where Zotero keeps them; nothing is copied." checked={options.attachments} onChange={(attachments) => setOptions({ ...options, attachments })} />
                <Toggle label="Notes" detail="Converted to Markdown, with highlights as quotes." checked={options.notes} onChange={(notes) => setOptions({ ...options, notes })} />
                <Toggle label="PDF annotations" detail="Each PDF’s highlights and comments, as a note of quotes." checked={options.annotations} onChange={(annotations) => setOptions({ ...options, annotations })} />
                <Toggle label="Zotero collections" detail="Recreated as Key collections, with items filed in them." checked={options.mirrorCollections} onChange={(mirrorCollections) => setOptions({ ...options, mirrorCollections })} />
              </div>
            </section>
            {error && <p className="kx-inline-error">{error}</p>}
          </>
        )}
      </div>
      <footer>
        {!result && !running && preview && (
          <span className="kx-zotero-count" aria-live="polite">
            {nothingChosen ? "Choose at least one collection" : <Counts counts={preview.selected} />}
          </span>
        )}
        <span className="kx-footer-spacer" />
        {result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button type="button" disabled={running} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" className="key-property-primary" disabled={running || !preview || nothingChosen || !preview.selected.items} onClick={() => void start()}>
              {running ? "Importing…" : "Import"}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

function Counts({ counts }: { counts: ZoteroPreview["selected"] }) {
  const parts = [plural(counts.items, "item")];
  if (counts.files) parts.push(plural(counts.files, "file"));
  if (counts.notes) parts.push(plural(counts.notes, "note"));
  if (counts.annotations) parts.push(plural(counts.annotations, "annotation"));
  return <>{parts.join(" · ")}</>;
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="kx-form-row kx-zotero-toggle">
      <span>
        {label}
        <small>{detail}</small>
      </span>
      <input type="checkbox" className="kx-switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Collections as a tree. Choosing one chooses everything inside it. */
export function CollectionTree({ collections, chosen, onChange }: { collections: Collection[]; chosen: Set<string>; onChange: (chosen: Set<string>) => void }) {
  const children = useMemo(() => {
    const map = new Map<string | null, Collection[]>();
    const known = new Set(collections.map((c) => c.key));
    for (const c of collections) {
      const parent = c.parentKey && known.has(c.parentKey) ? c.parentKey : null;
      map.set(parent, [...(map.get(parent) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [collections]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const descendants = (key: string): string[] => (children.get(key) ?? []).flatMap((c) => [c.key, ...descendants(c.key)]);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    for (const k of [key, ...descendants(key)]) on ? next.add(k) : next.delete(k);
    onChange(next);
  };
  const rows = (parent: string | null, depth: number): React.ReactNode[] =>
    (children.get(parent) ?? []).flatMap((c) => {
      const inner = descendants(c.key);
      const some = inner.some((k) => chosen.has(k));
      const expanded = open.has(c.key);
      return [
        <div key={c.key} className="kx-zotero-collection" style={{ paddingLeft: 8 + depth * 18 }} role="treeitem" aria-level={depth + 1} aria-expanded={inner.length ? expanded : undefined}>
          {inner.length ? (
            <button
              className="kx-zotero-disclosure"
              aria-label={expanded ? `Collapse ${c.name}` : `Expand ${c.name}`}
              data-open={expanded || undefined}
              onClick={() => {
                const next = new Set(open);
                expanded ? next.delete(c.key) : next.add(c.key);
                setOpen(next);
              }}
            >
              <Icon name="chevronRight" size={10} />
            </button>
          ) : (
            <span className="kx-zotero-disclosure" />
          )}
          <label>
            <TriState checked={chosen.has(c.key)} mixed={!chosen.has(c.key) && some} onChange={(on) => toggle(c.key, on)} label={c.name} />
            <Icon name="folder" size={13} />
            <span className="kx-zotero-name">{c.name}</span>
            <span className="kx-zotero-items">{n(c.total)}</span>
          </label>
        </div>,
        ...(expanded ? rows(c.key, depth + 1) : []),
      ];
    });
  const all = collections.length > 0 && collections.every((c) => chosen.has(c.key));
  return (
    <div className="kx-zotero-tree">
      <div className="kx-zotero-tree-tools">
        <button onClick={() => onChange(all ? new Set() : new Set(collections.map((c) => c.key)))}>{all ? "Choose none" : "Choose all"}</button>
        <button onClick={() => setOpen(open.size ? new Set() : new Set(collections.map((c) => c.key)))}>{open.size ? "Collapse all" : "Expand all"}</button>
      </div>
      <div role="tree" aria-label="Zotero collections" aria-multiselectable="true">
        {rows(null, 0)}
      </div>
    </div>
  );
}

function TriState({ checked, mixed, onChange, label }: { checked: boolean; mixed: boolean; onChange: (on: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return <input ref={ref} type="checkbox" aria-label={label} aria-checked={mixed ? "mixed" : checked} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

const STAGES: Record<string, string> = {
  starting: "Preparing…",
  reading: "Reading your Zotero library…",
  items: "Importing items",
  notes: "Converting notes",
  saving: "Finishing…",
};

function ProgressView({ progress, preview }: { progress: ZoteroProgress | "starting" | undefined; preview?: ZoteroPreview }) {
  const p = typeof progress === "object" ? progress : undefined;
  const stage = p?.stage ?? "starting";
  return (
    <div className="kx-zotero-progress" aria-live="polite">
      <strong>{STAGES[stage] ?? "Importing…"}</strong>
      {p && p.total > 0 ? <progress max={p.total} value={p.done} /> : <progress />}
      <small>{p && p.total > 0 ? `${n(p.done)} of ${n(p.total)}` : preview ? <Counts counts={preview.selected} /> : null}</small>
    </div>
  );
}

function Summary({ report, workspace }: { report: ZoteroReport; workspace: WorkspaceSummary }) {
  const lines = [
    report.added && `${plural(report.added, "item")} added`,
    report.updated && `${plural(report.updated, "item")} updated`,
    report.unchanged && `${plural(report.unchanged, "item")} already up to date`,
    report.collections && `${plural(report.collections, "collection")} created`,
    report.notes && `${plural(report.notes, "note")} added`,
    report.notesUpdated && `${plural(report.notesUpdated, "note")} converted or updated`,
    report.linkedFiles && `${plural(report.linkedFiles, "file")} linked`,
    report.missingFiles && `${plural(report.missingFiles, "file")} not found on this Mac`,
    report.keptDeleted && `${plural(report.keptDeleted, "item")} you deleted in Key left out`,
  ].filter(Boolean) as string[];
  return (
    <div className="kx-zotero-summary">
      <span className="kx-zotero-done">
        <Icon name="check" size={16} />
      </span>
      <strong>Imported into “{workspace.name}”</strong>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {report.conflictCount > 0 && <Conflicts report={report} />}
    </div>
  );
}

/** Values kept in Key although Zotero changed them too. */
export function Conflicts({ report }: { report: ZoteroReport }) {
  return (
    <details className="kx-zotero-conflicts">
      <summary>
        {plural(report.conflictCount, "edit")} made in Key {report.conflictCount === 1 ? "was" : "were"} kept over Zotero’s
      </summary>
      <ul>
        {report.conflicts.map((c, i) => (
          <li key={i}>
            <strong>{c.title || "Untitled"}</strong> · {c.what}
            <small>{c.detail}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}
