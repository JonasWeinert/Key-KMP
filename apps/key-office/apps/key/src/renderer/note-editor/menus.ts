// Slash menu items, the @ source picker, and the Suggestion plugins that drive them.
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { IconName } from "../icons";
import { insertVideo, pickImageFiles } from "./mediaBehaviors";
import { getRuntime } from "./runtime";
import type { PickMode } from "./runtime";
import { mentionLabel, rememberSource, sourceLine } from "./sourceCache";
import { itemHref, refItem } from "./types";
import type { SourceRef } from "./types";

export type SlashGroup = "Basic blocks" | "Lists" | "Research" | "Media";
export const SLASH_GROUPS: readonly SlashGroup[] = ["Basic blocks", "Lists", "Research", "Media"];

export interface SlashItem {
  id: string;
  label: string;
  hint: string;
  group: SlashGroup;
  icon: IconName | { glyph: string } | "warning";
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
}

function clear(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range);
}

/** Inserts "@" so the source picker opens, in the given mode. */
function openPicker(editor: Editor, range: Range, mode: PickMode) {
  const runtime = getRuntime(editor);
  if (runtime) runtime.pickMode = mode;
  clear(editor, range).insertContent("@").run();
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", label: "Text", hint: "Plain paragraph", group: "Basic blocks", icon: { glyph: "T" }, keywords: ["paragraph", "plain", "p"], run: (e, r) => clear(e, r).setParagraph().run() },
  { id: "h1", label: "Heading 1", hint: "Large section title", group: "Basic blocks", icon: { glyph: "H1" }, keywords: ["title", "#"], run: (e, r) => clear(e, r).setHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", hint: "Medium section title", group: "Basic blocks", icon: { glyph: "H2" }, keywords: ["subtitle", "##"], run: (e, r) => clear(e, r).setHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Small section title", group: "Basic blocks", icon: { glyph: "H3" }, keywords: ["###"], run: (e, r) => clear(e, r).setHeading({ level: 3 }).run() },
  { id: "quote", label: "Quote", hint: "Indented quotation", group: "Basic blocks", icon: { glyph: "”" }, keywords: ["blockquote", ">"], run: (e, r) => clear(e, r).setBlockquote().run() },
  { id: "divider", label: "Divider", hint: "Horizontal rule", group: "Basic blocks", icon: { glyph: "—" }, keywords: ["hr", "rule", "line", "---"], run: (e, r) => clear(e, r).setHorizontalRule().run() },
  { id: "code", label: "Code", hint: "Code block with syntax", group: "Basic blocks", icon: { glyph: "</>" }, keywords: ["codeblock", "```", "snippet"], run: (e, r) => clear(e, r).setCodeBlock().run() },
  { id: "table", label: "Table", hint: "Simple grid", group: "Basic blocks", icon: "table", keywords: ["grid", "columns"], run: (e, r) => clear(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "bullet", label: "Bulleted list", hint: "Simple list", group: "Lists", icon: "list", keywords: ["ul", "unordered", "-"], run: (e, r) => clear(e, r).toggleBulletList().run() },
  { id: "numbered", label: "Numbered list", hint: "Ordered steps", group: "Lists", icon: { glyph: "1." }, keywords: ["ol", "ordered", "1."], run: (e, r) => clear(e, r).toggleOrderedList().run() },
  { id: "todo", label: "To-do list", hint: "Checkboxes to tick off", group: "Lists", icon: "check", keywords: ["task", "checkbox", "[]"], run: (e, r) => clear(e, r).toggleTaskList().run() },
  { id: "callout", label: "Callout", hint: "Highlighted note box", group: "Research", icon: "info", keywords: ["note", "tip", "warning", "admonition", "box"], run: (e, r) => clear(e, r).wrapIn("callout", { tone: "info" }).run() },
  { id: "toggle", label: "Toggle", hint: "Collapsible section", group: "Research", icon: "chevronRight", keywords: ["collapse", "details", "fold"], run: (e, r) => clear(e, r).wrapIn("toggle", { title: "" }).run() },
  { id: "link-source", label: "Link to anything", hint: "Note, source, highlight or canvas, like @", group: "Research", icon: "link", keywords: ["mention", "cite", "reference", "@", "note", "canvas", "highlight", "backlink"], run: (e, r) => openPicker(e, r, "link") },
  { id: "embed-source", label: "Embed a source", hint: "Card for a library item", group: "Research", icon: "books", keywords: ["card", "reference", "paper"], run: (e, r) => openPicker(e, r, "embed") },
  { id: "quote-source", label: "Quote from a source", hint: "Quotation with attribution", group: "Research", icon: "quote", keywords: ["citation", "excerpt", "cite"], run: (e, r) => openPicker(e, r, "quote") },
  {
    id: "image",
    label: "Image",
    hint: "Upload from your Mac",
    group: "Media",
    icon: "image",
    keywords: ["picture", "photo", "img", "upload", "file"],
    run: (e, r) => {
      clear(e, r).run();
      if (getRuntime(e)?.saveImage) pickImageFiles(e);
      else promptImageUrl(e);
    },
  },
  {
    id: "image-url",
    label: "Image from URL",
    hint: "Embed by link",
    group: "Media",
    icon: "link",
    keywords: ["picture", "photo", "img", "url", "web"],
    run: (e, r) => {
      clear(e, r).run();
      promptImageUrl(e);
    },
  },
  {
    id: "video",
    label: "Video",
    hint: "YouTube, Vimeo or a video link",
    group: "Media",
    icon: "video",
    keywords: ["youtube", "vimeo", "embed", "movie", "film"],
    run: (e, r) => {
      clear(e, r).run();
      getRuntime(e)?.promptUrl({
        title: "Video link",
        placeholder: "https://www.youtube.com/watch?v=…",
        submit: (url) => {
          if (!insertVideo(e, url)) e.chain().focus().insertContent(url).run();
        },
      });
    },
  },
];

/** Subsequence match; higher is better, -1 when the query does not match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  const word = t.indexOf(` ${q}`);
  if (word >= 0) return 800 - word;
  const sub = t.indexOf(q);
  if (sub >= 0) return 600 - sub;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, last + 1);
    if (at < 0) return -1;
    score += at === last + 1 ? 6 : 1;
    last = at;
  }
  return score;
}

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim();
  if (!q) return items;
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(fuzzyScore(q, item.label), fuzzyScore(q, item.id), ...item.keywords.map((k) => fuzzyScore(q, k) - 50)),
    }))
    .filter((s) => s.score >= 0);
  // keep the group order, best match first inside each group
  return SLASH_GROUPS.flatMap((group) =>
    scored
      .filter((s) => s.item.group === group)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item),
  );
}

// ── Suggestion plumbing ────────────────────────────────────────────────────

export type MenuKind = "slash" | "source";

export interface MenuState {
  kind: MenuKind;
  items: Array<SlashItem | SourceRef>;
  query: string;
  rect: DOMRect | null;
  mode: PickMode;
  loading: boolean;
  command: (item: SlashItem | SourceRef) => void;
}

export interface MenuController {
  onOpen(state: MenuState): void;
  onUpdate(state: MenuState): void;
  onKeyDown(event: KeyboardEvent): boolean;
  onClose(): void;
}

function notInCode(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  return !$from.parent.type.spec.code && !editor.isActive("code");
}

export const slashPluginKey = new PluginKey("noteSlash");
export const sourcePluginKey = new PluginKey("noteSourcePicker");

export const NoteMenus = Extension.create<{ controller: MenuController | null }>({
  name: "noteMenus",

  addOptions() {
    return { controller: null };
  },

  addProseMirrorPlugins() {
    const controller = () => this.options.controller;
    const editor = this.editor;

    const slashState = (props: SuggestionProps<SlashItem, SlashItem>): MenuState => ({
      kind: "slash",
      items: props.items,
      query: props.query,
      rect: props.clientRect?.() ?? null,
      mode: "link",
      loading: false,
      command: (item) => props.command(item as SlashItem),
    });

    const sourceState = (props: SuggestionProps<SourceRef, SourceRef>): MenuState => {
      const runtime = getRuntime(editor);
      return {
        kind: "source",
        items: props.items,
        query: props.query,
        rect: props.clientRect?.() ?? null,
        mode: runtime?.pickMode ?? "link",
        loading: runtime?.lastSourceQuery !== props.query,
        command: (item) => props.command(item as SourceRef),
      };
    };

    return [
      Suggestion<SlashItem, SlashItem>({
        editor,
        pluginKey: slashPluginKey,
        char: "/",
        allow: ({ editor: e }) => notInCode(e),
        items: ({ query }) => filterSlashItems(SLASH_ITEMS, query),
        command: ({ editor: e, range, props }) => props.run(e, range),
        render: () => ({
          onStart: (props) => controller()?.onOpen(slashState(props)),
          onUpdate: (props) => controller()?.onUpdate(slashState(props)),
          onKeyDown: ({ event }) => (event.key === "Escape" ? false : (controller()?.onKeyDown(event) ?? false)),
          onExit: () => controller()?.onClose(),
        }),
      }),
      Suggestion<SourceRef, SourceRef>({
        editor,
        pluginKey: sourcePluginKey,
        char: "@",
        allowSpaces: true,
        debounce: 120,
        allow: ({ editor: e }) => notInCode(e),
        items: async ({ query }) => {
          const runtime = getRuntime(editor);
          if (!runtime) return [];
          try {
            const found = await runtime.search(query.trim(), runtime.pickMode);
            return found.slice(0, 12);
          } catch {
            return [];
          } finally {
            runtime.lastSourceQuery = query;
          }
        },
        command: ({ editor: e, range, props: ref }) => {
          const runtime = getRuntime(e);
          const mode = runtime?.pickMode ?? "link";
          if (runtime) runtime.pickMode = "link";
          insertSource(e, range, ref, mode);
        },
        render: () => ({
          onStart: (props) => controller()?.onOpen(sourceState(props)),
          onUpdate: (props) => controller()?.onUpdate(sourceState(props)),
          onKeyDown: ({ event }) => (event.key === "Escape" ? false : (controller()?.onKeyDown(event) ?? false)),
          onExit: () => {
            const runtime = getRuntime(editor);
            if (runtime) {
              runtime.pickMode = "link";
              runtime.lastSourceQuery = null;
            }
            controller()?.onClose();
          },
        }),
      }),
    ];
  },
});

function promptImageUrl(editor: Editor) {
  getRuntime(editor)?.promptUrl({
    title: "Image URL",
    placeholder: "https://…",
    submit: (src) => editor.chain().focus().setImage({ src }).run(),
  });
}

export function insertSource(editor: Editor, range: Range, ref: SourceRef, mode: PickMode) {
  const item = refItem(ref);
  // The cache holds whole sources; a highlight shares its source's id.
  if (item.kind === "source" && !item.anchor) rememberSource(ref);
  if (mode === "embed") {
    editor.chain().focus().deleteRange(range).insertContent({ type: "sourceEmbed", attrs: { id: ref.id, label: sourceLine(ref) } }).run();
    return;
  }
  if (mode === "quote") {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .setNode("sourceQuote", { source: ref.id, page: typeof ref.page === "number" ? ref.page : null })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: "text", text: mentionLabel(ref), marks: [{ type: "link", attrs: { href: itemHref(item) } }] },
      { type: "text", text: " " },
    ])
    .run();
}
