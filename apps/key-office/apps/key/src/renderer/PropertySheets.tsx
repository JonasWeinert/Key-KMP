// Sheets that act on library sources: typed property definitions (create, edit,
// rename, apply), agent fill, the tag manager and adding a reference by identifier.
import { useCallback, useEffect, useState } from "react";
import { AgentPropertyDialog } from "./EntryTools";
import { GlobalDialog } from "./GlobalDrawer";
import { Icon } from "./icons";
import type { Invoke, Source } from "./library-api";
import PropertyEditor, { type PropertyDraft } from "./PropertyEditor";
import { preparePropertyDraft } from "./property-draft";
import { evaluatePropertyFormula } from "./property-formula";
import TagManagerDialog from "./TagManagerDialog";

export interface PropertyDefinition {
  name: string;
  type: "text" | "number" | "boolean" | "select" | "formula";
  options?: string[];
  formula?: string;
}

/** Workspace property definitions; callers reload them after saves and library changes. */
export function usePropertyDefinitions(invoke: Invoke, workspaceId: string) {
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
  const reload = useCallback(() => {
    void invoke<PropertyDefinition[]>("workspace_attributes", {}, workspaceId).then(setDefinitions).catch(() => setDefinitions([]));
  }, [invoke, workspaceId]);
  useEffect(reload, [reload]);
  return { definitions, reload };
}

/** The key the reader and agent use for a source: its content hash, or its id. */
export const sourceKey = (source: Source) => source.fileHash ?? source.id;

/** Formula inputs for one source: its properties plus the core bibliographic fields. */
export function formulaContext(source: Source) {
  return {
    ...source.properties,
    title: source.title ?? "",
    Title: source.title ?? "",
    year: source.year ?? null,
    Year: source.year ?? null,
    pages: source.pageCount ?? 0,
    Pages: source.pageCount ?? 0,
    authors: source.creators.map((c) => c.literal || [c.given, c.family].filter(Boolean).join(" ")).join("; "),
    journal: source.containerTitle ?? "",
  };
}

export function formulaValue(definition: PropertyDefinition, source: Source): string {
  try {
    const value = evaluatePropertyFormula(definition.formula || "", formulaContext(source));
    return value === null || value === undefined ? "" : String(value);
  } catch (e) {
    return `⚠ ${String(e).replace(/^Error: /, "")}`;
  }
}

export type PropertySheetState =
  | { mode: "new"; targets: Source[] }
  | { mode: "edit"; definition: PropertyDefinition; targets: Source[]; applyValue?: boolean };

/** Create or edit a typed property; optionally apply a value to the target sources. */
export function PropertySheet({
  state,
  invoke,
  workspaceId,
  definitions,
  onClose,
  onSaved,
}: {
  state: PropertySheetState;
  invoke: Invoke;
  workspaceId: string;
  definitions: PropertyDefinition[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentFor, setAgentFor] = useState<string>();
  const editing = state.mode === "edit" ? state.definition : undefined;
  const single = state.targets.length === 1 ? state.targets[0] : undefined;
  const initial: PropertyDraft = {
    name: editing?.name ?? "",
    type: editing?.type ?? "text",
    value: editing && single ? String(single.properties[editing.name] ?? "") : "",
    options: editing?.options ?? [],
    formula: editing?.formula ?? "",
    applyValues: state.mode === "new" ? state.targets.length > 0 : !!state.applyValue,
  };
  const save = async (draft: PropertyDraft, configureAgent: boolean) => {
    setError("");
    let prepared: ReturnType<typeof preparePropertyDraft>;
    try {
      prepared = preparePropertyDraft(draft);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      return;
    }
    const { name, value, config } = prepared;
    if (!editing && definitions.some((d) => d.name === name)) {
      setError("A property with this name already exists. Edit it instead.");
      return;
    }
    setBusy(true);
    try {
      if (editing && editing.name !== name) await invoke("workspace_rename_attribute", { name: editing.name, newName: name }, workspaceId);
      await invoke("workspace_save_attribute", { name, config }, workspaceId);
      if (draft.applyValues) {
        for (const target of state.targets) {
          const next =
            draft.type === "formula"
              ? formulaValue({ name, type: "formula", formula: draft.formula }, target)
              : value;
          await invoke("store_update", { id: target.id, patch: { properties: { [name]: next } } }, workspaceId);
        }
      }
      onSaved();
      if (configureAgent) setAgentFor(name);
      else onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PropertyEditor
      initial={initial}
      editing={!!editing}
      busy={busy}
      error={error || undefined}
      targetCount={state.targets.length}
      targetLabel="source"
      properties={single ? formulaContext(single) : {}}
      previewTitle={single?.title}
      onClose={onClose}
      onSave={(draft, agent) => void save(draft, agent)}
      onBack={() => setAgentFor(undefined)}
      agentContent={
        agentFor ? (
          <AgentPropertyDialog
            key={agentFor}
            embedded
            invoke={invoke}
            workspaceId={workspaceId}
            hashes={state.targets.slice(0, 25).map(sourceKey)}
            propertyName={agentFor}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : undefined
      }
    />
  );
}

/** Agent fill for a property across up to 25 sources. */
export function AgentFillSheet({
  invoke,
  workspaceId,
  targets,
  propertyName,
  onClose,
  onSaved,
}: {
  invoke: Invoke;
  workspaceId: string;
  targets: Source[];
  propertyName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <AgentPropertyDialog
      invoke={invoke}
      workspaceId={workspaceId}
      hashes={targets.slice(0, 25).map(sourceKey)}
      propertyName={propertyName ?? ""}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function TagManagerSheet({ invoke, workspaceId, onClose, onSaved }: { invoke: Invoke; workspaceId: string; onClose: () => void; onSaved: () => void }) {
  return <TagManagerDialog invoke={invoke} workspaceId={workspaceId} onClose={onClose} onSaved={onSaved} />;
}

interface ScholarlyMetadata {
  title: string;
  abstractText?: string | null;
  authors: string[];
  year?: number | null;
  journal?: string | null;
  journalShort?: string | null;
  doi?: string | null;
  openAccess?: boolean | null;
  fullTextUrl?: string | null;
  landingUrl?: string | null;
}

/** Splits "Marco A. Palma" into family and given names. */
function personName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (name.includes(",")) {
    const [family, given] = name.split(",", 2);
    return { family: family.trim(), given: given.trim(), role: "author" };
  }
  return parts.length > 1 ? { family: parts.at(-1), given: parts.slice(0, -1).join(" "), role: "author" } : { literal: name.trim(), role: "author" };
}

/** Looks up a DOI, ISBN, arXiv id or URL and adds it as a reference (with its open-access PDF). */
export function IdentifierSheet({
  invoke,
  workspaceId,
  collectionId,
  onClose,
  onAdded,
}: {
  invoke: Invoke;
  workspaceId: string;
  collectionId?: string;
  onClose: () => void;
  onAdded: (source: Source) => void;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<ScholarlyMetadata>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [download, setDownload] = useState(true);
  const lookup = async () => {
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(await invoke<ScholarlyMetadata>("scholarly_lookup_resource", { resource: value.trim() }, workspaceId));
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      const source = await invoke<Source>(
        "store_create",
        {
          source: {
            kind: "reference",
            itemType: "article",
            title: result.title,
            creators: result.authors.map(personName),
            year: result.year ?? undefined,
            containerTitle: result.journal ?? undefined,
            containerShort: result.journalShort ?? undefined,
            doi: result.doi ?? undefined,
            url: result.landingUrl ?? (result.doi ? `https://doi.org/${result.doi}` : undefined),
            abstract: result.abstractText ?? undefined,
            collections: collectionId ? [collectionId] : [],
            indexStatus: result.abstractText ? "pending" : "skipped",
          },
        },
        workspaceId,
      );
      let added = source;
      if (download && result.fullTextUrl) {
        try {
          added = await invoke<Source>("library_download_pdf", { url: result.fullTextUrl, sourceId: source.id }, workspaceId);
        } catch (e) {
          setError(`Added the reference, but the PDF could not be downloaded: ${String(e).replace(/^Error: /, "")}`);
          onAdded(source);
          return;
        }
      }
      onAdded(added);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <GlobalDialog label="Add by identifier" onClose={onClose}>
      <form
        className="key-shell-dialog kx-identifier-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          if (result) void add();
          else void lookup();
        }}
      >
        <h2>Add by identifier</h2>
        <p>Paste a DOI, ISBN, arXiv ID or article URL. Key looks up the metadata and an open-access PDF when one exists.</p>
        <div className="kx-identifier-input">
          <Icon name="search" size={14} />
          <input
            autoFocus
            aria-label="Identifier"
            placeholder="10.1371/journal.pone.0266237"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setResult(undefined);
            }}
          />
          <button type="button" className="kx-button-primary" disabled={busy || !value.trim()} onClick={() => void lookup()}>
            {busy && !result ? "Looking up…" : "Look up"}
          </button>
        </div>
        {result && (
          <div className="kx-identifier-result">
            <strong>{result.title}</strong>
            <span>{[result.authors.slice(0, 3).join(", ") + (result.authors.length > 3 ? " et al." : ""), result.year, result.journal].filter(Boolean).join(" · ")}</span>
            {result.doi && <small>doi:{result.doi}</small>}
            {result.fullTextUrl && (
              <label className="kx-check">
                <input type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} />
                Download the open-access PDF
              </label>
            )}
          </div>
        )}
        {error && <p className="kx-inline-error">{error}</p>}
        <div>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="kx-button-primary" disabled={busy || !result}>
            {busy && result ? "Adding…" : "Add to library"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}
