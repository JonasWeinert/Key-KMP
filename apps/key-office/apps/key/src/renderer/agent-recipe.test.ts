import { describe, expect, it } from "vitest";
import { resolveAgentRecipe, withAgentRecipe } from "./agent-recipe";
describe("property agent recipes", () => {
  it("uses canonical type/options over old agent config and restores explicit input permissions", () => {
    expect(
      resolveAgentRecipe(
        {
          name: "Status",
          type: "select",
          options: ["Read"],
          agentic: {
            inputs: ["title"],
            instruction: "Use only title",
            enabled: false,
          },
        },
        { type: "text", inputs: ["pdfText"], prompt: "Old" },
      ),
    ).toEqual({
      type: "select",
      options: ["Read"],
      inputs: ["title"],
      instruction: "Use only title",
      enabled: false,
    });
  });
  it("migrates old recipe data on read, excludes unknown context permissions", () => {
    expect(
      resolveAgentRecipe(undefined, {
        inputs: ["title", "password", "title"],
        prompt: "Classify",
        type: "number",
      }),
    ).toMatchObject({
      inputs: ["title"],
      instruction: "Classify",
      type: "number",
    });
  });
  it("persists a bounded recipe without discarding definition fields or storing its name twice", () => {
    const result = withAgentRecipe(
      { name: "Status", type: "select", options: ["Read"], color: "blue" },
      "Status",
      "select",
      ["Read"],
      { inputs: ["title"], instruction: "Classify", enabled: true },
    );
    expect(result).toMatchObject({
      color: "blue",
      type: "select",
      agentic: { inputs: ["title"], instruction: "Classify", enabled: true },
    });
    expect(result).not.toHaveProperty("name");
    expect(() =>
      withAgentRecipe(undefined, "Status", "text", [], {
        inputs: [],
        instruction: "Classify",
        enabled: true,
      }),
    ).toThrow();
    expect(() =>
      withAgentRecipe(undefined, "Status", "formula", [], {
        inputs: ["title"],
        instruction: "Classify",
        enabled: true,
      }),
    ).toThrow();
    expect(() =>
      withAgentRecipe(undefined, "Status", "text", [], {
        inputs: ["title"],
        instruction: "é".repeat(4097),
        enabled: true,
      }),
    ).toThrow();
  });
});
