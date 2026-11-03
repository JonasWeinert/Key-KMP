// A page's header, as stored with the item: an emoji icon and a cover (a colour, a
// gradient or an image). Covers are document content, so their colours are fixed values
// that look the same in both themes, not chrome tokens.

export type PageCover = { kind: "color" | "gradient"; value: string } | { kind: "image"; value: string; position?: number };
export interface PageAppearance {
  icon?: string;
  cover?: PageCover;
}

export const COVER_COLORS: [name: string, value: string][] = [
  ["Sand", "#e9dcc4"],
  ["Clay", "#e4b89c"],
  ["Rose", "#efc6cc"],
  ["Lilac", "#d6ccec"],
  ["Sky", "#bcd6ee"],
  ["Sage", "#c6dcc4"],
  ["Olive", "#b8b48a"],
  ["Slate", "#8a96a6"],
  ["Ink", "#2f3440"],
];

export const COVER_GRADIENTS: [name: string, value: string][] = [
  ["Dawn", "linear-gradient(120deg, #f6d5b8 0%, #efb4c0 55%, #c9b6ec 100%)"],
  ["Lagoon", "linear-gradient(120deg, #a8e0d2 0%, #8cc2ea 100%)"],
  ["Meadow", "linear-gradient(120deg, #e6efb4 0%, #9fd0a4 100%)"],
  ["Ember", "linear-gradient(120deg, #f8c66d 0%, #e9775a 100%)"],
  ["Dusk", "linear-gradient(120deg, #4a4f86 0%, #b86e9a 100%)"],
  ["Paper", "linear-gradient(180deg, #f3eee4 0%, #e3dac8 100%)"],
];

export const PAGE_ICONS = [
  "📄", "📝", "📚", "📖", "🔖", "📌", "🧠", "💡", "🔬", "🧪", "📊", "📈",
  "🗂️", "🗃️", "🧭", "🗺️", "🎯", "✅", "⭐", "🔥", "🌱", "🌿", "🌍", "🏛️",
  "⚖️", "🩺", "💬", "❓", "❗", "🧩", "🛠️", "🎓", "✏️", "🖋️", "📎", "🗓️",
];

/** Reads an appearance from stored JSON, dropping anything malformed. */
export function readAppearance(value: unknown): PageAppearance {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: PageAppearance = {};
  if (typeof raw.icon === "string" && raw.icon) out.icon = raw.icon;
  const cover = raw.cover as Record<string, unknown> | undefined;
  if (cover && typeof cover.value === "string" && ["color", "gradient", "image"].includes(cover.kind as string))
    out.cover = { kind: cover.kind as PageCover["kind"], value: cover.value, ...(typeof cover.position === "number" ? { position: cover.position } : {}) } as PageCover;
  return out;
}

/** The CSS background for a cover; `url` turns stored media paths into loadable URLs. */
export function coverBackground(cover: PageCover | undefined, url: (src: string) => string = (src) => src): string | undefined {
  if (!cover) return undefined;
  if (cover.kind === "image") return `center ${cover.position ?? 50}% / cover no-repeat url("${url(cover.value).replace(/"/g, "%22")}")`;
  return cover.value;
}

/** One colour standing for the cover, for compact views such as canvas cards. */
export function coverTint(cover: PageCover | undefined): string | undefined {
  if (!cover || cover.kind === "image") return undefined;
  if (cover.kind === "color") return cover.value;
  return cover.value.match(/#[0-9a-f]{3,8}/i)?.[0];
}
