// Highlights query words in any text the way the store matches them: whole words,
// ignoring case and accents, with the last word also matching as a prefix while typing.
import type { ReactNode } from "react";
import { snippetParts } from "./library-api";

// Same function words the store ignores (key-store `words`).
const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "has", "have", "how", "i", "in", "is", "it", "its", "of", "on", "or", "than", "that", "the", "their", "there", "these", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with"]);

/** Strips accents without changing string length, so match offsets map back to the original. */
function fold(text: string) {
  if (/^[\x00-\x7f]*$/.test(text)) return text;
  const whole = text.normalize("NFD").replace(/\p{M}/gu, "");
  if (whole.length === text.length) return whole;
  let out = "";
  for (const c of text) {
    const plain = c.normalize("NFD").replace(/\p{M}/gu, "");
    out += plain.length === c.length ? plain : c;
  }
  return out;
}

export function queryPattern(query: string): RegExp | undefined {
  const words = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  if (!words.length) return undefined;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const last = words.length - 1;
  const terms = words.map((w, i) => escape(w) + (i === last && w.length >= 2 ? "[\\p{L}\\p{N}]*" : ""));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

/** Only the typed part at the start of each word ("Alex" in "Alexandru"), as Mail's suggestions show it. */
export function prefixPattern(query: string): RegExp | undefined {
  const words = fold(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return undefined;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).sort((a, b) => b.length - a.length).join("|")})`, "giu");
}

export function hasMatch(text: string | undefined, pattern?: RegExp) {
  if (!text || !pattern) return false;
  pattern.lastIndex = 0;
  const found = pattern.test(fold(text));
  pattern.lastIndex = 0;
  return found;
}

export function Highlight({ text, pattern }: { text?: string | null; pattern?: RegExp }) {
  if (!text) return null;
  if (!pattern) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of fold(text).matchAll(pattern)) {
    if (!m[0] || m.index === undefined) continue;
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push(<mark key={m.index}>{text.slice(m.index, m.index + m[0].length)}</mark>);
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A store snippet (matches in `[[ ]]`); unmarked stretches are highlighted locally. */
export function Snippet({ snippet, pattern }: { snippet: string; pattern?: RegExp }) {
  const parts = snippetParts(snippet);
  const marked = parts.some((p) => p.match);
  return (
    <>
      {parts.map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{marked ? part.text : <Highlight text={part.text} pattern={pattern} />}</span>,
      )}
    </>
  );
}
