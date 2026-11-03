// Adapted from https://beui.dev/components/motion/preview-rail (MIT; BEUI-LICENSE.txt).
// Key keeps the fisheye ticks and the preview card that glides between them, and
// styles them with theme tokens instead of Tailwind. It is vertical only and drops
// the touch tap-to-pin path, since the reader takes a pointer and the keyboard. It
// adds a resting length and a mark per tick, one tab stop with arrow keys, and a
// card that leans away from the rail's ends so it stays on screen.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import "./preview-rail.css";

const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export interface PreviewRailItem {
  id: string;
  label: string;
  ariaLabel?: string;
  /** Tick length at rest, as a fraction of the full tick (0.25 when left out). */
  rest?: number;
  /** A colour (any CSS colour) for a dot beside the tick, e.g. a highlight on that page. */
  mark?: string;
}

export interface PreviewRailProps {
  items: PreviewRailItem[];
  label?: string;
  /** The item the reader is in now; drawn in the accent colour. */
  activeId?: string;
  onItemSelect?: (item: PreviewRailItem) => void;
  renderPreview: (item: PreviewRailItem) => ReactNode;
  itemSize?: number;
  /** Shown under the ticks while the rail is hovered or focused. */
  footer?: ReactNode;
  className?: string;
}

// A pointer resting on the rail, not one pressing into it while dragging past.
const hovering = (event: PointerEvent) =>
  event.pointerType !== "touch" && event.buttons === 0;

export function PreviewRail({
  items,
  label = "Section navigation",
  activeId,
  onItemSelect,
  renderPreview,
  itemSize = 24,
  footer,
  className,
}: PreviewRailProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [rovingId, setRovingId] = useState<string | null>(null);

  const displayedId = hoveredId ?? focusedId ?? "";
  const highlightedId = displayedId || activeId || "";
  const displayedIndex = items.findIndex((item) => item.id === highlightedId);
  const tabId = items.some((item) => item.id === rovingId)
    ? rovingId
    : items.some((item) => item.id === activeId)
      ? activeId
      : items[0]?.id;
  const rows = items.length ? `repeat(${items.length}, ${itemSize}px)` : undefined;
  const open = displayedId !== "";

  const move = (event: KeyboardEvent, index: number) => {
    const next =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next === null || !items[next]) return;
    event.preventDefault();
    setRovingId(items[next].id);
    buttons.current.get(items[next].id)?.focus();
  };

  return (
    <motion.div
      layoutRoot
      className={`key-preview-rail${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
      }}
    >
      <nav
        aria-label={label}
        className="key-preview-rail-ticks"
        style={{ gridTemplateRows: rows }}
        onPointerLeave={() => setHoveredId(null)}
      >
        {items.map((item, index) => {
          const highlighted = item.id === highlightedId;
          const distance =
            displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex);
          const rest = item.rest ?? 0.25;
          const scale = highlighted
            ? 1
            : distance === 1
              ? Math.max(rest, 0.68)
              : distance === 2
                ? Math.max(rest, 0.44)
                : rest;
          return (
            <button
              key={item.id}
              ref={(element) => {
                if (element) buttons.current.set(item.id, element);
                else buttons.current.delete(item.id);
              }}
              type="button"
              data-slot="preview-rail-item"
              data-highlighted={highlighted || undefined}
              aria-label={item.ariaLabel ?? item.label}
              aria-current={item.id === activeId ? "location" : undefined}
              tabIndex={item.id === tabId ? 0 : -1}
              style={{ height: itemSize }}
              onPointerEnter={(event) => {
                if (hovering(event)) setHoveredId(item.id);
              }}
              onFocus={(event) => {
                setRovingId(item.id);
                if (event.currentTarget.matches(":focus-visible")) setFocusedId(item.id);
              }}
              onKeyDown={(event) => move(event, index)}
              onClick={() => onItemSelect?.(item)}
            >
              <motion.span
                aria-hidden="true"
                className="key-preview-rail-tick"
                initial={false}
                animate={{ scaleX: scale }}
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              />
              {item.mark ? (
                <span
                  aria-hidden="true"
                  className="key-preview-rail-mark"
                  style={{ "--key-rail-mark": item.mark } as CSSProperties}
                />
              ) : null}
            </button>
          );
        })}
        {footer ? <div className="key-preview-rail-footer">{footer}</div> : null}
      </nav>

      <div aria-hidden="true" className="key-preview-rail-previews" style={{ gridTemplateRows: rows }}>
        {items.map((item, index) => (
          <div
            key={item.id}
            className="key-preview-rail-slot"
            data-lean={
              items.length * itemSize < 320
                ? undefined
                : index < items.length / 3
                  ? "down"
                  : index >= (items.length * 2) / 3
                    ? "up"
                    : undefined
            }
            style={{ height: itemSize }}
          >
            {item.id === displayedId ? (
              <motion.div
                layoutId={`key-preview-rail-card-${uid}`}
                className="key-preview-rail-card"
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={item.id}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(6px)" }}
                    animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={
                      reduce
                        ? { opacity: 0 }
                        : {
                            opacity: 0,
                            y: -2,
                            filter: "blur(4px)",
                            transition: { duration: 0.12, ease: EASE_OUT },
                          }
                    }
                    transition={{ duration: reduce ? 0 : 0.18, ease: EASE_OUT }}
                  >
                    {renderPreview(item)}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            ) : null}
          </div>
        ))}
      </div>
    </motion.div>
  );
}
