import { describe, it, expect } from "vitest";
import { evaluatePropertyFormula as formula } from "./property-formula";
describe("restricted property formulas", () => {
  it("uses typed fields and arithmetic precedence", () => {
    expect(formula("[year] + 2 * 3", { year: 2020 })).toBe(2026);
    expect(formula("([year] + 2) * 3", { year: 2020 })).toBe(6066);
  });
  it("supports mock curly references and built-in field casing", () => {
    expect(formula("{Year} + {Pages}", { year: 2020, pages: 6 })).toBe(2026);
  });
  it("supports deterministic text and predicates", () => {
    expect(
      formula('if([reviewed], upper([title]), "pending")', {
        reviewed: true,
        title: "Memory",
      }),
    ).toBe("MEMORY");
    expect(
      formula('contains(lower([title]), "memory")', {
        title: "MEMORY systems",
      }),
    ).toBe(true);
  });
  it("rejects executable, unknown, nonfinite and unbounded expressions", () => {
    expect(() => formula("process.exit()", {})).toThrow();
    expect(() => formula("1 / 0", {})).toThrow();
    expect(() => formula("(".repeat(40) + "1" + ")".repeat(40), {})).toThrow();
    expect(() => formula("[obj]", { obj: { value: 1 } })).toThrow();
  });
  it("treats absent fields as null and supports coalescing", () => {
    expect(formula('coalesce([missing], "unknown")', {})).toBe("unknown");
  });
});
