import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Notion-style gutter for the hovered top-level block: "+" inserts an empty
 * paragraph below and opens the slash menu; the grip drags the block (it hands
 * a NodeSelection to ProseMirror's own drag-and-drop) or selects it on click.
 */
export const BlockGutter = Extension.create({
  name: "noteBlockGutter",

  addProseMirrorPlugins() {
    return [gutterPlugin(this.editor)];
  },
});

const GRIP_SVG =
  '<svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">' +
  '<circle cx="2.5" cy="2.5" r="1.3" fill="currentColor"/><circle cx="7.5" cy="2.5" r="1.3" fill="currentColor"/>' +
  '<circle cx="2.5" cy="7" r="1.3" fill="currentColor"/><circle cx="7.5" cy="7" r="1.3" fill="currentColor"/>' +
  '<circle cx="2.5" cy="11.5" r="1.3" fill="currentColor"/><circle cx="7.5" cy="11.5" r="1.3" fill="currentColor"/>' +
  "</svg>";

const PLUS_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

function topLevelPosAt(view: EditorView, coords: { left: number; top: number }): number | null {
  const found = view.posAtCoords(coords);
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  if ($pos.depth === 0 && found.inside >= 0) return found.inside;
  return $pos.depth > 0 ? $pos.before(1) : null;
}

function gutterPlugin(editor: Editor): Plugin {
  return new Plugin({
    key: new PluginKey("noteBlockGutter"),
    view(view) {
      const container = view.dom.parentElement;

      const gutter = document.createElement("div");
      gutter.className = "ne-gutter";
      gutter.style.display = "none";
      gutter.setAttribute("contenteditable", "false");

      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "ne-gutter-btn";
      plus.innerHTML = PLUS_SVG;
      plus.title = "Click to add a block below";
      plus.setAttribute("aria-label", "Add block below");

      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "ne-gutter-btn ne-gutter-grip";
      grip.draggable = true;
      grip.innerHTML = GRIP_SVG;
      grip.title = "Drag to move";
      grip.setAttribute("aria-label", "Drag to move block");

      gutter.append(plus, grip);
      container?.append(gutter);

      let hoverPos: number | null = null;
      let hideTimer: number | null = null;

      const hide = () => {
        gutter.style.display = "none";
        hoverPos = null;
      };
      const cancelHide = () => {
        if (hideTimer !== null) window.clearTimeout(hideTimer);
        hideTimer = null;
      };
      const scheduleHide = () => {
        cancelHide();
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          hide();
        }, 220);
      };

      const onMouseMove = (event: MouseEvent) => {
        if (!view.editable || !container) return;
        cancelHide();
        const pos = topLevelPosAt(view, { left: event.clientX, top: event.clientY });
        if (pos === null) return;
        const dom = view.nodeDOM(pos);
        if (!(dom instanceof HTMLElement)) return hide();
        const blockRect = dom.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const scale = container.offsetWidth ? containerRect.width / container.offsetWidth : 1;
        // line up with the first line of text rather than the block's top edge
        const style = window.getComputedStyle(dom);
        const lineHeight = Number.parseFloat(style.lineHeight) || 24;
        const paddingTop = Number.parseFloat(style.paddingTop) || 0;
        const firstLine = Math.min(lineHeight, blockRect.height / scale);
        hoverPos = pos;
        gutter.style.display = "flex";
        // In a narrow gutter only the grip fits; "/" still inserts blocks.
        plus.hidden = false;
        const room = (blockRect.left - containerRect.left) / scale;
        if (gutter.offsetWidth + 4 > room) plus.hidden = true;
        const gutterHeight = gutter.offsetHeight || 24;
        const top = (blockRect.top - containerRect.top) / scale + container.scrollTop + paddingTop + (firstLine - gutterHeight) / 2;
        gutter.style.top = `${Math.max(0, top)}px`;
        const left = (blockRect.left - containerRect.left) / scale - gutter.offsetWidth - 4;
        gutter.style.left = `${Math.max(0, left)}px`;
      };

      const selectHovered = (): NodeSelection | null => {
        if (hoverPos === null || hoverPos >= view.state.doc.content.size) return null;
        if (!view.state.doc.nodeAt(hoverPos)) return null;
        try {
          return NodeSelection.create(view.state.doc, hoverPos);
        } catch {
          return null;
        }
      };

      const onDragStart = (event: DragEvent) => {
        if (!event.dataTransfer) return;
        const selection = selectHovered();
        if (!selection) return event.preventDefault();
        view.dispatch(view.state.tr.setSelection(selection));
        view.dragging = { slice: selection.content(), move: true };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", " ");
        const dom = view.nodeDOM(selection.from);
        if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
      };

      const onDragEnd = () => hide();

      const onGripClick = () => {
        const selection = selectHovered();
        if (!selection) return;
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
      };

      const onPlusClick = () => {
        const selection = selectHovered();
        if (!selection) return;
        const after = selection.to;
        const paragraph = editor.schema.nodes.paragraph.create();
        let tr = view.state.tr.insert(after, paragraph);
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
        view.dispatch(tr);
        view.focus();
        editor.commands.insertContent("/");
      };

      const keepFocus = (event: MouseEvent) => event.preventDefault();
      const stop = (event: MouseEvent) => event.stopPropagation();

      view.dom.addEventListener("mousemove", onMouseMove);
      view.dom.addEventListener("mouseleave", scheduleHide);
      gutter.addEventListener("mousemove", stop);
      gutter.addEventListener("mouseenter", cancelHide);
      gutter.addEventListener("mouseleave", scheduleHide);
      plus.addEventListener("mousedown", keepFocus);
      plus.addEventListener("click", onPlusClick);
      grip.addEventListener("dragstart", onDragStart);
      grip.addEventListener("dragend", onDragEnd);
      grip.addEventListener("click", onGripClick);

      return {
        update(_view, prev) {
          if (!prev.doc.eq(view.state.doc) && hoverPos !== null && hoverPos >= view.state.doc.content.size) hide();
        },
        destroy() {
          cancelHide();
          view.dom.removeEventListener("mousemove", onMouseMove);
          view.dom.removeEventListener("mouseleave", scheduleHide);
          gutter.removeEventListener("mousemove", stop);
          gutter.removeEventListener("mouseenter", cancelHide);
          gutter.removeEventListener("mouseleave", scheduleHide);
          plus.removeEventListener("mousedown", keepFocus);
          plus.removeEventListener("click", onPlusClick);
          grip.removeEventListener("dragstart", onDragStart);
          grip.removeEventListener("dragend", onDragEnd);
          grip.removeEventListener("click", onGripClick);
          gutter.remove();
        },
      };
    },
  });
}
