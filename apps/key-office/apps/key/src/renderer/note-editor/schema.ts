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
import { parseVideoUrl } from "./media";
import { fenceFor, fenceStart, matchFence, renderFence } from "./fences";
import type { FenceKind } from "./fences";
import { peekSource, sourceLine } from "./sourceCache";
import { CALLOUT_TONES } from "./types";
import type { CalloutTone } from "./types";

const TOKEN_NAME: Record<FenceKind, string> = {
  callout: "callout",
  toggle: "toggle",
  source: "sourceEmbed",
  quote: "sourceQuote",
  video: "videoEmbed",
  // the editor's image node also takes marked's `![alt](src)` tokens, which share this type
  image: "image",
};

/** Fences whose body is a plain line (a label, title or caption), not Markdown blocks. */
const LINE_BODY: readonly FenceKind[] = ["source", "video", "image"];

function fenceTokenizer(kind: FenceKind, accept?: (attrs: Record<string, string>) => boolean, inline = false) {
  return {
    name: kind === "image" ? "noteImageFence" : TOKEN_NAME[kind],
    level: "block" as const,
    start: (src: string) => fenceStart(src),
    tokenize(src: string, _tokens: MarkdownToken[], lexer: { blockTokens(s: string): MarkdownToken[]; inlineTokens(s: string): MarkdownToken[] }) {
      const fence = matchFence(src, kind);
      if (!fence || (accept && !accept(fence.attrs))) return undefined;
      return {
        type: TOKEN_NAME[kind],
        raw: fence.raw,
        fence: true,
        attrs: fence.attrs,
        body: fence.body,
        tokens: inline ? lexer.inlineTokens(fence.body) : LINE_BODY.includes(kind) ? [] : lexer.blockTokens(fence.body),
      };
    },
  };
}

/** First non-empty line of a fence body, on one line. */
function bodyLine(token: MarkdownToken): string {
  return String(token.body ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
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
    return helpers.createNode("sourceEmbed", { id: token.attrs?.id ?? "", label: bodyLine(token) });
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

export const VideoEmbed = Node.create({
  name: "videoEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-url") ?? "",
        renderHTML: (attrs) => ({ "data-url": attrs.url }),
      },
      // the provider's title, kept so the note stays searchable and readable offline
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? "",
        renderHTML: (attrs) => (attrs.title ? { "data-title": attrs.title } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-video-embed]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-video-embed": "", class: "ne-video" })];
  },

  markdownTokenizer: fenceTokenizer("video", (attrs) => Boolean(attrs.url && parseVideoUrl(attrs.url))),

  parseMarkdown(token, helpers) {
    const url = String(token.attrs?.url ?? "");
    const line = bodyLine(token);
    return helpers.createNode("videoEmbed", { url, title: line === url ? "" : line });
  },

  renderMarkdown(node) {
    const url = String(node.attrs?.url ?? "");
    // without a title the link itself is the searchable line
    const line = String(node.attrs?.title || "") || url;
    return renderFence("video", [["url", url]], line.replace(/\n+/g, " "));
  },
});

function parseWidth(value: unknown): number | null {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 24 ? n : null;
}

/**
 * Block image. A plain one is written as `![alt](src)`; once it has a caption or a width
 * it becomes an `image` fence whose body is the caption. Pasted and dropped files are
 * stored in the workspace and referenced as `media/<sha256>.<ext>`, never inlined.
 */
export const NoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => parseWidth(el.getAttribute("width")),
        renderHTML: (attrs) => (attrs.width ? { width: String(attrs.width) } : {}),
      },
    };
  },

  markdownTokenizer: fenceTokenizer("image", (attrs) => Boolean(attrs.src)),

  parseMarkdown(token, helpers) {
    if (token.fence) {
      const caption = bodyLine(token);
      return helpers.createNode("image", {
        src: token.attrs?.src ?? "",
        alt: token.attrs?.alt || null,
        title: caption || null,
        width: parseWidth(token.attrs?.width),
      });
    }
    return helpers.createNode("image", { src: token.href, title: token.title || null, alt: token.text || null });
  },

  renderMarkdown(node) {
    const src = String(node.attrs?.src ?? "");
    const alt = String(node.attrs?.alt ?? "");
    const caption = String(node.attrs?.title ?? "").replace(/\n+/g, " ").trim();
    const width = parseWidth(node.attrs?.width);
    if (!caption && !width) return `![${alt.replace(/[[\]]/g, "\\$&")}](${src.replace(/[ ()]/g, encodeURIComponent)})`;
    return renderFence(
      "image",
      [
        ["src", src],
        ["alt", alt || null],
        ["width", width ? String(width) : null],
      ],
      caption,
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
  videoEmbed?: AnyExtension;
  image?: AnyExtension;
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
    parts.image ?? NoteImage.configure({ inline: false }),
    parts.callout ?? Callout,
    parts.toggle ?? Toggle,
    parts.sourceEmbed ?? SourceEmbed,
    parts.sourceQuote ?? SourceQuote,
    parts.videoEmbed ?? VideoEmbed,
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
    if (fence && !/^(?:callout|toggle|source|quote|video|image)\b/.test(fence[2].trim())) code = fence[1];
    if (!line.trim()) {
      blank += 1;
      if (blank > 1) continue;
    } else blank = 0;
    out.push(line);
  }
  return out.join("\n");
}
