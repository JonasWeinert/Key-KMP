// The library's columns, sort fields and grid cards for the shared database view.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DatabaseColumn, SortLevel } from "./DatabaseView";
import type { ColumnSetting } from "./database-view-model";
import { Icon } from "./icons";
import { KIND_ICON, bridge, itemTypeLabel, relativeDate, shortCreators, type Collection, type Source } from "./library-api";
import { formulaValue, type PropertyDefinition } from "./PropertySheets";
import { indexLabel } from "./SourceInspector";

export const SOURCE_SORTS: [string, string][] = [
  ["added", "Date added"],
  ["title", "Title"],
  ["creator", "First author"],
  ["year", "Year"],
  ["container", "Journal / container"],
  ["type", "Item type"],
  ["pages", "Pages"],
  ["updated", "Last modified"],
];
export const DEFAULT_SORTS: SortLevel[] = [{ field: "added", descending: true }];

/** Built-in columns followed by one per typed property (hidden until shown). */
export function useSourceColumns({
  definitions,
  collections,
  onCommit,
  onEditProperty,
}: {
  definitions: PropertyDefinition[];
  collections: Collection[];
  onCommit: (source: Source, name: string, value: unknown) => void;
  onEditProperty: (definition: PropertyDefinition) => void;
}): DatabaseColumn<Source>[] {
  // Handlers change every render; the columns only when what they show changes.
  const latest = useRef({ onCommit, onEditProperty });
  latest.current = { onCommit, onEditProperty };
  return useMemo(() => {
    const names = new Map(collections.map((c) => [c.id, c.name]));
    const builtIn: DatabaseColumn<Source>[] = [
      {
        id: "title",
        label: "Title",
        width: 340,
        pinned: true,
        sortField: "title",
        render: (s) => (
          <span className="kx-cell-title">
            <span className="kx-row-kind kx-row-kind-small" data-kind={s.kind}>
              <Icon name={KIND_ICON[s.kind] ?? "doc"} size={12} />
            </span>
            <span>{s.title || "Untitled"}</span>
          </span>
        ),
      },
      { id: "authors", label: "Authors", width: 170, sortField: "creator", render: (s) => shortCreators(s.creators) },
      { id: "year", label: "Year", width: 76, numeric: true, sortField: "year", render: (s) => s.year ?? "" },
      { id: "container", label: "Journal / container", width: 180, sortField: "container", render: (s) => s.containerShort || s.containerTitle || "" },
      { id: "added", label: "Added", width: 100, sortField: "added", render: (s) => <span className="kx-cell-muted">{relativeDate(s.addedAt)}</span> },
      { id: "type", label: "Item type", width: 130, hidden: true, sortField: "type", render: (s) => itemTypeLabel(s.itemType) },
      { id: "pages", label: "Pages", width: 70, hidden: true, numeric: true, sortField: "pages", render: (s) => s.pageCount ?? "" },
      { id: "tags", label: "Tags", width: 160, hidden: true, render: (s) => s.tags.join(", ") },
      { id: "collections", label: "Collections", width: 160, hidden: true, render: (s) => s.collections.map((id) => names.get(id)).filter(Boolean).join(", ") },
      { id: "status", label: "Search readiness", width: 150, hidden: true, render: (s) => <ReadinessCell source={s} /> },
      { id: "updated", label: "Modified", width: 100, hidden: true, sortField: "updated", render: (s) => <span className="kx-cell-muted">{relativeDate(s.updatedAt)}</span> },
    ];
    const properties = definitions.map<DatabaseColumn<Source>>((d) => ({
      id: `property:${d.name}`,
      label: d.name,
      mark: d.type === "formula" ? "ƒ " : undefined,
      width: 130,
      hidden: true,
      numeric: d.type === "number",
      sortField: d.type === "formula" ? undefined : `property:${d.name}`,
      onEdit: () => latest.current.onEditProperty(d),
      render: (s) => <PropertyCell definition={d} source={s} onCommit={(value) => latest.current.onCommit(s, d.name, value)} />,
    }));
    return [...builtIn, ...properties];
  }, [definitions, collections]);
}

/** Older libraries remembered their shown properties separately; they become shown columns. */
export function legacyColumnSettings(workspaceId: string): ColumnSetting[] {
  try {
    const names = JSON.parse(localStorage.getItem(`key.library.columns:${workspaceId}`) || "[]") as string[];
    return names.map((name) => ({ id: `property:${name}`, hidden: false }));
  } catch {
    return [];
  }
}

function ReadinessCell({ source }: { source: Source }) {
  const status = indexLabel(source);
  return (
    <>
      <span className="kx-status-dot" data-tone={status.tone} /> {status.label}
    </>
  );
}

/** A typed property value; double-click edits it in place. */
function PropertyCell({ definition: d, source, onCommit }: { definition: PropertyDefinition; source: Source; onCommit: (value: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const raw = source.properties[d.name];
  if (editing && d.type !== "formula") {
    const done = (value: unknown) => {
      setEditing(false);
      if (value !== raw) onCommit(value);
    };
    return d.type === "select" || d.type === "boolean" ? (
      <select
        autoFocus
        className="kx-cell-editor"
        aria-label={`Edit ${d.name}`}
        defaultValue={String(raw ?? "")}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => done(d.type === "boolean" ? e.target.value === "true" : e.target.value || null)}
        onBlur={() => setEditing(false)}
      >
        <option value="">—</option>
        {(d.type === "boolean" ? ["true", "false"] : d.options ?? []).map((o) => (
          <option key={o} value={o}>
            {d.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
          </option>
        ))}
      </select>
    ) : (
      <input
        autoFocus
        className="kx-cell-editor"
        aria-label={`Edit ${d.name}`}
        defaultValue={String(raw ?? "")}
        inputMode={d.type === "number" ? "decimal" : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const next = e.target.value.trim();
          done(next === "" ? null : d.type === "number" && Number.isFinite(Number(next)) ? Number(next) : next);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  const text = d.type === "formula" ? formulaValue(d, source) : raw === undefined || raw === null ? "" : d.type === "boolean" ? (raw ? "✓" : "") : String(raw);
  return (
    <span
      className={`kx-cell-property ${d.type === "formula" ? "computed" : ""}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (d.type !== "formula") setEditing(true);
      }}
      title={d.type === "formula" ? "Calculated" : "Double-click to edit"}
    >
      {text}
    </span>
  );
}

// Quick Look thumbnails, kept for the session; a miss is remembered so it isn't retried.
const thumbnails = new Map<string, Promise<string | null>>();
function useThumbnail(path?: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!path || !bridge()?.thumbnail) return;
    let live = true;
    let pending = thumbnails.get(path);
    if (!pending) {
      pending = bridge()
        .thumbnail(path, 360)
        .catch(() => null);
      thumbnails.set(path, pending);
    }
    void pending.then((value) => live && setUrl(value));
    return () => {
      live = false;
    };
  }, [path]);
  return url;
}

const coverTone = (id: string) => [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6;

/** A grid card: the file's first page where Quick Look has one, otherwise a typeset cover. */
export function SourceCard({ source }: { source: Source }) {
  const thumbnail = useThumbnail(source.filePath && source.kind !== "web" ? source.filePath : undefined);
  const meta = [shortCreators(source.creators), source.year].filter(Boolean).join(" · ");
  return (
    <>
      <span className="kx-cover" data-tone={coverTone(source.id)} aria-hidden="true">
        <span className="kx-cover-kind">{source.kind === "reference" ? itemTypeLabel(source.itemType).toUpperCase() : source.kind.toUpperCase()}</span>
        <span className="kx-cover-title">{source.title || "Untitled"}</span>
        {!!source.pageCount && <span className="kx-cover-pages">{source.pageCount} pp.</span>}
        {thumbnail && <img className="kx-cover-thumb" src={thumbnail} alt="" draggable={false} />}
      </span>
      <strong title={source.title}>{source.title || "Untitled"}</strong>
      <span>{meta || "No details yet"}</span>
    </>
  );
}
