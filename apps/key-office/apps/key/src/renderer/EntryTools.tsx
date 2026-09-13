import {
  Button,
  Input,
  Textarea,
  Select,
  Surface,
  Badge,
} from "@key/design-system";
import { GlobalDrawer, GlobalDialog } from "./GlobalDrawer";
import { useEffect, useState, useRef } from "react";
import { parseReferences } from "./reference-import";
import {
  agentInputs,
  defaultInstruction,
  resolveAgentRecipe,
  withAgentRecipe,
  type AgentInput,
  type AgentAttribute,
} from "./agent-recipe";
import type { LibraryHomeProps } from "./LibraryHome";
type Invoke = LibraryHomeProps["invoke"];
export interface SourceEntry {
  id: string;
  kind: string;
  title: string;
  body: string;
  properties: Record<string, unknown>;
  revision: number;
  workspaceId?: string;
}
interface Props {
  invoke: Invoke;
  workspaceId?: string;
  projectId?: string;
  onClose: () => void;
  onSaved: () => void;
}
function highlight(text: string, query: string) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  return i < 0 ? (
    text
  ) : (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}
const types = [
  "web",
  "reference",
  "note",
  "image",
  "video",
  "audio",
  "dataset",
];
function Frame({
  title,
  onClose,
  children,
  embedded = false,
  className = "",
  drawer = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  embedded?: boolean;
  className?: string;
  drawer?: boolean;
}) {
  if (drawer)
    return (
      <GlobalDrawer onClose={onClose}>
        <Frame title={title} onClose={onClose} className={className} embedded>
          {children}
        </Frame>
      </GlobalDrawer>
    );
  if (embedded && className.includes("key-agent-fill-dialog"))
    return (
      <section className={`key-shell-dialog ${className}`} aria-label={title}>
        <header style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>{title}</h2>
          <Button
            type="button"
            aria-label="Close agent settings"
            onClick={onClose}
          >
            ×
          </Button>
        </header>
        {children}
      </section>
    );
  if (embedded)
    return (
      <section className="key-record-editor key-entry-pane">
        <h2>{title}</h2>
        {children}
      </section>
    );
  return (
    <GlobalDialog label={title} onClose={onClose}>
      <section
        className={`key-shell-dialog ${className}`}
      >
        <header style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>{title}</h2>
          <Button onClick={onClose} aria-label="Close">
            ×
          </Button>
        </header>
        {children}
      </section>
    </GlobalDialog>
  );
}
export function AddEntryDialog(props: Props) {
  return <EntryDetails {...props} />;
}
const reservedEntryProperties = new Set([
  "sourceType",
  "url",
  "contentMode",
  "pdfHash",
  "authors",
  "year",
  "doi",
  "fullTextUrl",
  "metadataSource",
]);
export function EntryDetails({
  invoke,
  workspaceId,
  projectId,
  onClose,
  onSaved,
  entry,
  embedded = false,
  onState,
}: Props & {
  entry?: SourceEntry;
  embedded?: boolean;
  onState?: (dirty: boolean, title: string) => void;
}) {
  const [extras, setExtras] = useState<Record<string, unknown>>({});
  const [propertyName, setPropertyName] = useState("");
  const [propertyValue, setPropertyValue] = useState("");
  const [propertyType, setPropertyType] = useState("text");
  const [notice, setNotice] = useState("");
  const [lookup, setLookup] = useState<any>();
  const [authors, setAuthors] = useState(
    ((entry?.properties.authors as string[]) ?? []).join("; "),
  );
  const [year, setYear] = useState(String(entry?.properties.year ?? ""));
  const [bibliography, setBibliography] = useState("");
  const [loaded, setLoaded] = useState<SourceEntry | undefined>(
    entry?.body ? entry : undefined,
  );
  const [type, setType] = useState(
    String(entry?.properties.sourceType ?? "web"),
  );
  const [title, setTitle] = useState(entry?.title ?? "");
  const [url, setUrl] = useState(String(entry?.properties.url ?? ""));
  const [content, setContent] = useState(entry?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = workspaceId ?? entry?.workspaceId;
  const baseline = useRef<string | undefined>(undefined);
  const fields = JSON.stringify({
    title,
    url,
    type,
    content,
    authors,
    year,
    extras,
  });
  const stateCallback = useRef(onState);
  stateCallback.current = onState;
  useEffect(() => {
    stateCallback.current?.(
      baseline.current !== undefined && fields !== baseline.current,
      title,
    );
  }, [fields, loaded]);

  useEffect(() => {
    if (!entry) return;
    let live = true;
    void invoke<SourceEntry>("workspace_entry", { id: entry.id }, id)
      .then((r) => {
        if (live) {
          setExtras(
            Object.fromEntries(
              Object.entries(r.properties).filter(
                ([key]) => !reservedEntryProperties.has(key),
              ),
            ),
          );
          baseline.current = JSON.stringify({
            title: r.title,
            url: String(r.properties.url ?? ""),
            type: String(r.properties.sourceType),
            content: r.body,
            authors: ((r.properties.authors as string[]) ?? []).join("; "),
            year: String(r.properties.year ?? ""),
            extras: Object.fromEntries(
              Object.entries(r.properties).filter(
                ([key]) => !reservedEntryProperties.has(key),
              ),
            ),
          });
          setLoaded(r);
          setContent(r.body);
          setTitle(r.title);
          setUrl(String(r.properties.url ?? ""));
          setType(String(r.properties.sourceType));
          setAuthors(((r.properties.authors as string[]) ?? []).join("; "));
          setYear(String(r.properties.year ?? ""));
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, [entry?.id, id]);
  async function save() {
    if (year && !Number.isInteger(Number(year))) {
      setError("Enter a valid year");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await invoke<SourceEntry>(
        "workspace_save_entry",
        {
          id: entry?.id ?? null,
          sourceType: type,
          title,
          url:
            type === "reference" && /^10\.\d{4,9}\//.test(url.trim())
              ? "https://doi.org/" + url.trim()
              : url,
          content,
          properties: {
            ...Object.fromEntries(
              Object.entries(loaded?.properties ?? {}).filter(([key]) =>
                reservedEntryProperties.has(key),
              ),
            ),
            ...extras,
            authors: authors
              .split(";")
              .map((a) => a.trim())
              .filter(Boolean),
            year: year ? Number(year) : null,
            ...(lookup
              ? {
                  fullTextUrl: lookup.fullTextUrl ?? null,
                  metadataSource: lookup.source ?? null,
                  doi: lookup.doi ?? null,
                }
              : {}),
          },
          expectedRevision: loaded?.revision ?? null,
          projectId: projectId ?? null,
        },
        id,
      );
      baseline.current = fields;
      setLoaded(saved);
      onSaved();
      if (!embedded) onClose();
      else setNotice("Saved");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function lookupMetadata() {
    setBusy(true);
    setError("");
    try {
      setLookup(
        await invoke("scholarly_lookup_resource", { resource: url.trim() }, id),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function importBibliography() {
    setBusy(true);
    setError("");
    let count = 0;
    try {
      const records = parseReferences(bibliography);
      for (const r of records) {
        await invoke(
          "workspace_save_entry",
          {
            sourceType: "reference",
            title: r.title,
            url: r.url,
            content: "",
            properties: r.properties,
            projectId: projectId ?? null,
          },
          id,
        );
        count++;
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(`${count} imported. ${String(e)}`);
      if (count) onSaved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Frame
      title={entry ? "Edit source" : "Add source"}
      onClose={onClose}
      embedded={embedded}
    >
      <p>Save source information and searchable text in this workspace.</p>
      {!id && <p role="alert">Choose a workspace before adding a source.</p>}
      <label>
        Source type
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
      </label>
      <label>
        Title
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={256}
        />
      </label>
      <label>
        Source URL
        <Input
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {type === "reference" && (
        <>
          <label>
            Authors separated by semicolons
            <Input
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
            />
          </label>
          <label>
            Year
            <Input
              type="number"
              step="1"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !url.trim()}
            onClick={() => void lookupMetadata()}
          >
            Look up metadata
          </Button>
          {lookup && (
            <Surface className="key-metadata-proposal">
              <h3>Review retrieved metadata</h3>
              <strong>{lookup.title}</strong>
              <p>
                {lookup.authors?.join("; ")} · {lookup.year ?? "Year unknown"}
              </p>
              <p>{lookup.abstractText?.slice(0, 1000)}</p>
              <small>Source: {lookup.source}</small>
              <Button
                onClick={() => {
                  if (lookup.title) setTitle(lookup.title);
                  if (lookup.authors?.length)
                    setAuthors(lookup.authors.join("; "));
                  if (lookup.year) setYear(String(lookup.year));
                  if (!content && lookup.abstractText)
                    setContent(lookup.abstractText);
                }}
              >
                Use reviewed metadata
              </Button>
            </Surface>
          )}
          {(lookup?.fullTextUrl || loaded?.properties.fullTextUrl) && (
            <Button
              disabled={busy || !entry?.id}
              onClick={() => {
                setBusy(true);
                void invoke(
                  "library_download_pdf",
                  {
                    url: lookup?.fullTextUrl ?? loaded?.properties.fullTextUrl,
                    entryId: entry?.id,
                  },
                  id,
                )
                  .then(async (info: any) => {
                    if (!loaded)
                      throw Error("Reload the reference to link this PDF");
                    const saved = await invoke<SourceEntry>(
                      "workspace_save_entry",
                      {
                        id: loaded.id,
                        sourceType: loaded.properties.sourceType,
                        title: loaded.title,
                        url: loaded.properties.url ?? "",
                        content: loaded.body,
                        properties: {
                          ...loaded.properties,
                          pdfHash: info.hash,
                        },
                        expectedRevision: loaded.revision,
                      },
                      id,
                    );
                    setLoaded(saved);
                    onSaved();
                    setNotice("PDF added and linked to this reference");
                    await (window as any).key.openSource({
                      ...info,
                      documentHash: info.hash,
                      workspaceId: id,
                    });
                  })
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              Get open-access PDF{!entry?.id ? " (save reference first)" : ""}
            </Button>
          )}
        </>
      )}
      <label>
        {type === "note" ? "Note" : "Supplied text or description"}
        <Textarea
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <p style={{ fontSize: 12 }}>
        URLs are saved without downloading pages. Media transcription, image
        recognition and automatic reference enrichment are not run. Text you
        provide is indexed for search.
      </p>
      <details>
        <summary>Custom properties</summary>
        {Object.entries(extras).map(([name, value]) => (
          <div key={name} style={{ display: "flex", gap: 8 }}>
            <span>
              {name}:{" "}
              {typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
            </span>
            <Button
              onClick={() =>
                setExtras((old) =>
                  Object.fromEntries(
                    Object.entries(old).filter(([key]) => key !== name),
                  ),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <label>
          Property name
          <Input
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
            maxLength={128}
          />
        </label>
        <label>
          Type
          <Select
            value={propertyType}
            onChange={(e) => setPropertyType(e.target.value)}
          >
            <option>text</option>
            <option>number</option>
            <option>boolean</option>
          </Select>
        </label>
        <label>
          Value
          <Input
            value={propertyValue}
            onChange={(e) => setPropertyValue(e.target.value)}
            maxLength={4096}
          />
        </label>
        <Button
          onClick={() => {
            const name = propertyName.trim();
            if (
              !name ||
              reservedEntryProperties.has(name) ||
              Object.keys(extras).length >= 64
            ) {
              setError(
                "Choose a custom property name; up to 64 properties are supported",
              );
              return;
            }
            if (
              (propertyType === "number" &&
                (!propertyValue.trim() ||
                  !Number.isFinite(Number(propertyValue)))) ||
              (propertyType === "boolean" &&
                !["true", "false"].includes(propertyValue))
            ) {
              setError("Enter a valid typed value");
              return;
            }
            setExtras((old) => ({
              ...old,
              [name]:
                propertyType === "number"
                  ? Number(propertyValue)
                  : propertyType === "boolean"
                    ? propertyValue === "true"
                    : propertyValue,
            }));
            setPropertyName("");
            setPropertyValue("");
          }}
        >
          Add or update property
        </Button>
        <p>Changes are saved with the source.</p>
      </details>
      {notice && <p role="status">{notice}</p>}
      {!entry && (
        <details>
          <summary>Import BibTeX or RIS references</summary>
          <Input
            type="file"
            accept=".bib,.ris"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 256 * 1024) {
                setError("Reference import is limited to 256 KiB");
                return;
              }
              void file.text().then(setBibliography);
            }}
          />
          <Textarea
            rows={5}
            aria-label="BibTeX or RIS content"
            value={bibliography}
            onChange={(e) => setBibliography(e.target.value)}
            placeholder="Paste BibTeX or RIS…"
          />
          <Button
            disabled={busy || !id || !bibliography.trim()}
            onClick={() => void importBibliography()}
          >
            Import references
          </Button>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      <Button
        data-save-record
        disabled={!id || busy || !title.trim() || (!!entry && !loaded)}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save source"}
      </Button>
    </Frame>
  );
}
export function EntriesList({
  invoke,
  workspaceId,
  projectId,
  onOpen,
  active = true,
  refreshKey = 0,
}: {
  invoke: Invoke;
  workspaceId?: string;
  projectId?: string;
  onOpen?: (entry: SourceEntry) => void;
  active?: boolean;
  refreshKey?: number;
}) {
  const request = useRef(0);
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [editing, setEditing] = useState<SourceEntry>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  async function load(offset = 0) {
    const seq = ++request.current;
    setBusy(true);
    try {
      const p = await invoke<{
        entries: SourceEntry[];
        total: number;
        nextOffset: number | null;
      }>(
        "workspace_entries",
        { projectId: projectId ?? null, query: submitted, offset, limit: 50 },
        workspaceId,
      );
      if (seq !== request.current) return;
      setEntries((old) => (offset ? [...old, ...p.entries] : p.entries));
      setNext(p.nextOffset);
      setTotal(p.total);
      setError("");
    } catch (e) {
      if (seq === request.current) setError(String(e));
    } finally {
      if (seq === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => setSubmitted(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      request.current++;
    };
  }, [workspaceId, projectId, submitted, revision, active, refreshKey]);
  const refresh = () => setRevision((r) => r + 1);
  return (
    <section aria-label="Other sources">
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2>
          Other sources <small>{total}</small>
        </h2>
        <Button disabled={!workspaceId} onClick={() => setAdding(true)}>
          Add source
        </Button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query);
        }}
      >
        <Input
          aria-label="Search other sources"
          placeholder="Search titles, URLs and supplied text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button>Search</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <table className="key-source-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Content</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.workspaceId}:${e.id}`}>
              <td>
                <Button
                  onClick={() => {
                    if (onOpen) onOpen(e);
                    else setEditing(e);
                  }}
                >
                  {highlight(e.title, submitted)}
                </Button>
              </td>
              <td>{String(e.properties.sourceType)}</td>
              <td>
                {e.properties.contentMode === "user-provided"
                  ? "Supplied text indexed"
                  : "Metadata indexed"}
              </td>
              <td>
                <Button onClick={() => (onOpen ? onOpen(e) : setEditing(e))}>
                  Edit
                </Button>
                {typeof e.properties.url === "string" && e.properties.url && (
                  <Button
                    onClick={() =>
                      void (window as any).key.tabAction("open-url", {
                        url: e.properties.url,
                      })
                    }
                  >
                    Open link ↗
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length && !busy && (
        <p>
          No sources yet. Add links, references, notes or media information.
        </p>
      )}
      {next !== null && (
        <Button disabled={busy} onClick={() => void load(next)}>
          Load more
        </Button>
      )}
      {adding && (
        <AddEntryDialog
          invoke={invoke}
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setAdding(false)}
          onSaved={refresh}
        />
      )}{" "}
      {editing && (
        <EntryDetails
          invoke={invoke}
          workspaceId={editing.workspaceId ?? workspaceId}
          projectId={projectId}
          entry={editing}
          onClose={() => setEditing(undefined)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
export function AgentPropertyDialog({
  invoke,
  workspaceId,
  onClose,
  onSaved,
  hashes = [],
  propertyName = "",
  embedded = false,
}: Props & { hashes?: string[]; propertyName?: string; embedded?: boolean }) {
  const [endpoint, setEndpoint] = useState("http://localhost:11434/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [selectedProposals, setSelectedProposals] = useState<string[]>([]);
  const [name, setName] = useState(propertyName);
  const [prompt, setPrompt] = useState(defaultInstruction);
  const [inputs, setInputs] = useState<AgentInput[]>(["title", "pdfText"]);
  const [enabled, setEnabled] = useState(true);
  const [attribute, setAttribute] = useState<AgentAttribute>();
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [type, setType] = useState("text");
  const [options, setOptions] = useState("");
  const [status, setStatus] = useState<{
    available: boolean;
    reason?: string;
    provider?: string;
    model?: string;
  }>();
  const [proposals, setProposals] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void invoke<any>("agent_fill_status", {}, workspaceId)
      .then(setStatus)
      .catch((e) => setMessage(String(e)));
  }, [workspaceId]);
  useEffect(() => {
    let active = true;
    setLoadingRecipe(true);
    const timer = setTimeout(() => {
      if (!workspaceId) {
        setLoadingRecipe(false);
        return;
      }
      void Promise.all([
        invoke<AgentAttribute[]>("workspace_attributes", {}, workspaceId),
        name.trim()
          ? invoke<Record<string, unknown> | null>(
              "workspace_agent_property",
              { name: name.trim() },
              workspaceId,
            )
          : Promise.resolve(null),
      ])
        .then(([attributes, legacy]) => {
          if (!active) return;
          const found = attributes.find((a) => a.name === name.trim());
          const recipe = resolveAgentRecipe(found, legacy ?? undefined);
          setAttribute(found);
          setPrompt(recipe.instruction);
          setInputs(recipe.inputs);
          setEnabled(recipe.enabled);
          setType(recipe.type);
          setOptions(recipe.options.join("; "));
          setProposals([]);
          setSelectedProposals([]);
          setLoadingRecipe(false);
        })
        .catch((e) => {
          if (active)
            setMessage(
              `Could not load the property recipe. Close and reopen to retry: ${String(e)}`,
            );
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId, name]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  const config = {
    prompt,
    inputs,
    type,
    options: options
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  return (
    <Frame
      title="Fill a property"
      onClose={onClose}
      className="key-agent-fill-dialog"
      embedded={embedded}
      drawer={!embedded}
    >
      <Surface tone="quiet" className="key-agent-intro">
        <Badge>{hashes.length} selected PDFs</Badge>
        <p>
          Choose the information your agent can use. Review every proposal
          before saving.
        </p>
        <small>Up to 25 PDFs per batch.</small>
      </Surface>
      <section
        className="key-agent-section"
        aria-label="Property configuration"
      >
        <h3>Property</h3>
        <label>
          Property name
          <Input
            value={name}
            disabled={!!propertyName || busy}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Value type
          <Select
            value={type}
            disabled={!!attribute?.type || loadingRecipe}
            onChange={(e) => setType(e.target.value)}
          >
            {type === "formula" && (
              <option value="formula">Formula · calculated locally</option>
            )}
            {["text", "number", "boolean", "select"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </label>
        {type === "select" && (
          <label>
            Options separated by semicolons
            <Input
              value={options}
              disabled={!!attribute?.type || loadingRecipe}
              onChange={(e) => setOptions(e.target.value)}
            />
          </label>
        )}
        <label>
          <Input
            type="checkbox"
            style={{ width: "auto", marginRight: 8 }}
            checked={enabled}
            disabled={loadingRecipe || busy}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable agent fill for this property
        </label>
        <p>
          Enabling saves a reusable recipe. Nothing runs automatically: Generate
          sends only the checked inputs, and confirmed proposals are saved after
          review.
        </p>
        {attribute?.type && (
          <small>
            Value type and select options follow the workspace property
            definition.
          </small>
        )}
      </section>
      <fieldset className="key-agent-section key-agent-inputs">
        <legend>Inputs</legend>
        {agentInputs.map((input) => (
          <label key={input}>
            <Input
              type="checkbox"
              style={{ width: "auto", marginRight: 8 }}
              disabled={loadingRecipe || busy}
              checked={inputs.includes(input)}
              onChange={(e) =>
                setInputs((old) =>
                  e.target.checked
                    ? [...old, input]
                    : old.filter((i) => i !== input),
                )
              }
            />
            {input === "pdfText"
              ? "PDF text (up to 32 KiB from first extracted blocks)"
              : input}
          </label>
        ))}
      </fieldset>
      <section className="key-agent-section" aria-label="Agent instructions">
        <label>
          Instructions
          <Textarea
            rows={4}
            value={prompt}
            maxLength={8192}
            disabled={loadingRecipe || busy}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <Button
          disabled={
            busy ||
            loadingRecipe ||
            !workspaceId ||
            !name.trim() ||
            !inputs.length ||
            type === "formula"
          }
          onClick={() =>
            void action(async () => {
              const attributes = await invoke<AgentAttribute[]>(
                "workspace_attributes",
                {},
                workspaceId,
              );
              const current = attributes.find((a) => a.name === name.trim());
              if (
                current?.type &&
                (current.type !== type ||
                  JSON.stringify(current.options ?? []) !==
                    JSON.stringify(attribute?.options ?? []))
              )
                throw Error(
                  "Property definition changed. Reopen agent fill before saving.",
                );
              const saved = withAgentRecipe(
                current,
                name.trim(),
                type,
                config.options,
                { inputs, instruction: prompt, enabled },
              );
              await invoke(
                "workspace_save_attribute",
                { name: name.trim(), config: saved },
                workspaceId,
              );
              setAttribute({ name: name.trim(), ...saved });
              onSaved();
              setMessage(
                "Recipe saved for this property. No inputs have been sent.",
              );
            })
          }
        >
          Save instructions
        </Button>
      </section>
      {status?.available ? (
        <p>
          Provider: {status.provider} · {status.model}
        </p>
      ) : (
        <p role="status">
          Unavailable: {status?.reason ?? "Checking provider…"} Use the
          Configure provider form below.
        </p>
      )}
      <details className="key-agent-provider">
        <summary>Configure an OpenAI-compatible provider</summary>
        <label>
          Endpoint
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
        <label>
          Model
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          API key (optional for a local provider)
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label>
          <Input
            type="checkbox"
            style={{ width: "auto", marginRight: 8 }}
            checked={clearKey}
            onChange={(e) => setClearKey(e.target.checked)}
          />
          Clear saved API key (otherwise blank keeps it)
        </label>
        <Button
          disabled={busy || !model.trim()}
          onClick={() =>
            void action(async () => {
              setStatus(
                await invoke<any>(
                  "agent_fill_configure",
                  {
                    baseUrl: endpoint,
                    model,
                    apiKey: clearKey ? "" : apiKey || undefined,
                  },
                  workspaceId,
                ),
              );
              setApiKey("");
              setClearKey(false);
              setMessage(
                "Provider configured. Generate proposals to send the selected inputs.",
              );
            })
          }
        >
          Save provider
        </Button>
      </details>
      <Button
        variant="primary"
        disabled={
          busy ||
          !workspaceId ||
          !status?.available ||
          loadingRecipe ||
          !enabled ||
          type === "formula" ||
          !hashes.length ||
          hashes.length > 25 ||
          !name.trim() ||
          !inputs.length
        }
        onClick={() =>
          void action(async () => {
            const r = await invoke<any>(
              "agent_fill_propose",
              { hashes, name: name.trim(), ...config },
              workspaceId,
            );
            setProposals(r.proposals);
            setSelectedProposals(r.proposals.map((p: any) => p.id));
            setMessage(
              r.errors
                .map((e: any) => `${e.hash.slice(0, 8)}: ${e.error}`)
                .join("\n"),
            );
          })
        }
      >
        {busy ? "Working…" : "Generate proposals"}
      </Button>
      {proposals.length > 0 && (
        <section className="key-agent-proposals">
          <h3>Review {proposals.length} proposals</h3>
          {proposals.map((p) => (
            <Surface className="key-agent-proposal" key={p.id}>
              <Input
                type="checkbox"
                style={{ width: "auto", marginRight: 8 }}
                aria-label={`Accept proposal for ${p.title}`}
                checked={selectedProposals.includes(p.id)}
                onChange={(e) =>
                  setSelectedProposals((old) =>
                    e.target.checked
                      ? [...old, p.id]
                      : old.filter((id) => id !== p.id),
                  )
                }
              />
              <strong>{p.title}</strong>
              <p>
                {p.name}: {String(p.value)}
              </p>
              <small>
                {p.provider} · {p.model} · {p.inputs.join(", ")}
              </small>
            </Surface>
          ))}
          <Button
            variant="primary"
            disabled={busy || !selectedProposals.length}
            onClick={() =>
              void action(async () => {
                const r = await invoke<any>(
                  "agent_fill_apply",
                  { ids: selectedProposals },
                  workspaceId,
                );
                setProposals([]);
                setMessage(`${r.applied} values saved with provenance`);
                onSaved();
              })
            }
          >
            Confirm selected values
          </Button>
          <Button disabled={busy} onClick={() => setProposals([])}>
            Dismiss proposals
          </Button>
        </section>
      )}
      <details>
        <summary>Copy known metadata without AI</summary>
        <p>This copies existing values and leaves populated cells unchanged.</p>
        {["title", "authors", "year", "pageCount"].map((input) => (
          <Button
            key={input}
            disabled={busy || !workspaceId || !name.trim() || !hashes.length}
            onClick={() =>
              void action(async () => {
                const r = await invoke<any>(
                  "workspace_fill_known_property",
                  { hashes, name, input },
                  workspaceId,
                );
                setMessage(`${r.filled} copied; ${r.skipped} skipped`);
                onSaved();
              })
            }
          >
            Copy {input}
          </Button>
        ))}
      </details>
      {message && (
        <p role="status" style={{ whiteSpace: "pre-wrap" }}>
          {message}
        </p>
      )}
    </Frame>
  );
}
