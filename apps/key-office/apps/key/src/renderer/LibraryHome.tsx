import SearchSourceMetadata from "./SearchSourceMetadata";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./library.css";
import { AddEntryDialog, AgentPropertyDialog, EntriesList } from "./EntryTools";
import TagManagerDialog from "./TagManagerDialog";
import TagChips from "./TagChips";
import { mergePropertyColumns, type PropertyDefinition } from "./property-columns";
import { preparePropertyDraft } from "./property-draft";
import PropertyManager from "./PropertyManager";
import PropertyEditor, { type PropertyDraft } from "./PropertyEditor";
import { evaluatePropertyFormula } from "./property-formula";
import LibraryTable, {
  defaultColumns,
  LiteralMatches,
  type SourceColumn,
} from "./LibraryTable";

export interface LibrarySource {
  documentId: string;
  documentHash: string;
  title: string;
  pageCount: number;
  status: string;
  keywordReady?: boolean;
  year?: number;
  authors?: string[];
  completed: number;
  total: number;
  error?: string;
  updatedAtMs?: number;
  addedAtMs?: number | null;
  workspaceId?: string;
}
export interface LibraryHit {
  id: string;
  documentId: string;
  documentHash: string;
  documentTitle?: string;
  page: number;
  text: string;
  targetText: string;
  score: number;
  workspaceId?: string;
}
export interface LibraryHomeProps {
  invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    workspaceId?: string,
  ) => Promise<T>;
  workspaceId?: string;
  projectId?: string;
  scopeLabel?: string;
  openDocumentIds?: ReadonlySet<string>;
  onOpenSource: (
    source: LibrarySource,
    hit?: LibraryHit,
    hits?: LibraryHit[],
    query?: string,
  ) => void;
  onOpenItem?: (item: unknown) => void;
  onDismissSearch?: () => void;
  activePreview?: {id:string;workspaceId:string;documentHash:string;page:number;documentTitle?:string};
  onAddSources: () => void;
  refreshKey?: number;
  active?: boolean;
}
interface LibraryPage {
  documents: LibrarySource[];
  nextOffset: number | null;
  total: number;
  counts?: {
    all: number;
    removed: number;
    searchable: number;
    processing: number;
    attention: number;
  };
}
interface Metadata {
  tags: string[];
  collections: string[];
  properties: Record<string, string | number | boolean | null>;
}
const emptyFilter = {
  author: "",
  yearFrom: "",
  yearTo: "",
  tag: "",
  collection: "",
  annotations: "any",
  metadataText: "",
  property: "",
  type: "text",
  value: "",
};
const activeStates = new Set(["queued", "processing", "indexing"]);
const identity = (d: LibrarySource | LibraryHit) =>
  `${d.workspaceId || ""}:${d.documentHash}`;
function statusText(d: LibrarySource) {
  if (d.status === "indexed")
    return `${d.total.toLocaleString()} searchable passages`;
  if (d.status === "no_text") return "No extractable text";
  if (d.status === "needs_source") return "Original PDF needed";
  if (d.status === "failed") return d.error || "Processing failed";
  if (d.status === "paused") return "Paused";
  if (d.status === "queued") return "Waiting to process";
  if (d.status === "indexing")
    return `${d.completed.toLocaleString()} / ${d.total.toLocaleString()} passages${d.keywordReady ? " · keyword ready" : ""}`;
  return "Extracting text…";
}

export default function LibraryHome({
  invoke,
  workspaceId,
  projectId,
  scopeLabel = "Library",
  openDocumentIds = new Set<string>(),
  onOpenSource,
  onDismissSearch,
  activePreview,
  onOpenItem,
  onAddSources,
  refreshKey,
  active = true,
}: LibraryHomeProps) {
  const libraryRoot = useRef<HTMLElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [sourceKind, setSourceKind] = useState("pdf"),
    [entryDialog, setEntryDialog] = useState(false),
    [agentDialog, setAgentDialog] = useState(false),
    [agentProperty, setAgentProperty] = useState("");
  const [previewHit, setPreviewHit] = useState<LibraryHit>();
  const [counts, setCounts] = useState<LibraryPage["counts"]>();
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [columns, setColumns] = useState<SourceColumn[]>(defaultColumns);
  const [tagManager, setTagManager] = useState(false),
    [activity, setActivity] = useState(false);
  const [showColumns, setShowColumns] = useState(false),
    [checked, setChecked] = useState<Set<string>>(new Set());
  const [attributeContext, setAttributeContext] = useState<{workspaceId?:string;targets:LibrarySource[];properties:Record<string,unknown>;title?:string}>();
  const [agentSelection, setAgentSelection] = useState<{workspaceId?:string;hashes:string[]}>();
  useEffect(()=>{setAttribute(false);setAgentDialog(false);setAgentSelection(undefined);},[workspaceId,projectId]);
  useEffect(()=>{if(agentDialog&&!agentSelection)setAgentSelection({workspaceId,hashes:checked.size?documents.filter(d=>checked.has(identity(d))).map(d=>d.documentHash):selected?[selected.documentHash]:[]});},[agentDialog]);
  const [attributeApply, setAttributeApply] = useState(false);
  const [attribute, setAttribute] = useState(false),
    [attributeName, setAttributeName] = useState(""),
    [attributeType, setAttributeType] = useState("text"),
    [attributeValue, setAttributeValue] = useState("");
  const [bulkTag, setBulkTag] = useState(""),
    [attributeOptions, setAttributeOptions] = useState(""),
    [attributeFormula, setAttributeFormula] = useState("");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const searchRef = useRef<() => void>(() => {});
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`key:library-columns:${workspaceId || "all"}`) ||
          "null",
      );
      setColumns(
        Array.isArray(saved) &&
          saved.every(
            (c) =>
              typeof c.id === "string" &&
              typeof c.label === "string" &&
              Number.isFinite(c.width),
          )
          ? saved
          : defaultColumns,
      );
    } catch {
      setColumns(defaultColumns);
    }
  }, [workspaceId]);
  const updateColumns = (next: SourceColumn[]) => {
    setColumns(next);
    try {
      localStorage.setItem(
        `key:library-columns:${workspaceId || "all"}`,
        JSON.stringify(next),
      );
    } catch {}
  };
  const [documents, setDocuments] = useState<LibrarySource[]>([]);
  const [scope, setScope] = useState("all");
  const [view, setView] = useState("table");
  const [sort, setSort] = useState("title");
  const openKeys = [...openDocumentIds].sort();
  const openSignature = scope === "open" ? openKeys.join("|") : "";
  const pageFilters = {
    sort,
    statuses:
      scope === "attention"
        ? ["failed", "paused", "needs_source", "no_text"]
        : null,
    documentHashes:
      scope === "open"
        ? openKeys
            .filter(
              (key) =>
                !workspaceId ||
                !key.includes(":") ||
                key.startsWith(`${workspaceId}:`),
            )
            .map((key) => key.split(":").pop()!)
            .filter((key) => /^[a-f0-9]{64}$/i.test(key))
        : null,
    documentKeys: scope === "open" ? openKeys : null,
  };

  const [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<LibrarySource>();
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [details, setDetails] = useState<Metadata>();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [sourceRecordId, setSourceRecordId] = useState<string>();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [hits, setHits] = useState<LibraryHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [filter, setFilter] = useState(emptyFilter);
  const [showFilters, setShowFilters] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [roadmap, setRoadmap] = useState(false);
  const [removed, setRemoved] = useState<LibrarySource>();
  const request = useRef(0);
  const submittedArgs = useRef<Record<string, unknown> | undefined>(undefined);
  const context = useRef(0);
  const call = <T,>(
    command: string,
    args: Record<string, unknown> = {},
    source?: LibrarySource,
  ) => invoke<T>(command, args, source?.workspaceId || workspaceId);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false, request = 0;
    let pendingRename: {name:string;newName:string}|undefined;
    const loadDefinitions = async (rename?:{name:string;newName:string}) => {
      if(rename)pendingRename=rename;
      const current = ++request;
      try {
        const definitions = await invoke<PropertyDefinition[]>("workspace_attributes", {}, workspaceId);
        if(cancelled || current!==request)return;
        const resolvedRename=pendingRename;pendingRename=undefined;
        setColumns(previous=>{const merged=mergePropertyColumns(previous,definitions,resolvedRename);try{localStorage.setItem(`key:library-columns:${workspaceId}`,JSON.stringify(merged));}catch{}return merged;});
        setMetadataRevision(n=>n+1);
        const source=selectedRef.current;
        if(source){const metadata=await invoke<Metadata>("library_metadata_details",{hash:source.documentHash},source.workspaceId||workspaceId);if(!cancelled&&current===request&&selectedRef.current&&identity(selectedRef.current)===identity(source))setDetails(metadata);}
      } catch(e){if(!cancelled&&current===request)setError(String(e));}
    };
    void loadDefinitions();
    const unsubscribe=(window as unknown as {key?:{on?:(event:string,callback:(payload:any)=>void)=>()=>void}}).key?.on?.('property-definitions-changed',payload=>{if(payload?.workspaceId===workspaceId)void loadDefinitions(payload.name&&payload.newName?{name:payload.name,newName:payload.newName}:undefined);});
    return ()=>{cancelled=true;unsubscribe?.();};
  }, [invoke, workspaceId]);
  const refresh = async () => {
    const page = await call<LibraryPage>("semantic_library_page", {
      projectId: projectId || null,
      offset,
      limit: 200,
      removed: scope === "removed",
      ...pageFilters,
    });
    setDocuments(page.documents);
    setNextOffset(page.nextOffset);
    setTotal(page.total);
    setCounts(page.counts);
  };
  useEffect(() => {
    const generation = ++context.current;
    ++request.current;
    setChecked(new Set());
    setSelected(undefined);
    setPreviewHit(undefined);
    setDetails(undefined);
    setSubmitted("");
    setHits([]);
    setCursor(null);
    setSearching(false);
    setError("");
    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!activeRef.current) {
        timer = setTimeout(poll, 2000);
        return;
      }
      try {
        const page = await invoke<LibraryPage>(
          "semantic_library_page",
          {
            projectId: projectId || null,
            offset,
            limit: 200,
            removed: scope === "removed",
            ...pageFilters,
          },
          workspaceId,
        );
        const next = page.documents;
        if (generation !== context.current) return;
        setDocuments(next);
        setNextOffset(page.nextOffset);
        setTotal(page.total);
        setCounts(page.counts);
        setSelected((previous) =>
          previous
            ? next.find((d) => identity(d) === identity(previous))
            : undefined,
        );
        setLoading(false);
        timer = setTimeout(
          poll,
          next.some((d) => activeStates.has(d.status)) ? 900 : 3500,
        );
      } catch (e) {
        if (generation === context.current) {
          setError(String(e));
          setLoading(false);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => {
      ++context.current;
      ++request.current;
      clearTimeout(timer);
    };
  }, [
    invoke,
    workspaceId,
    projectId,
    scope,
    refreshKey,
    offset,
    sort,
    openSignature,
  ]);
  useEffect(() => {
    setOffset(0);
  }, [workspaceId, projectId, scope, sort]);
  useEffect(() => {
    setDetails(undefined);
    setSourceRecordId(undefined);
    setProjects([]);
    if (!selected) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await call<{ id: string; name: string }[]>(
          "workspace_projects",
          {},
          selected,
        );
        if (cancelled) return;
        setProjects(list);
        const source = await call<{ id: string } | null>(
          "workspace_record",
          { id: `source:${selected.documentHash}` },
          selected,
        );
        if (!cancelled) setSourceRecordId(source?.id);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    void call<Metadata>(
      "library_metadata_details",
      { hash: selected.documentHash },
      selected,
    )
      .then((d) => {
        if (!cancelled) setDetails(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.documentHash, selected?.workspaceId]);
  const isOpen = (d: LibrarySource) =>
    openDocumentIds.has(d.documentId) ||
    openDocumentIds.has(d.documentHash) ||
    openDocumentIds.has(identity(d));
  const visible = documents;
  useEffect(() => {
    if(!activePreview) return;
    const found=hits.find(hit=>hit.id===activePreview.id && (hit.workspaceId || workspaceId)===activePreview.workspaceId);
    if(found) {setPreviewHit(found);setSelected(undefined);setActivity(false);}
  },[activePreview?.id,activePreview?.workspaceId]);
  useEffect(() => {
    if(!activePreview) return;
    const frame=requestAnimationFrame(()=> {
      const scroll=libraryRoot.current?.querySelector<HTMLElement>('.key-library-scroll');
      const hit=scroll?.querySelector<HTMLElement>('[aria-current="true"].key-library-hit');
      if (!scroll || !hit) return;
      const bounds=scroll.getBoundingClientRect(), target=hit.getBoundingClientRect();
      const delta=target.top<bounds.top ? target.top-bounds.top : target.bottom>bounds.bottom ? target.bottom-bounds.bottom : 0;
      if(delta) scroll.scrollBy({top:delta,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    });
    return ()=>cancelAnimationFrame(frame);
  },[previewHit?.id,previewHit?.workspaceId]);
  const groups = useMemo(() => {
    const map = new Map<string, LibraryHit[]>();
    for (const h of hits) {
      const key = identity(h);
      map.set(key, [...(map.get(key) || []), h]);
    }
    return [...map.values()];
  }, [hits]);
  const run = async (action: () => Promise<void>, success = "") => {
    if (busy) return;
    const generation = context.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (generation === context.current) {
        await refresh();
        setMessage(success);
        setMetadataRevision((n) => n + 1);
      }
    } catch (e) {
      if (generation === context.current) setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const search = async (next: string | null = null) => {
    clearTimeout(liveTimer.current);
    if (!query.trim()) return;
    const yearFrom = filter.yearFrom ? Number(filter.yearFrom) : null,
      yearTo = filter.yearTo ? Number(filter.yearTo) : null;
    if (
      (yearFrom !== null && !Number.isInteger(yearFrom)) ||
      (yearTo !== null && !Number.isInteger(yearTo)) ||
      (yearFrom !== null && yearTo !== null && yearFrom > yearTo)
    ) {
      setError("Enter a valid year range.");
      return;
    }
    if (
      filter.property &&
      filter.type === "number" &&
      (!filter.value.trim() || !Number.isFinite(Number(filter.value)))
    ) {
      setError("Enter a finite property number.");
      return;
    }
    if (
      filter.property &&
      filter.type === "boolean" &&
      !["true", "false"].includes(filter.value)
    ) {
      setError("Enter true or false for the property value.");
      return;
    }
    const seq = ++request.current;
    setSearching(true);
    setError("");
    if (!next) {
      setSubmitted(query.trim());
      setHits([]);
      setCursor(null);
    }
    try {
      const searchArgs =
        next && submittedArgs.current
          ? { ...submittedArgs.current, cursor: next }
          : {
              query: query.trim(),
              cursor: next,
              projectId: projectId || null,
              filter: {
                author: filter.author || null,
                yearFrom,
                yearTo,
                tag: filter.tag || null,
                collection: filter.collection || null,
                hasAnnotations:
                  filter.annotations === "any"
                    ? null
                    : filter.annotations === "yes",
                metadataText: filter.metadataText || null,
                properties: filter.property
                  ? {
                      [filter.property]:
                        filter.type === "number"
                          ? Number(filter.value)
                          : filter.type === "boolean"
                            ? filter.value === "true"
                            : filter.value,
                    }
                  : {},
              },
            };
      if (!next) submittedArgs.current = searchArgs;
      const page = await call<{
        hits: LibraryHit[];
        nextCursor: string | null;
        capped: boolean;
      }>("global_search_page", searchArgs);
      if (seq !== request.current) return;
      setHits((previous) => (next ? [...previous, ...page.hits] : page.hits));
      setCursor(page.nextCursor);
      setCapped(page.capped);
    } catch (e) {
      if (seq === request.current) {
        setError(String(e));
        if (!next) setHits([]);
      }
    } finally {
      if (seq === request.current) setSearching(false);
    }
  };
  searchRef.current = () => {
    void search();
  };
  useEffect(() => {
    ++request.current;
    clearTimeout(liveTimer.current);
    if (!active) return;
    if (!query.trim()) {
      setSubmitted("");
      setHits([]);
      setCursor(null);
      setSearching(false);
      return;
    }
    liveTimer.current = setTimeout(() => searchRef.current(), 250);
    return () => clearTimeout(liveTimer.current);
  }, [query, filter, workspaceId, projectId, active]);
  const bulk = async (action: string) => {
    const targets = documents.filter((d) => checked.has(identity(d)));
    if (!targets.length || busy) return;
    setBusy(true);
    setError("");
    let completed = 0;
    try {
      for (const d of targets) {
        if (action === "tag") {
          const meta = await call<Metadata>(
            "library_metadata_details",
            { hash: d.documentHash },
            d,
          );
          await call(
            "library_set_labels",
            {
              hash: d.documentHash,
              tags: [...new Set([...meta.tags, bulkTag.trim()])],
              collections: meta.collections,
            },
            d,
          );
        } else if (action === "remove" || action === "restore") {
          await call(
            "library_set_removed",
            { hash: d.documentHash, removed: action === "remove" },
            d,
          );
        } else
          await call(
            "library_processing_control",
            { hash: d.documentHash, action },
            d,
          );
        completed++;
        setMessage(`${completed} of ${targets.length} updated`);
      }
      setChecked(new Set());
      await refresh();
    } catch (e) {
      setError(`${completed} of ${targets.length} updated. ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const capturePropertyContext = (single = false) => {
    const targets = single && selected ? [selected] : checked.size ? documents.filter(d=>checked.has(identity(d))) : selected ? [selected] : [];
    setAttributeContext({workspaceId,targets:targets.map(d=>({...d,workspaceId:d.workspaceId||workspaceId})),title:selected?.title,properties:{Title:selected?.title??null,Year:selected?.year??null,Pages:selected?.pageCount??null,Authors:selected?.authors?.join('; ')??null,...Object.fromEntries(columns.filter(c=>c.property&&!c.property.startsWith('@')).map(c=>[c.property!,null])),...details?.properties}});
  };
  const newProperty = () => { capturePropertyContext(); setError(""); setAttributeApply(false); setAttributeName(""); setAttributeType("text"); setAttributeValue(""); setAttributeOptions(""); setAttributeFormula(""); setAttribute(true); };
  const editProperty = (c: SourceColumn, apply = false) => { capturePropertyContext(apply); setError(""); setAttributeApply(apply); setAttributeName(c.property || c.label); setAttributeType(c.type || "text"); setAttributeOptions(c.options?.join('; ') || ''); setAttributeFormula(c.formula || ''); setAttributeValue(String(details?.properties[c.property || c.label] ?? '')); setAttribute(true); };
  const applyAttribute = async (draft: PropertyDraft, configureAgent = false) => {
    let prepared: ReturnType<typeof preparePropertyDraft>;
    try { prepared = preparePropertyDraft(draft); } catch(e) { setError(String(e)); return; }
    const { name, value, config } = prepared;
    if (!attributeName && columns.some(c=>c.id===`property:${name}`)) { setError("A property with this name already exists. Edit it from Properties instead."); return; }
    const originalName = attributeName;
    const renaming = Boolean(originalName && originalName !== name);
    if(renaming && draft.type==='formula' && draft.formula.trim()!==attributeFormula.trim()){setError("Save your formula changes before renaming this property.");return;}
    const attributeType = draft.type, formulaToCalculate = draft.formula;
    const propertyGeneration = context.current;
    const targetWorkspace = attributeContext?.workspaceId;
    const targets = draft.applyValues ? attributeContext?.targets || [] : [];
    if (!targetWorkspace) { setError("Choose a workspace to define a property."); return; }
    await run(
      async () => {
        const calculated = [];
        for (const d of targets) {
          let next = value;
          if (attributeType === "formula") {
            const meta = await call<Metadata>(
              "library_metadata_details",
              { hash: d.documentHash },
              d,
            );
            next = evaluatePropertyFormula(formulaToCalculate, {
              ...meta.properties,
              title: d.title,
              year: d.year ?? null,
              pages: d.pageCount,
              authors: d.authors?.join("; ") || "",
            });
          }
          calculated.push({ d, value: next });
        }
        if(renaming){
          const renamed=await invoke<{attribute?:{formula?:string}}>("workspace_rename_attribute",{name:originalName,newName:name},targetWorkspace);
          if(config.type==='formula' && renamed.attribute?.formula)config.formula=renamed.attribute.formula;
          if(propertyGeneration===context.current)setAttributeName(name);
        }
        const definitions = await invoke<Array<Record<string, unknown> & {name:string}>>("workspace_attributes", {}, targetWorkspace);
        const previousDefinition: Record<string, unknown> = definitions.find(definition=>definition.name===name) || {};
        const {name: _key, type: _type, options: _options, formula: _formula, ...retained} = previousDefinition;
        await invoke("workspace_save_attribute", { name, config: {...retained, ...config} }, targetWorkspace);
        for (const item of calculated)
          await call(
            "library_set_property",
            { hash: item.d.documentHash, name, value: item.value },
            item.d,
          );
        if (propertyGeneration !== context.current) return;
        const currentDefinitions = await invoke<PropertyDefinition[]>("workspace_attributes", {}, targetWorkspace);
        if(propertyGeneration!==context.current)return;
        setColumns(previous=>{const merged=mergePropertyColumns(previous,currentDefinitions,renaming?{name:originalName,newName:name}:undefined);try{localStorage.setItem(`key:library-columns:${targetWorkspace}`,JSON.stringify(merged));}catch{}return merged;});
        setAttribute(false);
        setMetadataRevision(n => n + 1);
        if(configureAgent) { setAgentSelection({workspaceId:targetWorkspace,hashes:(attributeContext?.targets||[]).map(d=>d.documentHash)}); setAgentProperty(name); setAgentDialog(true); }
        if (selected) {
          const refreshed = await call<Metadata>("library_metadata_details", {hash:selected.documentHash}, selected);
          if (selectedRef.current && identity(selectedRef.current)===identity(selected) && propertyGeneration===context.current) setDetails(refreshed);
        }
      },
      `Attribute saved${targets.length ? ` on ${targets.length} sources` : ""}`,
    );
  };
  const openHit = (hit: LibraryHit) => {
    const source = documents.find((d) => identity(d) === identity(hit)) || {
      documentId: hit.documentId,
      documentHash: hit.documentHash,
      title: hit.documentTitle || "Document",
      workspaceId: hit.workspaceId,
      pageCount: hit.page + 1,
      status: "indexed",
      completed: 0,
      total: 0,
    };
    onOpenSource(source, hit, hits, submitted);
  };
  const saveMetadata = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const source = selected;
    const data = new FormData(event.currentTarget);
    void run(async () => {
      await call(
        "library_update_metadata",
        {
          hash: source.documentHash,
          title: String(data.get("title")),
          authors: String(data.get("authors"))
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean),
          year: data.get("year") ? Number(data.get("year")) : null,
        },
        source,
      );
      setSelected({
        ...source,
        title: String(data.get("title")),
        authors: String(data.get("authors"))
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean),
        year: data.get("year") ? Number(data.get("year")) : undefined,
      });
    }, "Metadata saved");
  };
  return (
    <section ref={libraryRoot} className={`key-library ${previewHit && !selected ? "has-search-metadata" : ""}`} aria-label="Library">
      <div className="key-library-main">
        <header className="key-library-heading">
          <div>
            <div className="key-library-breadcrumb">Home / Sources</div>
            <h1>{scopeLabel}</h1>
            <p>
              {total} documents ·{" "}
              {counts?.searchable ??
                documents.filter((d) => d.status === "indexed").length}{" "}
              fully indexed ·{" "}
              {counts?.processing ??
                documents.filter((d) => activeStates.has(d.status)).length}{" "}
              processing
            </p>
          </div>
          <button onClick={() => setRoadmap(true)}>
            Roadmap <span className="key-mock-badge">Preview</span>
          </button>
        </header>
        <nav className="key-library-scopes" aria-label="Library views">
          {[
            ["all", "All sources"],
            ["open", "Open"],
            ["attention", "Needs attention"],
            ["removed", "Removed"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={scope === id}
              onClick={() => setScope(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <nav className="key-library-scopes" aria-label="Source types">
          <button
            aria-pressed={sourceKind === "pdf"}
            onClick={() => setSourceKind("pdf")}
          >
            PDFs
          </button>
          <button
            aria-pressed={sourceKind === "other"}
            onClick={() => setSourceKind("other")}
          >
            References, web & media
          </button>
          <button disabled={!workspaceId} onClick={() => setEntryDialog(true)}>
            ＋ Reference / other source
          </button>
        </nav>
        {sourceKind === "other" && (
          <EntriesList
            active={active}
            refreshKey={refreshKey}
            onOpen={onOpenItem}
            invoke={invoke}
            workspaceId={workspaceId}
            projectId={projectId}
          />
        )}
        <div style={{ display: sourceKind === "pdf" ? "contents" : "none" }}>
          <div className="key-library-toolbar">
            <div className="key-view-switch">
              {["table", "list"].map((v) => (
                <button
                  key={v}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {v === "table" ? "▤ Table" : "☷ List"}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input
                aria-label="Search passages"
                placeholder="Search passages · keyword or describe an idea"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button disabled={searching || !query.trim()}>Search</button>
            </form>
            <button
              aria-expanded={showFilters}
              onClick={() => setShowFilters(!showFilters)}
            >
              Filter
            </button>
            <select
              aria-label="Sort library"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="title">{workspaceId?'Title':'Title · within each workspace'}</option>
              <option value="year">{workspaceId?'Year':'Year · within each workspace'}</option>
              <option value="updated">{workspaceId?'Last updated':'Updated · within each workspace'}</option>
            </select>
            <button className="key-primary" onClick={onAddSources}>
              ＋ Add PDFs
            </button>
          </div>
          <div className="key-library-tools">
            <button
              disabled={!workspaceId}
              onClick={() => {
                setAgentProperty("");
                setAgentDialog(true);
              }}
            >
              Agentic fill
            </button>
            <button
              onClick={() => {
                setActivity(!activity);
                setSelected(undefined);
                setPreviewHit(undefined);
              }}
            >
              Activity
            </button>
            <button disabled={!workspaceId} onClick={() => setTagManager(true)}>
              PDF tags
            </button>
            <button
              aria-expanded={showColumns}
              onClick={() => setShowColumns(!showColumns)}
            >
              Properties
            </button>
            <button disabled={!workspaceId} title={!workspaceId ? "Choose a workspace to manage properties" : "Create a typed workspace property"} onClick={newProperty}>＋ Property</button>
            {checked.size > 0 && (
              <>
                <strong>{checked.size} selected</strong>
                <button disabled={busy} onClick={() => void bulk("pause")}>
                  Pause
                </button>
                <button disabled={busy} onClick={() => void bulk("resume")}>
                  Resume
                </button>
                <button disabled={busy} onClick={() => void bulk("retry")}>
                  Retry
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void bulk(scope === "removed" ? "restore" : "remove")
                  }
                >
                  {scope === "removed" ? "Restore" : "Remove"}
                </button>
                <input
                  aria-label="Tag selected sources"
                  placeholder="Add tag…"
                  value={bulkTag}
                  onChange={(e) => setBulkTag(e.target.value)}
                />
                <button
                  disabled={busy || !bulkTag.trim()}
                  onClick={() => void bulk("tag")}
                >
                  Apply tag
                </button>
                <button onClick={() => setChecked(new Set())}>
                  Clear selection
                </button>
              </>
            )}
          </div>
          {showColumns && <PropertyManager columns={columns} onChange={updateColumns} disabled={busy||!workspaceId} onAdd={newProperty} onEdit={editProperty} onFill={c=>{setAgentProperty(c.property!);setAgentDialog(true);}} onDelete={(c,deleteValues)=>void run(async()=>{await call('workspace_delete_attribute',{name:c.property,deleteValues});updateColumns(columns.filter(x=>x.id!==c.id));setMetadataRevision(n=>n+1);if(selected)setDetails(await call<Metadata>('library_metadata_details',{hash:selected.documentHash},selected));},deleteValues?'Property and values deleted':'Property definition removed; values retained')} />}
          <div className="key-filter-chips">
            {Object.entries(filter)
              .filter(
                ([key, value]) =>
                  value &&
                  key !== "type" &&
                  !(key === "annotations" && value === "any") &&
                  key !== "value",
              )
              .map(([key, value]) => (
                <button
                  key={key}
                  onClick={() =>
                    setFilter({
                      ...filter,
                      [key]: key === "annotations" ? "any" : "",
                    })
                  }
                >
                  {key}: {value} ×
                </button>
              ))}
          </div>
          {showFilters && (
            <form
              className="key-library-filters"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              {[
                ["author", "Author"],
                ["yearFrom", "Year from"],
                ["yearTo", "Year to"],
                ["tag", "Tag"],
                ["collection", "Collection"],
                ["metadataText", "Metadata or comments"],
                ["property", "Property name"],
                ["value", "Property value"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={filter[key as keyof typeof filter]}
                    onChange={(e) =>
                      setFilter({ ...filter, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label>
                Annotations
                <select
                  value={filter.annotations}
                  onChange={(e) =>
                    setFilter({ ...filter, annotations: e.target.value })
                  }
                >
                  <option value="any">Any</option>
                  <option value="yes">With annotations</option>
                  <option value="no">Without annotations</option>
                </select>
              </label>
              <label>
                Property type
                <select
                  value={filter.type}
                  onChange={(e) =>
                    setFilter({ ...filter, type: e.target.value })
                  }
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">True / false</option>
                </select>
              </label>
              <button type="button" onClick={() => setFilter(emptyFilter)}>
                Reset
              </button>
              <button disabled={searching || !query.trim()}>
                Apply to search
              </button>
            </form>
          )}
          {error && (
            <div className="key-library-error" role="alert">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {message && (
            <p className="key-library-message" role="status">
              {message}
            </p>
          )}
          {removed && (
            <p className="key-library-message" role="status">
              Removed “{removed.title}”.{" "}
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(
                      "library_set_removed",
                      { hash: removed.documentHash, removed: false },
                      removed,
                    );
                    setRemoved(undefined);
                  }, "Restored")
                }
              >
                Undo
              </button>
            </p>
          )}
          <div className="key-library-scroll">
            {submitted ? (
              <div className="key-library-results">
                <header>
                  <strong>
                    {searching ? "Searching…" : `${hits.length} matches loaded`}{" "}
                    for “{submitted}”
                  </strong>
                  <button
                    onClick={() => {
                      ++request.current;
                      setSearching(false);
                      setSubmitted("");
                      setHits([]);
                      onDismissSearch?.();
                    }}
                  >
                    Back to library
                  </button>
                </header>
                {!searching && !hits.length && !error && (
                  <p className="key-library-empty">
                    No matching passages. Try different words or fewer filters.
                  </p>
                )}
                {groups.map((group) => (
                  <article key={identity(group[0])}>
                    <h2>
                      {group[0].documentTitle ||
                        documents.find(
                          (d) => identity(d) === identity(group[0]),
                        )?.title ||
                        "Document"}{" "}
                      <small>· {group.length} passages</small>
                    </h2>
                    {group.map((hit) => (
                      <button
                        className={`key-library-hit ${previewHit?.id === hit.id && identity(previewHit) === identity(hit) ? "preview-active" : ""}`}
                        aria-current={previewHit?.id === hit.id && identity(previewHit) === identity(hit) ? "true" : undefined}
                        key={`${identity(hit)}:${hit.id}`}
                        onClick={() => {
                          setPreviewHit(hit);
                          setSelected(undefined);
                          setActivity(false);
                          openHit(hit);
                        }}

                      >
                        <span>
                          Page {hit.page + 1} <span>Open beside results →</span>
                        </span>
                        <p>
                          <LiteralMatches
                            text={hit.targetText || hit.text}
                            query={submitted}
                          />
                        </p>
                      </button>
                    ))}
                  </article>
                ))}
                {cursor && (
                  <button
                    disabled={searching}
                    onClick={() => void search(cursor)}
                  >
                    Load more results
                  </button>
                )}
                {capped && (
                  <p>
                    Showing up to 1,000 candidate passages. Narrow your search
                    for more specific results.
                  </p>
                )}
              </div>
            ) : loading ? (
              <p className="key-library-empty" role="status">
                Loading sources…
              </p>
            ) : !visible.length ? (
              <div className="key-library-empty">
                <h2>
                  {scope === "all"
                    ? "Your sources live here"
                    : "No documents in this view"}
                </h2>
                <p>
                  Add PDFs to read immediately. Search indexing happens in the
                  background.
                </p>
                <button onClick={onAddSources}>Add PDFs</button>
              </div>
            ) : (
              <LibraryTable onSort={setSort}
                onProperty={c=>{if(c)editProperty(c);else newProperty();}}
                onFillProperty={(c,d)=>{setChecked(new Set([identity(d)]));setAgentProperty(c.property!);setAgentDialog(true);}}
                saveProperty={async (d, c, raw) => {
                  let value: unknown = raw;
                  if (c.type === "number") {
                    if (!raw.trim() || !Number.isFinite(Number(raw)))
                      throw Error("Enter a finite number");
                    value = Number(raw);
                  }
                  if (c.type === "boolean") {
                    if (!["true", "false"].includes(raw))
                      throw Error("Choose true or false");
                    value = raw === "true";
                  }
                  await call(
                    "library_set_property",
                    { hash: d.documentHash, name: c.property, value },
                    d,
                  );
                  setMetadataRevision((n) => n + 1);
                }}
                revision={metadataRevision}
                documents={visible}
                columns={columns}
                setColumns={updateColumns}
                view={view}
                selected={selected}
                checked={checked}
                setChecked={setChecked}
                onSelect={setSelected}
                onOpen={(d) => {
                  if (scope !== "removed") onOpenSource(d);
                }}
                isOpen={isOpen}
                status={statusText}
                metadata={(d) =>
                  call<Metadata>(
                    "library_metadata_details",
                    { hash: d.documentHash },
                    d,
                  )
                }
              />
            )}
            {!submitted && (offset > 0 || nextOffset !== null) && (
              <div className="key-library-pagination">
                <button
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 200))}
                >
                  Previous 200
                </button>
                <span>
                  Sources {Math.min(offset + 1, total)}–
                  {Math.min(offset + documents.length, total)} of {total}
                  {scope === "open" || scope === "attention" ? "" : ""}
                </span>
                <button
                  disabled={loading || nextOffset === null}
                  onClick={() => {
                    if (nextOffset !== null) setOffset(nextOffset);
                  }}
                >
                  Next 200 sources
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {previewHit && !selected && <SearchSourceMetadata hit={previewHit} invoke={invoke} workspaceId={workspaceId} onClose={()=>setPreviewHit(undefined)} onEdit={setSelected}/>}
      {activity && !selected && !previewHit && (
        <aside className="key-library-detail" aria-label="Processing activity">
          <header>
            <strong>Activity</strong>
            <button
              onClick={() => setActivity(false)}
              aria-label="Close activity"
            >
              ×
            </button>
          </header>
          <p>
            Processing status for the {documents.length} sources on this page.
          </p>
          {documents
            .filter(
              (d) =>
                activeStates.has(d.status) ||
                ["failed", "paused", "needs_source"].includes(d.status),
            )
            .map((d) => (
              <div className="key-activity-item" key={identity(d)}>
                <button onClick={() => setSelected(d)}>{d.title}</button>
                <p>{statusText(d)}</p>
                {d.total > 0 && <progress max={d.total} value={d.completed} />}
              </div>
            ))}
          {!documents.some(
            (d) =>
              activeStates.has(d.status) ||
              ["failed", "paused", "needs_source"].includes(d.status),
          ) && <p>No processing tasks need attention on this page.</p>}
        </aside>
      )}
      {selected && (
        <aside className="key-library-detail" aria-label="Document details">
          <header>
            <strong>Details</strong>
            <button
              aria-label="Close details"
              onClick={() => setSelected(undefined)}
            >
              ×
            </button>
          </header>
          <h2>{selected.title}</h2>
          <p>{statusText(selected)}</p>
          <div className="key-detail-actions">
            {scope !== "removed" && (
              <button
                className="key-primary"
                onClick={() =>
                  selected.status === "needs_source"
                    ? void run(async () => {
                        await call(
                          "library_relink",
                          { hash: selected.documentHash },
                          selected,
                        );
                      }, "Source relinked")
                    : onOpenSource(selected)
                }
              >
                {selected.status === "needs_source"
                  ? "Relink original PDF"
                  : isOpen(selected)
                    ? "Go to tab ↗"
                    : "Open PDF ↗"}
              </button>
            )}
            {(activeStates.has(selected.status) ||
              ["paused", "failed"].includes(selected.status)) && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(
                      "library_processing_control",
                      {
                        hash: selected.documentHash,
                        action:
                          selected.status === "paused"
                            ? "resume"
                            : selected.status === "failed"
                              ? "retry"
                              : "pause",
                      },
                      selected,
                    );
                  }, "Processing updated")
                }
              >
                {selected.status === "paused"
                  ? "Resume"
                  : selected.status === "failed"
                    ? "Retry"
                    : "Pause"}
              </button>
            )}
          </div>
          <form key={`metadata:${identity(selected)}`} onSubmit={saveMetadata}>
            <label>
              Title
              <input name="title" defaultValue={selected.title} required />
            </label>
            <label>
              Authors
              <input
                name="authors"
                defaultValue={selected.authors?.join("; ")}
                placeholder="Separate authors with ;"
              />
            </label>
            <label>
              Year
              <input
                name="year"
                type="number"
                step="1"
                defaultValue={selected.year || ""}
              />
            </label>
            <button disabled={busy}>Save metadata</button>
          </form>
          {details && (
            <>
              <form
                key={`labels:${identity(selected)}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const source = selected;
                  void run(async () => {
                    await call(
                      "library_set_labels",
                      {
                        hash: source.documentHash,
                        tags: String(data.get("tags"))
                          .split(";")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        collections: String(data.get("collections"))
                          .split(";")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                      source,
                    );
                  }, "Labels saved");
                }}
              >
                <TagChips name="tags" label="Tags" initial={details.tags} />
                <TagChips
                  name="collections"
                  label="Collections"
                  initial={details.collections}
                />
                <button disabled={busy}>Save labels</button>
              </form>
              <h3>Properties</h3>
              <div className="key-source-property-rows">{Array.from(new Set([...columns.filter(c=>c.id.startsWith('property:')).map(c=>c.property!),...Object.keys(details.properties)])).map(name=>{const column=columns.find(c=>c.property===name)||{id:`property:${name}`,property:name,label:name,width:150,type:typeof details.properties[name]==='number'?'number':typeof details.properties[name]==='boolean'?'boolean':'text'};let value=details.properties[name];if(column.type==='formula'){try{value=evaluatePropertyFormula(column.formula||'', {...details.properties,Title:selected.title,Year:selected.year??null,Pages:selected.pageCount});}catch(e){value=String(e);}}return <div key={name}><button disabled={!workspaceId} onClick={()=>editProperty(column)}>{column.type==='formula'?'ƒ ':column.type==='number'?'# ':'Aa '}{name}</button><button title="Edit property and apply a value to this source" disabled={!workspaceId} onClick={()=>{setChecked(new Set());editProperty(column,true);}}>{value===undefined||value===null||value===''?'Empty':String(value)}</button>{column.type!=='formula'&&<button title={`Fill ${name} for this source`} disabled={!workspaceId} onClick={()=>{setChecked(new Set());setAgentProperty(name);setAgentDialog(true);}}>✧</button>}</div>;})}</div>
              <button disabled={!workspaceId} onClick={newProperty}>＋ Add a property</button>
            </>
          )}
          {projects.length > 0 && (
            <details className="key-source-projects">
              <summary>Project membership</summary>
              {!sourceRecordId && <small>Loading source record…</small>}
              {projects.map((project) => (
                <div key={project.id}>
                  <span>{project.name}</span>
                  <button
                    disabled={busy || !sourceRecordId}
                    onClick={() =>
                      void run(async () => {
                        await call(
                          "workspace_set_project_membership",
                          {
                            projectId: project.id,
                            recordId: sourceRecordId,
                            present: true,
                          },
                          selected,
                        );
                      }, `Added to ${project.name}`)
                    }
                  >
                    Add
                  </button>
                  <button
                    disabled={busy || !sourceRecordId}
                    onClick={() =>
                      void run(async () => {
                        await call(
                          "workspace_set_project_membership",
                          {
                            projectId: project.id,
                            recordId: sourceRecordId,
                            present: false,
                          },
                          selected,
                        );
                      }, `Removed from ${project.name}`)
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </details>
          )}
          <button
            onClick={() => {
              setAgentProperty("");
              setAgentDialog(true);
            }}
          >
            Configure agentic fill{" "}
            <span className="key-mock-badge">Preview</span>
          </button>
          <div className="key-detail-danger">
            {scope === "removed" ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call(
                        "library_set_removed",
                        { hash: selected.documentHash, removed: false },
                        selected,
                      );
                      setSelected(undefined);
                    }, "Document restored")
                  }
                >
                  Restore
                </button>
                <button
                  disabled={busy || isOpen(selected)}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Permanently delete “${selected.title}”, its saved PDF, annotations and metadata? Your original file outside Key is kept. This cannot be undone.`,
                      )
                    )
                      void run(async () => {
                        await call(
                          "library_purge",
                          { hash: selected.documentHash },
                          selected,
                        );
                        setSelected(undefined);
                      }, "Permanently deleted");
                  }}
                >
                  Delete permanently
                </button>
                {isOpen(selected) && (
                  <small>Close this PDF in every tab before deleting it.</small>
                )}
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call(
                      "library_set_removed",
                      { hash: selected.documentHash, removed: true },
                      selected,
                    );
                    setRemoved(selected);
                    setSelected(undefined);
                  }, "")
                }
              >
                Remove from library
              </button>
            )}
          </div>
        </aside>
      )}
      {entryDialog && (
        <AddEntryDialog
          invoke={invoke}
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setEntryDialog(false)}
          onSaved={() => {
            setEntryDialog(false);
            setSourceKind("other");
          }}
        />
      )}
      {agentDialog && (
        <AgentPropertyDialog
          invoke={invoke}
          workspaceId={agentSelection?.workspaceId || workspaceId}
          projectId={projectId}
          hashes={
            agentSelection?.hashes || (checked.size
              ? documents
                  .filter((d) => checked.has(identity(d)))
                  .map((d) => d.documentHash)
              : selected
                ? [selected.documentHash]
                : [])
          }
          propertyName={agentProperty}
          onClose={() => {setAgentDialog(false);setAgentSelection(undefined);}}
          onSaved={() => {
            void refresh();
            setMetadataRevision((n) => n + 1);
          }}
        />
      )}
      {tagManager && (
        <TagManagerDialog
          invoke={invoke}
          workspaceId={workspaceId}
          onClose={() => setTagManager(false)}
          onSaved={() => {
            void refresh();
            setMetadataRevision((n) => n + 1);
          }}
        />
      )}
      {attribute && <PropertyEditor
        initial={{name:attributeName,type:attributeType,value:attributeValue,options:attributeOptions.split(';').map(s=>s.trim()).filter(Boolean),formula:attributeFormula,applyValues:attributeApply}}
        editing={columns.some(c=>c.id===`property:${attributeName}`)}
        busy={busy} error={error || undefined} targetCount={attributeContext?.targets.length || 0}
        properties={attributeContext?.properties || {}} previewTitle={attributeContext?.title} onClose={()=>setAttribute(false)} onSave={(draft,agent)=>void applyAttribute(draft,agent)}
      />}
      {roadmap && (
        <div className="key-roadmap-backdrop" onClick={() => setRoadmap(false)}>
          <section
            className="key-roadmap"
            role="dialog"
            aria-modal="true"
            aria-label="Library roadmap"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>Library roadmap</h2>
              <button
                aria-label="Close roadmap"
                onClick={() => setRoadmap(false)}
              >
                ×
              </button>
            </header>
            <p>
              The available controls use your real library. The items below
              identify remaining integration limits.
            </p>
            <ul><li><strong>Formula dependencies:</strong> automatic propagation and relation rollups. Derived column displays recalculate locally; stored filter values update when you explicitly save/recompute.</li><li><strong>Automatic media processing:</strong> web page capture, OCR, audio/video transcription, image understanding and timestamp-aware media navigation. Manually supplied text and metadata can already be saved and searched.</li></ul>
            <p>
              PDF import, search, processing controls, scalar properties and
              metadata editing use the real library.
            </p>
            <button onClick={() => setRoadmap(false)}>Back to library</button>
          </section>
        </div>
      )}
    </section>
  );
}
