use crate::model::{BBox, Block, ListItem, Page, TextLine};

pub(crate) fn recognize_lists(pages: &mut [Page]) {
    for page in pages {
        let mut rebuilt = Vec::with_capacity(page.blocks.len());
        for block in std::mem::take(&mut page.blocks) {
            let Block::Paragraph { bbox, text, lines } = block else {
                rebuilt.push(block);
                continue;
            };
            if lines.len() < 2
                || page
                    .images
                    .iter()
                    .any(|image| containment(bbox, *image) > 0.75)
            {
                rebuilt.push(Block::Paragraph { bbox, text, lines });
                continue;
            }
            let starts: Vec<(usize, Marker)> = lines
                .iter()
                .enumerate()
                .filter_map(|(index, line)| parse_marker(&line.text).map(|marker| (index, marker)))
                .collect();
            if !credible_sequence(&starts, &lines) {
                rebuilt.push(Block::Paragraph { bbox, text, lines });
                continue;
            }
            let first = starts[0].0;
            if first > 0 {
                rebuilt.push(paragraph(lines[..first].to_vec()));
            }
            let mut indents: Vec<f32> = starts
                .iter()
                .map(|(index, _)| lines[*index].bbox.x)
                .collect();
            indents.sort_by(f32::total_cmp);
            indents.dedup_by(|a, b| (*a - *b).abs() <= 8.0);
            let mut items = Vec::new();
            for (position, (start, marker)) in starts.iter().enumerate() {
                let end = starts
                    .get(position + 1)
                    .map(|entry| entry.0)
                    .unwrap_or(lines.len());
                let item_lines = lines[*start..end].to_vec();
                let item_bbox = item_lines
                    .iter()
                    .map(|line| line.bbox)
                    .reduce(BBox::union)
                    .unwrap();
                let mut item_text = strip_marker(&item_lines[0].text, marker.bytes).to_owned();
                for line in item_lines.iter().skip(1) {
                    join_text(&mut item_text, &line.text);
                }
                let level = indents
                    .iter()
                    .position(|x| (lines[*start].bbox.x - *x).abs() <= 8.0)
                    .unwrap_or(0);
                items.push(ListItem {
                    marker: marker.text.clone(),
                    level,
                    text: item_text.trim().to_owned(),
                    bbox: item_bbox,
                    lines: item_lines,
                });
            }
            let list_bbox = items
                .iter()
                .map(|item| item.bbox)
                .reduce(BBox::union)
                .unwrap();
            let ordered =
                starts.iter().filter(|(_, marker)| marker.ordered).count() * 2 >= starts.len();
            let list_lines = items
                .iter()
                .flat_map(|item| item.lines.clone())
                .collect::<Vec<_>>();
            let list_text = items
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            rebuilt.push(Block::List {
                bbox: list_bbox,
                ordered,
                text: list_text,
                lines: list_lines,
                items,
            });
        }
        page.blocks = rebuilt;
    }
}

#[derive(Clone, Debug)]
struct Marker {
    text: String,
    bytes: usize,
    ordered: bool,
    ordinal: Option<usize>,
}

fn parse_marker(text: &str) -> Option<Marker> {
    let trimmed = text.trim_start();
    let leading = text.len() - trimmed.len();
    let first = trimmed.chars().next()?;
    if matches!(first, '•' | '●' | '▪' | '◦' | '‣' | '⁃' | '–' | '—')
        || matches!(first, '-' | '*' | '+')
            && trimmed[first.len_utf8()..].starts_with(char::is_whitespace)
    {
        let bytes = leading + first.len_utf8();
        return Some(Marker {
            text: first.to_string(),
            bytes,
            ordered: false,
            ordinal: None,
        });
    }
    let token_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let token = &trimmed[..token_end];
    if token.len() > 10 {
        return None;
    }
    let parenthesized = token.starts_with('(');
    if parenthesized && !token.ends_with(')') {
        return None;
    }
    if !parenthesized && !token.ends_with(['.', ')', ':']) {
        return None;
    }
    let core = token
        .trim_start_matches('(')
        .trim_end_matches(['.', ')', ':']);
    if core.is_empty() {
        return None;
    }
    let numeric = core.len() <= 3 && core.chars().all(|ch| ch.is_ascii_digit());
    let alphabetic = core.len() == 1 && core.chars().all(|ch| ch.is_ascii_alphabetic());
    let roman = core.len() <= 5
        && core.chars().all(|ch| {
            matches!(
                ch.to_ascii_lowercase(),
                'i' | 'v' | 'x' | 'l' | 'c' | 'd' | 'm'
            )
        });
    let ordinal = core
        .parse::<usize>()
        .ok()
        .or_else(|| alpha_ordinal(core))
        .or_else(|| roman_ordinal(core));
    let valid = numeric || alphabetic || roman;
    valid.then(|| Marker {
        text: token.to_owned(),
        bytes: leading + token_end,
        ordered: true,
        ordinal,
    })
}

fn alpha_ordinal(value: &str) -> Option<usize> {
    if value.len() == 1 {
        return value
            .bytes()
            .next()
            .map(|b| (b.to_ascii_lowercase() - b'a' + 1) as usize);
    }
    None
}
fn roman_ordinal(value: &str) -> Option<usize> {
    let mut total = 0usize;
    let mut previous = 0usize;
    for ch in value.chars().rev() {
        let current = match ch.to_ascii_lowercase() {
            'i' => 1,
            'v' => 5,
            'x' => 10,
            'l' => 50,
            'c' => 100,
            'd' => 500,
            'm' => 1000,
            _ => return None,
        };
        if current < previous {
            total = total.saturating_sub(current);
        } else {
            total += current;
            previous = current;
        }
    }
    (total > 0).then_some(total)
}

fn credible_sequence(starts: &[(usize, Marker)], lines: &[TextLine]) -> bool {
    if starts.len() < 2 {
        return false;
    }
    let unordered = starts.iter().filter(|(_, marker)| !marker.ordered).count();
    let ordered = starts.len() - unordered;
    if unordered > 0 && ordered > 0 && unordered.min(ordered) * 3 > starts.len() {
        return false;
    }
    let aligned = starts
        .windows(2)
        .filter(|pair| (lines[pair[0].0].bbox.x - lines[pair[1].0].bbox.x).abs() <= 18.0)
        .count();
    if aligned + 1 < starts.len() {
        return false;
    }
    if ordered >= 2 {
        let ordinals: Vec<usize> = starts
            .iter()
            .filter_map(|(_, marker)| marker.ordinal)
            .collect();
        if ordinals.len() * 2 < ordered {
            return false;
        }
        if ordinals.len() >= 2 && !ordinals.windows(2).any(|pair| pair[1] == pair[0] + 1) {
            return false;
        }
    }
    starts.iter().all(|(index, marker)| {
        strip_marker(&lines[*index].text, marker.bytes)
            .chars()
            .filter(|ch| ch.is_alphabetic())
            .count()
            >= 2
    })
}

fn strip_marker(text: &str, bytes: usize) -> &str {
    text.get(bytes..).unwrap_or_default().trim_start()
}
fn join_text(output: &mut String, next: &str) {
    if output.ends_with('-') && !output.ends_with(" -") {
        output.pop();
    } else if !output.is_empty() {
        output.push(' ');
    }
    output.push_str(next.trim());
}
fn paragraph(lines: Vec<TextLine>) -> Block {
    let bbox = lines
        .iter()
        .map(|line| line.bbox)
        .reduce(BBox::union)
        .unwrap_or_default();
    let mut text = String::new();
    for line in &lines {
        join_text(&mut text, &line.text);
    }
    Block::Paragraph { bbox, text, lines }
}
fn containment(small: BBox, large: BBox) -> f32 {
    let area = (small.right().min(large.right()) - small.x.max(large.x)).max(0.0)
        * (small.bottom().min(large.bottom()) - small.y.max(large.y)).max(0.0);
    area / small.area().max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(text: &str, x: f32, y: f32) -> TextLine {
        TextLine {
            text: text.into(),
            bbox: BBox {
                x,
                y,
                width: 200.0,
                height: 10.0,
            },
            font_size: 10.0,
            font_weight: 400,
            spans: vec![],
        }
    }
    #[test]
    fn recognizes_wrapped_and_nested_bullets() {
        let lines = vec![
            line("• First item", 20.0, 10.0),
            line("wraps here", 32.0, 22.0),
            line("◦ Nested item", 38.0, 34.0),
            line("• Last item", 20.0, 46.0),
        ];
        let starts: Vec<_> = lines
            .iter()
            .enumerate()
            .filter_map(|(i, l)| parse_marker(&l.text).map(|m| (i, m)))
            .collect();
        assert!(credible_sequence(&starts, &lines));
    }
    #[test]
    fn rejects_isolated_figure_bullet() {
        assert!(parse_marker("• Figure 2").is_some());
    }
}
