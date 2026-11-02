import { Button, Input, Select } from "@key/design-system";
import { Checkbox } from "./motion/Checkbox";
import { useColumnReorder } from "./motion/table/use-column-reorder";
import { Table } from "./motion/table/Table";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { evaluatePropertyFormula } from "./property-formula";
import type { LibrarySource } from "./LibraryHome";
import { Icon } from "./icons";

const statusTone = (status: string) =>
  status === "indexed"
    ? "ready"
    : ["failed", "needs_source", "no_text"].includes(status)
      ? "attention"
      : ["queued", "paused"].includes(status)
        ? "idle"
        : "busy";
export interface SourceColumn {
  id: string;
  label: string;
  width: number;
  pinned?: boolean;
  hidden?: boolean;
  property?: string;
  type?: string;
  formula?: string;
  options?: string[];
}
export const defaultColumns: SourceColumn[] = [
  { id: "title", label: "Title", width: 330, pinned: true },
  { id: "authors", label: "Authors", width: 180 },
  { id: "year", label: "Year", width: 70 },
  { id: "pages", label: "Pages", width: 70 },
  { id: "status", label: "Search readiness", width: 210 },
  { id: "type", label: "Item type", width: 100, hidden: true },
  {id:"added",label:"Date added",width:140,hidden:true},
  {
    id: "publication",
    label: "Publication",
    width: 180,
    property: "publication",
    hidden: true,
  },
  { id: "tags", label: "Tags", width: 170, property: "@tags", hidden: true },
  {
    id: "collections",
    label: "Collection",
    width: 170,
    property: "@collections",
    hidden: true,
  },
];
export function LiteralMatches({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const terms = [
    ...new Set(
      (query.match(/"[^"]+"|[\p{L}\p{N}]+/gu) || [])
        .map((s) => s.replace(/^"|"$/g, ""))
        .filter((s) => s.length > 0),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 30);
  if (!terms.length) return <>{text}</>;
  const expression = new RegExp(
    `(?<![\\p{L}\\p{N}])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const children: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(expression)) {
    const at = match.index!;
    children.push(text.slice(from, at), <mark key={at}>{match[0]}</mark>);
    from = at + match[0].length;
  }
  children.push(text.slice(from));
  return <>{children}</>;
}
interface Props {
  onProperty?:(column?:SourceColumn)=>void;
  onFillProperty?:(column:SourceColumn,source:LibrarySource)=>void;
  onSort:(field:string)=>void;
  saveProperty: (
    d: LibrarySource,
    column: SourceColumn,
    value: string,
  ) => Promise<void>;
  revision?: number;
  documents: LibrarySource[];
  columns: SourceColumn[];
  setColumns: (columns: SourceColumn[]) => void;
  view: string;
  selected?: LibrarySource;
  checked: Set<string>;
  setChecked: (ids: Set<string>) => void;
  onSelect: (d: LibrarySource) => void;
  onOpen: (d: LibrarySource) => void;
  isOpen: (d: LibrarySource) => boolean;
  status: (d: LibrarySource) => string;
  metadata: (
    d: LibrarySource,
  ) => Promise<{
    tags: string[];
    collections: string[];
    properties: Record<string, unknown>;
  }>;
}
const keyOf = (d: LibrarySource) => `${d.workspaceId || ""}:${d.documentHash}`;
export default function LibraryTable({
  onProperty, onFillProperty,
  onSort,
  saveProperty,
  revision,
  documents,
  columns,
  setColumns,
  view,
  selected,
  checked,
  setChecked,
  onSelect,
  onOpen,
  isOpen,
  status,
  metadata,
}: Props) {
  const [editing, setEditing] = useState<{
    key: string;
    column: string;
    value: string;
    error?: string;
  }>();
  const [saving, setSaving] = useState(false);
  const commit = async (d: LibrarySource, c: SourceColumn) => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      await saveProperty(d, c, editing.value);
      setEditing(undefined);
    } catch (e) {
      setEditing({ ...editing, error: String(e) });
    } finally {
      setSaving(false);
    }
  };
  const [extra, setExtra] = useState<
    Record<
      string,
      {
        tags: string[];
        collections: string[];
        properties: Record<string, unknown>;
      }
    >
  >({});
  const custom = columns
    .filter((c) => !c.hidden && c.property)
    .map((c) => c.property)
    .join("|");
  useEffect(() => {
    let cancel = false;
    setExtra({});
    if (!custom) return;
    let next = 0;
    const run = async () => {
      while (next < documents.length && !cancel) {
        const d = documents[next++];
        try {
          const result = await metadata(d);
          if (!cancel)
            setExtra((previous) => ({ ...previous, [keyOf(d)]: result }));
        } catch {
          /* Details panel reports metadata failures; cells remain unavailable. */
        }
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(4, documents.length) }, run),
    );
    return () => {
      cancel = true;
    };
  }, [documents.map(keyOf).join("|"), custom, revision]);
  const visible = columns.filter(
    (c) =>
      !c.hidden &&
      (view !== "list" || ["title", "status"].includes(c.id) || c.property),
  );
  const ordered = [
    ...visible.filter((c) => c.pinned),
    ...visible.filter((c) => !c.pinned),
  ];
  const headerRefs=useRef<Record<string,HTMLTableCellElement|null>>({});
  const columnDrag=useColumnReorder({columns:ordered.map(c=>({key:c.id,header:c.label,width:`${c.width}px`})),thRefs:headerRefs,onColumnOrderChange:keys=>{
    const byId=new Map(columns.map(c=>[c.id,c]));
    setColumns([...keys.map(key=>byId.get(key)!).filter(Boolean),...columns.filter(c=>!keys.includes(c.id))]);
  }});
  const left = (col: SourceColumn) =>
    42 +
    ordered
      .slice(
        0,
        ordered.findIndex((c) => c.id === col.id),
      )
      .filter((c) => c.pinned)
      .reduce((sum, c) => sum + c.width, 0);
  const toggle = (d: LibrarySource) => {
    const next = new Set(checked);
    next.has(keyOf(d)) ? next.delete(keyOf(d)) : next.add(keyOf(d));
    setChecked(next);
  };
  const resize = (id: string, width: number) =>
    setColumns(
      columns.map((c) =>
        c.id === id ? { ...c, width: Math.max(60, Math.min(700, width)) } : c,
      ),
    );
  return (
    <Table data={documents} columns={ordered} getRowId={keyOf} rowHeight={view==='list'?60:40} header={
      <thead>
        <tr>
          <th className="key-grid-select">
            <Checkbox label="Select all sources on this page"
              checked={documents.length>0&&documents.every(d=>checked.has(keyOf(d)))}
              indeterminate={documents.some(d=>checked.has(keyOf(d)))&&!documents.every(d=>checked.has(keyOf(d)))}
              onChange={value=>setChecked(value?new Set(documents.map(keyOf)):new Set())}/>
          </th>
          {ordered.map((c,index) => (
            <th
              key={c.id}
              ref={el=>{headerRefs.current[c.id]=el;}}
              data-drop={columnDrag.dragKey ? columnDrag.dropIndex===index : undefined}
              data-drag={columnDrag.dragKey===c.id}
              style={
                c.pinned
                  ? { position: "sticky", left: left(c), zIndex: 4 }
                  : undefined
              }
            >
              <Button type="button" className="key-table-column-grip" aria-label={`Reorder ${c.label} column`} onPointerDown={e=>columnDrag.startReorder(c.id,e)} onPointerCancel={columnDrag.cancelReorder} onKeyDown={e=>{if(e.key==='Escape')columnDrag.cancelReorder();if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const next=[...columns],from=next.indexOf(c),to=from+(e.key==='ArrowLeft'?-1:1);if(to>=0&&to<next.length){[next[from],next[to]]=[next[to],next[from]];setColumns(next);}}}}>⠿</Button>
              {c.id.startsWith('property:') && onProperty ? <Button className="key-property-name-link" aria-label={`Configure ${c.label} property`} onClick={()=>onProperty(c)}>{c.type==='formula'?'ƒ ':''}{c.pinned?'⌖ ':''}{c.label}</Button> : <span role={['title','year'].includes(c.id)?'button':undefined} tabIndex={['title','year'].includes(c.id)?0:undefined} onClick={()=>{if(['title','year'].includes(c.id))onSort(c.id);}} onKeyDown={e=>{if(e.key==='Enter'&&['title','year'].includes(c.id))onSort(c.id);}}
                title={
                  c.formula
                    ? `Derived display: ${c.formula}. Save the attribute to refresh stored filter values.`
                    : c.label
                }
              >
                {c.type === "formula" ? "ƒ " : ""}
                {c.pinned && c.id !== "title" ? "⌖ " : ""}
                {c.label}
              </span>}
              {c.id === "title" && (
                <Button
                  className="key-column-pin"
                  aria-label={`${c.pinned ? "Unpin" : "Pin"} Title column`}
                  aria-pressed={!!c.pinned}
                  title={c.pinned ? "Unpin Title column" : "Pin Title column"}
                  onClick={() => setColumns(columns.map(column =>
                    column.id === c.id ? { ...column, pinned: !column.pinned } : column
                  ))}
                >⌖</Button>
              )}
              <span
                className="key-column-resize"
                role="separator"
                tabIndex={0}
                aria-label={`Resize ${c.label} column`}
                aria-orientation="vertical"
                onKeyDown={(e) => {
                  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                    e.preventDefault();
                    resize(c.id, c.width + (e.key === "ArrowLeft" ? -20 : 20));
                  }
                }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  e.currentTarget.dataset.start = String(e.clientX);
                  e.currentTarget.dataset.width = String(c.width);
                }}
                onPointerMove={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    resize(
                      c.id,
                      Number(e.currentTarget.dataset.width) +
                        e.clientX -
                        Number(e.currentTarget.dataset.start),
                    );
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
              />
            </th>
          ))}
          <th className="key-table-actions" data-drop={columnDrag.dragKey ? columnDrag.dropIndex===ordered.length : undefined}>{onProperty&&<Button aria-label="Add a property" title="Add a property" onClick={()=>onProperty()}><Icon name="plus" size={14} /></Button>}</th><th aria-hidden="true"/>
        </tr>
      </thead>} renderRow={(d) => (
          <tr
            key={keyOf(d)}
            data-selected={checked.has(keyOf(d))}
            className={
              selected && keyOf(selected) === keyOf(d) ? "selected" : ""
            }
            tabIndex={0}
            onClick={() => onSelect(d)}
            onDoubleClick={() => onOpen(d)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && e.key === "Enter") onOpen(d);
            }}
          >
            <td
              className="key-grid-select"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox label={`Select ${d.title}`} checked={checked.has(keyOf(d))} onChange={()=>toggle(d)}/>
            </td>
            {ordered.map((c) => (
              <td
                key={c.id}
                tabIndex={c.id.startsWith('property:') ? 0 : undefined}
                onKeyDown={e=>{if(e.key==='Enter'&&c.id.startsWith('property:')&&c.type!=='formula'){e.preventDefault();e.stopPropagation();setEditing({key:keyOf(d),column:c.id,value:String(extra[keyOf(d)]?.properties[c.property!]??(c.type==='boolean'?'false':''))});}}}
                onClick={e=>{if(c.id.startsWith('property:')&&c.type!=='formula'){e.stopPropagation();if(!editing)setEditing({key:keyOf(d),column:c.id,value:String(extra[keyOf(d)]?.properties[c.property!]??(c.type==='boolean'?'false':''))});}}}
                onDoubleClick={(e) => {
                  if (
                    c.property &&
                    !c.property.startsWith("@") &&
                    c.type !== "formula"
                  ) {
                    e.stopPropagation();
                    setEditing({
                      key: keyOf(d),
                      column: c.id,
                      value: String(
                        extra[keyOf(d)]?.properties[c.property] ?? "",
                      ),
                    });
                  }
                }}
                style={
                  c.pinned
                    ? { position: "sticky", left: left(c), zIndex: 1 }
                    : undefined
                }
              >
                {editing?.key === keyOf(d) && editing.column === c.id ? (
                  <div
                    className="key-inline-edit"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.type === "select" || c.type === "boolean" ? (
                      <Select
                        aria-label={`Edit ${c.label} for ${d.title}`}
                        onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setEditing(undefined);}if(e.key==='Enter'){e.preventDefault();void commit(d,c);}}}
                        autoFocus
                        disabled={saving}
                        value={editing.value}
                        onChange={(e) =>
                          setEditing({ ...editing, value: e.target.value })
                        }
                        onBlur={() => void commit(d, c)}
                      >
                        {c.type==='select'&&<option value="" disabled>Choose…</option>}
                        {(c.type === "boolean"
                          ? ["true", "false"]
                          : c.options || []
                        ).map((option) => (
                          <option key={option}>{option}</option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        autoFocus
                        aria-label={`Edit ${c.label} for ${d.title}`}
                        disabled={saving}
                        value={editing.value}
                        onChange={(e) =>
                          setEditing({ ...editing, value: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commit(d, c);
                          }
                          if (e.key === "Escape") setEditing(undefined);
                        }}
                        onBlur={() => void commit(d, c)}
                      />
                    )}{" "}
                    {onFillProperty && <Button type="button" title={`Review agent proposals for ${c.label}`} onClick={()=>{setEditing(undefined);onFillProperty(c,d);}}>✧ Fill</Button>}
                    {editing.error && (
                      <small role="alert">{editing.error}</small>
                    )}
                  </div>
                ) : c.id === "title" ? (
                  <>
                    <span className="key-source-title" title={d.title}>
                      <span className="kx-file-glyph" aria-hidden="true">PDF</span>
                      <span>{d.title}</span>
                    </span>
                    {isOpen(d) && <span className="key-open-badge">Open</span>}
                    {view === "list" && (
                      <small>
                        {d.authors?.join(", ") || "Unknown author"} ·{" "}
                        {d.year || "—"}{d.pageCount ? ` · ${d.pageCount} pages` : ""}
                      </small>
                    )}
                  </>
                ) : c.id === "authors" ? (
                  d.authors?.join("; ") || "—"
                ) : c.id === "year" ? (
                  d.year || "—"
                ) : c.id === "pages" ? (
                  d.pageCount || "—"
                ) : c.id === "added" ? (d.addedAtMs?new Date(d.addedAtMs).toLocaleDateString():"—") : c.id === "type" ? (
                  "PDF"
                ) : c.id === "tags" ? (
                  extra[keyOf(d)]?.tags.join(", ") || "—"
                ) : c.id === "collections" ? (
                  extra[keyOf(d)]?.collections.join(", ") || "—"
                ) : c.id === "status" ? (
                  <>
                    <span className={`key-source-status ${d.status}`}>
                      <span className="kx-status-dot" data-tone={statusTone(d.status)} />
                      {status(d)}
                    </span>
                    {["queued", "processing", "indexing"].includes(d.status) &&
                      d.total > 0 && (
                        <progress max={d.total} value={d.completed} />
                      )}
                  </>
                ) : (
                  <span>
                    {extra[keyOf(d)]
                      ? formulaValue(c, d, extra[keyOf(d)].properties)
                      : "…"}
                  </span>
                )}
              </td>
            ))}
            <td className="key-table-actions">
              <Button
                aria-label={`Details for ${d.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(d);
                }}
              >
                <Icon name="more" />
              </Button>
            </td>
            <td aria-hidden="true"/>
          </tr>
        )}
    />
  );
}

function formulaValue(
  column: SourceColumn,
  document: LibrarySource,
  properties: Record<string, unknown>,
) {
  try {
    return String(
      column.type === "formula" && column.formula
        ? evaluatePropertyFormula(column.formula, {
            ...properties,
            title: document.title,
            year: document.year ?? null,
            pages: document.pageCount,
            authors: document.authors?.join("; ") || "",
          })
        : (properties[column.property!] ?? "—"),
    );
  } catch (e) {
    return `⚠ ${String(e).replace(/^Error: /, "")}`;
  }
}
