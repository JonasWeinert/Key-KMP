import { Button, Input } from "@key/design-system";
import { useState } from "react";
import type { SourceColumn } from "./LibraryTable";
import "./property-tools.css";
import { Icon } from "./icons";
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
        <Button disabled={disabled} onClick={onAdd}>
          <Icon name="plus" size={13} />
          New property
        </Button>
      </header>
      <Input
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
              <Input
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
              <Button
                className="key-property-manager-name"
                disabled={!c.id.startsWith("property:") || disabled}
                onClick={() => onEdit(c)}
              >
                <span className="kx-type-badge" aria-hidden="true">
                  {c.type === "formula" ? (
                    "ƒ"
                  ) : c.type === "number" ? (
                    "#"
                  ) : c.type === "boolean" ? (
                    <Icon name="check" size={11} />
                  ) : c.type === "select" ? (
                    <Icon name="list" size={11} />
                  ) : (
                    "Aa"
                  )}
                </span>
                <span className="kx-property-label">{c.label}</span>
                <small>{c.type || "Built-in"}</small>
              </Button>
              <Button
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
              </Button>
              <Button
                aria-label={`Move ${c.label} left`}
                disabled={columns.indexOf(c) === 0}
                onClick={() => {
                  const next = [...columns],
                    i = next.indexOf(c);
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(next);
                }}
              >
                <Icon name="chevronRight" size={13} style={{ transform: "scaleX(-1)" }} />
              </Button>
              {c.id.startsWith("property:") && (
                <>
                  <Button
                    disabled={disabled || c.type === "formula"}
                    title="Configure inputs and review proposals for selected sources"
                    onClick={() => onFill(c)}
                  >
                    <Icon name="sparkle" size={13} />
                    Fill
                  </Button>
                  <Button
                    aria-label={`Delete ${c.label}`}
                    disabled={disabled}
                    onClick={() => setConfirm(c)}
                  >
                    <Icon name="trash" size={13} />
                  </Button>
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
          <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
          <Button
            disabled={disabled}
            onClick={() => {
              onDelete(confirm, false);
              setConfirm(undefined);
            }}
          >
            Keep values
          </Button>
          <Button
            disabled={disabled}
            onClick={() => {
              onDelete(confirm, true);
              setConfirm(undefined);
            }}
          >
            Delete values too
          </Button>
        </div>
      )}
    </section>
  );
}
