export const agentInputs = [
  "title",
  "authors",
  "year",
  "pageCount",
  "pdfText",
] as const;
export type AgentInput = (typeof agentInputs)[number];
export type AgentRecipe = {
  inputs: AgentInput[];
  instruction: string;
  enabled: boolean;
};
export type AgentAttribute = {
  name: string;
  type?: string;
  options?: string[];
  agentic?: AgentRecipe;
  [key: string]: unknown;
};
export const defaultInstruction =
  "Extract the requested property from the selected source inputs. Return null if unsupported.";
export function resolveAgentRecipe(
  attribute?: AgentAttribute,
  legacy?: Record<string, unknown>,
) {
  const recipe = attribute?.agentic;
  const suppliedInputs = recipe?.inputs ?? legacy?.inputs;
  const inputs = Array.isArray(suppliedInputs)
    ? [
        ...new Set(
          suppliedInputs.filter(
            (v): v is AgentInput =>
              typeof v === "string" && agentInputs.includes(v as AgentInput),
          ),
        ),
      ]
    : (["title", "pdfText"] as AgentInput[]);
  const instruction = recipe?.instruction ?? legacy?.prompt;
  return {
    inputs,
    instruction:
      typeof instruction === "string"
        ? instruction.slice(0, 8192)
        : defaultInstruction,
    enabled: recipe?.enabled !== false,
    type:
      attribute?.type ??
      (typeof legacy?.type === "string" ? legacy.type : "text"),
    options:
      attribute?.options ??
      (Array.isArray(legacy?.options)
        ? legacy.options.filter((v): v is string => typeof v === "string")
        : []),
  };
}
export function withAgentRecipe(
  attribute: AgentAttribute | undefined,
  name: string,
  type: string,
  options: string[],
  recipe: AgentRecipe,
) {
  if (
    !name.trim() ||
    name.length > 128 ||
    !recipe.instruction.trim() ||
    new TextEncoder().encode(recipe.instruction).length > 8192 ||
    !recipe.inputs.length ||
    recipe.inputs.length > 5 ||
    recipe.inputs.some((i) => !agentInputs.includes(i))
  )
    throw Error("Choose a property, 1–5 inputs and instructions up to 8 KiB.");
  if (!["text", "number", "boolean", "select"].includes(type))
    throw Error(
      "Agent fill supports text, number, checkbox and select properties; formulas calculate locally.",
    );
  if (type === "select" && (!options.length || options.length > 100))
    throw Error("Select properties require 1–100 options.");
  const { name: _name, ...existing } = attribute ?? { name };
  return {
    ...existing,
    type,
    ...(type === "select" ? { options } : {}),
    agentic: { ...recipe, inputs: [...new Set(recipe.inputs)] },
  };
}
