import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Icon } from "../icons";

type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "quote";
const BLOCK_LABEL: Record<BlockKind, string> = { paragraph: "Text", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", quote: "Quote" };
const BLOCK_ORDER: BlockKind[] = ["paragraph", "h1", "h2", "h3", "quote"];

function currentBlock(editor: Editor): BlockKind {
  if (editor.isActive("heading", { level: 1 })) return "h1";
  if (editor.isActive("heading", { level: 2 })) return "h2";
  if (editor.isActive("heading", { level: 3 })) return "h3";
  if (editor.isActive("blockquote")) return "quote";
  return "paragraph";
}

function turnInto(editor: Editor, kind: BlockKind) {
  const chain = editor.chain().focus();
  if (kind !== "quote" && editor.isActive("blockquote")) chain.lift("blockquote");
  if (kind === "paragraph") chain.setParagraph();
  else if (kind === "quote") {
    if (!editor.isActive("blockquote")) chain.setParagraph().setBlockquote();
  } else chain.setHeading({ level: kind === "h1" ? 1 : kind === "h2" ? 2 : 3 });
  chain.run();
}

/** Accepts bare domains ("example.org") and keeps known schemes as typed. */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/") || url.startsWith("#")) return url;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`;
  return `https://${url}`;
}

function ToolButton(props: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`ne-tool${props.active ? " is-active" : ""}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function BubbleToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      block: currentBlock(e),
      from: e.state.selection.from,
      to: e.state.selection.to,
    }),
  });

  // a new selection closes the sub-panels
  useEffect(() => {
    setLinkOpen(false);
    setBlockOpen(false);
  }, [state.from, state.to]);

  useEffect(() => {
    if (linkOpen) inputRef.current?.focus();
  }, [linkOpen]);

  const applyLink = () => {
    const url = normalizeUrl(href);
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinkOpen(false);
  };

  return (
    <BubbleMenu
      editor={editor}
      className="ne-bubble"
      options={{ placement: "top", offset: 8, flip: true, shift: { padding: 8 } }}
      shouldShow={({ editor: e, state: s, from, to }) => {
        if (!e.isEditable || from === to) return false;
        if (s.selection instanceof NodeSelection) return false;
        if (e.isActive("codeBlock")) return false;
        return s.doc.textBetween(from, to, " ").trim().length > 0;
      }}
    >
      {linkOpen ? (
        <div className="ne-bubble-link">
          <Icon name="link" size={14} />
          <input
            ref={inputRef}
            className="ne-bubble-input"
            value={href}
            placeholder="Paste or type a link…"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkOpen(false);
                editor.commands.focus();
              }
            }}
          />
          {state.link && (
            <ToolButton
              label="Remove link"
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setLinkOpen(false);
              }}
            >
              <Icon name="close" size={14} />
            </ToolButton>
          )}
          <ToolButton label="Apply link" onClick={applyLink}>
            <Icon name="check" size={14} />
          </ToolButton>
        </div>
      ) : (
        <div className="ne-bubble-row">
          <div className="ne-bubble-block">
            <button
              type="button"
              className="ne-tool ne-tool-text"
              aria-haspopup="menu"
              aria-expanded={blockOpen}
              title="Turn into"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBlockOpen((v) => !v)}
            >
              {BLOCK_LABEL[state.block]}
              <Icon name="chevronDown" size={12} />
            </button>
            {blockOpen && (
              <div className="ne-popover ne-block-menu" role="menu">
                <div className="ne-menu-heading">Turn into</div>
                {BLOCK_ORDER.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitemradio"
                    aria-checked={kind === state.block}
                    className={`ne-menu-row${kind === state.block ? " is-active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      turnInto(editor, kind);
                      setBlockOpen(false);
                    }}
                  >
                    <span>{BLOCK_LABEL[kind]}</span>
                    {kind === state.block && <Icon name="check" size={14} className="ne-menu-check" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="ne-bubble-sep" />
          <ToolButton label="Bold (⌘B)" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <b>B</b>
          </ToolButton>
          <ToolButton label="Italic (⌘I)" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <i className="ne-glyph-italic">I</i>
          </ToolButton>
          <ToolButton label="Strikethrough (⌘⇧S)" active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <s>S</s>
          </ToolButton>
          <ToolButton label="Inline code (⌘E)" active={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <span className="ne-glyph-code">{"</>"}</span>
          </ToolButton>
          <ToolButton
            label="Link"
            active={state.link}
            onClick={() => {
              setHref(state.href);
              setLinkOpen(true);
            }}
          >
            <Icon name="link" size={14} />
          </ToolButton>
        </div>
      )}
    </BubbleMenu>
  );
}
