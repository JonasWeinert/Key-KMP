use std::collections::HashSet;

use crate::model::{BBox, Block, Page};

/// Recover algorithm/pseudocode containers before equation recognition.  A
/// formula-like assignment inside pseudocode is still part of the algorithm;
/// callers can inspect its constituent lines without promoting it to a display
/// equation.
pub(crate) fn recognize_algorithms(pages: &mut [Page]) {
    for page in pages {
        let headers = page
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| algorithm_title(&block.text()).map(|title| (index, title)))
            .collect::<Vec<_>>();
        if headers.is_empty() {
            continue;
        }

        let mut consumed = HashSet::new();
        let mut replacements = Vec::new();
        for (header_index, title) in headers {
            if consumed.contains(&header_index) {
                continue;
            }
            let header = page.blocks[header_index].bbox();
            let (left, right) = column_band(header, &page.blocks, page.width);
            let next_header_y = page
                .blocks
                .iter()
                .enumerate()
                .filter(|(index, block)| {
                    *index != header_index
                        && algorithm_title(&block.text()).is_some()
                        && block.bbox().y > header.y + 4.0
                        && block.bbox().center_x() >= left
                        && block.bbox().center_x() <= right
                })
                .map(|(_, block)| block.bbox().y)
                .min_by(f32::total_cmp);

            let mut candidates = page
                .blocks
                .iter()
                .enumerate()
                .filter(|(index, block)| {
                    if consumed.contains(index) {
                        return false;
                    }
                    let bbox = block.bbox();
                    bbox.y + 2.0 >= header.y
                        && bbox.y < next_header_y.unwrap_or(page.height)
                        && bbox.center_x() >= left
                        && bbox.center_x() <= right
                        && bbox.x < right
                        && bbox.right() > left
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            candidates.sort_by(|a, b| {
                page.blocks[*a]
                    .bbox()
                    .y
                    .total_cmp(&page.blocks[*b].bbox().y)
                    .then(
                        page.blocks[*a]
                            .bbox()
                            .x
                            .total_cmp(&page.blocks[*b].bbox().x),
                    )
            });
            if candidates.len() < 3 {
                continue;
            }

            let mut selected = Vec::new();
            let mut last_bottom = header.bottom();
            let mut evidence = 0usize;
            for index in candidates {
                let block = &page.blocks[index];
                let bbox = block.bbox();
                let gap = bbox.y - last_bottom;
                let text = block.text();
                if !selected.is_empty() && gap > 28.0 {
                    break;
                }
                if !selected.is_empty() && gap > 15.0 && looks_like_prose_start(&text) {
                    break;
                }
                if pseudocode_signal(&text, bbox, left) {
                    evidence += 1;
                }
                selected.push(index);
                last_bottom = last_bottom.max(bbox.bottom());
            }
            if evidence < 2 || selected.len() < 3 {
                continue;
            }
            let bbox = selected
                .iter()
                .map(|index| page.blocks[*index].bbox())
                .reduce(BBox::union)
                .unwrap();
            let lines = selected
                .iter()
                .flat_map(|index| block_lines(&page.blocks[*index]))
                .collect::<Vec<_>>();
            let text = selected
                .iter()
                .map(|index| page.blocks[*index].text())
                .collect::<Vec<_>>()
                .join("\n");
            let insert_at = *selected.iter().min().unwrap();
            consumed.extend(selected);
            replacements.push((
                insert_at,
                Block::Algorithm {
                    bbox,
                    title,
                    text,
                    lines,
                },
            ));
        }

        if replacements.is_empty() {
            continue;
        }
        let mut rebuilt = Vec::new();
        for (index, block) in std::mem::take(&mut page.blocks).into_iter().enumerate() {
            if let Some((_, replacement)) = replacements.iter().find(|(at, _)| *at == index) {
                rebuilt.push(replacement.clone());
            }
            if !consumed.contains(&index) {
                rebuilt.push(block);
            }
        }
        page.blocks = rebuilt;
    }
}

fn algorithm_title(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower.strip_prefix("algorithm ")?;
    let token = rest
        .split_whitespace()
        .next()?
        .trim_matches(|ch: char| matches!(ch, ':' | '.' | ')'));
    (!token.is_empty()
        && token
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch.is_ascii_alphabetic()))
    .then(|| {
        let first_line = trimmed.lines().next().unwrap_or(trimmed);
        first_line
            .find(". ")
            .map_or(first_line, |end| &first_line[..=end])
            .to_owned()
    })
}

fn column_band(header: BBox, blocks: &[Block], page_width: f32) -> (f32, f32) {
    let mut header_centers = blocks
        .iter()
        .filter(|block| algorithm_title(&block.text()).is_some())
        .map(|block| block.bbox().center_x())
        .collect::<Vec<_>>();
    header_centers.sort_by(f32::total_cmp);
    let center = header.center_x();
    let left_neighbor = header_centers
        .iter()
        .copied()
        .filter(|x| *x < center - 20.0)
        .max_by(f32::total_cmp);
    let right_neighbor = header_centers
        .iter()
        .copied()
        .filter(|x| *x > center + 20.0)
        .min_by(f32::total_cmp);
    let left = left_neighbor.map_or(0.0, |x| (x + center) / 2.0);
    let right = right_neighbor.map_or(page_width, |x| (x + center) / 2.0);
    (left, right)
}

fn pseudocode_signal(text: &str, bbox: BBox, left: f32) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    let keyword = [
        "input",
        "output",
        "require",
        "ensure",
        "procedure",
        "for ",
        "while ",
        "repeat",
        "until",
        "return",
        "if ",
        "else",
        "end ",
    ]
    .iter()
    .any(|needle| lower.starts_with(needle));
    let line_number = lower.len() <= 3 && lower.chars().all(|ch| ch.is_ascii_digit());
    let assignment = text.contains('=') || text.contains('←') || text.contains(":=");
    keyword || line_number || assignment || bbox.x - left < 22.0
}

fn looks_like_prose_start(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.split_whitespace().count() >= 12
        && trimmed.ends_with('.')
        && !pseudocode_signal(
            trimmed,
            BBox {
                x: 100.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            0.0,
        )
}

fn block_lines(block: &Block) -> Vec<crate::model::TextLine> {
    match block {
        Block::Paragraph { lines, .. }
        | Block::Heading { lines, .. }
        | Block::Equation { lines, .. } => lines.clone(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_numbered_algorithm_titles() {
        assert!(algorithm_title("Algorithm 1: Selection").is_some());
        assert!(algorithm_title("Algorithm A. Mutation").is_some());
        assert!(algorithm_title("Algorithmic fairness").is_none());
        assert_eq!(
            algorithm_title("Algorithm 1: Selection. 1 Procedure choose(x)").as_deref(),
            Some("Algorithm 1: Selection.")
        );
    }
}
