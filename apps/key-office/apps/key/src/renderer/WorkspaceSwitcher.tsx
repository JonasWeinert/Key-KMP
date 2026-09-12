import { useEffect, useRef, useState } from "react";
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
      <button
        className="key-workspace-trigger"
        aria-label="Workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="key-workspace-icon"
          style={{
            color: selected?.color || colors[0],
            background: `color-mix(in srgb, ${selected?.color || colors[0]} 12%, transparent)`,
          }}
        >
          {selected?.icon || (selected ? "📚" : "◈")}
        </span>
        <strong>{selected?.name || "All workspaces"}</strong>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="key-workspace-dropdown">
          {!editing ? (
            <div role="menu" aria-label="Workspaces">
              <button
                role="menuitemradio"
                aria-checked={!selectedId}
                onClick={() => {
                  onSelect();
                  setOpen(false);
                }}
              >
                ◈ <span>All workspaces</span>
                {!selectedId && "✓"}
              </button>
              {workspaces.map((w) => (
                <button
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
                  {w.id === selectedId && "✓"}
                </button>
              ))}
              <hr />
              {selected && (
                <button role="menuitem" onClick={() => setEditing(true)}>
                  Customize workspace…
                </button>
              )}
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => void run(onAdd)}
              >
                ＋ Add workspace…
              </button>
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
                <button
                  type="button"
                  aria-label="Back to workspaces"
                  onClick={() => setEditing(false)}
                >
                  ←
                </button>
              </header>
              <label>
                Emoji or icon
                <input
                  value={icon}
                  maxLength={32}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="📚"
                />
              </label>
              <div className="key-workspace-icon-options">
                {icons.map((i) => (
                  <button
                    type="button"
                    key={i}
                    aria-label={`Use ${i}`}
                    aria-pressed={icon === i}
                    onClick={() => setIcon(i)}
                  >
                    {i}
                  </button>
                ))}
              </div>
              <label>
                Colour
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              </label>
              <div className="key-workspace-colors">
                {colors.map((c) => (
                  <button
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
              <button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save appearance"}
              </button>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
