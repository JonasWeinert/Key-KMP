use std::collections::{HashMap, HashSet};

use crate::metrics::Profiler;
use crate::model::{BBox, Block, Page, Rule, TableCell, TextLine};
use crate::reading_order::xy_cut_plus_plus;

const TRACK_TOLERANCE: f32 = 6.0;
type TextFragment = (f32, f32, String);

pub struct ReconstructedPage {
    pub blocks: Vec<Block>,
    pub source_lines: Vec<TextLine>,
}

/// Links high-confidence geometric table fragments across adjacent pages.
/// This intentionally records continuity instead of physically merging page
/// blocks. Tagged/XML reconciliation can subsequently replace the provisional
/// `geo-chain:` identity with a stronger semantic identity.
pub fn reconcile_geometry_table_continuations(pages: &mut [Page]) {
    let mut chain = 0usize;
    for page_index in 0..pages.len().saturating_sub(1) {
        if pages[page_index + 1].number != pages[page_index].number + 1 {
            continue;
        }
        let (before, after) = pages.split_at_mut(page_index + 1);
        let previous = &mut before[page_index];
        let next = &mut after[0];
        let Some(previous_index) = edge_table_index(previous, false) else {
            continue;
        };
        let Some(next_index) = edge_table_index(next, true) else {
            continue;
        };
        let score = table_continuation_score(
            &previous.blocks[previous_index],
            previous.width,
            previous.height,
            &next.blocks[next_index],
            next.width,
            next.height,
        );
        if score < 4 {
            continue;
        }
        let inherited_id = match &previous.blocks[previous_index] {
            Block::Table {
                semantic_table_id, ..
            } => semantic_table_id.clone(),
            _ => None,
        };
        let id = inherited_id.unwrap_or_else(|| {
            chain += 1;
            format!("geo-chain:{chain}")
        });
        if let Block::Table {
            semantic_table_id,
            continues_on_next_page,
            ..
        } = &mut previous.blocks[previous_index]
        {
            *semantic_table_id = Some(id.clone());
            *continues_on_next_page = true;
        }
        if let Block::Table {
            semantic_table_id,
            continues_from_previous_page,
            ..
        } = &mut next.blocks[next_index]
        {
            *semantic_table_id = Some(id);
            *continues_from_previous_page = true;
        }
    }
}

fn edge_table_index(page: &Page, at_top: bool) -> Option<usize> {
    page.blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| match block {
            Block::Table { bbox, .. } => Some((index, *bbox)),
            _ => None,
        })
        .filter(|(_, bbox)| {
            if at_top {
                bbox.y <= page.height * 0.22
            } else {
                bbox.bottom() >= page.height * 0.78
            }
        })
        .min_by(|(_, a), (_, b)| {
            let a_distance = if at_top {
                a.y
            } else {
                page.height - a.bottom()
            };
            let b_distance = if at_top {
                b.y
            } else {
                page.height - b.bottom()
            };
            a_distance.total_cmp(&b_distance)
        })
        .map(|(index, _)| index)
}

fn table_continuation_score(
    previous: &Block,
    previous_width: f32,
    previous_height: f32,
    next: &Block,
    next_width: f32,
    next_height: f32,
) -> usize {
    let (
        Block::Table {
            bbox: previous_bbox,
            columns: previous_columns,
            cells: previous_cells,
            ruled: previous_ruled,
            ..
        },
        Block::Table {
            bbox: next_bbox,
            columns: next_columns,
            cells: next_cells,
            ruled: next_ruled,
            ..
        },
    ) = (previous, next)
    else {
        return 0;
    };
    let mut score = 0;
    if previous_bbox.bottom() >= previous_height * 0.88 {
        score += 1;
    }
    if next_bbox.y <= next_height * 0.12 {
        score += 1;
    }
    if previous_columns == next_columns && *previous_columns >= 2 {
        score += 2;
    } else if previous_columns.abs_diff(*next_columns) <= 1
        && (*previous_columns).min(*next_columns) >= 3
    {
        score += 1;
    }
    if previous_ruled == next_ruled {
        score += 1;
    }
    let previous_signature = normalized_column_signature(previous_cells, previous_width);
    let next_signature = normalized_column_signature(next_cells, next_width);
    if previous_signature.len() == next_signature.len()
        && previous_signature.len() >= 2
        && previous_signature
            .iter()
            .zip(next_signature)
            .all(|(a, b)| (a - b).abs() <= 0.025)
    {
        score += 2;
    }
    score
}

fn normalized_column_signature(cells: &[TableCell], page_width: f32) -> Vec<f32> {
    let mut by_column = HashMap::<usize, Vec<f32>>::new();
    for cell in cells.iter().filter(|cell| cell.column_span == 1) {
        by_column
            .entry(cell.column)
            .or_default()
            .push(cell.bbox.x / page_width.max(1.0));
    }
    let mut signature: Vec<(usize, f32)> = by_column
        .into_iter()
        .map(|(column, values)| {
            (
                column,
                values.iter().sum::<f32>() / values.len().max(1) as f32,
            )
        })
        .collect();
    signature.sort_by_key(|entry| entry.0);
    signature.into_iter().map(|entry| entry.1).collect()
}

pub fn reconstruct_page(
    lines: Vec<TextLine>,
    rules: &[Rule],
    page_width: f32,
) -> ReconstructedPage {
    let mut profiler = None;
    reconstruct_page_profiled(lines, rules, page_width, &mut profiler)
}

pub(crate) fn reconstruct_page_profiled(
    lines: Vec<TextLine>,
    rules: &[Rule],
    page_width: f32,
    profiler: &mut Option<&mut Profiler>,
) -> ReconstructedPage {
    let mut consumed = HashSet::new();
    // PDF producers frequently emit one visual border as several adjacent
    // path objects (clipped forms and dashed/overpainted rules are common).
    // Heal only collinear fragments here. The downstream grid requirements
    // remain deliberately strict, so fraction bars and radical vincula cannot
    // become tables merely because they were joined.
    let joined_rules = join_collinear_rule_fragments(rules);
    let before = profiler.as_deref().map(Profiler::start);
    let mut blocks = ruled_tables(&lines, &joined_rules, &mut consumed);
    blocks = refine_ruled_table_regions(blocks, &lines, &joined_rules, &mut consumed, page_width);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("ruled_table_detection", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    blocks.extend(semi_ruled_tables(
        &lines,
        &joined_rules,
        &mut consumed,
        page_width,
    ));
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("semi_ruled_table_detection", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    blocks.extend(borderless_tables(&lines, &mut consumed, page_width));
    // Borderless reconstruction also works in local row bands. Run the same
    // geometry refinement again once those candidates exist so interrupted
    // forms can be treated as one region and repeated side-by-side grids can
    // be separated at their whitespace gutters.
    blocks = refine_ruled_table_regions(blocks, &lines, &joined_rules, &mut consumed, page_width);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("borderless_table_detection", before);
    }

    let before = profiler.as_deref().map(Profiler::start);
    let remaining: Vec<(usize, TextLine)> = lines
        .iter()
        .cloned()
        .enumerate()
        .filter(|(index, _)| !consumed.contains(index))
        .filter(|(_, line)| !line.text.trim().is_empty())
        .collect();
    blocks.extend(text_blocks(remaining, page_width));
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("paragraph_heading_reconstruction", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    let mut blocks = xy_cut_plus_plus(blocks);
    suppress_vector_figure_mini_grids(&mut blocks);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("reading_order_xy_cut", before);
    }
    ReconstructedPage {
        blocks,
        source_lines: lines,
    }
}

fn suppress_vector_figure_mini_grids(blocks: &mut [Block]) {
    // Author/affiliation matrices in TeX front matter are often implemented
    // with the same Form XObject rules as real tables. In an academic article
    // an explicit Abstract heading is a reliable boundary: small grids above
    // it are layout containers, not data tables.
    if let Some(abstract_y) = blocks.iter().find_map(|block| match block {
        Block::Heading { bbox, text, .. } if text.trim().eq_ignore_ascii_case("abstract") => {
            Some(bbox.y)
        }
        _ => None,
    }) {
        for block in blocks.iter_mut() {
            let replacement = match block {
                Block::Table {
                    bbox, rows, cells, ..
                } if bbox.bottom() < abstract_y && *rows <= 8 => Some(Block::Paragraph {
                    bbox: *bbox,
                    text: cells
                        .iter()
                        .map(|cell| cell.text.trim())
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                        .join(" "),
                    lines: Vec::new(),
                }),
                _ => None,
            };
            if let Some(replacement) = replacement {
                *block = replacement;
            }
        }
    }
    let captions: Vec<BBox> = blocks
        .iter()
        .filter_map(|block| match block {
            Block::Paragraph { bbox, text, .. }
                if text.trim_start().starts_with("Figure ")
                    || text.trim_start().starts_with("Fig. ") =>
            {
                Some(*bbox)
            }
            _ => None,
        })
        .collect();
    for caption in captions {
        let candidates: Vec<usize> = blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| match block {
                Block::Table { bbox, rows, .. }
                    if *rows <= 6
                        && bbox.bottom() <= caption.y
                        && caption.y - bbox.bottom() <= 320.0 =>
                {
                    Some(index)
                }
                _ => None,
            })
            .collect();
        if candidates.len() < 2 {
            continue;
        }
        for index in candidates {
            let replacement = match &blocks[index] {
                Block::Table { bbox, cells, .. } => Block::Paragraph {
                    bbox: *bbox,
                    text: cells
                        .iter()
                        .map(|cell| cell.text.trim())
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                        .join(" "),
                    lines: Vec::new(),
                },
                _ => continue,
            };
            blocks[index] = replacement;
        }
    }
}

fn join_collinear_rule_fragments(rules: &[Rule]) -> Vec<Rule> {
    let mut result = Vec::new();
    for horizontal in [true, false] {
        let mut source: Vec<Rule> = rules
            .iter()
            .copied()
            .filter(|rule| {
                if horizontal {
                    rule.horizontal()
                } else {
                    rule.vertical()
                }
            })
            .collect();
        source.sort_by(|a, b| {
            let a_track = if horizontal {
                (a.y1 + a.y2) * 0.5
            } else {
                (a.x1 + a.x2) * 0.5
            };
            let b_track = if horizontal {
                (b.y1 + b.y2) * 0.5
            } else {
                (b.x1 + b.x2) * 0.5
            };
            let a_start = if horizontal {
                a.x1.min(a.x2)
            } else {
                a.y1.min(a.y2)
            };
            let b_start = if horizontal {
                b.x1.min(b.x2)
            } else {
                b.y1.min(b.y2)
            };
            a_track
                .total_cmp(&b_track)
                .then(a_start.total_cmp(&b_start))
        });
        for rule in source {
            let track = if horizontal {
                (rule.y1 + rule.y2) * 0.5
            } else {
                (rule.x1 + rule.x2) * 0.5
            };
            let start = if horizontal {
                rule.x1.min(rule.x2)
            } else {
                rule.y1.min(rule.y2)
            };
            let end = if horizontal {
                rule.x1.max(rule.x2)
            } else {
                rule.y1.max(rule.y2)
            };
            if let Some(previous) = result.last_mut().filter(|previous: &&mut Rule| {
                let previous_track = if horizontal {
                    (previous.y1 + previous.y2) * 0.5
                } else {
                    (previous.x1 + previous.x2) * 0.5
                };
                let previous_end = if horizontal {
                    previous.x1.max(previous.x2)
                } else {
                    previous.y1.max(previous.y2)
                };
                (track - previous_track).abs() <= 1.75
                    && start - previous_end <= 5.0_f32.max(previous.width + rule.width)
            }) {
                if horizontal {
                    previous.x1 = previous.x1.min(start);
                    previous.x2 = previous.x2.max(end);
                    previous.y1 = (previous.y1 + track) * 0.5;
                    previous.y2 = previous.y1;
                } else {
                    previous.y1 = previous.y1.min(start);
                    previous.y2 = previous.y2.max(end);
                    previous.x1 = (previous.x1 + track) * 0.5;
                    previous.x2 = previous.x1;
                }
                previous.width = previous.width.max(rule.width);
            } else {
                result.push(rule);
            }
        }
    }
    // Preserve non-axis-aligned paths for later formula/figure consumers.
    result.extend(
        rules
            .iter()
            .copied()
            .filter(|rule| !rule.horizontal() && !rule.vertical()),
    );
    result
}

fn ruled_tables(lines: &[TextLine], rules: &[Rule], consumed: &mut HashSet<usize>) -> Vec<Block> {
    let rules: Vec<Rule> = rules
        .iter()
        .copied()
        .filter(|r| r.horizontal() || r.vertical())
        .collect();
    if rules.len() < 4 {
        return Vec::new();
    }
    let mut seen = vec![false; rules.len()];
    let mut result = Vec::new();
    for root in 0..rules.len() {
        if seen[root] {
            continue;
        }
        let mut stack = vec![root];
        let mut component = Vec::new();
        seen[root] = true;
        while let Some(index) = stack.pop() {
            component.push(rules[index]);
            for other in 0..rules.len() {
                if !seen[other] && rules_touch(rules[index], rules[other]) {
                    seen[other] = true;
                    stack.push(other);
                }
            }
        }
        if let Some(block) = ruled_component_to_table(&component, lines, consumed) {
            result.push(block);
        }
    }
    result
}

/// Refines the coarse connected components produced by the vector-rule pass.
/// PDF tables frequently interrupt rules at section labels (which fragments a
/// logical table vertically) or place several independent grids on the same
/// baselines (which can connect them horizontally). Region refinement is kept
/// separate from cell reconstruction so the outer geometry can improve without
/// making the grid solver depend on document-specific structure.
fn refine_ruled_table_regions(
    blocks: Vec<Block>,
    lines: &[TextLine],
    rules: &[Rule],
    consumed: &mut HashSet<usize>,
    page_width: f32,
) -> Vec<Block> {
    let merged =
        merge_horizontal_table_fragments(merge_vertical_table_fragments(blocks, lines, page_width));
    let split: Vec<Block> = merged
        .into_iter()
        .flat_map(|block| split_table_at_vertical_gutters(block, rules, lines))
        .collect();
    // The gutter pass may expose the same clipped column-group pattern after a
    // larger component was reconstructed. Re-join only exact touching,
    // row-compatible fragments; unlike the gutter detector this has explicit
    // structural evidence from reconstructed rows.
    let mut split: Vec<Block> = merge_horizontal_table_fragments(split)
        .into_iter()
        .flat_map(split_repeated_tall_panels)
        .collect();
    for block in &mut split {
        expand_table_with_aligned_edge_text(block, lines, consumed);
        expand_table_to_relative_rule_envelope(block, rules);
        expand_table_with_aligned_rows(block, lines, consumed, page_width);
    }
    split
}

fn expand_table_to_relative_rule_envelope(block: &mut Block, rules: &[Rule]) {
    let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        ..
    } = block
    else {
        return;
    };
    if *rows < 3 {
        return;
    }
    let original = *bbox;
    let envelopes: Vec<(f32, f32)> = rules
        .iter()
        .copied()
        .filter(|rule| rule.horizontal())
        .filter(|rule| {
            let y = (rule.y1 + rule.y2) * 0.5;
            y >= original.y - 2.0 && y <= original.bottom() + 2.0
        })
        .map(|rule| (rule.x1.min(rule.x2), rule.x1.max(rule.x2)))
        .filter(|(left, right)| {
            let overlap = (right.min(original.right()) - left.max(original.x)).max(0.0);
            overlap >= original.width * 0.35
        })
        .collect();
    let minimum_support = ((*rows as f32 * 0.35).ceil() as usize).max(3);
    if envelopes.len() < minimum_support {
        return;
    }
    let robust_edge = |left: bool| {
        let mut values: Vec<f32> = envelopes
            .iter()
            .map(|envelope| if left { envelope.0 } else { envelope.1 })
            .collect();
        values.sort_by(f32::total_cmp);
        let mut groups = Vec::<Vec<f32>>::new();
        for value in values {
            if groups.last().is_some_and(|group| {
                (value - group.iter().sum::<f32>() / group.len() as f32).abs() <= 3.0
            }) {
                groups.last_mut().unwrap().push(value);
            } else {
                groups.push(vec![value]);
            }
        }
        groups
            .into_iter()
            .filter(|group| group.len() >= minimum_support)
            .max_by_key(Vec::len)
            .map(|group| group.iter().sum::<f32>() / group.len() as f32)
    };
    let mut left = robust_edge(true).unwrap_or(original.x);
    let mut right = robust_edge(false).unwrap_or(original.right());
    let maximum_growth = original.width * 0.35;
    left = left.max(original.x - maximum_growth);
    right = right.min(original.right() + maximum_growth);
    if left >= original.x - 2.0 && right <= original.right() + 2.0 {
        return;
    }
    let expanded = BBox {
        x: left.min(original.x),
        y: original.y,
        width: right.max(original.right()) - left.min(original.x),
        height: original.height,
    };
    // Keep text-derived cell boxes intact, but let edge cells claim the newly
    // established container boundary. This preserves alignment evidence for a
    // later structure pass while making the region truthful immediately.
    let column_count = *columns;
    for cell in cells.iter_mut() {
        if cell.column == 0 {
            cell.bbox.width = cell.bbox.right() - expanded.x;
            cell.bbox.x = expanded.x;
        }
        if cell.column + cell.column_span == column_count {
            cell.bbox.width = expanded.right() - cell.bbox.x;
        }
    }
    *bbox = expanded;
}

fn split_repeated_tall_panels(block: Block) -> Vec<Block> {
    let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        ruled,
        ..
    } = &block
    else {
        return vec![block];
    };
    if *rows < 30 || !(3..=8).contains(columns) {
        return vec![block];
    }
    let headers: Vec<String> = (0..*columns)
        .map(|column| {
            cells
                .iter()
                .filter(|cell| cell.row == 0 && cell.column == column)
                .map(|cell| cell.text.trim().to_ascii_lowercase())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    if headers.iter().any(String::is_empty)
        || headers.iter().skip(1).any(|header| header != &headers[0])
    {
        return vec![block];
    }
    let mut result = Vec::new();
    for column in 0..*columns {
        let mut panel_cells: Vec<TableCell> = cells
            .iter()
            .filter(|cell| cell.column == column && cell.column_span == 1)
            .cloned()
            .map(|mut cell| {
                cell.column = 0;
                cell
            })
            .collect();
        if panel_cells.is_empty() {
            return vec![block];
        }
        let panel_bbox = panel_cells
            .iter()
            .map(|cell| cell.bbox)
            .reduce(BBox::union)
            .unwrap_or(*bbox);
        panel_cells.sort_by_key(|cell| cell.row);
        result.push(Block::Table {
            bbox: panel_bbox,
            rows: *rows,
            columns: 1,
            cells: panel_cells,
            ruled: *ruled,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        });
    }
    result
}

fn merge_horizontal_table_fragments(mut blocks: Vec<Block>) -> Vec<Block> {
    loop {
        let mut pair = None;
        'search: for left_index in 0..blocks.len() {
            let Block::Table {
                bbox: left_bbox,
                rows: left_rows,
                columns: left_columns,
                ..
            } = &blocks[left_index]
            else {
                continue;
            };
            for right_index in 0..blocks.len() {
                if left_index == right_index {
                    continue;
                }
                let Block::Table {
                    bbox: right_bbox,
                    rows: right_rows,
                    columns: right_columns,
                    cells: right_cells,
                    ..
                } = &blocks[right_index]
                else {
                    continue;
                };
                // Clipped/form-contained rules often produce one connected
                // component per column group. Exact shared row bands plus a
                // touching seam are stronger evidence of one table than the
                // component boundary. A real side-by-side layout normally has
                // a visible gutter, so keep this tolerance deliberately tiny.
                let repeated_single_column_panel =
                    (*left_rows >= 30 && *left_columns <= 4 && *right_columns <= 4)
                        || matches!(
                            &blocks[left_index],
                            Block::Table {
                                columns: 1,
                                cells: left_cells,
                                ..
                            } if *right_columns == 1
                                && first_row_text(left_cells) == first_row_text(right_cells)
                                && !first_row_text(left_cells).is_empty()
                        );
                if !repeated_single_column_panel
                    && left_bbox.x < right_bbox.x
                    && (right_bbox.x - left_bbox.right()).abs() <= 1.5
                    && (left_bbox.y - right_bbox.y).abs() <= 2.5
                    && (left_bbox.height - right_bbox.height).abs() <= 3.0
                    && left_rows == right_rows
                    && *left_rows >= 3
                {
                    pair = Some((left_index, right_index));
                    break 'search;
                }
            }
        }
        let Some((left_index, right_index)) = pair else {
            break;
        };
        let (high, low) = if left_index > right_index {
            (left_index, right_index)
        } else {
            (right_index, left_index)
        };
        let high_block = blocks.remove(high);
        let low_block = blocks.remove(low);
        let (left, right) = if low_block.bbox().x <= high_block.bbox().x {
            (low_block, high_block)
        } else {
            (high_block, low_block)
        };
        blocks.push(merge_table_blocks_horizontal(left, right));
    }
    blocks
}

fn first_row_text(cells: &[TableCell]) -> String {
    cells
        .iter()
        .filter(|cell| cell.row == 0)
        .map(|cell| cell.text.trim().to_ascii_lowercase())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn merge_table_blocks_horizontal(left: Block, right: Block) -> Block {
    let Block::Table {
        bbox: left_bbox,
        rows,
        columns: left_columns,
        mut cells,
        ruled,
        semantic_table_id,
        semantic_confidence,
        continues_from_previous_page,
        continues_on_next_page,
    } = left
    else {
        unreachable!("region refinement only receives tables")
    };
    let Block::Table {
        bbox: right_bbox,
        columns: right_columns,
        cells: right_cells,
        ..
    } = right
    else {
        unreachable!("region refinement only receives tables")
    };
    cells.extend(right_cells.into_iter().map(|mut cell| {
        cell.column += left_columns;
        cell
    }));
    cells.sort_by_key(|cell| (cell.row, cell.column));
    Block::Table {
        bbox: left_bbox.union(right_bbox),
        rows,
        columns: left_columns + right_columns,
        cells,
        ruled,
        semantic_table_id,
        semantic_confidence,
        continues_from_previous_page,
        continues_on_next_page,
    }
}

fn merge_vertical_table_fragments(
    mut blocks: Vec<Block>,
    lines: &[TextLine],
    page_width: f32,
) -> Vec<Block> {
    blocks.sort_by(|a, b| {
        a.bbox()
            .y
            .total_cmp(&b.bbox().y)
            .then(a.bbox().x.total_cmp(&b.bbox().x))
    });
    loop {
        let mut pair = None;
        'search: for upper in 0..blocks.len() {
            for lower in upper + 1..blocks.len() {
                if table_fragments_continue(
                    blocks[upper].bbox(),
                    blocks[lower].bbox(),
                    lines,
                    page_width,
                ) {
                    pair = Some((upper, lower));
                    break 'search;
                }
            }
        }
        let Some((upper, lower)) = pair else {
            break;
        };
        let lower = blocks.remove(lower);
        let upper = blocks.remove(upper);
        blocks.push(merge_table_blocks(upper, lower));
        blocks.sort_by(|a, b| {
            a.bbox()
                .y
                .total_cmp(&b.bbox().y)
                .then(a.bbox().x.total_cmp(&b.bbox().x))
        });
    }
    blocks
}

fn table_fragments_continue(upper: BBox, lower: BBox, lines: &[TextLine], page_width: f32) -> bool {
    if lower.y + 2.0 < upper.y || lower.y < upper.bottom() - 2.0 {
        return false;
    }
    let gap = lower.y - upper.bottom();
    if gap > 30.0 {
        return false;
    }
    let overlap = (upper.right().min(lower.right()) - upper.x.max(lower.x)).max(0.0);
    let overlap_ratio = overlap / upper.width.min(lower.width).max(1.0);
    let same_left = (upper.x - lower.x).abs() <= 6.0;
    let same_right = (upper.right() - lower.right()).abs() <= 6.0;
    let same_extent = same_left && same_right;
    let aligned = same_extent
        || (gap <= 4.0 && overlap_ratio >= 0.45 && (same_left || same_right))
        || (overlap_ratio >= 0.65 && (same_left || same_right));
    if !aligned {
        return false;
    }
    // A shared edge with no meaningful vertical gap is stronger evidence than
    // typography in the seam: repeated column headers and group labels inside
    // forms are often bold and would otherwise look like section headings.
    if (same_extent && gap <= 12.0)
        || (gap <= 4.0 && overlap_ratio >= 0.45 && (same_left || same_right))
    {
        return true;
    }
    !has_section_break_between(upper, lower, lines, page_width)
}

fn has_section_break_between(
    upper: BBox,
    lower: BBox,
    lines: &[TextLine],
    page_width: f32,
) -> bool {
    let mut body_sizes: Vec<f32> = lines
        .iter()
        .filter(|line| upper.contains_center(line.bbox) || lower.contains_center(line.bbox))
        .map(|line| line.font_size)
        .filter(|size| size.is_finite() && *size > 0.0)
        .collect();
    body_sizes.sort_by(f32::total_cmp);
    let body_size = body_sizes.get(body_sizes.len() / 2).copied().unwrap_or(8.0);
    let union = upper.union(lower);
    lines.iter().any(|line| {
        let center_y = line.bbox.center_y();
        center_y > upper.bottom() + 1.0
            && center_y < lower.y - 1.0
            && line.bbox.width >= union.width.max(page_width * 0.25) * 0.45
            && line.font_size >= body_size * 1.35
            && line.text.chars().filter(|ch| ch.is_alphabetic()).count() >= 6
    })
}

fn merge_table_blocks(upper: Block, lower: Block) -> Block {
    let Block::Table {
        bbox: upper_bbox,
        rows: upper_rows,
        columns: upper_columns,
        mut cells,
        ruled,
        semantic_table_id,
        semantic_confidence,
        continues_from_previous_page,
        continues_on_next_page,
    } = upper
    else {
        unreachable!("region refinement only receives tables")
    };
    let Block::Table {
        bbox: lower_bbox,
        rows: lower_rows,
        columns: lower_columns,
        cells: lower_cells,
        ..
    } = lower
    else {
        unreachable!("region refinement only receives tables")
    };
    cells.extend(lower_cells.into_iter().map(|mut cell| {
        cell.row += upper_rows;
        cell
    }));
    Block::Table {
        bbox: upper_bbox.union(lower_bbox),
        rows: upper_rows + lower_rows,
        columns: upper_columns.max(lower_columns),
        cells,
        ruled,
        semantic_table_id,
        semantic_confidence,
        continues_from_previous_page,
        continues_on_next_page,
    }
}

fn split_table_at_vertical_gutters(block: Block, rules: &[Rule], lines: &[TextLine]) -> Vec<Block> {
    let bbox = block.bbox();
    let mut xs = merge_tracks(
        rules
            .iter()
            .copied()
            .filter(|rule| rule.vertical())
            .filter(|rule| {
                let x = (rule.x1 + rule.x2) * 0.5;
                x >= bbox.x - 2.0
                    && x <= bbox.right() + 2.0
                    && rule_bbox(*rule).bottom() >= bbox.y
                    && rule_bbox(*rule).y <= bbox.bottom()
            })
            .map(|rule| (rule.x1 + rule.x2) * 0.5)
            .collect(),
        2.0,
    );
    xs.sort_by(f32::total_cmp);
    let horizontal: Vec<Rule> = rules
        .iter()
        .copied()
        .filter(|rule| rule.horizontal())
        .filter(|rule| {
            let y = (rule.y1 + rule.y2) * 0.5;
            y >= bbox.y - 2.0 && y <= bbox.bottom() + 2.0
        })
        .collect();
    let min_gap = 10.0_f32.max(bbox.width * 0.025);
    let mut gutters = Vec::<(f32, f32)>::new();
    for pair in xs.windows(2) {
        let (left, right) = (pair[0], pair[1]);
        if right - left < min_gap || left - bbox.x < 18.0 || bbox.right() - right < 18.0 {
            continue;
        }
        let left_coverage = vertical_track_coverage(rules, left, bbox);
        let right_coverage = vertical_track_coverage(rules, right, bbox);
        if left_coverage < 0.15 || right_coverage < 0.15 {
            continue;
        }
        let bridges = horizontal
            .iter()
            .filter(|rule| {
                rule.x1.min(rule.x2) <= left + 2.0 && rule.x1.max(rule.x2) >= right - 2.0
            })
            .count();
        let contains_text = lines.iter().any(|line| {
            line.bbox.center_y() >= bbox.y - 2.0
                && line.bbox.center_y() <= bbox.bottom() + 2.0
                && line.bbox.center_x() > left + 2.0
                && line.bbox.center_x() < right - 2.0
        });
        if bridges <= 1 && !contains_text {
            gutters.push((left, right));
        }
    }
    let segments = if gutters.is_empty() {
        text_gutter_segments(&block, lines)
    } else {
        segments_around_gutters(bbox, &gutters)
    };
    let Some(segments) = segments else {
        return vec![block];
    };
    split_table_block(block, &segments)
}

fn segments_around_gutters(bbox: BBox, gutters: &[(f32, f32)]) -> Option<Vec<(f32, f32)>> {
    let mut segments = Vec::new();
    let mut start = bbox.x;
    for (left, right) in gutters {
        if left - start >= 12.0 {
            segments.push((start, *left));
        }
        start = *right;
    }
    if bbox.right() - start >= 12.0 {
        segments.push((start, bbox.right()));
    }
    (segments.len() >= 2).then_some(segments)
}

fn text_gutter_segments(block: &Block, lines: &[TextLine]) -> Option<Vec<(f32, f32)>> {
    let Block::Table { bbox, columns, .. } = block else {
        return None;
    };
    if *columns < 6 {
        return None;
    }
    let mut intervals: Vec<(f32, f32)> = lines
        .iter()
        .filter(|line| {
            line.bbox.center_y() >= bbox.y - 2.0
                && line.bbox.center_y() <= bbox.bottom() + 2.0
                && line.bbox.right() >= bbox.x
                && line.bbox.x <= bbox.right()
                && line.bbox.width <= bbox.width * 0.35
        })
        .map(|line| (line.bbox.x.max(bbox.x), line.bbox.right().min(bbox.right())))
        .filter(|(left, right)| right > left)
        .collect();
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut occupied = Vec::<(f32, f32)>::new();
    for (left, right) in intervals {
        if let Some(last) = occupied.last_mut().filter(|last| left <= last.1 + 2.0) {
            last.1 = last.1.max(right);
        } else {
            occupied.push((left, right));
        }
    }
    if occupied.len() < 3 {
        return None;
    }
    let gaps: Vec<(f32, f32, f32)> = occupied
        .windows(2)
        .map(|pair| (pair[0].1, pair[1].0, pair[1].0 - pair[0].1))
        .filter(|(_, _, width)| *width > 2.0)
        .collect();
    if gaps.len() < 2 {
        return None;
    }
    let mut widths: Vec<f32> = gaps.iter().map(|gap| gap.2).collect();
    widths.sort_by(f32::total_cmp);
    let median = widths[widths.len() / 2];
    let minimum = 14.0_f32.max(bbox.width * 0.035).max(median * 1.6);
    let gutters: Vec<(f32, f32)> = gaps
        .into_iter()
        .filter(|(left, right, width)| {
            *width >= minimum && *left - bbox.x >= 18.0 && bbox.right() - *right >= 18.0
        })
        .map(|(left, right, _)| (left, right))
        .collect();
    if gutters.len() < 2 {
        return None;
    }
    // Text-derived gutters do not have explicit border tracks, so cut through
    // the whitespace midpoint and retain a small part of it on either region.
    let cuts: Vec<(f32, f32)> = gutters
        .iter()
        .map(|(left, right)| {
            let middle = (left + right) * 0.5;
            (middle, middle)
        })
        .collect();
    let segments = segments_around_gutters(*bbox, &cuts)?;
    let min_width = segments
        .iter()
        .map(|(left, right)| right - left)
        .fold(f32::INFINITY, f32::min);
    let max_width = segments
        .iter()
        .map(|(left, right)| right - left)
        .fold(0.0, f32::max);
    // Repeated side-by-side mini-tables have similarly sized panels. A very
    // uneven split is usually just ordinary whitespace between columns in one
    // wide table (as in dense factor matrices and datasheet grids).
    (max_width / min_width.max(1.0) <= 1.6).then_some(segments)
}

fn vertical_track_coverage(rules: &[Rule], x: f32, bbox: BBox) -> f32 {
    let mut intervals: Vec<(f32, f32)> = rules
        .iter()
        .copied()
        .filter(|rule| rule.vertical() && (((rule.x1 + rule.x2) * 0.5) - x).abs() <= 2.5)
        .map(|rule| {
            (
                rule.y1.min(rule.y2).max(bbox.y),
                rule.y1.max(rule.y2).min(bbox.bottom()),
            )
        })
        .filter(|(start, end)| end > start)
        .collect();
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut covered = 0.0;
    let mut current: Option<(f32, f32)> = None;
    for (start, end) in intervals {
        match current {
            Some((current_start, current_end)) if start <= current_end + 2.0 => {
                current = Some((current_start, current_end.max(end)));
            }
            Some((current_start, current_end)) => {
                covered += current_end - current_start;
                current = Some((start, end));
            }
            None => current = Some((start, end)),
        }
    }
    if let Some((start, end)) = current {
        covered += end - start;
    }
    covered / bbox.height.max(1.0)
}

fn split_table_block(block: Block, segments: &[(f32, f32)]) -> Vec<Block> {
    let Block::Table {
        bbox,
        rows,
        cells,
        ruled,
        ..
    } = block
    else {
        unreachable!("region refinement only receives tables")
    };
    let mut result = Vec::new();
    let mut assigned_cells = 0;
    let mut empty_segment = false;
    for (left, right) in segments {
        let mut segment_cells: Vec<TableCell> = cells
            .iter()
            .filter(|cell| cell.bbox.center_x() >= *left && cell.bbox.center_x() <= *right)
            .cloned()
            .collect();
        if segment_cells.is_empty() {
            empty_segment = true;
            continue;
        }
        assigned_cells += segment_cells.len();
        let min_column = segment_cells.iter().map(|cell| cell.column).min().unwrap();
        let max_column = segment_cells
            .iter()
            .map(|cell| cell.column + cell.column_span)
            .max()
            .unwrap();
        for cell in &mut segment_cells {
            cell.column -= min_column;
        }
        result.push(Block::Table {
            bbox: BBox {
                x: *left,
                y: bbox.y,
                width: right - left,
                height: bbox.height,
            },
            rows,
            columns: max_column - min_column,
            cells: segment_cells,
            ruled,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        });
    }
    if result.len() >= 2 && !empty_segment && assigned_cells == cells.len() {
        result
    } else {
        let columns = cells
            .iter()
            .map(|cell| cell.column + cell.column_span)
            .max()
            .unwrap_or(0);
        vec![Block::Table {
            bbox,
            rows,
            columns,
            cells,
            ruled,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        }]
    }
}

fn expand_table_with_aligned_edge_text(
    block: &mut Block,
    lines: &[TextLine],
    consumed: &mut HashSet<usize>,
) {
    let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        ..
    } = block
    else {
        return;
    };
    let original_bbox = *bbox;
    let typical_column_width = original_bbox.width / (*columns).max(1) as f32;
    let edge_distance_max = (original_bbox.width * 0.22).max(0.0);
    let edge_distance = (original_bbox.width / (*columns).max(1) as f32 * 1.25)
        .clamp(12.0_f32.min(edge_distance_max), edge_distance_max);
    let mut row_bands: HashMap<usize, BBox> = HashMap::new();
    for cell in cells.iter() {
        row_bands
            .entry(cell.row)
            .and_modify(|band| *band = band.union(cell.bbox))
            .or_insert(cell.bbox);
    }
    let mut left = Vec::<(usize, usize)>::new();
    let mut right = Vec::<(usize, usize)>::new();
    for (index, line) in lines.iter().enumerate() {
        if consumed.contains(&index)
            || line.text.trim().is_empty()
            || line.bbox.width > typical_column_width * 0.85
            || line.bbox.center_y() < original_bbox.y - 2.0
            || line.bbox.center_y() > original_bbox.bottom() + 2.0
        {
            continue;
        }
        let Some(row) = row_bands
            .iter()
            .filter(|(_, band)| {
                line.bbox.center_y() >= band.y - 2.0 && line.bbox.center_y() <= band.bottom() + 2.0
            })
            .min_by(|(_, a), (_, b)| {
                (a.center_y() - line.bbox.center_y())
                    .abs()
                    .total_cmp(&(b.center_y() - line.bbox.center_y()).abs())
            })
            .map(|(row, _)| *row)
        else {
            continue;
        };
        if line.bbox.center_x() < original_bbox.x
            && line.bbox.right() >= original_bbox.x - edge_distance
        {
            left.push((index, row));
        } else if line.bbox.center_x() > original_bbox.right()
            && line.bbox.x <= original_bbox.right() + edge_distance
        {
            right.push((index, row));
        }
    }
    let distinct_rows = |candidates: &[(usize, usize)]| {
        candidates
            .iter()
            .map(|(_, row)| *row)
            .collect::<HashSet<_>>()
            .len()
    };
    if distinct_rows(&left) >= 3 {
        for cell in cells.iter_mut() {
            cell.column += 1;
        }
        append_edge_column(cells, &left, lines, 0);
        *columns += 1;
        let left_x = left
            .iter()
            .map(|(index, _)| lines[*index].bbox.x)
            .fold(original_bbox.x, f32::min);
        bbox.width = bbox.right() - left_x;
        bbox.x = left_x;
        consumed.extend(left.iter().map(|(index, _)| *index));
    }
    if distinct_rows(&right) >= 3 {
        append_edge_column(cells, &right, lines, *columns);
        *columns += 1;
        let right_x = right
            .iter()
            .map(|(index, _)| lines[*index].bbox.right())
            .fold(bbox.right(), f32::max);
        bbox.width = right_x - bbox.x;
        consumed.extend(right.iter().map(|(index, _)| *index));
    }
    *rows = (*rows).max(
        cells
            .iter()
            .map(|cell| cell.row + cell.row_span)
            .max()
            .unwrap_or(*rows),
    );
    cells.sort_by_key(|cell| (cell.row, cell.column));
}

fn append_edge_column(
    cells: &mut Vec<TableCell>,
    candidates: &[(usize, usize)],
    lines: &[TextLine],
    column: usize,
) {
    let mut by_row: HashMap<usize, Vec<usize>> = HashMap::new();
    for (index, row) in candidates {
        by_row.entry(*row).or_default().push(*index);
    }
    for (row, mut indices) in by_row {
        indices.sort_by(|a, b| lines[*a].bbox.x.total_cmp(&lines[*b].bbox.x));
        let bbox = indices
            .iter()
            .map(|index| lines[*index].bbox)
            .reduce(BBox::union)
            .unwrap();
        let text = indices
            .iter()
            .map(|index| lines[*index].text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        cells.push(TableCell {
            row,
            column,
            row_span: 1,
            column_span: 1,
            text,
            bbox,
        });
    }
}

#[derive(Debug)]
struct AlignedRow {
    indices: Vec<usize>,
    bbox: BBox,
}

fn expand_table_with_aligned_rows(
    block: &mut Block,
    lines: &[TextLine],
    consumed: &mut HashSet<usize>,
    _page_width: f32,
) {
    let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        ..
    } = block
    else {
        return;
    };
    if *columns < 2 {
        return;
    }
    let original_bbox = *bbox;
    let mut row_centres: Vec<f32> = cells.iter().map(|cell| cell.bbox.center_y()).collect();
    row_centres.sort_by(f32::total_cmp);
    row_centres.dedup_by(|a, b| (*a - *b).abs() <= 2.0);
    let mut row_pitches: Vec<f32> = row_centres
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|pitch| *pitch > 2.0)
        .collect();
    row_pitches.sort_by(f32::total_cmp);
    let typical_pitch = row_pitches
        .get(row_pitches.len() / 2)
        .copied()
        .unwrap_or(10.0);
    let expansion_gap = (typical_pitch * 2.4).clamp(16.0, 42.0);
    // Headers may sit above a booktabs rule with deliberately generous
    // whitespace. Downward growth is riskier because the next table often
    // begins after a section heading, so continuation uses a tighter bound.
    let continuation_gap = (typical_pitch * 1.35).clamp(12.0, 22.0);
    let column_centres = empirical_column_centres(cells, *columns, original_bbox);
    let mut candidates: Vec<(usize, &TextLine)> = lines
        .iter()
        .enumerate()
        .filter(|(index, line)| {
            !consumed.contains(index)
                && !line.text.trim().is_empty()
                // Keep tiny raised numeric markers in the prose/citation
                // stream. They annotate header labels but are not independent
                // table cells, and consuming them here loses citation links.
                && !(line.bbox.height <= 7.5
                    && line.text.trim().chars().all(|character| character.is_ascii_digit()))
                && line.bbox.center_x() >= original_bbox.x - 4.0
                && line.bbox.center_x() <= original_bbox.right() + 4.0
                && (line.bbox.bottom() <= original_bbox.y + 2.0
                    || line.bbox.y >= original_bbox.bottom() - 2.0)
        })
        .collect();
    candidates.sort_by(|a, b| {
        a.1.bbox
            .center_y()
            .total_cmp(&b.1.bbox.center_y())
            .then(a.1.bbox.x.total_cmp(&b.1.bbox.x))
    });
    let mut visual_rows = Vec::<AlignedRow>::new();
    for (index, line) in candidates {
        if let Some(row) = visual_rows
            .last_mut()
            .filter(|row| (row.bbox.center_y() - line.bbox.center_y()).abs() <= 6.0)
        {
            row.indices.push(index);
            row.bbox = row.bbox.union(line.bbox);
        } else {
            visual_rows.push(AlignedRow {
                indices: vec![index],
                bbox: line.bbox,
            });
        }
    }
    visual_rows.retain(|row| {
        row.indices.len() >= 2
            && (row.bbox.width >= original_bbox.width * 0.20
                || row.bbox.x <= original_bbox.x + original_bbox.width * 0.10)
            && row.indices.iter().all(|index| {
                let line = &lines[*index];
                line.bbox.width <= original_bbox.width * 0.60
            })
    });

    let mut above: Vec<AlignedRow> = visual_rows
        .iter()
        .filter(|row| row.bbox.bottom() <= original_bbox.y + 2.0)
        .map(|row| AlignedRow {
            indices: row.indices.clone(),
            bbox: row.bbox,
        })
        .collect();
    above.sort_by(|a, b| b.bbox.y.total_cmp(&a.bbox.y));
    let mut accepted_above = Vec::new();
    let mut top = original_bbox.y;
    for row in above {
        if top - row.bbox.bottom() > expansion_gap {
            break;
        }
        top = row.bbox.y;
        accepted_above.push(row);
    }
    accepted_above.reverse();

    let mut below: Vec<AlignedRow> = visual_rows
        .into_iter()
        .filter(|row| row.bbox.y >= original_bbox.bottom() - 2.0)
        .collect();
    below.sort_by(|a, b| a.bbox.y.total_cmp(&b.bbox.y));
    let mut accepted_below = Vec::new();
    let mut bottom = original_bbox.bottom();
    for row in below {
        if row.bbox.y - bottom > continuation_gap {
            break;
        }
        bottom = row.bbox.bottom();
        accepted_below.push(row);
    }
    if accepted_above.is_empty() && accepted_below.is_empty() {
        return;
    }

    let above_count = accepted_above.len();
    if above_count > 0 {
        for cell in cells.iter_mut() {
            cell.row += above_count;
        }
    }
    for (row_index, row) in accepted_above.iter().enumerate() {
        append_aligned_row_cells(cells, row, row_index, &column_centres, original_bbox, lines);
    }
    let first_below_row = above_count + *rows;
    for (offset, row) in accepted_below.iter().enumerate() {
        append_aligned_row_cells(
            cells,
            row,
            first_below_row + offset,
            &column_centres,
            original_bbox,
            lines,
        );
    }
    consumed.extend(
        accepted_above
            .iter()
            .chain(&accepted_below)
            .flat_map(|row| row.indices.iter().copied()),
    );
    *rows += above_count + accepted_below.len();
    bbox.y = top;
    bbox.height = bottom - top;
    cells.sort_by_key(|cell| (cell.row, cell.column));
}

fn empirical_column_centres(cells: &[TableCell], columns: usize, table_bbox: BBox) -> Vec<f32> {
    (0..columns)
        .map(|column| {
            let mut centres: Vec<f32> = cells
                .iter()
                .filter(|cell| cell.column == column && cell.column_span == 1)
                .map(|cell| cell.bbox.center_x())
                .collect();
            centres.sort_by(f32::total_cmp);
            centres.get(centres.len() / 2).copied().unwrap_or_else(|| {
                table_bbox.x + table_bbox.width * (column as f32 + 0.5) / columns as f32
            })
        })
        .collect()
}

fn append_aligned_row_cells(
    cells: &mut Vec<TableCell>,
    row: &AlignedRow,
    row_index: usize,
    column_centres: &[f32],
    table_bbox: BBox,
    lines: &[TextLine],
) {
    let columns = column_centres.len();
    let mut boundaries = Vec::with_capacity(columns + 1);
    boundaries.push(table_bbox.x);
    boundaries.extend(
        column_centres
            .windows(2)
            .map(|centres| (centres[0] + centres[1]) * 0.5),
    );
    boundaries.push(table_bbox.right());
    let mut column_widths: Vec<f32> = boundaries
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .collect();
    column_widths.sort_by(f32::total_cmp);
    let typical_column_width = column_widths
        .get(column_widths.len() / 2)
        .copied()
        .unwrap_or(table_bbox.width / columns.max(1) as f32);
    let mut indices = row.indices.clone();
    indices.sort_by(|a, b| lines[*a].bbox.x.total_cmp(&lines[*b].bbox.x));
    for index in indices {
        let line = &lines[index];
        let broad_label_padding = if line.bbox.width >= typical_column_width * 1.3 {
            5.0
        } else {
            0.0
        };
        let mut overlapping: Vec<usize> = (0..columns)
            .filter(|column| {
                let overlap = ((line.bbox.right() + broad_label_padding)
                    .min(boundaries[*column + 1])
                    - (line.bbox.x - broad_label_padding).max(boundaries[*column]))
                .max(0.0);
                overlap
                    >= (line.bbox.width + broad_label_padding * 2.0)
                        .min(boundaries[*column + 1] - boundaries[*column])
                        * 0.40
            })
            .collect();
        if overlapping.is_empty() {
            overlapping.push(
                column_centres
                    .iter()
                    .enumerate()
                    .min_by(|(_, a), (_, b)| {
                        (**a - line.bbox.center_x())
                            .abs()
                            .total_cmp(&(**b - line.bbox.center_x()).abs())
                    })
                    .map(|(column, _)| column)
                    .unwrap_or(0),
            );
        }
        let column = overlapping[0];
        let column_span = overlapping[overlapping.len() - 1] - column + 1;
        if let Some(cell) = cells.iter_mut().find(|cell| {
            cell.row == row_index
                && column >= cell.column
                && column < cell.column + cell.column_span
        }) {
            if !line.text.trim().is_empty() {
                if !cell.text.is_empty() {
                    cell.text.push(' ');
                }
                cell.text.push_str(line.text.trim());
            }
            cell.bbox = cell.bbox.union(line.bbox);
            continue;
        }
        cells.push(TableCell {
            row: row_index,
            column,
            row_span: 1,
            column_span,
            text: line.text.trim().to_owned(),
            bbox: line.bbox,
        });
    }
}

#[derive(Clone, Copy, Debug)]
struct HorizontalTrack {
    y: f32,
    left: f32,
    right: f32,
}

/// Reconstructs academic "booktabs" tables: tables bounded and grouped by
/// horizontal rules but without a complete vertical grid. A caption anchors
/// the region, while the densest row establishes one global sparse-column
/// lattice for headers and every body row.
fn semi_ruled_tables(
    lines: &[TextLine],
    rules: &[Rule],
    consumed: &mut HashSet<usize>,
    page_width: f32,
) -> Vec<Block> {
    let tracks = horizontal_tracks(rules, page_width);
    if tracks.len() < 2 {
        return Vec::new();
    }
    let captions: Vec<&TextLine> = lines
        .iter()
        .filter(|line| is_table_caption(&line.text))
        .collect();
    let mut result = Vec::new();
    let mut used_track_ranges = Vec::<(f32, f32)>::new();
    for caption in captions {
        let Some(first_index) = tracks.iter().position(|track| {
            track.y >= caption.bbox.bottom() - 2.0
                && track.y - caption.bbox.bottom() <= 90.0
                && track.right - track.left >= page_width * 0.35
        }) else {
            continue;
        };
        let first = tracks[first_index];
        let mut selected = vec![first];
        let mut previous_y = first.y;
        for track in tracks.iter().copied().skip(first_index + 1) {
            if track.y - first.y > 360.0 {
                break;
            }
            if horizontal_overlap_ratio(first, track) < 0.60 {
                continue;
            }
            if track.y - previous_y > 85.0 && selected.len() >= 2 {
                break;
            }
            selected.push(track);
            previous_y = track.y;
        }
        if selected.len() < 2 {
            continue;
        }
        let top = selected.first().unwrap().y;
        let bottom = selected.last().unwrap().y;
        if bottom - top < 18.0
            || used_track_ranges
                .iter()
                .any(|(used_top, used_bottom)| top <= *used_bottom && bottom >= *used_top)
        {
            continue;
        }
        let left = selected
            .iter()
            .map(|track| track.left)
            .fold(f32::INFINITY, f32::min);
        let right = selected
            .iter()
            .map(|track| track.right)
            .fold(f32::NEG_INFINITY, f32::max);
        let region = BBox {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        };
        let indices: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(index, line)| {
                !consumed.contains(index)
                    && line.bbox.center_y() >= region.y - 3.0
                    && line.bbox.center_y() <= region.bottom() + 3.0
                    && line.bbox.right() >= region.x - 4.0
                    && line.bbox.x <= region.right() + 4.0
            })
            .map(|(index, _)| index)
            .collect();
        let separator_ys: Vec<f32> = selected.iter().map(|track| track.y).collect();
        if let Some(table) =
            booktabs_region_to_table(lines, &indices, region, selected[1].y, &separator_ys)
        {
            consumed.extend(indices);
            result.push(table);
            used_track_ranges.push((top, bottom));
        }
    }
    result
}

fn horizontal_tracks(rules: &[Rule], page_width: f32) -> Vec<HorizontalTrack> {
    let mut source: Vec<HorizontalTrack> = rules
        .iter()
        .copied()
        .filter(|rule| rule.horizontal())
        .filter_map(|rule| {
            let left = rule.x1.min(rule.x2);
            let right = rule.x1.max(rule.x2);
            (right - left >= page_width * 0.30).then_some(HorizontalTrack {
                y: (rule.y1 + rule.y2) * 0.5,
                left,
                right,
            })
        })
        .collect();
    source.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.left.total_cmp(&b.left)));
    let mut tracks = Vec::<HorizontalTrack>::new();
    for track in source {
        if let Some(existing) = tracks.last_mut().filter(|existing| {
            (existing.y - track.y).abs() <= 2.0
                && horizontal_overlap_ratio(**existing, track) >= 0.5
        }) {
            existing.y = (existing.y + track.y) * 0.5;
            existing.left = existing.left.min(track.left);
            existing.right = existing.right.max(track.right);
        } else {
            tracks.push(track);
        }
    }
    tracks
}

fn horizontal_overlap_ratio(a: HorizontalTrack, b: HorizontalTrack) -> f32 {
    let overlap = (a.right.min(b.right) - a.left.max(b.left)).max(0.0);
    overlap / (a.right - a.left).min(b.right - b.left).max(1.0)
}

fn is_table_caption(text: &str) -> bool {
    let text = text.trim_start();
    let Some(rest) = text.strip_prefix("Table ") else {
        return false;
    };
    rest.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

#[derive(Clone, Debug)]
struct MappedCell {
    start: usize,
    end: usize,
    text: String,
    bbox: BBox,
}

#[derive(Clone, Debug)]
struct MappedRow {
    cells: Vec<MappedCell>,
    bbox: BBox,
}

fn booktabs_region_to_table(
    lines: &[TextLine],
    indices: &[usize],
    region: BBox,
    header_bottom: f32,
    separator_ys: &[f32],
) -> Option<Block> {
    if indices.len() < 6 {
        return None;
    }
    let outside: HashSet<usize> = (0..lines.len())
        .filter(|index| !indices.contains(index))
        .collect();
    let visual = visual_rows(lines, &outside);
    let raw_rows: Vec<(BBox, Vec<CandidateCell>)> = visual
        .iter()
        .map(|row| (row_bbox(row), split_row_cells(row)))
        .filter(|(_, cells)| !cells.is_empty())
        .collect();
    let column_count = raw_rows.iter().map(|(_, cells)| cells.len()).max()?;
    if column_count < 3 {
        return None;
    }
    let reference = raw_rows
        .iter()
        .filter(|(_, cells)| cells.len() == column_count)
        .max_by(|(_, a), (_, b)| {
            let a_width = a.last().unwrap().right - a.first().unwrap().x;
            let b_width = b.last().unwrap().right - b.first().unwrap().x;
            a_width.total_cmp(&b_width)
        })?;
    let centers: Vec<f32> = reference
        .1
        .iter()
        .map(|cell| (cell.x + cell.right) * 0.5)
        .collect();
    if centers.windows(2).any(|window| window[1] - window[0] < 4.0) {
        return None;
    }
    let mut rows: Vec<MappedRow> = raw_rows
        .into_iter()
        .map(|(bbox, cells)| map_booktabs_row(cells, bbox, &centers, region))
        .filter(|row| !row.cells.is_empty())
        .collect();
    rows = consolidate_booktabs_rows(rows, header_bottom);
    if rows.len() < 3 {
        return None;
    }

    let mut boundaries = Vec::with_capacity(column_count + 1);
    boundaries.push(region.x);
    boundaries.extend(
        centers
            .windows(2)
            .map(|window| (window[0] + window[1]) * 0.5),
    );
    boundaries.push(region.right());
    let mut cells = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        for cell in &row.cells {
            cells.push(TableCell {
                row: row_index,
                column: cell.start,
                row_span: 1,
                column_span: cell.end - cell.start + 1,
                text: cell.text.trim().to_owned(),
                bbox: BBox {
                    x: boundaries[cell.start],
                    y: row.bbox.y,
                    width: boundaries[cell.end + 1] - boundaries[cell.start],
                    height: row.bbox.height,
                },
            });
        }
    }
    apply_booktabs_group_rowspans(&mut cells, &rows, separator_ys, &boundaries);
    Some(Block::Table {
        bbox: region,
        rows: rows.len(),
        columns: column_count,
        cells,
        ruled: true,
        semantic_table_id: None,
        semantic_confidence: None,
        continues_from_previous_page: false,
        continues_on_next_page: false,
    })
}

fn apply_booktabs_group_rowspans(
    cells: &mut [TableCell],
    rows: &[MappedRow],
    separator_ys: &[f32],
    boundaries: &[f32],
) {
    for cell in cells.iter_mut().filter(|cell| is_group_label(&cell.text)) {
        let source_center = cell.bbox.center_y();
        let Some(window) = separator_ys
            .windows(2)
            .find(|window| source_center >= window[0] && source_center <= window[1])
        else {
            continue;
        };
        let grouped_rows: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.bbox.center_y() >= window[0] && row.bbox.center_y() <= window[1])
            .map(|(index, _)| index)
            .collect();
        let (Some(first), Some(last)) =
            (grouped_rows.first().copied(), grouped_rows.last().copied())
        else {
            continue;
        };
        cell.row = first;
        cell.row_span = last - first + 1;
        cell.bbox = BBox {
            x: boundaries[cell.column],
            y: rows[first].bbox.y,
            width: boundaries[cell.column + cell.column_span] - boundaries[cell.column],
            height: rows[last].bbox.bottom() - rows[first].bbox.y,
        };
    }
    cells.sort_by_key(|cell| (cell.row, cell.column));
}

fn is_group_label(text: &str) -> bool {
    let bytes = text.trim().as_bytes();
    bytes.len() == 3 && bytes[0] == b'(' && bytes[1].is_ascii_uppercase() && bytes[2] == b')'
}

fn map_booktabs_row(
    cells: Vec<CandidateCell>,
    bbox: BBox,
    centers: &[f32],
    region: BBox,
) -> MappedRow {
    let padding = 8.0;
    let mut mapped = Vec::<MappedCell>::new();
    let mut next_column = 0;
    for cell in cells {
        let overlapping: Vec<usize> = centers
            .iter()
            .enumerate()
            .filter(|(_, center)| **center >= cell.x - padding && **center <= cell.right + padding)
            .map(|(index, _)| index)
            .collect();
        let (mut start, mut end) = if let (Some(start), Some(end)) =
            (overlapping.first().copied(), overlapping.last().copied())
        {
            (start, end)
        } else {
            let center = (cell.x + cell.right) * 0.5;
            let nearest = centers
                .iter()
                .enumerate()
                .min_by(|a, b| (a.1 - center).abs().total_cmp(&(b.1 - center).abs()))
                .map(|entry| entry.0)
                .unwrap_or(0);
            (nearest, nearest)
        };
        start = start.max(next_column.min(centers.len() - 1));
        end = end.max(start).min(centers.len() - 1);
        next_column = end + 1;
        let cell_bbox = BBox {
            x: cell.x.max(region.x),
            y: bbox.y,
            width: (cell.right.min(region.right()) - cell.x.max(region.x)).max(0.0),
            height: bbox.height,
        };
        if let Some(previous) = mapped.last_mut().filter(|previous| previous.start == start) {
            if !previous.text.is_empty() && !cell.text.is_empty() {
                previous.text.push(' ');
            }
            previous.text.push_str(&cell.text);
            previous.bbox = previous.bbox.union(cell_bbox);
        } else {
            mapped.push(MappedCell {
                start,
                end,
                text: cell.text,
                bbox: cell_bbox,
            });
        }
    }
    MappedRow {
        cells: mapped,
        bbox,
    }
}

fn consolidate_booktabs_rows(rows: Vec<MappedRow>, header_bottom: f32) -> Vec<MappedRow> {
    let mut result = Vec::<MappedRow>::new();
    for row in rows {
        let merge = result.last().is_some_and(|previous| {
            let gap = row.bbox.y - previous.bbox.bottom();
            let previous_columns: HashSet<usize> = previous
                .cells
                .iter()
                .flat_map(|cell| cell.start..=cell.end)
                .collect();
            let row_columns: HashSet<usize> = row
                .cells
                .iter()
                .flat_map(|cell| cell.start..=cell.end)
                .collect();
            row.bbox.y < header_bottom + 1.0
                && gap <= 2.5
                && (previous_columns.is_disjoint(&row_columns)
                    || (row_columns.is_subset(&previous_columns)
                        && row.cells.len() < previous.cells.len()))
        });
        if merge {
            let previous = result.last_mut().unwrap();
            for cell in row.cells {
                if let Some(existing) = previous
                    .cells
                    .iter_mut()
                    .find(|existing| existing.start == cell.start && existing.end == cell.end)
                {
                    if !existing.text.is_empty() && !cell.text.is_empty() {
                        existing.text.push(' ');
                    }
                    existing.text.push_str(&cell.text);
                    existing.bbox = existing.bbox.union(cell.bbox);
                } else {
                    previous.cells.push(cell);
                }
            }
            previous.cells.sort_by_key(|cell| cell.start);
            previous.bbox = previous.bbox.union(row.bbox);
        } else {
            result.push(row);
        }
    }
    result
}

fn rules_touch(a: Rule, b: Rule) -> bool {
    let a_box = rule_bbox(a);
    let b_box = rule_bbox(b);
    let margin = 2.5;
    a_box.x <= b_box.right() + margin
        && b_box.x <= a_box.right() + margin
        && a_box.y <= b_box.bottom() + margin
        && b_box.y <= a_box.bottom() + margin
}

fn rule_bbox(rule: Rule) -> BBox {
    BBox {
        x: rule.x1.min(rule.x2),
        y: rule.y1.min(rule.y2),
        width: (rule.x2 - rule.x1).abs().max(rule.width),
        height: (rule.y2 - rule.y1).abs().max(rule.width),
    }
}

fn ruled_component_to_table(
    component: &[Rule],
    lines: &[TextLine],
    consumed: &mut HashSet<usize>,
) -> Option<Block> {
    let mut xs = merge_tracks(
        component
            .iter()
            .filter(|r| r.vertical())
            .map(|r| (r.x1 + r.x2) * 0.5)
            .collect(),
        2.0,
    );
    let mut ys = merge_tracks(
        component
            .iter()
            .filter(|r| r.horizontal())
            .map(|r| (r.y1 + r.y2) * 0.5)
            .collect(),
        2.0,
    );
    xs.sort_by(f32::total_cmp);
    ys.sort_by(f32::total_cmp);
    if xs.len() < 2 || ys.len() < 2 {
        return None;
    }
    let bbox = BBox {
        x: xs[0],
        y: ys[0],
        width: xs[xs.len() - 1] - xs[0],
        height: ys[ys.len() - 1] - ys[0],
    };
    if bbox.width < 12.0 || bbox.height < 8.0 {
        return None;
    }
    let row_count = ys.len() - 1;
    let column_count = xs.len() - 1;
    if column_count < 2 {
        return None;
    }
    let mut contents: HashMap<(usize, usize), Vec<TextFragment>> = HashMap::new();
    for (index, line) in lines.iter().enumerate() {
        if !bbox.contains_center(line.bbox) {
            continue;
        }
        consumed.insert(index);
        for span in &line.spans {
            let Some(row) = interval_for(span.bbox.center_y(), &ys) else {
                continue;
            };
            let Some(column) = interval_for(span.bbox.center_x(), &xs) else {
                continue;
            };
            contents.entry((row, column)).or_default().push((
                span.bbox.y,
                span.bbox.x,
                span.text.trim().to_owned(),
            ));
        }
    }

    // Missing internal rules represent merged cells. Build connected atomic
    // cells, then emit one anchor cell with row_span/column_span per component.
    let mut parents: Vec<usize> = (0..row_count * column_count).collect();
    for row in 0..row_count {
        for column in 0..column_count {
            let here = row * column_count + column;
            if column + 1 < column_count
                && !vertical_boundary_exists(component, xs[column + 1], ys[row], ys[row + 1])
            {
                union(&mut parents, here, here + 1);
            }
            if row + 1 < row_count
                && !horizontal_boundary_exists(component, ys[row + 1], xs[column], xs[column + 1])
            {
                union(&mut parents, here, here + column_count);
            }
        }
    }
    let mut groups: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
    for row in 0..row_count {
        for column in 0..column_count {
            let root = find(&mut parents, row * column_count + column);
            groups.entry(root).or_default().push((row, column));
        }
    }
    let mut cells = Vec::new();
    for atomic_cells in groups.values() {
        let min_row = atomic_cells.iter().map(|p| p.0).min().unwrap();
        let max_row = atomic_cells.iter().map(|p| p.0).max().unwrap();
        let min_column = atomic_cells.iter().map(|p| p.1).min().unwrap();
        let max_column = atomic_cells.iter().map(|p| p.1).max().unwrap();
        let mut fragments: Vec<TextFragment> = atomic_cells
            .iter()
            .flat_map(|key| contents.remove(key).unwrap_or_default())
            .collect();
        fragments.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        cells.push(TableCell {
            row: min_row,
            column: min_column,
            row_span: max_row - min_row + 1,
            column_span: max_column - min_column + 1,
            text: fragments
                .into_iter()
                .map(|fragment| fragment.2)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
            bbox: BBox {
                x: xs[min_column],
                y: ys[min_row],
                width: xs[max_column + 1] - xs[min_column],
                height: ys[max_row + 1] - ys[min_row],
            },
        });
    }
    cells.sort_by_key(|cell| (cell.row, cell.column));
    Some(Block::Table {
        bbox,
        rows: row_count,
        columns: column_count,
        cells,
        ruled: true,
        semantic_table_id: None,
        semantic_confidence: None,
        continues_from_previous_page: false,
        continues_on_next_page: false,
    })
}

fn vertical_boundary_exists(rules: &[Rule], x: f32, top: f32, bottom: f32) -> bool {
    rules
        .iter()
        .copied()
        .filter(|rule| rule.vertical() && (((rule.x1 + rule.x2) * 0.5) - x).abs() <= 2.5)
        .any(|rule| {
            let start = rule.y1.min(rule.y2);
            let end = rule.y1.max(rule.y2);
            (end.min(bottom) - start.max(top)).max(0.0) >= (bottom - top) * 0.65
        })
}

fn horizontal_boundary_exists(rules: &[Rule], y: f32, left: f32, right: f32) -> bool {
    rules
        .iter()
        .copied()
        .filter(|rule| rule.horizontal() && (((rule.y1 + rule.y2) * 0.5) - y).abs() <= 2.5)
        .any(|rule| {
            let start = rule.x1.min(rule.x2);
            let end = rule.x1.max(rule.x2);
            (end.min(right) - start.max(left)).max(0.0) >= (right - left) * 0.65
        })
}

fn find(parents: &mut [usize], value: usize) -> usize {
    if parents[value] != value {
        parents[value] = find(parents, parents[value]);
    }
    parents[value]
}

fn union(parents: &mut [usize], a: usize, b: usize) {
    let a = find(parents, a);
    let b = find(parents, b);
    if a != b {
        parents[b] = a;
    }
}

fn interval_for(value: f32, tracks: &[f32]) -> Option<usize> {
    (0..tracks.len() - 1)
        .find(|index| value >= tracks[*index] - 1.0 && value <= tracks[*index + 1] + 1.0)
}

fn merge_tracks(mut values: Vec<f32>, tolerance: f32) -> Vec<f32> {
    values.sort_by(f32::total_cmp);
    let mut groups: Vec<Vec<f32>> = Vec::new();
    for value in values {
        if groups
            .last()
            .is_some_and(|g| (value - g.iter().sum::<f32>() / g.len() as f32).abs() <= tolerance)
        {
            groups.last_mut().unwrap().push(value);
        } else {
            groups.push(vec![value]);
        }
    }
    groups
        .into_iter()
        .map(|g| g.iter().sum::<f32>() / g.len() as f32)
        .collect()
}

#[derive(Clone)]
struct CandidateCell {
    x: f32,
    right: f32,
    text: String,
}

fn borderless_tables(
    lines: &[TextLine],
    consumed: &mut HashSet<usize>,
    page_width: f32,
) -> Vec<Block> {
    let rows = visual_rows(lines, consumed);
    let midpoint = page_width * 0.5;
    let mut left_rows = Vec::new();
    let mut right_rows = Vec::new();
    for row in &rows {
        let left: Vec<_> = row
            .iter()
            .copied()
            .filter(|(_, line)| line.bbox.right() <= midpoint + 2.0)
            .collect();
        let right: Vec<_> = row
            .iter()
            .copied()
            .filter(|(_, line)| line.bbox.x >= midpoint - 2.0)
            .collect();
        if !left.is_empty() {
            left_rows.push(left);
        }
        if !right.is_empty() {
            right_rows.push(right);
        }
    }
    let wide_left = lines
        .iter()
        .filter(|line| line.bbox.width >= page_width * 0.30 && line.bbox.right() <= midpoint + 2.0)
        .count();
    let wide_right = lines
        .iter()
        .filter(|line| line.bbox.width >= page_width * 0.30 && line.bbox.x >= midpoint - 2.0)
        .count();
    let mut result = if wide_left >= 3 && wide_right >= 3 {
        Vec::new()
    } else {
        detect_borderless_rows(&rows, consumed)
    };
    result.extend(detect_borderless_rows(&left_rows, consumed));
    result.extend(detect_borderless_rows(&right_rows, consumed));
    result
}

fn detect_borderless_rows(
    rows: &[Vec<(usize, &TextLine)>],
    consumed: &mut HashSet<usize>,
) -> Vec<Block> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < rows.len() {
        if rows[index]
            .iter()
            .all(|(line_index, _)| consumed.contains(line_index))
        {
            index += 1;
            continue;
        }
        let first_cells = split_row_cells(&rows[index]);
        if first_cells.len() < 3 {
            index += 1;
            continue;
        }
        let tracks: Vec<f32> = first_cells.iter().map(|cell| cell.x).collect();
        let mut run = Vec::<(usize, Vec<(usize, CandidateCell)>, Option<CandidateCell>)>::new();
        run.push((index, first_cells.into_iter().enumerate().collect(), None));
        let mut next = index + 1;
        while next < rows.len() {
            if rows[next]
                .iter()
                .all(|(line_index, _)| consumed.contains(line_index))
            {
                break;
            }
            let previous_bbox = row_bbox(&rows[run.last().unwrap().0]);
            let next_bbox = row_bbox(&rows[next]);
            let vertical_gap = next_bbox.y - previous_bbox.bottom();
            let max_gap = next_bbox.height.max(previous_bbox.height) * 2.5;
            if vertical_gap > max_gap {
                break;
            }
            let mut cells = split_row_cells(&rows[next]);
            let mut group_label = None;
            if cells.len() == tracks.len() + 1
                && cells[1..]
                    .iter()
                    .zip(&tracks)
                    .all(|(c, x)| (c.x - x).abs() <= TRACK_TOLERANCE)
            {
                group_label = Some(cells.remove(0));
            }
            if cells.len() != tracks.len()
                || !cells
                    .iter()
                    .zip(&tracks)
                    .all(|(cell, track)| (cell.x - track).abs() <= TRACK_TOLERANCE)
            {
                break;
            }
            run.push((next, cells.into_iter().enumerate().collect(), group_label));
            next += 1;
        }
        if run.len() >= 2 {
            let bbox = run
                .iter()
                .map(|(i, _, _)| row_bbox(&rows[*i]))
                .reduce(BBox::union)
                .unwrap();
            let mut cells = Vec::new();
            let run_indices: Vec<usize> = run
                .iter()
                .flat_map(|(visual_row_index, _, _)| {
                    rows[*visual_row_index]
                        .iter()
                        .map(|(line_index, _)| *line_index)
                })
                .collect();
            if run_indices
                .iter()
                .any(|line_index| consumed.contains(line_index))
            {
                index += 1;
                continue;
            }
            let labels: Vec<(usize, &CandidateCell)> = run
                .iter()
                .enumerate()
                .filter_map(|(row, (_, _, label))| label.as_ref().map(|label| (row, label)))
                .collect();
            let label_column = !labels.is_empty();
            for (row, (visual_row_index, row_cells, _)) in run.iter().enumerate() {
                let visual_bbox = row_bbox(&rows[*visual_row_index]);
                for (line_index, _) in &rows[*visual_row_index] {
                    consumed.insert(*line_index);
                }
                for (column, cell) in row_cells {
                    let right = tracks.get(column + 1).copied().unwrap_or(bbox.right());
                    cells.push(TableCell {
                        row,
                        column: *column + usize::from(label_column),
                        row_span: 1,
                        column_span: 1,
                        text: cell.text.clone(),
                        bbox: BBox {
                            x: cell.x,
                            y: visual_bbox.y,
                            width: (right - cell.x).max(cell.right - cell.x),
                            height: visual_bbox.height,
                        },
                    });
                }
            }
            for (label_index, (center_row, label)) in labels.iter().enumerate() {
                let start_row = if label_index == 0 {
                    0
                } else {
                    (labels[label_index - 1].0 + *center_row) / 2 + 1
                };
                let end_row = if label_index + 1 == labels.len() {
                    run.len() - 1
                } else {
                    (*center_row + labels[label_index + 1].0) / 2
                };
                let top_bbox = row_bbox(&rows[run[start_row].0]);
                let bottom_bbox = row_bbox(&rows[run[end_row].0]);
                cells.push(TableCell {
                    row: start_row,
                    column: 0,
                    row_span: end_row - start_row + 1,
                    column_span: 1,
                    text: label.text.clone(),
                    bbox: BBox {
                        x: label.x,
                        y: top_bbox.y,
                        width: tracks[0] - label.x,
                        height: bottom_bbox.bottom() - top_bbox.y,
                    },
                });
            }
            cells.sort_by_key(|cell| (cell.row, cell.column));
            result.push(Block::Table {
                bbox,
                rows: run.len(),
                columns: tracks.len() + usize::from(label_column),
                cells,
                ruled: false,
                semantic_table_id: None,
                semantic_confidence: None,
                continues_from_previous_page: false,
                continues_on_next_page: false,
            });
            index = next;
        } else {
            index += 1;
        }
    }
    result
}

fn visual_rows<'a>(
    lines: &'a [TextLine],
    consumed: &HashSet<usize>,
) -> Vec<Vec<(usize, &'a TextLine)>> {
    let mut source: Vec<(usize, &TextLine)> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !consumed.contains(i))
        .collect();
    source.sort_by(|a, b| {
        a.1.bbox
            .center_y()
            .total_cmp(&b.1.bbox.center_y())
            .then(a.1.bbox.x.total_cmp(&b.1.bbox.x))
    });
    let mut rows: Vec<Vec<(usize, &TextLine)>> = Vec::new();
    for entry in source {
        let best = rows
            .iter()
            .enumerate()
            .filter_map(|(i, row)| {
                let representative = row[0].1;
                let tolerance = representative.bbox.height.max(entry.1.bbox.height) * 0.65;
                let delta = (representative.bbox.center_y() - entry.1.bbox.center_y()).abs();
                (delta <= tolerance).then_some((i, delta))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|x| x.0);
        if let Some(i) = best {
            rows[i].push(entry);
        } else {
            rows.push(vec![entry]);
        }
    }
    for row in &mut rows {
        row.sort_by(|a, b| a.1.bbox.x.total_cmp(&b.1.bbox.x));
    }
    rows.sort_by(|a, b| row_bbox(a).y.total_cmp(&row_bbox(b).y));
    rows
}

fn row_bbox(row: &[(usize, &TextLine)]) -> BBox {
    row.iter()
        .map(|(_, line)| line.bbox)
        .reduce(BBox::union)
        .unwrap_or_default()
}

fn split_row_cells(row: &[(usize, &TextLine)]) -> Vec<CandidateCell> {
    let mut spans: Vec<_> = row
        .iter()
        .flat_map(|(_, line)| line.spans.iter().map(move |span| (span, line.font_size)))
        .collect();
    spans.sort_by(|a, b| a.0.bbox.x.total_cmp(&b.0.bbox.x));
    let mut cells: Vec<CandidateCell> = Vec::new();
    for (span, font_size) in spans {
        let gap = cells
            .last()
            .map(|cell| span.bbox.x - cell.right)
            .unwrap_or(f32::INFINITY);
        if cells.is_empty() || gap > (font_size * 0.80).max(1.0) {
            cells.push(CandidateCell {
                x: span.bbox.x,
                right: span.bbox.right(),
                text: span.text.trim().to_owned(),
            });
        } else {
            let cell = cells.last_mut().unwrap();
            if !cell.text.ends_with(' ') {
                cell.text.push(' ');
            }
            cell.text.push_str(span.text.trim());
            cell.right = cell.right.max(span.bbox.right());
        }
    }
    cells
}

fn text_blocks(mut lines: Vec<(usize, TextLine)>, page_width: f32) -> Vec<Block> {
    if lines.is_empty() {
        return Vec::new();
    }
    // PDFium character iteration is not a reliable document order. Use the
    // same XY geometry to establish regions before paragraph joining, then
    // run XY-cut again on the resulting semantic blocks at the end.
    let line_blocks: Vec<Block> = lines
        .drain(..)
        .map(|(_, line)| Block::Paragraph {
            bbox: line.bbox,
            text: line.text.clone(),
            lines: vec![line],
        })
        .collect();
    lines = xy_cut_plus_plus(line_blocks)
        .into_iter()
        .enumerate()
        .filter_map(|(i, block)| match block {
            Block::Paragraph { mut lines, .. } => lines.pop().map(|line| (i, line)),
            _ => None,
        })
        .collect();
    let body_size = weighted_body_size(lines.iter().map(|(_, line)| line));
    let heading_evidence = lines.len() >= 4;
    let heading_sizes = if heading_evidence {
        heading_size_levels(lines.iter().map(|(_, line)| line), body_size)
    } else {
        Vec::new()
    };
    let mut blocks = Vec::new();
    let mut paragraph = Vec::<TextLine>::new();
    for index in 0..lines.len() {
        let line = lines[index].1.clone();
        let previous = index.checked_sub(1).map(|previous| &lines[previous].1);
        let next = lines.get(index + 1).map(|(_, line)| line);
        let next_next = lines.get(index + 2).map(|(_, line)| line);
        let heading_level = heading_evidence
            .then(|| {
                classify_heading(
                    &line,
                    previous,
                    next,
                    next_next,
                    body_size,
                    &heading_sizes,
                    page_width,
                )
            })
            .flatten();
        if let Some(level) = heading_level {
            flush_paragraph(&mut blocks, &mut paragraph);
            append_heading_line(&mut blocks, line, level);
        } else if paragraph
            .last()
            .is_some_and(|previous| paragraph_continues(previous, &line))
        {
            paragraph.push(line);
        } else {
            flush_paragraph(&mut blocks, &mut paragraph);
            paragraph.push(line);
        }
    }
    flush_paragraph(&mut blocks, &mut paragraph);
    blocks
}

fn line_font_name(line: &TextLine) -> Option<&str> {
    line.spans
        .iter()
        .max_by_key(|span| {
            span.text
                .chars()
                .filter(|character| !character.is_whitespace())
                .count()
        })
        .map(|span| span.font_name.as_str())
}

fn normalize_font_name(name: &str) -> String {
    name.rsplit_once('+')
        .map(|(_, suffix)| suffix)
        .unwrap_or(name)
        .to_ascii_lowercase()
}

fn font_name_suggests_emphasis(name: &str) -> bool {
    let name = normalize_font_name(name);
    ["bold", "semibold", "semi-bold", "demi", "black", "heavy"]
        .iter()
        .any(|marker| name.contains(marker))
}

fn append_heading_line(blocks: &mut Vec<Block>, line: TextLine, level: u8) {
    let continues_previous = matches!(
        blocks.last(),
        Some(Block::Heading {
            level: previous_level,
            lines,
            ..
        }) if *previous_level == level
            && lines
                .last()
                .is_some_and(|previous| paragraph_continues(previous, &line))
    );
    if continues_previous {
        let Some(Block::Heading {
            bbox, text, lines, ..
        }) = blocks.last_mut()
        else {
            unreachable!("the previous block was just matched as a heading")
        };
        *bbox = bbox.union(line.bbox);
        text.push(' ');
        text.push_str(line.text.trim());
        lines.push(line);
        return;
    }
    blocks.push(Block::Heading {
        bbox: line.bbox,
        text: line.text.clone(),
        level,
        lines: vec![line],
    });
}

fn weighted_body_size<'a>(lines: impl Iterator<Item = &'a TextLine>) -> f32 {
    let mut sizes = Vec::new();
    for line in lines {
        let count = line
            .text
            .chars()
            .filter(|c| !c.is_whitespace())
            .count()
            .max(1);
        sizes.extend(std::iter::repeat_n(line.font_size, count.min(1000)));
    }
    sizes.sort_by(f32::total_cmp);
    sizes.get(sizes.len() / 2).copied().unwrap_or(10.0)
}

fn heading_size_levels<'a>(lines: impl Iterator<Item = &'a TextLine>, body: f32) -> Vec<f32> {
    let mut sizes: Vec<f32> = lines
        .filter(|line| line.font_size >= body * 1.30 && line.text.chars().count() <= 160)
        .map(|line| line.font_size)
        .collect();
    sizes.sort_by(|a, b| b.total_cmp(a));
    let mut levels = Vec::new();
    for size in sizes {
        if levels
            .iter()
            .all(|existing: &f32| (*existing - size).abs() > 0.75)
        {
            levels.push(size);
        }
    }
    levels.truncate(6);
    levels
}

fn classify_heading(
    line: &TextLine,
    previous: Option<&TextLine>,
    next: Option<&TextLine>,
    next_next: Option<&TextLine>,
    body: f32,
    levels: &[f32],
    page_width: f32,
) -> Option<u8> {
    let text = line.text.trim();
    let has_alphabetic = text.chars().any(char::is_alphabetic);
    if text.is_empty()
        || !has_alphabetic
        || text.chars().count() > 160
        || text.ends_with('.') && text.chars().count() > 80
    {
        return None;
    }
    let size_heading = line.font_size >= body * 1.30;
    let chars: Vec<char> = text.chars().collect();
    let alphabetic = chars.iter().filter(|ch| ch.is_alphabetic()).count();
    let uppercase =
        alphabetic > 0 && chars.iter().filter(|ch| ch.is_uppercase()).count() * 5 >= alphabetic * 4;
    let structural_shape = !text.contains(char::is_whitespace)
        || chars.first().is_some_and(char::is_ascii_digit)
        || chars.get(1) == Some(&'.')
        || uppercase;
    let bold_short = structural_shape
        && line.font_weight >= 600
        && line.font_size >= body * 0.98
        && text.chars().count() <= 80;
    let emphasized_face = line_font_name(line).is_some_and(font_name_suggests_emphasis);
    let same_column_gap = |other: &TextLine, before: bool| {
        let same_column =
            overlap_x(other.bbox, line.bbox) > other.bbox.width.min(line.bbox.width) * 0.20;
        if !same_column {
            return None;
        }
        Some(if before {
            line.bbox.y - other.bbox.bottom()
        } else {
            other.bbox.y - line.bbox.bottom()
        })
    };
    let line_height = line.bbox.height.max(line.font_size).max(1.0);
    let break_before = previous
        .and_then(|other| same_column_gap(other, true))
        .is_none_or(|gap| gap >= line_height * 0.42);
    let followed_by_email = next
        .into_iter()
        .chain(next_next)
        .any(|other| other.text.contains('@'));
    let body_after = next.is_some_and(|other| {
        overlap_x(other.bbox, line.bbox) > other.bbox.width.min(line.bbox.width) * 0.20
            && (other.font_size - body).abs() <= 1.0
            && other.text.chars().count() >= 25
    });
    let same_size_styled = line.font_size >= body * 0.96
        && text.chars().count() <= 100
        && heading_title_shape(text)
        && (emphasized_face || line.font_weight >= 600)
        && !followed_by_email
        && (break_before || body_after);
    let width_ok = line.bbox.width < page_width * 0.92;
    if !(width_ok && (size_heading || bold_short || same_size_styled)) {
        return None;
    }
    if size_heading {
        levels
            .iter()
            .position(|size| (*size - line.font_size).abs() <= 0.75)
            .map(|i| (i + 1) as u8)
            .or(Some(1))
    } else {
        Some((levels.len() + 1).clamp(1, 6) as u8)
    }
}

fn heading_title_shape(text: &str) -> bool {
    if text.ends_with(['.', ',', ';']) {
        return false;
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() || words.len() > 14 {
        return false;
    }
    let connectors = [
        "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to",
        "via", "with",
    ];
    words.iter().all(|word| {
        let trimmed = word.trim_matches(|character: char| !character.is_alphanumeric());
        trimmed.is_empty()
            || connectors.contains(&trimmed.to_ascii_lowercase().as_str())
            || trimmed
                .chars()
                .next()
                .is_some_and(|character| character.is_uppercase() || character.is_ascii_digit())
    })
}

fn paragraph_continues(previous: &TextLine, next: &TextLine) -> bool {
    let gap = next.bbox.y - previous.bbox.bottom();
    let line_height = previous.bbox.height.max(next.bbox.height).max(1.0);
    let left_aligned =
        (previous.bbox.x - next.bbox.x).abs() <= previous.font_size.max(next.font_size) * 0.8;
    let same_column =
        overlap_x(previous.bbox, next.bbox) > previous.bbox.width.min(next.bbox.width) * 0.25;
    let same_style = (previous.font_size - next.font_size).abs() <= 1.0
        && previous.font_weight.abs_diff(next.font_weight) <= 200;
    gap >= -line_height * 0.25
        && gap <= line_height * 1.15
        && same_column
        && same_style
        && (left_aligned
            || previous.bbox.right().min(next.bbox.right()) - previous.bbox.x.max(next.bbox.x)
                > 0.0)
}

fn overlap_x(a: BBox, b: BBox) -> f32 {
    (a.right().min(b.right()) - a.x.max(b.x)).max(0.0)
}

fn flush_paragraph(blocks: &mut Vec<Block>, lines: &mut Vec<TextLine>) {
    if lines.is_empty() {
        return;
    }
    let lines = std::mem::take(lines);
    let bbox = lines.iter().map(|l| l.bbox).reduce(BBox::union).unwrap();
    let mut text = String::new();
    for line in &lines {
        if text.ends_with('-') && line.text.chars().next().is_some_and(char::is_lowercase) {
            text.pop();
        } else if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(line.text.trim());
    }
    blocks.push(Block::Paragraph { bbox, text, lines });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Span;
    fn line(text: &str, x: f32, y: f32, size: f32) -> TextLine {
        line_with_font(text, x, y, size, 400, "Test")
    }
    fn line_with_font(
        text: &str,
        x: f32,
        y: f32,
        size: f32,
        weight: u16,
        font_name: &str,
    ) -> TextLine {
        let bbox = BBox {
            x,
            y,
            width: text.len() as f32 * 5.0,
            height: size,
        };
        TextLine {
            text: text.into(),
            bbox,
            font_size: size,
            font_weight: weight,
            spans: vec![Span {
                text: text.into(),
                bbox,
                font_size: size,
                font_weight: weight,
                font_name: font_name.into(),
                rotation: 0.0,
            }],
        }
    }
    #[test]
    fn groups_body_lines_and_keeps_heading() {
        let blocks = text_blocks(
            vec![
                (0, line("Title", 10.0, 10.0, 18.0)),
                (1, line("First body line", 10.0, 40.0, 10.0)),
                (2, line("second body line", 10.0, 51.0, 10.0)),
                (3, line("third body line", 10.0, 62.0, 10.0)),
            ],
            500.0,
        );
        assert!(matches!(blocks[0], Block::Heading { level: 1, .. }));
        assert!(matches!(&blocks[1], Block::Paragraph { lines, .. } if lines.len() == 3));
    }
    #[test]
    fn detects_same_size_heading_from_bold_font_face() {
        let blocks = text_blocks(
            vec![
                (
                    0,
                    line_with_font("Introduction", 10.0, 10.0, 10.0, 400, "Journal-Bold"),
                ),
                (
                    1,
                    line_with_font(
                        "Model-informed dosing is used for individual patients",
                        10.0,
                        25.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
                (
                    2,
                    line_with_font(
                        "and combines pharmacokinetic models with patient data",
                        10.0,
                        36.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
                (
                    3,
                    line_with_font(
                        "to support more accurate and individualized treatment",
                        10.0,
                        47.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
            ],
            500.0,
        );
        assert!(matches!(&blocks[0], Block::Heading { text, .. } if text == "Introduction"));
        assert!(matches!(&blocks[1], Block::Paragraph { lines, .. } if lines.len() == 3));
    }
    #[test]
    fn does_not_promote_title_case_italic_reference_line() {
        let blocks = text_blocks(
            vec![
                (
                    0,
                    line_with_font(
                        "In Proceedings of Computer Vision",
                        10.0,
                        10.0,
                        10.0,
                        400,
                        "Journal-Italic",
                    ),
                ),
                (
                    1,
                    line_with_font(
                        "pages 100-110 followed by the remaining citation details",
                        10.0,
                        21.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
                (
                    2,
                    line_with_font(
                        "A second sufficiently long reference entry follows here",
                        10.0,
                        38.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
                (
                    3,
                    line_with_font(
                        "and continues with ordinary bibliographic information",
                        10.0,
                        49.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
            ],
            500.0,
        );
        assert!(!blocks.iter().any(
            |block| matches!(block, Block::Heading { text, .. } if text == "In Proceedings of Computer Vision")
        ));
    }
    #[test]
    fn does_not_promote_bold_author_above_email_affiliation() {
        let blocks = text_blocks(
            vec![
                (
                    0,
                    line_with_font("Ashish Vaswani", 10.0, 10.0, 10.0, 400, "Journal-Bold"),
                ),
                (
                    1,
                    line_with_font("Google Brain", 10.0, 21.0, 10.0, 400, "Journal-Regular"),
                ),
                (
                    2,
                    line_with_font(
                        "avaswani@google.com",
                        10.0,
                        32.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
                (
                    3,
                    line_with_font(
                        "The abstract contains a sufficiently long body text line",
                        10.0,
                        53.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
                (
                    4,
                    line_with_font(
                        "and continues here with more ordinary prose for weighting",
                        10.0,
                        64.0,
                        10.0,
                        400,
                        "Journal-Regular",
                    ),
                ),
            ],
            500.0,
        );
        assert!(!blocks
            .iter()
            .any(|block| matches!(block, Block::Heading { text, .. } if text == "Ashish Vaswani")));
    }
    #[test]
    fn builds_simple_ruled_grid() {
        let rules = vec![
            Rule {
                x1: 0.0,
                y1: 0.0,
                x2: 100.0,
                y2: 0.0,
                width: 1.0,
            },
            Rule {
                x1: 0.0,
                y1: 20.0,
                x2: 100.0,
                y2: 20.0,
                width: 1.0,
            },
            Rule {
                x1: 0.0,
                y1: 40.0,
                x2: 100.0,
                y2: 40.0,
                width: 1.0,
            },
            Rule {
                x1: 0.0,
                y1: 0.0,
                x2: 0.0,
                y2: 40.0,
                width: 1.0,
            },
            Rule {
                x1: 50.0,
                y1: 0.0,
                x2: 50.0,
                y2: 40.0,
                width: 1.0,
            },
            Rule {
                x1: 100.0,
                y1: 0.0,
                x2: 100.0,
                y2: 40.0,
                width: 1.0,
            },
        ];
        let mut consumed = HashSet::new();
        let tables = ruled_tables(&[], &rules, &mut consumed);
        assert!(matches!(
            &tables[0],
            Block::Table {
                rows: 2,
                columns: 2,
                ruled: true,
                ..
            }
        ));
    }

    #[test]
    fn joins_fragmented_grid_rules_but_not_formula_bar_into_table() {
        let fragmented = vec![
            Rule {
                x1: 0.0,
                y1: 0.0,
                x2: 48.0,
                y2: 0.0,
                width: 1.0,
            },
            Rule {
                x1: 51.0,
                y1: 0.2,
                x2: 100.0,
                y2: 0.2,
                width: 1.0,
            },
            Rule {
                x1: 0.0,
                y1: 20.0,
                x2: 100.0,
                y2: 20.0,
                width: 1.0,
            },
            Rule {
                x1: 0.0,
                y1: 40.0,
                x2: 100.0,
                y2: 40.0,
                width: 1.0,
            },
            Rule {
                x1: 0.0,
                y1: 0.0,
                x2: 0.0,
                y2: 40.0,
                width: 1.0,
            },
            Rule {
                x1: 50.0,
                y1: 0.0,
                x2: 50.0,
                y2: 40.0,
                width: 1.0,
            },
            Rule {
                x1: 100.0,
                y1: 0.0,
                x2: 100.0,
                y2: 40.0,
                width: 1.0,
            },
        ];
        let joined = join_collinear_rule_fragments(&fragmented);
        let mut consumed = HashSet::new();
        assert_eq!(ruled_tables(&[], &joined, &mut consumed).len(), 1);

        let formula = vec![
            Rule {
                x1: 10.0,
                y1: 20.0,
                x2: 17.0,
                y2: 20.0,
                width: 0.5,
            },
            Rule {
                x1: 19.0,
                y1: 20.1,
                x2: 27.0,
                y2: 20.1,
                width: 0.5,
            },
        ];
        let joined_formula = join_collinear_rule_fragments(&formula);
        assert_eq!(joined_formula.len(), 1);
        assert!(ruled_tables(&[], &joined_formula, &mut HashSet::new()).is_empty());
    }

    #[test]
    fn links_only_adjacent_edge_tables_with_matching_column_signatures() {
        fn table(y: f32) -> Block {
            Block::Table {
                bbox: BBox {
                    x: 50.0,
                    y,
                    width: 400.0,
                    height: 100.0,
                },
                rows: 2,
                columns: 2,
                cells: vec![
                    TableCell {
                        row: 0,
                        column: 0,
                        row_span: 1,
                        column_span: 1,
                        text: "A".into(),
                        bbox: BBox {
                            x: 50.0,
                            y,
                            width: 200.0,
                            height: 50.0,
                        },
                    },
                    TableCell {
                        row: 0,
                        column: 1,
                        row_span: 1,
                        column_span: 1,
                        text: "B".into(),
                        bbox: BBox {
                            x: 250.0,
                            y,
                            width: 200.0,
                            height: 50.0,
                        },
                    },
                ],
                ruled: true,
                semantic_table_id: None,
                semantic_confidence: None,
                continues_from_previous_page: false,
                continues_on_next_page: false,
            }
        }
        fn page(number: usize, block: Block) -> Page {
            Page {
                number,
                width: 500.0,
                height: 800.0,
                blocks: vec![block],
                citations: Vec::new(),
                note_references: Vec::new(),
                sentences: Vec::new(),
                semantic_regions: Vec::new(),
                internal_links: Vec::new(),
                marked_objects: Vec::new(),
                images: Vec::new(),
                lines: Vec::new(),
                rules: Vec::new(),
            }
        }
        let mut pages = vec![page(1, table(700.0)), page(2, table(0.0))];
        reconcile_geometry_table_continuations(&mut pages);
        assert!(matches!(
            &pages[0].blocks[0],
            Block::Table { continues_on_next_page: true, semantic_table_id: Some(id), .. }
                if id.starts_with("geo-chain:")
        ));
        assert!(matches!(
            &pages[1].blocks[0],
            Block::Table {
                continues_from_previous_page: true,
                ..
            }
        ));
    }
}
