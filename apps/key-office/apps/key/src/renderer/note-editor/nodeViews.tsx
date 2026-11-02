import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { Icon } from "../icons";
import type { IconName } from "../icons";
import { parseVideoUrl, videoMeta } from "./media";
import type { VideoMeta } from "./media";
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

// ── Video embed ────────────────────────────────────────────────────────────

const PROVIDER_LABEL = { youtube: "YouTube", vimeo: "Vimeo", file: "Video" } as const;

/** Opens a web link in the user's browser (the shell hands new windows to the system). */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener");
}

export function VideoEmbedView({ node, editor, selected, updateAttributes }: ReactNodeViewProps) {
  const url = String(node.attrs.url ?? "");
  const title = String(node.attrs.title ?? "");
  const info = parseVideoUrl(url);
  const [playing, setPlaying] = useState(false);
  const [meta, setMeta] = useState<VideoMeta>({});
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    if (!info) return;
    let live = true;
    void videoMeta(info).then((found) => {
      if (!live) return;
      setMeta(found);
      // keep the title in the note, so it is searchable and shows offline
      if (found.title && !title && editor.isEditable) updateAttributes({ title: found.title });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (!info) {
    return (
      <NodeViewWrapper className={`ne-video is-broken${selected ? " is-selected" : ""}`} data-drag-handle="">
        <div className="ne-video-bar" contentEditable={false}>
          <Icon name="video" size={14} />
          <span className="ne-video-title">{url || "Video link missing"}</span>
        </div>
      </NodeViewWrapper>
    );
  }

  const shownTitle = title || meta.title || url;
  const thumbnail = thumbFailed ? undefined : (info.thumbnail ?? meta.thumbnail);
  return (
    <NodeViewWrapper className={`ne-video${selected ? " is-selected" : ""}${playing ? " is-playing" : ""}`} data-drag-handle="" data-provider={info.provider}>
      <div className="ne-video-frame" contentEditable={false}>
        {info.provider === "file" ? (
          <video className="ne-video-player" src={info.embedUrl} controls preload="metadata" />
        ) : playing ? (
          <iframe
            className="ne-video-player"
            src={info.embedUrl}
            title={shownTitle}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            className="ne-video-poster"
            aria-label={`Play ${shownTitle}`}
            title="Play here"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPlaying(true)}
          >
            {thumbnail ? <img src={thumbnail} alt="" draggable={false} onError={() => setThumbFailed(true)} /> : <Icon name="video" size={32} />}
            <span className="ne-video-play">
              <Icon name="play" size={22} />
            </span>
          </button>
        )}
      </div>
      <div className="ne-video-bar" contentEditable={false}>
        <span className="ne-video-provider">{PROVIDER_LABEL[info.provider]}</span>
        <span className="ne-video-title" title={shownTitle}>
          {shownTitle}
        </span>
        {playing && (
          <button type="button" className="ne-video-action" onMouseDown={(e) => e.preventDefault()} onClick={() => setPlaying(false)} aria-label="Stop video" title="Stop">
            <Icon name="close" size={13} />
          </button>
        )}
        <button
          type="button"
          className="ne-video-action"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openExternal(info.url)}
          aria-label={`Open in ${info.provider === "file" ? "browser" : PROVIDER_LABEL[info.provider]}`}
          title="Open in your browser"
        >
          <Icon name="external" size={13} />
        </button>
      </div>
    </NodeViewWrapper>
  );
}

// ── Image ──────────────────────────────────────────────────────────────────

const MIN_IMAGE_WIDTH = 80;

function Lightbox({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="ne-lightbox" role="dialog" aria-modal="true" aria-label={caption || "Image"} onClick={onClose}>
      <figure className="ne-lightbox-figure">
        <img src={src} alt={caption} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      <button type="button" className="ne-lightbox-close" aria-label="Close" onClick={onClose}>
        <Icon name="close" size={16} />
      </button>
    </div>,
    document.body,
  );
}

export function ImageView({ node, editor, selected, updateAttributes }: ReactNodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const caption = String(node.attrs.title ?? "");
  const alt = String(node.attrs.alt ?? "") || caption;
  const width = typeof node.attrs.width === "number" ? (node.attrs.width as number) : null;
  const url = getRuntime(editor)?.mediaUrl(src) ?? src;
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [draft, setDraft] = useState(caption);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => setFailed(false), [url]);
  useEffect(() => setDraft(caption), [caption]);
  const editable = editor.isEditable;

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, side: 1 | -1) => {
    event.preventDefault();
    event.stopPropagation();
    const frame = frameRef.current;
    const column = frame?.parentElement;
    if (!frame || !column) return;
    const startX = event.clientX;
    const startWidth = frame.getBoundingClientRect().width;
    const max = column.getBoundingClientRect().width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let next = startWidth;
    const move = (e: PointerEvent) => {
      // the image stays centred, so it grows on both sides
      next = Math.round(Math.min(max, Math.max(MIN_IMAGE_WIDTH, startWidth + side * 2 * (e.clientX - startX))));
      setDragWidth(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setDragWidth(null);
      // the full column width means "fit", which keeps the plain Markdown form
      updateAttributes({ width: next >= max - 1 ? null : next });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const commitCaption = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    if (next !== caption) updateAttributes({ title: next || null });
  };

  const shownWidth = dragWidth ?? width;
  return (
    <NodeViewWrapper as="figure" className={`ne-image${selected ? " is-selected" : ""}`} data-drag-handle="">
      <div className="ne-image-frame" ref={frameRef} contentEditable={false} style={shownWidth ? { width: shownWidth } : undefined}>
        {failed ? (
          <div className="ne-image-missing">
            <Icon name="image" size={20} />
            <span>Image not found</span>
          </div>
        ) : (
          <img src={url} alt={alt} draggable={false} onError={() => setFailed(true)} onClick={() => setZoomed(true)} title="Click to enlarge" />
        )}
        {editable && !failed && (
          <>
            <span className="ne-image-handle is-left" onPointerDown={(e) => startResize(e, -1)} aria-hidden="true" />
            <span className="ne-image-handle is-right" onPointerDown={(e) => startResize(e, 1)} aria-hidden="true" />
          </>
        )}
      </div>
      {(editable || caption) && (
        <figcaption className="ne-image-caption" contentEditable={false}>
          <input
            value={draft}
            placeholder="Add a caption"
            aria-label="Image caption"
            spellCheck
            readOnly={!editable}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitCaption}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCaption();
                editor.commands.focus();
              } else if (e.key === "Escape") {
                setDraft(caption);
                editor.commands.focus();
              }
            }}
          />
        </figcaption>
      )}
      {zoomed && <Lightbox src={url} caption={caption || alt} onClose={() => setZoomed(false)} />}
    </NodeViewWrapper>
  );
}
