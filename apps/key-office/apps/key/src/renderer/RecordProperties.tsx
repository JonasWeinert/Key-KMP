import { useEffect, useId, useState } from "react";
import { evaluatePropertyFormula } from "./property-formula";
import PropertyEditor, { type PropertyDraft } from "./PropertyEditor";
import "./record-properties.css";

type Definition = {
  name: string;
  type?: string;
  options?: string[];
  formula?: string;
};
type Props = {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onRename?: (
    name: string,
    newName: string,
  ) => Promise<{ attribute?: Omit<Definition, "name"> | null }>;
  workspaceId?: string;
  disabled?: boolean;
  invoke: <T>(
    command: string,
    args?: Record<string, unknown>,
    workspaceId?: string,
  ) => Promise<T>;
};
const reserved = new Set([
  "view",
  "path",
  "editor",
  "sourceType",
  "contentMode",
  "contentHash",
  "pdfHash",
]);
const own = (value: object, name: string) =>
  Object.prototype.hasOwnProperty.call(value, name);

/** Item values remain part of the parent's revision-checked save, including calculated values. */
export function RecordProperties({
  value,
  onChange,
  onRename,
  workspaceId,
  disabled,
  invoke,
}: Props) {
  const instanceId = useId();
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [editor, setEditor] = useState<{
    draft: PropertyDraft;
    editing: boolean;
  } | null>(null);
  const [savingDefinition, setSavingDefinition] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    if (!workspaceId) return;
    const load = () => {
      void invoke<Definition[]>("workspace_attributes", {}, workspaceId)
        .then((rows) => {
          if (active) setDefinitions(rows);
        })
        .catch((reason) => {
          if (active)
            setError(`Could not load property definitions: ${String(reason)}`);
        });
    };
    load();
    const unsubscribe = (
      window as unknown as {
        key?: {
          on?: (
            event: string,
            callback: (payload: { workspaceId?: string }) => void,
          ) => () => void;
        };
      }
    ).key?.on?.("property-definitions-changed", (payload) => {
      if (payload?.workspaceId === workspaceId) load();
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [invoke, workspaceId]);
  const names = [
    ...new Set([...Object.keys(value), ...definitions.map((d) => d.name)]),
  ].filter((n) => !reserved.has(n));
  const update = (key: string, next: unknown) => {
    onChange({ ...value, [key]: next });
  };
  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const edit = (key?: string) => {
    const definition = definitions.find((d) => d.name === key);
    const raw = key ? value[key] : undefined;
    setError("");
    setEditor({
      editing: !!key,
      draft: {
        name: key || "",
        type:
          definition?.type ||
          (typeof raw === "number"
            ? "number"
            : typeof raw === "boolean"
              ? "boolean"
              : "text"),
        value: raw == null ? "" : String(raw),
        options: definition?.options || [],
        formula: definition?.formula || "",
        applyValues: false,
      },
    });
  };
  const saveDefinition = async (draft: PropertyDraft) => {
    const key = draft.name.trim();
    if (
      !workspaceId ||
      !key ||
      key.length > 128 ||
      reserved.has(key) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    ) {
      setError(
        "Choose a property name of 1–128 characters, excluding reserved names.",
      );
      return;
    }
    if (
      !editor?.editing &&
      (own(value, key) || definitions.some((d) => d.name === key))
    ) {
      setError("That property already exists. Edit it below.");
      return;
    }
    if (!own(value, key) && Object.keys(value).length >= 64) {
      setError("This editor supports up to 64 properties per item.");
      return;
    }
    const originalName = editor?.editing ? editor.draft.name : key;
    const renaming = originalName !== key;
    if (renaming && draft.applyValues) {
      setError(
        "Save value changes first, then rename the property separately.",
      );
      return;
    }
    if (
      renaming &&
      draft.type === "formula" &&
      draft.formula !== editor?.draft.formula
    ) {
      setError(
        "Save formula changes first, then rename so references can be updated safely.",
      );
      return;
    }
    setSavingDefinition(true);
    setError("");
    try {
      let next: unknown = draft.value;
      const options = [
        ...new Set(draft.options.map((v) => v.trim()).filter(Boolean)),
      ];
      if (draft.applyValues) {
        if (draft.type === "number") {
          if (!draft.value.trim() || !Number.isFinite(Number(draft.value)))
            throw Error("Enter a finite number.");
          next = Number(draft.value);
        }
        if (draft.type === "boolean") next = draft.value === "true";
        if (draft.type === "select" && !options.includes(draft.value))
          throw Error("Choose one of the select options.");
        if (draft.type === "formula")
          next = evaluatePropertyFormula(draft.formula, value);
      }
      let renamedFormula = draft.formula;
      if (renaming) {
        if (!onRename)
          throw Error(
            "This editor cannot rename properties yet. Reopen the item and try again.",
          );
        const result = await onRename(originalName, key);
        if (
          draft.type === "formula" &&
          typeof result.attribute?.formula === "string"
        )
          renamedFormula = result.attribute.formula;
      }
      const latestDefinitions = await invoke<Definition[]>(
        "workspace_attributes",
        {},
        workspaceId,
      );
      const { name: _existingName, ...existingConfig } = latestDefinitions.find(
        (d) => d.name === key,
      ) ?? { name: key };
      const config = {
        ...existingConfig,
        type: draft.type,
        ...(draft.type === "select" ? { options } : {}),
        ...(draft.type === "formula" ? { formula: renamedFormula } : {}),
      };
      await invoke(
        "workspace_save_attribute",
        { name: key, config },
        workspaceId,
      );
      setDefinitions((old) => [
        ...old.filter((d) => d.name !== key && d.name !== originalName),
        { name: key, ...config },
      ]);
      if (draft.applyValues) update(key, next);
      setEditor(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSavingDefinition(false);
    }
  };
  return (
    <section className="key-record-properties" aria-label="Item properties">
      <header>
        <div>
          <h3>Properties</h3>
          <p>
            Values are saved with this item. Property definitions are shared
            across the workspace and saved immediately.
          </p>
        </div>
        <button type="button" disabled={disabled} onClick={() => edit()}>
          ＋ Add property
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!names.length && (
        <p className="key-record-property-empty">
          Add details such as status, priority, or a reference number.
        </p>
      )}
      {names.map((key) => {
        const definition = definitions.find((d) => d.name === key);
        const raw = value[key];
        const kind =
          definition?.type ||
          (typeof raw === "number"
            ? "number"
            : typeof raw === "boolean"
              ? "boolean"
              : raw !== null && typeof raw === "object"
                ? "structured"
                : "text");
        let formulaValue: unknown,
          formulaError = "";
        if (kind === "formula") {
          try {
            formulaValue = evaluatePropertyFormula(
              definition?.formula || "",
              value,
            );
          } catch (reason) {
            formulaError = String(reason);
          }
        }
        return (
          <div className="key-record-property-row" key={key}>
            <label htmlFor={`${instanceId}-property-${key}`} title={key}>
              <button
                type="button"
                className="key-record-property-name"
                disabled={disabled}
                onClick={() => edit(key)}
              >
                {key}
              </button>
              <small>{kind === "boolean" ? "Checkbox" : kind}</small>
            </label>
            <div className="key-record-property-value">
              {kind === "formula" ? (
                <div className="key-record-formula">
                  <code>{definition?.formula}</code>
                  <output>
                    {formulaError || String(formulaValue ?? "Empty")}
                  </output>
                  <button
                    type="button"
                    disabled={disabled || !!formulaError}
                    onClick={() => update(key, formulaValue)}
                  >
                    Use result
                  </button>
                  <small>
                    Recalculate after changing inputs. The result is saved with
                    this item.
                  </small>
                </div>
              ) : kind === "boolean" ? (
                <input
                  id={`${instanceId}-property-${key}`}
                  aria-label={key}
                  type="checkbox"
                  checked={raw === true}
                  disabled={disabled}
                  onChange={(e) => update(key, e.target.checked)}
                />
              ) : kind === "select" ? (
                <select
                  id={`${instanceId}-property-${key}`}
                  value={typeof raw === "string" ? raw : ""}
                  disabled={disabled}
                  onChange={(e) => update(key, e.target.value || null)}
                >
                  <option value="">Empty</option>
                  {typeof raw === "string" &&
                    raw &&
                    !definition?.options?.includes(raw) && (
                      <option value={raw}>{raw} (existing)</option>
                    )}
                  {definition?.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : kind === "number" ? (
                <input
                  id={`${instanceId}-property-${key}`}
                  type="number"
                  step="any"
                  value={typeof raw === "number" ? raw : ""}
                  disabled={disabled}
                  onChange={(e) => {
                    if (!e.target.value) {
                      update(key, null);
                      return;
                    }
                    const number = Number(e.target.value);
                    if (Number.isFinite(number)) update(key, number);
                  }}
                />
              ) : kind === "structured" ? (
                <details>
                  <summary>Structured value · preserved</summary>
                  <pre>{JSON.stringify(raw, null, 2)}</pre>
                  <small>
                    Nested objects and arrays are retained. Relation and rollup
                    editors are not available yet.
                  </small>
                </details>
              ) : (
                <input
                  id={`${instanceId}-property-${key}`}
                  type="text"
                  maxLength={4096}
                  value={
                    typeof raw === "string"
                      ? raw
                      : raw == null
                        ? ""
                        : String(raw)
                  }
                  placeholder="Empty"
                  disabled={disabled}
                  onChange={(e) => update(key, e.target.value)}
                />
              )}
            </div>
            <button
              className="key-record-property-clear"
              type="button"
              title={`Clear ${key} on this item`}
              aria-label={`Clear ${key} on this item`}
              disabled={disabled || !own(value, key)}
              onClick={() => remove(key)}
            >
              ×
            </button>
          </div>
        );
      })}
      {editor && (
        <PropertyEditor
          initial={editor.draft}
          editing={editor.editing}
          busy={savingDefinition}
          error={error}
          targetCount={1}
          properties={value}
          previewTitle="This item"
          allowAgent={false}
          targetLabel="item"
          onClose={() => {
            setEditor(null);
            setError("");
          }}
          onSave={(draft) => {
            void saveDefinition(draft);
          }}
        />
      )}
    </section>
  );
}
