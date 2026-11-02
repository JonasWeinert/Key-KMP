// Notes as passages. A note's Markdown is read into blocks (headings, paragraphs, lists,
// tables, quotes, code and the editor's fenced callouts, toggles, quotes and source lines)
// and cut by the layout chunker without merging: each passage is one block, so editing a
// paragraph changes only its passage and only that one needs a new vector.
use crate::chunk::sentences;
use crate::layout::{LayoutBlock, LayoutSentence, chunk_blocks};
use key_store::ChunkInput;

/// The note editor's own fenced blocks; their bodies are Markdown, other fences are code.
const NOTE_FENCES: [&str; 4] = ["callout", "toggle", "source", "quote"];

pub fn chunk_note(markdown: &str) -> Vec<ChunkInput> {
    let mut chunks = chunk_blocks(&note_blocks(markdown), false);
    for chunk in &mut chunks {
        chunk.page = None;
        chunk.rects.clear();
    }
    chunks
}

fn note_blocks(markdown: &str) -> Vec<LayoutBlock> {
    let mut blocks = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut kind = "paragraph";
    // Open fences: their marker and whether the body is code.
    let mut fences: Vec<(String, bool)> = Vec::new();
    let flush = |lines: &mut Vec<String>, kind: &str, blocks: &mut Vec<LayoutBlock>| {
        let text = lines.join("\n");
        lines.clear();
        if !text.trim().is_empty() {
            blocks.push(block(kind, text));
        }
    };
    for line in markdown.lines() {
        let in_code = fences.last().is_some_and(|(_, code)| *code);
        if let Some((marker, info)) = fence(line) {
            let closes = fences.last().is_some_and(|(open, _)| marker.starts_with(open.as_str()) && info.is_empty());
            if closes || !in_code {
                flush(&mut lines, kind, &mut blocks);
                kind = "paragraph";
                if closes {
                    fences.pop();
                } else {
                    let name = info.split_whitespace().next().unwrap_or("");
                    let code = !NOTE_FENCES.contains(&name);
                    fences.push((marker.to_string(), code));
                    if code {
                        kind = "code";
                    } else if let Some(title) = attribute(info, "title") {
                        blocks.push(block("heading", title));
                    }
                }
                continue;
            }
        }
        if in_code {
            lines.push(line.to_string());
            continue;
        }
        let trimmed = line.trim();
        if is_table_rule(trimmed) {
            continue;
        }
        if trimmed.is_empty() || is_rule(trimmed) {
            flush(&mut lines, kind, &mut blocks);
            kind = "paragraph";
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix('#').map(|h| h.trim_start_matches('#')).filter(|h| h.starts_with(' ')) {
            flush(&mut lines, kind, &mut blocks);
            kind = "paragraph";
            blocks.push(block("heading", inline(heading.trim())));
            continue;
        }
        let (line_kind, text) = block_line(trimmed);
        if lines.is_empty() {
            kind = line_kind;
        }
        lines.push(inline(&text));
    }
    flush(&mut lines, kind, &mut blocks);
    blocks
}

fn block(kind: &str, text: String) -> LayoutBlock {
    // Sentences let the chunker split an overlong block; notes have no geometry.
    let sentences = sentences(&text).into_iter().map(|s| LayoutSentence { text: s.to_string(), rects: Vec::new() }).collect();
    LayoutBlock { page: 0, kind: kind.into(), sentences, text, bounds: [0; 4] }
}

/// A fence line: its marker (``` or ~~~, three or more) and the info after it.
fn fence(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let mark = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let length = trimmed.chars().take_while(|c| *c == mark).count();
    (length >= 3).then(|| (&trimmed[..length], trimmed[length..].trim()))
}

fn attribute(info: &str, name: &str) -> Option<String> {
    let rest = &info[info.find(&format!("{name}=\""))? + name.len() + 2..];
    let mut value = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => value.extend(chars.next()),
            '"' => return Some(value),
            _ => value.push(c),
        }
    }
    None
}

/// A thematic break (---, ***, ___).
fn is_rule(line: &str) -> bool {
    let marks: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    marks.len() >= 3 && matches!(marks.chars().next(), Some('-' | '*' | '_')) && marks.chars().all(|c| marks.starts_with(c))
}

/// The line under a table's header row.
fn is_table_rule(line: &str) -> bool {
    line.starts_with('|') && line.contains("---") && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// The block a line belongs to, and its text without quote, list or table markup.
fn block_line(line: &str) -> (&'static str, String) {
    let mut kind = "paragraph";
    let mut text = line;
    while let Some(rest) = text.strip_prefix('>') {
        text = rest.trim_start();
    }
    let ordered = text.split_once(['.', ')']).filter(|(n, rest)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(' '));
    if let Some(rest) = text.strip_prefix(['-', '*', '+']).filter(|r| r.starts_with(' ')).or(ordered.map(|(_, r)| r)) {
        kind = "list";
        text = rest.trim_start();
        for box_ in ["[ ] ", "[x] ", "[X] "] {
            text = text.strip_prefix(box_).unwrap_or(text);
        }
    }
    if text.starts_with('|') && text.ends_with('|') {
        let cells: Vec<&str> = text.trim_matches('|').split('|').map(str::trim).collect();
        return ("table", cells.join(" "));
    }
    (kind, text.to_string())
}

/// Inline Markdown to plain text: links keep their label, emphasis and code marks go.
fn inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('[') {
        let label_end = rest[start..].find("](").map(|i| start + i);
        let link_end = label_end.and_then(|l| rest[l..].find(')').map(|i| l + i));
        match (label_end, link_end) {
            (Some(label), Some(end)) => {
                // An image keeps its alt text the same way.
                out.push_str(rest[..start].strip_suffix('!').unwrap_or(&rest[..start]));
                out.push_str(&rest[start + 1..label]);
                rest = &rest[end + 1..];
            }
            _ => break,
        }
    }
    out.push_str(rest);
    let mut clean = out;
    for mark in ["**", "__", "~~", "`"] {
        clean = clean.replace(mark, "");
    }
    clean.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_passage_per_block_under_its_heading() {
        let md = "# Reading notes\n\nIncome and **health** move together, see [Smith](https://x.org/a).\n\n- first point\n- second point\n\n```quote color=\"green\"\nA quoted line from the paper.\n```\n\n## Methods\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```toggle title=\"Key findings\"\nHidden detail.\n```\n\n```python\n# not a heading\nprint(1)\n```";
        let chunks = chunk_note(md);
        let texts: Vec<&str> = chunks.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "Income and health move together, see Smith.",
                "first point second point",
                "A quoted line from the paper.",
                "a b 1 2",
                "Hidden detail.",
                "# not a heading print(1)",
            ]
        );
        assert_eq!(chunks[0].section.as_deref(), Some("Reading notes"));
        assert_eq!(chunks[1].kind.as_deref(), Some("list"));
        assert_eq!(chunks[3].section.as_deref(), Some("Methods"));
        assert_eq!(chunks[4].section.as_deref(), Some("Key findings"));
        assert_eq!(chunks[5].kind.as_deref(), Some("code"));
        assert!(chunks.iter().all(|c| c.page.is_none() && c.rects.is_empty()));
    }

    #[test]
    fn editing_one_paragraph_leaves_the_others_alone() {
        let before = chunk_note("First paragraph stays.\n\nSecond one is edited.\n\nThird stays too.");
        let after = chunk_note("A new opening line.\n\nFirst paragraph stays.\n\nSecond one is edited, now longer.\n\nThird stays too.");
        let old: Vec<&str> = before.iter().map(|c| c.text.as_str()).collect();
        let changed: Vec<&str> = after.iter().map(|c| c.text.as_str()).filter(|t| !old.contains(t)).collect();
        assert_eq!(changed, vec!["A new opening line.", "Second one is edited, now longer."]);
    }

    #[test]
    fn splits_an_overlong_paragraph_at_sentences() {
        let chunks = chunk_note(&"Income matters for health in many ways. ".repeat(120));
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.text.len() <= 1500));
    }
}
