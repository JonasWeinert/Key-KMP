// Key adaptations of beUI's MIT primitives. See PROVENANCE.md and BEUI-LICENSE.txt.
import {
  cloneElement,
  isValidElement,
  forwardRef,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
export const motionTokens = {
  easeOut: [0.16, 1, 0.3, 1] as const,
  panel: { type: "spring", stiffness: 420, damping: 40, mass: 0.5 } as const,
  layout: { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const,
};
const cls = (base: string, extra?: string) =>
  `${base}${extra ? " " + extra : ""}`;
type Density = "compact" | "default";
export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "compact" | "default" | "large" | "icon";
  density?: Density;
  loading?: boolean;
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant,
      size,
      density,
      loading,
      disabled,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        className={cls("kui-button", className)}
        data-variant={variant}
        data-size={size || density || "compact"}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
      >
        {loading && <span className="kui-spinner" aria-hidden="true" />}
        {children}
      </button>
    );
  },
);
export const Input = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<"input"> & { density?: Density }
>(function Input({ className, density = "compact", ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={cls("kui-input", className)}
      data-density={density}
    />
  );
});
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<"textarea"> & { density?: Density }
>(function Textarea({ className, density = "default", ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={cls("kui-textarea", className)}
      data-density={density}
    />
  );
});
export const Select = forwardRef<
  HTMLSelectElement,
  ComponentPropsWithoutRef<"select"> & { density?: Density }
>(function Select({ className, density = "compact", ...props }, ref) {
  return (
    <select
      {...props}
      ref={ref}
      className={cls("kui-select", className)}
      data-density={density}
    />
  );
});
export function Surface({
  className,
  tone = "default",
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  tone?: "default" | "quiet" | "raised";
}) {
  return (
    <div
      {...props}
      className={cls("kui-surface", className)}
      data-tone={tone}
    />
  );
}
export function Badge({
  className,
  tone = "neutral",
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}) {
  return (
    <span {...props} className={cls("kui-badge", className)} data-tone={tone} />
  );
}
export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  const generated = useId(),
    hintId = generated + "-hint";
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        "aria-describedby":
          [
            children.props["aria-describedby"],
            help || error ? hintId : undefined,
          ]
            .filter(Boolean)
            .join(" ") || undefined,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })
    : children;
  return (
    <div className={cls("kui-field", className)}>
      <label htmlFor={htmlFor}>
        <span className="kui-field-label">{label}</span>
        {control}
      </label>
      {error ? (
        <span id={hintId} className="kui-field-error" role="alert">
          {error}
        </span>
      ) : help ? (
        <span id={hintId} className="kui-field-help">
          {help}
        </span>
      ) : null}
    </div>
  );
}
export function Progress({
  value,
  max = 100,
  label,
}: {
  value?: number;
  max?: number;
  label: string;
}) {
  return (
    <div className="kui-progress">
      <span>{label}</span>
      <progress aria-label={label} value={value} max={max} />
    </div>
  );
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Surface tone="quiet" className="kui-empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </Surface>
  );
}
export function Skeleton({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cls("kui-skeleton", className)}
      aria-hidden="true"
    />
  );
}
export function Disclosure({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen),
    id = useId();
  return (
    <section className="kui-disclosure">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? "⌄" : "›"}</span>
        {title}
      </Button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
export { Checkbox } from "./Checkbox";
