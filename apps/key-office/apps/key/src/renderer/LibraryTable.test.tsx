import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiteralMatches } from "./LibraryTable";
describe("literal passage match rendering", () => {
  it("highlights single-character whole words",()=>{expect(renderToStaticMarkup(<LiteralMatches text="I see x in text." query="I x"/>)).toBe("<mark>I</mark> see <mark>x</mark> in text.");});
  it("marks only actual whole words, preserving source spelling", () => {
    expect(
      renderToStaticMarkup(
        <LiteralMatches
          text="Memory and memoryless systems"
          query="memory imagined"
        />,
      ),
    ).toBe("<mark>Memory</mark> and memoryless systems");
  });
  it("does not interpret snippets as HTML", () => {
    const result = renderToStaticMarkup(
      <LiteralMatches
        text={"<script>alert(1)</script> memory"}
        query="memory"
      />,
    );
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
    expect(result).toContain("<mark>memory</mark>");
  });
  it("handles quoted phrases and Unicode words", () => {
    expect(
      renderToStaticMarkup(
        <LiteralMatches
          text="Überblick on working memory."
          query={'Überblick "working memory"'}
        />,
      ),
    ).toBe("<mark>Überblick</mark> on <mark>working memory</mark>.");
  });
  it("leaves semantic-only passages unmarked", () => {
    expect(
      renderToStaticMarkup(
        <LiteralMatches
          text="Sleep supports recall."
          query="memory consolidation"
        />,
      ),
    ).toBe("Sleep supports recall.");
  });
});
