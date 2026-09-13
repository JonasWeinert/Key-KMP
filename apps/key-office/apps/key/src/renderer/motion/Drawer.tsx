// Adapted from https://beui.dev/components/motion/drawer (MIT; BEUI-LICENSE.txt).
// Key adds a chrome inset, focus containment, and native overlay lifecycle callbacks.
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
function Panel({
  children,
  presentation,
  label,
}: {
  children: ReactNode;
  presentation: "drawer" | "dialog";
  label: string;
}) {
  const present = useIsPresent(),
    reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (present)
      ref.current
        ?.querySelector<HTMLElement>(
          "button:not(:disabled),input:not(:disabled)",
        )
        ?.focus();
  }, [present]);
  return (
    <motion.aside
      ref={ref}
      className={`key-global-drawer key-ui-root ${presentation === "dialog" ? "key-global-dialog" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      inert={!present}
      initial={
        presentation === "dialog"
          ? { opacity: 0, y: reduce ? 0 : 12 }
          : reduce
            ? { opacity: 0 }
            : { x: "-100%" }
      }
      animate={
        presentation === "dialog"
          ? { opacity: 1, y: 0 }
          : reduce
            ? { opacity: 1 }
            : { x: 0 }
      }
      exit={
        presentation === "dialog"
          ? { opacity: 0, y: reduce ? 0 : 8 }
          : reduce
            ? { opacity: 0 }
            : { x: "-100%" }
      }
      transition={reduce ? { duration: 0.2, ease: EASE_OUT } : SPRING_PANEL}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ) || [],
        ).filter((el) => el.getClientRects().length && !el.closest("[inert]"));
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
    >
      {children}
    </motion.aside>
  );
}
export function Drawer({
  open,
  onClose,
  onExitComplete,
  children,
  presentation = "drawer",
  label = "Property details",
}: {
  presentation?: "drawer" | "dialog";
  label?: string;
  open: boolean;
  onClose: () => void;
  onExitComplete: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", key);
    };
  }, [open, onClose]);
  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {open && (
        <motion.button
          key="scrim"
          className="key-global-drawer-scrim"
          aria-label="Close property drawer"
          tabIndex={-1}
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
        />
      )}
      {open && (
        <Panel key="panel" presentation={presentation} label={label}>
          {children}
        </Panel>
      )}
    </AnimatePresence>
  );
}
