// Plain-text preview of a note: Markdown syntax and fence lines removed, the
// text of paragraphs, callouts, toggles, quotes and source lines kept, all
// whitespace collapsed to single spaces.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;

function inline(text: string): string {
  return (
    text
      // images → alt text, links → label
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, "$1")
  );
}

function blockLine(line: string): string | null {
  let s = line;
  if (/^\s*(?:[-*_]\s*){3,}$/.test(s)) return null; // thematic break
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(s)) return null; // table rule
  s = s.replace(/^\s*(?:>\s?)+/, ""); // blockquote
  s = s.replace(/^\s*#{1,6}\s+/, ""); // heading
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""); // list / task
  if (/^\s*\|.*\|\s*$/.test(s)) s = s.trim().replace(/^\||\|$/g, "").split("|").join(" ");
  return inline(s);
}

export function markdownToPlainText(md: string): string {
  const out: string[] = [];
  const fences: Array<{ marker: string; code: boolean }> = [];
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1];
      const top = fences[fences.length - 1];
      // a bare fence at least as long as the open one closes it
      if (top && marker[0] === top.marker[0] && marker.length >= top.marker.length && !open[2].trim()) {
        fences.pop();
        continue;
      }
      if (!top?.code) {
        const info = open[2].trim();
        fences.push({ marker, code: !/^(?:callout|toggle|source|quote|video|image)\b/.test(info) });
        const toggle = /^toggle\b.*?title="((?:[^"\\]|\\.)*)"/.exec(info);
        if (toggle) out.push(toggle[1].replace(/\\(.)/g, "$1"));
        continue;
      }
    }
    const inCode = fences.some((f) => f.code);
    const text = inCode ? line : blockLine(line);
    if (text !== null) out.push(text);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}
