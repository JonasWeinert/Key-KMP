// The citation styles the sidebar's References list offers: in-text citations, a short
// narrative byline for each row, and reference list entries (APA via citation.ts).
import { apa, type CitableSource, type Creator } from "./citation";

export type CitationStyle = "apa" | "chicago" | "harvard" | "mla";
export const CITATION_STYLES: { id: CitationStyle; label: string }[] = [
  { id: "apa", label: "APA 7th Edition" },
  { id: "chicago", label: "Chicago (author-date)" },
  { id: "harvard", label: "Harvard" },
  { id: "mla", label: "MLA 9th Edition" },
];

const authorsOf = (source: CitableSource) => {
  const authors = source.creators.filter((c) => !c.role || c.role === "author");
  return authors.length ? authors : source.creators;
};
const family = (c: Creator) => c.family || c.literal || c.given || "";

/** "Kirkby et al.", "Bayer & Kuhn" (APA) or "Bayer and Kuhn". */
function who(source: CitableSource, style: CitationStyle) {
  const list = authorsOf(source).map(family).filter(Boolean);
  const and = style === "apa" ? " & " : " and ";
  if (!list.length) return source.title?.trim() || "Untitled";
  if (list.length === 1) return list[0];
  if (list.length === 2) return list.join(and);
  if (list.length === 3 && style === "chicago") return `${list[0]}, ${list[1]}, and ${list[2]}`;
  return `${list[0]} et al.`;
}
const year = (source: CitableSource) => String(source.year ?? "n.d.");

/** Kirkby et al. (2022): the byline a reference list row shows. */
export function narrativeCitation(source: CitableSource, style: CitationStyle = "apa") {
  return style === "mla" ? who(source, style) : `${who(source, style)} (${year(source)})`;
}

/** (Kirkby et al., 2022, p. 4); `page` is zero-based like the reader's pages. */
export function inTextCitationFor(source: CitableSource, style: CitationStyle = "apa", page?: number) {
  const p = page === undefined ? undefined : page + 1;
  switch (style) {
    case "chicago":
      return `(${who(source, style)} ${year(source)}${p ? `, ${p}` : ""})`;
    case "mla":
      return `(${who(source, style)}${p ? ` ${p}` : ""})`;
    default:
      return `(${who(source, style)}, ${year(source)}${p ? `, p. ${p}` : ""})`;
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const doiUrl = (doi?: string) => (doi ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : "");
const end = (text: string) => (/[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const BOOKISH = new Set(["book", "report", "thesis"]);

/** A reference list entry in `style`; `html` italicises titles and containers. */
export function referenceEntry(source: CitableSource, style: CitationStyle = "apa", html = false) {
  if (style === "apa") return apa(source, html);
  const italic = (text: string) => (html ? `<i>${escapeHtml(text)}</i>` : text);
  const plain = (text: string) => (html ? escapeHtml(text) : text);
  const people = authorsOf(source);
  const inverted = (c: Creator) => (c.literal ? c.literal : [c.family, c.given].filter(Boolean).join(", "));
  const straight = (c: Creator) => (c.literal ? c.literal : [c.given, c.family].filter(Boolean).join(" "));
  const initialled = (c: Creator) =>
    c.literal ? c.literal : [c.family, (c.given || "").split(/[\s-]+/).filter(Boolean).map((g) => `${g[0]}.`).join("")].filter(Boolean).join(", ");
  let names = "";
  if (style === "mla") names = people.length > 2 ? `${inverted(people[0])}, et al.` : people.map((c, i) => (i ? straight(c) : inverted(c))).join(", and ");
  else if (style === "harvard") names = people.length > 1 ? `${people.slice(0, -1).map(initialled).join(", ")} and ${initialled(people.at(-1)!)}` : people.map(initialled).join("");
  else names = people.length > 1 ? `${people.slice(0, -1).map((c, i) => (i ? straight(c) : inverted(c))).join(", ")}, and ${straight(people.at(-1)!)}` : people.map(inverted).join("");
  const title = source.title?.trim() || "Untitled";
  const book = BOOKISH.has(source.itemType ?? "");
  const shownTitle = book ? italic(title) : plain(style === "harvard" ? `‘${title}’` : `“${end(title)}”`);
  const container = source.containerTitle?.trim();
  const pages = source.pages?.replace(/-/g, "–");
  const link = doiUrl(source.doi) || source.url || "";
  const parts: string[] = [];
  if (style === "mla") {
    if (names) parts.push(end(plain(names)));
    parts.push(book ? end(shownTitle) : shownTitle);
    const tail = [
      container && italic(container),
      source.volume && plain(`vol. ${source.volume}`),
      source.issue && plain(`no. ${source.issue}`),
      book && source.publisher && plain(source.publisher),
      source.year !== undefined && plain(String(source.year)),
      pages && plain(`pp. ${pages}`),
    ].filter(Boolean);
    if (tail.length) parts.push(`${tail.join(", ")}.`);
  } else if (style === "harvard") {
    parts.push(`${plain(names || title)} (${plain(year(source))})`);
    const tail = [
      names ? shownTitle : "",
      container && italic(container),
      source.volume && plain(`${source.volume}${source.issue ? `(${source.issue})` : ""}`),
      pages && plain(`pp. ${pages}`),
      book && source.publisher && plain(source.publisher),
    ].filter(Boolean);
    if (tail.length) parts[0] += ` ${tail.join(", ")}.`;
    else parts[0] += ".";
  } else {
    if (names) parts.push(end(plain(names)));
    parts.push(`${plain(year(source))}.`);
    parts.push(book ? end(shownTitle) : shownTitle);
    if (container) {
      let tail = italic(container);
      if (source.volume) tail += plain(` ${source.volume}`);
      if (source.issue) tail += plain(` (${source.issue})`);
      if (pages) tail += plain(`: ${pages}`);
      parts.push(`${tail}.`);
    } else if (book && source.publisher) parts.push(end(plain(source.publisher)));
  }
  if (link) parts.push(html ? `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : style === "harvard" ? `Available at: ${link}.` : link);
  return parts.join(" ");
}
