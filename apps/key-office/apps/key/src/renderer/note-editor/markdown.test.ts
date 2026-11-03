// @vitest-environment jsdom
import { afterAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { buildSchemaExtensions, serializeNote } from "./schema";
import { markdownToPlainText } from "./plainText";
import { rememberSource } from "./sourceCache";

const editors: Editor[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});

function createEditor(): Editor {
  const editor = new Editor({ extensions: buildSchemaExtensions(), content: "" });
  editors.push(editor);
  return editor;
}

const editor = createEditor();

/** markdown → editor document → markdown, plus a second pass that must be stable */
function roundTrip(md: string): { out: string; doc: JSONContent; stable: boolean } {
  editor.commands.setContent(md, { contentType: "markdown" });
  const doc = editor.getJSON();
  const out = serializeNote(editor);
  editor.commands.setContent(out, { contentType: "markdown" });
  const again = serializeNote(editor);
  return { out, doc, stable: again === out && JSON.stringify(editor.getJSON()) === JSON.stringify(doc) };
}

function types(doc: JSONContent): string[] {
  const nodes = [...(doc.content ?? [])];
  // the trailing-node plugin keeps an empty paragraph after a final non-paragraph block
  const last = nodes[nodes.length - 1];
  if (doc.type === "doc" && last?.type === "paragraph" && !last.content?.length) nodes.pop();
  return nodes.map((n) => n.type ?? "");
}

describe("note markdown round-trip", () => {
  it("headings", () => {
    const { out, doc, stable } = roundTrip("# One\n\n## Two\n\n### Three\n\nBody **bold** *it* ~~gone~~ `code`");
    expect(types(doc)).toEqual(["heading", "heading", "heading", "paragraph"]);
    expect(out).toContain("# One\n\n## Two\n\n### Three");
    expect(out).toContain("**bold**");
    expect(out).toContain("~~gone~~");
    expect(out).toContain("`code`");
    expect(stable).toBe(true);
  });

  it("bullet and numbered lists", () => {
    const { out, doc, stable } = roundTrip("- a\n- b\n    - nested\n\n1. one\n2. two");
    expect(types(doc)).toEqual(["bulletList", "orderedList"]);
    expect(out).toContain("- a\n- b\n    - nested");
    expect(out).toContain("1. one\n2. two");
    expect(stable).toBe(true);
  });

  it("nested to-dos", () => {
    const { out, doc, stable } = roundTrip("- [ ] open\n    - [x] done child\n- [x] done");
    expect(types(doc)).toEqual(["taskList"]);
    expect(JSON.stringify(doc)).toContain('"checked":true');
    expect(out).toContain("- [ ] open\n    - [x] done child\n- [x] done");
    expect(stable).toBe(true);
  });

  it("tables", () => {
    const { out, doc, stable } = roundTrip("| Name | Value |\n| --- | --- |\n| a | 1 |");
    expect(types(doc)).toEqual(["table"]);
    expect(out).toContain("| Name | Value |");
    expect(out).toMatch(/\| a\s+\| 1\s+\|/);
    expect(stable).toBe(true);
  });

  it("code with a language, and ordinary ```js stays code", () => {
    const { out, doc, stable } = roundTrip("```js\nconst a = 1\n```");
    expect(types(doc)).toEqual(["codeBlock"]);
    expect(doc.content?.[0].attrs?.language).toBe("js");
    expect(out).toBe("```js\nconst a = 1\n```");
    expect(stable).toBe(true);
  });

  it("info strings that only start like a note block stay code", () => {
    const { doc } = roundTrip("```callouts\nx\n```\n\n```quote\nno source attr\n```");
    expect(types(doc)).toEqual(["codeBlock", "codeBlock"]);
    expect(doc.content?.[1].attrs?.language).toBe("quote");
  });

  it("divider, quote and image", () => {
    const { out, doc, stable } = roundTrip("> quoted\n\n---\n\n![Chart](https://example.org/a.png)");
    expect(types(doc)).toEqual(["blockquote", "horizontalRule", "image"]);
    expect(out).toContain("> quoted");
    expect(out).toContain("---");
    expect(out).toContain("![Chart](https://example.org/a.png)");
    expect(stable).toBe(true);
  });

  it("video embed fence keeps its link and title", () => {
    const md = '```video url="https://www.youtube.com/watch?v=6GR75W2dRmU"\nA lecture on health economics\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(types(doc)).toEqual(["videoEmbed"]);
    expect(doc.content?.[0].attrs).toEqual({ url: "https://www.youtube.com/watch?v=6GR75W2dRmU", title: "A lecture on health economics" });
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("video without a title writes its link as the body", () => {
    editor.commands.setContent({ type: "doc", content: [{ type: "videoEmbed", attrs: { url: "https://vimeo.com/76979871" } }] });
    const out = serializeNote(editor);
    expect(out).toBe('```video url="https://vimeo.com/76979871"\nhttps://vimeo.com/76979871\n```');
    const { doc, stable } = roundTrip(out);
    expect(doc.content?.[0].attrs?.title).toBe("");
    expect(stable).toBe(true);
  });

  it("a video fence with a link that is not a video stays code", () => {
    const { doc } = roundTrip('```video url="https://example.org/page"\nx\n```');
    expect(types(doc)).toEqual(["codeBlock"]);
  });

  it("image with a caption and width becomes a fence and back", () => {
    const md = '```image src="media/0123456789abcdef0123456789abcdef.png" alt="Bar chart" width="480"\nResponse rates by region\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(types(doc)).toEqual(["image"]);
    expect(doc.content?.[0].attrs).toMatchObject({
      src: "media/0123456789abcdef0123456789abcdef.png",
      alt: "Bar chart",
      title: "Response rates by region",
      width: 480,
    });
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("a plain image stays plain Markdown until it is resized", () => {
    editor.commands.setContent("![](media/0123456789abcdef.webp)", { contentType: "markdown" });
    expect(serializeNote(editor)).toBe("![](media/0123456789abcdef.webp)");
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { width: 320 });
    const out = serializeNote(editor);
    expect(out).toBe('```image src="media/0123456789abcdef.webp" width="320"\n\n```');
    const again = roundTrip(out);
    expect(again.doc.content?.[0].attrs).toMatchObject({ src: "media/0123456789abcdef.webp", width: 320, title: null });
    expect(again.stable).toBe(true);
  });

  it("callout containing a list", () => {
    const md = '```callout tone="warning"\nCheck **these**:\n\n- one\n- two\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(types(doc)).toEqual(["callout"]);
    expect(doc.content?.[0].attrs?.tone).toBe("warning");
    expect(types(doc.content![0])).toEqual(["paragraph", "bulletList"]);
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("callout defaults to info and nests inside a callout", () => {
    const plain = roundTrip("```callout\nouter\n```");
    expect(plain.doc.content?.[0]).toMatchObject({ type: "callout", attrs: { tone: "info" } });
    expect(plain.out).toBe('```callout tone="info"\nouter\n```');
    const md = '````callout tone="note"\nouter\n\n```callout tone="tip"\ninner\n```\n````';
    const nested = roundTrip(md);
    expect(types(nested.doc.content![0])).toEqual(["paragraph", "callout"]);
    expect(nested.out).toBe(md);
    expect(nested.stable).toBe(true);
  });

  it("toggle", () => {
    const md = '```toggle title="Key findings"\nFirst finding\n\n1. a\n2. b\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(types(doc)).toEqual(["toggle"]);
    expect(doc.content?.[0].attrs?.title).toBe("Key findings");
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("toggle title with quotes is escaped", () => {
    const md = '```toggle title="Say \\"hi\\""\nbody\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(doc.content?.[0].attrs?.title).toBe('Say "hi"');
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("source embed keeps its fallback line until the source resolves", () => {
    const md = '```source id="abc123"\nPalma et al. 2022 — Health versus income amid COVID-19\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(doc.content?.[0]).toMatchObject({ type: "sourceEmbed", attrs: { id: "abc123" } });
    expect(out).toBe(md);
    expect(stable).toBe(true);

    rememberSource({ id: "zz9", title: "Fresh title", detail: "Doe 2020" });
    const resolved = roundTrip('```source id="zz9"\nstale line\n```');
    expect(resolved.out).toBe('```source id="zz9"\nDoe 2020 — Fresh title\n```');
  });

  it("quote keeps the highlight colour", () => {
    const md = '```quote source="abc123" page="4" color="blue"\nFrom a blue highlight.\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(doc.content?.[0]).toMatchObject({ type: "sourceQuote", attrs: { source: "abc123", page: 4, color: "blue" } });
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("quote with page", () => {
    const md = '```quote source="abc123" page="4"\nThe quoted *passage*…\n```';
    const { out, doc, stable } = roundTrip(md);
    expect(doc.content?.[0]).toMatchObject({ type: "sourceQuote", attrs: { source: "abc123", page: 4 } });
    expect(doc.content?.[0].content?.[0].text).toBe("The quoted ");
    expect(out).toBe(md);
    expect(stable).toBe(true);

    const noPage = roundTrip('```quote source="abc123"\nNo page.\n```');
    expect(noPage.doc.content?.[0].attrs?.page).toBeNull();
    expect(noPage.out).toBe('```quote source="abc123"\nNo page.\n```');
  });

  it("source mention link", () => {
    const md = "As shown by [Palma 2022](key://source/abc123), income matters.";
    const { out, doc, stable } = roundTrip(md);
    const link = doc.content?.[0].content?.[1];
    expect(link?.marks?.[0]).toMatchObject({ type: "link", attrs: { href: "key://source/abc123" } });
    expect(out).toBe(md);
    expect(stable).toBe(true);
  });

  it("lengthens the fence when the body contains ```", () => {
    const md = '````callout tone="tip"\nExample:\n\n```js\nrun()\n```\n````';
    const { out, doc, stable } = roundTrip(md);
    expect(types(doc)).toEqual(["callout"]);
    expect(types(doc.content![0])).toEqual(["paragraph", "codeBlock"]);
    expect(out).toBe(md);
    expect(stable).toBe(true);

    // a code block that itself contains ``` gets a longer fence too
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "md" }, content: [{ type: "text", text: "```js\nx\n```" }] }],
    });
    const code = serializeNote(editor);
    expect(code).toBe("````md\n```js\nx\n```\n````");
    expect(roundTrip(code).out).toBe(code);
  });

  it("collapses double blank lines but not inside code", () => {
    const { out } = roundTrip("- [ ] a\n\n| x |\n| --- |\n| 1 |\n\nafter\n\n```\nkeep\n\n\nblank\n```");
    expect(out).not.toMatch(/\n\n\n(?!blank)/);
    expect(out).toContain("- [ ] a\n\n| x");
    expect(out).toContain("keep\n\n\nblank");
  });

  it("note blocks inside a list item", () => {
    const md = '- item\n\n    ```callout tone="info"\n    inside\n    ```';
    const { doc, stable } = roundTrip(md);
    expect(JSON.stringify(doc)).toContain('"type":"callout"');
    expect(stable).toBe(true);
  });
});

describe("markdownToPlainText", () => {
  it("strips syntax and fences but keeps quote and callout text", () => {
    const md = [
      "# Title",
      "",
      "Some **bold** and [Palma 2022](key://source/abc) text.",
      "",
      '```callout tone="tip"',
      "Callout *body*",
      "```",
      "",
      '```quote source="abc" page="2"',
      "Quoted words",
      "```",
      "",
      '```source id="abc"',
      "Palma et al. 2022 — Health",
      "```",
      "",
      "- [ ] task one",
      "> blockquote",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    expect(markdownToPlainText(md)).toBe(
      "Title Some bold and Palma 2022 text. Callout body Quoted words Palma et al. 2022 — Health task one blockquote a b 1 2",
    );
  });

  it("keeps a video's title and an image's caption", () => {
    const md = [
      '```video url="https://youtu.be/6GR75W2dRmU"',
      "A lecture on health economics",
      "```",
      "",
      '```image src="media/0123456789abcdef.png" width="300"',
      "Response rates",
      "```",
    ].join("\n");
    expect(markdownToPlainText(md)).toBe("A lecture on health economics Response rates");
  });
});
