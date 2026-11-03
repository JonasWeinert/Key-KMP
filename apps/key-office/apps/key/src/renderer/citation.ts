// Citation output for workspace-library sources: APA 7 (text and HTML) and BibTeX.
export interface Creator {
  family?: string;
  given?: string;
  literal?: string;
  role?: string;
  /** The person this creator is in the library (read-only; see the store's graph). */
  personId?: string;
}
export interface CitableSource {
  id: string;
  kind: string;
  itemType?: string;
  title?: string;
  creators: Creator[];
  year?: number;
  date?: string;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  place?: string;
  edition?: string;
  doi?: string;
  url?: string;
  isbn?: string;
  issn?: string;
  citationKey?: string;
  institution?: string;
  genre?: string;
}

const initials = (given?: string) =>
  (given || "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(" ");

const apaName = (c: Creator) =>
  c.literal ? c.literal : [c.family, initials(c.given)].filter(Boolean).join(", ");

function apaAuthors(creators: Creator[]) {
  const authors = creators.filter((c) => !c.role || c.role === "author");
  const names = (authors.length ? authors : creators).map(apaName).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  return `${names.slice(0, 19).join(", ")}, … ${names.at(-1)}`;
}

const sentence = (text: string) => (/[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const doiUrl = (doi?: string) => (doi ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : "");

/** APA 7 reference. `html` italicises titles the way APA requires. */
export function apa(source: CitableSource, html = false) {
  const italic = (text: string) => (html ? `<i>${escapeHtml(text)}</i>` : text);
  const plain = (text: string) => (html ? escapeHtml(text) : text);
  const authors = apaAuthors(source.creators);
  const year = `(${source.year ?? "n.d."}).`;
  const title = source.title?.trim() || "Untitled";
  const link = doiUrl(source.doi) || source.url || "";
  const container = source.containerTitle?.trim();
  const parts: string[] = [];
  const head = authors ? `${sentence(plain(authors))} ${year}` : `${italic(title)}. ${year}`;
  parts.push(head);
  switch (source.itemType) {
    case "article":
    case "magazine-article":
    case "newspaper-article":
    case "preprint": {
      if (authors) parts.push(sentence(plain(title)));
      if (container) {
        let tail = italic(container);
        if (source.volume) tail += `, ${italic(source.volume)}`;
        if (source.issue) tail += plain(`(${source.issue})`);
        if (source.pages) tail += plain(`, ${source.pages.replace(/-/g, "–")}`);
        parts.push(`${tail}.`);
      }
      break;
    }
    case "chapter": {
      if (authors) parts.push(sentence(plain(title)));
      if (container) parts.push(`In ${italic(container)}${source.pages ? plain(` (pp. ${source.pages.replace(/-/g, "–")})`) : ""}.`);
      if (source.publisher) parts.push(sentence(plain(source.publisher)));
      break;
    }
    case "book":
    case "report":
    case "thesis": {
      if (authors) parts.push(`${italic(title)}${source.edition ? plain(` (${source.edition} ed.)`) : ""}.`);
      const by = source.publisher || source.institution;
      if (by) parts.push(sentence(plain(by)));
      break;
    }
    default: {
      if (authors) parts.push(`${italic(title)}.`);
      if (container) parts.push(sentence(plain(container)));
      else if (source.publisher) parts.push(sentence(plain(source.publisher)));
    }
  }
  if (link) parts.push(html ? `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : link);
  return parts.join(" ");
}

/** In-text citation, e.g. (Palma et al., 2022). */
export function apaInText(source: CitableSource) {
  const authors = source.creators.filter((c) => !c.role || c.role === "author");
  const name = (c?: Creator) => c?.family || c?.literal || "";
  const who =
    authors.length === 0
      ? source.title || "Untitled"
      : authors.length === 1
        ? name(authors[0])
        : authors.length === 2
          ? `${name(authors[0])} & ${name(authors[1])}`
          : `${name(authors[0])} et al.`;
  return `(${who}, ${source.year ?? "n.d."})`;
}

const BIBTEX_TYPES: Record<string, string> = {
  article: "article",
  "magazine-article": "article",
  "newspaper-article": "article",
  book: "book",
  chapter: "incollection",
  "conference-paper": "inproceedings",
  report: "techreport",
  thesis: "phdthesis",
  webpage: "misc",
  dataset: "misc",
  software: "software",
  preprint: "misc",
};

export function citationKey(source: CitableSource) {
  if (source.citationKey) return source.citationKey;
  const first = source.creators[0];
  const name = (first?.family || first?.literal || "anon").toLowerCase().replace(/[^a-z0-9]/g, "");
  const word = (source.title || "").toLowerCase().split(/\W+/).find((w) => w.length > 3) || "item";
  return `${name}${source.year ?? ""}${word}`;
}

export function bibtex(source: CitableSource) {
  const type = BIBTEX_TYPES[source.itemType || ""] || "misc";
  const authors = source.creators
    .filter((c) => !c.role || c.role === "author")
    .map((c) => (c.literal ? `{${c.literal}}` : [c.family, c.given].filter(Boolean).join(", ")))
    .join(" and ");
  const editors = source.creators
    .filter((c) => c.role === "editor")
    .map((c) => (c.literal ? `{${c.literal}}` : [c.family, c.given].filter(Boolean).join(", ")))
    .join(" and ");
  const container = type === "article" ? "journal" : type === "inproceedings" || type === "incollection" ? "booktitle" : "howpublished";
  const fields: [string, string | number | undefined][] = [
    ["title", source.title],
    ["author", authors],
    ["editor", editors],
    [container, source.containerTitle],
    ["year", source.year],
    ["volume", source.volume],
    ["number", source.issue],
    ["pages", source.pages?.replace(/[–—-]+/g, "--")],
    ["edition", source.edition],
    ["publisher", source.publisher],
    ["address", source.place],
    ["institution", type === "techreport" || type === "phdthesis" ? source.institution : undefined],
    ["doi", source.doi],
    ["isbn", source.isbn],
    ["issn", source.issn],
    ["url", source.url],
  ];
  const body = fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `  ${key} = {${String(value).replace(/[{}]/g, "")}}`)
    .join(",\n");
  return `@${type}{${citationKey(source)},\n${body}\n}`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
