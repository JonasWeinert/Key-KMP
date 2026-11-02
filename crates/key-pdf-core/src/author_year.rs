//! Author–year citations, such as "(Smith et al., 2020; Lee 2019a)" or "Smith and Jones
//! (2020)", and the unnumbered reference lists they point into. Citations are matched to
//! entries by the first author's surname and the year, so a parenthesis that merely holds a
//! year never becomes a citation unless the reference list has a matching entry.

use crate::model::{TextBounds, TextLayer};
use crate::search::text_runs_for_range;

const MAX_PARENTHETICAL_CHARACTERS: usize = 260;
const MAX_ENTRY_AUTHOR_CHARACTERS: usize = 220;
const MAX_NARRATIVE_LOOKBACK: usize = 80;

/// Who and when: the first author's surname (its last word, lowercased), the second
/// author's when given, and the year with any letter suffix ("2020a").
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthorYear {
    pub first: String,
    pub second: Option<String>,
    pub year: String,
}

impl AuthorYear {
    /// Whether a citation names this reference. "2020" also matches "2020a" when the list
    /// only has lettered years.
    pub fn cites(&self, reference: &AuthorYear) -> bool {
        self.first == reference.first
            && (self.year == reference.year
                || (self.year.len() == 4 && reference.year.starts_with(&self.year)))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AuthorYearCandidate {
    pub page: usize,
    pub start: usize,
    pub end: usize,
    pub bounds: TextBounds,
    pub source: String,
    pub keys: Vec<AuthorYear>,
}

#[derive(Clone, Debug)]
pub(crate) struct UnnumberedEntry {
    pub page: usize,
    pub x_fraction: Option<f32>,
    pub y_fraction: Option<f32>,
    pub text: String,
    pub text_runs: Vec<TextBounds>,
}

/// The author and year of a reference entry, read from its start ("Smith, J., & Lee, K.
/// (2020). Title…" or "Smith J, Lee K. 2020. Title…").
pub(crate) fn entry_key(text: &str) -> Option<AuthorYear> {
    let chars = text.chars().collect::<Vec<_>>();
    let (year_start, _, year) = years(&chars)
        .into_iter()
        .find(|(start, _, _)| *start <= MAX_ENTRY_AUTHOR_CHARACTERS)?;
    let authors = chars[..year_start].iter().collect::<String>();
    let authors = authors.split('(').next().unwrap_or_default();
    let mut surnames = author_pieces(authors).into_iter().filter_map(|piece| surname(&piece));
    Some(AuthorYear { first: surnames.next()?, second: surnames.next(), year })
}

/// Reference entries without numbers, from `start` on the page: each entry begins on a
/// line that starts like an author list and is outdented or follows a finished entry.
/// Lines that don't begin a recognisable entry stay with the one above.
pub(crate) fn unnumbered_reference_entries(page: usize, text: &TextLayer, start: usize) -> Vec<UnnumberedEntry> {
    let lines = lines(text, start, text.len());
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let previous = index.checked_sub(1).map(|i| &lines[i]);
        let begins = looks_like_entry_start(&line.text)
            && previous.is_none_or(|previous| {
                let shift = line.left - previous.left;
                if shift.abs() > 0.2 {
                    true
                } else if shift > 0.008 {
                    false
                } else if shift < -0.008 {
                    true
                } else {
                    previous.text.ends_with(['.', ')', '/']) || previous.text.ends_with(|c: char| c.is_ascii_digit())
                }
            });
        match groups.last_mut() {
            Some(group) if !begins => group.1 = line.end,
            _ => groups.push((line.start, line.end)),
        }
    }
    // A split that left a piece without an author and year was a continuation after all.
    let mut entries: Vec<(usize, usize, String)> = Vec::new();
    for (first, last) in groups {
        let entry_text = collapse(text, first, last);
        match entries.last_mut() {
            Some(previous) if entry_key(&entry_text).is_none() => {
                previous.1 = last;
                previous.2 = collapse(text, previous.0, last);
            }
            _ => entries.push((first, last, entry_text)),
        }
    }
    entries
        .into_iter()
        .filter(|(_, _, entry_text)| entry_key(entry_text).is_some() && entry_text.chars().filter(|c| c.is_alphabetic()).count() >= 12)
        .map(|(first, last, entry_text)| {
            let bounds = text[first..=last].iter().find_map(|character| character.bounds);
            UnnumberedEntry {
                page,
                x_fraction: bounds.map(|b| (b.left + b.right) * 0.5),
                y_fraction: bounds.map(|b| b.top),
                text: entry_text,
                text_runs: text_runs_for_range(text.as_slice(), first, last),
            }
        })
        .collect()
}

/// Author–year citations in `start..end`. A parenthesis with several citations gives one
/// candidate per citation, and a citation that wraps gives one per line.
pub(crate) fn author_year_citations(page: usize, text: &TextLayer, start: usize, end: usize) -> Vec<AuthorYearCandidate> {
    let end = end.min(text.len());
    let chars = text[..end].iter().map(|c| if c.value == '\n' || c.value == '\r' { ' ' } else { c.value }).collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut index = start.min(end);
    while index < end {
        let closer = match chars[index] {
            '(' => ')',
            '[' => ']',
            _ => {
                index += 1;
                continue;
            }
        };
        let open = index;
        let Some(close) = (open + 1..end.min(open + MAX_PARENTHETICAL_CHARACTERS))
            .take_while(|&i| chars[i] != chars[open])
            .find(|&i| chars[i] == closer)
        else {
            index += 1;
            continue;
        };
        index = close + 1;
        if years(&chars[open + 1..close]).is_empty() {
            continue;
        }
        let mut part_start = open + 1;
        for part_end in (open + 1..=close).filter(|&i| i == close || chars[i] == ';') {
            let part = &chars[part_start..part_end];
            let offset = part_start;
            part_start = part_end + 1;
            let found = years(part);
            let Some(&(first_year, _, _)) = found.first() else { continue };
            let raw = part[..first_year].iter().collect::<String>();
            let phrase = name_run(&strip_lead_ins(&raw)).to_owned();
            let year_end = offset + found.last().map_or(part.len(), |(_, end, _)| *end);
            let (authors, range) = if surname_of_phrase(&phrase).is_some() {
                let lead = raw.rfind(&phrase).map_or(0, |byte| raw[..byte].chars().count());
                (phrase, (offset + lead, year_end - 1))
            } else if offset == open + 1 && phrase.trim().is_empty() {
                // Narrative: "Smith et al. (2020)" names the authors before the parenthesis.
                let Some((phrase_start, phrase)) = narrative_authors(&chars, open, start) else { continue };
                (phrase, (phrase_start, close))
            } else {
                continue;
            };
            let pieces = author_pieces(&authors);
            let mut surnames = pieces.iter().filter_map(|piece| surname(piece));
            let Some(first) = surnames.next() else { continue };
            let second = surnames.next();
            let keys = found
                .into_iter()
                .map(|(_, _, year)| AuthorYear { first: first.clone(), second: second.clone(), year })
                .collect::<Vec<_>>();
            for (segment_start, segment_end, bounds) in line_segments(text, range.0, range.1) {
                result.push(AuthorYearCandidate {
                    page,
                    start: segment_start,
                    end: segment_end,
                    bounds,
                    source: collapse(text, segment_start, segment_end),
                    keys: keys.clone(),
                });
            }
        }
    }
    result
}

/// Years such as 2020 or 2020a: (start, end exclusive, year with suffix).
fn years(chars: &[char]) -> Vec<(usize, usize, String)> {
    let mut found = Vec::new();
    let mut index = 0;
    while index + 4 <= chars.len() {
        let digits = &chars[index..index + 4];
        let bounded_before = index == 0 || !chars[index - 1].is_alphanumeric();
        if bounded_before
            && digits.iter().all(char::is_ascii_digit)
            && matches!((digits[0], digits[1]), ('1', '9') | ('2', '0'))
            && chars.get(index + 4).is_none_or(|c| !c.is_ascii_digit())
        {
            let mut end = index + 4;
            let mut year = digits.iter().collect::<String>();
            if let Some(&suffix) = chars.get(end).filter(|c| c.is_ascii_lowercase())
                && chars.get(end + 1).is_none_or(|c| !c.is_alphabetic())
            {
                year.push(suffix);
                end += 1;
            }
            if chars.get(end).is_none_or(|c| !c.is_alphanumeric()) {
                found.push((index, end, year));
                index = end;
                continue;
            }
        }
        index += 1;
    }
    found
}

const LEAD_INS: [&str; 8] = ["see also", "see", "e.g.,", "e.g.", "cf.", "i.e.,", "i.e.", "for example,"];

fn strip_lead_ins(phrase: &str) -> String {
    let mut rest = phrase.trim();
    while let Some(lead) = LEAD_INS.iter().find(|lead| rest.to_lowercase().starts_with(*lead)) {
        rest = rest[lead.len()..].trim_start();
    }
    rest.to_owned()
}

/// The names a citation starts with: the run of capitalised words, initials and particles
/// that ends its first author, so "as argued in [see Lynch and Kaplan" starts at "Lynch".
fn name_run(phrase: &str) -> &str {
    let first_end = [phrase.find(','), phrase.find(" and "), phrase.find(" & ")].into_iter().flatten().min().unwrap_or(phrase.len());
    let piece = &phrase[..first_end];
    let mut words = Vec::new();
    let mut start = None;
    for (offset, c) in piece.char_indices().chain([(piece.len(), ' ')]) {
        let separator = c.is_whitespace() || matches!(c, '[' | '(');
        match (separator, start) {
            (true, Some(from)) => {
                words.push((from, &piece[from..offset]));
                start = None;
            }
            (false, None) => start = Some(offset),
            _ => {}
        }
    }
    let mut cut = piece.len();
    for (offset, word) in words.into_iter().rev() {
        let bare = word.trim_matches(|c: char| !c.is_alphanumeric());
        let name = bare.chars().next().is_some_and(char::is_uppercase)
            || matches!(bare, "van" | "von" | "der" | "den" | "de" | "da" | "di" | "du" | "le" | "la" | "et" | "al" | "of" | "for");
        if !name {
            break;
        }
        cut = offset;
    }
    // A run can't start with a joining word ("of Smith").
    let mut run = &phrase[cut..];
    while let Some(rest) = ["of ", "for ", "et ", "al. "].iter().find_map(|lead| run.strip_prefix(lead)) {
        run = rest;
    }
    run
}

/// Splits an author list into one piece per author: commas, "and" and "&" separate them.
fn author_pieces(authors: &str) -> Vec<String> {
    authors
        .replace(" & ", ",")
        .replace(" and ", ",")
        .split(',')
        .map(|piece| piece.trim().to_owned())
        .filter(|piece| !piece.is_empty())
        .collect()
}

fn surname_of_phrase(phrase: &str) -> Option<String> {
    author_pieces(phrase).first().and_then(|piece| surname(piece))
}

/// The last word of a surname, lowercased: initials, "et al." and particles are dropped.
fn surname(piece: &str) -> Option<String> {
    let words = piece
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|word| !word.is_empty())
        .filter(|word| !matches!(word.to_lowercase().as_str(), "et" | "al" | "and" | "in" | "press" | "the"))
        .filter(|word| !is_initials(word))
        .collect::<Vec<_>>();
    let word = *words.last()?;
    let first = word.chars().next()?;
    (first.is_uppercase() && word.chars().count() >= 2 && word.chars().all(|c| c.is_alphabetic() || matches!(c, '-' | '\'' | '’')))
        .then(|| word.to_lowercase())
}

/// "J", "JA", "J.-P." — at most three capitals, nothing else.
fn is_initials(word: &str) -> bool {
    let letters = word.chars().filter(|c| c.is_alphabetic()).collect::<Vec<_>>();
    !letters.is_empty() && letters.len() <= 3 && letters.iter().all(|c| c.is_uppercase())
}

/// The authors named just before a narrative citation's parenthesis: "Smith", "Smith et
/// al.", "Smith and Jones", "van der Berg".
fn narrative_authors(chars: &[char], open: usize, floor: usize) -> Option<(usize, String)> {
    let from = open.saturating_sub(MAX_NARRATIVE_LOOKBACK).max(floor);
    let before = &chars[from..open];
    let words = {
        let mut words = Vec::new();
        let mut index = before.len();
        while index > 0 {
            while index > 0 && before[index - 1].is_whitespace() {
                index -= 1;
            }
            let end = index;
            while index > 0 && !before[index - 1].is_whitespace() {
                index -= 1;
            }
            if end > index {
                words.push((from + index, before[index..end].iter().collect::<String>()));
            }
        }
        words
    };
    let mut taken = Vec::new();
    for (position, word) in words {
        let bare = word.trim_matches(|c: char| !c.is_alphanumeric());
        let joins = matches!(bare, "et" | "al" | "and" | "&" | "van" | "von" | "der" | "den" | "de" | "da" | "di" | "du" | "le" | "la") || word == "&";
        let name = bare.chars().next().is_some_and(char::is_uppercase) && !is_initials(bare) && word.ends_with(|c: char| c.is_alphabetic() || c == '.' || c == '\'' || c == '’');
        if !(joins || name) || (taken.is_empty() && !name && bare != "al") {
            break;
        }
        taken.push((position, word));
        if taken.len() > 8 {
            break;
        }
    }
    // Drop joining words left at the front ("and Smith" → "Smith").
    while taken.last().is_some_and(|(_, word)| matches!(word.trim_matches(|c: char| !c.is_alphanumeric() && c != '&'), "and" | "&" | "et" | "al")) {
        taken.pop();
    }
    let (phrase_start, _) = *taken.last()?;
    let phrase = taken.iter().rev().map(|(_, word)| word.as_str()).collect::<Vec<_>>().join(" ");
    surname_of_phrase(&phrase)?;
    Some((phrase_start, phrase))
}

fn looks_like_entry_start(line: &str) -> bool {
    let mut words = line.split_whitespace();
    let Some(first) = words.next() else { return false };
    let particle = matches!(first, "van" | "von" | "de" | "da" | "di" | "du" | "le" | "la" | "del" | "der");
    let initial = first.chars().next().is_some_and(char::is_uppercase);
    (initial || particle) && !first.starts_with(|c: char| c.is_ascii_digit()) && line.chars().take(60).any(|c| c == ',' || c == '.') && {
        let chars = line.chars().collect::<Vec<_>>();
        line.contains(',') || !years(&chars).is_empty()
    }
}

struct Line {
    start: usize,
    end: usize,
    left: f32,
    text: String,
}

fn lines(text: &TextLayer, start: usize, end: usize) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut line_start = start;
    for index in start..=end {
        if index == end || matches!(text[index].value, '\n' | '\r') {
            if let Some(first) = (line_start..index).find(|&i| !text[i].value.is_whitespace()) {
                let last = (first..index).rev().find(|&i| !text[i].value.is_whitespace()).unwrap_or(first);
                if let Some(left) = text[first..=last].iter().find_map(|c| c.bounds).map(|b| b.left) {
                    lines.push(Line { start: first, end: last, left, text: collapse(text, first, last) });
                }
            }
            line_start = index + 1;
        }
    }
    lines
}

/// One (start, end, bounds) per printed line of `start..=end`, so a wrapped citation is not
/// drawn as one box over two lines.
fn line_segments(text: &TextLayer, start: usize, end: usize) -> Vec<(usize, usize, TextBounds)> {
    let mut segments: Vec<(usize, usize, TextBounds)> = Vec::new();
    let mut previous: Option<TextBounds> = None;
    let mut broken = false;
    for index in start..=end.min(text.len().saturating_sub(1)) {
        let character = &text[index];
        if matches!(character.value, '\n' | '\r') {
            broken = true;
            continue;
        }
        let Some(bounds) = character.bounds else { continue };
        let wrapped = previous.is_some_and(|p| {
            let height = (p.bottom - p.top).abs();
            bounds.top >= p.bottom - height * 0.25 || bounds.left < p.left - 0.05
        });
        match segments.last_mut() {
            Some(segment) if !broken && !wrapped => {
                segment.1 = index;
                segment.2 = union(segment.2, bounds);
            }
            _ => segments.push((index, index, bounds)),
        }
        previous = Some(bounds);
        broken = false;
    }
    segments
}

fn union(a: TextBounds, b: TextBounds) -> TextBounds {
    TextBounds { left: a.left.min(b.left), top: a.top.min(b.top), right: a.right.max(b.right), bottom: a.bottom.max(b.bottom) }
}

fn collapse(text: &TextLayer, start: usize, end: usize) -> String {
    let mut result = String::new();
    for character in &text[start..=end.min(text.len().saturating_sub(1))] {
        if character.value.is_whitespace() || character.value.is_control() {
            if !result.ends_with(' ') && !result.is_empty() {
                result.push(' ');
            }
        } else if character.value != '\u{00ad}' {
            result.push(character.value);
        }
    }
    result.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TextChar;

    fn layer(lines: &[(&str, f32, f32)]) -> TextLayer {
        let mut characters = Vec::new();
        for (index, (line, left, top)) in lines.iter().enumerate() {
            let mut x = *left;
            for value in line.chars() {
                characters.push(TextChar {
                    value,
                    bounds: (!value.is_whitespace()).then_some(TextBounds { left: x, top: *top, right: x + 0.008, bottom: top + 0.015 }),
                });
                x += 0.009;
            }
            if index + 1 != lines.len() {
                characters.push(TextChar { value: '\n', bounds: None });
            }
        }
        TextLayer::new(characters)
    }

    fn key(first: &str, second: Option<&str>, year: &str) -> AuthorYear {
        AuthorYear { first: first.into(), second: second.map(Into::into), year: year.into() }
    }

    #[test]
    fn entry_keys_read_apa_harvard_and_vancouver_like_starts() {
        assert_eq!(entry_key("Smith, J. A., Jones, K., & Lee, M. (2020). A title. Journal, 3, 1–9."), Some(key("smith", Some("jones"), "2020")));
        assert_eq!(entry_key("van der Berg, P. 2019a. Another title. Press."), Some(key("berg", None, "2019a")));
        assert_eq!(entry_key("Smith JA, Lee K. 2018. Title of the paper."), Some(key("smith", Some("lee"), "2018")));
        assert_eq!(entry_key("World Health Organization. (2021). Report."), Some(key("organization", None, "2021")));
        assert_eq!(entry_key("A line with no year at all"), None);
    }

    #[test]
    fn parenthetical_groups_give_one_candidate_per_citation() {
        let text = layer(&[("Risk rose sharply (e.g., Smith et al., 2020; Lee & Park 2019a, 2021) in both.", 0.05, 0.1)]);
        let found = author_year_citations(0, &text, 0, text.len());
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].source, "Smith et al., 2020");
        assert_eq!(found[0].keys, vec![key("smith", None, "2020")]);
        assert_eq!(found[1].source, "Lee & Park 2019a, 2021");
        assert_eq!(found[1].keys, vec![key("lee", Some("park"), "2019a"), key("lee", Some("park"), "2021")]);
    }

    #[test]
    fn narrative_citations_take_the_names_before_the_parenthesis() {
        let text = layer(&[("As shown by Smith and Jones (2020), and later van der Berg (2019).", 0.05, 0.1)]);
        let found = author_year_citations(0, &text, 0, text.len());
        assert_eq!(found.iter().map(|c| c.source.as_str()).collect::<Vec<_>>(), vec!["Smith and Jones (2020)", "van der Berg (2019)"]);
        assert_eq!(found[0].keys, vec![key("smith", Some("jones"), "2020")]);
        assert_eq!(found[1].keys, vec![key("berg", None, "2019")]);
    }

    #[test]
    fn a_citation_that_wraps_is_drawn_per_line() {
        let text = layer(&[("findings (Smith et", 0.05, 0.1), ("al., 2020) hold.", 0.05, 0.13)]);
        let found = author_year_citations(0, &text, 0, text.len());
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|c| c.keys == vec![key("smith", None, "2020")]));
        assert!(found[0].bounds.bottom <= found[1].bounds.top + 0.001);
    }

    #[test]
    fn citations_start_at_the_names_and_may_use_brackets() {
        let text = layer(&[("a material reading [see Lynch and Kaplan 2000] and (as argued by Smith, 1999).", 0.05, 0.1)]);
        let found = author_year_citations(0, &text, 0, text.len());
        assert_eq!(found.iter().map(|c| c.source.as_str()).collect::<Vec<_>>(), vec!["Lynch and Kaplan 2000", "Smith, 1999"]);
        assert_eq!(found[0].keys, vec![key("lynch", Some("kaplan"), "2000")]);
    }

    #[test]
    fn plain_parentheses_and_bare_years_are_ignored() {
        let text = layer(&[("Participants (n = 120) were enrolled in 2020 (see Table 2).", 0.05, 0.1)]);
        assert!(author_year_citations(0, &text, 0, text.len()).is_empty());
    }

    #[test]
    fn unnumbered_lists_split_on_hanging_indents() {
        let text = layer(&[
            ("Adams, R., & Brown, T. (2018). Long title that", 0.05, 0.10),
            ("continues on a second line. Journal, 1, 2.", 0.07, 0.12),
            ("Chen, L. (2020a). Second entry title. Press.", 0.05, 0.14),
            ("Chen, L. (2020b). Third entry, same author.", 0.05, 0.16),
            ("  Retrieved from https://example.org/x", 0.07, 0.18),
        ]);
        let entries = unnumbered_reference_entries(5, &text, 0);
        assert_eq!(entries.len(), 3);
        assert!(entries[0].text.ends_with("Journal, 1, 2."));
        assert_eq!(entry_key(&entries[2].text), Some(key("chen", None, "2020b")));
        assert!(entries[2].text.ends_with("example.org/x"));
        assert!(key("chen", None, "2020").cites(&key("chen", None, "2020b")));
    }
}
