import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { getRuntime } from "./runtime";
import { peekSource, sourceLine, subscribeSources } from "./sourceCache";
import { itemFromHref } from "./types";
import type { ItemLink } from "./types";

const CONTAINERS = new Set(["callout", "toggle"]);

/** Notion-like Enter/Backspace behaviour for callouts, toggles and source quotes. */
export const NoteKeymap = Extension.create({
  name: "noteKeymap",

  addKeyboardShortcuts() {
    return {
      // Enter on an empty last line inside a callout/toggle leaves the container
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.depth < 2) return false;
        const parent = $from.parent;
        if (parent.type.name !== "paragraph" || parent.content.size > 0) return false;
        const container = $from.node($from.depth - 1);
        if (!CONTAINERS.has(container.type.name)) return false;
        if ($from.index($from.depth - 1) !== container.childCount - 1 || container.childCount < 2) return false;
        return editor.commands.liftEmptyBlock();
      },
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        // a source quote turns back into a paragraph
        if ($from.parent.type.name === "sourceQuote") return editor.commands.setParagraph();
        if ($from.depth < 2) return false;
        const container = $from.node($from.depth - 1);
        if (!CONTAINERS.has(container.type.name) || $from.index($from.depth - 1) !== 0) return false;
        return editor.commands.lift(container.type.name);
      },
    };
  },
});

const sourceLinkKey = new PluginKey<DecorationSet>("noteSourceLinks");

const OPEN_TITLE: Record<ItemLink["kind"], string> = { source: "Open source", note: "Open note", canvas: "Open canvas", record: "Open page", file: "Open file" };

function linkRanges(doc: PMNode): Array<{ from: number; to: number; item: ItemLink }> {
  const ranges: Array<{ from: number; to: number; item: ItemLink }> = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "link") continue;
      const item = itemFromHref(mark.attrs.href);
      if (item) ranges.push({ from: pos, to: pos + node.nodeSize, item });
    }
  });
  return ranges;
}

/** Whole-source mentions, whose sources are looked up for their tooltips. */
function sourceLinkRanges(doc: PMNode) {
  return linkRanges(doc).flatMap(({ item }) => (item.kind === "source" && !item.anchor ? [{ id: item.id }] : []));
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations = linkRanges(doc).map(({ from, to, item }) => {
    if (item.kind !== "source" || item.anchor) {
      return Decoration.inline(from, to, { class: "ne-mention-text", "data-item": item.kind, title: item.anchor?.startsWith("highlight:") ? "Open highlight" : OPEN_TITLE[item.kind] });
    }
    const ref = peekSource(item.id);
    return Decoration.inline(from, to, {
      class: `ne-mention-text${ref === null ? " is-missing" : ""}`,
      title: ref ? sourceLine(ref) : ref === null ? "Source not found" : "Open source",
    });
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Item links (`[label](key://<kind>/<id>#<anchor>)`): tooltip with the resolved
 * source, and a plain click opens the item. Other links open on Cmd/Ctrl-click.
 */
export const SourceLinks = Extension.create({
  name: "noteSourceLinks",

  addProseMirrorPlugins() {
    const editor: Editor = this.editor;
    return [
      new Plugin<DecorationSet>({
        key: sourceLinkKey,
        state: {
          init: (_config, state) => buildDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(sourceLinkKey) ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations: (state) => sourceLinkKey.getState(state),
          handleDOMEvents: {
            click: (_view, event) => {
              const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
              if (!anchor) return false;
              event.preventDefault();
              const href = anchor.getAttribute("href") ?? "";
              const item = itemFromHref(href);
              if (item) {
                getRuntime(editor)?.openItem(item);
                return true;
              }
              if ((event.metaKey || event.ctrlKey) && /^(https?:|mailto:)/i.test(href)) {
                window.open(href, "_blank", "noopener");
                return true;
              }
              return false;
            },
          },
        },
        view: (view) => {
          const resolveVisible = () => {
            const runtime = getRuntime(editor);
            if (!runtime) return;
            for (const { id } of sourceLinkRanges(view.state.doc)) {
              if (peekSource(id) === undefined) void runtime.resolve(id);
            }
          };
          resolveVisible();
          const unsubscribe = subscribeSources(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(sourceLinkKey, true));
          });
          return {
            update: (_v, prev) => {
              if (!prev.doc.eq(view.state.doc)) resolveVisible();
            },
            destroy: unsubscribe,
          };
        },
      }),
    ];
  },
});
