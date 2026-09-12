import { describe, it, expect } from "vitest";
import { preparePropertyDraft } from "./property-draft";
import type { PropertyDraft } from "./PropertyEditor";
const draft = (patch: Partial<PropertyDraft>): PropertyDraft => ({
  name: "Rating",
  type: "number",
  value: "",
  options: [],
  formula: "",
  applyValues: false,
  ...patch,
});
describe("property definitions and explicit value assignment", () => {
  it("allows empty numeric schema without silently assigning zero", () => {
    expect(preparePropertyDraft(draft({}))).toEqual({
      name: "Rating",
      value: "",
      config: { type: "number" },
    });
    expect(() => preparePropertyDraft(draft({ applyValues: true }))).toThrow(
      "finite number",
    );
  });
  it("normalizes select choices but refuses values outside the definition", () => {
    expect(
      preparePropertyDraft(
        draft({ type: "select", options: [" Read ", "Read", "Later"] }),
      ).config,
    ).toEqual({ type: "select", options: ["Read", "Later"] });
    expect(() =>
      preparePropertyDraft(
        draft({
          type: "select",
          options: ["Read"],
          value: "Done",
          applyValues: true,
        }),
      ),
    ).toThrow("select options");
  });
  it("preserves explicit false and zero with correct JSON types", () => {
    expect(
      preparePropertyDraft(
        draft({ type: "boolean", value: "false", applyValues: true }),
      ).value,
    ).toBe(false);
    expect(
      preparePropertyDraft(draft({ value: "0", applyValues: true })).value,
    ).toBe(0);
  });
  it("rejects invalid schema and non-finite values before writes", () => {
    expect(() => preparePropertyDraft(draft({ name: " " }))).toThrow("name");
    expect(() => preparePropertyDraft(draft({ type: "formula" }))).toThrow(
      "formula",
    );
    expect(() =>
      preparePropertyDraft(draft({ value: "Infinity", applyValues: true })),
    ).toThrow("finite");
    expect(() => preparePropertyDraft(draft({ type: "select" }))).toThrow(
      "option",
    );
  });
});
