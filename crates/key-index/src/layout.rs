// Chunks from document layout analysis. The analyser has already found the blocks
// (paragraphs, lists, tables, headings, running headers …) in reading order, with
// sentence geometry; here they become passages that stay inside one page and one
// section, skip page furniture and the bibliography, and keep their rectangles.
use key_store::ChunkInput;
use serde::{Deserialize, Serialize};

/// Merging stops once a passage reaches this size.
const TARGET_CHARS: usize = 1400;
/// Blocks longer than this are split at sentences.
const MAX_CHARS: usize = 2400;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSentence {
    pub text: String,
    /// [x, y, width, height] on a 0..65535 page scale.
    pub rects: Vec<[u16; 4]>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBlock {
    /// Zero-based page.
    pub page: i64,
    /// paragraph | heading | list | table | equation | algorithm | header | footer |
    /// page_number | reference_list | footnote | endnote_list
    pub kind: String,
    pub text: String,
    pub bounds: [u16; 4],
    pub sentences: Vec<LayoutSentence>,
}

/// A document as layout analysis sees it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// layout-onnx when the layout model ran, layout for geometry and structure only.
    pub engine: String,
    pub page_count: usize,
    pub markdown: String,
    pub blocks: Vec<LayoutBlock>,
}

fn indexed(kind: &str) -> bool {
    !matches!(kind, "header" | "footer" | "page_number" | "reference_list" | "heading")
}

pub fn chunk_layout(blocks: &[LayoutBlock]) -> Vec<ChunkInput> {
    chunk_blocks(blocks, true)
}

/// Blocks to passages. With `merge`, short prose blocks join their neighbours; without it
/// every block is its own passage (notes, whose passages must not shift when one changes).
pub(crate) fn chunk_blocks(blocks: &[LayoutBlock], merge: bool) -> Vec<ChunkInput> {
    let mut out: Vec<ChunkInput> = Vec::new();
    let mut section: Option<String> = None;
    let mut open: Option<ChunkInput> = None;
    let close = |open: &mut Option<ChunkInput>, out: &mut Vec<ChunkInput>| {
        if let Some(chunk) = open.take() {
            if chunk.text.chars().any(char::is_alphanumeric) {
                out.push(chunk);
            }
        }
    };
    for block in blocks {
        if block.kind == "heading" {
            close(&mut open, &mut out);
            let heading = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
            section = (!heading.is_empty()).then_some(heading);
            continue;
        }
        if !indexed(&block.kind) {
            continue;
        }
        let text = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        // Tables, equations and the like stand alone; prose merges with its neighbours.
        let prose = matches!(block.kind.as_str(), "paragraph" | "list" | "footnote");
        let fits = merge && open.as_ref().is_some_and(|c| {
            c.page == Some(block.page) && c.kind.as_deref().is_some_and(|k| prose && matches!(k, "paragraph" | "list" | "footnote")) && c.text.len() + text.len() < TARGET_CHARS
        });
        if !fits {
            close(&mut open, &mut out);
        }
        if text.len() > MAX_CHARS && block.sentences.len() > 1 {
            close(&mut open, &mut out);
            for chunk in split_sentences(block, &section) {
                out.push(chunk);
            }
            continue;
        }
        let rects = block_rects(block);
        match open.as_mut() {
            Some(chunk) => {
                chunk.text.push('\n');
                chunk.text.push_str(&text);
                chunk.rects.extend(rects);
            }
            None => {
                open = Some(ChunkInput {
                    page: Some(block.page),
                    text,
                    rects,
                    kind: Some(block.kind.clone()),
                    section: section.clone(),
                    ..Default::default()
                })
            }
        }
    }
    close(&mut open, &mut out);
    out
}

fn block_rects(block: &LayoutBlock) -> Vec<[u16; 4]> {
    let rects: Vec<[u16; 4]> = block.sentences.iter().flat_map(|s| s.rects.iter().copied()).collect();
    if rects.is_empty() { vec![block.bounds] } else { rects }
}

fn split_sentences(block: &LayoutBlock, section: &Option<String>) -> Vec<ChunkInput> {
    let mut out = Vec::new();
    let mut current = ChunkInput { page: Some(block.page), kind: Some(block.kind.clone()), section: section.clone(), ..Default::default() };
    for sentence in &block.sentences {
        let text = sentence.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !current.text.is_empty() && current.text.len() + text.len() > TARGET_CHARS {
            out.push(std::mem::replace(
                &mut current,
                ChunkInput { page: Some(block.page), kind: Some(block.kind.clone()), section: section.clone(), ..Default::default() },
            ));
        }
        if !current.text.is_empty() {
            current.text.push(' ');
        }
        current.text.push_str(&text);
        current.rects.extend(sentence.rects.iter().copied());
    }
    if !current.text.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(page: i64, kind: &str, text: &str) -> LayoutBlock {
        LayoutBlock { page, kind: kind.into(), text: text.into(), bounds: [1, 2, 3, 4], sentences: Vec::new() }
    }

    #[test]
    fn keeps_sections_and_drops_page_furniture() {
        let blocks = vec![
            block(0, "header", "Journal of Things 12"),
            block(0, "heading", "1 Introduction"),
            block(0, "paragraph", "Health and income move together."),
            block(0, "paragraph", "We study why."),
            block(0, "table", "Year Income 2020 10"),
            block(0, "page_number", "3"),
            block(1, "heading", "References"),
            block(1, "reference_list", "[1] Someone. A paper. 2020."),
        ];
        let chunks = chunk_layout(&blocks);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, "Health and income move together.\nWe study why.");
        assert_eq!(chunks[0].section.as_deref(), Some("1 Introduction"));
        assert_eq!(chunks[0].rects, vec![[1, 2, 3, 4], [1, 2, 3, 4]]);
        assert_eq!(chunks[1].kind.as_deref(), Some("table"));
        assert!(chunks.iter().all(|c| !c.text.contains("Journal of Things") && !c.text.contains("Someone")));
    }

    #[test]
    fn never_crosses_pages_and_splits_long_blocks_at_sentences() {
        let sentence = |t: &str| LayoutSentence { text: t.into(), rects: vec![[9, 9, 9, 9]] };
        let long = LayoutBlock {
            page: 1,
            kind: "paragraph".into(),
            text: "x. ".repeat(1000),
            bounds: [0; 4],
            sentences: (0..40).map(|_| sentence(&"Income matters for health in many ways. ".repeat(2))).collect(),
        };
        let chunks = chunk_layout(&[block(0, "paragraph", "First page."), block(1, "paragraph", "Second page."), long]);
        assert_eq!(chunks[0].page, Some(0));
        assert_eq!(chunks[1].page, Some(1));
        assert!(chunks.len() > 3);
        assert!(chunks[2..].iter().all(|c| c.text.len() <= TARGET_CHARS + 100 && c.rects.iter().all(|r| *r == [9, 9, 9, 9])));
    }
}
