// Document schema of the note editor plus its Markdown mapping. Kept free of
// React so the round-trip tests can build a headless editor from it.
import { Node, mergeAttributes } from "@tiptap/core";
import type { AnyExtension, JSONContent, MarkdownToken } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Image } from "@tiptap/extension-image";
import { fenceFor, fenceStart, matchFence, renderFence } from "./fences";
import type { FenceKind } from "./fences";
import { peekSource, sourceLine } from "./sourceCache";
import { CALLOUT_TONES } from "./types";
import type { CalloutTone } from "./types";

function fenceTokenizer(kind: FenceKind, accept?: (attrs: Record<string, string>) => boolean, inline = false) {
  return {
    name: kind === "source" ? "sourceEmbed" : kind === "quote" ? "sourceQuote" : kind,
    level: "block" as const,
    start: (src: string) => fenceStart(src),
    tokenize(src: string, _tokens: MarkdownToken[], lexer: { blockTokens(s: string): MarkdownToken[]; inlineTokens(s: string): MarkdownToken[] }) {
      const fence = matchFence(src, kind);
      if (!fence || (accept && !accept(fence.attrs))) return undefined;
      return {
        type: kind === "source" ? "sourceEmbed" : kind === "quote" ? "sourceQuote" : kind,
        raw: fence.raw,
        attrs: fence.attrs,
        body: fence.body,
        tokens: inline ? lexer.inlineTokens(fence.body) : kind === "source" ? [] : lexer.blockTokens(fence.body),
      };
    },
  };
}

/**
 * Inside list items marked lexes with `top = false`, which yields block-level
 * `text` tokens instead of paragraphs; treat them as paragraphs.
 */
function asBlocks(tokens: MarkdownToken[] | undefined): MarkdownToken[] {
  return (tokens ?? []).map((t) => (t.type === "text" && Array.isArray(t.tokens) ? { ...t, type: "paragraph" } : t));
}

function blockChildren(content: JSONContent[]): JSONContent[] {
  return content.length > 0 ? content : [{ type: "paragraph" }];
}

function normalizeTone(value: unknown): CalloutTone {
  return CALLOUT_TONES.includes(value as CalloutTone) ? (value as CalloutTone) : "info";
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: "info",
        parseHTML: (el) => normalizeTone(el.getAttribute("data-tone")),
        renderHTML: (attrs) => ({ "data-tone": attrs.tone }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "", class: "ne-callout" }), 0];
  },

  markdownTokenizer: fenceTokenizer("callout"),

  parseMarkdown(token, helpers) {
    return helpers.createNode("callout", { tone: normalizeTone(token.attrs?.tone) }, blockChildren(helpers.parseChildren(asBlocks(token.tokens))));
  },

  renderMarkdown(node, h) {
    const body = node.content ? h.renderChildren(node.content, "\n\n") : "";
    return renderFence("callout", [["tone", normalizeTone(node.attrs?.tone)]], body);
  },
});

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? "",
        renderHTML: (attrs) => ({ "data-title": attrs.title }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toggle": "", class: "ne-toggle" }), 0];
  },

  markdownTokenizer: fenceTokenizer("toggle"),

  parseMarkdown(token, helpers) {
    return helpers.createNode("toggle", { title: token.attrs?.title ?? "" }, blockChildren(helpers.parseChildren(asBlocks(token.tokens))));
  },

  renderMarkdown(node, h) {
    const body = node.content ? h.renderChildren(node.content, "\n\n") : "";
    return renderFence("toggle", [["title", String(node.attrs?.title ?? "")]], body);
  },
});

export const SourceEmbed = Node.create({
  name: "sourceEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-source-id") ?? "",
        renderHTML: (attrs) => ({ "data-source-id": attrs.id }),
      },
      // fallback line read from the file; only used when the source is unresolved
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (attrs) => (attrs.label ? { "data-label": attrs.label } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-source-embed]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-source-embed": "", class: "ne-source-card" })];
  },

  markdownTokenizer: fenceTokenizer("source", (attrs) => Boolean(attrs.id)),

  parseMarkdown(token, helpers) {
    const label = String(token.body ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
    return helpers.createNode("sourceEmbed", { id: token.attrs?.id ?? "", label });
  },

  renderMarkdown(node) {
    const id = String(node.attrs?.id ?? "");
    const ref = peekSource(id);
    const line = ref ? sourceLine(ref) : String(node.attrs?.label || "") || id;
    return renderFence("source", [["id", id]], line.replace(/\n+/g, " "));
  },
});

export const SourceQuote = Node.create({
  name: "sourceQuote",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-source") ?? "",
        renderHTML: (attrs) => ({ "data-source": attrs.source }),
      },
      page: {
        default: null,
        parseHTML: (el) => parsePage(el.getAttribute("data-page")),
        renderHTML: (attrs) => (attrs.page === null || attrs.page === undefined ? {} : { "data-page": String(attrs.page) }),
      },
      /** The colour of the PDF highlight it came from (yellow, blue, green, red, purple…). */
      color: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-color"),
        renderHTML: (attrs) => (attrs.color ? { "data-color": String(attrs.color) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "blockquote[data-source-quote]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(HTMLAttributes, { "data-source-quote": "", class: "ne-squote" }), 0];
  },

  markdownTokenizer: fenceTokenizer("quote", (attrs) => Boolean(attrs.source), true),

  parseMarkdown(token, helpers) {
    return helpers.createNode(
      "sourceQuote",
      { source: token.attrs?.source ?? "", page: parsePage(token.attrs?.page), color: token.attrs?.color || null },
      helpers.parseInline(token.tokens ?? []),
    );
  },

  renderMarkdown(node, h) {
    const body = node.content ? h.renderChildren(node.content) : "";
    const page = node.attrs?.page;
    return renderFence(
      "quote",
      [
        ["source", String(node.attrs?.source ?? "")],
        ["page", page === null || page === undefined ? null : String(page)],
        ["color", node.attrs?.color ? String(node.attrs.color) : null],
      ],
      body,
    );
  },
});

function parsePage(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Code block whose fence grows past any backtick run in the code. */
export const NoteCodeBlock = CodeBlock.extend({
  renderMarkdown(node, h) {
    const language = node.attrs?.language || "";
    const body = node.content ? h.renderChildren(node.content) : "";
    const fence = fenceFor(body);
    return `${fence}${language}\n${body}\n${fence}`;
  },
});

export interface NoteSchemaParts {
  callout?: AnyExtension;
  toggle?: AnyExtension;
  sourceEmbed?: AnyExtension;
  sourceQuote?: AnyExtension;
  codeBlock?: AnyExtension;
}

/** Schema + Markdown extensions; the editor component swaps in node views. */
export function buildSchemaExtensions(parts: NoteSchemaParts = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      // `++text++` is not GFM
      underline: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ["key"],
      },
    }),
    parts.codeBlock ?? NoteCodeBlock,
    // 4-space nesting keeps sub-lists of "1." items nested in strict parsers
    Markdown.configure({ indentation: { style: "space", size: 4 } }),
    TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: false }),
    parts.callout ?? Callout,
    parts.toggle ?? Toggle,
    parts.sourceEmbed ?? SourceEmbed,
    parts.sourceQuote ?? SourceQuote,
  ];
}

/**
 * The editor's Markdown, minus the empty trailing paragraph(s) the trailing-node
 * plugin keeps after a final list/table/callout.
 */
export function serializeNote(editor: { getMarkdown(): string }): string {
  return collapseBlankLines(editor.getMarkdown()).replace(/(?:\s|&nbsp;|\u00a0)+$/, "");
}

/**
 * The upstream list/table serialisers leave runs of two blank lines; outside
 * code blocks extra blank lines carry no meaning (empty paragraphs are written
 * as &nbsp;), so collapse them to one.
 */
export function collapseBlankLines(md: string): string {
  const out: string[] = [];
  let code: string | null = null; // opening fence of the code block we are in
  let blank = 0;
  for (const line of md.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (code) {
      if (fence && fence[1][0] === code[0] && fence[1].length >= code.length && !fence[2].trim()) code = null;
      out.push(line);
      continue;
    }
    if (fence && !/^(?:callout|toggle|source|quote)\b/.test(fence[2].trim())) code = fence[1];
    if (!line.trim()) {
      blank += 1;
      if (blank > 1) continue;
    } else blank = 0;
    out.push(line);
  }
  return out.join("\n");
}
