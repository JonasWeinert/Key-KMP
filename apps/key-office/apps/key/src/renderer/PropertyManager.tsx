import { useState } from "react";
import type { SourceColumn } from "./LibraryTable";
import "./property-tools.css";
export default function PropertyManager({
  columns,
  onChange,
  onEdit,
  onFill,
  onDelete,
  onAdd,
  disabled,
}: {
  columns: SourceColumn[];
  onChange: (next: SourceColumn[]) => void;
  onEdit: (c: SourceColumn) => void;
  onFill: (c: SourceColumn) => void;
  onDelete: (c: SourceColumn, deleteValues: boolean) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(""),
    [confirm, setConfirm] = useState<SourceColumn>();
  return (
    <section className="key-property-manager" aria-label="Manage properties">
      <header>
        <strong>Properties</strong>
        <button disabled={disabled} onClick={onAdd}>
          ＋ New property
        </button>
      </header>
      <input
        aria-label="Find a property"
        placeholder="Find a property…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="key-property-manager-list">
        {columns
          .filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
          .map((c) => (
            <div className="key-property-manager-row" key={c.id}>
              <input
                type="checkbox"
                aria-label={`Show ${c.label}`}
                checked={!c.hidden}
                disabled={c.id === "title"}
                onChange={(e) =>
                  onChange(
                    columns.map((x) =>
                      x.id === c.id ? { ...x, hidden: !e.target.checked } : x,
                    ),
                  )
                }
              />
              <button
                className="key-property-manager-name"
                disabled={!c.id.startsWith("property:") || disabled}
                onClick={() => onEdit(c)}
              >
                <span>
                  {c.type === "formula"
                    ? "ƒ"
                    : c.type === "number"
                      ? "#"
                      : c.type === "boolean"
                        ? "☑"
                        : c.type === "select"
                          ? "◉"
                          : "Aa"}
                </span>
                {c.label}
                <small>{c.type || "Built-in"}</small>
              </button>
              <button
                aria-label={`${c.pinned ? "Unpin" : "Pin"} ${c.label}`}
                aria-pressed={!!c.pinned}
                onClick={() =>
                  onChange(
                    columns.map((x) =>
                      x.id === c.id ? { ...x, pinned: !x.pinned } : x,
                    ),
                  )
                }
              >
                {c.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                aria-label={`Move ${c.label} left`}
                disabled={columns.indexOf(c) === 0}
                onClick={() => {
                  const next = [...columns],
                    i = next.indexOf(c);
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(next);
                }}
              >
                ←
              </button>
              {c.id.startsWith("property:") && (
                <>
                  <button
                    disabled={disabled || c.type === "formula"}
                    title="Configure inputs and review proposals for selected sources"
                    onClick={() => onFill(c)}
                  >
                    ✧ Fill
                  </button>
                  <button
                    aria-label={`Delete ${c.label}`}
                    disabled={disabled}
                    onClick={() => setConfirm(c)}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
      </div>
      {confirm && (
        <div className="key-property-delete" role="alert">
          <strong>Remove “{confirm.label}”?</strong>
          <p>
            Removing its definition keeps source values. Deleting values also
            removes them from metadata search.
          </p>
          <button onClick={() => setConfirm(undefined)}>Cancel</button>
          <button
            disabled={disabled}
            onClick={() => {
              onDelete(confirm, false);
              setConfirm(undefined);
            }}
          >
            Keep values
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              onDelete(confirm, true);
              setConfirm(undefined);
            }}
          >
            Delete values too
          </button>
        </div>
      )}
    </section>
  );
}
