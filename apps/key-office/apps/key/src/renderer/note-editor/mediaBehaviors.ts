// Getting media into a note: pasted or dropped image files are stored in the workspace,
// a video link pasted or typed on a line of its own becomes an embed, and items dragged
// in from elsewhere in the app become links where they land.
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { getRuntime } from "./runtime";
import { imageFiles, parseVideoUrl } from "./media";
import { itemHref, readItemDrag, type DraggedItem } from "./types";

/** Links to dragged items, comma-separated, at `pos` (moved to the end of a word it would split). */
function insertItemLinks(editor: Editor, items: DraggedItem[], pos: number): boolean {
  const { doc } = editor.state;
  const word = /[\p{L}\p{N}]/u;
  const charAt = (at: number) => (at > 0 && at < doc.content.size ? doc.textBetween(at, at + 1, "\n", "\n") : "");
  while (word.test(charAt(pos - 1)) && word.test(charAt(pos))) pos++;
  const before = charAt(pos - 1);
  const label = (title: string) => (title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title || "Untitled");
  const content = items.flatMap((item, i) => [
    ...(i ? [{ type: "text", text: ", " }] : []),
    { type: "text", text: label(item.title), marks: [{ type: "link", attrs: { href: itemHref(item) } }] },
  ]);
  const lead = before && !/\s/.test(before) ? [{ type: "text", text: " " }] : [];
  const trail = /\s/.test(charAt(pos)) ? [] : [{ type: "text", text: " " }];
  return editor.chain().focus().insertContentAt(pos, [...lead, ...content, ...trail]).run();
}

/** The selection sits in an empty top-level-ish paragraph a block can replace. */
function inEmptyParagraph(state: EditorState): boolean {
  const { $from, empty } = state.selection;
  return empty && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
}

/** Replaces the paragraph at the cursor with a video embed, leaving the cursor after it. */
export function insertVideo(editor: Editor, url: string): boolean {
  if (!parseVideoUrl(url)) return false;
  const { $from } = editor.state.selection;
  const paragraph = $from.parent.type.name === "paragraph" ? { from: $from.before(), to: $from.after() } : null;
  const chain = editor.chain().focus();
  const content = [{ type: "videoEmbed", attrs: { url, title: "" } }, { type: "paragraph" }];
  if (paragraph && !$from.parent.textContent.replace(url, "").trim()) chain.insertContentAt(paragraph, content);
  else chain.insertContent(content);
  return chain.run();
}

/** Stores the files and inserts them as images at `pos` (or the selection), in order. */
export async function insertImageFiles(editor: Editor, files: File[], pos?: number): Promise<void> {
  const save = getRuntime(editor)?.saveImage;
  if (!save || files.length === 0) return;
  const images: Array<{ type: string; attrs: Record<string, unknown> }> = [];
  for (const file of files) {
    try {
      images.push({ type: "image", attrs: { src: await save(file), alt: null, title: null, width: null } });
    } catch (error) {
      console.warn("Key couldn't store the image", error);
    }
  }
  if (images.length === 0 || editor.isDestroyed) return;
  const at = pos === undefined ? null : Math.min(pos, editor.state.doc.content.size);
  const chain = editor.chain().focus();
  if (at !== null) chain.insertContentAt(at, images);
  else if (inEmptyParagraph(editor.state)) {
    const { $from } = editor.state.selection;
    chain.insertContentAt({ from: $from.before(), to: $from.after() }, [...images, { type: "paragraph" }]);
  } else chain.insertContent(images);
  chain.run();
}

/** Opens the system file picker for images. */
export function pickImageFiles(editor: Editor): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = () => void insertImageFiles(editor, Array.from(input.files ?? []));
  input.click();
}

const mediaPasteKey = new PluginKey("noteMediaPaste");

export const NoteMedia = Extension.create({
  name: "noteMedia",
  // before the link extension's paste handler turns a pasted video link into a link
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      // a paragraph holding nothing but a video link becomes an embed on Enter
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return false;
        const text = $from.parent.textContent.trim();
        return text.length > 0 && parseVideoUrl(text) !== null && insertVideo(editor, text);
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: mediaPasteKey,
        props: {
          handlePaste: (view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (files.length && getRuntime(editor)?.saveImage) {
              event.preventDefault();
              void insertImageFiles(editor, files);
              return true;
            }
            const text = event.clipboardData?.getData("text/plain").trim() ?? "";
            if (text && !view.state.selection.$from.parent.type.spec.code && inEmptyParagraph(view.state) && parseVideoUrl(text)) {
              event.preventDefault();
              return insertVideo(editor, text);
            }
            return false;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved) return false;
            const items = readItemDrag(event.dataTransfer);
            if (items.length) {
              event.preventDefault();
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              return insertItemLinks(editor, items, at?.pos ?? view.state.selection.from);
            }
            const files = imageFiles(event.dataTransfer?.files);
            if (!files.length || !getRuntime(editor)?.saveImage) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            void insertImageFiles(editor, files, at?.pos);
            return true;
          },
        },
      }),
    ];
  },
});
