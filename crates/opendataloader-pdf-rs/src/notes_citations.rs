use std::collections::{HashMap, HashSet};

use crate::model::{BBox, Block, Citation, NoteItem, NoteReference, Page, TextLine};

pub(crate) fn recognize_notes_and_citations(pages: &mut [Page]) {
    recognize_endnotes(pages);
    recognize_footnotes(pages);
    recognize_note_references(pages);
    recognize_citations(pages);
}

fn recognize_endnotes(pages: &mut [Page]) {
    let page_count = pages.len();
    let Some((page_index, heading_index, heading_level)) = pages
        .iter()
        .enumerate()
        .flat_map(|(page_index, page)| {
            page.blocks
                .iter()
                .enumerate()
                .filter_map(move |(block_index, block)| match block {
                    Block::Heading { text, level, .. }
                        if is_endnote_heading(text)
                            && page_index * 2 >= page_count.saturating_sub(1) =>
                    {
                        Some((page_index, block_index, *level))
                    }
                    _ => None,
                })
        })
        .next_back()
    else {
        return;
    };

    let mut end = None;
    'outer: for (candidate_page, page) in pages.iter().enumerate().skip(page_index) {
        let first = if candidate_page == page_index {
            heading_index + 1
        } else {
            0
        };
        for (block_index, block) in page.blocks.iter().enumerate().skip(first) {
            if matches!(block, Block::Heading { level, .. } if *level <= heading_level) {
                end = Some((candidate_page, block_index));
                break 'outer;
            }
        }
    }

    let last_page = end.map(|position| position.0).unwrap_or(pages.len() - 1);
    let mut collected = Vec::<(usize, usize, NoteItem)>::new();
    let mut consumed_blocks = Vec::<(usize, usize)>::new();
    for (candidate_page, page) in pages
        .iter()
        .enumerate()
        .take(last_page + 1)
        .skip(page_index)
    {
        let first = if candidate_page == page_index {
            heading_index + 1
        } else {
            0
        };
        let last = end
            .filter(|position| position.0 == candidate_page)
            .map(|position| position.1)
            .unwrap_or(page.blocks.len());
        for block_index in first..last {
            let Block::Paragraph {
                bbox, text, lines, ..
            } = &page.blocks[block_index]
            else {
                continue;
            };
            if let Some((label, content_start)) =
                leading_note_marker(text).or_else(|| leading_superscript_note_marker(text, lines))
            {
                let id = format!("en-{}", note_id_component(&label));
                collected.push((
                    candidate_page,
                    block_index,
                    NoteItem {
                        id,
                        label: Some(label),
                        text: text[content_start..].trim().to_owned(),
                        bbox: *bbox,
                        lines: lines.clone(),
                    },
                ));
                consumed_blocks.push((candidate_page, block_index));
            } else if let Some((_, _, item)) = collected.last_mut() {
                if !item.text.chars().last().is_some_and(char::is_whitespace) {
                    item.text.push(' ');
                }
                item.text.push_str(text.trim());
                item.bbox = item.bbox.union(*bbox);
                item.lines.extend(lines.clone());
                consumed_blocks.push((candidate_page, block_index));
            }
        }
    }
    if collected.len() < 2 {
        return;
    }

    for (current_page, page) in pages
        .iter_mut()
        .enumerate()
        .take(last_page + 1)
        .skip(page_index)
    {
        let mut positions: Vec<usize> = consumed_blocks
            .iter()
            .filter(|position| position.0 == current_page)
            .map(|position| position.1)
            .collect();
        if current_page == page_index {
            positions.push(heading_index);
        }
        positions.sort_unstable();
        positions.dedup();
        let items: Vec<NoteItem> = collected
            .iter()
            .filter(|entry| entry.0 == current_page)
            .map(|entry| entry.2.clone())
            .collect();
        if items.is_empty() {
            continue;
        }
        let bbox = items
            .iter()
            .map(|item| item.bbox)
            .reduce(BBox::union)
            .unwrap();
        let insert_at = *positions.first().unwrap();
        for position in positions.into_iter().rev() {
            page.blocks.remove(position);
        }
        page.blocks
            .insert(insert_at, Block::EndnoteList { bbox, items });
    }
}

fn is_endnote_heading(text: &str) -> bool {
    matches!(
        normalize_heading(text).as_str(),
        "notes"
            | "endnotes"
            | "end notes"
            | "notes to the text"
            | "chapter notes"
            | "notes du chapitre"
            | "anmerkungen"
            | "notas"
    )
}

fn normalize_heading(text: &str) -> String {
    text.trim()
        .trim_end_matches([':', '.'])
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn recognize_footnotes(pages: &mut [Page]) {
    for page in pages {
        let body_size = median(
            page.blocks
                .iter()
                .filter_map(|block| match block {
                    Block::Paragraph { lines, bbox, .. } if bbox.y < page.height * 0.7 => {
                        lines.first().map(|line| line.font_size)
                    }
                    _ => None,
                })
                .collect(),
        )
        .unwrap_or(10.0);
        let mut replacements = Vec::<(usize, Vec<Block>)>::new();
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Block::Paragraph { lines, .. } = block else {
                continue;
            };
            let Some((note_start, label, content_start)) =
                lines.iter().enumerate().find_map(|(line_index, line)| {
                    if line.bbox.y < page.height * 0.72 || line.bbox.bottom() > page.height * 0.94 {
                        return None;
                    }
                    let marker_is_superscript = line
                        .spans
                        .first()
                        .is_some_and(|span| span.font_size <= body_size * 0.82);
                    if line.font_size > body_size * 0.9 && !marker_is_superscript {
                        return None;
                    }
                    leading_note_marker(&line.text)
                        .or_else(|| {
                            leading_superscript_note_marker(&line.text, std::slice::from_ref(line))
                        })
                        .map(|(label, content_start)| (line_index, label, content_start))
                })
            else {
                continue;
            };
            let mut replacement = Vec::new();
            if note_start > 0 {
                replacement.push(paragraph_from_lines(&lines[..note_start]));
            }
            let mut note_groups = vec![(label, content_start, Vec::<TextLine>::new())];
            for (offset, line) in lines[note_start..].iter().enumerate() {
                if offset > 0 {
                    if let Some((next_label, next_start)) =
                        leading_note_marker(&line.text).or_else(|| {
                            leading_superscript_note_marker(&line.text, std::slice::from_ref(line))
                        })
                    {
                        note_groups.push((next_label, next_start, Vec::new()));
                    }
                }
                note_groups.last_mut().unwrap().2.push(line.clone());
            }
            for (label, content_start, note_lines) in note_groups {
                let mut note_text = note_lines[0].text[content_start..].trim().to_owned();
                for line in note_lines.iter().skip(1) {
                    if !note_text.is_empty() {
                        note_text.push(' ');
                    }
                    note_text.push_str(line.text.trim());
                }
                if note_text.chars().count() < 3 {
                    continue;
                }
                let note_bbox = note_lines
                    .iter()
                    .map(|line| line.bbox)
                    .reduce(BBox::union)
                    .unwrap();
                let item = NoteItem {
                    id: format!("fn-p{}-{}", page.number, note_id_component(&label)),
                    label: Some(label),
                    text: note_text,
                    bbox: note_bbox,
                    lines: note_lines,
                };
                replacement.push(Block::Footnote {
                    bbox: note_bbox,
                    item,
                });
            }
            replacements.push((block_index, replacement));
        }
        for (block_index, replacement) in replacements.into_iter().rev() {
            page.blocks.splice(block_index..=block_index, replacement);
        }
    }
}

fn paragraph_from_lines(lines: &[TextLine]) -> Block {
    let bbox = lines
        .iter()
        .map(|line| line.bbox)
        .reduce(BBox::union)
        .unwrap();
    let mut text = String::new();
    for line in lines {
        if text.ends_with('-') && line.text.chars().next().is_some_and(char::is_lowercase) {
            text.pop();
        } else if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(line.text.trim());
    }
    Block::Paragraph {
        bbox,
        text,
        lines: lines.to_vec(),
    }
}

fn median(mut values: Vec<f32>) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    Some(values[values.len() / 2])
}

fn leading_note_marker(text: &str) -> Option<(String, usize)> {
    let trimmed = text.trim_start();
    let offset = text.len() - trimmed.len();
    let first = trimmed.chars().next()?;
    if matches!(first, '*' | '∗' | '⁎' | '†' | '‡' | '※') {
        return Some((first.to_string(), offset + first.len_utf8()));
    }
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 3 {
        return None;
    }
    let after_digits = &trimmed[digits..];
    let punctuation_bytes = after_digits
        .bytes()
        .take_while(|byte| matches!(*byte, b'.' | b')' | b']'))
        .count();
    let content_start = offset + digits + punctuation_bytes;
    let boundary = text[content_start..]
        .chars()
        .next()
        .is_none_or(char::is_whitespace)
        || punctuation_bytes > 0;
    boundary.then(|| (trimmed[..digits].to_owned(), content_start))
}

fn leading_superscript_note_marker(text: &str, lines: &[TextLine]) -> Option<(String, usize)> {
    let line = lines.first()?;
    let span = line.spans.first()?;
    let marker = span.text.trim();
    if span.font_size > line.font_size * 0.82
        || !(marker.bytes().all(|byte| byte.is_ascii_digit())
            || marker
                .chars()
                .all(|character| matches!(character, '*' | '∗' | '⁎' | '†' | '‡' | '※')))
    {
        return None;
    }
    text.starts_with(marker)
        .then(|| (marker.to_owned(), marker.len()))
}

fn note_id_component(label: &str) -> String {
    match label {
        "*" | "∗" | "⁎" => "star".to_owned(),
        "†" => "dagger".to_owned(),
        "‡" => "double-dagger".to_owned(),
        "※" => "reference-mark".to_owned(),
        _ => label
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
            .collect(),
    }
}

fn recognize_note_references(pages: &mut [Page]) {
    let endnotes: HashMap<String, String> = pages
        .iter()
        .flat_map(|page| page.blocks.iter())
        .filter_map(|block| match block {
            Block::EndnoteList { items, .. } => Some(items),
            _ => None,
        })
        .flatten()
        .filter_map(|item| item.label.clone().map(|label| (label, item.id.clone())))
        .collect();
    for page in pages {
        let mut labels = endnotes.clone();
        labels.extend(page.blocks.iter().filter_map(|block| match block {
            Block::Footnote { item, .. } => {
                item.label.clone().map(|label| (label, item.id.clone()))
            }
            _ => None,
        }));
        if labels.is_empty() {
            continue;
        }
        let mut references = Vec::new();
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Some((bbox, text, lines)) = textual_parts(block) else {
                continue;
            };
            for line in lines {
                let Some(line_start) = text.find(line.text.trim()) else {
                    continue;
                };
                for span in &line.spans {
                    let marker = span
                        .text
                        .trim()
                        .trim_matches(|character| matches!(character, '[' | ']' | '(' | ')'));
                    let Some(note_id) = labels.get(marker) else {
                        continue;
                    };
                    let superscript = span.font_size <= line.font_size * 0.84
                        || span.bbox.bottom() < line.bbox.bottom() - line.bbox.height * 0.18;
                    if !superscript {
                        continue;
                    }
                    let Some(local_start) = line.text.find(span.text.trim()) else {
                        continue;
                    };
                    let start = line_start + local_start;
                    let end = start + span.text.trim().len();
                    references.push(NoteReference {
                        block_index,
                        start,
                        end,
                        text: text[start..end].to_owned(),
                        note_id: note_id.clone(),
                        bbox: span.bbox,
                    });
                }
            }
            let _ = bbox;
        }
        references.sort_by_key(|reference| (reference.block_index, reference.start));
        references
            .dedup_by_key(|reference| (reference.block_index, reference.start, reference.end));
        page.note_references = references;
    }
}

fn recognize_citations(pages: &mut [Page]) {
    let reference_pages: HashSet<usize> = pages
        .iter()
        .filter(|page| {
            page.blocks
                .iter()
                .any(|block| matches!(block, Block::ReferenceList { .. }))
        })
        .map(|page| page.number)
        .collect();
    let references: Vec<(Option<String>, String)> = pages
        .iter()
        .flat_map(|page| page.blocks.iter())
        .filter_map(|block| match block {
            Block::ReferenceList { items, .. } => Some(items),
            _ => None,
        })
        .flatten()
        .map(|item| (item.label.clone(), item.text.clone()))
        .collect();
    if references.is_empty() {
        return;
    }
    let valid_labels: HashSet<String> = references
        .iter()
        .filter_map(|reference| reference.0.clone())
        .collect();
    for page in pages.iter_mut() {
        let note_ranges: HashSet<(usize, usize, usize)> = page
            .note_references
            .iter()
            .map(|reference| (reference.block_index, reference.start, reference.end))
            .collect();
        let mut citations = Vec::new();
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Some((bbox, text, lines)) = textual_parts(block) else {
                continue;
            };
            for (start, end, style, labels) in numeric_citations(text, &valid_labels) {
                if note_ranges.contains(&(block_index, start, end)) {
                    continue;
                }
                let parenthetical = style == "numeric_parenthetical";
                citations.push(Citation {
                    block_index,
                    start,
                    end,
                    text: text[start..end].to_owned(),
                    style,
                    bbox: text_range_bbox(bbox, text, lines, start, end),
                    confidence: if parenthetical { 0.74 } else { 0.95 },
                    evidence: vec![
                        "reference_label_match".to_owned(),
                        if parenthetical {
                            "parenthetical_prose_context"
                        } else {
                            "explicit_numeric_delimiters"
                        }
                        .to_owned(),
                    ],
                    link_target_page: None,
                    reference_labels: labels,
                    target_ids: Vec::new(),
                    external_urls: Vec::new(),
                });
            }
            for citation in
                superscript_numeric_citations(block_index, text, lines, &valid_labels, &note_ranges)
            {
                citations.push(citation);
            }
            for (start, end, labels) in author_year_citations(text, &references) {
                citations.push(Citation {
                    block_index,
                    start,
                    end,
                    text: text[start..end].to_owned(),
                    style: "author_year".to_owned(),
                    bbox: text_range_bbox(bbox, text, lines, start, end),
                    confidence: 0.85,
                    evidence: vec!["bibliography_fuzzy_match".to_owned()],
                    link_target_page: None,
                    reference_labels: labels,
                    target_ids: Vec::new(),
                    external_urls: Vec::new(),
                });
            }
        }
        citations.sort_by_key(|citation| (citation.block_index, citation.start, citation.end));
        citations.dedup_by_key(|citation| (citation.block_index, citation.start, citation.end));
        page.citations = citations;
    }
    apply_internal_link_evidence(pages, &references, &valid_labels, &reference_pages);
    apply_document_style_consistency(pages);
}

fn apply_internal_link_evidence(
    pages: &mut [Page],
    references: &[(Option<String>, String)],
    valid_labels: &HashSet<String>,
    reference_pages: &HashSet<usize>,
) {
    for page in pages {
        if page.internal_links.is_empty() {
            continue;
        }
        for citation in &mut page.citations {
            let Some(link) = page
                .internal_links
                .iter()
                .filter(|link| boxes_overlap(citation.bbox, link.bbox))
                .max_by(|left, right| {
                    overlap_area(citation.bbox, left.bbox)
                        .total_cmp(&overlap_area(citation.bbox, right.bbox))
                })
            else {
                continue;
            };
            citation.evidence.push("internal_link_source".to_owned());
            citation.link_target_page = Some(link.target_page);
            citation.confidence += 0.03;
            if reference_pages.contains(&link.target_page) {
                citation
                    .evidence
                    .push("link_targets_reference_page".to_owned());
                citation.confidence += 0.06;
            }
            citation.confidence = citation.confidence.min(0.99);
        }

        let mut additions = Vec::new();
        for link in &page.internal_links {
            // A destination in the bibliography is useful but deliberately
            // weak: many authoring systems target only the section or page.
            if !reference_pages.contains(&link.target_page) {
                continue;
            }
            for (block_index, block) in page.blocks.iter().enumerate() {
                let Some((block_bbox, text, lines)) = textual_parts(block) else {
                    continue;
                };
                if !boxes_overlap(block_bbox, link.bbox)
                    || page.citations.iter().any(|citation| {
                        citation.block_index == block_index
                            && boxes_overlap(citation.bbox, link.bbox)
                    })
                {
                    continue;
                }
                let Some((start, end)) = linked_text_range(text, lines, link.bbox) else {
                    continue;
                };
                if page.note_references.iter().any(|reference| {
                    reference.block_index == block_index
                        && start < reference.end
                        && end > reference.start
                }) {
                    continue;
                }
                let linked_text = text[start..end].trim();
                let stripped = linked_text
                    .trim_matches(|character: char| matches!(character, '[' | ']' | '(' | ')'));
                let labels = expand_numeric_labels(stripped);
                let explicitly_delimited = (linked_text.starts_with('[')
                    && linked_text.ends_with(']'))
                    || (linked_text.starts_with('(') && linked_text.ends_with(')'));
                if explicitly_delimited
                    && !labels.is_empty()
                    && labels.iter().all(|label| valid_labels.contains(label))
                {
                    additions.push(Citation {
                        block_index,
                        start,
                        end,
                        text: text[start..end].to_owned(),
                        style: "numeric_link".to_owned(),
                        bbox: text_range_bbox(block_bbox, text, lines, start, end),
                        confidence: 0.72,
                        evidence: vec![
                            "reference_label_match".to_owned(),
                            "internal_link_source".to_owned(),
                            "link_targets_reference_page".to_owned(),
                        ],
                        link_target_page: Some(link.target_page),
                        reference_labels: labels,
                        target_ids: Vec::new(),
                        external_urls: Vec::new(),
                    });
                    continue;
                }
                if let Some(author_matches) = bibliography_match_labels(linked_text, references) {
                    additions.push(Citation {
                        block_index,
                        start,
                        end,
                        text: text[start..end].to_owned(),
                        style: "author_year_link".to_owned(),
                        bbox: text_range_bbox(block_bbox, text, lines, start, end),
                        confidence: 0.7,
                        evidence: vec![
                            "bibliography_fuzzy_match".to_owned(),
                            "internal_link_source".to_owned(),
                            "link_targets_reference_page".to_owned(),
                        ],
                        link_target_page: Some(link.target_page),
                        reference_labels: author_matches,
                        target_ids: Vec::new(),
                        external_urls: Vec::new(),
                    });
                }
            }
        }
        page.citations.extend(additions);
        page.citations
            .sort_by_key(|citation| (citation.block_index, citation.start, citation.end));
        page.citations
            .dedup_by_key(|citation| (citation.block_index, citation.start, citation.end));
    }
}

fn apply_document_style_consistency(pages: &mut [Page]) {
    let mut counts = HashMap::<String, usize>::new();
    for citation in pages.iter().flat_map(|page| &page.citations) {
        if citation.confidence >= 0.7 {
            *counts
                .entry(style_family(&citation.style).to_owned())
                .or_default() += 1;
        }
    }
    let total: usize = counts.values().sum();
    let Some((dominant, count)) = counts.into_iter().max_by_key(|entry| entry.1) else {
        return;
    };
    if count < 3 || count * 5 < total * 3 {
        return;
    }
    for citation in pages
        .iter_mut()
        .flat_map(|page| &mut page.citations)
        .filter(|citation| style_family(&citation.style) == dominant)
    {
        citation
            .evidence
            .push("document_style_consistency".to_owned());
        citation.confidence = (citation.confidence + 0.04).min(0.99);
    }
}

fn style_family(style: &str) -> &str {
    if style.starts_with("author_year") {
        "author_year"
    } else if style.starts_with("numeric") {
        "numeric"
    } else {
        style
    }
}

fn linked_text_range(text: &str, lines: &[TextLine], link_bbox: BBox) -> Option<(usize, usize)> {
    let mut cursor = 0;
    let mut result: Option<(usize, usize)> = None;
    for line in lines {
        let line_text = line.text.trim();
        let local_line_start = text[cursor..].find(line_text)?;
        let line_start = cursor + local_line_start;
        let mut span_cursor = 0;
        for span in &line.spans {
            let span_text = span.text.trim();
            if span_text.is_empty() {
                continue;
            }
            let Some(local_start) = line_text[span_cursor..].find(span_text) else {
                continue;
            };
            let start = line_start + span_cursor + local_start;
            let end = start + span_text.len();
            span_cursor += local_start + span_text.len();
            if boxes_overlap(span.bbox, link_bbox) {
                result = Some(match result {
                    Some((existing_start, existing_end)) => {
                        (existing_start.min(start), existing_end.max(end))
                    }
                    None => (start, end),
                });
            }
        }
        cursor = line_start + line_text.len();
    }
    result
}

fn boxes_overlap(left: BBox, right: BBox) -> bool {
    overlap_area(left, right) > 0.5
}

fn overlap_area(left: BBox, right: BBox) -> f32 {
    let width = left.right().min(right.right()) - left.x.max(right.x);
    let height = left.bottom().min(right.bottom()) - left.y.max(right.y);
    width.max(0.0) * height.max(0.0)
}

fn superscript_numeric_citations(
    block_index: usize,
    text: &str,
    lines: &[TextLine],
    valid_labels: &HashSet<String>,
    note_ranges: &HashSet<(usize, usize, usize)>,
) -> Vec<Citation> {
    if valid_labels.is_empty() {
        return Vec::new();
    }
    let mut output = Vec::new();
    let mut cursor = 0;
    for line in lines {
        let line_text = line.text.trim();
        let Some(local_line_start) = text[cursor..].find(line_text) else {
            continue;
        };
        let line_start = cursor + local_line_start;
        let prose_like = line_text
            .chars()
            .filter(|character| character.is_alphabetic())
            .count()
            >= 15
            && line_text.split_whitespace().count() >= 4;
        if prose_like {
            let mut span_cursor = 0;
            for span in &line.spans {
                let marker = span.text.trim();
                let superscript = span.bbox.bottom() < line.bbox.bottom() - line.bbox.height * 0.18;
                if !superscript
                    || marker.is_empty()
                    || !marker.chars().all(|character| {
                        character.is_ascii_digit()
                            || character.is_whitespace()
                            || matches!(character, ',' | ';' | '-' | '–' | '—')
                    })
                {
                    continue;
                }
                let labels = expand_numeric_labels(marker);
                if labels.is_empty() || !labels.iter().all(|label| valid_labels.contains(label)) {
                    continue;
                }
                let Some(local_start) = line_text[span_cursor..].find(marker) else {
                    continue;
                };
                let start = line_start + span_cursor + local_start;
                let end = start + marker.len();
                span_cursor += local_start + marker.len();
                let prefix = text[..start].trim_end();
                let preceding_word = prefix
                    .split(|character: char| !character.is_alphabetic())
                    .next_back()
                    .unwrap_or_default();
                if preceding_word.chars().count() < 3 {
                    continue;
                }
                if note_ranges.contains(&(block_index, start, end)) {
                    continue;
                }
                output.push(Citation {
                    block_index,
                    start,
                    end,
                    text: marker.to_owned(),
                    style: "numeric_superscript".to_owned(),
                    bbox: span.bbox,
                    confidence: 0.72,
                    evidence: vec![
                        "reference_label_match".to_owned(),
                        "superscript_prose".to_owned(),
                    ],
                    link_target_page: None,
                    reference_labels: labels,
                    target_ids: Vec::new(),
                    external_urls: Vec::new(),
                });
            }
        }
        cursor = line_start + line_text.len();
    }
    output
}

fn numeric_citations(
    text: &str,
    valid_labels: &HashSet<String>,
) -> Vec<(usize, usize, String, Vec<String>)> {
    if valid_labels.is_empty() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let close = match bytes[index] {
            b'[' => b']',
            b'(' => b')',
            _ => {
                index += 1;
                continue;
            }
        };
        let Some(relative_end) = bytes[index + 1..].iter().position(|byte| *byte == close) else {
            index += 1;
            continue;
        };
        let end = index + 1 + relative_end + 1;
        let content = &text[index + 1..end - 1];
        if content.chars().all(|character| {
            character.is_ascii_digit()
                || character.is_whitespace()
                || matches!(character, ',' | ';' | '-' | '–' | '—')
        }) {
            let labels = expand_numeric_labels(content);
            let parenthetical_ok =
                bytes[index] != b'(' || plausible_parenthetical_citation(text, index, end, &labels);
            if !labels.is_empty()
                && labels.iter().all(|label| valid_labels.contains(label))
                && parenthetical_ok
            {
                output.push((
                    index,
                    end,
                    if bytes[index] == b'[' {
                        "numeric_bracket"
                    } else {
                        "numeric_parenthetical"
                    }
                    .to_owned(),
                    labels,
                ));
            }
        }
        index = end;
    }
    output
}

fn plausible_parenthetical_citation(
    text: &str,
    start: usize,
    end: usize,
    labels: &[String],
) -> bool {
    if start == 0 || text.trim() == &text[start..end] {
        return false;
    }
    let preceding = text[..start].chars().next_back();
    if preceding.is_some_and(|character| character.is_alphanumeric() || character == '_') {
        return false;
    }
    let context_start = text[..start]
        .char_indices()
        .rev()
        .nth(32)
        .map(|entry| entry.0)
        .unwrap_or(0);
    let context = text[context_start..start].to_lowercase();
    if [
        "equation",
        "equations",
        "eq.",
        "figure",
        "fig.",
        "table",
        "section",
        "algorithm",
        "appendix",
        "line ",
    ]
    .iter()
    .any(|cue| context.contains(cue))
    {
        return false;
    }
    let unique: HashSet<_> = labels.iter().collect();
    unique.len() == labels.len()
}

fn expand_numeric_labels(content: &str) -> Vec<String> {
    let normalized = content.replace(['–', '—'], "-");
    let mut labels = Vec::new();
    for part in normalized.split([',', ';']) {
        let part = part.trim();
        if let Some((first, last)) = part.split_once('-') {
            let (Ok(first), Ok(last)) =
                (first.trim().parse::<usize>(), last.trim().parse::<usize>())
            else {
                return Vec::new();
            };
            if last < first || last - first > 100 {
                return Vec::new();
            }
            labels.extend((first..=last).map(|value| value.to_string()));
        } else if let Ok(value) = part.parse::<usize>() {
            labels.push(value.to_string());
        } else {
            return Vec::new();
        }
    }
    labels
}

fn author_year_citations(
    text: &str,
    references: &[(Option<String>, String)],
) -> Vec<(usize, usize, Vec<String>)> {
    let mut output = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'(' {
            index += 1;
            continue;
        }
        let Some(close_index) = matching_closing_parenthesis(bytes, index) else {
            break;
        };
        let end = close_index + 1;
        let content = &text[index + 1..end - 1];
        let years = four_digit_years(content);
        let has_author = !likely_surnames(content).is_empty();
        let narrative_author = (!has_author)
            .then(|| preceding_surname(text, index))
            .flatten();
        if !years.is_empty() && (has_author || narrative_author.is_some()) {
            let haystack = narrative_author.as_deref().unwrap_or(content);
            let match_text = format!("{haystack} {}", years.join(" "));
            if let Some(labels) = bibliography_match_labels(&match_text, references) {
                let start = narrative_author
                    .as_ref()
                    .and_then(|author| text[..index].rfind(author))
                    .unwrap_or(index);
                output.push((start, end, labels));
            }
        }
        index = end;
    }
    output
}

fn matching_closing_parenthesis(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, byte) in bytes.iter().enumerate().skip(open) {
        match byte {
            b'(' => depth += 1,
            b')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn bibliography_match_labels(
    citation_text: &str,
    references: &[(Option<String>, String)],
) -> Option<Vec<String>> {
    let years = four_digit_years(citation_text);
    let surnames = likely_surnames(citation_text);
    if years.is_empty() || surnames.is_empty() {
        return None;
    }
    let matches: Vec<_> = references
        .iter()
        .filter(|(_, reference)| reference_matches_author_year(reference, &years, &surnames))
        .collect();
    (!matches.is_empty()).then(|| {
        matches
            .into_iter()
            .filter_map(|reference| reference.0.clone())
            .collect()
    })
}

fn reference_matches_author_year(reference: &str, years: &[String], surnames: &[String]) -> bool {
    if !years.iter().any(|year| reference.contains(year)) {
        return false;
    }
    let reference_tokens: Vec<String> = reference
        .split(|character: char| !character.is_alphanumeric())
        .map(normalize_name_token)
        .filter(|token| token.chars().count() >= 2)
        .collect();
    surnames.iter().any(|surname| {
        let surname = normalize_name_token(surname);
        reference_tokens
            .iter()
            .any(|token| fuzzy_name_match(&surname, token))
    })
}

fn normalize_name_token(token: &str) -> String {
    token
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn fuzzy_name_match(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left_len = left.chars().count();
    let right_len = right.chars().count();
    if left_len < 5 || right_len < 5 || left_len.abs_diff(right_len) > 1 {
        return false;
    }
    levenshtein_distance(left, right) <= 1
}

fn levenshtein_distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (left_index, left_character) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_character) in right.iter().enumerate() {
            current.push(
                (previous[right_index + 1] + 1)
                    .min(current[right_index] + 1)
                    .min(previous[right_index] + usize::from(left_character != *right_character)),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

fn four_digit_years(text: &str) -> Vec<String> {
    text.as_bytes()
        .windows(4)
        .enumerate()
        .filter_map(|(index, window)| {
            let left_boundary = index == 0 || !text.as_bytes()[index - 1].is_ascii_alphanumeric();
            let right_boundary = index + 4 == text.len()
                || !text.as_bytes()[index + 4].is_ascii_alphanumeric()
                || (matches!(text.as_bytes()[index + 4], b'a' | b'b')
                    && (index + 5 == text.len()
                        || !text.as_bytes()[index + 5].is_ascii_alphanumeric()));
            (window.iter().all(u8::is_ascii_digit) && left_boundary && right_boundary)
                .then(|| &text[index..index + 4])
                .filter(|year| matches!(&year[..2], "18" | "19" | "20"))
                .map(str::to_owned)
        })
        .collect()
}

fn preceding_surname(text: &str, open: usize) -> Option<String> {
    let prefix = text[..open].trim_end();
    prefix
        .split_whitespace()
        .rev()
        .take(6)
        .map(|word| {
            word.trim_matches(|character: char| !character.is_alphabetic() && character != '-')
        })
        .find(|word| {
            word.chars().next().is_some_and(char::is_uppercase)
                && word.chars().count() >= 2
                && !matches!(*word, "Al" | "Et" | "And" | "See" | "Cf")
        })
        .map(str::to_owned)
}

fn likely_surnames(text: &str) -> Vec<String> {
    text.split(|character: char| character.is_whitespace() || matches!(character, ',' | ';' | '&'))
        .map(|word| {
            word.trim_matches(|character: char| !character.is_alphabetic() && character != '-')
        })
        .filter(|word| {
            word.len() >= 2
                && word.chars().next().is_some_and(char::is_uppercase)
                && !matches!(
                    *word,
                    "The"
                        | "See"
                        | "Cf"
                        | "Grant"
                        | "No"
                        | "Equation"
                        | "Figure"
                        | "Table"
                        | "Section"
                        | "Appendix"
                        | "Algorithm"
                )
        })
        .map(str::to_owned)
        .collect()
}

fn text_range_bbox(
    block_bbox: BBox,
    block_text: &str,
    lines: &[TextLine],
    start: usize,
    end: usize,
) -> BBox {
    let mut cursor = 0;
    let mut result = None;
    for line in lines {
        let line_text = line.text.trim();
        let Some(local) = block_text[cursor..].find(line_text) else {
            continue;
        };
        let line_start = cursor + local;
        let line_end = line_start + line_text.len();
        let overlap_start = start.max(line_start);
        let overlap_end = end.min(line_end);
        if overlap_start < overlap_end {
            let length = line_text.len().max(1) as f32;
            let x = line.bbox.x + line.bbox.width * (overlap_start - line_start) as f32 / length;
            let right = line.bbox.x + line.bbox.width * (overlap_end - line_start) as f32 / length;
            let bbox = BBox {
                x,
                y: line.bbox.y,
                width: (right - x).max(1.0),
                height: line.bbox.height,
            };
            result = Some(result.map_or(bbox, |current: BBox| current.union(bbox)));
        }
        cursor = line_end;
    }
    result.unwrap_or_else(|| {
        let length = block_text.len().max(1) as f32;
        BBox {
            x: block_bbox.x + block_bbox.width * start as f32 / length,
            y: block_bbox.y,
            width: (block_bbox.width * (end - start) as f32 / length).max(1.0),
            height: block_bbox.height,
        }
    })
}

fn textual_parts(block: &Block) -> Option<(BBox, &str, &[TextLine])> {
    match block {
        Block::Paragraph {
            bbox, text, lines, ..
        }
        | Block::Heading {
            bbox, text, lines, ..
        }
        | Block::Equation {
            bbox, text, lines, ..
        }
        | Block::List {
            bbox, text, lines, ..
        } => Some((*bbox, text, lines)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Span;

    fn line(text: &str, y: f32, size: f32) -> TextLine {
        TextLine {
            text: text.to_owned(),
            bbox: BBox {
                x: 50.0,
                y,
                width: 300.0,
                height: size,
            },
            font_size: size,
            font_weight: 400,
            spans: Vec::new(),
        }
    }

    fn paragraph(text: &str, y: f32, size: f32) -> Block {
        let line = line(text, y, size);
        Block::Paragraph {
            bbox: line.bbox,
            text: text.to_owned(),
            lines: vec![line],
        }
    }

    #[test]
    fn expands_numeric_ranges_and_rejects_equation_numbers() {
        let valid = (1..=8).map(|value| value.to_string()).collect();
        let citations = numeric_citations(
            "Prior work [1, 3-5], later confirmed (6), but Equation (3).",
            &valid,
        );
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0].3, ["1", "3", "4", "5"]);
        assert_eq!(citations[1].3, ["6"]);
        assert!(numeric_citations("(3)", &valid).is_empty());
    }

    #[test]
    fn recognizes_resolved_author_year_forms() {
        let references = vec![(
            None,
            "Smith, J. and Jones, A. A useful paper. 2020a.".to_owned(),
        )];
        let citations = author_year_citations(
            "This follows Smith (2020a) and earlier work (Smyth & Jones, 2020a).",
            &references,
        );
        assert_eq!(citations.len(), 2);
    }

    #[test]
    fn parses_common_note_markers() {
        assert_eq!(leading_note_marker("12. Note text"), Some(("12".into(), 3)));
        assert_eq!(
            leading_note_marker("† Editorial note"),
            Some(("†".into(), 3))
        );
        assert_eq!(leading_note_marker("2014. Not a note"), None);
    }

    #[test]
    fn recognizes_an_endnote_section_near_the_document_end() {
        let mut pages = vec![Page {
            number: 1,
            width: 612.0,
            height: 792.0,
            blocks: vec![
                Block::Heading {
                    bbox: BBox {
                        x: 50.0,
                        y: 300.0,
                        width: 100.0,
                        height: 16.0,
                    },
                    text: "Notes".to_owned(),
                    level: 1,
                    lines: vec![line("Notes", 300.0, 16.0)],
                },
                paragraph("1. First note.", 330.0, 9.0),
                paragraph("2) Second note.", 350.0, 9.0),
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
        }];
        recognize_endnotes(&mut pages);
        assert!(matches!(
            &pages[0].blocks[0],
            Block::EndnoteList { items, .. }
                if items.len() == 2 && items[0].id == "en-1" && items[1].text == "Second note."
        ));
    }

    #[test]
    fn does_not_detect_citations_without_a_reference_list() {
        let mut pages = vec![Page {
            number: 1,
            width: 612.0,
            height: 792.0,
            blocks: vec![paragraph("A claim [1].", 100.0, 10.0)],
            citations: Vec::new(),
            note_references: Vec::new(),
            sentences: Vec::new(),
            semantic_regions: Vec::new(),
            internal_links: Vec::new(),
            marked_objects: Vec::new(),
            images: Vec::new(),
            lines: Vec::new(),
            rules: Vec::new(),
        }];
        recognize_citations(&mut pages);
        assert!(pages[0].citations.is_empty());
    }

    #[test]
    fn recognizes_superscript_numeric_citations_in_prose() {
        let mut source = line("Prior work1 established this useful result.", 100.0, 10.0);
        source.spans = vec![
            Span {
                text: "Prior work".to_owned(),
                bbox: BBox {
                    x: 50.0,
                    y: 100.0,
                    width: 50.0,
                    height: 10.0,
                },
                font_size: 10.0,
                font_weight: 400,
                font_name: "Body".to_owned(),
                rotation: 0.0,
            },
            Span {
                text: "1".to_owned(),
                bbox: BBox {
                    x: 100.0,
                    y: 98.0,
                    width: 4.0,
                    height: 6.0,
                },
                font_size: 6.0,
                font_weight: 400,
                font_name: "Body".to_owned(),
                rotation: 0.0,
            },
        ];
        let valid = HashSet::from(["1".to_owned()]);
        let citations = superscript_numeric_citations(
            0,
            &source.text,
            &[source.clone()],
            &valid,
            &HashSet::new(),
        );
        assert_eq!(citations.len(), 1);
        assert_eq!(citations[0].style, "numeric_superscript");
        assert_eq!(citations[0].reference_labels, ["1"]);
    }
}
