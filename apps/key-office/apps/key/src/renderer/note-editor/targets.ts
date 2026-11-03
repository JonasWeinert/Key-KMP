// Editors that can take text from outside at their cursor (the sidebar's Cite button).
// Each editable NoteEditor registers itself with its root element; the shell asks for the
// one inside the focused pane, preferring the editor that last had the cursor.

export interface EditorTarget {
  root: HTMLElement;
  /** Inserts links at the cursor (or where it last was). Answers an undo, or null if nothing was inserted. */
  insertLinks: (links: { text: string; href: string }[]) => (() => void) | null;
}

const targets = new Map<EditorTarget, number>();
const listeners = new Set<() => void>();
let clock = 0;
const changed = () => listeners.forEach((listener) => listener());

export function registerEditorTarget(target: EditorTarget) {
  targets.set(target, 0);
  changed();
  return () => {
    targets.delete(target);
    changed();
  };
}
/** The editor took the cursor: it wins over other editors in the same pane. */
export function editorTargetFocused(target: EditorTarget) {
  if (targets.has(target)) targets.set(target, ++clock);
}
/** The editor inside `container` that most recently had the cursor. */
export function editorTargetIn(container: Element | null | undefined): EditorTarget | undefined {
  if (!container) return undefined;
  let best: EditorTarget | undefined;
  for (const [target, at] of targets)
    if (target.root.isConnected && container.contains(target.root) && (!best || at > targets.get(best)!)) best = target;
  return best;
}
export function onEditorTargets(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
