import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { Icon } from "../icons";
import type { IconName } from "../icons";
import { getRuntime } from "./runtime";
import { peekSource, subscribeSources } from "./sourceCache";
import { CALLOUT_TONES } from "./types";
import type { CalloutTone, SourceRef } from "./types";

function useSource(editor: Editor, id: string): SourceRef | null | undefined {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeSources(bump), []);
  useEffect(() => {
    if (id) void getRuntime(editor)?.resolve(id);
  }, [editor, id]);
  return id ? peekSource(id) : null;
}

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, ref]);
}

// ── Callout ────────────────────────────────────────────────────────────────

const TONE_LABEL: Record<CalloutTone, string> = { info: "Info", tip: "Tip", warning: "Warning", note: "Note" };

const WarningGlyph = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2.4 14.2 13H1.8ZM8 6.6v3M8 11.4h.01" />
  </svg>
);

export function ToneIcon({ tone, size = 16 }: { tone: CalloutTone; size?: number }): ReactNode {
  if (tone === "warning") return <WarningGlyph size={size} />;
  const name: IconName = tone === "tip" ? "sparkle" : tone === "note" ? "note" : "info";
  return <Icon name={name} size={size} />;
}

export function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const tone = (CALLOUT_TONES.includes(node.attrs.tone) ? node.attrs.tone : "info") as CalloutTone;
  const [menuOpen, setMenuOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const close = () => setMenuOpen(false);
  useDismiss(menuOpen, close, boxRef);
  return (
    <NodeViewWrapper className={`ne-callout ne-tone-${tone}`} data-tone={tone}>
      <div className="ne-callout-side" contentEditable={false} ref={boxRef}>
        <button
          type="button"
          className="ne-callout-icon"
          title="Change callout style"
          aria-label="Change callout style"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!editor.isEditable}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <ToneIcon tone={tone} />
        </button>
        {menuOpen && (
          <div className="ne-popover ne-tone-menu" role="menu">
            {CALLOUT_TONES.map((t) => (
              <button
                key={t}
                type="button"
                role="menuitemradio"
                aria-checked={t === tone}
                className={`ne-menu-row ne-tone-${t}${t === tone ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  updateAttributes({ tone: t });
                  close();
                }}
              >
                <span className="ne-tone-swatch">
                  <ToneIcon tone={t} size={14} />
                </span>
                <span>{TONE_LABEL[t]}</span>
                {t === tone && <Icon name="check" size={14} className="ne-menu-check" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <NodeViewContent className="ne-callout-body" />
    </NodeViewWrapper>
  );
}

// ── Toggle ─────────────────────────────────────────────────────────────────

export function ToggleView({ node, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  // collapsed by default when loaded; a freshly inserted (empty) toggle starts open
  const [open, setOpen] = useState(() => node.childCount === 1 && node.firstChild?.content.size === 0);
  const title = String(node.attrs.title ?? "");
  const focusBody = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    setOpen(true);
    editor.chain().focus(pos + 2).run();
  };
  return (
    <NodeViewWrapper className={`ne-toggle${open ? " is-open" : ""}`}>
      <div className="ne-toggle-head" contentEditable={false}>
        <button
          type="button"
          className="ne-toggle-chevron"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <input
          className="ne-toggle-title"
          value={title}
          placeholder="Toggle"
          spellCheck
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              focusBody();
            }
          }}
        />
      </div>
      <NodeViewContent className="ne-toggle-body" />
    </NodeViewWrapper>
  );
}

// ── Source embed ───────────────────────────────────────────────────────────

function kindIcon(kind?: string): IconName {
  switch ((kind ?? "").toLowerCase()) {
    case "book":
      return "book";
    case "web":
    case "webpage":
    case "website":
      return "globe";
    case "video":
      return "video";
    case "audio":
    case "podcast":
      return "audio";
    case "image":
      return "image";
    default:
      return "doc";
  }
}

export function SourceEmbedView({ node, editor, selected }: ReactNodeViewProps) {
  const id = String(node.attrs.id ?? "");
  const ref = useSource(editor, id);
  const fallback = String(node.attrs.label || "") || id;
  const open = () => getRuntime(editor)?.open(id);
  return (
    <NodeViewWrapper className={`ne-source-card${selected ? " is-selected" : ""}`} data-drag-handle="">
      <div
        className="ne-source-card-inner"
        contentEditable={false}
        role="button"
        tabIndex={-1}
        onDoubleClick={open}
        title="Open source"
      >
        <span className="ne-source-card-icon">
          <Icon name={kindIcon(ref?.kind)} size={18} />
        </span>
        <span className="ne-source-card-text">
          <span className="ne-source-card-title">{ref ? ref.title : fallback}</span>
          {ref?.detail ? (
            <span className="ne-source-card-detail">{ref.detail}</span>
          ) : ref === null ? (
            <span className="ne-source-card-detail is-missing">Source not found in the library</span>
          ) : null}
        </span>
        <button
          type="button"
          className="ne-source-card-open"
          onMouseDown={(e) => e.preventDefault()}
          onClick={open}
          aria-label="Open source"
        >
          <Icon name="external" size={14} />
        </button>
      </div>
    </NodeViewWrapper>
  );
}

// ── Source quote ───────────────────────────────────────────────────────────

export function SourceQuoteView({ node, editor }: ReactNodeViewProps) {
  const id = String(node.attrs.source ?? "");
  const page = typeof node.attrs.page === "number" ? (node.attrs.page as number) : null;
  const ref = useSource(editor, id);
  const parts: string[] = [];
  if (ref?.detail) parts.push(ref.detail);
  if (ref?.title) parts.push(ref.title);
  if (!ref) parts.push(ref === null ? "Unknown source" : "Loading source…");
  if (page !== null) parts.push(`p. ${page + 1}`);
  return (
    <NodeViewWrapper as="figure" className="ne-squote" data-color={node.attrs.color || undefined}>
      <NodeViewContent<"blockquote"> as="blockquote" className="ne-squote-text" />
      <figcaption className="ne-squote-cite" contentEditable={false}>
        <button
          type="button"
          className="ne-squote-link"
          title="Open source"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => getRuntime(editor)?.open(id, page ?? undefined)}
        >
          <Icon name="quote" size={12} />
          <span>{parts.join(" · ")}</span>
        </button>
      </figcaption>
    </NodeViewWrapper>
  );
}
