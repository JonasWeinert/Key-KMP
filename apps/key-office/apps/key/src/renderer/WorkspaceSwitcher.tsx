import { Button, Input } from "@key/design-system";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
export interface WorkspaceAppearance {
  id: string;
  name: string;
  root: string;
  icon?: string;
  color?: string;
}
const icons = [
  "📚",
  "🔬",
  "🧠",
  "✍️",
  "🌱",
  "🗂️",
  "🏠",
  "💼",
  "★",
  "◆",
  "●",
  "☀",
];
const colors = [
  "#64748b",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#16a34a",
  "#0891b2",
];
export default function WorkspaceSwitcher({
  workspaces,
  selectedId,
  onSelect,
  onAdd,
  onSave,
}: {
  workspaces: WorkspaceAppearance[];
  selectedId?: string;
  onSelect: (id?: string) => void;
  onAdd: () => Promise<void>;
  onSave: (id: string, icon: string, color: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [icon, setIcon] = useState("📚"),
    [color, setColor] = useState(colors[0]);
  const container = useRef<HTMLDivElement>(null);
  const selected = workspaces.find((w) => w.id === selectedId);
  useEffect(() => {
    setEditing(false);
    setError("");
    setIcon(selected?.icon || "📚");
    setColor(selected?.color || colors[0]);
  }, [selectedId, selected?.icon, selected?.color]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setEditing(false);
        container.current
          ?.querySelector<HTMLButtonElement>(".key-workspace-trigger")
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setOpen(false);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="key-workspace-switcher" ref={container}>
      <Button
        className="key-workspace-trigger"
        aria-label="Workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setQuery("");
          setOpen((v) => !v);
        }}
      >
        <span
          className="key-workspace-icon"
          style={{
            color: selected?.color || colors[0],
            background: `color-mix(in srgb, ${selected?.color || colors[0]} 12%, transparent)`,
          }}
        >
          {selected?.icon || (selected ? "📚" : <Icon name="layers" size={15} />)}
        </span>
        <strong>{selected?.name || "All workspaces"}</strong>
        <span aria-hidden="true"><Icon name="chevronUpDown" size={14} /></span>
      </Button>
      {open && (
        <div
          className="key-workspace-dropdown"
          onKeyDown={(e) => {
            if (
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) ||
              editing
            )
              return;
            const options = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role^="menuitem"]:not(:disabled)',
              ),
            );
            if (!options.length) return;
            // Text editing keeps its native Home/End behavior in the filter.
            if (
              e.target instanceof HTMLInputElement &&
              (e.key === "Home" || e.key === "End")
            )
              return;
            e.preventDefault();
            const current = options.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? options.length - 1
                  : e.key === "ArrowDown"
                    ? (current + 1) % options.length
                    : current < 0
                      ? options.length - 1
                      : (current - 1 + options.length) % options.length;
            options[next].focus();
          }}
        >
          {!editing ? (
            <div className="key-workspace-options">
              <Input
                autoFocus
                aria-label="Find a workspace"
                placeholder="Find a workspace…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div role="menu" aria-label="Workspaces">
                <Button
                  role="menuitemradio"
                  aria-checked={!selectedId}
                  onClick={() => {
                    onSelect();
                    setOpen(false);
                  }}
                >
                  <span className="key-workspace-icon"><Icon name="layers" size={13} /></span>
                  <span>All workspaces</span>
                  {!selectedId && <Icon name="check" size={14} />}
                </Button>
                {workspaces
                  .filter((w) =>
                    w.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((w) => (
                    <Button
                      key={w.id}
                      data-workspace-id={w.id}
                      role="menuitemradio"
                      aria-checked={w.id === selectedId}
                      onClick={() => {
                        onSelect(w.id);
                        setOpen(false);
                      }}
                    >
                      <span
                        className="key-workspace-icon"
                        style={{
                          color: w.color || colors[0],
                          background: `color-mix(in srgb, ${w.color || colors[0]} 12%, transparent)`,
                        }}
                      >
                        {w.icon || "📚"}
                      </span>
                      <span>{w.name}</span>
                      {w.id === selectedId && <Icon name="check" size={14} />}
                    </Button>
                  ))}
                {query &&
                  !workspaces.some((w) =>
                    w.name.toLowerCase().includes(query.toLowerCase()),
                  ) && (
                    <p className="key-workspace-no-results" role="status">
                      No matching workspaces
                    </p>
                  )}
                <hr />
                {selected && (
                  <Button role="menuitem" onClick={() => setEditing(true)}>
                    Customize workspace…
                  </Button>
                )}
                <Button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void run(onAdd)}
                >
                  <Icon name="plus" size={14} />
                  <span>Add workspace…</span>
                </Button>
              </div>
            </div>
          ) : (
            <form
              aria-label="Workspace appearance"
              onSubmit={(e) => {
                e.preventDefault();
                if (selected) void run(() => onSave(selected.id, icon, color));
              }}
            >
              <header>
                <strong>Workspace appearance</strong>
                <Button
                  type="button"
                  aria-label="Back to workspaces"
                  onClick={() => setEditing(false)}
                >
                  ←
                </Button>
              </header>
              <label>
                Emoji or icon
                <Input
                  value={icon}
                  maxLength={32}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="📚"
                />
              </label>
              <div className="key-workspace-icon-options">
                {icons.map((i) => (
                  <Button
                    type="button"
                    key={i}
                    aria-label={`Use ${i}`}
                    aria-pressed={icon === i}
                    onClick={() => setIcon(i)}
                  >
                    {i}
                  </Button>
                ))}
              </div>
              <label>
                Colour
                <Input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              </label>
              <div className="key-workspace-colors">
                {colors.map((c) => (
                  <Button
                    type="button"
                    key={c}
                    aria-label={`Use colour ${c}`}
                    aria-pressed={color === c}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
              <p className="key-workspace-preview">
                <span
                  className="key-workspace-icon"
                  style={{
                    color,
                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                  }}
                >
                  {icon || "📚"}
                </span>
                {selected?.name}
              </p>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? "Saving…" : "Save appearance"}
              </Button>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
