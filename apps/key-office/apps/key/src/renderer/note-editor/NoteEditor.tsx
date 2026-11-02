import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { AnyExtension } from "@tiptap/core";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import { BlockGutter } from "./blockGutter";
import { BubbleToolbar, normalizeUrl } from "./BubbleToolbar";
import { NoteKeymap, SourceLinks } from "./behaviors";
import { NoteMenus } from "./menus";
import type { MenuController, MenuState } from "./menus";
import { CalloutView, SourceEmbedView, SourceQuoteView, ToggleView } from "./nodeViews";
import { NoteRuntimeExtension } from "./runtime";
import type { NoteRuntime, UrlPromptRequest } from "./runtime";
import { Callout, SourceEmbed, SourceQuote, Toggle, buildSchemaExtensions, serializeNote } from "./schema";
import { resolveSourceCached } from "./sourceCache";
import { SuggestionMenu, usePopoverPosition } from "./SuggestionMenu";
import type { SuggestionMenuHandle } from "./SuggestionMenu";
import type { NoteEditorProps } from "./types";
import "./note-editor.css";

const SAVE_DELAY_MS = 400;
const DEFAULT_PLACEHOLDER = "Type / for blocks, @ to link anything";

function buildEditorExtensions(runtime: NoteRuntime, controller: MenuController): AnyExtension[] {
  return [
    ...buildSchemaExtensions({
      callout: Callout.extend({ addNodeView: () => ReactNodeViewRenderer(CalloutView) }),
      toggle: Toggle.extend({ addNodeView: () => ReactNodeViewRenderer(ToggleView) }),
      sourceEmbed: SourceEmbed.extend({ addNodeView: () => ReactNodeViewRenderer(SourceEmbedView) }),
      sourceQuote: SourceQuote.extend({ addNodeView: () => ReactNodeViewRenderer(SourceQuoteView) }),
    }),
    NoteRuntimeExtension.configure({ runtime }),
    Placeholder.configure({
      includeChildren: true,
      showOnlyCurrent: true,
      placeholder: ({ node }) => {
        if (node.type.name === "heading") return `Heading ${node.attrs.level}`;
        if (node.type.name === "sourceQuote") return "Quoted passage…";
        if (node.type.name === "paragraph") return runtime.placeholder();
        return "";
      },
    }),
    NoteKeymap,
    SourceLinks,
    BlockGutter,
    NoteMenus.configure({ controller }),
  ];
}

function UrlPrompt({ request, rect, onClose }: { request: UrlPromptRequest; rect: DOMRect | null; onClose: () => void }) {
  const [value, setValue] = useState(request.initial ?? "");
  const { ref, style } = usePopoverPosition(rect, []);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose, ref]);
  const submit = () => {
    const url = normalizeUrl(value);
    onClose();
    if (url) request.submit(url);
  };
  return (
    <div ref={ref} className="ne-popover ne-url-prompt" style={style} role="dialog" aria-label={request.title}>
      <div className="ne-menu-heading">{request.title}</div>
      <div className="ne-url-row">
        <input
          ref={inputRef}
          className="ne-url-input"
          value={value}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <button type="button" className="ne-url-submit" onClick={submit} disabled={!value.trim()}>
          Insert
        </button>
      </div>
    </div>
  );
}

export default function NoteEditor(props: NoteEditorProps): JSX.Element {
  const propsRef = useRef(props);
  propsRef.current = props;

  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<SuggestionMenuHandle>(null);
  const [prompt, setPrompt] = useState<{ request: UrlPromptRequest; rect: DOMRect | null } | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const controller = useMemo<MenuController>(
    () => ({
      onOpen: (state) => setMenu(state),
      onUpdate: (state) => setMenu(state),
      onKeyDown: (event) => menuRef.current?.handleKey(event) ?? false,
      onClose: () => setMenu(null),
    }),
    [],
  );

  const runtime = useMemo<NoteRuntime>(
    () => ({
      placeholder: () => propsRef.current.placeholder ?? DEFAULT_PLACEHOLDER,
      // Links can point at anything; cards and quotes need a source.
      search: (query, mode) => (mode === "link" && propsRef.current.searchItems ? propsRef.current.searchItems(query) : propsRef.current.searchSources(query)),
      resolve: (id) => resolveSourceCached(id, (x) => propsRef.current.resolveSource(x)),
      open: (id, page) => propsRef.current.onOpenSource(id, page),
      openItem: (item) => {
        const page = item.anchor?.startsWith("page:") ? Number(item.anchor.slice(5)) : undefined;
        if (item.kind === "source" && (!item.anchor || page !== undefined)) propsRef.current.onOpenSource(item.id, page);
        else propsRef.current.onOpenItem?.(item);
      },
      promptUrl: (request) => {
        const editor = editorRef.current;
        let rect: DOMRect | null = null;
        if (editor) {
          const c = editor.view.coordsAtPos(editor.state.selection.from);
          rect = new DOMRect(c.left, c.top, 0, c.bottom - c.top);
        }
        setPrompt({ request, rect });
      },
      pickMode: "link",
      lastSourceQuery: null,
    }),
    [],
  );

  // ── saving ───────────────────────────────────────────────────────────────
  // `applied`: the last value loaded from props or emitted by us (echoes are ignored);
  // `baseline`: canonical markdown of that state, so loading a non-canonical file
  // (different table padding, trailing newline…) does not count as an edit
  const applied = useRef(props.value);
  const baseline = useRef<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const onChangeRef = useRef(props.onChange);

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const editor = editorRef.current;
    if (!dirty.current || !editor) return;
    dirty.current = false;
    let markdown: string;
    try {
      markdown = serializeNote(editor);
    } catch {
      return;
    }
    // normalisation-only transactions (e.g. the trailing paragraph) change nothing on disk
    if (markdown === baseline.current) return;
    baseline.current = markdown;
    applied.current = markdown;
    onChangeRef.current(markdown);
  }, []);

  const editor = useEditor(
    {
      extensions: buildEditorExtensions(runtime, controller),
      content: props.value,
      contentType: "markdown",
      autofocus: props.autoFocus ? "end" : false,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: "ne-prose", spellcheck: "true", "aria-label": "Note" },
      },
      onUpdate: () => {
        dirty.current = true;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
      },
      onBlur: () => flush(),
    },
    [],
  );
  editorRef.current = editor;

  // a different note loaded from outside: replace without emitting onChange
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (baseline.current === null) baseline.current = serializeNote(editor);
    if (props.value === applied.current) return;
    flush(); // pending edits go to the callback that belonged to them
    applied.current = props.value;
    editor.commands.setContent(props.value, { contentType: "markdown", emitUpdate: false });
    baseline.current = serializeNote(editor);
    setPrompt(null);
  }, [editor, props.value, flush]);

  // after the value effect, so a flush above still uses the previous callback
  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  // unmount: save what is left
  useEffect(() => () => flush(), [flush]);

  const rootClass = ["ne-root", props.compact ? "ne-root--compact" : "", props.className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={rootClass}>
      <EditorContent editor={editor} className="ne-content" />
      {editor && <BubbleToolbar editor={editor} />}
      {/* Floating menus live at the document root: the shell's panes use CSS containment, which
          would otherwise make them the frame for these fixed-position menus. */}
      {createPortal(<SuggestionMenu ref={menuRef} state={menu} />, document.body)}
      {prompt && createPortal(<UrlPrompt request={prompt.request} rect={prompt.rect} onClose={() => setPrompt(null)} />, document.body)}
    </div>
  );
}
