import { describe, expect, it } from "vitest";
import { apa, apaInText, bibtex } from "./citation";

const article = {
  id: "1",
  kind: "pdf",
  itemType: "article",
  title: "Health versus income amid COVID-19: What do people value more?",
  creators: [
    { family: "Palma", given: "Marco A.", role: "author" },
    { family: "Huseynov", given: "Samir", role: "author" },
    { family: "Nayga", given: "Rodolfo M.", role: "author" },
  ],
  year: 2022,
  containerTitle: "PLoS One",
  volume: "17",
  issue: "4",
  pages: "e0266237",
  doi: "10.1371/journal.pone.0266237",
};

describe("citations", () => {
  it("formats APA 7 journal references", () => {
    expect(apa(article)).toBe(
      "Palma, M. A., Huseynov, S., & Nayga, R. M. (2022). Health versus income amid COVID-19: What do people value more? PLoS One, 17(4), e0266237. https://doi.org/10.1371/journal.pone.0266237",
    );
    expect(apa(article, true)).toContain("<i>PLoS One</i>, <i>17</i>(4)");
  });

  it("formats in-text citations and books without authors", () => {
    expect(apaInText(article)).toBe("(Palma et al., 2022)");
    expect(apaInText({ ...article, creators: article.creators.slice(0, 2) })).toBe("(Palma & Huseynov, 2022)");
    expect(apa({ id: "2", kind: "reference", itemType: "book", title: "Untitled report", creators: [], publisher: "WHO" })).toBe(
      "Untitled report. (n.d.). WHO.",
    );
  });

  it("writes BibTeX with a derived key", () => {
    const entry = bibtex(article);
    expect(entry.startsWith("@article{palma2022health,")).toBe(true);
    expect(entry).toContain("author = {Palma, Marco A. and Huseynov, Samir and Nayga, Rodolfo M.}");
    expect(entry).toContain("journal = {PLoS One}");
    expect(bibtex({ ...article, citationKey: "palma_health_2022" })).toContain("@article{palma_health_2022,");
  });
});
