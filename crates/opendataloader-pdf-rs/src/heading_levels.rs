use std::collections::{BTreeMap, HashMap};

use crate::model::{BBox, Block, Page};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum MarkerFamily {
    Arabic,
    UpperRoman,
    LowerRoman,
    UpperAlpha,
    LowerAlpha,
}

#[derive(Clone, Debug)]
struct OutlineMarker {
    family: MarkerFamily,
    ordinal: usize,
    /// Dotted markers carry their hierarchy explicitly: `2`, `2.3`, and
    /// `2.3.1` have depths one, two, and three. Atomic alphabetic and Roman
    /// markers need document-level reset/indentation evidence instead.
    explicit_depth: Option<usize>,
}

#[derive(Clone, Debug)]
struct HeadingObservation {
    page: usize,
    block: usize,
    position: usize,
    base_level: u8,
    font_size: f32,
    font_weight: u16,
    relative_indent_em: Option<f32>,
    centered: bool,
    marker: Option<OutlineMarker>,
}

/// Refines the typographic hierarchy with document-wide outline evidence.
///
/// Font size remains the baseline because it works for unnumbered documents.
/// Number depth, repeated Roman/letter resets, and repeated local indentation
/// patterns may split a single typographic style into multiple logical levels.
pub(crate) fn normalize_heading_levels(pages: &mut [Page]) {
    assign_typographic_levels(pages);
    let observations = collect_observations(pages);
    let mut levels: Vec<u8> = observations.iter().map(|item| item.base_level).collect();

    apply_explicit_outline_depths(&observations, &mut levels);
    apply_atomic_marker_consistency(&observations, &mut levels);
    apply_marker_reset_hierarchy(&observations, &mut levels);
    apply_repeated_indentation(&observations, &mut levels);

    for (observation, level) in observations.iter().zip(levels) {
        if let Block::Heading {
            level: output_level,
            ..
        } = &mut pages[observation.page].blocks[observation.block]
        {
            *output_level = level.clamp(1, 6);
        }
    }
}

/// Java detects heading style groups across the whole document, then walks
/// headings in reading order so levels never jump by more than one. Keeping
/// this document-level is essential when a subsection begins on a new page.
fn assign_typographic_levels(pages: &mut [Page]) {
    let mut sizes: Vec<f32> = pages
        .iter()
        .flat_map(|page| page.blocks.iter())
        .filter_map(|block| match block {
            Block::Heading { lines, .. } => lines.first().map(|line| line.font_size),
            _ => None,
        })
        .collect();
    sizes.sort_by(|a, b| b.total_cmp(a));
    let mut groups = Vec::<f32>::new();
    for size in sizes {
        if groups
            .iter()
            .all(|existing| (*existing - size).abs() > 0.75)
        {
            groups.push(size);
        }
    }

    let mut open_levels: Vec<(usize, u8)> = Vec::new();
    for page in pages {
        for block in &mut page.blocks {
            let Block::Heading { level, lines, .. } = block else {
                continue;
            };
            let size = lines.first().map(|line| line.font_size).unwrap_or(0.0);
            let detected = groups
                .iter()
                .position(|candidate| (*candidate - size).abs() <= 0.75)
                .unwrap_or(0)
                + 1;
            while open_levels.last().is_some_and(|entry| entry.0 > detected) {
                open_levels.pop();
            }
            let normalized =
                if let Some(entry) = open_levels.last().filter(|entry| entry.0 == detected) {
                    entry.1
                } else {
                    let normalized = open_levels.last().map(|entry| entry.1 + 1).unwrap_or(1);
                    open_levels.push((detected, normalized));
                    normalized
                };
            *level = normalized;
        }
    }
}

fn collect_observations(pages: &[Page]) -> Vec<HeadingObservation> {
    let mut observations = Vec::new();
    for (page_index, page) in pages.iter().enumerate() {
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Block::Heading {
                bbox,
                text,
                level,
                lines,
            } = block
            else {
                continue;
            };
            let font_size = lines.first().map(|line| line.font_size).unwrap_or(0.0);
            let font_weight = lines.first().map(|line| line.font_weight).unwrap_or(400);
            let body_left = local_body_left(page, block_index, *bbox);
            let relative_indent_em = body_left
                .filter(|left| bbox.x + font_size * 0.5 >= *left)
                .map(|left| (bbox.x - left).max(0.0) / font_size.max(1.0));
            observations.push(HeadingObservation {
                page: page_index,
                block: block_index,
                position: observations.len(),
                base_level: *level,
                font_size,
                font_weight,
                relative_indent_em,
                centered: (bbox.center_x() - page.width / 2.0).abs() <= font_size * 1.5,
                marker: parse_outline_marker(text),
            });
        }
    }
    observations
}

fn local_body_left(page: &Page, heading_index: usize, heading_bbox: BBox) -> Option<f32> {
    page.blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let Block::Paragraph { bbox, text, .. } = block else {
                return None;
            };
            if text.chars().count() < 40 {
                return None;
            }
            let horizontal_distance = if bbox.right() < heading_bbox.x {
                heading_bbox.x - bbox.right()
            } else if heading_bbox.right() < bbox.x {
                bbox.x - heading_bbox.right()
            } else {
                0.0
            };
            if horizontal_distance > page.width * 0.12 {
                return None;
            }
            let vertical_distance = if bbox.bottom() < heading_bbox.y {
                heading_bbox.y - bbox.bottom()
            } else if heading_bbox.bottom() < bbox.y {
                bbox.y - heading_bbox.bottom()
            } else {
                0.0
            };
            if vertical_distance > page.height * 0.30 {
                return None;
            }
            let order_distance = index.abs_diff(heading_index) as f32;
            Some((
                vertical_distance + horizontal_distance * 0.5 + order_distance,
                bbox.x,
            ))
        })
        .min_by(|left, right| left.0.total_cmp(&right.0))
        .map(|(_, x)| x)
}

fn apply_explicit_outline_depths(observations: &[HeadingObservation], levels: &mut [u8]) {
    let outlined: Vec<(usize, usize)> = observations
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.marker
                .as_ref()
                .and_then(|marker| marker.explicit_depth.map(|depth| (index, depth)))
        })
        .collect();
    let Some(minimum_depth) = outlined.iter().map(|(_, depth)| *depth).min() else {
        return;
    };
    let distinct_depths = outlined
        .iter()
        .map(|(_, depth)| *depth)
        .collect::<std::collections::BTreeSet<_>>();
    if distinct_depths.len() < 2 {
        return;
    }
    let anchor = mode_level(
        outlined
            .iter()
            .filter(|(_, depth)| *depth == minimum_depth)
            .map(|(index, _)| observations[*index].base_level),
    )
    .unwrap_or(1);
    for (index, depth) in outlined {
        levels[index] = anchor
            .saturating_add(depth.saturating_sub(minimum_depth) as u8)
            .clamp(1, 6);
    }
}

fn apply_atomic_marker_consistency(observations: &[HeadingObservation], levels: &mut [u8]) {
    let mut families = HashMap::<MarkerFamily, Vec<usize>>::new();
    for (index, item) in observations.iter().enumerate() {
        if let Some(marker) = item
            .marker
            .as_ref()
            .filter(|marker| marker.explicit_depth.is_none())
        {
            families
                .entry(marker.family.clone())
                .or_default()
                .push(index);
        }
    }
    for indices in families.values().filter(|indices| indices.len() >= 2) {
        if let Some(level) = mode_level(indices.iter().map(|index| levels[*index])) {
            for index in indices {
                levels[*index] = level;
            }
        }
    }
}

fn apply_marker_reset_hierarchy(observations: &[HeadingObservation], levels: &mut [u8]) {
    let mut families = HashMap::<MarkerFamily, Vec<usize>>::new();
    for (index, item) in observations.iter().enumerate() {
        if let Some(marker) = item
            .marker
            .as_ref()
            .filter(|marker| marker.explicit_depth.is_none())
        {
            families
                .entry(marker.family.clone())
                .or_default()
                .push(index);
        }
    }
    let family_names: Vec<MarkerFamily> = families.keys().cloned().collect();
    let mut edges = Vec::<(MarkerFamily, MarkerFamily)>::new();
    for parent in &family_names {
        let parent_indices = &families[parent];
        if parent_indices.len() < 2 {
            continue;
        }
        for child in &family_names {
            if child == parent || families[child].len() < 2 {
                continue;
            }
            let reset_intervals = parent_indices
                .iter()
                .enumerate()
                .filter(|(offset, parent_index)| {
                    let start = observations[**parent_index].position;
                    let end = parent_indices
                        .get(offset + 1)
                        .map(|index| observations[*index].position)
                        .unwrap_or(usize::MAX);
                    families[child]
                        .iter()
                        .find(|index| {
                            let position = observations[**index].position;
                            position > start && position < end
                        })
                        .and_then(|index| observations[*index].marker.as_ref())
                        .is_some_and(|marker| marker.ordinal == 1)
                })
                .count();
            if reset_intervals >= 2 {
                edges.push((parent.clone(), child.clone()));
            }
        }
    }

    // A few relaxation passes handle I -> A -> a without depending on hash
    // iteration order. Cycles cannot deepen forever because levels cap at six.
    for _ in 0..6 {
        let mut changed = false;
        for (parent, child) in &edges {
            let Some(parent_level) =
                mode_level(families[parent].iter().map(|index| levels[*index]))
            else {
                continue;
            };
            let child_level = parent_level.saturating_add(1).min(6);
            for index in &families[child] {
                if levels[*index] < child_level {
                    levels[*index] = child_level;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

fn apply_repeated_indentation(observations: &[HeadingObservation], levels: &mut [u8]) {
    let mut styles = BTreeMap::<(i32, u16, u8), Vec<usize>>::new();
    for (index, item) in observations.iter().enumerate() {
        if item.centered
            || item
                .marker
                .as_ref()
                .is_some_and(|marker| marker.explicit_depth.is_some())
        {
            continue;
        }
        if item.relative_indent_em.is_some() {
            styles
                .entry((
                    (item.font_size / 0.75).round() as i32,
                    item.font_weight / 100,
                    levels[index],
                ))
                .or_default()
                .push(index);
        }
    }

    for indices in styles.values().filter(|indices| indices.len() >= 4) {
        let mut sorted = indices.clone();
        sorted.sort_by(|left, right| {
            observations[*left]
                .relative_indent_em
                .unwrap_or(0.0)
                .total_cmp(&observations[*right].relative_indent_em.unwrap_or(0.0))
        });
        let Some((split, _)) = sorted
            .windows(2)
            .enumerate()
            .map(|(index, pair)| {
                let gap = observations[pair[1]].relative_indent_em.unwrap_or(0.0)
                    - observations[pair[0]].relative_indent_em.unwrap_or(0.0);
                (index + 1, gap)
            })
            .filter(|(split, gap)| *split >= 2 && sorted.len() - *split >= 2 && *gap >= 1.5)
            .max_by(|left, right| left.1.total_cmp(&right.1))
        else {
            continue;
        };
        let shallow = &sorted[..split];
        let deep = &sorted[split..];
        let first_shallow = shallow
            .iter()
            .map(|index| observations[*index].position)
            .min()
            .unwrap();
        let last_shallow = shallow
            .iter()
            .map(|index| observations[*index].position)
            .max()
            .unwrap();
        let deep_inside = deep.iter().any(|index| {
            observations[*index].position > first_shallow
                && observations[*index].position < last_shallow
        });
        let deep_after = deep
            .iter()
            .any(|index| observations[*index].position > last_shallow);
        if !deep_inside || !deep_after {
            continue;
        }
        let parent_level = mode_level(shallow.iter().map(|index| levels[*index])).unwrap_or(1);
        for index in deep {
            levels[*index] = levels[*index].max(parent_level.saturating_add(1).min(6));
        }
    }
}

fn mode_level(levels: impl Iterator<Item = u8>) -> Option<u8> {
    let mut counts = [0usize; 7];
    for level in levels {
        counts[level.clamp(1, 6) as usize] += 1;
    }
    (1..=6)
        .max_by_key(|level| (counts[*level], std::cmp::Reverse(*level)))
        .map(|level| level as u8)
}

fn parse_outline_marker(text: &str) -> Option<OutlineMarker> {
    let token = text.split_whitespace().next()?;
    if token.len() == text.trim().len() {
        return None;
    }
    let enclosed = token.starts_with('(') && token.ends_with(')');
    let punctuated = enclosed || token.ends_with('.') || token.ends_with(')');
    let core = token
        .trim_start_matches('(')
        .trim_end_matches(['.', ')', ':']);
    if core.is_empty() {
        return None;
    }
    let components: Vec<&str> = core.split('.').collect();
    if components
        .iter()
        .all(|component| component.chars().all(|ch| ch.is_ascii_digit()))
    {
        let ordinal = components.last()?.parse().ok()?;
        return Some(OutlineMarker {
            family: MarkerFamily::Arabic,
            ordinal,
            explicit_depth: Some(components.len()),
        });
    }
    if components.len() > 1
        && components
            .iter()
            .all(|component| outline_component(component))
    {
        return Some(OutlineMarker {
            family: classify_alpha_family(components.last()?)?,
            ordinal: alpha_or_roman_ordinal(components.last()?)?,
            explicit_depth: Some(components.len()),
        });
    }
    if !punctuated || !core.chars().all(|ch| ch.is_ascii_alphabetic()) || core.len() > 8 {
        return None;
    }
    Some(OutlineMarker {
        family: classify_alpha_family(core)?,
        ordinal: alpha_or_roman_ordinal(core)?,
        explicit_depth: None,
    })
}

fn outline_component(component: &str) -> bool {
    !component.is_empty()
        && (component.chars().all(|ch| ch.is_ascii_digit())
            || component.chars().all(|ch| ch.is_ascii_alphabetic()) && component.len() <= 8)
}

fn classify_alpha_family(value: &str) -> Option<MarkerFamily> {
    let uppercase = value.chars().all(|ch| ch.is_ascii_uppercase());
    let lowercase = value.chars().all(|ch| ch.is_ascii_lowercase());
    if !uppercase && !lowercase {
        return None;
    }
    let roman = roman_ordinal(value).is_some();
    Some(match (uppercase, roman) {
        (true, true) => MarkerFamily::UpperRoman,
        (false, true) => MarkerFamily::LowerRoman,
        (true, false) => MarkerFamily::UpperAlpha,
        (false, false) => MarkerFamily::LowerAlpha,
    })
}

fn alpha_or_roman_ordinal(value: &str) -> Option<usize> {
    roman_ordinal(value).or_else(|| {
        value.bytes().try_fold(0usize, |total, byte| {
            let upper = byte.to_ascii_uppercase();
            (upper.is_ascii_uppercase()).then_some(total * 26 + (upper - b'A' + 1) as usize)
        })
    })
}

fn roman_ordinal(value: &str) -> Option<usize> {
    let mut total = 0usize;
    let mut previous = 0usize;
    for byte in value.bytes().rev() {
        let current = match byte.to_ascii_uppercase() {
            b'I' => 1,
            b'V' => 5,
            b'X' => 10,
            b'L' => 50,
            b'C' => 100,
            b'D' => 500,
            b'M' => 1000,
            _ => return None,
        };
        if current < previous {
            total = total.checked_sub(current)?;
        } else {
            total += current;
            previous = current;
        }
    }
    (total > 0).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Span, TextLine};

    fn block(text: &str, x: f32, y: f32, size: f32) -> Block {
        let bbox = BBox {
            x,
            y,
            width: text.len() as f32 * size * 0.5,
            height: size,
        };
        let line = TextLine {
            text: text.into(),
            bbox,
            font_size: size,
            font_weight: 700,
            spans: vec![Span {
                text: text.into(),
                bbox,
                font_size: size,
                font_weight: 700,
                font_name: "Test".into(),
                rotation: 0.0,
            }],
        };
        Block::Heading {
            bbox,
            text: text.into(),
            level: 1,
            lines: vec![line],
        }
    }

    fn paragraph(text: &str, y: f32) -> Block {
        Block::Paragraph {
            bbox: BBox {
                x: 80.0,
                y,
                width: 430.0,
                height: 20.0,
            },
            text: text.into(),
            lines: Vec::new(),
        }
    }

    fn page(blocks: Vec<Block>) -> Page {
        Page {
            number: 1,
            width: 600.0,
            height: 800.0,
            blocks,
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

    fn heading_levels(page: &Page) -> Vec<(&str, u8)> {
        page.blocks
            .iter()
            .filter_map(|block| match block {
                Block::Heading { text, level, .. } => Some((text.as_str(), *level)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn dotted_numbers_split_identically_sized_headings() {
        let mut pages = vec![page(vec![
            block("Document title", 180.0, 20.0, 18.0),
            block("1 Introduction", 80.0, 80.0, 12.0),
            block("1.1 Scope", 80.0, 130.0, 12.0),
            block("1.1.1 Limits", 80.0, 180.0, 12.0),
            block("2 Results", 80.0, 230.0, 12.0),
        ])];
        normalize_heading_levels(&mut pages);
        assert_eq!(
            heading_levels(&pages[0]),
            vec![
                ("Document title", 1),
                ("1 Introduction", 2),
                ("1.1 Scope", 3),
                ("1.1.1 Limits", 4),
                ("2 Results", 2),
            ]
        );
    }

    #[test]
    fn repeated_roman_and_letter_resets_form_nested_levels() {
        let mut pages = vec![page(vec![
            block("Document title", 180.0, 20.0, 18.0),
            block("I. First", 80.0, 80.0, 12.0),
            block("A. Alpha", 80.0, 110.0, 12.0),
            block("B. Beta", 80.0, 140.0, 12.0),
            block("II. Second", 80.0, 180.0, 12.0),
            block("A. Again", 80.0, 210.0, 12.0),
            block("B. More", 80.0, 240.0, 12.0),
        ])];
        normalize_heading_levels(&mut pages);
        assert_eq!(
            heading_levels(&pages[0]),
            vec![
                ("Document title", 1),
                ("I. First", 2),
                ("A. Alpha", 3),
                ("B. Beta", 3),
                ("II. Second", 2),
                ("A. Again", 3),
                ("B. More", 3),
            ]
        );
    }

    #[test]
    fn repeated_local_indentation_splits_an_unnumbered_style() {
        let body = "A sufficiently long body paragraph used to establish the local column margin.";
        let mut pages = vec![page(vec![
            block("Document title", 180.0, 20.0, 18.0),
            block("First section", 80.0, 70.0, 12.0),
            block("First detail", 110.0, 100.0, 12.0),
            paragraph(body, 125.0),
            block("Second section", 80.0, 180.0, 12.0),
            block("Second detail", 110.0, 210.0, 12.0),
            paragraph(body, 235.0),
        ])];
        normalize_heading_levels(&mut pages);
        assert_eq!(
            heading_levels(&pages[0]),
            vec![
                ("Document title", 1),
                ("First section", 2),
                ("First detail", 3),
                ("Second section", 2),
                ("Second detail", 3),
            ]
        );
    }
}
