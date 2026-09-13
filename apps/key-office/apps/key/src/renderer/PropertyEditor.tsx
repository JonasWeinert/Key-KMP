import { GlobalDrawer } from "./GlobalDrawer";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { evaluatePropertyFormula } from "./property-formula";
import "./property-tools.css";
export interface PropertyDraft {
  name: string;
  type: string;
  value: string;
  options: string[];
  formula: string;
  applyValues: boolean;
}
const types = [
  ["text", "Aa", "Text", "Notes, identifiers and summaries"],
  ["number", "#", "Number", "Ratings, years and measurements"],
  ["boolean", "☑", "Checkbox", "A simple true or false value"],
  ["select", "◉", "Select", "A consistent set of choices"],
  ["formula", "ƒ", "Formula", "Calculate from other properties"],
];
export default function PropertyEditor({
  initial,
  editing,
  busy,
  error,
  targetCount,
  properties,
  previewTitle,
  onClose,
  onSave,
  allowAgent = true,
  targetLabel = "source",
  agentContent,
  onBack,
}: {
  agentContent?: ReactNode;
  onBack?: () => void;
  allowAgent?: boolean;
  targetLabel?: string;
  initial: PropertyDraft;
  editing: boolean;
  busy: boolean;
  error?: string;
  targetCount: number;
  properties: Record<string, unknown>;
  previewTitle?: string;
  onClose: () => void;
  onSave: (draft: PropertyDraft, agent: boolean) => void;
}) {
  const reduce = useReducedMotion();
  const retainedAgent = useRef<ReactNode>(null);
  if (agentContent) retainedAgent.current = agentContent;
  const [draft, setDraft] = useState(initial),
    [option, setOption] = useState("");
  const ref = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<PropertyDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    ref.current
      ?.querySelector<HTMLElement>(
        "input:not(:disabled),textarea:not(:disabled),button:not(:disabled)",
      )
      ?.focus();
    return () => before?.focus();
  }, []);
  let preview = "",
    formulaError = "";
  if (draft.type === "formula" && draft.formula.trim()) {
    try {
      preview = String(
        evaluatePropertyFormula(draft.formula, properties) ?? "Empty",
      );
    } catch (e) {
      formulaError = e instanceof Error ? e.message : String(e);
    }
  }
  const addOption = () => {
    const v = option.trim();
    if (v && !draft.options.includes(v))
      set({ options: [...draft.options, v] });
    setOption("");
  };
  const valid =
    !!draft.name.trim() &&
    (draft.type !== "select" || draft.options.length > 0) &&
    (draft.type !== "formula" || !!draft.formula.trim());
  return (
    <GlobalDrawer onClose={onClose} busy={busy}>
      <div className="key-drawer-slides">
        <motion.div
          className="key-drawer-slide"
          inert={!!agentContent}
          animate={{
            x: agentContent ? "-25%" : "0%",
            opacity: agentContent ? 0 : 1,
          }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 420, damping: 40, mass: 0.5 }
          }
        >
          <form
            ref={ref}
            className="key-property-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "Edit property" : "New property"}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) onSave(draft, false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) {
                e.stopPropagation();
                onClose();
              }
              if (e.key === "Tab") {
                const controls = Array.from(
                  ref.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
                  ) || [],
                );
                const first = controls[0],
                  last = controls.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header>
              <div>
                <small>WORKSPACE PROPERTY</small>
                <h2>{editing ? "Edit property" : "New property"}</h2>
              </div>
              <button
                type="button"
                aria-label="Close property editor"
                disabled={busy}
                onClick={onClose}
              >
                ×
              </button>
            </header>
            <div className="key-property-body">
              <label>
                Property name
                <input
                  required
                  maxLength={128}
                  value={draft.name}
                  disabled={busy}
                  placeholder="e.g. Reading status"
                  onChange={(e) => set({ name: e.target.value })}
                />
              </label>
              {editing && (
                <small>
                  Renaming keeps existing values and updates formula references.
                </small>
              )}
              <fieldset disabled={busy}>
                <legend>Property type</legend>
                <div className="key-property-types">
                  {types.map(([id, icon, label, hint]) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={draft.type === id}
                      title={hint}
                      onClick={() =>
                        set({
                          type: id,
                          value: id === "boolean" ? "false" : "",
                        })
                      }
                    >
                      <span>{icon}</span>
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
              {draft.type === "select" && (
                <section>
                  <label>
                    Options
                    <div className="key-property-option-entry">
                      <input
                        value={option}
                        placeholder="Add an option…"
                        onChange={(e) => setOption(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addOption();
                          }
                        }}
                      />
                      <button
                        type="button"
                        disabled={!option.trim()}
                        onClick={addOption}
                      >
                        Add
                      </button>
                    </div>
                  </label>
                  <div className="key-property-options">
                    {draft.options.map((value, i) => (
                      <span key={value} data-color={i % 5}>
                        {value}
                        <button
                          type="button"
                          aria-label={`Remove option ${value}`}
                          onClick={() =>
                            set({
                              options: draft.options.filter((v) => v !== value),
                              value: draft.value === value ? "" : draft.value,
                            })
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </section>
              )}
              {draft.type === "formula" && (
                <section>
                  <label>
                    Formula
                    <textarea
                      required
                      spellCheck={false}
                      value={draft.formula}
                      placeholder="if({Pages} > 20, 'Long read', 'Short read')"
                      onChange={(e) => set({ formula: e.target.value })}
                    />
                  </label>
                  <div className="key-property-references">
                    {Object.keys(properties)
                      .slice(0, 24)
                      .map((name) => (
                        <button
                          type="button"
                          key={name}
                          onClick={() =>
                            set({ formula: draft.formula + `{${name}}` })
                          }
                        >
                          {name}
                        </button>
                      ))}
                  </div>
                  <div className="key-property-preview" role="status">
                    <small>
                      {previewTitle
                        ? `Preview · ${previewTitle}`
                        : "Preview with empty source values"}
                    </small>
                    <strong>
                      {formulaError ||
                        preview ||
                        "Write a formula to see its result"}
                    </strong>
                  </div>
                  <details>
                    <summary>Supported formulas and storage</summary>
                    <p>
                      Use arithmetic, comparisons, [property] or {"{Property}"},
                      and if, concat, upper, lower, length, round, contains,
                      coalesce. Use if(condition, yes, no); ternary syntax,
                      relations and rollups are unsupported. Arguments are
                      evaluated eagerly.
                    </p>
                    <p>
                      Cells calculate locally. Applying to selected sources
                      stores the results for search filters. Stored values do
                      not automatically update when dependencies change.
                    </p>
                  </details>
                </section>
              )}
              <section className="key-property-apply">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.applyValues}
                    disabled={!targetCount || busy}
                    onChange={(e) => set({ applyValues: e.target.checked })}
                  />
                  {draft.type === "formula"
                    ? "Recompute stored results"
                    : "Set a value"}{" "}
                  on {targetCount} selected{" "}
                  {targetCount === 1 ? targetLabel : `${targetLabel}s`}
                </label>
                {draft.applyValues &&
                  targetCount > 0 &&
                  draft.type !== "formula" && (
                    <label>
                      Value
                      {draft.type === "select" ? (
                        <select
                          aria-label="Value"
                          required
                          value={draft.value}
                          onChange={(e) => set({ value: e.target.value })}
                        >
                          <option value="">Choose an option…</option>
                          {draft.options.map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      ) : draft.type === "boolean" ? (
                        <select
                          aria-label="Value"
                          value={draft.value}
                          onChange={(e) => set({ value: e.target.value })}
                        >
                          <option value="false">Unchecked</option>
                          <option value="true">Checked</option>
                        </select>
                      ) : (
                        <input
                          required={draft.type === "number"}
                          type={draft.type === "number" ? "number" : "text"}
                          step="any"
                          value={draft.value}
                          onChange={(e) => set({ value: e.target.value })}
                        />
                      )}
                    </label>
                  )}
                <small>
                  Creating or editing the property alone leaves existing item
                  values untouched.
                </small>
              </section>
              {error && (
                <p role="alert" className="key-property-error">
                  {error}
                </p>
              )}
            </div>
            <footer>
              {allowAgent && (
                <button
                  type="button"
                  disabled={busy || !valid || draft.type === "formula"}
                  title="Save this property, then configure inputs and review AI proposals"
                  onClick={() => onSave({ ...draft, applyValues: false }, true)}
                >
                  ✧ Configure agent fill
                </button>
              )}
              <button
                type="submit"
                className="key-property-primary"
                disabled={busy || !valid}
              >
                {busy
                  ? "Saving…"
                  : editing
                    ? "Save property"
                    : "Create property"}
              </button>
            </footer>
          </form>
        </motion.div>
        {retainedAgent.current && (
          <motion.div
            key="agent"
            className="key-drawer-slide"
            inert={!agentContent}
            initial={reduce ? { opacity: 0 } : { x: "100%" }}
            animate={{
              x: agentContent ? 0 : "100%",
              opacity: agentContent ? 1 : 0,
            }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 420, damping: 40, mass: 0.5 }
            }
          >
            <div className="key-agent-drawer-back">
              <button
                type="button"
                aria-label="Back to property"
                onClick={onBack}
              >
                ‹
              </button>
              <strong>Agent settings</strong>
            </div>
            {retainedAgent.current}
          </motion.div>
        )}
      </div>
    </GlobalDrawer>
  );
}
