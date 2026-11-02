use std::ops::Range;

use crate::model::{BBox, Block, Page, Sentence, TextLine};

#[derive(Clone, Copy, Debug)]
struct MappedChar {
    output_start: usize,
    output_end: usize,
    line: usize,
    line_char: usize,
}

pub(crate) fn recognize_sentences(pages: &mut [Page]) {
    for page in pages {
        let mut sentences = Vec::new();
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Block::Paragraph { text, lines, bbox } = block else {
                continue;
            };
            for range in sentence_ranges(text) {
                if !plausible_sentence(&text[range.clone()]) {
                    continue;
                }
                let rects = sentence_rects(text, lines, range.clone());
                let rects = if rects.is_empty() { vec![*bbox] } else { rects };
                let sentence_bbox = rects.iter().copied().reduce(BBox::union).unwrap_or(*bbox);
                sentences.push(Sentence {
                    block_index,
                    start: range.start,
                    end: range.end,
                    text: text[range].to_owned(),
                    bbox: sentence_bbox,
                    rects,
                });
            }
        }
        page.sentences = sentences;
    }
}

fn plausible_sentence(text: &str) -> bool {
    if text.contains('@') {
        return false;
    }
    let words = text
        .split_whitespace()
        .filter(|word| word.chars().any(char::is_alphabetic))
        .count();
    let alphabetic = text
        .chars()
        .filter(|character| character.is_alphabetic())
        .count();
    let visible = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .count();
    let terminal = text
        .trim_end_matches(['”', '’', '"', '\'', ')', ']', '}'])
        .ends_with(['.', '!', '?']);
    alphabetic >= 5
        && visible > 0
        && alphabetic * 100 / visible >= 45
        && if terminal { words >= 2 } else { words >= 4 }
}

fn sentence_ranges(text: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = text
        .char_indices()
        .find(|(_, character)| !character.is_whitespace())
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut index = 0;
    while index < chars.len() {
        let (byte, character) = chars[index];
        if matches!(character, '.' | '!' | '?') && is_sentence_terminal(text, &chars, index) {
            let mut end_index = index + 1;
            while end_index < chars.len()
                && matches!(
                    chars[end_index].1,
                    '.' | '!' | '?' | '”' | '’' | '"' | '\'' | ')' | ']' | '}'
                )
            {
                end_index += 1;
            }
            let end = chars
                .get(end_index)
                .map(|item| item.0)
                .unwrap_or(text.len());
            if start < end {
                ranges.push(start..end);
            }
            start = chars[end_index..]
                .iter()
                .find(|(_, next)| !next.is_whitespace())
                .map(|(offset, _)| *offset)
                .unwrap_or(text.len());
            index = end_index;
            continue;
        }
        let _ = byte;
        index += 1;
    }
    if start < text.len() {
        let end = text.trim_end().len();
        if start < end {
            ranges.push(start..end);
        }
    }
    ranges
}

fn is_sentence_terminal(text: &str, chars: &[(usize, char)], index: usize) -> bool {
    let (byte, character) = chars[index];
    let previous = index
        .checked_sub(1)
        .and_then(|offset| chars.get(offset))
        .map(|item| item.1);
    let next = chars.get(index + 1).map(|item| item.1);
    if character == '.'
        && previous.is_some_and(|value| value.is_ascii_digit())
        && next.is_some_and(|value| value.is_ascii_digit())
    {
        return false;
    }
    if character == '.' && period_belongs_to_abbreviation(&text[..byte]) {
        return false;
    }
    let mut lookahead = index + 1;
    while chars.get(lookahead).is_some_and(|(_, value)| {
        matches!(
            value,
            '.' | '!' | '?' | '”' | '’' | '"' | '\'' | ')' | ']' | '}'
        )
    }) {
        lookahead += 1;
    }
    chars
        .get(lookahead)
        .is_none_or(|(_, value)| value.is_whitespace())
}

fn period_belongs_to_abbreviation(prefix: &str) -> bool {
    let token = prefix
        .split_whitespace()
        .next_back()
        .unwrap_or("")
        .trim_matches(|character: char| !character.is_alphanumeric() && character != '.');
    let normalized = token.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "mr" | "mrs"
            | "ms"
            | "dr"
            | "prof"
            | "fig"
            | "eq"
            | "sec"
            | "vs"
            | "etc"
            | "al"
            | "e.g"
            | "i.e"
    ) {
        return true;
    }
    token.len() == 1 && token.chars().all(char::is_alphabetic)
}

fn sentence_rects(text: &str, lines: &[TextLine], range: Range<usize>) -> Vec<BBox> {
    let (rebuilt, mapped) = rebuild_with_mapping(lines);
    if rebuilt != text {
        return fallback_sentence_rects(&text[range], lines);
    }
    let mut per_line = Vec::<(usize, usize, usize)>::new();
    for mapped_char in mapped
        .iter()
        .filter(|item| item.output_end > range.start && item.output_start < range.end)
    {
        if let Some((_, start, end)) = per_line
            .last_mut()
            .filter(|item| item.0 == mapped_char.line)
        {
            *start = (*start).min(mapped_char.line_char);
            *end = (*end).max(mapped_char.line_char + 1);
        } else {
            per_line.push((
                mapped_char.line,
                mapped_char.line_char,
                mapped_char.line_char + 1,
            ));
        }
    }
    per_line
        .into_iter()
        .filter_map(|(line_index, start, end)| line_slice_bbox(&lines[line_index], start, end))
        .collect()
}

fn rebuild_with_mapping(lines: &[TextLine]) -> (String, Vec<MappedChar>) {
    let mut output = String::new();
    let mut mapped = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        let trimmed = line.text.trim();
        if output.ends_with('-') && trimmed.chars().next().is_some_and(char::is_lowercase) {
            output.pop();
            mapped.pop();
        } else if !output.is_empty() {
            output.push(' ');
        }
        let leading_chars = line
            .text
            .chars()
            .take_while(|value| value.is_whitespace())
            .count();
        for (offset, character) in trimmed.chars().enumerate() {
            let output_start = output.len();
            output.push(character);
            mapped.push(MappedChar {
                output_start,
                output_end: output.len(),
                line: line_index,
                line_char: leading_chars + offset,
            });
        }
    }
    (output, mapped)
}

fn line_slice_bbox(line: &TextLine, start: usize, end: usize) -> Option<BBox> {
    let length = line.text.chars().count();
    if length == 0 || start >= end || start >= length {
        return None;
    }
    let start = start.min(length) as f32 / length as f32;
    let end = end.min(length) as f32 / length as f32;
    Some(BBox {
        x: line.bbox.x + line.bbox.width * start,
        y: line.bbox.y,
        width: line.bbox.width * (end - start),
        height: line.bbox.height,
    })
}

fn fallback_sentence_rects(sentence: &str, lines: &[TextLine]) -> Vec<BBox> {
    let words: Vec<String> = sentence
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| !character.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|word| word.len() >= 3)
        .collect();
    lines
        .iter()
        .filter(|line| {
            let lower = line.text.to_lowercase();
            words.iter().any(|word| lower.contains(word))
        })
        .map(|line| line.bbox)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Span;

    fn line(text: &str, y: f32) -> TextLine {
        let bbox = BBox {
            x: 50.0,
            y,
            width: text.chars().count() as f32 * 5.0,
            height: 10.0,
        };
        TextLine {
            text: text.into(),
            bbox,
            font_size: 10.0,
            font_weight: 400,
            spans: vec![Span {
                text: text.into(),
                bbox,
                font_size: 10.0,
                font_weight: 400,
                font_name: "Test".into(),
                rotation: 0.0,
            }],
        }
    }

    #[test]
    fn segments_prose_without_splitting_abbreviations_or_decimals() {
        let text = "Dr. Smith measured 3.14 units. It worked! A final fragment";
        let sentences: Vec<&str> = sentence_ranges(text)
            .into_iter()
            .map(|range| &text[range])
            .collect();
        assert_eq!(
            sentences,
            [
                "Dr. Smith measured 3.14 units.",
                "It worked!",
                "A final fragment"
            ]
        );
    }

    #[test]
    fn wrapped_sentence_keeps_one_rectangle_per_line() {
        let lines = vec![
            line("The sentence starts on this line", 20.0),
            line("and finishes here. Next one.", 32.0),
        ];
        let text = "The sentence starts on this line and finishes here. Next one.";
        let ranges = sentence_ranges(text);
        let first = sentence_rects(text, &lines, ranges[0].clone());
        let second = sentence_rects(text, &lines, ranges[1].clone());
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].y, 20.0);
        assert_eq!(first[1].y, 32.0);
        assert_eq!(second.len(), 1);
        assert!(second[0].x > 50.0);
    }

    #[test]
    fn dehyphenated_line_join_preserves_both_sentence_rectangles() {
        let lines = vec![
            line("A multi-", 20.0),
            line("line sentence ends here.", 32.0),
        ];
        let text = "A multiline sentence ends here.";
        let rects = sentence_rects(text, &lines, 0..text.len());
        assert_eq!(rects.len(), 2);
    }

    #[test]
    fn page_sentences_follow_column_aware_block_reading_order() {
        let left_lines = vec![line("Left first. Left second.", 40.0)];
        let mut right_line = line("Right first. Right second.", 40.0);
        right_line.bbox.x = 330.0;
        let blocks = vec![
            Block::Paragraph {
                bbox: left_lines[0].bbox,
                text: left_lines[0].text.clone(),
                lines: left_lines,
            },
            Block::Paragraph {
                bbox: right_line.bbox,
                text: right_line.text.clone(),
                lines: vec![right_line],
            },
        ];
        let mut pages = vec![Page {
            number: 1,
            width: 612.0,
            height: 792.0,
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
        }];
        recognize_sentences(&mut pages);
        assert_eq!(
            pages[0]
                .sentences
                .iter()
                .map(|sentence| (sentence.block_index, sentence.text.as_str()))
                .collect::<Vec<_>>(),
            [
                (0, "Left first."),
                (0, "Left second."),
                (1, "Right first."),
                (1, "Right second."),
            ]
        );
        assert!(pages[0].sentences[1].bbox.x < pages[0].sentences[2].bbox.x);
    }
}
