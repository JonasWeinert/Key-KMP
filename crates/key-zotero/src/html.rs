// Zotero notes are HTML (the note editor's ProseMirror output, Better Notes, or older
// hand-written markup). This reads them with a forgiving parser and writes the Markdown
// Key's note editor reads: headings, emphasis, lists, links, quotes, tables and code, with
// Zotero highlight annotations as the editor's ```quote blocks.
use serde_json::Value as Json;

#[derive(Debug, Clone)]
enum Node {
    Element { name: String, attrs: Vec<(String, String)>, children: Vec<Node> },
    Text(String),
}

impl Node {
    fn name(&self) -> &str {
        match self {
            Node::Element { name, .. } => name,
            Node::Text(_) => "",
        }
    }
    fn attr(&self, key: &str) -> Option<&str> {
        match self {
            Node::Element { attrs, .. } => attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()),
            Node::Text(_) => None,
        }
    }
    fn has_class(&self, class: &str) -> bool {
        self.attr("class").is_some_and(|c| c.split_whitespace().any(|c| c == class))
    }
    fn children(&self) -> &[Node] {
        match self {
            Node::Element { children, .. } => children,
            Node::Text(_) => &[],
        }
    }
    /// The text inside, as the browser would show it in `pre` (line breaks kept).
    fn raw_text(&self, out: &mut String) {
        match self {
            Node::Text(text) => out.push_str(text),
            Node::Element { name, children, .. } => {
                if name == "br" {
                    out.push('\n');
                }
                for child in children {
                    child.raw_text(out);
                }
            }
        }
    }
}

const VOID: [&str; 11] = ["br", "img", "hr", "input", "meta", "link", "col", "wbr", "area", "source", "base"];
const BLOCK: [&str; 33] = [
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "table", "thead", "tbody", "tfoot", "tr", "td",
    "th", "hr", "section", "article", "header", "footer", "figure", "figcaption", "dl", "dt", "dd", "center", "details", "summary",
];

fn is_block(name: &str) -> bool {
    BLOCK.contains(&name) || name == "aside" || name == "main" || name == "nav" || name == "address" || name == "caption"
}

// ── Parsing ─────────────────────────────────────────────

fn parse(html: &str) -> Vec<Node> {
    // An open element: its name, attributes and children so far.
    let mut stack: Vec<(String, Vec<(String, String)>, Vec<Node>)> = vec![(String::new(), Vec::new(), Vec::new())];
    let close_top = |stack: &mut Vec<(String, Vec<(String, String)>, Vec<Node>)>| {
        let (name, attrs, children) = stack.pop().expect("an open element");
        stack.last_mut().expect("the root").2.push(Node::Element { name, attrs, children });
    };
    let mut rest = html;
    while !rest.is_empty() {
        let Some(start) = rest.find('<') else {
            stack.last_mut().unwrap().2.push(Node::Text(decode(rest)));
            break;
        };
        if start > 0 {
            stack.last_mut().unwrap().2.push(Node::Text(decode(&rest[..start])));
        }
        rest = &rest[start..];
        if let Some(comment) = rest.strip_prefix("<!--") {
            rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
            continue;
        }
        let Some(end) = tag_end(rest) else {
            // A stray "<" is text.
            stack.last_mut().unwrap().2.push(Node::Text("<".into()));
            rest = &rest[1..];
            continue;
        };
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        if tag.starts_with('!') || tag.starts_with('?') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let name = name.trim().to_ascii_lowercase();
            // Close up to the nearest matching element; an end tag nothing opened is ignored.
            if let Some(index) = stack.iter().rposition(|(open, _, _)| *open == name) {
                if index > 0 {
                    while stack.len() > index {
                        close_top(&mut stack);
                    }
                }
            }
            continue;
        }
        let (name, attrs, self_closing) = read_tag(tag);
        if name.is_empty() {
            continue;
        }
        // Implied ends, as browsers apply them to the markup Zotero and plugins write.
        if is_block(&name) {
            if let Some(index) = stack.iter().rposition(|(open, _, _)| open == "p") {
                if stack[index + 1..].iter().all(|(open, _, _)| !is_block(open)) {
                    while stack.len() > index {
                        close_top(&mut stack);
                    }
                }
            }
        }
        let implied: &[&str] = match name.as_str() {
            "li" => &["li"],
            "dt" | "dd" => &["dt", "dd"],
            "tr" => &["tr", "td", "th"],
            "td" | "th" => &["td", "th"],
            "thead" | "tbody" | "tfoot" => &["thead", "tbody", "tfoot", "tr", "td", "th"],
            _ => &[],
        };
        if !implied.is_empty() {
            // Only within the nearest list or table: a nested list's items never close the outer one.
            let boundary = match name.as_str() {
                "li" => &["ul", "ol"][..],
                "dt" | "dd" => &["dl"][..],
                _ => &["table"][..],
            };
            let scope = stack.iter().rposition(|(open, _, _)| boundary.contains(&open.as_str())).unwrap_or(0);
            if let Some(index) = stack.iter().rposition(|(open, _, _)| implied.contains(&open.as_str())).filter(|i| *i > scope) {
                while stack.len() > index {
                    close_top(&mut stack);
                }
            }
        }
        if self_closing || VOID.contains(&name.as_str()) {
            stack.last_mut().unwrap().2.push(Node::Element { name, attrs, children: Vec::new() });
        } else if matches!(name.as_str(), "script" | "style") {
            let close = format!("</{name}");
            let lower = rest.to_ascii_lowercase();
            rest = lower.find(&close).and_then(|i| rest[i..].find('>').map(|e| &rest[i + e + 1..])).unwrap_or("");
        } else {
            stack.push((name, attrs, Vec::new()));
        }
    }
    while stack.len() > 1 {
        close_top(&mut stack);
    }
    stack.pop().map(|(_, _, children)| children).unwrap_or_default()
}

/// The ">" that ends a tag starting at `html[0] == '<'`, skipping quoted attribute values.
fn tag_end(html: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    if bytes.len() < 2 || !(bytes[1].is_ascii_alphabetic() || matches!(bytes[1], b'/' | b'!' | b'?')) {
        return None;
    }
    let mut quote = None;
    for (index, &b) in bytes.iter().enumerate().skip(1) {
        match (quote, b) {
            (None, b'"' | b'\'') => quote = Some(b),
            (Some(q), _) if q == b => quote = None,
            (None, b'>') => return Some(index),
            _ => {}
        }
    }
    None
}

fn read_tag(tag: &str) -> (String, Vec<(String, String)>, bool) {
    let self_closing = tag.trim_end().ends_with('/');
    let tag = tag.trim_end().trim_end_matches('/');
    let name_end = tag.find(|c: char| c.is_whitespace()).unwrap_or(tag.len());
    let name = tag[..name_end].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut rest = tag[name_end..].trim_start();
    while !rest.is_empty() {
        let key_end = rest.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(rest.len());
        let key = rest[..key_end].to_ascii_lowercase();
        rest = rest[key_end..].trim_start();
        let mut value = String::new();
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            if let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let body = &after[1..];
                let close = body.find(q).unwrap_or(body.len());
                value = decode(&body[..close]);
                rest = body.get(close + 1..).unwrap_or("");
            } else {
                let close = after.find(char::is_whitespace).unwrap_or(after.len());
                value = decode(&after[..close]);
                rest = &after[close..];
            }
        }
        if !key.is_empty() {
            attrs.push((key, value));
        }
        rest = rest.trim_start();
    }
    (name, attrs, self_closing)
}

/// Decodes character references (named ones Zotero writes, and numeric ones).
pub fn decode(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '#')).map(|i| i + 1);
        let decoded = end.filter(|e| rest[*e..].starts_with(';')).and_then(|e| {
            let entity = &rest[1..e];
            let c = if let Some(number) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
                u32::from_str_radix(number, 16).ok().and_then(char::from_u32)
            } else if let Some(number) = entity.strip_prefix('#') {
                number.parse().ok().and_then(char::from_u32)
            } else {
                Some(match entity {
                    "amp" => '&',
                    "lt" => '<',
                    "gt" => '>',
                    "quot" => '"',
                    "apos" => '\'',
                    "nbsp" => '\u{a0}',
                    "ndash" => '–',
                    "mdash" => '—',
                    "hellip" => '…',
                    "lsquo" => '‘',
                    "rsquo" => '’',
                    "ldquo" => '“',
                    "rdquo" => '”',
                    "laquo" => '«',
                    "raquo" => '»',
                    "middot" => '·',
                    "bull" => '•',
                    "copy" => '©',
                    "reg" => '®',
                    "deg" => '°',
                    "times" => '×',
                    "minus" => '−',
                    "plusmn" => '±',
                    "shy" => '\u{ad}',
                    "zwj" => '\u{200d}',
                    "zwnj" => '\u{200c}',
                    _ => return None,
                })
            };
            c.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, length)) => {
                out.push(c);
                rest = &rest[length..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ── Rendering ───────────────────────────────────────────

/// What a highlight in a note points at: the Zotero key of the PDF attachment it was made
/// on and of the item it cites. The resolver turns either into a Key source id.
pub trait Resolve {
    fn source(&self, attachment_key: Option<&str>, item_key: Option<&str>) -> Option<String>;
}
impl<F: Fn(Option<&str>, Option<&str>) -> Option<String>> Resolve for F {
    fn source(&self, attachment_key: Option<&str>, item_key: Option<&str>) -> Option<String> {
        self(attachment_key, item_key)
    }
}
/// For notes converted without a library at hand: highlights become plain block quotes.
pub struct NoSources;
impl Resolve for NoSources {
    fn source(&self, _: Option<&str>, _: Option<&str>) -> Option<String> {
        None
    }
}

/// Converts a Zotero note's HTML to Markdown for Key's note editor.
pub fn html_to_markdown(html: &str, sources: &dyn Resolve) -> String {
    let nodes = parse(html);
    let writer = Writer { sources };
    let blocks = writer.blocks(&nodes);
    let mut out = blocks.join("\n\n");
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    out.trim().to_string()
}

struct Writer<'a> {
    sources: &'a dyn Resolve,
}

impl Writer<'_> {
    /// Block-level Markdown for a run of nodes; inline runs between blocks become paragraphs.
    fn blocks(&self, nodes: &[Node]) -> Vec<String> {
        let mut out = Vec::new();
        let mut inline: Vec<&Node> = Vec::new();
        for node in nodes {
            if is_block(node.name()) {
                self.paragraph(&inline, &mut out);
                inline.clear();
                self.block(node, &mut out);
            } else {
                inline.push(node);
            }
        }
        self.paragraph(&inline, &mut out);
        out
    }

    fn block(&self, node: &Node, out: &mut Vec<String>) {
        let name = node.name();
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = (name.as_bytes()[1] - b'0') as usize;
                let text = collapse(&self.inline_nodes(node.children(), true));
                if !text.is_empty() {
                    out.push(format!("{} {}", "#".repeat(level), text));
                }
            }
            "p" | "dt" | "dd" | "summary" | "figcaption" | "caption" => {
                let children: Vec<&Node> = node.children().iter().collect();
                if children.iter().any(|c| is_block(c.name())) {
                    out.extend(self.blocks(node.children()));
                } else {
                    self.paragraph(&children, out);
                }
            }
            "ul" | "ol" => {
                let list = self.list(node);
                if !list.is_empty() {
                    out.push(list);
                }
            }
            "li" => {
                // A list item outside a list reads as a bullet.
                let item = self.list_item(node, "- ");
                if !item.is_empty() {
                    out.push(item);
                }
            }
            "blockquote" => {
                let inner = self.blocks(node.children()).join("\n\n");
                if !inner.trim().is_empty() {
                    out.push(inner.lines().map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect::<Vec<_>>().join("\n"));
                }
            }
            "pre" => {
                let mut code = String::new();
                node.raw_text(&mut code);
                let code = code.trim_end_matches('\n').trim_start_matches('\n');
                let language = find(node, &|n| n.name() == "code")
                    .and_then(|c| c.attr("class"))
                    .and_then(|c| c.split_whitespace().find_map(|c| c.strip_prefix("language-")))
                    .unwrap_or("")
                    .to_string();
                if !code.trim().is_empty() {
                    let fence = "`".repeat(longest_run(code, '`').max(2) + 1);
                    out.push(format!("{fence}{language}\n{code}\n{fence}"));
                }
            }
            "table" => {
                if let Some(table) = self.table(node) {
                    out.push(table);
                }
            }
            "hr" => out.push("---".into()),
            _ => out.extend(self.blocks(node.children())),
        }
    }

    /// Inline nodes as one paragraph, with any Zotero highlights lifted out as quote blocks.
    fn paragraph(&self, nodes: &[&Node], out: &mut Vec<String>) {
        let mut run: Vec<&Node> = Vec::new();
        let mut after_quote = false;
        let flush = |run: &mut Vec<&Node>, out: &mut Vec<String>| {
            let owned: Vec<Node> = run.drain(..).cloned().collect();
            let text = self.inline_nodes(&owned, false);
            let text = text.trim_matches(|c: char| c == ' ' || c == '\n' || c == '\u{a0}');
            if !text.is_empty() && !text.chars().all(|c| matches!(c, '\\' | '/' | ' ' | '\u{a0}')) {
                out.push(escape_line_starts(text));
            }
        };
        for node in nodes {
            if let Some(quote) = self.annotation(node) {
                flush(&mut run, out);
                out.push(quote);
                after_quote = true;
                continue;
            }
            // The citation Zotero writes after a highlight repeats the quote's source and page.
            if after_quote {
                if node.has_class("citation") {
                    after_quote = false;
                    continue;
                }
                if matches!(node, Node::Text(t) if t.trim().is_empty()) {
                    continue;
                }
                after_quote = false;
            }
            run.push(node);
        }
        flush(&mut run, out);
    }

    /// A highlight or underline annotation span (`data-annotation`) as a quote block.
    fn annotation(&self, node: &Node) -> Option<String> {
        if node.name() != "span" || !(node.has_class("highlight") || node.has_class("underline")) {
            return None;
        }
        let data: Json = serde_json::from_str(&percent_decode(node.attr("data-annotation")?)).ok()?;
        let mut text = String::new();
        node.raw_text(&mut text);
        let text = collapse(&text);
        let text = text.strip_prefix('“').and_then(|t| t.strip_suffix('”')).unwrap_or(&text).trim();
        if text.is_empty() {
            return None;
        }
        let attachment = data.get("attachmentURI").and_then(Json::as_str).and_then(uri_key);
        let item = data
            .pointer("/citationItem/uris/0")
            .and_then(Json::as_str)
            .and_then(uri_key);
        let page = data.pointer("/position/pageIndex").and_then(Json::as_i64);
        let color = data.get("color").and_then(Json::as_str).and_then(color_name);
        Some(quote_block(self.sources.source(attachment, item).as_deref(), page, color, &escape(text)))
    }

    fn list(&self, node: &Node) -> String {
        let ordered = node.name() == "ol";
        let mut number: i64 = node.attr("start").and_then(|s| s.trim().parse().ok()).unwrap_or(1);
        let mut items = Vec::new();
        for child in node.children() {
            match child {
                Node::Element { name, .. } if name == "li" => {
                    let marker = if ordered { format!("{number}. ") } else { "- ".to_string() };
                    number += 1;
                    let item = self.list_item(child, &marker);
                    if !item.is_empty() {
                        items.push(item);
                    }
                }
                // A list nested directly in a list belongs to the item before it.
                Node::Element { name, .. } if name == "ul" || name == "ol" => {
                    let nested = self.list(child);
                    if !nested.is_empty() {
                        match items.last_mut() {
                            Some(last) => {
                                last.push('\n');
                                last.push_str(&indent(&nested));
                            }
                            None => items.push(nested),
                        }
                    }
                }
                Node::Text(text) if text.trim().is_empty() => {}
                other => {
                    let text = collapse(&self.inline_nodes(std::slice::from_ref(other), false));
                    if !text.is_empty() {
                        items.push(format!("- {text}"));
                    }
                }
            }
        }
        items.join("\n")
    }

    fn list_item(&self, node: &Node, marker: &str) -> String {
        let blocks = self.blocks(node.children());
        let Some((first, rest)) = blocks.split_first() else { return String::new() };
        let mut item = format!("{marker}{}", first.replace('\n', "\n    "));
        let mut previous_was_list = false;
        for block in rest {
            let is_list = block.starts_with("- ") || block.split_once(". ").is_some_and(|(n, _)| n.chars().all(|c| c.is_ascii_digit()));
            // Paragraphs inside an item are separated by a blank line; a nested list follows directly.
            item.push_str(if is_list && !previous_was_list { "\n" } else { "\n\n" });
            item.push_str(&indent(block));
            previous_was_list = is_list;
        }
        item
    }

    fn table(&self, node: &Node) -> Option<String> {
        let mut rows: Vec<Vec<String>> = Vec::new();
        collect_rows(node, &mut |row: &Node| {
            let cells: Vec<String> = row
                .children()
                .iter()
                .filter(|c| matches!(c.name(), "td" | "th"))
                .map(|cell| {
                    let blocks = self.blocks(cell.children());
                    blocks.join(" ").replace('\n', " ").replace('|', "\\|").trim().to_string()
                })
                .collect();
            if !cells.is_empty() {
                rows.push(cells);
            }
        });
        let width = rows.iter().map(Vec::len).max()?;
        for row in &mut rows {
            row.resize(width, String::new());
        }
        // Markdown tables have exactly one header row: the first row serves.
        let line = |cells: &[String]| format!("| {} |", cells.iter().map(|c| if c.is_empty() { " " } else { c.as_str() }).collect::<Vec<_>>().join(" | "));
        let mut out = vec![line(&rows[0]), format!("|{}", " --- |".repeat(width))];
        out.extend(rows[1..].iter().map(|r| line(r)));
        Some(out.join("\n"))
    }

    /// Inline Markdown for a run of nodes. `flat` turns line breaks into spaces (headings).
    fn inline_nodes(&self, nodes: &[Node], flat: bool) -> String {
        let mut out = String::new();
        for node in nodes {
            self.inline(node, flat, &mut out);
        }
        out
    }

    fn inline(&self, node: &Node, flat: bool, out: &mut String) {
        let element = match node {
            Node::Text(text) => {
                out.push_str(&escape(&collapse_spaces(text)));
                return;
            }
            Node::Element { name, .. } => name.as_str(),
        };
        match element {
            "br" => out.push_str(if flat { " " } else { "\\\n" }),
            "strong" | "b" => wrap(out, "**", &self.inline_nodes(node.children(), flat)),
            "em" | "i" | "cite" | "dfn" => wrap(out, "*", &self.inline_nodes(node.children(), flat)),
            "s" | "strike" | "del" => wrap(out, "~~", &self.inline_nodes(node.children(), flat)),
            "code" | "kbd" | "samp" | "tt" => {
                let mut text = String::new();
                node.raw_text(&mut text);
                let text = collapse_spaces(&text);
                if !text.trim().is_empty() {
                    let ticks = "`".repeat(longest_run(&text, '`') + 1);
                    let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
                    out.push_str(&format!("{ticks}{pad}{text}{pad}{ticks}"));
                }
            }
            "a" => {
                let label = self.inline_nodes(node.children(), flat);
                let href = node.attr("href").unwrap_or("").trim();
                if href.is_empty() || href.starts_with("javascript:") || label.trim().is_empty() {
                    out.push_str(&label);
                } else {
                    let (lead, label, trail) = split_space(&label);
                    out.push_str(&format!("{lead}[{label}]({}){trail}", link_target(href)));
                }
            }
            "img" => {
                let src = node.attr("src").unwrap_or("");
                // Zotero keeps note images as attachments (data-attachment-key); only web images carry over.
                if src.starts_with("http://") || src.starts_with("https://") {
                    let alt = node.attr("alt").unwrap_or("").replace(['[', ']'], "");
                    out.push_str(&format!("![{alt}]({})", link_target(src)));
                }
            }
            "span" if node.attr("data-annotation").is_some() => {
                // A highlight inside a heading, link or table cell stays inline text.
                let mut text = String::new();
                node.raw_text(&mut text);
                out.push_str(&escape(&collapse_spaces(&text)));
            }
            "sup" | "sub" | "u" | "ins" | "mark" | "small" | "big" | "font" | "span" | "abbr" | "q" | "label" | "time" | "var" => {
                for child in node.children() {
                    self.inline(child, flat, out);
                }
            }
            "input" if node.attr("type") == Some("checkbox") => {}
            "math" | "svg" | "button" | "select" | "textarea" | "iframe" | "object" | "video" | "audio" | "canvas" => {}
            _ if is_block(element) => {
                // A block inside inline content (a table cell, a heading): its text, separated by spaces.
                let inner = self.blocks(node.children()).join(" ");
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(&inner.replace('\n', " "));
            }
            _ => {
                for child in node.children() {
                    self.inline(child, flat, out);
                }
            }
        }
    }
}

fn collect_rows(node: &Node, visit: &mut dyn FnMut(&Node)) {
    for child in node.children() {
        match child.name() {
            "tr" => visit(child),
            // A table inside a cell is flattened into that cell's text, not walked here.
            "table" => {}
            _ => collect_rows(child, visit),
        }
    }
}

fn find<'n>(node: &'n Node, test: &dyn Fn(&Node) -> bool) -> Option<&'n Node> {
    node.children().iter().find_map(|c| if test(c) { Some(c) } else { find(c, test) })
}

/// The editor's quote block, or a plain block quote when the source is not in Key.
pub fn quote_block(source: Option<&str>, page: Option<i64>, color: Option<&str>, body: &str) -> String {
    let Some(source) = source else {
        return body.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
    };
    let mut info = format!("quote source={}", quote_attr(source));
    if let Some(page) = page {
        info.push_str(&format!(" page={}", quote_attr(&page.to_string())));
    }
    if let Some(color) = color {
        info.push_str(&format!(" color={}", quote_attr(color)));
    }
    let fence = "`".repeat(longest_run(body, '`').max(2) + 1);
    format!("{fence}{info}\n{body}\n{fence}")
}

fn quote_attr(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " "))
}

/// Zotero's highlight colours by the names Key's reader uses.
pub fn color_name(hex: &str) -> Option<&'static str> {
    match hex.trim().to_ascii_lowercase().as_str() {
        "#ffd400" => Some("yellow"),
        "#ff6666" => Some("red"),
        "#5fb236" => Some("green"),
        "#2ea8e5" => Some("blue"),
        "#a28ae5" => Some("purple"),
        "#e56eee" => Some("pink"),
        "#f19837" => Some("orange"),
        _ => None,
    }
}

/// The item key at the end of a Zotero URI (http://zotero.org/users/123/items/ABCD2345).
pub fn uri_key(uri: &str) -> Option<&str> {
    let (_, key) = uri.rsplit_once("/items/")?;
    (!key.is_empty()).then_some(key)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn link_target(href: &str) -> String {
    let href = href.replace(' ', "%20");
    if href.contains(['(', ')', '<', '>']) {
        format!("<{}>", href.replace('<', "%3C").replace('>', "%3E"))
    } else {
        href
    }
}

/// Wraps inline content in emphasis marks, keeping its edge spaces outside them.
fn wrap(out: &mut String, mark: &str, content: &str) {
    let (lead, inner, trail) = split_space(content);
    if inner.is_empty() {
        out.push_str(content);
        return;
    }
    // Directly nested marks of the same kind ("**a****b**") read as one run.
    if out.ends_with(mark) && lead.is_empty() && !out.ends_with(&format!("\\{mark}")) {
        out.truncate(out.len() - mark.len());
        out.push_str(&format!("{inner}{mark}{trail}"));
        return;
    }
    out.push_str(&format!("{lead}{mark}{inner}{mark}{trail}"));
}

fn split_space(text: &str) -> (&str, &str, &str) {
    let is_space = |c: char| c == ' ' || c == '\u{a0}' || c == '\n';
    let inner = text.trim_matches(is_space);
    let lead = &text[..text.len() - text.trim_start_matches(is_space).len()];
    let trail = &text[text.trim_end_matches(is_space).len()..];
    (lead, inner, trail)
}

/// HTML whitespace: runs of spaces, tabs and newlines read as one space.
fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(if c == '\u{a0}' { ' ' } else { c });
            space = false;
        }
    }
    out
}

fn collapse(text: &str) -> String {
    collapse_spaces(text).trim().to_string()
}

fn longest_run(text: &str, mark: char) -> usize {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == mark { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    longest
}

fn indent(block: &str) -> String {
    block.lines().map(|l| if l.is_empty() { String::new() } else { format!("    {l}") }).collect::<Vec<_>>().join("\n")
}

/// Escapes text so Markdown reads it literally: emphasis and code marks, and link
/// brackets only where they would form a link. Plain words stay as they are.
fn escape(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let link_like = text.contains("](");
    let mut out = String::with_capacity(text.len());
    for (index, &c) in chars.iter().enumerate() {
        let before = index.checked_sub(1).map(|i| chars[i]);
        let after = chars.get(index + 1).copied();
        let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
        let escaped = match c {
            '*' | '`' | '\\' => c != '\\' || after.is_some_and(|a| a.is_ascii_punctuation()),
            // Inside a word (snake_case) an underscore never starts emphasis.
            '_' => !(word(before) && word(after)),
            '[' | ']' => link_like,
            '<' => after.is_some_and(|a| a.is_ascii_alphabetic() || a == '/' || a == '!'),
            '~' => after == Some('~') || before == Some('~'),
            _ => false,
        };
        if escaped {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Text that would start a heading, quote, list or fence at the start of a line is escaped.
fn escape_line_starts(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            let lead = &line[..line.len() - trimmed.len()];
            let numbered = trimmed
                .find(['.', ')'])
                .filter(|&i| i > 0 && trimmed[..i].chars().all(|c| c.is_ascii_digit()) && trimmed[i + 1..].starts_with(' '));
            if let Some(i) = numbered {
                format!("{lead}{}\\{}", &trimmed[..i], &trimmed[i..])
            } else if trimmed.starts_with('#')
                || trimmed.starts_with('>')
                || trimmed.starts_with("```")
                || trimmed.starts_with("~~~")
                || trimmed.starts_with('|')
                || ((trimmed.starts_with("- ") || trimmed.starts_with("+ ")) || trimmed == "-" || trimmed.starts_with("---") || trimmed.starts_with("==="))
            {
                format!("{lead}\\{trimmed}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The plain text the first importer kept of a note, so an unedited copy can be recognised
/// and converted to Markdown on the next import.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag.trim_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_ascii_lowercase();
                if matches!(name.as_str(), "p" | "br" | "div" | "li" | "h1" | "h2" | "h3" | "h4" | "tr" | "blockquote") && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(c),
            _ => out.push(c),
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    decoded.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(html: &str) -> String {
        html_to_markdown(html, &NoSources)
    }

    #[test]
    fn zotero_7_note_with_headings_emphasis_and_links() {
        let html = r#"<div class="zotero-note znv1"><div data-schema-version="9"><h1>Welcome to the notes</h1>
<p>This note was written in <strong>Zotero 7</strong> with <em>emphasis</em>, <s>gone</s> and <code>a_code</code> -&gt; done.</p>
<h2>📝 Introduction</h2>
<blockquote>
<p>Everything about note management.</p>
</blockquote>
<p>It is a plugin for <a href="https://zotero.org" rel="noopener noreferrer nofollow">Zotero</a>.</p>
</div></div>"#;
        assert_eq!(
            md(html),
            "# Welcome to the notes\n\nThis note was written in **Zotero 7** with *emphasis*, ~~gone~~ and `a_code` -> done.\n\n## 📝 Introduction\n\n> Everything about note management.\n\nIt is a plugin for [Zotero](https://zotero.org)."
        );
    }

    #[test]
    fn unclosed_paragraphs_before_headings() {
        // An AI summary plugin writes <p> without closing it before the next heading.
        let html = "<div class=\"zotero-note znv1\"><h1>highly relevant: masks &amp; mandates</h1> <h2>Study Type:</h2> <p> Other Study type</p> <h2>Factors</h2> <h3>Investigated</h3> <p> ['Political Affiliation &amp; Attitudes', 'Gender'] <h3>Significant</h3> <p> [] <h2>Causal</h2> <p>false</p></div>";
        assert_eq!(
            md(html),
            "# highly relevant: masks & mandates\n\n## Study Type:\n\nOther Study type\n\n## Factors\n\n### Investigated\n\n['Political Affiliation & Attitudes', 'Gender']\n\n### Significant\n\n[]\n\n## Causal\n\nfalse"
        );
    }

    #[test]
    fn styled_spans_lists_and_nested_lists() {
        let html = r#"<div class="zotero-note znv1"><div data-schema-version="9"><h3 style="text-align: left"><span style="color: rgb(17, 17, 17)"><span style="background-color: rgb(243, 243, 243)">1.&nbsp;</span></span><strong><span style="color: rgb(17, 17, 17)">Main Argument &amp; Finding</span></strong></h3>
<ul>
<li>
<strong><u><span style="color: inherit"><a href="https://example.org/a?x=1&amp;y=2" rel="noopener noreferrer nofollow">Public Trust</a></span></u></strong><span>: trust in institutions</span>
</li>
<li>
<p>Second point</p>
<ol start="3"><li>three</li><li>four</li></ol>
</li>
</ul>
<p><strong><span style="color: rgb(17, 17, 17);">Key Findings</span></strong><span>: communication matters. </span><strong><span>Clarity</span></strong><span> and consistency.</span></p>
</div></div>"#;
        assert_eq!(
            md(html),
            "### 1. **Main Argument & Finding**\n\n- **[Public Trust](https://example.org/a?x=1&y=2)**: trust in institutions\n- Second point\n    3. three\n    4. four\n\n**Key Findings**: communication matters. **Clarity** and consistency."
        );
    }

    #[test]
    fn highlight_annotations_become_quote_blocks() {
        let annotation = "%7B%22attachmentURI%22%3A%22http%3A%2F%2Fzotero.org%2Fusers%2F1234567%2Fitems%2FYAHPABYX%22%2C%22annotationKey%22%3A%22G9I22HTD%22%2C%22color%22%3A%22%235fb236%22%2C%22pageLabel%22%3A%221%22%2C%22position%22%3A%7B%22pageIndex%22%3A4%2C%22rects%22%3A%5B%5B218.181%2C134.81%2C554.175%2C143.909%5D%5D%7D%2C%22citationItem%22%3A%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F1234567%2Fitems%2FYG66J6CC%22%5D%2C%22locator%22%3A%225%22%7D%7D";
        let citation = "%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F1234567%2Fitems%2FYG66J6CC%22%5D%2C%22locator%22%3A%225%22%7D%5D%2C%22properties%22%3A%7B%7D%7D";
        let html = format!(
            r#"<div class="zotero-note znv1"><div data-citation-items="%5B%5D" data-schema-version="10"><h1>Annotations<br>(18/02/2026, 13:24:22)</h1>
<p><span class="underline" data-annotation="{annotation}">“Clustering is widely used for *phenotyping* because it suits data without labels.”</span> <span class="citation" data-citation="{citation}">(<span class="citation-item">Han and Oh, 2023, p. 5</span>)</span> my comment</p>
<p></p>
<p>/</p>
</div></div>"#
        );
        let resolved = html_to_markdown(&html, &|attachment: Option<&str>, item: Option<&str>| {
            assert_eq!((attachment, item), (Some("YAHPABYX"), Some("YG66J6CC")));
            Some("src123".to_string())
        });
        assert_eq!(
            resolved,
            "# Annotations (18/02/2026, 13:24:22)\n\n```quote source=\"src123\" page=\"4\" color=\"green\"\nClustering is widely used for \\*phenotyping\\* because it suits data without labels.\n```\n\nmy comment"
        );
        // Without the source in Key the highlight is still kept, as a block quote.
        assert!(md(&html).contains("> Clustering is widely used"));
    }

    #[test]
    fn tables_and_code() {
        let html = "<table><thead><tr><th>Name</th><th>Value | unit</th></tr></thead><tbody><tr><td><p>alpha</p></td><td>1</td></tr><tr><td>beta</td></tr></tbody></table><pre>@article{Ajzen1991,\n  title = {Theory of ```Planned``` Behavior},\n}</pre><pre><code class=\"language-python\">print(1 &lt; 2)</code></pre>";
        assert_eq!(
            md(html),
            "| Name | Value \\| unit |\n| --- | --- |\n| alpha | 1 |\n| beta |   |\n\n````\n@article{Ajzen1991,\n  title = {Theory of ```Planned``` Behavior},\n}\n````\n\n```python\nprint(1 < 2)\n```"
        );
    }

    #[test]
    fn older_notes_with_bare_text_and_breaks() {
        let html = "Import errors found: <ul><li>Unterminated value at line 7031<pre>@article{Abaluck2022,\n  title = {Impact}</pre></li></ul>";
        assert_eq!(md(html), "Import errors found:\n\n- Unterminated value at line 7031\n\n    ```\n    @article{Abaluck2022,\n      title = {Impact}\n    ```");
        assert_eq!(md("<p>Line one<br/>line two</p><p># not a heading</p><p>1. not a list</p>"), "Line one\\\nline two\n\n\\# not a heading\n\n1\\. not a list");
        assert_eq!(md("<p>a_b and _c_ and [x](y) &#x2014; &copy; &unknown;</p>"), "a_b and \\_c\\_ and \\[x\\](y) — © &unknown;");
    }

    #[test]
    fn plain_text_of_the_first_importer_is_unchanged() {
        assert_eq!(html_to_text("<p>One &amp; two</p><p>Three<br/>four</p>"), "One & two\nThree\nfour");
    }
}
