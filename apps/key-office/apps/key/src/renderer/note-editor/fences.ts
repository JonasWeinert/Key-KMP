// Fenced-block syntax shared by the custom note blocks.
//
//   ```callout tone="info"
//   body
//   ```
//
// The closing fence must be at least as long as the opening one, so a block
// whose body contains ``` is written with a longer fence (````callout …).

export type FenceKind = "callout" | "toggle" | "source" | "quote" | "video" | "image" | "embed";

export const FENCE_KINDS: readonly FenceKind[] = ["callout", "toggle", "source", "quote", "video", "image", "embed"];

export interface ParsedFence {
  kind: FenceKind;
  attrs: Record<string, string>;
  body: string;
  raw: string;
}

const OPEN_RE = /^ {0,3}(`{3,})(callout|toggle|source|quote|video|image|embed)(?=[ \t]|\n|$)([^\n]*)(?:\n|$)/;
const START_RE = /^ {0,3}`{3,}(?:callout|toggle|source|quote|video|image|embed)(?=[ \t]|\n|$)/m;
const ATTR_RE = /([A-Za-z_][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))/g;

/** Index of the first line that could open a custom fence (for paragraph interruption). */
export function fenceStart(src: string): number {
  const m = START_RE.exec(src);
  return m ? m.index : -1;
}

export function parseFenceAttrs(info: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of info.matchAll(ATTR_RE)) {
    attrs[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
  }
  return attrs;
}

/** Tokenizes one custom fence of the given kind at the start of `src`. */
export function matchFence(src: string, kind: FenceKind): ParsedFence | undefined {
  const open = OPEN_RE.exec(src);
  if (!open || open[2] !== kind) return undefined;
  const fenceLength = open[1].length;
  const rest = src.slice(open[0].length);
  const close = new RegExp(`^ {0,3}\`{${fenceLength},}[ \\t]*$`, "m");
  const closeMatch = close.exec(rest);
  let body: string;
  let raw: string;
  if (closeMatch) {
    body = rest.slice(0, closeMatch.index);
    let end = closeMatch.index + closeMatch[0].length;
    if (rest[end] === "\n") end += 1;
    raw = open[0] + rest.slice(0, end);
  } else {
    // unclosed fence runs to the end of the document (CommonMark behaviour)
    body = rest;
    raw = src;
  }
  // like CommonMark code fences, strip the opening fence's indentation from the body
  const indent = open[0].length - open[0].trimStart().length;
  if (indent > 0) {
    const strip = new RegExp(`^ {0,${indent}}`, "gm");
    body = body.replace(strip, "");
  }
  return {
    kind,
    attrs: parseFenceAttrs(open[3]),
    body: body.replace(/\n$/, ""),
    raw,
  };
}

/** A backtick fence longer than any backtick run inside `body` (minimum 3). */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function quoteAttr(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/\n/g, " ")}"`;
}

export function renderFence(kind: FenceKind, attrs: Array<[string, string | null | undefined]>, body: string): string {
  const info = attrs
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined)
    .map(([key, value]) => `${key}=${quoteAttr(value)}`)
    .join(" ");
  const fence = fenceFor(body);
  return `${fence}${kind}${info ? ` ${info}` : ""}\n${body}\n${fence}`;
}
