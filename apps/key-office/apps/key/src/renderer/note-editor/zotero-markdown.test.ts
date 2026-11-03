// @vitest-environment jsdom
// The Markdown key-zotero writes for Zotero notes (crates/key-zotero/src/html.rs tests)
// reads as the intended blocks in the note editor and survives a save unchanged in meaning.
import { afterAll, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { buildSchemaExtensions, serializeNote } from "./schema";

const editor = new Editor({ extensions: buildSchemaExtensions(), content: "" });
afterAll(() => editor.destroy());

function load(md: string): JSONContent[] {
  editor.commands.setContent(md, { contentType: "markdown" });
  const nodes = editor.getJSON().content ?? [];
  const last = nodes.at(-1);
  return last?.type === "paragraph" && !last.content?.length ? nodes.slice(0, -1) : nodes;
}
const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join("");
const marks = (node: JSONContent): string[] => [...new Set([...(node.marks ?? []).map((m) => m.type), ...(node.content ?? []).flatMap(marks)])];

describe("converted Zotero notes in the note editor", () => {
  it("headings, emphasis, links and quotes", () => {
    const nodes = load(
      "# Welcome to the notes\n\nThis note was written in **Zotero 7** with *emphasis*, ~~gone~~ and `a_code` -> done.\n\n## 📝 Introduction\n\n> Everything about note management.\n\nIt is a plugin for [Zotero](https://zotero.org).",
    );
    expect(nodes.map((n) => n.type)).toEqual(["heading", "paragraph", "heading", "blockquote", "paragraph"]);
    expect(marks(nodes[1]).sort()).toEqual(["bold", "code", "italic", "strike"]);
    expect(text(nodes[1])).toBe("This note was written in Zotero 7 with emphasis, gone and a_code -> done.");
    expect(nodes[4].content?.[1].marks?.[0]).toMatchObject({ type: "link", attrs: { href: "https://zotero.org" } });
  });

  it("lists nested in lists, tables, code and escaped text", () => {
    const nodes = load(
      "- **[Public Trust](https://example.org/a?x=1&y=2)**: trust in institutions\n- Second point\n    3. three\n    4. four\n\n| Name | Value \\| unit |\n| --- | --- |\n| alpha | 1 |\n| beta |   |\n\n````\n@article{Ajzen1991,\n  title = {Theory of ```Planned``` Behavior},\n}\n````\n\nLine one\\\nline two\n\n\\# not a heading\n\n1\\. not a list\n\na_b and \\_c\\_ and \\[x\\](y)",
    );
    expect(nodes.map((n) => n.type)).toEqual(["bulletList", "table", "codeBlock", "paragraph", "paragraph", "paragraph", "paragraph"]);
    const second = nodes[0].content?.[1];
    expect(second?.content?.map((n) => n.type)).toEqual(["paragraph", "orderedList"]);
    expect(second?.content?.[1].attrs?.start).toBe(3);
    expect(text(nodes[1])).toContain("Value | unit");
    expect(text(nodes[2])).toContain("```Planned```");
    expect(nodes[3].content?.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
    expect(text(nodes[4])).toBe("# not a heading");
    expect(text(nodes[5])).toBe("1. not a list");
    expect(text(nodes[6])).toBe("a_b and _c_ and [x](y)");
  });

  it("highlights as source quotes with page and colour", () => {
    const md = '# Annotations (18/02/2026, 13:24:22)\n\n```quote source="src123" page="4" color="green"\nClustering is widely used for \\*phenotyping\\* because it suits data without labels.\n```\n\nmy comment';
    const nodes = load(md);
    expect(nodes.map((n) => n.type)).toEqual(["heading", "sourceQuote", "paragraph"]);
    expect(nodes[1].attrs).toMatchObject({ source: "src123", page: 4, color: "green" });
    expect(text(nodes[1])).toBe("Clustering is widely used for *phenotyping* because it suits data without labels.");
    // Saving keeps the quote as it was written.
    expect(serializeNote(editor)).toContain('```quote source="src123" page="4" color="green"');
  });
});
