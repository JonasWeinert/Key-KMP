// Adapted from beUI Checkbox (MIT; BEUI-LICENSE.txt).
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  const reduce = useReducedMotion(),
    show = checked || indeterminate;
  return (
    <motion.button
      type="button"
      role="checkbox"
      className="key-motion-checkbox"
      aria-label={label}
      aria-checked={indeterminate ? "mixed" : checked}
      data-state={show ? "checked" : "unchecked"}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      whileTap={reduce ? undefined : { scale: 0.92 }}
      transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.6 }}
    >
      <AnimatePresence initial={false}>
        {show && (
          <motion.svg
            key={indeterminate ? "mixed" : "checked"}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduce ? false : { opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            aria-hidden="true"
          >
            <motion.path
              d={indeterminate ? "M6 12h12" : "M5 13l4 4L19 7"}
              initial={reduce ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: reduce ? 0 : 0.3 }}
            />
          </motion.svg>
        )}
      </AnimatePresence>
    </motion.button>
  );
}
