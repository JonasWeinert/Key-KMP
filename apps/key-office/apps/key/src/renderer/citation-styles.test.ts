import { describe, expect, it } from "vitest";
import { inTextCitationFor, narrativeCitation, referenceEntry } from "./citation-styles";

const article = {
  id: "a",
  kind: "pdf",
  itemType: "article",
  title: "Education-related inequalities in beliefs and behaviors",
  creators: [
    { family: "Kirkby", given: "Jane" },
    { family: "Smith", given: "Ann" },
    { family: "Lee", given: "Bo" },
  ],
  year: 2022,
  containerTitle: "Journal of Health",
  volume: "12",
  issue: "3",
  pages: "4-19",
  doi: "10.1/xyz",
};
const pair = { ...article, creators: article.creators.slice(0, 2) };

describe("citation styles", () => {
  it("writes rows' bylines", () => {
    expect(narrativeCitation(article)).toBe("Kirkby et al. (2022)");
    expect(narrativeCitation(pair)).toBe("Kirkby & Smith (2022)");
    expect(narrativeCitation(pair, "harvard")).toBe("Kirkby and Smith (2022)");
    expect(narrativeCitation({ ...article, creators: [], year: undefined })).toBe(`${article.title} (n.d.)`);
  });

  it("cites in the text with pages", () => {
    expect(inTextCitationFor(article, "apa")).toBe("(Kirkby et al., 2022)");
    expect(inTextCitationFor(article, "apa", 3)).toBe("(Kirkby et al., 2022, p. 4)");
    expect(inTextCitationFor(article, "chicago", 3)).toBe("(Kirkby, Smith, and Lee 2022, 4)");
    expect(inTextCitationFor(pair, "mla", 3)).toBe("(Kirkby and Smith 4)");
  });

  it("writes reference list entries", () => {
    expect(referenceEntry(article, "apa")).toContain("Kirkby, J., Smith, A., & Lee, B. (2022).");
    expect(referenceEntry(article, "chicago")).toBe(
      "Kirkby, Jane, Ann Smith, and Bo Lee. 2022. “Education-related inequalities in beliefs and behaviors.” Journal of Health 12 (3): 4–19. https://doi.org/10.1/xyz",
    );
    expect(referenceEntry(article, "mla")).toBe(
      "Kirkby, Jane, et al. “Education-related inequalities in beliefs and behaviors.” Journal of Health, vol. 12, no. 3, 2022, pp. 4–19. https://doi.org/10.1/xyz",
    );
    expect(referenceEntry(pair, "harvard")).toBe(
      "Kirkby, J. and Smith, A. (2022) ‘Education-related inequalities in beliefs and behaviors’, Journal of Health, 12(3), pp. 4–19. Available at: https://doi.org/10.1/xyz.",
    );
    expect(referenceEntry(article, "mla", true)).toContain("<i>Journal of Health</i>");
  });
});
