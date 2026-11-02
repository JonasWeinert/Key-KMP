use std::collections::HashSet;

use crate::model::{BBox, Block, Page, SemanticRegion, Span};

pub(crate) fn recognize_display_equations(pages: &mut [Page]) {
    for page in pages {
        let mut anchors: Vec<usize> = page
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| display_anchor(block, &page.blocks, page.width))
            .map(|(index, _)| index)
            .collect();
        for (label_index, label_block) in page.blocks.iter().enumerate() {
            if equation_label(&label_block.text()).is_none() {
                continue;
            }
            if let Some((index, _)) = page
                .blocks
                .iter()
                .enumerate()
                .filter(|(index, block)| {
                    *index != label_index && block.bbox().right() <= label_block.bbox().x
                })
                .filter(|(_, block)| {
                    (block.bbox().center_y() - label_block.bbox().center_y()).abs() <= 8.0
                })
                .filter(|(_, block)| looks_formula_fragment(block))
                .min_by(|(_, a), (_, b)| {
                    (label_block.bbox().x - a.bbox().right())
                        .total_cmp(&(label_block.bbox().x - b.bbox().right()))
                })
            {
                anchors.push(index);
            }
        }
        anchors.sort_unstable();
        anchors.dedup();
        anchors.sort_by(|a, b| {
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
        if !anchors.is_empty() {
            let mut groups: Vec<Vec<usize>> = Vec::new();
            for anchor in anchors {
                if let Some(group) = groups.last_mut().filter(|group| {
                    equation_rows_continue(
                        page.blocks[*group.last().unwrap()].bbox(),
                        page.blocks[anchor].bbox(),
                    )
                }) {
                    group.push(anchor);
                } else {
                    groups.push(vec![anchor]);
                }
            }
            let mut consumed = HashSet::new();
            let mut replacements = Vec::new();
            for mut group in groups {
                let mut core = group
                    .iter()
                    .map(|index| page.blocks[*index].bbox())
                    .reduce(BBox::union)
                    .unwrap();
                for (index, block) in page.blocks.iter().enumerate() {
                    if group.contains(&index) {
                        continue;
                    }
                    if equation_continuation(block, core) {
                        group.push(index);
                        core = core.union(block.bbox());
                    }
                }
                if group
                    .iter()
                    .any(|index| block_has_large_operator(&page.blocks[*index]))
                {
                    let satellites = page
                        .blocks
                        .iter()
                        .enumerate()
                        .filter(|(index, block)| {
                            if group.contains(index)
                                || consumed.contains(index)
                                || !fragment_glyph_like(block)
                            {
                                return false;
                            }
                            let bbox = block.bbox();
                            let above_gap = core.y - bbox.bottom();
                            bbox.height <= 14.0
                                && bbox.width <= core.width * 0.55
                                && bbox.center_x() >= core.x - 3.0
                                && bbox.center_x() <= core.right() + 3.0
                                && above_gap >= -1.0
                                && above_gap <= 18.0
                        })
                        .map(|(index, _)| index)
                        .collect::<Vec<_>>();
                    for index in satellites {
                        group.push(index);
                        core = core.union(page.blocks[index].bbox());
                    }
                }
                let row_label = page
                    .blocks
                    .iter()
                    .find(|block| {
                        equation_label(&block.text()).is_some()
                            && (block.bbox().center_y() - core.center_y()).abs() <= 9.0
                            && block.bbox().x > core.center_x()
                    })
                    .map(Block::bbox);
                for (index, block) in page.blocks.iter().enumerate() {
                    if group.contains(&index)
                        || !matches!(block, Block::Paragraph { .. } | Block::Heading { .. })
                    {
                        continue;
                    }
                    let bbox = block.bbox();
                    let satellite = bbox.width <= 24.0
                        && bbox.height <= core.height.max(12.0)
                        && bbox.center_y() >= core.y - 4.0
                        && bbox.center_y() <= core.bottom() + 4.0
                        && bbox.x >= core.x - 8.0
                        && bbox.right() <= core.right() + 12.0;
                    let number = equation_label(&block.text()).is_some()
                        && (bbox.center_y() - core.center_y()).abs() <= 8.0
                        && bbox.x > core.right()
                        && bbox.right() <= page.width * 0.96;
                    let numbered_fragment = row_label.is_some_and(|label| {
                        matches!(block, Block::Paragraph { .. } | Block::Heading { .. })
                            && (bbox.center_y() - core.center_y()).abs() <= 10.0
                            && bbox.right() < label.x + 2.0
                            && bbox.x >= core.x.min(label.x - page.width * 0.58)
                            && (fragment_glyph_like(block) || looks_formula_fragment(block))
                    });
                    if satellite || number || numbered_fragment {
                        group.push(index);
                    }
                }
                group.sort_unstable();
                group.dedup();
                let insert_at = *group.iter().min().unwrap();
                let mut ordered = group.clone();
                ordered.sort_by(|a, b| {
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
                let label = ordered
                    .iter()
                    .find_map(|index| equation_label(&page.blocks[*index].text()));
                let text = ordered
                    .iter()
                    .filter_map(|index| {
                        let value = page.blocks[*index].text();
                        equation_label(&value).is_none().then_some(value)
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let lines: Vec<crate::model::TextLine> = ordered
                    .iter()
                    .flat_map(|index| match &page.blocks[*index] {
                        Block::Paragraph { lines, .. } | Block::Heading { lines, .. } => {
                            lines.clone()
                        }
                        _ => vec![],
                    })
                    .collect();
                let bbox = ordered
                    .iter()
                    .map(|index| page.blocks[*index].bbox())
                    .reduce(BBox::union)
                    .unwrap();
                let latex = reconstruct_formula(&lines, &page.rules, bbox);
                consumed.extend(group);
                replacements.push((
                    insert_at,
                    Block::Equation {
                        bbox,
                        latex,
                        text,
                        label,
                        lines,
                    },
                ));
            }
            let mut rebuilt = Vec::new();
            for (index, block) in std::mem::take(&mut page.blocks).into_iter().enumerate() {
                if let Some((_, equation)) = replacements.iter().find(|(at, _)| *at == index) {
                    rebuilt.push(equation.clone());
                }
                if !consumed.contains(&index) {
                    rebuilt.push(block);
                }
            }
            page.blocks = rebuilt;
        }
        recognize_inline_equations(page);
    }
}

fn fragment_glyph_like(block: &Block) -> bool {
    let Block::Paragraph { text, lines, .. } = block else {
        return false;
    };
    let spans = lines
        .iter()
        .flat_map(|line| &line.spans)
        .collect::<Vec<_>>();
    let math = spans
        .iter()
        .filter(|span| is_math_font(&span.font_name))
        .count();
    text.chars().count() <= 5 || math * 2 >= spans.len().max(1)
}

fn block_has_large_operator(block: &Block) -> bool {
    let lines = match block {
        Block::Paragraph { lines, .. }
        | Block::Heading { lines, .. }
        | Block::Equation { lines, .. } => lines,
        _ => return false,
    };
    lines.iter().flat_map(|line| &line.spans).any(|span| {
        let font = span.font_name.to_ascii_lowercase();
        font.contains("cmex") || span.text.chars().any(|ch| matches!(ch, '∑' | '∏' | '∫'))
    })
}

fn looks_formula_fragment(block: &Block) -> bool {
    let (text, lines) = match block {
        Block::Paragraph { text, lines, .. } | Block::Heading { text, lines, .. } => (text, lines),
        _ => return false,
    };
    let operators = text.chars().filter(|ch| is_math_operator(*ch)).count();
    let math_fonts = lines
        .iter()
        .flat_map(|line| &line.spans)
        .filter(|span| is_math_font(&span.font_name))
        .count();
    let words = text
        .split_whitespace()
        .filter(|word| word.chars().filter(|ch| ch.is_alphabetic()).count() >= 3)
        .count();
    operators > 0 && (math_fonts > 0 || words <= 3)
}

fn recognize_inline_equations(page: &mut Page) {
    let mut regions = Vec::new();
    for (block_index, block) in page.blocks.iter().enumerate() {
        let Block::Paragraph { lines, .. } = block else {
            continue;
        };
        for line in lines {
            if line
                .text
                .split_whitespace()
                .filter(|word| word.chars().any(char::is_alphabetic))
                .count()
                < 5
            {
                continue;
            }
            let mut group = Vec::<&Span>::new();
            let flush = |group: &mut Vec<&Span>, regions: &mut Vec<SemanticRegion>| {
                if inline_group(group) {
                    let bbox = group
                        .iter()
                        .map(|span| span.bbox)
                        .reduce(BBox::union)
                        .unwrap();
                    let text = group
                        .iter()
                        .map(|span| span.text.as_str())
                        .collect::<String>();
                    regions.push(SemanticRegion {
                        id: format!("inline-equation:{}:{}", page.number, regions.len() + 1),
                        role: "InlineEquation".into(),
                        bbox,
                        confidence: 0.78,
                        source: "geometry:glyph-pattern".into(),
                        alt_text: None,
                        label: Some(text),
                        caption: None,
                        target_id: Some(format!("block:{block_index}")),
                        external_url: None,
                    });
                }
                group.clear();
            };
            for span in &line.spans {
                let signal = is_math_font(&span.font_name)
                    || span.text.chars().any(is_math_operator)
                    || span
                        .text
                        .chars()
                        .any(|ch| matches!(ch, 'α'..='ω' | 'Α'..='Ω'));
                let adjacent = group
                    .last()
                    .is_none_or(|previous| span.bbox.x - previous.bbox.right() <= 4.0);
                if signal && adjacent {
                    group.push(span);
                } else {
                    flush(&mut group, &mut regions);
                    if signal {
                        group.push(span);
                    }
                }
            }
            flush(&mut group, &mut regions);
        }
    }
    page.semantic_regions.extend(regions);
}

fn inline_group(group: &[&Span]) -> bool {
    if group.is_empty() {
        return false;
    }
    let math_fonts = group
        .iter()
        .filter(|span| is_math_font(&span.font_name))
        .count();
    let operators = group
        .iter()
        .flat_map(|span| span.text.chars())
        .filter(|ch| is_math_operator(*ch))
        .count();
    let special = group
        .iter()
        .flat_map(|span| span.text.chars())
        .any(|ch| matches!(ch, 'α'..='ω' | 'Α'..='Ω' | '∈' | '∑' | '∫' | '√' | '∞'));
    math_fonts > 0 && (operators > 0 || special)
}

fn display_anchor(block: &Block, blocks: &[Block], page_width: f32) -> bool {
    let Block::Paragraph { bbox, text, lines } = block else {
        return false;
    };
    if lines
        .iter()
        .flat_map(|line| &line.spans)
        .map(|span| span.font_size)
        .max_by(f32::total_cmp)
        .unwrap_or(0.0)
        < 8.0
    {
        return false;
    }
    if text.chars().count() > 180 || text.contains("http") || text.contains('@') {
        return false;
    }
    let lower = text.to_lowercase();
    if ["where ", "and ", "or ", "in this ", "figure ", "table "]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return false;
    }
    let operators = text.chars().filter(|ch| is_math_operator(*ch)).count();
    if operators == 0 {
        return false;
    }
    let math_fonts = lines
        .iter()
        .flat_map(|line| &line.spans)
        .filter(|span| is_math_font(&span.font_name))
        .count();
    let spans = lines.iter().map(|line| line.spans.len()).sum::<usize>();
    let prose_words = text
        .split_whitespace()
        .filter(|word| {
            let clean = word.trim_matches(|ch: char| !ch.is_alphabetic());
            clean.chars().count() >= 3 && clean.chars().all(char::is_alphabetic)
        })
        .count();
    if prose_words > 5 {
        return false;
    }
    let centered = local_column(block, blocks, page_width)
        .is_some_and(|column| (bbox.center_x() - column.center_x()).abs() <= column.width * 0.24);
    let baseline_prose = blocks.iter().any(|other| {
        !std::ptr::eq(other, block)
            && matches!(other, Block::Paragraph { .. })
            && (other.bbox().center_y() - bbox.center_y()).abs()
                <= bbox.height.max(other.bbox().height) * 0.55
            && other.bbox().right() <= bbox.x + 4.0
            && other
                .text()
                .split_whitespace()
                .filter(|word| word.chars().count() >= 3)
                .count()
                >= 3
    });
    if baseline_prose {
        return false;
    }
    let mut score = 0;
    if text.contains('=') || operators >= 2 {
        score += 2;
    }
    if math_fonts * 3 >= spans.max(1) {
        score += 2;
    }
    if centered {
        score += 1;
    }
    if prose_words <= 3 {
        score += 1;
    }
    if text.contains(['∈', '∑', '∫', '√', '∞', '≤', '≥']) {
        score += 1;
    }
    score >= 4
}

fn equation_continuation(block: &Block, core: BBox) -> bool {
    let Block::Paragraph { bbox, text, lines } = block else {
        return false;
    };
    let gap = bbox.y - core.bottom();
    if gap < -3.0 || gap > 18.0 || (bbox.center_x() - core.center_x()).abs() > 75.0 {
        return false;
    }
    if text.trim_start().to_ascii_lowercase().starts_with("where ") && text.contains('=') {
        return true;
    }
    let spans = lines
        .iter()
        .flat_map(|line| &line.spans)
        .collect::<Vec<_>>();
    let math_fonts = spans
        .iter()
        .filter(|span| is_math_font(&span.font_name))
        .count();
    (text.contains('=') || text.chars().filter(|ch| is_math_operator(*ch)).count() >= 2)
        && math_fonts * 4 >= spans.len().max(1)
        && text.chars().count() <= 160
}

fn local_column(block: &Block, blocks: &[Block], page_width: f32) -> Option<BBox> {
    let bbox = block.bbox();
    blocks
        .iter()
        .filter(|other| matches!(other, Block::Paragraph { .. }))
        .filter(|other| {
            let other_bbox = other.bbox();
            (other_bbox.center_y() - bbox.center_y()).abs() <= 140.0
                && other_bbox.width >= page_width * 0.25
                && horizontal_overlap(other_bbox, bbox) > 0.0
                && other.text().split_whitespace().count() >= 8
        })
        .min_by(|a, b| {
            (a.bbox().center_y() - bbox.center_y())
                .abs()
                .total_cmp(&(b.bbox().center_y() - bbox.center_y()).abs())
        })
        .map(Block::bbox)
}

fn equation_rows_continue(upper: BBox, lower: BBox) -> bool {
    let gap = lower.y - upper.bottom();
    gap >= -upper.height.max(lower.height)
        && gap <= 16.0
        && (upper.center_x() - lower.center_x()).abs() <= 90.0
}
fn equation_label(text: &str) -> Option<String> {
    let value = text.trim();
    let core = value.strip_prefix('(')?.strip_suffix(')')?;
    (!core.is_empty()
        && core.len() <= 8
        && core
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '.' || ch.is_ascii_lowercase()))
    .then(|| value.to_owned())
}
fn horizontal_overlap(a: BBox, b: BBox) -> f32 {
    (a.right().min(b.right()) - a.x.max(b.x)).max(0.0)
}
fn is_math_operator(ch: char) -> bool {
    matches!(
        ch,
        '=' | '+'
            | '−'
            | '×'
            | '÷'
            | '∑'
            | '∏'
            | '∫'
            | '√'
            | '∞'
            | '≤'
            | '≥'
            | '≈'
            | '∈'
            | '∉'
            | '⊂'
            | '⊆'
            | '∂'
            | '∇'
            | '±'
    )
}
fn is_math_font(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "cmmi", "cmsy", "msbm", "math", "symbol", "mtmi", "rmtmi", "advpssym", "euclid",
    ]
    .iter()
    .any(|part| name.contains(part))
}

/// Reconstruct the most common TeX formula relationships from positioned PDF
/// runs. PDF text order is deliberately ignored: large runs establish local
/// baselines and smaller runs are attached as superscripts/subscripts by their
/// geometry. The raw extraction remains alongside this best-effort form.
fn reconstruct_formula(
    lines: &[crate::model::TextLine],
    rules: &[crate::model::Rule],
    bbox: BBox,
) -> Option<String> {
    let spans = lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .filter(|span| !span.text.trim().is_empty() && equation_label(&span.text).is_none())
        .cloned()
        .collect::<Vec<_>>();
    if spans.is_empty() {
        return None;
    }
    let spans = collapse_structural_constructs(spans, rules, bbox);
    let max_size = spans
        .iter()
        .map(|span| span.font_size)
        .max_by(f32::total_cmp)
        .unwrap_or(0.0);
    let base_cutoff = max_size * 0.82;
    let mut bases = spans
        .iter()
        .enumerate()
        .filter(|(_, span)| span.font_size >= base_cutoff)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    bases.sort_by(|a, b| {
        spans[*a]
            .bbox
            .center_y()
            .total_cmp(&spans[*b].bbox.center_y())
            .then(spans[*a].bbox.x.total_cmp(&spans[*b].bbox.x))
    });
    if bases.is_empty() {
        return None;
    }

    let mut rows: Vec<Vec<usize>> = Vec::new();
    for index in bases {
        if let Some(row) = rows.last_mut().filter(|row| {
            let center =
                row.iter().map(|i| spans[*i].bbox.center_y()).sum::<f32>() / row.len() as f32;
            (spans[index].bbox.center_y() - center).abs() <= max_size * 0.48
        }) {
            row.push(index);
        } else {
            rows.push(vec![index]);
        }
    }
    for row in &mut rows {
        row.sort_by(|a, b| spans[*a].bbox.x.total_cmp(&spans[*b].bbox.x));
    }

    let base_set = rows.iter().flatten().copied().collect::<HashSet<_>>();
    let mut supers = vec![Vec::<usize>::new(); spans.len()];
    let mut subs = vec![Vec::<usize>::new(); spans.len()];
    for script_index in 0..spans.len() {
        if base_set.contains(&script_index) {
            continue;
        }
        let script = &spans[script_index];
        let candidate = rows
            .iter()
            .flatten()
            .copied()
            .filter(|base_index| {
                let base = &spans[*base_index];
                (script.bbox.center_y() - base.bbox.center_y()).abs() <= max_size * 1.8
                    && script.bbox.x >= base.bbox.x - 2.0
                    && script.bbox.x <= base.bbox.right() + max_size * 1.5
            })
            .min_by(|a, b| {
                script_distance(script, &spans[*a]).total_cmp(&script_distance(script, &spans[*b]))
            });
        let Some(base_index) = candidate else {
            continue;
        };
        if script.bbox.center_y() < spans[base_index].bbox.center_y() - max_size * 0.08 {
            supers[base_index].push(script_index);
        } else {
            subs[base_index].push(script_index);
        }
    }

    let mut rendered_rows = Vec::new();
    for row in rows {
        let mut rendered = String::new();
        let mut previous_right = None;
        for index in row {
            let span = &spans[index];
            if previous_right.is_some_and(|right| span.bbox.x - right > max_size * 0.55) {
                rendered.push(' ');
            }
            rendered.push_str(&map_pdf_math_glyph(&span.text, &span.font_name));
            append_script(&mut rendered, '^', &supers[index], &spans);
            append_script(&mut rendered, '_', &subs[index], &spans);
            previous_right = Some(span.bbox.right());
        }
        let rendered = rendered.trim().to_owned();
        if !rendered.is_empty() {
            rendered_rows.push(rendered);
        }
    }
    (!rendered_rows.is_empty()).then(|| rendered_rows.join(" \\\\ "))
}

fn collapse_structural_constructs(
    mut spans: Vec<Span>,
    rules: &[crate::model::Rule],
    bbox: BBox,
) -> Vec<Span> {
    // Short horizontal rules surrounded by text above and below are fraction
    // bars. Long page/table rules are excluded by the equation-local bounds.
    let mut bars = rules
        .iter()
        .filter(|rule| rule.horizontal())
        .filter_map(|rule| {
            let left = rule.x1.min(rule.x2);
            let right = rule.x1.max(rule.x2);
            let y = (rule.y1 + rule.y2) * 0.5;
            let width = right - left;
            (left >= bbox.x - 2.0
                && right <= bbox.right() + 2.0
                && y >= bbox.y - 2.0
                && y <= bbox.bottom() + 2.0
                && width >= 5.0
                && width <= bbox.width * 0.72)
                .then_some((left, right, y, width))
        })
        .collect::<Vec<_>>();
    bars.sort_by(|a, b| a.3.total_cmp(&b.3));
    for (left, right, y, width) in bars {
        let numerator = spans
            .iter()
            .enumerate()
            .filter(|(_, span)| {
                span.bbox.center_x() >= left - 2.0
                    && span.bbox.center_x() <= right + 2.0
                    && span.bbox.bottom() <= y + 2.0
                    && y - span.bbox.bottom() <= 28.0
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let denominator = spans
            .iter()
            .enumerate()
            .filter(|(_, span)| {
                span.bbox.center_x() >= left - 2.0
                    && span.bbox.center_x() <= right + 2.0
                    && span.bbox.y >= y - 2.0
                    && span.bbox.y - y <= 28.0
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if numerator.is_empty() || denominator.is_empty() {
            continue;
        }
        let used = numerator
            .iter()
            .chain(&denominator)
            .copied()
            .collect::<HashSet<_>>();
        let numerator_spans = numerator
            .iter()
            .map(|index| spans[*index].clone())
            .collect::<Vec<_>>();
        let denominator_spans = denominator
            .iter()
            .map(|index| spans[*index].clone())
            .collect::<Vec<_>>();
        let numerator_text = render_subexpression(&numerator_spans);
        let denominator_text = render_subexpression(&denominator_spans);
        if numerator_text.is_empty() || denominator_text.is_empty() {
            continue;
        }
        let atom_bbox = used
            .iter()
            .map(|index| spans[*index].bbox)
            .reduce(BBox::union)
            .unwrap()
            .union(BBox {
                x: left,
                y: y - 0.5,
                width,
                height: 1.0,
            });
        let font_size = used
            .iter()
            .map(|index| spans[*index].font_size)
            .max_by(f32::total_cmp)
            .unwrap_or(10.0);
        spans = spans
            .into_iter()
            .enumerate()
            .filter_map(|(index, span)| (!used.contains(&index)).then_some(span))
            .collect();
        spans.push(synthetic_span(
            format!("\\frac{{{numerator_text}}}{{{denominator_text}}}"),
            atom_bbox,
            font_size,
        ));
    }

    // A radical glyph plus a matching overbar defines the radicand extent.
    let radical_indices = spans
        .iter()
        .enumerate()
        .filter(|(_, span)| {
            span.text.contains('√')
                || span.font_name.to_ascii_lowercase().contains("cmex") && span.text == "p"
                || span.font_name.to_ascii_lowercase().contains("symbol")
                    && span.text.chars().count() == 1
                || matches!(span.text.trim(), "■" | "□" | "�")
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    for radical_index in radical_indices.into_iter().rev() {
        if radical_index >= spans.len() {
            continue;
        }
        let radical = spans[radical_index].clone();
        let bar = rules
            .iter()
            .filter(|rule| rule.horizontal())
            .filter_map(|rule| {
                let left = rule.x1.min(rule.x2);
                let right = rule.x1.max(rule.x2);
                let y = (rule.y1 + rule.y2) * 0.5;
                (left >= radical.bbox.center_x()
                    && left <= radical.bbox.right() + 5.0
                    && y >= radical.bbox.y - 4.0
                    && y <= radical.bbox.center_y() + 2.0
                    && right > radical.bbox.right() + 3.0)
                    .then_some((left, right, y))
            })
            .min_by(|a, b| {
                (a.0 - radical.bbox.right())
                    .abs()
                    .total_cmp(&(b.0 - radical.bbox.right()).abs())
            });
        let Some((left, right, _)) = bar else {
            continue;
        };
        let radicand = spans
            .iter()
            .enumerate()
            .filter(|(index, span)| {
                *index != radical_index
                    && span.bbox.center_x() >= left - 2.0
                    && span.bbox.center_x() <= right + 2.0
                    && span.bbox.center_y() >= radical.bbox.y - 3.0
                    && span.bbox.center_y() <= radical.bbox.bottom() + 6.0
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if radicand.is_empty() {
            continue;
        }
        let value = render_subexpression(
            &radicand
                .iter()
                .map(|index| spans[*index].clone())
                .collect::<Vec<_>>(),
        );
        let used = std::iter::once(radical_index)
            .chain(radicand)
            .collect::<HashSet<_>>();
        let atom_bbox = used
            .iter()
            .map(|index| spans[*index].bbox)
            .reduce(BBox::union)
            .unwrap();
        let font_size = used
            .iter()
            .map(|index| spans[*index].font_size)
            .max_by(f32::total_cmp)
            .unwrap_or(10.0);
        spans = spans
            .into_iter()
            .enumerate()
            .filter_map(|(index, span)| (!used.contains(&index)).then_some(span))
            .collect();
        spans.push(synthetic_span(
            format!("\\sqrt{{{value}}}"),
            atom_bbox,
            font_size,
        ));
    }

    collapse_matrix(spans)
}

fn collapse_matrix(mut spans: Vec<Span>) -> Vec<Span> {
    let mut pairs = Vec::new();
    for (left_index, left) in spans.iter().enumerate() {
        let opening = left.text.trim();
        if !matches!(opening, "[" | "(" | "{") {
            continue;
        }
        if opening == "(" && left.font_name.to_ascii_lowercase().contains("cmex") {
            pairs.push((left_index, None));
            continue;
        }
        if let Some((right_index, _right)) = spans
            .iter()
            .enumerate()
            .filter(|(index, right)| {
                *index != left_index
                    && matches!(
                        (opening, right.text.trim()),
                        ("[", "]") | ("(", ")") | ("{", "}")
                    )
                    && right.bbox.x > left.bbox.x
                    && (right.bbox.center_y() - left.bbox.center_y()).abs()
                        <= left.bbox.height.max(right.bbox.height) * 1.5
            })
            .min_by(|(_, a), (_, b)| a.bbox.x.total_cmp(&b.bbox.x))
        {
            pairs.push((left_index, Some(right_index)));
        } else if opening == "{"
            || (opening == "(" && left.font_name.to_ascii_lowercase().contains("cmex"))
        {
            pairs.push((left_index, None));
        }
    }
    for (left_index, right_index) in pairs.into_iter().rev() {
        if left_index >= spans.len() || right_index.is_some_and(|index| index >= spans.len()) {
            continue;
        }
        let left = spans[left_index].clone();
        let right_x = right_index.map_or_else(
            || {
                spans
                    .iter()
                    .filter(|span| {
                        span.bbox.x > left.bbox.x
                            && span.bbox.center_y() >= left.bbox.y - 4.0
                            && span.bbox.center_y() <= left.bbox.bottom() + 4.0
                    })
                    .map(|span| span.bbox.right())
                    .max_by(f32::total_cmp)
                    .unwrap_or(left.bbox.right())
            },
            |index| spans[index].bbox.x,
        );
        let inside = spans
            .iter()
            .enumerate()
            .filter(|(index, span)| {
                *index != left_index
                    && Some(*index) != right_index
                    && span.bbox.center_x() > left.bbox.right() - 1.0
                    && span.bbox.center_x() < right_x + 1.0
                    && span.bbox.center_y() >= left.bbox.y - 4.0
                    && span.bbox.center_y() <= left.bbox.bottom() + 4.0
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if inside.len() < 4 {
            continue;
        }
        let mut rows = cluster_span_rows(
            &inside
                .iter()
                .map(|index| spans[*index].clone())
                .collect::<Vec<_>>(),
        );
        if rows.len() < 2 {
            continue;
        }
        let max_size = inside
            .iter()
            .map(|index| spans[*index].font_size)
            .max_by(f32::total_cmp)
            .unwrap_or(10.0);
        let mut rendered_rows = Vec::new();
        let mut orphan_prefixes = Vec::new();
        for row in &mut rows {
            row.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
            let equals_x = row
                .iter()
                .find(|span| span.text.contains('='))
                .map(|span| span.bbox.x);
            let orphan_prefix = equals_x
                .map(|x| {
                    row.iter()
                        .filter(|span| span.bbox.right() <= x && span.font_size < max_size * 0.82)
                        .map(|span| span.text.as_str())
                        .collect::<String>()
                })
                .unwrap_or_default();
            let mut cells = Vec::new();
            let mut cell = Vec::new();
            let mut previous_right = None;
            for span in row.drain(..) {
                if previous_right.is_some_and(|right| span.bbox.x - right > max_size * 1.2)
                    && !cell.is_empty()
                {
                    cells.push(render_subexpression(&cell));
                    cell.clear();
                }
                previous_right = Some(span.bbox.right());
                cell.push(span);
            }
            if !cell.is_empty() {
                cells.push(render_subexpression(&cell));
            }
            rendered_rows.push(cells.join(" & "));
            orphan_prefixes.push(orphan_prefix);
        }
        if environment_for_fence(&left, right_index)
            .is_some_and(|environment| environment == "cases")
        {
            let template = rendered_rows.iter().find_map(|row| {
                let lhs = row.split_once('=')?.0.trim();
                (!lhs.is_empty()).then(|| strip_final_subscript(lhs).to_owned())
            });
            if let Some(template) = template {
                for (row, orphan) in rendered_rows.iter_mut().zip(orphan_prefixes) {
                    if row.trim_start().starts_with('=') && !orphan.is_empty() {
                        *row = format!("{template}_{{{orphan}}}{row}");
                    }
                }
            }
        }
        let environment = environment_for_fence(&left, right_index).unwrap_or("pmatrix");
        let value = format!(
            "\\begin{{{environment}}} {} \\end{{{environment}}}",
            rendered_rows.join(" \\\\ ")
        );
        let used = std::iter::once(left_index)
            .chain(right_index)
            .chain(inside)
            .collect::<HashSet<_>>();
        let atom_bbox = used
            .iter()
            .map(|index| spans[*index].bbox)
            .reduce(BBox::union)
            .unwrap();
        spans = spans
            .into_iter()
            .enumerate()
            .filter_map(|(index, span)| (!used.contains(&index)).then_some(span))
            .collect();
        spans.push(synthetic_span(value, atom_bbox, max_size));
    }
    spans
}

fn environment_for_fence(left: &Span, right_index: Option<usize>) -> Option<&'static str> {
    Some(if left.text.trim() == "{" || right_index.is_none() {
        "cases"
    } else if left.text.trim() == "[" {
        "bmatrix"
    } else {
        "pmatrix"
    })
}

fn strip_final_subscript(value: &str) -> &str {
    let trimmed = value.trim();
    let Some(start) = trimmed.rfind("_{") else {
        return trimmed;
    };
    if trimmed.ends_with('}') {
        trimmed[..start].trim_end()
    } else {
        trimmed
    }
}

fn render_subexpression(spans: &[Span]) -> String {
    let Some(bbox) = spans.iter().map(|span| span.bbox).reduce(BBox::union) else {
        return String::new();
    };
    let font_size = spans
        .iter()
        .map(|span| span.font_size)
        .max_by(f32::total_cmp)
        .unwrap_or(10.0);
    let text = spans
        .iter()
        .map(|span| span.text.as_str())
        .collect::<String>();
    let line = crate::model::TextLine {
        text,
        bbox,
        font_size,
        font_weight: 400,
        spans: spans.to_vec(),
    };
    reconstruct_formula(&[line], &[], bbox).unwrap_or_default()
}

fn cluster_span_rows(spans: &[Span]) -> Vec<Vec<Span>> {
    let max_size = spans
        .iter()
        .map(|span| span.font_size)
        .max_by(f32::total_cmp)
        .unwrap_or(10.0);
    let mut sorted = spans.to_vec();
    sorted.sort_by(|a, b| a.bbox.center_y().total_cmp(&b.bbox.center_y()));
    let mut rows: Vec<Vec<Span>> = Vec::new();
    for span in sorted {
        if let Some(row) = rows.last_mut().filter(|row| {
            let center =
                row.iter().map(|item| item.bbox.center_y()).sum::<f32>() / row.len() as f32;
            (span.bbox.center_y() - center).abs() <= max_size * 0.48
        }) {
            row.push(span);
        } else {
            rows.push(vec![span]);
        }
    }
    rows
}

fn synthetic_span(text: String, bbox: BBox, font_size: f32) -> Span {
    Span {
        text,
        bbox,
        font_size,
        font_weight: 400,
        font_name: "geometry-structure".into(),
        rotation: 0.0,
    }
}

fn script_distance(script: &Span, base: &Span) -> f32 {
    let horizontal = if script.bbox.x < base.bbox.x {
        base.bbox.x - script.bbox.x
    } else if script.bbox.x > base.bbox.right() {
        script.bbox.x - base.bbox.right()
    } else {
        0.0
    };
    horizontal * 2.0 + (script.bbox.center_y() - base.bbox.center_y()).abs()
}

fn append_script(output: &mut String, marker: char, indices: &[usize], spans: &[Span]) {
    if indices.is_empty() {
        return;
    }
    let mut indices = indices.to_vec();
    indices.sort_by(|a, b| spans[*a].bbox.x.total_cmp(&spans[*b].bbox.x));
    let mut value = render_script_run(&indices, spans);
    if marker == '^' && matches!(value.trim(), "," | "'" | "’" | "`") {
        value = "\\prime".into();
    }
    output.push(marker);
    output.push('{');
    output.push_str(value.trim());
    output.push('}');
}

fn render_script_run(indices: &[usize], spans: &[Span]) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < indices.len() {
        let current = &spans[indices[cursor]];
        output.push_str(&map_pdf_math_glyph(&current.text, &current.font_name));
        let mut nested = Vec::new();
        let mut next = cursor + 1;
        while next < indices.len() {
            let candidate = &spans[indices[next]];
            if candidate.font_size < current.font_size * 0.86
                && candidate.bbox.center_y() > current.bbox.center_y()
            {
                nested.push(indices[next]);
                next += 1;
            } else {
                break;
            }
        }
        if !nested.is_empty() {
            output.push_str("_{");
            output.push_str(&render_script_run(&nested, spans));
            output.push('}');
        }
        cursor = next;
    }
    output
}

fn map_pdf_math_glyph(text: &str, font_name: &str) -> String {
    let font = font_name.to_ascii_lowercase();
    if font.contains("cmex") && text == "X" {
        return "\\sum".into();
    }
    if font.contains("cmex") && text == "Y" {
        return "\\prod".into();
    }
    if font.contains("cmsy") && text == "0" {
        return "\\prime".into();
    }
    text.replace('−', "-")
        .replace('×', "\\times ")
        .replace('÷', "\\div ")
        .replace('∑', "\\sum ")
        .replace('∏', "\\prod ")
        .replace('∫', "\\int ")
        .replace('√', "\\sqrt{}")
        .replace('∞', "\\infty ")
        .replace('≤', "\\le ")
        .replace('≥', "\\ge ")
        .replace('≈', "\\approx ")
        .replace('∈', "\\in ")
        .replace('∂', "\\partial ")
        .replace('∇', "\\nabla ")
        .replace('α', "\\alpha ")
        .replace('β', "\\beta ")
        .replace('δ', "\\delta ")
        .replace('θ', "\\theta ")
        .replace('σ', "\\sigma ")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn span(text: &str, x: f32, y: f32, size: f32) -> Span {
        Span {
            text: text.into(),
            bbox: BBox {
                x,
                y,
                width: text.len() as f32 * size * 0.5,
                height: size,
            },
            font_size: size,
            font_weight: 400,
            font_name: "Times".into(),
            rotation: 0.0,
        }
    }
    #[test]
    fn parses_equation_numbers_but_not_citations() {
        assert_eq!(equation_label("(2)"), Some("(2)".into()));
        assert_eq!(equation_label("[2]"), None);
    }
    #[test]
    fn recognizes_common_math_fonts() {
        assert!(is_math_font("ABCDEE+CMMI10"));
        assert!(is_math_font("CambriaMath"));
    }
    #[test]
    fn maps_known_computer_modern_extension_glyphs() {
        assert_eq!(map_pdf_math_glyph("X", "CMEX10"), "\\sum");
        assert_eq!(map_pdf_math_glyph("0", "CMSY6"), "\\prime");
    }
    #[test]
    fn reconstructs_stacked_fraction_from_vector_bar() {
        let spans = vec![
            span("a", 20.0, 10.0, 8.0),
            span("b", 20.0, 25.0, 8.0),
            span("y=", 0.0, 18.0, 10.0),
        ];
        let bbox = spans
            .iter()
            .map(|span| span.bbox)
            .reduce(BBox::union)
            .unwrap();
        let line = crate::model::TextLine {
            text: "a b y=".into(),
            bbox,
            font_size: 10.0,
            font_weight: 400,
            spans,
        };
        let rule = crate::model::Rule {
            x1: 17.0,
            y1: 21.0,
            x2: 25.0,
            y2: 21.0,
            width: 0.5,
        };
        let result = reconstruct_formula(&[line], &[rule], bbox).unwrap();
        assert!(result.contains("\\frac{a}{b}"), "{result}");
    }
}
