// Links in a note's Markdown: `[label](key://<kind>/<id>#<anchor>)` mentions, the editor's
// ```source cards and ```quote blocks. Each becomes a row in key-store's links table with
// the sentence around it, so backlinks can show where an item was mentioned.
use crate::note::{NOTE_FENCES, attribute, fence, inline};
use key_store::{ItemRef, LinkInput};

pub const LINK_SCHEME: &str = "key://";
const KINDS: [&str; 5] = ["source", "note", "canvas", "record", "file"];
const CONTEXT_CHARS: usize = 240;

pub fn note_links(note_id: &str, markdown: &str) -> Vec<LinkInput> {
    let from = ItemRef::new("note", note_id, None);
    let mut links = Vec::new();
    // Open fences: their marker, whether the body is code, and a quote waiting for its body.
    let mut fences: Vec<(String, bool)> = Vec::new();
    let mut quote: Option<(ItemRef, Vec<String>)> = None;
    for line in markdown.lines() {
        let in_code = fences.last().is_some_and(|(_, code)| *code);
        if let Some((marker, info)) = fence(line) {
            let closes = fences.last().is_some_and(|(open, _)| marker.starts_with(open.as_str()) && info.is_empty());
            if closes {
                fences.pop();
                if let Some((to, body)) = quote.take() {
                    let text = inline(&body.join(" "));
                    links.push(LinkInput { from: from.clone(), to, label: None, context: Some(clip(&text)) });
                }
                continue;
            }
            if !in_code {
                let name = info.split_whitespace().next().unwrap_or("");
                fences.push((marker.to_string(), !NOTE_FENCES.contains(&name)));
                match name {
                    "source" => {
                        if let Some(id) = attribute(info, "id").filter(|id| !id.is_empty()) {
                            links.push(LinkInput { from: from.clone(), to: ItemRef::new("source", &id, None), label: None, context: None });
                        }
                    }
                    "quote" => {
                        if let Some(id) = attribute(info, "source").filter(|id| !id.is_empty()) {
                            let anchor = attribute(info, "highlight")
                                .map(|h| format!("highlight:{h}"))
                                .or_else(|| attribute(info, "page").filter(|p| p.parse::<i64>().is_ok()).map(|p| format!("page:{p}")));
                            quote = Some((ItemRef { kind: "source".into(), id, anchor }, Vec::new()));
                        }
                    }
                    _ => {}
                }
                continue;
            }
        }
        if in_code {
            continue;
        }
        if let Some((_, body)) = quote.as_mut() {
            body.push(line.trim().to_string());
        }
        let context = || clip(inline(line.trim().trim_start_matches(['#', '>', ' '])).trim());
        for (label, to) in inline_links(line) {
            links.push(LinkInput { from: from.clone(), to, label: Some(label), context: Some(context()) });
        }
    }
    // An unclosed quote still links.
    if let Some((to, body)) = quote {
        links.push(LinkInput { from, to, label: None, context: Some(clip(&inline(&body.join(" ")))) });
    }
    links
}

/// `key://source/abc#page:3` → the item and its anchor. Older notes wrote `?page=3`.
pub fn parse_href(href: &str) -> Option<ItemRef> {
    let rest = href.strip_prefix(LINK_SCHEME)?;
    let (kind, rest) = rest.split_once('/')?;
    if !KINDS.contains(&kind) {
        return None;
    }
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let id = percent_decode(&rest[..end]);
    if id.is_empty() {
        return None;
    }
    let tail = &rest[end..];
    let anchor = if let Some(fragment) = tail.split_once('#').map(|(_, f)| f) {
        Some(percent_decode(fragment)).filter(|a| !a.is_empty())
    } else {
        tail.strip_prefix("?page=").filter(|p| p.parse::<i64>().is_ok()).map(|p| format!("page:{p}"))
    };
    Some(ItemRef { kind: kind.into(), id, anchor })
}

/// Markdown links on one line whose target is a Key item, with their labels.
fn inline_links(line: &str) -> Vec<(String, ItemRef)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = line[from..].find(&format!("]({LINK_SCHEME}")).map(|i| from + i) {
        let href_start = at + 2;
        let Some(href_end) = line[href_start..].find([')', ' ']).map(|i| href_start + i) else { break };
        let label_start = line[..at].rfind('[').map(|i| i + 1).unwrap_or(at);
        if let Some(item) = parse_href(&line[href_start..href_end]) {
            found.push((inline(&line[label_start..at].replace("\\[", "[").replace("\\]", "]")), item));
        }
        from = href_end;
    }
    found
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn clip(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= CONTEXT_CHARS {
        return text;
    }
    format!("{}…", text.chars().take(CONTEXT_CHARS - 1).collect::<String>().trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(links: &[LinkInput]) -> Vec<(String, String, Option<String>)> {
        links.iter().map(|l| (l.to.kind.clone(), l.to.id.clone(), l.to.anchor.clone())).collect()
    }

    #[test]
    fn finds_mentions_cards_and_quotes_with_their_context() {
        let md = "# Reading\n\nIncome matters, see [Palma 2022](key://source/s1) and [my plan](key://note/n2#heading:methods).\n\n```source id=\"s3\"\nSmith 2020 — A title\n```\n\n```quote source=\"s1\" page=\"4\" color=\"green\"\nA quoted line.\n```\n\n```python\nx = \"[no](key://source/zz)\"\n```\n\nOn the [board](key://canvas/c9) and [web](https://example.org).";
        let links = note_links("n1", md);
        assert_eq!(
            targets(&links),
            vec![
                ("source".into(), "s1".into(), None),
                ("note".into(), "n2".into(), Some("heading:methods".into())),
                ("source".into(), "s3".into(), None),
                ("source".into(), "s1".into(), Some("page:4".into())),
                ("canvas".into(), "c9".into(), None),
            ]
        );
        assert!(links.iter().all(|l| l.from == ItemRef::new("note", "n1", None)));
        assert_eq!(links[0].label.as_deref(), Some("Palma 2022"));
        assert_eq!(links[0].context.as_deref(), Some("Income matters, see Palma 2022 and my plan."));
        assert_eq!(links[3].context.as_deref(), Some("A quoted line."));
    }

    #[test]
    fn reads_hrefs_old_and_new() {
        assert_eq!(parse_href("key://source/abc"), Some(ItemRef::new("source", "abc", None)));
        assert_eq!(parse_href("key://source/abc?page=3"), Some(ItemRef::new("source", "abc", Some("page:3"))));
        assert_eq!(parse_href("key://source/abc#highlight%3Ah1"), Some(ItemRef::new("source", "abc", Some("highlight:h1"))));
        assert_eq!(parse_href("key://record/r%201"), Some(ItemRef::new("record", "r 1", None)));
        assert_eq!(parse_href("key://unknown/x"), None);
        assert_eq!(parse_href("https://x.org"), None);
    }
}
