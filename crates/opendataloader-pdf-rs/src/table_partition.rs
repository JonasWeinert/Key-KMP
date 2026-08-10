//! Parameterized final cell partition and exclusive text-assignment pass.

use std::collections::{BTreeMap, HashSet};

use crate::model::{BBox, Block, Page, Rule, TableCell, TextLine};

#[derive(Clone, Debug)]
pub struct TablePartitionConfig {
    pub enabled: bool,
    pub sequence_merge_gap_em: f32,
    pub orphan_row_min_sequences: usize,
    pub orphan_row_min_column_fraction: f32,
    pub orphan_row_baseline_tolerance: f32,
    pub local_anchor_tolerance_fraction: f32,
    pub assignment_min_score: f32,
    pub infer_orphan_spans: bool,
    pub snap_to_vector_rules: bool,
    pub strong_rule_coverage_fraction: f32,
    pub rule_snap_tolerance_fraction: f32,
    pub infer_topology_spans: bool,
    pub span_boundary_crossing_tolerance: f32,
    pub split_overloaded_spans: bool,
}

impl Default for TablePartitionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sequence_merge_gap_em: 0.45,
            orphan_row_min_sequences: 2,
            orphan_row_min_column_fraction: 0.35,
            orphan_row_baseline_tolerance: 0.55,
            local_anchor_tolerance_fraction: 0.20,
            assignment_min_score: 0.18,
            infer_orphan_spans: true,
            snap_to_vector_rules: true,
            strong_rule_coverage_fraction: 0.70,
            rule_snap_tolerance_fraction: 0.55,
            infer_topology_spans: true,
            span_boundary_crossing_tolerance: 1.5,
            split_overloaded_spans: false,
        }
    }
}

#[derive(Clone, Debug)]
struct Sequence {
    text: String,
    bbox: BBox,
}

pub fn normalize_pages(pages: &mut [Page], config: &TablePartitionConfig) {
    if !config.enabled {
        return;
    }
    for page in pages {
        let lines = page.lines.clone();
        let rules = page.rules.clone();
        for block in &mut page.blocks {
            normalize_table(block, &lines, &rules, config);
        }
    }
}

fn normalize_table(
    block: &mut Block,
    lines: &[TextLine],
    rules: &[Rule],
    config: &TablePartitionConfig,
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
    if *rows == 0 || *columns == 0 || cells.is_empty() {
        return;
    }
    let sequences = table_sequences(lines, *bbox, config.sequence_merge_gap_em);
    if sequences.is_empty() {
        return;
    }
    if config.split_overloaded_spans {
        split_overloaded_spanning_cells(
            *bbox,
            *columns,
            cells,
            &sequences,
            config.local_anchor_tolerance_fraction,
        );
    }

    let orphan_groups = visual_sequence_rows(
        sequences
            .iter()
            .filter(|sequence| {
                !cells.iter().any(|cell| {
                    contains_with_padding(
                        cell.bbox,
                        sequence.bbox.center_x(),
                        sequence.bbox.center_y(),
                        1.0,
                    )
                })
            })
            .cloned()
            .collect(),
        config.orphan_row_baseline_tolerance,
    );
    let xs = column_boundaries(
        *bbox,
        *columns,
        cells,
        config.local_anchor_tolerance_fraction,
    );
    for group in orphan_groups {
        if !valid_orphan_row(
            &group,
            &xs,
            config.orphan_row_min_sequences,
            config.orphan_row_min_column_fraction,
        ) {
            continue;
        }
        let group_box = row_bbox(&group);
        if cells
            .iter()
            .any(|cell| vertical_overlap_fraction(cell.bbox, group_box) >= 0.45)
        {
            continue;
        }
        let centers = row_centers(*rows, cells);
        let insertion = centers
            .iter()
            .position(|center| group_box.center_y() < *center)
            .unwrap_or(*rows);
        for cell in cells.iter_mut().filter(|cell| cell.row >= insertion) {
            cell.row += 1;
        }
        let additions = orphan_row_cells(
            &group,
            insertion,
            &xs,
            *bbox,
            rules,
            config.infer_orphan_spans,
        );
        if additions.is_empty() {
            for cell in cells.iter_mut().filter(|cell| cell.row > insertion) {
                cell.row -= 1;
            }
        } else {
            cells.extend(additions);
            *rows += 1;
        }
    }

    if config.infer_topology_spans {
        infer_spans_from_original_geometry(*bbox, *rows, *columns, cells, rules, config);
    }
    normalize_partitions(
        *bbox,
        *rows,
        *columns,
        cells,
        rules,
        config,
        config.local_anchor_tolerance_fraction,
    );
    assign_sequences_exclusively(&sequences, cells, config.assignment_min_score);
    cells.sort_by_key(|cell| (cell.row, cell.column));
}

fn split_overloaded_spanning_cells(
    table: BBox,
    columns: usize,
    cells: &mut Vec<TableCell>,
    sequences: &[Sequence],
    local_tolerance: f32,
) {
    let boundaries = column_boundaries(table, columns, cells, local_tolerance);
    let mut rebuilt = Vec::with_capacity(cells.len());
    for cell in cells.drain(..) {
        if cell.column_span <= 1 {
            rebuilt.push(cell);
            continue;
        }
        let mut groups = BTreeMap::<(usize, usize), Vec<&Sequence>>::new();
        for sequence in sequences.iter().filter(|sequence| {
            contains_with_padding(
                cell.bbox,
                sequence.bbox.center_x(),
                sequence.bbox.center_y(),
                1.0,
            )
        }) {
            let overlaps = overlapping_columns(sequence.bbox, &boundaries, 0.30);
            let Some((&start, &end)) = overlaps.first().zip(overlaps.last()) else {
                continue;
            };
            if start < cell.column || end >= cell.column + cell.column_span {
                continue;
            }
            groups.entry((start, end)).or_default().push(sequence);
        }
        let mut ranges = groups.keys().copied().collect::<Vec<_>>();
        ranges.sort_unstable();
        let distinct = ranges.len() >= 2 && ranges.windows(2).all(|pair| pair[0].1 < pair[1].0);
        if !distinct {
            rebuilt.push(cell);
            continue;
        }
        rebuilt.extend(groups.into_iter().map(|((start, end), members)| {
            TableCell {
                row: cell.row,
                column: start,
                row_span: cell.row_span,
                column_span: end - start + 1,
                text: members
                    .iter()
                    .map(|member| member.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                bbox: members
                    .iter()
                    .map(|member| member.bbox)
                    .reduce(BBox::union)
                    .unwrap(),
            }
        }));
    }
    *cells = rebuilt;
}

fn infer_spans_from_original_geometry(
    table: BBox,
    rows: usize,
    columns: usize,
    cells: &mut [TableCell],
    rules: &[Rule],
    config: &TablePartitionConfig,
) {
    if rows == 0 || columns == 0 {
        return;
    }
    let ys = row_boundaries(table, rows, cells);
    let occupied = cells
        .iter()
        .flat_map(|cell| {
            (cell.row..(cell.row + cell.row_span).min(rows)).flat_map(move |row| {
                (cell.column..(cell.column + cell.column_span).min(columns))
                    .map(move |column| (row, column))
            })
        })
        .collect::<HashSet<_>>();
    let peer_row_spans = cells.iter().filter(|cell| cell.row_span > 1).fold(
        BTreeMap::<usize, usize>::new(),
        |mut spans, cell| {
            spans
                .entry(cell.row)
                .and_modify(|span| *span = (*span).max(cell.row_span))
                .or_insert(cell.row_span);
            spans
        },
    );

    for cell in cells.iter_mut() {
        let original = cell.bbox;
        if cell.row_span != 1 {
            continue;
        }
        let peer_span = peer_row_spans.get(&cell.row).copied().filter(|span| {
            cell.row + span <= rows
                && (cell.row + 1..cell.row + span).all(|row| {
                    !occupied.contains(&(row, cell.column))
                        && !horizontal_rule_crosses_cell(rules, ys[row], original, table)
                })
        });
        if let Some(span) = peer_span {
            // Repeated same-row topology is stronger than bbox height. This
            // recovers paired group labels such as two six-row parameter
            // descriptors without treating ordinary multiline body cells as
            // spans.
            cell.row_span = span;
        } else if cell.row == 0 {
            // A broad box crossing the next track is reliable undeclared-
            // rowspan evidence in a leading multilevel header. Below row zero
            // it commonly means multiline content inside one tall data row.
            let mut end = cell.row + 1;
            while end < rows
                && !occupied.contains(&(end, cell.column))
                && original.bottom() + config.span_boundary_crossing_tolerance >= ys[end]
                && !horizontal_rule_crosses_cell(rules, ys[end], original, table)
            {
                end += 1;
            }
            cell.row_span = end - cell.row;
        }
        // Do not infer a colspan from a broad original box alone. Sparse
        // numerical tables commonly give one text-bearing cell the whole
        // remaining row envelope. Existing declared colspans and orphan-row
        // text crossings are preserved; novel colspans need sequence-level
        // crossing or repeated-template evidence.
    }
}

fn horizontal_rule_crosses_cell(rules: &[Rule], y: f32, cell: BBox, table: BBox) -> bool {
    rules.iter().copied().any(|rule| {
        if !rule.horizontal() || (rule.y1 - y).abs() > 1.5 {
            return false;
        }
        let left = rule.x1.min(rule.x2).max(table.x);
        let right = rule.x1.max(rule.x2).min(table.right());
        let overlap = (right.min(cell.right()) - left.max(cell.x)).max(0.0);
        overlap / cell.width.max(0.1) >= 0.65
    })
}

fn table_sequences(lines: &[TextLine], table: BBox, merge_gap_em: f32) -> Vec<Sequence> {
    let mut result = Vec::new();
    for line in lines {
        if intersection_fraction(line.bbox, table) < 0.25 {
            continue;
        }
        if is_table_caption(&line.text) {
            continue;
        }
        let mut spans = line
            .spans
            .iter()
            .filter(|span| intersection_fraction(span.bbox, table) >= 0.25)
            .collect::<Vec<_>>();
        spans.sort_by(|left, right| left.bbox.x.total_cmp(&right.bbox.x));
        let mut current: Option<Sequence> = None;
        for span in spans {
            let join = current.as_ref().is_some_and(|before| {
                span.bbox.x - before.bbox.right() <= span.font_size.max(1.0) * merge_gap_em
                    && (span.bbox.center_y() - before.bbox.center_y()).abs()
                        <= span.bbox.height.max(before.bbox.height) * 0.45
            });
            if join {
                let sequence = current.as_mut().unwrap();
                if !sequence.text.is_empty() {
                    sequence.text.push(' ');
                }
                sequence.text.push_str(span.text.trim());
                sequence.bbox = sequence.bbox.union(span.bbox);
            } else {
                if let Some(sequence) = current.take().filter(|item| !item.text.trim().is_empty()) {
                    result.push(sequence);
                }
                current = Some(Sequence {
                    text: span.text.trim().to_owned(),
                    bbox: span.bbox,
                });
            }
        }
        if let Some(sequence) = current.filter(|item| !item.text.trim().is_empty()) {
            result.push(sequence);
        }
    }
    result.sort_by(|left, right| {
        left.bbox
            .y
            .total_cmp(&right.bbox.y)
            .then(left.bbox.x.total_cmp(&right.bbox.x))
    });
    result
}

fn visual_sequence_rows(mut sequences: Vec<Sequence>, tolerance: f32) -> Vec<Vec<Sequence>> {
    sequences.sort_by(|left, right| {
        left.bbox
            .center_y()
            .total_cmp(&right.bbox.center_y())
            .then(left.bbox.x.total_cmp(&right.bbox.x))
    });
    let mut rows: Vec<Vec<Sequence>> = Vec::new();
    for sequence in sequences {
        let target = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let representative = &row[0];
                let delta = (representative.bbox.center_y() - sequence.bbox.center_y()).abs();
                let allowed = representative.bbox.height.max(sequence.bbox.height) * tolerance;
                (delta <= allowed).then_some((index, delta))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1))
            .map(|item| item.0);
        if let Some(index) = target {
            rows[index].push(sequence);
        } else {
            rows.push(vec![sequence]);
        }
    }
    rows
}

fn valid_orphan_row(
    row: &[Sequence],
    boundaries: &[f32],
    minimum_sequences: usize,
    minimum_column_fraction: f32,
) -> bool {
    if row.len() < minimum_sequences || boundaries.len() < 2 {
        return false;
    }
    let columns = boundaries.len() - 1;
    let touched = row
        .iter()
        .flat_map(|sequence| overlapping_columns(sequence.bbox, boundaries, 0.30))
        .collect::<HashSet<_>>()
        .len();
    touched >= ((columns as f32 * minimum_column_fraction).ceil() as usize).max(1)
        && row
            .iter()
            .map(|item| item.text.chars().count())
            .sum::<usize>()
            >= 3
}

fn orphan_row_cells(
    row: &[Sequence],
    row_index: usize,
    boundaries: &[f32],
    table: BBox,
    rules: &[Rule],
    infer_spans: bool,
) -> Vec<TableCell> {
    let proposed = row
        .iter()
        .filter_map(|sequence| {
            let overlaps = overlapping_columns(sequence.bbox, boundaries, 0.30);
            (overlaps.len() > 1).then_some((overlaps[0], *overlaps.last().unwrap()))
        })
        .collect::<Vec<_>>();
    let mut grouped = BTreeMap::<(usize, usize), Vec<&Sequence>>::new();
    for sequence in row {
        let overlaps = overlapping_columns(sequence.bbox, boundaries, 0.30);
        if overlaps.is_empty() {
            continue;
        }
        let start = overlaps[0];
        let proposed_end = *overlaps.last().unwrap();
        let repeated_template = proposed
            .iter()
            .filter(|candidate| **candidate == (start, proposed_end))
            .count()
            > 1;
        let strong_geometric_crossing = proposed_end > start
            && (start + 1..=proposed_end).all(|boundary| {
                let x = boundaries[boundary];
                let left = x - sequence.bbox.x;
                let right = sequence.bbox.right() - x;
                left >= sequence.bbox.height * 0.30
                    && right >= sequence.bbox.height * 0.30
                    && !vertical_rule_crosses_band(rules, x, sequence.bbox, table)
            });
        let end = if infer_spans && (repeated_template || strong_geometric_crossing) {
            proposed_end
        } else {
            start
        };
        grouped.entry((start, end)).or_default().push(sequence);
    }
    grouped
        .into_iter()
        .map(|((start, end), mut sequences)| {
            sequences.sort_by(|left, right| left.bbox.x.total_cmp(&right.bbox.x));
            TableCell {
                row: row_index,
                column: start,
                row_span: 1,
                column_span: end - start + 1,
                text: sequences
                    .iter()
                    .map(|sequence| sequence.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                bbox: sequences
                    .iter()
                    .map(|sequence| sequence.bbox)
                    .reduce(BBox::union)
                    .unwrap(),
            }
        })
        .collect()
}

fn vertical_rule_crosses_band(rules: &[Rule], x: f32, band: BBox, table: BBox) -> bool {
    rules.iter().copied().any(|rule| {
        if !rule.vertical() || (rule.x1 - x).abs() > 1.5 {
            return false;
        }
        let top = rule.y1.min(rule.y2).max(table.y);
        let bottom = rule.y1.max(rule.y2).min(table.bottom());
        let overlap = (bottom.min(band.bottom()) - top.max(band.y)).max(0.0);
        overlap / band.height.max(0.1) >= 0.65
    })
}

fn normalize_partitions(
    table: BBox,
    rows: usize,
    columns: usize,
    cells: &mut [TableCell],
    rules: &[Rule],
    config: &TablePartitionConfig,
    local_tolerance: f32,
) {
    let mut xs = column_boundaries(table, columns, cells, local_tolerance);
    let mut ys = row_boundaries(table, rows, cells);
    if config.snap_to_vector_rules {
        snap_internal_boundaries_to_rules(
            &mut xs,
            table,
            rules,
            false,
            config.strong_rule_coverage_fraction,
            config.rule_snap_tolerance_fraction,
        );
        snap_internal_boundaries_to_rules(
            &mut ys,
            table,
            rules,
            true,
            config.strong_rule_coverage_fraction,
            config.rule_snap_tolerance_fraction,
        );
    }
    for cell in cells {
        if cell.row >= rows || cell.column >= columns {
            continue;
        }
        let end_row = (cell.row + cell.row_span).min(rows);
        let end_column = (cell.column + cell.column_span).min(columns);
        cell.row_span = end_row - cell.row;
        cell.column_span = end_column - cell.column;
        cell.bbox = BBox {
            x: xs[cell.column],
            y: ys[cell.row],
            width: xs[end_column] - xs[cell.column],
            height: ys[end_row] - ys[cell.row],
        };
    }
}

/// Snap an already-supported atomic partition to nearby strong vector rules.
///
/// Rules do not create rows or columns here: that would let decorative strokes
/// over-segment a table. They only refine a boundary that text/cell alignment
/// has independently established. This also preserves the distinction between
/// the atomic grid and later row/column spans.
fn snap_internal_boundaries_to_rules(
    boundaries: &mut [f32],
    table: BBox,
    rules: &[Rule],
    horizontal: bool,
    minimum_coverage: f32,
    tolerance_fraction: f32,
) {
    if boundaries.len() < 3 {
        return;
    }
    let typical_interval =
        (boundaries[boundaries.len() - 1] - boundaries[0]) / (boundaries.len() - 1) as f32;
    let tolerance = (typical_interval * tolerance_fraction).clamp(1.0, 12.0);
    let candidates = rules
        .iter()
        .copied()
        .filter_map(|rule| {
            if horizontal && rule.horizontal() {
                let overlap = (rule.x1.max(rule.x2).min(table.right())
                    - rule.x1.min(rule.x2).max(table.x))
                .max(0.0);
                (overlap / table.width.max(0.1) >= minimum_coverage
                    && rule.y1 >= table.y - 1.5
                    && rule.y1 <= table.bottom() + 1.5)
                    .then_some(rule.y1)
            } else if !horizontal && rule.vertical() {
                let overlap = (rule.y1.max(rule.y2).min(table.bottom())
                    - rule.y1.min(rule.y2).max(table.y))
                .max(0.0);
                (overlap / table.height.max(0.1) >= minimum_coverage
                    && rule.x1 >= table.x - 1.5
                    && rule.x1 <= table.right() + 1.5)
                    .then_some(rule.x1)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for index in 1..boundaries.len() - 1 {
        let lower = boundaries[index - 1] + 0.5;
        let upper = boundaries[index + 1] - 0.5;
        let Some(candidate) = candidates
            .iter()
            .copied()
            .filter(|value| *value > lower && *value < upper)
            .min_by(|left, right| {
                (left - boundaries[index])
                    .abs()
                    .total_cmp(&(right - boundaries[index]).abs())
            })
            .filter(|value| (*value - boundaries[index]).abs() <= tolerance)
        else {
            continue;
        };
        boundaries[index] = candidate;
    }
}

fn assign_sequences_exclusively(sequences: &[Sequence], cells: &mut [TableCell], minimum: f32) {
    let mut assigned = vec![Vec::<&Sequence>::new(); cells.len()];
    for sequence in sequences {
        let best = cells
            .iter()
            .enumerate()
            .filter_map(|(index, cell)| {
                let overlap = intersection_fraction(sequence.bbox, cell.bbox);
                let center = usize::from(cell.bbox.contains_center(sequence.bbox)) as f32;
                let dx = (sequence.bbox.center_x() - cell.bbox.center_x()).abs()
                    / cell.bbox.width.max(1.0);
                let dy = (sequence.bbox.center_y() - cell.bbox.center_y()).abs()
                    / cell.bbox.height.max(1.0);
                let specificity = 1.0 / (cell.row_span * cell.column_span).max(1) as f32;
                let score =
                    overlap * 2.5 + center * 0.8 + specificity * 0.15 - dx * 0.12 - dy * 0.12;
                (score >= minimum).then_some((index, score))
            })
            .max_by(|left, right| left.1.total_cmp(&right.1));
        if let Some((index, _)) = best {
            assigned[index].push(sequence);
        }
    }
    for (cell, mut sequences) in cells.iter_mut().zip(assigned) {
        sequences.sort_by(|left, right| {
            left.bbox
                .y
                .total_cmp(&right.bbox.y)
                .then(left.bbox.x.total_cmp(&right.bbox.x))
        });
        cell.text = sequences
            .iter()
            .map(|sequence| sequence.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
    }
}

fn column_boundaries(
    table: BBox,
    columns: usize,
    cells: &[TableCell],
    local_tolerance: f32,
) -> Vec<f32> {
    let typical_width = table.width / columns.max(1) as f32;
    let centers = (0..columns)
        .map(|column| {
            let values = cells
                .iter()
                .filter(|cell| cell.column == column && cell.column_span == 1)
                .map(|cell| cell.bbox.center_x())
                .collect::<Vec<_>>();
            let tolerance_max = (typical_width * 0.45).max(0.0);
            dominant_cluster_center(
                values,
                (typical_width * local_tolerance).clamp(1.0_f32.min(tolerance_max), tolerance_max),
            )
            .unwrap_or(table.x + table.width * (column as f32 + 0.5) / columns.max(1) as f32)
        })
        .collect::<Vec<_>>();
    centers_to_boundaries(table.x, table.right(), &centers)
}

fn dominant_cluster_center(mut values: Vec<f32>, tolerance: f32) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    let mut groups = Vec::<Vec<f32>>::new();
    for value in values {
        if groups.last().is_some_and(|group| {
            let center = group.iter().sum::<f32>() / group.len() as f32;
            (value - center).abs() <= tolerance
        }) {
            groups.last_mut().unwrap().push(value);
        } else {
            groups.push(vec![value]);
        }
    }
    groups
        .into_iter()
        .max_by(|left, right| left.len().cmp(&right.len()))
        .map(|group| group.iter().sum::<f32>() / group.len() as f32)
}

fn is_table_caption(text: &str) -> bool {
    let text = text.trim_start();
    let Some(rest) = text
        .strip_prefix("Table ")
        .or_else(|| text.strip_prefix("TABLE "))
    else {
        return false;
    };
    rest.chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit() || matches!(character, 'I' | 'V' | 'X'))
}

fn row_boundaries(table: BBox, rows: usize, cells: &[TableCell]) -> Vec<f32> {
    centers_to_boundaries(table.y, table.bottom(), &row_centers(rows, cells))
}

fn row_centers(rows: usize, cells: &[TableCell]) -> Vec<f32> {
    let union = cells
        .iter()
        .map(|cell| cell.bbox)
        .reduce(BBox::union)
        .unwrap_or_default();
    (0..rows)
        .map(|row| {
            let mut values = cells
                .iter()
                .filter(|cell| cell.row == row && cell.row_span == 1)
                .map(|cell| cell.bbox.center_y())
                .collect::<Vec<_>>();
            median(&mut values)
                .unwrap_or(union.y + union.height * (row as f32 + 0.5) / rows.max(1) as f32)
        })
        .collect()
}

fn centers_to_boundaries(start: f32, end: f32, centers: &[f32]) -> Vec<f32> {
    let mut centers = centers.to_vec();
    for index in 1..centers.len() {
        centers[index] = centers[index].max(centers[index - 1] + 0.5);
    }
    let mut result = vec![start];
    result.extend(
        centers
            .windows(2)
            .map(|pair| ((pair[0] + pair[1]) * 0.5).clamp(start, end)),
    );
    result.push(end);
    result
}

fn overlapping_columns(bbox: BBox, boundaries: &[f32], threshold: f32) -> Vec<usize> {
    boundaries
        .windows(2)
        .enumerate()
        .filter_map(|(column, interval)| {
            let overlap = (bbox.right().min(interval[1]) - bbox.x.max(interval[0])).max(0.0);
            (overlap >= bbox.width.min(interval[1] - interval[0]).max(0.1) * threshold)
                .then_some(column)
        })
        .collect()
}

fn row_bbox(row: &[Sequence]) -> BBox {
    row.iter()
        .map(|sequence| sequence.bbox)
        .reduce(BBox::union)
        .unwrap_or_default()
}

fn median(values: &mut [f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    Some(values[values.len() / 2])
}

fn contains_with_padding(bbox: BBox, x: f32, y: f32, padding: f32) -> bool {
    x >= bbox.x - padding
        && x <= bbox.right() + padding
        && y >= bbox.y - padding
        && y <= bbox.bottom() + padding
}

fn intersection_fraction(inner: BBox, outer: BBox) -> f32 {
    let width = (inner.right().min(outer.right()) - inner.x.max(outer.x)).max(0.0);
    let height = (inner.bottom().min(outer.bottom()) - inner.y.max(outer.y)).max(0.0);
    width * height / inner.area().max(0.1)
}

fn vertical_overlap_fraction(a: BBox, b: BBox) -> f32 {
    let overlap = (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0.0);
    overlap / a.height.min(b.height).max(0.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Span;

    fn span(text: &str, x: f32, y: f32, width: f32) -> Span {
        Span {
            text: text.into(),
            bbox: BBox {
                x,
                y,
                width,
                height: 7.0,
            },
            font_size: 7.0,
            font_weight: 400,
            font_name: "Test".into(),
            rotation: 0.0,
        }
    }

    fn line(text: &str, spans: Vec<Span>) -> TextLine {
        let bbox = spans
            .iter()
            .map(|span| span.bbox)
            .reduce(BBox::union)
            .unwrap();
        TextLine {
            text: text.into(),
            bbox,
            font_size: 7.0,
            font_weight: 400,
            spans,
        }
    }

    fn cell(row: usize, column: usize, bbox: BBox) -> TableCell {
        TableCell {
            row,
            column,
            row_span: 1,
            column_span: 1,
            text: String::new(),
            bbox,
        }
    }

    #[test]
    fn inserts_unassigned_header_but_not_caption() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 36.0,
        };
        let mut block = Block::Table {
            bbox: table,
            rows: 2,
            columns: 2,
            cells: vec![
                cell(
                    0,
                    0,
                    BBox {
                        x: 0.0,
                        y: 14.0,
                        width: 50.0,
                        height: 10.0,
                    },
                ),
                cell(
                    0,
                    1,
                    BBox {
                        x: 50.0,
                        y: 14.0,
                        width: 50.0,
                        height: 10.0,
                    },
                ),
                cell(
                    1,
                    0,
                    BBox {
                        x: 0.0,
                        y: 24.0,
                        width: 50.0,
                        height: 10.0,
                    },
                ),
                cell(
                    1,
                    1,
                    BBox {
                        x: 50.0,
                        y: 24.0,
                        width: 50.0,
                        height: 10.0,
                    },
                ),
            ],
            ruled: true,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        };
        let lines = vec![
            line(
                "Table 6. Example",
                vec![span("Table 6. Example", 5.0, 0.0, 70.0)],
            ),
            line(
                "Left Right",
                vec![span("Left", 5.0, 7.0, 15.0), span("Right", 60.0, 7.0, 18.0)],
            ),
            line(
                "A 1",
                vec![span("A", 5.0, 15.0, 6.0), span("1", 60.0, 15.0, 5.0)],
            ),
            line(
                "B 2",
                vec![span("B", 5.0, 25.0, 6.0), span("2", 60.0, 25.0, 5.0)],
            ),
        ];
        normalize_table(&mut block, &lines, &[], &TablePartitionConfig::default());
        let Block::Table { rows, cells, .. } = block else {
            unreachable!()
        };
        assert_eq!(rows, 3);
        assert!(cells
            .iter()
            .any(|cell| cell.row == 0 && cell.text.contains("Left")));
        assert!(cells.iter().all(|cell| !cell.text.contains("Table 6")));
    }

    #[test]
    fn makes_ordinary_cell_boxes_monotonic_and_exclusive() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 20.0,
        };
        let mut block = Block::Table {
            bbox: table,
            rows: 1,
            columns: 2,
            cells: vec![
                cell(
                    0,
                    0,
                    BBox {
                        x: 0.0,
                        y: 0.0,
                        width: 70.0,
                        height: 20.0,
                    },
                ),
                cell(
                    0,
                    1,
                    BBox {
                        x: 30.0,
                        y: 0.0,
                        width: 70.0,
                        height: 20.0,
                    },
                ),
            ],
            ruled: true,
            semantic_table_id: Some("tagged".into()),
            semantic_confidence: Some(0.95),
            continues_from_previous_page: false,
            continues_on_next_page: false,
        };
        let lines = vec![line(
            "Alpha Beta",
            vec![span("Alpha", 5.0, 6.0, 20.0), span("Beta", 75.0, 6.0, 18.0)],
        )];
        normalize_table(&mut block, &lines, &[], &TablePartitionConfig::default());
        let Block::Table { cells, .. } = block else {
            unreachable!()
        };
        assert!(cells[0].bbox.right() <= cells[1].bbox.x);
        assert_eq!(cells[0].text, "Alpha");
        assert_eq!(cells[1].text, "Beta");
    }

    #[test]
    fn preserves_explicit_spanning_cell() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 20.0,
        };
        let mut spanning = cell(0, 0, table);
        spanning.column_span = 2;
        let mut block = Block::Table {
            bbox: table,
            rows: 1,
            columns: 2,
            cells: vec![spanning],
            ruled: false,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        };
        normalize_table(
            &mut block,
            &[line(
                "Wide heading",
                vec![span("Wide heading", 20.0, 6.0, 60.0)],
            )],
            &[],
            &TablePartitionConfig::default(),
        );
        let Block::Table { cells, .. } = block else {
            unreachable!()
        };
        assert_eq!(cells[0].column_span, 2);
        assert_eq!(cells[0].bbox, table);
    }

    #[test]
    fn snaps_supported_partition_to_full_width_rule() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 40.0,
        };
        let mut boundaries = vec![0.0, 18.0, 40.0];
        snap_internal_boundaries_to_rules(
            &mut boundaries,
            table,
            &[Rule {
                x1: 0.0,
                y1: 20.0,
                x2: 100.0,
                y2: 20.0,
                width: 0.5,
            }],
            true,
            0.70,
            0.55,
        );
        assert_eq!(boundaries, vec![0.0, 20.0, 40.0]);
    }

    #[test]
    fn visible_separator_vetoes_an_orphan_colspan() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 20.0,
        };
        let sequence = Sequence {
            text: "crossing".into(),
            bbox: BBox {
                x: 35.0,
                y: 5.0,
                width: 30.0,
                height: 8.0,
            },
        };
        let cells = orphan_row_cells(
            &[sequence],
            0,
            &[0.0, 50.0, 100.0],
            table,
            &[Rule {
                x1: 50.0,
                y1: 0.0,
                x2: 50.0,
                y2: 20.0,
                width: 0.5,
            }],
            true,
        );
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].column_span, 1);
    }

    #[test]
    fn infers_header_rowspan_from_original_box_and_local_rule_gap() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 30.0,
        };
        let mut cells = vec![
            cell(
                0,
                0,
                BBox {
                    x: 0.0,
                    y: 0.0,
                    width: 40.0,
                    height: 16.0,
                },
            ),
            cell(
                0,
                1,
                BBox {
                    x: 40.0,
                    y: 0.0,
                    width: 60.0,
                    height: 10.0,
                },
            ),
            cell(
                1,
                1,
                BBox {
                    x: 40.0,
                    y: 10.0,
                    width: 60.0,
                    height: 10.0,
                },
            ),
            cell(
                2,
                0,
                BBox {
                    x: 0.0,
                    y: 20.0,
                    width: 40.0,
                    height: 10.0,
                },
            ),
            cell(
                2,
                1,
                BBox {
                    x: 40.0,
                    y: 20.0,
                    width: 60.0,
                    height: 10.0,
                },
            ),
        ];
        infer_spans_from_original_geometry(
            table,
            3,
            2,
            &mut cells,
            &[Rule {
                x1: 40.0,
                y1: 10.0,
                x2: 100.0,
                y2: 10.0,
                width: 0.5,
            }],
            &TablePartitionConfig::default(),
        );
        assert_eq!(cells[0].row_span, 2);
        assert_eq!(cells[1].row_span, 1);
    }

    #[test]
    fn propagates_repeated_rowspan_template_to_an_empty_parallel_track() {
        let table = BBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 40.0,
        };
        let mut left = cell(
            1,
            0,
            BBox {
                x: 0.0,
                y: 10.0,
                width: 50.0,
                height: 10.0,
            },
        );
        let mut right = cell(
            1,
            1,
            BBox {
                x: 50.0,
                y: 10.0,
                width: 50.0,
                height: 30.0,
            },
        );
        right.row_span = 3;
        let mut cells = vec![left.clone(), right];
        infer_spans_from_original_geometry(
            table,
            4,
            2,
            &mut cells,
            &[],
            &TablePartitionConfig::default(),
        );
        left.row_span = 3;
        assert_eq!(cells[0], left);
    }
}
