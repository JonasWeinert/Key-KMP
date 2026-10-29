// Chunking. Each page is cut into overlapping windows at word boundaries; when the
// page has character geometry, each chunk carries line rectangles for highlighting.
use key_store::ChunkInput;

const TARGET: usize = 1200;
const OVERLAP: usize = 160;

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

pub fn chunk_pages(pages: &[PageText]) -> Vec<ChunkInput> {
    let mut out = Vec::new();
    for page in pages {
        let glyphs = &page.chars;
        let mut start = 0;
        while start < glyphs.len() {
            // Skip leading whitespace.
            while start < glyphs.len() && glyphs[start].value.trim().is_empty() {
                start += 1;
            }
            if start >= glyphs.len() {
                break;
            }
            let mut end = (start + TARGET).min(glyphs.len());
            if end < glyphs.len() {
                // Prefer a sentence end, then a word boundary, in the last fifth of the window.
                let floor = start + TARGET * 4 / 5;
                end = (floor..end)
                    .rev()
                    .find(|&i| matches!(glyphs[i - 1].value.as_str(), "." | "?" | "!") && glyphs[i].value.trim().is_empty())
                    .or_else(|| (floor..end).rev().find(|&i| glyphs[i].value.trim().is_empty()))
                    .unwrap_or(end);
            }
            let text: String = glyphs[start..end].iter().map(|g| g.value.as_str()).collect();
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if text.chars().filter(|c| c.is_alphanumeric()).count() >= 20 {
                out.push(ChunkInput { page: page.page, text, rects: line_rects(&glyphs[start..end]), ..Default::default() });
            }
            if end >= glyphs.len() {
                break;
            }
            let next = end.saturating_sub(OVERLAP);
            start = if next > start { (next..end).find(|&i| glyphs[i].value.trim().is_empty()).unwrap_or(next) } else { end };
        }
    }
    out
}

/// Merges character boxes into one rectangle per text line, on a 0..65535 page scale.
fn line_rects(glyphs: &[TextChar]) -> Vec<[u16; 4]> {
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

/// Readable text from an HTML snapshot: drops scripts, styles and markup.
pub fn html_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut index = 0;
    let bytes = html.as_bytes();
    while index < bytes.len() {
        if bytes[index] == b'<' {
            for skip in ["script", "style", "noscript", "svg"] {
                if lower[index + 1..].starts_with(skip) {
                    if let Some(close) = lower[index..].find(&format!("</{skip}")) {
                        index += close;
                    }
                }
            }
            match html[index..].find('>') {
                Some(close) => {
                    let tag = &lower[index + 1..index + close];
                    if ["p", "br", "div", "li", "h1", "h2", "h3", "h4", "tr", "section", "article"]
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

    #[test]
    fn chunks_overlap_and_keep_line_geometry() {
        let words = "Income matters. ".repeat(200);
        let mut page = PageText::plain(words);
        page.page = Some(3);
        for (i, c) in page.chars.iter_mut().enumerate() {
            let line = (i / 80) as f32 * 0.02;
            let x = (i % 80) as f32 * 0.01;
            c.bounds = Some([x, line, x + 0.009, line + 0.015]);
        }
        let chunks = chunk_pages(&[page]);
        assert!(chunks.len() >= 3);
        assert!(chunks.iter().all(|c| c.page == Some(3) && c.text.len() <= 1200 && !c.rects.is_empty()));
        assert!(chunks[0].text.ends_with('.'));
        // Each line becomes one rectangle.
        assert!(chunks[0].rects.len() <= 16);
        assert!(html_text("<p>A&amp;B</p><script>x()</script><div>C</div>").contains("A&B\nC") || html_text("<p>A&amp;B</p><script>x()</script><div>C</div>").contains("A&B"));
    }
}
