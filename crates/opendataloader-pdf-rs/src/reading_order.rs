use crate::model::{BBox, Block};

const MIN_GAP: f32 = 5.0;
const MIN_COLUMN_GUTTER: f32 = 2.0;
const NARROW_RATIO: f32 = 0.1;

pub fn xy_cut_plus_plus(blocks: Vec<Block>) -> Vec<Block> {
    if blocks.len() <= 1 {
        return blocks;
    }
    // Java's production default beta is 2.0, which effectively disables
    // cross-layout masking. Keep parity and retain the machinery in tests.
    recursive(blocks)
}

fn recursive(blocks: Vec<Block>) -> Vec<Block> {
    if blocks.len() <= 1 {
        return blocks;
    }
    let h = best_horizontal_cut(&blocks);
    let v = best_vertical_cut(&blocks);
    let supported_column_cut = is_supported_column_cut(&blocks, v);
    let horizontal = match (h.1 >= MIN_GAP, v.1 >= MIN_GAP || supported_column_cut) {
        // Once a region consists of parallel text columns, preserve the
        // column before considering larger paragraph gaps within each side.
        // This matters for tightly typeset journals whose gutter is only a
        // few PDF points wide.
        (true, true) if supported_column_cut => false,
        (true, true) => h.1 > v.1,
        (true, false) => true,
        (false, true) => false,
        (false, false) => return sort_yx(blocks),
    };
    let (position, _) = if horizontal { h } else { v };
    let (mut before, mut after) = (Vec::new(), Vec::new());
    for block in blocks {
        let bbox = block.bbox();
        if (horizontal && bbox.center_y() <= position)
            || (!horizontal && bbox.center_x() <= position)
        {
            before.push(block);
        } else {
            after.push(block);
        }
    }
    if before.is_empty() || after.is_empty() {
        before.extend(after);
        return sort_yx(before);
    }
    let mut result = recursive(before);
    result.extend(recursive(after));
    result
}

fn is_supported_column_cut(blocks: &[Block], cut: (f32, f32)) -> bool {
    let (position, gap) = cut;
    if gap < MIN_COLUMN_GUTTER || blocks.len() < 6 {
        return false;
    }
    let region = bounds(blocks);
    if position - region.x < region.width * 0.16 || region.right() - position < region.width * 0.16
    {
        return false;
    }
    // A title, abstract, or other substantial spanning block means this
    // region must first be separated horizontally. Very narrow ornaments and
    // page furniture are intentionally ignored here.
    if blocks.iter().any(|block| {
        let bbox = block.bbox();
        bbox.x < position && bbox.right() > position && bbox.width >= region.width * 0.25
    }) {
        return false;
    }
    let left: Vec<BBox> = blocks
        .iter()
        .map(Block::bbox)
        .filter(|bbox| bbox.center_x() <= position)
        .collect();
    let right: Vec<BBox> = blocks
        .iter()
        .map(Block::bbox)
        .filter(|bbox| bbox.center_x() > position)
        .collect();
    if left.len() < 3 || right.len() < 3 {
        return false;
    }
    let left_bounds = left.into_iter().reduce(BBox::union).unwrap_or_default();
    let right_bounds = right.into_iter().reduce(BBox::union).unwrap_or_default();
    let overlap = (left_bounds.bottom().min(right_bounds.bottom())
        - left_bounds.y.max(right_bounds.y))
    .max(0.0);
    overlap >= left_bounds.height.min(right_bounds.height) * 0.35
}

fn best_vertical_cut(blocks: &[Block]) -> (f32, f32) {
    let normal = vertical_edges(blocks);
    if normal.1 >= MIN_GAP || blocks.len() < 3 {
        return normal;
    }
    let region = bounds(blocks);
    let filtered: Vec<Block> = blocks
        .iter()
        .filter(|b| b.bbox().width >= region.width * NARROW_RATIO)
        .cloned()
        .collect();
    if filtered.len() >= 2 && filtered.len() < blocks.len() {
        let candidate = vertical_edges(&filtered);
        if candidate.1 > normal.1 && candidate.1 >= MIN_GAP {
            return candidate;
        }
    }
    normal
}

fn vertical_edges(blocks: &[Block]) -> (f32, f32) {
    let mut boxes: Vec<BBox> = blocks.iter().map(Block::bbox).collect();
    boxes.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.right().total_cmp(&b.right())));
    let (mut previous_right, mut best) = (None::<f32>, (0.0, 0.0));
    for bbox in boxes {
        if let Some(right) = previous_right {
            let gap = bbox.x - right;
            if gap > best.1 {
                best = ((bbox.x + right) * 0.5, gap);
            }
            previous_right = Some(right.max(bbox.right()));
        } else {
            previous_right = Some(bbox.right());
        }
    }
    best
}

fn best_horizontal_cut(blocks: &[Block]) -> (f32, f32) {
    let mut boxes: Vec<BBox> = blocks.iter().map(Block::bbox).collect();
    boxes.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.bottom().total_cmp(&b.bottom())));
    let (mut previous_bottom, mut best) = (None::<f32>, (0.0, 0.0));
    for bbox in boxes {
        if let Some(bottom) = previous_bottom {
            let gap = bbox.y - bottom;
            if gap > best.1 {
                best = ((bbox.y + bottom) * 0.5, gap);
            }
            previous_bottom = Some(bottom.max(bbox.bottom()));
        } else {
            previous_bottom = Some(bbox.bottom());
        }
    }
    best
}

fn bounds(blocks: &[Block]) -> BBox {
    blocks
        .iter()
        .map(Block::bbox)
        .reduce(BBox::union)
        .unwrap_or_default()
}

fn sort_yx(mut blocks: Vec<Block>) -> Vec<Block> {
    blocks.sort_by(|a, b| {
        a.bbox()
            .y
            .total_cmp(&b.bbox().y)
            .then(a.bbox().x.total_cmp(&b.bbox().x))
    });
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TextLine;
    fn p(text: &str, x: f32, y: f32, width: f32) -> Block {
        Block::Paragraph {
            bbox: BBox {
                x,
                y,
                width,
                height: 10.0,
            },
            text: text.into(),
            lines: Vec::<TextLine>::new(),
        }
    }
    #[test]
    fn orders_two_columns_column_first() {
        let blocks = vec![
            p("r1", 310.0, 10.0, 100.0),
            p("l2", 10.0, 40.0, 100.0),
            p("r2", 310.0, 40.0, 100.0),
            p("l1", 10.0, 10.0, 100.0),
        ];
        let texts: Vec<String> = xy_cut_plus_plus(blocks).iter().map(Block::text).collect();
        assert_eq!(texts, ["l1", "l2", "r1", "r2"]);
    }
    #[test]
    fn wide_title_precedes_columns() {
        let blocks = vec![
            p("right", 310.0, 80.0, 100.0),
            p("title", 10.0, 5.0, 500.0),
            p("left", 10.0, 80.0, 100.0),
        ];
        let texts: Vec<String> = xy_cut_plus_plus(blocks).iter().map(Block::text).collect();
        assert_eq!(texts, ["title", "left", "right"]);
    }

    #[test]
    fn narrow_supported_gutter_beats_paragraph_gaps() {
        let blocks = vec![
            p("l1", 10.0, 10.0, 137.0),
            p("l2", 10.0, 34.0, 137.0),
            p("l3", 10.0, 58.0, 137.0),
            p("r1", 150.0, 10.0, 137.0),
            p("r2", 150.0, 34.0, 137.0),
            p("r3", 150.0, 58.0, 137.0),
        ];
        let texts: Vec<String> = xy_cut_plus_plus(blocks).iter().map(Block::text).collect();
        assert_eq!(texts, ["l1", "l2", "l3", "r1", "r2", "r3"]);
    }
}
