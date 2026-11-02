// Canvas colour tables (CLAUDE.md rules 4 and 5).
//
// Content: a canvas stores colour *keys* ("blue"), never hex, so the document is the
// same in both themes. Each key shows as a theme-keyed display value, like a dark page:
// a display-time remap only.
//
// Chrome: the editing affordances (selection, guides, handles, marquee, connector
// preview) read from CHROME, which points at the app's semantic tokens.
export type Theme = "light" | "dark";

export const CONTENT_COLORS = ["ink", "gray", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export type ContentColor = (typeof CONTENT_COLORS)[number];

const CONTENT: Record<ContentColor, Record<Theme, string>> = {
  ink: { light: "#1f2328", dark: "#e6e8eb" },
  gray: { light: "#8a9099", dark: "#9aa1ab" },
  red: { light: "#d93a3a", dark: "#ff6b6b" },
  orange: { light: "#e8780c", dark: "#ff9f43" },
  yellow: { light: "#d4a20a", dark: "#ffd43b" },
  green: { light: "#2f9e44", dark: "#51cf66" },
  blue: { light: "#1c7ed6", dark: "#4dabf7" },
  purple: { light: "#7048e8", dark: "#9775fa" },
};

/** Highlight colours as the reader stores them, for highlight cards. */
const HIGHLIGHT: Record<string, Record<Theme, string>> = {
  yellow: { light: "#ffd43b", dark: "#c9a227" },
  orange: { light: "#ffa94d", dark: "#d9822b" },
  green: { light: "#8ce99a", dark: "#4caf63" },
  blue: { light: "#74c0fc", dark: "#3d8fd1" },
  pink: { light: "#f783ac", dark: "#c85a85" },
  purple: { light: "#b197fc", dark: "#8268d6" },
  red: { light: "#ff8787", dark: "#d45c5c" },
};

export const CHROME = {
  selection: "var(--kx-accent)",
  selectionFill: "var(--kx-accent-soft)",
  guide: "var(--kx-red)",
  handle: "var(--kx-bg-raised)",
  connectorPreview: "var(--kx-accent)",
  grid: "var(--kx-line)",
} as const;

export function contentColor(key: string | undefined, theme: Theme): string {
  return (CONTENT[key as ContentColor] ?? CONTENT.ink)[theme];
}

export function highlightColor(key: string | undefined, theme: Theme): string {
  return (HIGHLIGHT[key ?? ""] ?? HIGHLIGHT.yellow)[theme];
}

/** The theme the shell is showing: an explicit choice, else the system's. */
export function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "dark" || chosen === "light") return chosen;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
