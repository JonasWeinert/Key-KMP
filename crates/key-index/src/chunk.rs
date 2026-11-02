// Paragraph-level chunking. PDF pages are rebuilt into lines from character geometry,
// lines into paragraphs (gaps, indents, size changes, column jumps), and each chunk is
// one paragraph: short neighbours are merged and only overlong paragraphs are split at
// sentence ends. Chunks keep line rectangles so the reader can highlight them.
use key_store::ChunkInput;
use std::ops::Range;

/// Paragraphs shorter than this are merged with their neighbour.
const MIN_CHARS: usize = 320;
/// Merging stops once a chunk reaches this size.
const TARGET_CHARS: usize = 1400;
/// Paragraphs longer than this are split at sentence boundaries.
const MAX_CHARS: usize = 2400;

#[derive(Clone, Debug, Default)]
pub struct TextChar {
    pub value: String,
    /// left, top, right, bottom as fractions of the page.
    pub bounds: Option<[f32; 4]>,
}

#[derive(Clone, Debug, Default)]
pub struct PageText {
    pub page: Option<i64>,
    pub chars: Vec<TextChar>,
}

impl PageText {
    pub fn plain(text: String) -> Self {
        Self { page: None, chars: text.chars().map(|c| TextChar { value: c.to_string(), bounds: None }).collect() }
    }
}

/// A paragraph: its text and the glyph ranges (one per line) it came from.
#[derive(Clone, Debug)]
struct Paragraph {
    text: String,
    glyphs: Vec<Range<usize>>,
    heading: bool,
}

pub fn chunk_pages(pages: &[PageText]) -> Vec<ChunkInput> {
    let mut out = Vec::new();
    for page in pages {
        let geometric = page.chars.iter().any(|c| c.bounds.is_some());
        let paragraphs = if geometric { pdf_paragraphs(&page.chars) } else { text_paragraphs(&page.chars) };
        for (text, ranges) in group(paragraphs) {
            let glyphs: Vec<&TextChar> = ranges.iter().flat_map(|r| page.chars[r.clone()].iter()).collect();
            out.push(ChunkInput { page: page.page, rects: line_rects(&glyphs), text, ..Default::default() });
        }
    }
    out
}

// ── Lines and paragraphs from geometry ─────────────────────

#[derive(Clone, Debug)]
struct Line {
    glyphs: Range<usize>,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}
impl Line {
    fn height(&self) -> f32 {
        (self.bottom - self.top).max(0.0005)
    }
}

fn lines(chars: &[TextChar]) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut start = 0;
    let mut current: Option<[f32; 4]> = None;
    for (index, glyph) in chars.iter().enumerate() {
        let Some([left, top, right, bottom]) = glyph.bounds else { continue };
        if glyph.value.trim().is_empty() {
            continue;
        }
        let breaks = match current {
            None => false,
            Some([l, t, _, b]) => {
                let height = (b - t).max(bottom - top).max(0.0005);
                let centre = (top + bottom) / 2.0;
                // A new baseline, or a jump back to the left edge on the same band.
                (centre - (t + b) / 2.0).abs() > height * 0.6 || left < l - height * 6.0 && (centre - (t + b) / 2.0).abs() > height * 0.2
            }
        };
        if breaks {
            if let Some([l, t, r, b]) = current.take() {
                lines.push(Line { glyphs: start..index, left: l, top: t, right: r, bottom: b });
            }
            start = index;
        }
        current = Some(match current {
            None => [left, top, right, bottom],
            Some([l, t, r, b]) => [l.min(left), t.min(top), r.max(right), b.max(bottom)],
        });
    }
    if let Some([l, t, r, b]) = current {
        lines.push(Line { glyphs: start..chars.len(), left: l, top: t, right: r, bottom: b });
    }
    lines
}

fn text_of(chars: &[TextChar], range: Range<usize>) -> String {
    let text: String = chars[range].iter().map(|c| c.value.as_str()).collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn pdf_paragraphs(chars: &[TextChar]) -> Vec<Paragraph> {
    let all = lines(chars);
    // Running headers, footers and page numbers sit at the page edges and are short.
    let lines: Vec<&Line> = all
        .iter()
        .filter(|l| {
            let text = text_of(chars, l.glyphs.clone());
            let edge = l.bottom < 0.07 || l.top > 0.94;
            !(edge && text.chars().count() < 90) && text.chars().any(char::is_alphanumeric)
        })
        .collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut heights: Vec<f32> = lines.iter().map(|l| l.height()).collect();
    heights.sort_by(f32::total_cmp);
    let body = heights[heights.len() / 2];
    let mut gaps: Vec<f32> = lines.windows(2).map(|w| w[1].top - w[0].bottom).filter(|g| *g > 0.0 && *g < body * 3.0).collect();
    gaps.sort_by(f32::total_cmp);
    let line_gap = gaps.get(gaps.len() / 2).copied().unwrap_or(body * 0.3);
    let column_right = lines.iter().map(|l| l.right).fold(0.0, f32::max);

    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let mut current: Vec<&Line> = Vec::new();
    let flush = |current: &mut Vec<&Line>, paragraphs: &mut Vec<Paragraph>| {
        if current.is_empty() {
            return;
        }
        let mut text = String::new();
        for line in current.iter() {
            let piece = text_of(chars, line.glyphs.clone());
            if text.ends_with('-') && piece.chars().next().is_some_and(char::is_lowercase) {
                text.pop(); // A word hyphenated across lines.
            } else if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&piece);
        }
        let height = current.iter().map(|l| l.height()).fold(0.0, f32::max);
        let heading = current.len() <= 2
            && text.chars().count() < 120
            && !text.ends_with(['.', ',', ';'])
            && (height > body * 1.15 || text.chars().filter(|c| c.is_alphabetic()).all(char::is_uppercase));
        paragraphs.push(Paragraph { glyphs: current.iter().map(|l| l.glyphs.clone()).collect(), text, heading });
        current.clear();
    };
    for line in lines {
        if let Some(previous) = current.last() {
            let gap = line.top - previous.bottom;
            let size_change = (line.height() - previous.height()).abs() > body * 0.25;
            let new_column = line.top < previous.top - body;
            let wide_gap = gap > line_gap + body * 0.55;
            let indented = line.left > previous.left + body * 0.8 && line.left - previous.left < 0.12;
            let previous_text = text_of(chars, previous.glyphs.clone());
            let ended = previous_text.ends_with(['.', '?', '!', ':', '"', '\u{201d}']) && previous.right < column_right - 0.06;
            if new_column || wide_gap || size_change || indented || ended {
                flush(&mut current, &mut paragraphs);
            }
        }
        current.push(line);
    }
    flush(&mut current, &mut paragraphs);
    paragraphs
}

/// Plain text (HTML snapshots, notes): blank lines or single newlines separate paragraphs.
fn text_paragraphs(chars: &[TextChar]) -> Vec<Paragraph> {
    let mut paragraphs = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index <= chars.len() {
        let at_break = index == chars.len() || chars[index].value == "\n";
        if at_break {
            let text = text_of(chars, start..index);
            if text.chars().any(char::is_alphanumeric) {
                let heading = text.chars().count() < 80 && !text.ends_with(['.', ',', ';', ':']);
                paragraphs.push(Paragraph { text, glyphs: vec![start..index], heading });
            }
            start = index + 1;
        }
        index += 1;
    }
    paragraphs
}

// ── Grouping paragraphs into chunks ────────────────────────

fn group(paragraphs: Vec<Paragraph>) -> Vec<(String, Vec<Range<usize>>)> {
    let mut chunks: Vec<(String, Vec<Range<usize>>)> = Vec::new();
    let mut text = String::new();
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut pending_heading = false;
    for paragraph in paragraphs {
        let fits = text.len() + paragraph.text.len() <= TARGET_CHARS;
        // Close the chunk unless it is still short or only holds a heading for this paragraph.
        if !text.is_empty() && !pending_heading && (text.len() >= MIN_CHARS || !fits) {
            chunks.extend(split(std::mem::take(&mut text), std::mem::take(&mut ranges)));
        }
        if !text.is_empty() {
            text.push_str(if pending_heading { ": " } else { " " });
        }
        text.push_str(&paragraph.text);
        ranges.extend(paragraph.glyphs);
        pending_heading = paragraph.heading;
    }
    if !text.is_empty() {
        chunks.extend(split(text, ranges));
    }
    chunks.retain(|(text, _)| text.chars().filter(|c| c.is_alphanumeric()).count() >= 20);
    chunks
}

/// Splits an overlong paragraph at sentence ends; geometry stays with every piece.
fn split(text: String, ranges: Vec<Range<usize>>) -> Vec<(String, Vec<Range<usize>>)> {
    if text.len() <= MAX_CHARS {
        return vec![(text, ranges)];
    }
    let mut pieces = Vec::new();
    let mut piece = String::new();
    for sentence in sentences(&text) {
        if !piece.is_empty() && piece.len() + sentence.len() > TARGET_CHARS {
            pieces.push(std::mem::take(&mut piece));
        }
        piece.push_str(sentence);
    }
    if !piece.trim().is_empty() {
        pieces.push(piece);
    }
    // Each piece highlights the lines proportional to its share of the paragraph.
    let total: usize = pieces.iter().map(String::len).sum::<usize>().max(1);
    let mut used = 0;
    let mut out = Vec::new();
    for piece in pieces {
        let from = used * ranges.len() / total;
        used += piece.len();
        let to = (used * ranges.len()).div_ceil(total).clamp(from + 1, ranges.len().max(1));
        out.push((piece.trim().to_string(), ranges.get(from..to.min(ranges.len())).map(<[_]>::to_vec).unwrap_or_default()));
    }
    out
}

pub(crate) fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (index, c) in text.char_indices() {
        if matches!(c, '.' | '?' | '!') && bytes.get(index + 1) == Some(&b' ') && bytes.get(index + 2).is_some_and(|b| b.is_ascii_uppercase()) {
            out.push(&text[start..=index + 1]);
            start = index + 2;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// Merges character boxes into one rectangle per text line, on a 0..65535 page scale.
fn line_rects(glyphs: &[&TextChar]) -> Vec<[u16; 4]> {
    let mut lines: Vec<[f32; 4]> = Vec::new();
    for bounds in glyphs.iter().filter_map(|g| g.bounds) {
        let [left, top, right, bottom] = bounds;
        let height = (bottom - top).abs().max(0.001);
        match lines.last_mut() {
            Some(line) if (line[1] - top).abs() < height * 0.6 && left >= line[0] - height => {
                line[0] = line[0].min(left);
                line[1] = line[1].min(top);
                line[2] = line[2].max(right);
                line[3] = line[3].max(bottom);
            }
            _ => lines.push([left, top, right, bottom]),
        }
    }
    let scale = |v: f32| (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
    lines
        .into_iter()
        .filter(|l| l[2] > l[0] && l[3] > l[1])
        .map(|[l, t, r, b]| [scale(l), scale(t), scale(r - l), scale(b - t)])
        .collect()
}

/// Readable text from an HTML snapshot: drops scripts, styles and markup, keeping
/// block boundaries as newlines so paragraphs survive.
pub fn html_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut index = 0;
    while index < html.len() {
        if html.as_bytes()[index] == b'<' {
            for skip in ["script", "style", "noscript", "svg", "nav", "footer"] {
                if lower[index + 1..].starts_with(skip) {
                    if let Some(close) = lower[index..].find(&format!("</{skip}")) {
                        index += close;
                    }
                }
            }
            match html[index..].find('>') {
                Some(close) => {
                    let tag = &lower[index + 1..index + close];
                    if ["p", "br", "div", "li", "h1", "h2", "h3", "h4", "h5", "tr", "section", "article", "blockquote"]
                        .iter()
                        .any(|t| tag.trim_start_matches('/').starts_with(t))
                    {
                        out.push('\n');
                    }
                    index += close + 1;
                }
                None => break,
            }
        } else {
            let next = html[index..].find('<').map(|n| index + n).unwrap_or(html.len());
            out.push_str(&html[index..next]);
            index = next;
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lays out text as a page: one line per `\n`, with `gap` extra space before blank-line paragraphs.
    fn page(lines: &[(&str, f32, f32)]) -> PageText {
        let mut chars = Vec::new();
        for (line, (text, top, left)) in lines.iter().enumerate() {
            for (i, c) in text.chars().enumerate() {
                let x = left + i as f32 * 0.008;
                chars.push(TextChar { value: c.to_string(), bounds: Some([x, *top, x + 0.007, top + 0.012]) });
            }
            if line + 1 < lines.len() {
                chars.push(TextChar { value: " ".into(), bounds: None });
            }
        }
        PageText { page: Some(0), chars }
    }

    #[test]
    fn chunks_follow_paragraphs_and_headings() {
        let long = "Respondents traded off health against income in every country we studied and the pattern held.";
        let p = page(&[
            ("Running head", 0.03, 0.1),
            ("RESULTS", 0.10, 0.1),
            (long, 0.13, 0.1),
            ("Second line of the first para-", 0.145, 0.1),
            ("graph continues without a break here.", 0.16, 0.1),
            (long, 0.20, 0.13),
            ("A second paragraph line that ends the block.", 0.215, 0.1),
            ("7", 0.97, 0.5),
        ]);
        let chunks = chunk_pages(&[p]);
        let text: Vec<&str> = chunks.iter().map(|c| c.text.as_str()).collect();
        assert!(!text.iter().any(|t| t.contains("Running head") || t.ends_with(" 7")), "{text:?}");
        assert!(text[0].starts_with("RESULTS: Respondents"), "{text:?}");
        assert!(text[0].contains("paragraph continues"), "{text:?}");
        assert!(chunks.iter().all(|c| !c.rects.is_empty()));
    }

    #[test]
    fn splits_only_overlong_paragraphs_at_sentences() {
        let sentence = "Income matters for health. ";
        let plain = PageText::plain(format!("{}\nShort closing paragraph that stands alone and is long enough to keep.", sentence.repeat(140)));
        let chunks = chunk_pages(&[plain]);
        assert!(chunks.len() >= 3);
        assert!(chunks.iter().all(|c| c.text.len() <= MAX_CHARS), "{:?}", chunks.iter().map(|c| c.text.len()).collect::<Vec<_>>());
        assert!(chunks[0].text.ends_with('.'));
        let html = html_text("<p>A&amp;B</p><script>x()</script><div>C</div>");
        assert_eq!(html.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>(), ["A&B", "C"]);
    }
}
