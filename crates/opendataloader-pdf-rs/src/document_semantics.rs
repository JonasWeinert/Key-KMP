use std::collections::{HashMap, HashSet};

use crate::model::{BBox, Block, Page, ReferenceItem, TextLine};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Edge {
    Header,
    Footer,
}

#[derive(Debug)]
struct EdgeCandidate {
    page_index: usize,
    block_index: usize,
    edge: Edge,
    signature: String,
    page_number: Option<usize>,
}

pub(crate) fn recognize_document_semantics(pages: &mut [Page]) {
    recognize_headers_footers_and_page_numbers(pages);
    recognize_reference_lists(pages);
}

fn recognize_headers_footers_and_page_numbers(pages: &mut [Page]) {
    if pages.is_empty() {
        return;
    }
    let mut candidates = Vec::<EdgeCandidate>::new();
    for (page_index, page) in pages.iter().enumerate() {
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Some((bbox, text, _)) = textual_block_parts(block) else {
                continue;
            };
            // Use the outermost margin band, not merely the top/bottom tenth:
            // academic figures and equations commonly start around 9-10% of
            // the page and can repeat across continuation pages.
            let edge = if bbox.bottom() <= page.height * 0.085 {
                Some(Edge::Header)
            } else if bbox.y >= page.height * 0.915 {
                Some(Edge::Footer)
            } else {
                None
            };
            let Some(edge) = edge else { continue };
            let signature = repeating_signature(text);
            if signature.is_empty() {
                continue;
            }
            candidates.push(EdgeCandidate {
                page_index,
                block_index,
                edge,
                signature,
                page_number: parse_page_number(text),
            });
        }
    }

    let mut page_number_indexes = HashSet::<(usize, usize)>::new();
    let mut offsets = HashMap::<isize, usize>::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.page_number.is_some())
    {
        let value = candidate.page_number.unwrap();
        let physical = pages[candidate.page_index].number;
        *offsets
            .entry(physical as isize - value as isize)
            .or_default() += 1;
    }
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.page_number.is_some())
    {
        let value = candidate.page_number.unwrap();
        let physical = pages[candidate.page_index].number;
        let offset = physical as isize - value as isize;
        if value == physical || offsets.get(&offset).copied().unwrap_or(0) >= 2 {
            page_number_indexes.insert((candidate.page_index, candidate.block_index));
        }
    }

    let mut repeating = HashMap::<(Edge, String), Vec<(usize, usize)>>::new();
    for candidate in &candidates {
        if page_number_indexes.contains(&(candidate.page_index, candidate.block_index)) {
            continue;
        }
        repeating
            .entry((candidate.edge, candidate.signature.clone()))
            .or_default()
            .push((candidate.page_index, candidate.block_index));
    }
    let mut repeated_indexes = HashMap::<(usize, usize), Edge>::new();
    for ((edge, _), mut occurrences) in repeating {
        occurrences.sort_unstable();
        let distinct_pages: HashSet<usize> =
            occurrences.iter().map(|occurrence| occurrence.0).collect();
        let repeats_locally = occurrences
            .windows(2)
            .any(|pair| pair[1].0 > pair[0].0 && pair[1].0.saturating_sub(pair[0].0) <= 2);
        if distinct_pages.len() >= 2 && repeats_locally {
            for occurrence in occurrences {
                repeated_indexes.insert(occurrence, edge);
            }
        }
    }

    for (page_index, page) in pages.iter_mut().enumerate() {
        for (block_index, block) in page.blocks.iter_mut().enumerate() {
            if page_number_indexes.contains(&(page_index, block_index)) {
                let value = parse_page_number(&block.text()).unwrap_or(page.number);
                replace_text_block(block, TextSemantic::PageNumber(value));
            } else if let Some(edge) = repeated_indexes.get(&(page_index, block_index)) {
                replace_text_block(
                    block,
                    match edge {
                        Edge::Header => TextSemantic::Header,
                        Edge::Footer => TextSemantic::Footer,
                    },
                );
            }
        }
    }
}

enum TextSemantic {
    Header,
    Footer,
    PageNumber(usize),
}

fn replace_text_block(block: &mut Block, semantic: TextSemantic) {
    let Some((bbox, text, lines)) = textual_block_parts(block) else {
        return;
    };
    *block = match semantic {
        TextSemantic::Header => Block::Header {
            bbox,
            text: text.to_owned(),
            lines: lines.to_vec(),
        },
        TextSemantic::Footer => Block::Footer {
            bbox,
            text: text.to_owned(),
            lines: lines.to_vec(),
        },
        TextSemantic::PageNumber(value) => Block::PageNumber {
            bbox,
            text: text.to_owned(),
            value,
            lines: lines.to_vec(),
        },
    };
}

fn textual_block_parts(block: &Block) -> Option<(BBox, &str, &[TextLine])> {
    match block {
        Block::Paragraph {
            bbox, text, lines, ..
        }
        | Block::Heading {
            bbox, text, lines, ..
        } => Some((*bbox, text, lines)),
        _ => None,
    }
}

fn repeating_signature(text: &str) -> String {
    let mut output = String::new();
    let mut in_digits = false;
    for character in text.trim().chars() {
        if character.is_ascii_digit() {
            if !in_digits {
                output.push('#');
                in_digits = true;
            }
        } else {
            in_digits = false;
            if character.is_alphanumeric() {
                output.extend(character.to_lowercase());
            } else if !output.ends_with(' ') {
                output.push(' ');
            }
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_page_number(text: &str) -> Option<usize> {
    let mut compact = text.trim().to_lowercase();
    if compact.len() > 24 {
        return None;
    }
    if let Some(rest) = compact.strip_prefix("page ") {
        compact = rest.trim().to_owned();
    }
    if let Some((first, _)) = compact.split_once(" of ") {
        compact = first.trim().to_owned();
    }
    compact = compact
        .trim_matches(|character: char| {
            character.is_whitespace() || matches!(character, '-' | '–' | '—' | '|' | '·')
        })
        .to_owned();
    if compact.chars().all(|character| character.is_ascii_digit()) {
        return compact.parse().ok();
    }
    roman_number(&compact)
}

fn roman_number(text: &str) -> Option<usize> {
    if text.is_empty()
        || text.len() > 10
        || !text
            .chars()
            .all(|character| matches!(character, 'i' | 'v' | 'x' | 'l' | 'c'))
    {
        return None;
    }
    let value = |character| match character {
        'i' => 1,
        'v' => 5,
        'x' => 10,
        'l' => 50,
        'c' => 100,
        _ => 0,
    };
    let values: Vec<usize> = text.chars().map(value).collect();
    let total: isize = values
        .iter()
        .enumerate()
        .map(|(index, current)| {
            if values.get(index + 1).is_some_and(|next| current < next) {
                -(*current as isize)
            } else {
                *current as isize
            }
        })
        .sum();
    (total > 0).then_some(total as usize)
}

fn recognize_reference_lists(pages: &mut [Page]) {
    let Some((start_page, start_block, heading_level)) = find_reference_heading(pages) else {
        return;
    };
    let end = find_reference_end(pages, start_page, start_block, heading_level);
    let mut list_pages = Vec::<usize>::new();
    let mut numbered_section = false;
    let mut previous_page_had_items = false;
    for page_index in start_page..=end.map(|position| position.0).unwrap_or(pages.len() - 1) {
        let first = if page_index == start_page {
            start_block + 1
        } else {
            0
        };
        let last = end
            .filter(|position| position.0 == page_index)
            .map(|position| position.1)
            .unwrap_or(pages[page_index].blocks.len());
        if first >= last {
            continue;
        }
        let eligible: Vec<usize> = (first..last)
            .filter(|index| matches!(pages[page_index].blocks[*index], Block::Paragraph { .. }))
            .collect();
        if eligible.is_empty() {
            previous_page_had_items = false;
            continue;
        }
        let mut items = Vec::<ReferenceItem>::new();
        for index in &eligible {
            let Block::Paragraph {
                bbox, text, lines, ..
            } = &pages[page_index].blocks[*index]
            else {
                continue;
            };
            let fragments = split_reference_block(*bbox, text, lines);
            for fragment in fragments {
                if fragment.label.is_some() {
                    numbered_section = true;
                    items.push(fragment);
                } else if let Some(current) = items.last_mut().filter(|current| {
                    numbered_section || reference_fragment_continues(current, &fragment)
                }) {
                    append_reference_fragment(current, fragment);
                } else {
                    items.push(fragment);
                }
            }
        }
        if items.is_empty() {
            previous_page_had_items = false;
            continue;
        }
        if previous_page_had_items && items.first().is_some_and(|item| item.label.is_none()) {
            items[0].continued = true;
        }
        let list_bbox = items
            .iter()
            .map(|item| item.bbox)
            .reduce(BBox::union)
            .unwrap();
        let numbering_style = if items.iter().any(|item| item.label.is_some()) {
            "numeric"
        } else {
            "none"
        };
        let insert_at = eligible[0];
        for index in eligible.into_iter().rev() {
            pages[page_index].blocks.remove(index);
        }
        pages[page_index].blocks.insert(
            insert_at,
            Block::ReferenceList {
                bbox: list_bbox,
                numbering_style: numbering_style.to_owned(),
                continued_from_previous: previous_page_had_items,
                continues_on_next: false,
                items,
            },
        );
        list_pages.push(page_index);
        previous_page_had_items = true;
    }
    for pair in list_pages.windows(2) {
        if pages[pair[0]].number + 1 == pages[pair[1]].number {
            if let Some(Block::ReferenceList {
                continues_on_next, ..
            }) = pages[pair[0]]
                .blocks
                .iter_mut()
                .find(|block| matches!(block, Block::ReferenceList { .. }))
            {
                *continues_on_next = true;
            }
        }
    }
}

fn find_reference_heading(pages: &[Page]) -> Option<(usize, usize, u8)> {
    pages
        .iter()
        .enumerate()
        .filter_map(|(page_index, page)| {
            page.blocks
                .iter()
                .enumerate()
                .find_map(|(block_index, block)| match block {
                    Block::Heading { text, level, .. } if is_reference_heading(text) => {
                        Some((page_index, block_index, *level))
                    }
                    Block::Paragraph { text, .. }
                        if text.chars().count() <= 40 && is_reference_heading(text) =>
                    {
                        Some((page_index, block_index, 6))
                    }
                    _ => None,
                })
        })
        .next_back()
}

fn is_reference_heading(text: &str) -> bool {
    let trimmed = text
        .trim()
        .trim_matches(|character: char| !character.is_alphanumeric());
    let without_number = trimmed
        .trim_start_matches(|character: char| {
            character.is_ascii_digit() || character == '.' || character.is_whitespace()
        })
        .to_lowercase();
    matches!(
        without_number.as_str(),
        "references"
            | "bibliography"
            | "reference list"
            | "bibliographical references"
            | "works cited"
            | "literature cited"
            | "selected references"
            | "references and notes"
            | "notes and references"
            | "sources"
            | "références"
            | "literaturverzeichnis"
            | "literatur"
            | "referencias"
            | "referências"
    )
}

fn find_reference_end(
    pages: &[Page],
    start_page: usize,
    start_block: usize,
    heading_level: u8,
) -> Option<(usize, usize)> {
    for (page_index, page) in pages.iter().enumerate().skip(start_page) {
        let first = if page_index == start_page {
            start_block + 1
        } else {
            0
        };
        for (block_index, block) in page.blocks.iter().enumerate().skip(first) {
            if let Block::Heading { text, level, .. } = block {
                if !is_reference_heading(text)
                    && (page_index > start_page || *level <= heading_level)
                {
                    return Some((page_index, block_index));
                }
            }
        }
    }
    None
}

fn split_reference_block(bbox: BBox, text: &str, lines: &[TextLine]) -> Vec<ReferenceItem> {
    let markers = bracketed_markers(text);
    if markers.is_empty() {
        return split_unnumbered_hanging_indent(bbox, text, lines);
    }
    let mut result = Vec::new();
    if markers[0].0 > 0 && !text[..markers[0].0].trim().is_empty() {
        result.push(reference_item(
            None,
            text[..markers[0].0].trim().to_owned(),
            proportional_bbox(bbox, 0, markers[0].0, text.len()),
            Vec::new(),
        ));
    }
    for (marker_index, (start, content_start, label)) in markers.iter().enumerate() {
        let end = markers
            .get(marker_index + 1)
            .map(|marker| marker.0)
            .unwrap_or(text.len());
        result.push(reference_item(
            Some(label.clone()),
            text[*content_start..end].trim().to_owned(),
            proportional_bbox(bbox, *start, end, text.len()),
            Vec::new(),
        ));
    }
    result
}

fn bracketed_markers(text: &str) -> Vec<(usize, usize, String)> {
    let bytes = text.as_bytes();
    let mut markers = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let (open, close) = match bytes[index] {
            b'[' => (b'[', b']'),
            b'(' => (b'(', b')'),
            _ => {
                index += 1;
                continue;
            }
        };
        let boundary = index == 0 || bytes[index - 1].is_ascii_whitespace();
        let mut end = index + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let plausible_label = text[index + 1..end]
            .parse::<usize>()
            .is_ok_and(|value| value <= 999);
        if boundary
            && end > index + 1
            && end < bytes.len()
            && bytes[end] == close
            && plausible_label
        {
            let label = text[index + 1..end].to_owned();
            markers.push((index, end + 1, label));
            index = end + 1;
        } else {
            let _ = open;
            index += 1;
        }
    }
    if markers.is_empty() {
        if let Some((label, content_start)) = leading_numeric_marker(text) {
            markers.push((0, content_start, label));
        }
    }
    markers
}

fn leading_numeric_marker(text: &str) -> Option<(String, usize)> {
    let trimmed = text.trim_start();
    let offset = text.len() - trimmed.len();
    let digits = trimmed
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    // Four-digit years are common as standalone continuation fragments in
    // bibliographies. Treating them as item labels creates spectacularly
    // wrong entries such as reference 2014 between references 2 and 3.
    let value = trimmed[..digits].parse::<usize>().ok()?;
    if value > 999 {
        return None;
    }
    if digits == trimmed.len() {
        return Some((trimmed.to_owned(), text.len()));
    }
    let punctuation = trimmed.as_bytes().get(digits).copied()?;
    if !matches!(punctuation, b'.' | b')' | b']') {
        return None;
    }
    Some((trimmed[..digits].to_owned(), offset + digits + 1))
}

fn split_unnumbered_hanging_indent(
    bbox: BBox,
    text: &str,
    lines: &[TextLine],
) -> Vec<ReferenceItem> {
    if lines.len() < 3 {
        return vec![reference_item(
            None,
            text.trim().to_owned(),
            bbox,
            lines.to_vec(),
        )];
    }
    let base_x = lines
        .iter()
        .map(|line| line.bbox.x)
        .fold(f32::INFINITY, f32::min);
    let mut groups = Vec::<Vec<TextLine>>::new();
    for line in lines {
        let starts_at_margin = line.bbox.x <= base_x + 3.0;
        let previous_was_indented = groups
            .last()
            .and_then(|group| group.last())
            .is_some_and(|previous| previous.bbox.x > base_x + 6.0);
        if groups.is_empty() || (starts_at_margin && previous_was_indented) {
            groups.push(vec![line.clone()]);
        } else {
            groups.last_mut().unwrap().push(line.clone());
        }
    }
    if groups.len() == 1 {
        return vec![reference_item(
            None,
            text.trim().to_owned(),
            bbox,
            lines.to_vec(),
        )];
    }
    groups
        .into_iter()
        .map(|group| {
            let group_bbox = group
                .iter()
                .map(|line| line.bbox)
                .reduce(BBox::union)
                .unwrap();
            let group_text = group
                .iter()
                .map(|line| line.text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            reference_item(None, group_text, group_bbox, group)
        })
        .collect()
}

fn reference_item(
    label: Option<String>,
    text: String,
    bbox: BBox,
    lines: Vec<TextLine>,
) -> ReferenceItem {
    ReferenceItem {
        label,
        text,
        bbox,
        continued: false,
        lines,
    }
}

fn proportional_bbox(bbox: BBox, start: usize, end: usize, total: usize) -> BBox {
    let total = total.max(1) as f32;
    let top = bbox.y + bbox.height * start as f32 / total;
    let bottom = bbox.y + bbox.height * end as f32 / total;
    BBox {
        x: bbox.x,
        y: top,
        width: bbox.width,
        height: (bottom - top).max(1.0),
    }
}

fn reference_fragment_continues(current: &ReferenceItem, next: &ReferenceItem) -> bool {
    let same_baseline = (current.bbox.center_y() - next.bbox.center_y()).abs()
        <= current.bbox.height.max(next.bbox.height) * 0.6;
    let hanging =
        next.bbox.x >= current.bbox.x + 8.0 && next.bbox.y - current.bbox.bottom() <= 12.0;
    same_baseline || hanging
}

fn append_reference_fragment(current: &mut ReferenceItem, fragment: ReferenceItem) {
    if !current.text.is_empty() && !fragment.text.is_empty() {
        current.text.push(' ');
    }
    current.text.push_str(&fragment.text);
    current.bbox = current.bbox.union(fragment.bbox);
    current.lines.extend(fragment.lines);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f32, y: f32) -> TextLine {
        TextLine {
            text: text.to_owned(),
            bbox: BBox {
                x,
                y,
                width: 180.0,
                height: 9.0,
            },
            font_size: 9.0,
            font_weight: 400,
            spans: Vec::new(),
        }
    }

    fn paragraph(text: &str, x: f32, y: f32) -> Block {
        let source = line(text, x, y);
        Block::Paragraph {
            bbox: source.bbox,
            text: text.to_owned(),
            lines: vec![source],
        }
    }

    #[test]
    fn parses_arabic_and_roman_page_numbers() {
        assert_eq!(parse_page_number("- 12 -"), Some(12));
        assert_eq!(parse_page_number("Page 7 of 20"), Some(7));
        assert_eq!(parse_page_number("xiv"), Some(14));
        assert_eq!(parse_page_number("Table 7"), None);
    }

    #[test]
    fn splits_multiple_numbered_references_in_one_paragraph() {
        let items = split_reference_block(
            BBox {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 40.0,
            },
            "[1] Alpha. [2] Beta.",
            &[],
        );
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].label.as_deref(), Some("1"));
        assert_eq!(items[0].text, "Alpha.");
        assert_eq!(items[1].label.as_deref(), Some("2"));
        assert_eq!(items[1].text, "Beta.");
    }

    #[test]
    fn does_not_treat_a_bibliographic_year_as_an_item_label() {
        let items = split_reference_block(
            BBox {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 10.0,
            },
            "2014.",
            &[],
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, None);
        assert_eq!(items[0].text, "2014.");

        let parenthesized = split_reference_block(
            BBox {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 10.0,
            },
            "Published (2017), revised 2019.",
            &[],
        );
        assert_eq!(parenthesized.len(), 1);
        assert_eq!(parenthesized[0].label, None);
    }

    #[test]
    fn recognizes_alternating_headers_repeated_footers_and_roman_pages() {
        let mut pages: Vec<Page> = (0..4)
            .map(|index| Page {
                number: index + 1,
                width: 612.0,
                height: 792.0,
                blocks: vec![
                    paragraph(
                        if index % 2 == 0 {
                            "Left running title"
                        } else {
                            "Right running title"
                        },
                        80.0,
                        20.0,
                    ),
                    paragraph("Body text", 80.0, 200.0),
                    paragraph("Confidential", 80.0, 730.0),
                    paragraph(["i", "ii", "iii", "iv"][index], 300.0, 760.0),
                ],
                citations: Vec::new(),
                note_references: Vec::new(),
                sentences: Vec::new(),
                semantic_regions: Vec::new(),
                internal_links: Vec::new(),
                marked_objects: Vec::new(),
                images: Vec::new(),
                lines: Vec::new(),
                rules: Vec::new(),
            })
            .collect();
        recognize_headers_footers_and_page_numbers(&mut pages);
        for page in pages {
            assert!(matches!(page.blocks[0], Block::Header { .. }));
            assert!(matches!(page.blocks[1], Block::Paragraph { .. }));
            assert!(matches!(page.blocks[2], Block::Footer { .. }));
            assert!(matches!(page.blocks[3], Block::PageNumber { .. }));
        }
    }

    #[test]
    fn splits_unnumbered_hanging_indent_items() {
        let lines = vec![
            line("Smith, J. First title.", 10.0, 20.0),
            line("Journal continuation.", 24.0, 30.0),
            line("Taylor, A. Second title.", 10.0, 44.0),
            line("Publisher continuation.", 24.0, 54.0),
        ];
        let bbox = lines
            .iter()
            .map(|line| line.bbox)
            .reduce(BBox::union)
            .unwrap();
        let items = split_unnumbered_hanging_indent(bbox, "unused", &lines);
        assert_eq!(items.len(), 2);
        assert!(items[0].text.starts_with("Smith"));
        assert!(items[1].text.starts_with("Taylor"));
    }
}
