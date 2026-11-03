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
  openElsewhere = [],
  openRequest = 0,
  onSelect,
  onAdd,
  onSave,
  onHome,
  onSettings,
}: {
  workspaces: WorkspaceAppearance[];
  selectedId?: string;
  /** Workspaces another window shows; choosing one brings that window forward. */
  openElsewhere?: string[];
  /** Opens the menu when it changes (File › Switch Workspace…). */
  openRequest?: number;
  /** `newWindow`: chosen when asked, Cmd- or Option-click, or the row's new-window button. */
  onSelect: (id: string, newWindow: boolean) => void;
  /** Adds a workspace (a folder picked by the user); answers it, or null when cancelled. */
  onAdd: () => Promise<WorkspaceAppearance | null>;
  onSave: (id: string, icon: string, color: string) => Promise<void>;
  /** The workspace's name: back to Home. */
  onHome: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [icon, setIcon] = useState("📚"),
    [color, setColor] = useState(colors[0]),
    // A workspace picked (or just added): open it here or in a new window?
    [choosing, setChoosing] = useState<WorkspaceAppearance>();
  const container = useRef<HTMLDivElement>(null);
  const selected = workspaces.find((w) => w.id === selectedId);
  useEffect(() => {
    setEditing(false);
    setError("");
    setIcon(selected?.icon || "📚");
    setColor(selected?.color || colors[0]);
  }, [selectedId, selected?.icon, selected?.color]);
  useEffect(() => {
    if (!openRequest) return;
    setQuery("");
    setEditing(false);
    setChoosing(undefined);
    setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open) setChoosing(undefined);
  }, [open]);
  /** A plain pick asks where to open, unless there's nothing to replace or another window shows it. */
  const pick = (w: WorkspaceAppearance, newWindow: boolean) => {
    if (newWindow || !selected || w.id === selectedId || openElsewhere.includes(w.id)) {
      onSelect(w.id, newWindow);
      setOpen(false);
    } else setChoosing(w);
  };
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
  async function add() {
    setBusy(true);
    setError("");
    try {
      const added = await onAdd();
      if (added) pick(added, false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
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
        type="button"
        className="key-workspace-home"
        aria-label={selected ? `${selected.name} · Home` : "Home"}
        title="Home"
        onClick={onHome}
      >
        <span
          className="key-workspace-icon"
          style={{
            color: selected?.color || colors[0],
            background: `color-mix(in srgb, ${selected?.color || colors[0]} 12%, transparent)`,
          }}
        >
          {selected?.icon || (selected ? "📚" : <Icon name="layers" size={13} />)}
        </span>
        <strong>{selected?.name || "Key"}</strong>
      </button>
      <button
        type="button"
        className="key-workspace-trigger"
        aria-label="Workspace"
        title="Switch, add or customise workspaces"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setQuery("");
          setOpen((v) => !v);
        }}
      >
        <Icon name="chevronUpDown" size={13} />
      </button>
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
          {choosing ? (
            <div className="key-workspace-choice" role="menu" aria-label={`Open ${choosing.name}`}>
              <p>
                Open <strong>{choosing.name}</strong>
              </p>
              <Button role="menuitem" autoFocus onClick={() => {
                  onSelect(choosing.id, false);
                  setOpen(false);
                }}>
                <Icon name="swap" size={14} />
                <span>Replace {selected?.name ?? "this workspace"} in this window</span>
              </Button>
              <Button role="menuitem" onClick={() => pick(choosing, true)}>
                <Icon name="windows" size={14} />
                <span>Open in a new window</span>
              </Button>
              <hr />
              <Button role="menuitem" onClick={() => setChoosing(undefined)}>
                <span>Cancel</span>
              </Button>
            </div>
          ) : !editing ? (
            <div className="key-workspace-options">
              <Input
                autoFocus
                aria-label="Find a workspace"
                placeholder="Find a workspace…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div role="menu" aria-label="Workspaces">
                {workspaces
                  .filter((w) =>
                    w.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((w) => (
                    <div className="key-workspace-row" key={w.id}>
                    <Button
                      data-workspace-id={w.id}
                      role="menuitemradio"
                      aria-checked={w.id === selectedId}
                      title={
                        openElsewhere.includes(w.id)
                          ? `${w.name} is open in another window`
                          : `Open ${w.name} · ⌘-click to open it in a new window`
                      }
                      onClick={(e) => pick(w, e.metaKey || e.altKey)}
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
                      {openElsewhere.includes(w.id) && w.id !== selectedId && (
                        <span className="key-workspace-open-dot" aria-label="Open in another window" />
                      )}
                      {w.id === selectedId && <Icon name="check" size={14} />}
                    </Button>
                    <button
                      type="button"
                      className="key-workspace-new-window"
                      aria-label={`Open ${w.name} in a new window`}
                      title="Open in new window"
                      onClick={() => {
                        onSelect(w.id, true);
                        setOpen(false);
                      }}
                    >
                      <Icon name="windows" size={13} />
                    </button>
                    </div>
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
                    <Icon name="image" size={14} />
                    <span>Customize workspace…</span>
                  </Button>
                )}
                <Button
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onSettings();
                  }}
                >
                  <Icon name="gear" size={14} />
                  <span>Workspace settings…</span>
                </Button>
                <Button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void add()}
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
