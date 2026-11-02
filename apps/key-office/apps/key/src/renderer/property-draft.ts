import type { PropertyDraft } from "./PropertyEditor";
/** Validate before the first database write; defining a column never implies overwriting values. */
export function preparePropertyDraft(draft: PropertyDraft) {
  const name = draft.name.trim();
  if (!name || name.length > 128)
    throw Error("Use a property name between 1 and 128 characters.");
  if (!["text", "number", "boolean", "select", "formula"].includes(draft.type))
    throw Error("Unsupported property type.");
  const options = [
    ...new Set(draft.options.map((v) => v.trim()).filter(Boolean)),
  ];
  if (draft.type === "select" && !options.length)
    throw Error("Add at least one select option.");
  if (draft.type === "formula" && !draft.formula.trim())
    throw Error("Enter a formula.");
  let value: unknown = draft.value;
  if (draft.applyValues) {
    if (draft.type === "number") {
      if (!draft.value.trim() || !Number.isFinite(Number(draft.value)))
        throw Error("Enter a finite number.");
      value = Number(draft.value);
    }
    if (draft.type === "boolean") {
      if (!["true", "false"].includes(draft.value))
        throw Error("Choose true or false.");
      value = draft.value === "true";
    }
    if (draft.type === "select" && !options.includes(draft.value))
      throw Error("Choose a value from the select options.");
  }
  return {
    name,
    value,
    config: {
      type: draft.type,
      ...(draft.type === "select" ? { options } : {}),
      ...(draft.type === "formula" ? { formula: draft.formula.trim() } : {}),
    },
  };
}
