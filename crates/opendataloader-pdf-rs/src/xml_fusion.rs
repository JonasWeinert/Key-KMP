//! Reconciles normalized scientific XML with the PDF-derived layout.
//!
//! XML supplies identity, labels, captions, logical rows/cells, and spans. It
//! never supplies PDF coordinates: a visible geometric or tagged candidate is
//! required before XML may create or alter a table/figure region.

use std::{collections::HashSet, fs, path::Path};

use anyhow::{Context, Result};
use roxmltree::{Document as XmlDocument, Node};

use crate::model::{BBox, Block, Page, SemanticRegion, TableCell};

#[derive(Clone, Debug)]
pub struct XmlEvidence {
    pub tables: Vec<XmlTable>,
    pub figures: Vec<XmlFigure>,
    pub formulas: Vec<XmlFormula>,
    pub references: Vec<XmlReference>,
    pub sections: Vec<XmlSection>,
    pub cross_references: Vec<XmlCrossReference>,
    pub flow: Vec<String>,
    pub full_text: bool,
}

#[derive(Clone, Debug)]
pub struct XmlTable {
    pub id: String,
    pub label: String,
    pub caption: String,
    pub rows: Vec<Vec<XmlCell>>,
}

#[derive(Clone, Debug)]
pub struct XmlCell {
    pub text: String,
    pub column: usize,
    pub row_span: usize,
    pub column_span: usize,
}

#[derive(Clone, Debug)]
pub struct XmlFigure {
    pub id: String,
    pub label: String,
    pub caption: String,
    pub alt_text: Option<String>,
}

#[derive(Clone, Debug)]
pub struct XmlFormula {
    pub id: String,
    pub label: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct XmlReference {
    pub id: String,
    pub label: String,
    pub text: String,
    pub external_url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct XmlSection {
    pub id: String,
    pub title: String,
    pub level: u8,
}

#[derive(Clone, Debug)]
pub struct XmlCrossReference {
    pub text: String,
    pub target_id: String,
    pub kind: String,
}

pub fn parse_xml_evidence(path: &Path) -> Result<XmlEvidence> {
    let source = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    parse_xml_source(&source)
}

fn parse_xml_source(source: &str) -> Result<XmlEvidence> {
    // roxmltree deliberately rejects DTDs. PubMed's normal JATS response has
    // an external DOCTYPE even though extraction needs neither validation nor
    // entity expansion. Remove only the declaration, preserving all document
    // content and refusing an unterminated declaration.
    let sanitized = strip_doctype(source).context("sanitize scientific XML DTD")?;
    let xml = XmlDocument::parse(&sanitized).context("parse scientific XML")?;
    let mut tables = Vec::new();
    for (index, table) in xml
        .descendants()
        .filter(|node| local(*node) == "table")
        .enumerate()
    {
        // JATS wraps the actual grid in table-wrap; TEI places its heads beside
        // the table. Nested layout tables without rows are ignored.
        let mut rows = table
            .descendants()
            .filter(|node| matches!(local(*node), "row" | "tr"))
            .map(|row| {
                row.children()
                    .filter(|node| matches!(local(*node), "cell" | "td" | "th"))
                    .map(|cell| XmlCell {
                        text: node_text(cell),
                        column: 0,
                        row_span: numeric_attr(cell, &["rows", "rowspan"]).unwrap_or(1),
                        column_span: numeric_attr(cell, &["cols", "colspan"]).unwrap_or(1),
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|row| !row.is_empty())
            .collect::<Vec<_>>();
        position_spanning_cells(&mut rows);
        if rows.len() < 2 {
            continue;
        }
        let container = table
            .ancestors()
            .find(|node| matches!(local(*node), "table-wrap" | "figure"))
            .unwrap_or(table);
        let heads = container
            .children()
            .filter(|node| matches!(local(*node), "head" | "label" | "caption"))
            .map(node_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>();
        let label = heads
            .iter()
            .find(|text| looks_like_label(text, "table"))
            .cloned()
            .unwrap_or_default();
        let caption = heads
            .iter()
            .filter(|text| **text != label)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        tables.push(XmlTable {
            id: xml_id(container)
                .or_else(|| xml_id(table))
                .unwrap_or_else(|| format!("table-{}", index + 1)),
            label,
            caption,
            rows,
        });
    }

    let figures = xml
        .descendants()
        .filter(|node| matches!(local(*node), "figure" | "fig"))
        .filter(|node| !node.descendants().any(|child| local(child) == "table"))
        .enumerate()
        .map(|(index, figure)| {
            let texts = figure
                .children()
                .filter(|node| matches!(local(*node), "head" | "label" | "figDesc" | "caption"))
                .map(node_text)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>();
            let label = texts
                .iter()
                .find(|text| looks_like_label(text, "fig"))
                .cloned()
                .unwrap_or_default();
            let caption = texts
                .iter()
                .filter(|text| **text != label)
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
            XmlFigure {
                id: xml_id(figure).unwrap_or_else(|| format!("figure-{}", index + 1)),
                label,
                caption,
                alt_text: figure
                    .descendants()
                    .find(|node| matches!(local(*node), "alt-text" | "figDesc" | "long-desc"))
                    .map(node_text)
                    .filter(|text| !text.is_empty()),
            }
        })
        .filter(|figure| !figure.label.is_empty() || !figure.caption.is_empty())
        .collect();
    // Inline formulae are ordinary sentence content and do not warrant a
    // separate layout region. Restrict coordinate reconciliation to displayed
    // equations (JATS) and explicit TEI formula elements.
    let formulas = xml
        .descendants()
        .filter(|node| matches!(local(*node), "disp-formula" | "formula"))
        .enumerate()
        .filter_map(|(index, formula)| {
            let label = formula
                .children()
                .find(|node| local(*node) == "label")
                .map(node_text)
                .unwrap_or_default();
            let text = node_text(formula);
            (!text.is_empty()).then(|| XmlFormula {
                id: xml_id(formula).unwrap_or_else(|| format!("formula-{}", index + 1)),
                label,
                text,
            })
        })
        .collect();
    let references = xml
        .descendants()
        .filter(|node| {
            matches!(local(*node), "bibl" | "biblStruct")
                || (local(*node) == "ref"
                    && node
                        .ancestors()
                        .any(|ancestor| local(ancestor) == "ref-list"))
        })
        .enumerate()
        .filter_map(|(index, reference)| {
            let label = reference
                .children()
                .find(|node| local(*node) == "label")
                .map(node_text)
                .unwrap_or_default();
            let text = node_text(reference);
            if text.is_empty() {
                return None;
            }
            let external_url = reference.descendants().find_map(xml_external_url);
            Some(XmlReference {
                id: xml_id(reference).unwrap_or_else(|| format!("ref-{}", index + 1)),
                label,
                text,
                external_url,
            })
        })
        .collect();
    let sections = xml
        .descendants()
        .filter(|node| matches!(local(*node), "sec" | "div"))
        .enumerate()
        .filter_map(|(index, section)| {
            let title = section
                .children()
                .find(|node| matches!(local(*node), "title" | "head"))
                .map(node_text)
                .filter(|text| !text.is_empty())?;
            let level = section
                .ancestors()
                .filter(|node| matches!(local(*node), "sec" | "div"))
                .count()
                .clamp(1, 6) as u8;
            Some(XmlSection {
                id: xml_id(section).unwrap_or_else(|| format!("section-{}", index + 1)),
                title,
                level,
            })
        })
        .collect();
    let cross_references = xml
        .descendants()
        .filter(|node| matches!(local(*node), "xref" | "ref"))
        .flat_map(|xref| {
            let text = node_text(xref);
            let kind = xref.attribute("ref-type").unwrap_or("internal").to_owned();
            xref.attribute("rid")
                .or_else(|| xref.attribute("target"))
                .unwrap_or_default()
                .split_whitespace()
                .map(|target| XmlCrossReference {
                    text: text.clone(),
                    target_id: target.trim_start_matches('#').to_owned(),
                    kind: kind.clone(),
                })
                .filter(|item| !item.text.is_empty() && !item.target_id.is_empty())
                .collect::<Vec<_>>()
        })
        .collect();
    let flow = xml
        .descendants()
        .filter(|node| matches!(local(*node), "title" | "head" | "p"))
        .filter(|node| {
            !node.ancestors().any(|ancestor| {
                matches!(
                    local(ancestor),
                    "table" | "table-wrap" | "fig" | "figure" | "ref-list" | "listBibl"
                )
            })
        })
        .map(node_text)
        .filter(|text| text.split_whitespace().count() >= 2)
        .collect();
    let full_text = xml
        .descendants()
        .any(|node| matches!(local(node), "body" | "text"));
    Ok(XmlEvidence {
        tables,
        figures,
        formulas,
        references,
        sections,
        cross_references,
        flow,
        full_text,
    })
}

fn strip_doctype(source: &str) -> Result<std::borrow::Cow<'_, str>> {
    use std::borrow::Cow;

    let Some(start) = source.find("<!DOCTYPE") else {
        return Ok(Cow::Borrowed(source));
    };
    let bytes = source.as_bytes();
    let mut quote = None;
    let mut subset_depth = 0usize;
    for index in start + 9..bytes.len() {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == delimiter {
                quote = None;
            }
            continue;
        }
        match byte {
            b'\'' | b'"' => quote = Some(byte),
            b'[' => subset_depth += 1,
            b']' => subset_depth = subset_depth.saturating_sub(1),
            b'>' if subset_depth == 0 => {
                let mut cleaned = String::with_capacity(source.len());
                cleaned.push_str(&source[..start]);
                cleaned.push_str(&source[index + 1..]);
                return Ok(Cow::Owned(cleaned));
            }
            _ => {}
        }
    }
    anyhow::bail!("unterminated DOCTYPE declaration")
}

pub fn reconcile_xml(evidence: &XmlEvidence, pages: &mut [Page]) {
    for table in &evidence.tables {
        consolidate_caption_segment(table, pages);
        let caption_match = caption_anchored_table(table, pages);
        if caption_match.is_none() && create_table_from_caption(table, pages) {
            reconcile_table_caption(table, pages);
            continue;
        }
        let matched = caption_match.or_else(|| best_table_match(table, pages).filter(|item| {
            item.2 >= 0.56
                || matches!(&pages[item.0].blocks[item.1], Block::Table { bbox, .. } if nearby_caption_score(table, &pages[item.0], *bbox) >= 0.72)
        }));
        if let Some((page_index, block_index, score)) = matched {
            if std::env::var_os("ODL_XML_TRACE").is_some() {
                eprintln!(
                    "XML table {} -> page {} block {} score {:.3}",
                    table.id,
                    page_index + 1,
                    block_index,
                    score
                );
            }
            repair_table_across_pages(pages, page_index, block_index, table, score);
        } else {
            if std::env::var_os("ODL_XML_TRACE").is_some() {
                eprintln!("XML table {} -> caption reconstruction", table.id);
            }
        }
        reconcile_table_caption(table, pages);
    }
    reconcile_figures(&evidence.figures, pages);
    reconcile_formulas(&evidence.formulas, pages);
    reconcile_entity_cross_references(&evidence.cross_references, pages);
    suppress_unmatched_xml_tables(evidence, pages);
    reconcile_reading_order(&evidence.flow, pages);
}

/// A publisher may paint one logical wide table as several independent
/// column/row fragments. A high-confidence XML label caption is a stronger
/// boundary signal than those geometric splits, so consolidate fragments in
/// the caption's vertical segment before matching XML rows and cells.
fn consolidate_caption_segment(table: &XmlTable, pages: &mut [Page]) {
    if table.label.trim().is_empty() {
        return;
    }
    let label = normalized(&table.label);
    let Some((page_index, caption_index)) = pages
        .iter()
        .enumerate()
        .flat_map(|(page_index, page)| {
            let label = label.clone();
            page.blocks
                .iter()
                .enumerate()
                .filter_map(move |(block_index, block)| match block {
                    Block::Paragraph { text, .. } | Block::Heading { text, .. }
                        if normalized(text).starts_with(&label)
                            || squash_doubled_text(text)
                                .starts_with(&squash_doubled_text(&table.label))
                            || corrupted_table_label_match(text, &table.label) =>
                    {
                        Some((page_index, block_index))
                    }
                    _ => None,
                })
        })
        .next()
    else {
        return;
    };

    let page = &mut pages[page_index];
    let caption = page.blocks[caption_index].bbox();
    let next_caption_y = page
        .blocks
        .iter()
        .filter_map(|block| match block {
            Block::Paragraph { text, bbox, .. } | Block::Heading { text, bbox, .. }
                if bbox.y > caption.y + 4.0 && normalized(text).starts_with("table ") =>
            {
                Some(bbox.y)
            }
            _ => None,
        })
        .fold(page.height - 42.0, f32::min);
    let mut fragments = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| match block {
            Block::Table {
                bbox,
                semantic_table_id,
                ..
            } if semantic_table_id.is_none()
                && bbox.y >= caption.bottom() - 4.0
                && bbox.y < next_caption_y =>
            {
                Some(index)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if fragments.is_empty() {
        return;
    }
    fragments.sort_unstable();

    let min_y = fragments
        .iter()
        .map(|index| page.blocks[*index].bbox().y)
        .fold(f32::INFINITY, f32::min);
    let max_y = fragments
        .iter()
        .map(|index| page.blocks[*index].bbox().bottom())
        .fold(f32::NEG_INFINITY, f32::max);
    let mut merged_bbox = fragments
        .iter()
        .map(|index| page.blocks[*index].bbox())
        .reduce(BBox::union)
        .unwrap();
    // Borderless portions frequently arrive as small paragraph blocks. They
    // may expand the table hull but cannot create a table without a geometric
    // fragment and a matching caption.
    for block in &page.blocks {
        if matches!(block, Block::Paragraph { .. } | Block::Heading { .. }) {
            let bbox = block.bbox();
            if bbox.y >= min_y - 2.0
                && bbox.y <= max_y + 2.0
                && (bbox.bottom() <= max_y + 15.0 || bbox.width <= page.width * 0.22)
            {
                merged_bbox = merged_bbox.union(bbox);
            }
        }
    }
    let target = fragments[0];
    let mut merged_cells = Vec::new();
    for index in &fragments {
        if let Block::Table { cells, .. } = &page.blocks[*index] {
            merged_cells.extend(cells.clone());
        }
    }
    if let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        ..
    } = &mut page.blocks[target]
    {
        *bbox = merged_bbox;
        *rows = merged_cells
            .iter()
            .map(|cell| cell.row + 1)
            .max()
            .unwrap_or(*rows);
        *columns = merged_cells
            .iter()
            .map(|cell| cell.column + cell.column_span)
            .max()
            .unwrap_or(*columns);
        *cells = merged_cells;
    }
    for index in fragments.into_iter().filter(|index| *index != target).rev() {
        page.blocks.remove(index);
    }
}

fn caption_anchored_table(table: &XmlTable, pages: &[Page]) -> Option<(usize, usize, f32)> {
    if table.label.trim().is_empty() {
        return None;
    }
    let label = normalized(&table.label);
    let compact_label = squash_doubled_text(&table.label);
    let mut best: Option<(usize, f32, usize, f32)> = None;
    for (page_index, page) in pages.iter().enumerate() {
        for caption in page.blocks.iter().filter_map(|caption| match caption {
            Block::Paragraph { text, bbox, .. } | Block::Heading { text, bbox, .. }
                if normalized(text).starts_with(&label)
                    || squash_doubled_text(text).starts_with(&compact_label)
                    || corrupted_table_label_match(text, &table.label) =>
            {
                Some(*bbox)
            }
            _ => None,
        }) {
            for (block_index, block) in page.blocks.iter().enumerate() {
                let Block::Table {
                    bbox,
                    semantic_table_id,
                    ..
                } = block
                else {
                    continue;
                };
                if semantic_table_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("xml:"))
                    || vertical_gap(caption, *bbox) > 90.0
                    || horizontal_overlap(caption, *bbox) < 0.35
                {
                    continue;
                }
                let score = 0.88 + 0.12 * token_similarity(&table.caption, &block.text());
                if best.as_ref().is_none_or(|current| {
                    (page_index, bbox.y as i32) < (current.0, current.1 as i32)
                }) {
                    best = Some((page_index, bbox.y, block_index, score));
                }
            }
        }
    }
    best.map(|(page, _y, block, score)| (page, block, score))
}

fn squash_doubled_text(text: &str) -> String {
    let compact = text
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0usize;
    while index < compact.len() {
        output.push(compact[index]);
        index += if compact.get(index + 1) == compact.get(index) {
            2
        } else {
            1
        };
    }
    output
}

fn corrupted_table_label_match(text: &str, label: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let number = label
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>();
    !number.is_empty()
        && (lower.contains("ttaab") || lower.contains("tabelle"))
        && lower
            .chars()
            .filter(|ch| ch.is_ascii_digit())
            .collect::<String>()
            .contains(&number)
}

fn reconcile_entity_cross_references(cross_references: &[XmlCrossReference], pages: &mut [Page]) {
    let mut emitted = HashSet::new();
    for xref in cross_references.iter().filter(|xref| {
        matches!(
            xref.kind.as_str(),
            "fig" | "figure" | "table" | "formula" | "disp-formula"
        )
    }) {
        let best = pages
            .iter()
            .enumerate()
            .flat_map(|(page_index, page)| {
                page.blocks
                    .iter()
                    .enumerate()
                    .filter_map(move |(block_index, block)| {
                        let observed = normalized(&block.text());
                        let expected = normalized(&xref.text);
                        ((!expected.is_empty()
                            && (observed == expected
                                || observed.split_whitespace().any(|part| part == expected)))
                            as u8
                            == 1)
                            .then_some((page_index, block_index))
                    })
            })
            .next();
        let Some((page_index, block_index)) = best else {
            continue;
        };
        if !emitted.insert((page_index, block_index, xref.target_id.clone())) {
            continue;
        }
        pages[page_index].semantic_regions.push(SemanticRegion {
            id: format!("xml:xref:{}:{}", xref.kind, xref.target_id),
            role: "CrossReference".into(),
            bbox: pages[page_index].blocks[block_index].bbox(),
            confidence: 0.94,
            source: "external_xml_xref_match".into(),
            alt_text: None,
            label: nonempty(&xref.text),
            caption: None,
            target_id: Some(format!("xml:{}", xref.target_id)),
            external_url: None,
        });
    }
}

fn reconcile_table_caption(table: &XmlTable, pages: &mut [Page]) {
    let target = format!("xml:{}", table.id);
    let best = pages
        .iter()
        .enumerate()
        .flat_map(|(page_index, page)| {
            page.blocks
                .iter()
                .enumerate()
                .filter_map(move |(block_index, block)| match block {
                    Block::Paragraph { text, .. } | Block::Heading { text, .. } => {
                        let label = (!table.label.is_empty()
                            && normalized(text).contains(&normalized(&table.label)))
                            as u8 as f32;
                        let score = label.max(token_similarity(&table.caption, text));
                        (score >= 0.72).then_some((page_index, block_index, score))
                    }
                    _ => None,
                })
        })
        .max_by(|left, right| left.2.total_cmp(&right.2));
    let Some((page_index, block_index, score)) = best else {
        return;
    };
    if !pages.iter().flat_map(|page| &page.blocks).any(
        |block| matches!(block, Block::Table { semantic_table_id: Some(id), .. } if id == &target),
    ) {
        return;
    }
    pages[page_index].semantic_regions.push(SemanticRegion {
        id: format!("{target}:caption"),
        role: "Caption".into(),
        bbox: pages[page_index].blocks[block_index].bbox(),
        confidence: score,
        source: "external_xml_caption".into(),
        alt_text: None,
        label: nonempty(&table.label),
        caption: nonempty(&table.caption),
        target_id: Some(target),
        external_url: None,
    });
}

fn reconcile_reading_order(flow: &[String], pages: &mut [Page]) {
    if flow.len() < 6 {
        return;
    }
    for page in pages {
        let mut matches = Vec::<(usize, usize, f32)>::new();
        let mut used = HashSet::new();
        for (block_index, block) in page.blocks.iter().enumerate() {
            if !matches!(block, Block::Paragraph { .. } | Block::Heading { .. }) {
                continue;
            }
            let text = block.text();
            let best = flow
                .iter()
                .enumerate()
                .filter(|(index, _)| !used.contains(index))
                .map(|(index, expected)| (index, token_similarity(expected, &text)))
                .max_by(|left, right| left.1.total_cmp(&right.1));
            if let Some((flow_index, score)) = best.filter(|candidate| candidate.1 >= 0.88) {
                used.insert(flow_index);
                matches.push((block_index, flow_index, score));
            }
        }
        if matches.len() < 6 {
            continue;
        }
        let inversions = matches
            .windows(2)
            .filter(|pair| pair[0].1 > pair[1].1)
            .count();
        if inversions == 0 || inversions * 5 > matches.len() * 2 {
            continue;
        }
        let min_x = matches
            .iter()
            .map(|item| page.blocks[item.0].bbox().x)
            .fold(f32::INFINITY, f32::min);
        let max_x = matches
            .iter()
            .map(|item| page.blocks[item.0].bbox().x)
            .fold(f32::NEG_INFINITY, f32::max);
        if max_x - min_x < page.width * 0.20 {
            continue;
        }
        let slots = matches.iter().map(|item| item.0).collect::<Vec<_>>();
        let mut ordered = matches.clone();
        ordered.sort_by_key(|item| item.1);
        let replacements = ordered
            .into_iter()
            .map(|item| page.blocks[item.0].clone())
            .collect::<Vec<_>>();
        for (slot, block) in slots.into_iter().zip(replacements) {
            page.blocks[slot] = block;
        }
    }
}

pub fn link_citations(evidence: &XmlEvidence, pages: &mut [Page]) {
    let urls = evidence
        .references
        .iter()
        .map(|reference| (reference.id.as_str(), reference.external_url.as_deref()))
        .collect::<std::collections::HashMap<_, _>>();
    let labels = evidence
        .references
        .iter()
        .map(|reference| {
            let fallback = reference
                .id
                .chars()
                .rev()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            (
                reference.id.as_str(),
                if reference.label.trim().is_empty() {
                    fallback
                } else {
                    reference.label.clone()
                },
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    for xref in evidence
        .cross_references
        .iter()
        .filter(|xref| matches!(xref.kind.as_str(), "bibr" | "bib" | "reference"))
    {
        let expected = normalized(&xref.text);
        if expected.is_empty() {
            continue;
        }
        let target_label = labels
            .get(xref.target_id.as_str())
            .map(|value| normalized(value))
            .unwrap_or_default();
        for page in pages.iter_mut() {
            for citation in &mut page.citations {
                let observed = normalized(&citation.text);
                let exact = (observed == expected) as u8 as f32;
                let label = citation.reference_labels.iter().any(|label| {
                    let label = normalized(label);
                    label == expected || (!target_label.is_empty() && label == target_label)
                }) as u8 as f32;
                let score = exact
                    .max(label)
                    .max(token_similarity(&xref.text, &citation.text));
                if score < 0.82 {
                    continue;
                }
                let target = format!("xml:{}", xref.target_id);
                if !citation.target_ids.contains(&target) {
                    citation.target_ids.push(target);
                }
                if let Some(Some(url)) = urls.get(xref.target_id.as_str()) {
                    if !citation
                        .external_urls
                        .iter()
                        .any(|existing| existing == url)
                    {
                        citation.external_urls.push((*url).to_owned());
                    }
                }
                if !citation
                    .evidence
                    .iter()
                    .any(|item| item == "external_xml_xref")
                {
                    citation.evidence.push("external_xml_xref".into());
                }
                citation.confidence = citation.confidence.max(0.98);
            }
        }
    }
}

/// Align one logical XML table to an ordered sequence of PDF table fragments.
///
/// XML has no PDF pagination, so the bridge is deliberately the visible text
/// produced by geometry mode.  Rows are assigned monotonically to adjacent
/// page fragments; a repeated page header is mapped to the first XML row but
/// is not emitted twice as a logical row.  This also makes XML safe without a
/// tagged structure tree.
fn repair_table_across_pages(
    pages: &mut [Page],
    anchor_page: usize,
    anchor_block: usize,
    xml: &XmlTable,
    score: f32,
) {
    // First retain the established same-page fragment joining behaviour.
    let anchor_index = repair_table_on_page_geometry(&mut pages[anchor_page], anchor_block, xml);
    let anchor_bbox = pages[anchor_page].blocks[anchor_index].bbox();
    let xml_columns = table_columns(&xml.rows);

    let mut fragments = vec![(anchor_page, anchor_index)];
    if anchor_bbox.bottom() < pages[anchor_page].height * 0.82 {
        repair_table(&mut pages[anchor_page].blocks[anchor_index], xml, score);
        return;
    }
    // Continuations are overwhelmingly on immediately adjacent pages. Stop at
    // the first page without a plausible top-of-page fragment so that a later
    // unrelated table with the same column count cannot be absorbed.
    for page_index in anchor_page + 1..pages.len() {
        let best = pages[page_index]
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| match block {
                Block::Table {
                    bbox,
                    columns,
                    cells,
                    ..
                } if (*columns == xml_columns || columns.abs_diff(xml_columns) <= 1)
                    && horizontal_overlap(*bbox, anchor_bbox) >= 0.68
                    && bbox.y <= pages[page_index].height * 0.30 =>
                {
                    let visible = cells
                        .iter()
                        .map(|cell| cell.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    let xml_text = xml
                        .rows
                        .iter()
                        .flatten()
                        .map(|cell| cell.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    Some((
                        index,
                        0.72 * token_similarity(&visible, &xml_text)
                            + 0.28 * horizontal_overlap(*bbox, anchor_bbox),
                    ))
                }
                _ => None,
            })
            .max_by(|left, right| left.1.total_cmp(&right.1));
        let Some((index, _continuation_score)) = best.filter(|candidate| candidate.1 >= 0.42)
        else {
            break;
        };
        fragments.push((page_index, index));
    }

    if fragments.len() == 1 {
        repair_table(&mut pages[anchor_page].blocks[anchor_index], xml, score);
        return;
    }

    let visible = fragments
        .iter()
        .map(|(page, block)| match &pages[*page].blocks[*block] {
            Block::Table { cells, .. } => cells
                .iter()
                .map(|cell| cell.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        })
        .collect::<Vec<_>>();
    let ranges = monotonic_row_ranges(xml, &visible);
    let fragment_count = fragments.len();
    for (fragment_index, ((page_index, block_index), (start, end))) in
        fragments.into_iter().zip(ranges).enumerate()
    {
        if start >= end {
            continue;
        }
        repair_table_rows(
            &mut pages[page_index].blocks[block_index],
            xml,
            start,
            end,
            score,
            fragment_index > 0,
            fragment_index + 1 < fragment_count,
        );
    }
}

fn monotonic_row_ranges(xml: &XmlTable, fragments: &[String]) -> Vec<(usize, usize)> {
    if fragments.len() == 1 {
        return vec![(0, xml.rows.len())];
    }
    let row_text = xml
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>();
    let mut boundaries = vec![0usize];
    let mut cursor = 0usize;
    for fragment_index in 0..fragments.len() - 1 {
        let remaining_fragments = fragments.len() - fragment_index - 1;
        let maximum = row_text
            .len()
            .saturating_sub(remaining_fragments)
            .max(cursor + 1);
        let mut best = (cursor + 1, f32::MIN);
        for end in cursor + 1..=maximum.min(row_text.len()) {
            let candidate = row_text[cursor..end].join(" ");
            let coverage = token_similarity(&candidate, &fragments[fragment_index]);
            // Reward the next fragment beginning with the next logical rows.
            let lookahead_end = (end + 3).min(row_text.len());
            let lookahead = token_similarity(
                &row_text[end..lookahead_end].join(" "),
                &fragments[fragment_index + 1],
            );
            let value = coverage + 0.32 * lookahead;
            if value > best.1 {
                best = (end, value);
            }
        }
        cursor = best.0;
        boundaries.push(cursor);
    }
    boundaries.push(row_text.len());
    boundaries
        .windows(2)
        .map(|window| (window[0], window[1]))
        .collect()
}

fn create_table_from_caption(xml: &XmlTable, pages: &mut [Page]) -> bool {
    let best = pages
        .iter()
        .enumerate()
        .flat_map(|(page_index, page)| {
            page.blocks
                .iter()
                .enumerate()
                .filter_map(move |(block_index, block)| match block {
                    Block::Paragraph { text, .. } | Block::Heading { text, .. } => {
                        let label = (!xml.label.is_empty()
                            && normalized(text).contains(&normalized(&xml.label)))
                            as u8 as f32;
                        let caption_bbox = block.bbox();
                        let nearby_caption = page
                            .blocks
                            .iter()
                            .filter_map(|candidate| match candidate {
                                Block::Paragraph { text, bbox, .. }
                                | Block::Heading { text, bbox, .. }
                                    if (bbox.y - caption_bbox.y).abs() < 35.0 =>
                                {
                                    Some(token_similarity(&xml.caption, text))
                                }
                                _ => None,
                            })
                            .fold(token_similarity(&xml.caption, text), f32::max);
                        let score = 0.65 * label + 0.35 * nearby_caption;
                        Some((page_index, block_index, score))
                    }
                    _ => None,
                })
        })
        .max_by(|left, right| left.2.total_cmp(&right.2));
    let Some((page_index, caption_index, _caption_score)) = best.filter(|item| item.2 >= 0.72)
    else {
        return false;
    };
    let page = &mut pages[page_index];
    let caption = page.blocks[caption_index].bbox();
    let candidate_indices = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let bbox = block.bbox();
            (index != caption_index
                && bbox.y >= caption.bottom() - 2.0
                && bbox.y < page.height - 45.0
                && matches!(block, Block::Paragraph { .. } | Block::Heading { .. }))
            .then_some(index)
        })
        .collect::<Vec<_>>();
    if candidate_indices.len() < xml.rows.len().min(3) {
        return false;
    }
    let xml_columns = table_columns(&xml.rows);
    if xml_columns == 0 {
        return false;
    }
    let table_bbox = candidate_indices
        .iter()
        .map(|index| page.blocks[*index].bbox())
        .reduce(BBox::union)
        .unwrap();
    let mut available = candidate_indices.iter().copied().collect::<HashSet<_>>();
    let mut cells = Vec::new();
    let mut matched = 0usize;
    for (row, xml_row) in xml.rows.iter().enumerate() {
        for xml_cell in xml_row {
            let column = xml_cell.column;
            let choice = available
                .iter()
                .filter_map(|index| match &page.blocks[*index] {
                    Block::Paragraph { text, bbox, .. } | Block::Heading { text, bbox, .. } => {
                        let semantic = token_similarity(&xml_cell.text, text);
                        let observed_column = (((bbox.x + bbox.width / 2.0 - table_bbox.x)
                            / table_bbox.width.max(1.0))
                            * xml_columns as f32)
                            .floor()
                            .clamp(0.0, (xml_columns - 1) as f32)
                            as usize;
                        let column_score = 1.0
                            - (observed_column.abs_diff(column) as f32 / xml_columns.max(1) as f32)
                                .min(1.0);
                        Some((
                            *index,
                            0.78 * semantic + 0.22 * column_score,
                            text.clone(),
                            *bbox,
                        ))
                    }
                    _ => None,
                })
                .max_by(|left, right| left.1.total_cmp(&right.1));
            let (_visible_text, bbox) = if let Some((index, _similarity, text, bbox)) =
                choice.filter(|choice| choice.1 >= 0.34)
            {
                available.remove(&index);
                matched += 1;
                (text, bbox)
            } else {
                (
                    xml_cell.text.clone(),
                    cell_geometry(
                        &[],
                        table_bbox,
                        row,
                        column,
                        xml.rows.len(),
                        xml_columns,
                        xml_cell.row_span,
                        xml_cell.column_span,
                    ),
                )
            };
            cells.push(TableCell {
                row,
                column,
                row_span: xml_cell.row_span.max(1),
                column_span: xml_cell.column_span.max(1),
                text: xml_cell.text.clone(),
                bbox,
            });
        }
    }
    let total = cells.len().max(1);
    if matched * 6 < total {
        return false;
    }
    let replacement = Block::Table {
        bbox: table_bbox,
        rows: xml.rows.len(),
        columns: xml_columns,
        cells,
        ruled: false,
        semantic_table_id: Some(format!("xml:{}", xml.id)),
        semantic_confidence: Some((0.72 + 0.28 * matched as f32 / total as f32).min(1.0)),
        continues_from_previous_page: false,
        continues_on_next_page: false,
    };
    let remove = candidate_indices.into_iter().collect::<HashSet<_>>();
    let insert_at = caption_index + 1;
    let mut replacement = Some(replacement);
    page.blocks = page
        .blocks
        .drain(..)
        .enumerate()
        .filter_map(|(index, block)| {
            if index == insert_at {
                replacement.take()
            } else if remove.contains(&index) {
                None
            } else {
                Some(block)
            }
        })
        .collect();
    if let Some(table) = replacement {
        page.blocks.push(table);
    }
    true
}

fn best_table_match(table: &XmlTable, pages: &[Page]) -> Option<(usize, usize, f32)> {
    let xml_text = table
        .rows
        .iter()
        .flatten()
        .map(|cell| cell.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let xml_columns = table_columns(&table.rows);
    let mut best = None;
    for (page_index, page) in pages.iter().enumerate() {
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Block::Table {
                rows,
                columns,
                cells,
                bbox,
                semantic_table_id,
                ..
            } = block
            else {
                continue;
            };
            if semantic_table_id
                .as_deref()
                .is_some_and(|id| id.starts_with("xml:"))
            {
                continue;
            }
            if nearby_figure_caption(page, *bbox) {
                continue;
            }
            let visible = cells
                .iter()
                .map(|cell| cell.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let text_score = token_similarity(&xml_text, &visible);
            let dimension_score = ((*columns == xml_columns) as u8 as f32
                + (*rows == table.rows.len()) as u8 as f32)
                * 0.5;
            let caption_score = nearby_caption_score(table, page, *bbox);
            if text_score < 0.28 && caption_score < 0.55 {
                continue;
            }
            if (!table.label.is_empty() || !table.caption.is_empty())
                && caption_score < 0.45
                && text_score < 0.65
            {
                continue;
            }
            let score = 0.58 * text_score + 0.18 * dimension_score + 0.24 * caption_score;
            if best
                .as_ref()
                .is_none_or(|current: &(usize, usize, f32)| score > current.2)
            {
                best = Some((page_index, block_index, score));
            }
        }
    }
    best
}

fn nearby_figure_caption(page: &Page, bbox: BBox) -> bool {
    page.blocks.iter().any(|block| match block {
        Block::Paragraph {
            text,
            bbox: caption,
            ..
        }
        | Block::Heading {
            text,
            bbox: caption,
            ..
        } => {
            let value = normalized(text);
            (value.starts_with("fig ") || value.starts_with("figure "))
                && vertical_gap(*caption, bbox) < 85.0
        }
        _ => false,
    })
}

fn repair_table_on_page_geometry(page: &mut Page, block_index: usize, xml: &XmlTable) -> usize {
    let xml_columns = table_columns(&xml.rows);
    let anchor = page.blocks[block_index].bbox();
    let mut fragments = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| match block {
            Block::Table {
                bbox,
                columns,
                semantic_table_id: None,
                ..
            } if (*columns == xml_columns
                && horizontal_overlap(*bbox, anchor) >= 0.72
                && vertical_gap(*bbox, anchor) <= 30.0)
                || (vertical_overlap(*bbox, anchor) >= 0.72
                    && horizontal_gap(*bbox, anchor) <= 60.0) =>
            {
                Some(index)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if !fragments.contains(&block_index) {
        fragments.push(block_index);
    }
    fragments.sort_unstable();

    let target = fragments[0];
    if fragments.len() > 1 {
        let mut pieces = fragments
            .iter()
            .filter_map(|index| match &page.blocks[*index] {
                Block::Table {
                    bbox, rows, cells, ..
                } => Some((*bbox, *rows, cells.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        pieces.sort_by(|left, right| left.0.y.total_cmp(&right.0.y));
        let merged_bbox = pieces
            .iter()
            .map(|piece| piece.0)
            .reduce(BBox::union)
            .unwrap_or(anchor);
        let mut merged_cells = Vec::new();
        let mut row_offset = 0usize;
        for (_, rows, cells) in pieces {
            merged_cells.extend(cells.into_iter().map(|mut cell| {
                cell.row += row_offset;
                cell
            }));
            row_offset += rows;
        }
        if let Block::Table {
            bbox, rows, cells, ..
        } = &mut page.blocks[target]
        {
            *bbox = merged_bbox;
            *rows = row_offset;
            *cells = merged_cells;
        }
        for index in fragments
            .iter()
            .copied()
            .filter(|index| *index != target)
            .rev()
        {
            page.blocks.remove(index);
        }
    }
    target
}

fn horizontal_overlap(left: BBox, right: BBox) -> f32 {
    (left.right().min(right.right()) - left.x.max(right.x)).max(0.0)
        / left.width.min(right.width).max(1.0)
}

fn vertical_overlap(left: BBox, right: BBox) -> f32 {
    (left.bottom().min(right.bottom()) - left.y.max(right.y)).max(0.0)
        / left.height.min(right.height).max(1.0)
}

fn horizontal_gap(left: BBox, right: BBox) -> f32 {
    if left.right() < right.x {
        right.x - left.right()
    } else if right.right() < left.x {
        left.x - right.right()
    } else {
        0.0
    }
}

fn vertical_gap(left: BBox, right: BBox) -> f32 {
    if left.bottom() < right.y {
        right.y - left.bottom()
    } else if right.bottom() < left.y {
        left.y - right.bottom()
    } else {
        0.0
    }
}

fn suppress_unmatched_xml_tables(evidence: &XmlEvidence, pages: &mut [Page]) {
    if !evidence.full_text {
        return;
    }
    let matched = pages.iter().flat_map(|page| &page.blocks).filter(|block| {
        matches!(block, Block::Table { semantic_table_id: Some(id), .. } if id.starts_with("xml:"))
    }).count();
    if !evidence.tables.is_empty() && matched * 5 < evidence.tables.len() * 4 {
        return;
    }
    for page in pages {
        let captions = page
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { text, bbox, .. } | Block::Heading { text, bbox, .. }
                    if normalized(text).starts_with("table ") =>
                {
                    Some(*bbox)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        page.blocks.retain(|block| match block {
            Block::Table {
                bbox,
                semantic_table_id: None,
                ..
            } => captions
                .iter()
                .any(|caption| vertical_gap(*bbox, *caption) < 100.0),
            _ => true,
        });
    }
}

fn nearby_caption_score(table: &XmlTable, page: &Page, bbox: BBox) -> f32 {
    page.blocks
        .iter()
        .filter_map(|block| match block {
            Block::Paragraph {
                text,
                bbox: text_bbox,
                ..
            }
            | Block::Heading {
                text,
                bbox: text_bbox,
                ..
            } if (text_bbox.y - bbox.y).abs() < 180.0
                || (text_bbox.bottom() - bbox.bottom()).abs() < 180.0 =>
            {
                let label: f32 = if table.label.is_empty() {
                    0.0
                } else if normalized(text).contains(&normalized(&table.label)) {
                    1.0
                } else {
                    0.0
                };
                Some(label.max(token_similarity(&table.caption, text)))
            }
            _ => None,
        })
        .fold(0.0, f32::max)
}

fn repair_table(block: &mut Block, xml: &XmlTable, score: f32) {
    repair_table_rows(block, xml, 0, xml.rows.len(), score, false, false);
}

fn repair_table_rows(
    block: &mut Block,
    xml: &XmlTable,
    row_start: usize,
    row_end: usize,
    score: f32,
    continues_from_previous_page: bool,
    continues_on_next_page: bool,
) {
    let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        semantic_table_id,
        semantic_confidence,
        continues_from_previous_page: from_previous,
        continues_on_next_page: on_next,
        ..
    } = block
    else {
        return;
    };
    let xml_columns = table_columns(&xml.rows);
    if xml_columns == 0 || row_start >= row_end || row_end > xml.rows.len() {
        return;
    }
    *semantic_table_id = Some(format!("xml:{}", xml.id));
    *semantic_confidence = Some(score);
    *from_previous = continues_from_previous_page;
    *on_next = continues_on_next_page;

    let old = cells.clone();
    let mut rebuilt = Vec::new();
    for (local_row, xml_row) in xml.rows[row_start..row_end].iter().enumerate() {
        for xml_cell in xml_row {
            let column = xml_cell.column;
            let cell_bbox = cell_geometry(
                &old,
                *bbox,
                local_row,
                column,
                row_end - row_start,
                xml_columns,
                xml_cell.row_span,
                xml_cell.column_span,
            );
            let visible_text = if xml_cell.text.trim().is_empty() {
                best_visible_cell_text(&old, local_row, column).unwrap_or_default()
            } else {
                xml_cell.text.clone()
            };
            rebuilt.push(TableCell {
                row: local_row,
                column,
                row_span: xml_cell.row_span.max(1),
                column_span: xml_cell.column_span.max(1),
                text: visible_text,
                bbox: cell_bbox,
            });
        }
    }
    *rows = row_end - row_start;
    *columns = xml_columns;
    *cells = rebuilt;
}

fn cell_geometry(
    old: &[TableCell],
    table: BBox,
    row: usize,
    column: usize,
    rows: usize,
    columns: usize,
    row_span: usize,
    column_span: usize,
) -> BBox {
    old.iter()
        .filter(|cell| cell.row == row && cell.column == column)
        .map(|cell| cell.bbox)
        .next()
        .unwrap_or(BBox {
            x: table.x + table.width * column as f32 / columns as f32,
            y: table.y + table.height * row as f32 / rows as f32,
            width: table.width * column_span.max(1) as f32 / columns as f32,
            height: table.height * row_span.max(1) as f32 / rows as f32,
        })
}

fn best_visible_cell_text(old: &[TableCell], row: usize, column: usize) -> Option<String> {
    if let Some(cell) = old
        .iter()
        .find(|cell| cell.row == row && cell.column == column && !cell.text.trim().is_empty())
    {
        return Some(cell.text.clone());
    }
    None
}

fn reconcile_figures(figures: &[XmlFigure], pages: &mut [Page]) {
    for figure in figures {
        let mut best: Option<(usize, usize, f32, f32, f32)> = None;
        for (page_index, page) in pages.iter().enumerate() {
            for (block_index, block) in page.blocks.iter().enumerate() {
                let (text, bbox) = match block {
                    Block::Paragraph { text, bbox, .. } | Block::Heading { text, bbox, .. } => {
                        (text, *bbox)
                    }
                    _ => continue,
                };
                let label = (!figure.label.is_empty()
                    && normalized(text).starts_with(&normalized(&figure.label)))
                    as u8 as f32;
                let caption = token_similarity(&figure.caption, text);
                let score = 0.60 * label + 0.40 * caption;
                if (label > 0.0 && caption >= 0.22 || caption >= 0.72)
                    && best.as_ref().is_none_or(|current| score > current.2)
                {
                    best = Some((page_index, block_index, score, label, caption));
                }
                let _ = bbox;
            }
        }
        let Some((page_index, block_index, _match_score, label_score, caption_score)) = best else {
            continue;
        };
        let caption_bbox = pages[page_index].blocks[block_index].bbox();
        let false_table = pages[page_index]
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| match block {
                Block::Table {
                    bbox,
                    semantic_table_id: None,
                    ..
                } if (bbox.bottom() <= caption_bbox.y + 12.0
                    && caption_bbox.y - bbox.bottom() < 60.0)
                    || (bbox.y >= caption_bbox.y - 12.0
                        && bbox.y - caption_bbox.bottom() < 60.0) =>
                {
                    Some((index, *bbox))
                }
                _ => None,
            })
            .max_by(|left, right| left.1.bottom().total_cmp(&right.1.bottom()));
        let region = false_table
            .map(|item| item.1)
            .or_else(|| {
                pages[page_index]
                    .images
                    .iter()
                    .copied()
                    .filter(|bbox| {
                        bbox.bottom() <= caption_bbox.y + 8.0
                            && caption_bbox.y - bbox.bottom() < 420.0
                    })
                    .max_by(|left, right| left.bottom().total_cmp(&right.bottom()))
            })
            .map(|bbox| expand_visual_hull(&pages[page_index], bbox, caption_bbox));
        if let Some(bbox) = region {
            let tag_support = pages[page_index].semantic_regions.iter().any(|semantic| {
                matches!(semantic.role.as_str(), "Figure" | "Chart" | "Diagram")
                    && overlap(semantic.bbox, bbox) >= 0.45
            });
            let (confidence, source) = if tag_support {
                (0.99, "external_xml_caption+tag_geometry")
            } else if false_table.is_none() && label_score > 0.0 && caption_score >= 0.50 {
                (0.97, "external_xml_caption+image_geometry")
            } else if false_table.is_none() && label_score > 0.0 {
                (0.91, "external_xml_label+image_geometry")
            } else if false_table.is_none() {
                (0.88, "external_xml_caption+image_geometry")
            } else if label_score > 0.0 && caption_score >= 0.50 {
                (0.93, "external_xml_caption+vector_geometry")
            } else {
                (0.80, "external_xml_caption+weak_geometry")
            };
            if let Some((index, _)) = false_table {
                pages[page_index].blocks.remove(index);
            }
            if !pages[page_index]
                .images
                .iter()
                .any(|existing| overlap(*existing, bbox) > 0.85)
            {
                pages[page_index].images.push(bbox);
            }
            pages[page_index].semantic_regions.push(SemanticRegion {
                id: format!("xml:{}", figure.id),
                role: "Figure".into(),
                bbox,
                confidence,
                source: source.into(),
                alt_text: figure.alt_text.clone(),
                label: nonempty(&figure.label),
                caption: nonempty(&figure.caption),
                target_id: None,
                external_url: None,
            });
            pages[page_index].semantic_regions.push(SemanticRegion {
                id: format!("xml:{}:caption", figure.id),
                role: "Caption".into(),
                bbox: caption_bbox,
                confidence: (0.82 + 0.18 * caption_score).min(1.0),
                source: "external_xml_caption".into(),
                alt_text: None,
                label: nonempty(&figure.label),
                caption: nonempty(&figure.caption),
                target_id: Some(format!("xml:{}", figure.id)),
                external_url: None,
            });
        }
    }
}

fn expand_visual_hull(page: &Page, seed: BBox, caption: BBox) -> BBox {
    page.images
        .iter()
        .copied()
        .chain(
            page.semantic_regions
                .iter()
                .filter(|region| matches!(region.role.as_str(), "Figure" | "Chart" | "Diagram"))
                .map(|region| region.bbox),
        )
        .filter(|candidate| {
            candidate.bottom() <= caption.y + 10.0
                && vertical_gap(*candidate, seed) < 28.0
                && horizontal_overlap(*candidate, seed) > 0.18
        })
        .fold(seed, BBox::union)
}

fn reconcile_formulas(formulas: &[XmlFormula], pages: &mut [Page]) {
    let mut used_lines = HashSet::new();
    for formula in formulas {
        let mut best = None;
        for (page_index, page) in pages.iter().enumerate() {
            for block in &page.blocks {
                let lines = match block {
                    Block::Paragraph { lines, .. } | Block::Heading { lines, .. } => {
                        lines.as_slice()
                    }
                    _ => &[],
                };
                for line in lines {
                    let text_score = token_similarity(&formula.text, &line.text);
                    let observed = normalized(&line.text);
                    let expected_label = normalized(&formula.label);
                    let label_score = (!expected_label.is_empty()
                        && (observed.ends_with(&expected_label) || observed == expected_label))
                        as u8 as f32;
                    let equation_like = line
                        .text
                        .chars()
                        .any(|ch| matches!(ch, '=' | '+' | '−' | '×' | 'λ' | 'β' | '∫'));
                    let eligible = equation_like
                        && (text_score >= 0.62 || (label_score > 0.0 && text_score >= 0.30));
                    let score = 0.82 * text_score + 0.18 * label_score;
                    let key = (
                        page_index,
                        line.bbox.x.round() as i32,
                        line.bbox.y.round() as i32,
                    );
                    if eligible
                        && !used_lines.contains(&key)
                        && best
                            .as_ref()
                            .is_none_or(|candidate: &(usize, BBox, f32)| score > candidate.2)
                    {
                        best = Some((page_index, line.bbox, score));
                    }
                }
            }
        }
        let Some((page_index, bbox, score)) = best else {
            continue;
        };
        used_lines.insert((page_index, bbox.x.round() as i32, bbox.y.round() as i32));
        pages[page_index].semantic_regions.push(SemanticRegion {
            id: format!("xml:{}", formula.id),
            role: "Formula".into(),
            bbox,
            confidence: score,
            source: if score >= 0.86 {
                "external_xml_formula_strong_match"
            } else {
                "external_xml_formula_probable_match"
            }
            .into(),
            alt_text: nonempty(&formula.text),
            label: nonempty(&formula.label),
            caption: None,
            target_id: None,
            external_url: None,
        });
    }
}

pub(crate) fn reconcile_sections(sections: &[XmlSection], pages: &mut [Page]) {
    for section in sections {
        let best = pages
            .iter()
            .enumerate()
            .flat_map(|(page_index, page)| {
                page.blocks
                    .iter()
                    .enumerate()
                    .filter_map(move |(block_index, block)| match block {
                        Block::Heading { text, .. } | Block::Paragraph { text, .. } => {
                            let score = token_similarity(&section.title, text);
                            (score >= 0.86).then_some((page_index, block_index, score))
                        }
                        _ => None,
                    })
            })
            .max_by(|left, right| left.2.total_cmp(&right.2));
        let Some((page_index, block_index, score)) = best else {
            continue;
        };
        let bbox = pages[page_index].blocks[block_index].bbox();
        if let Block::Heading { level, .. } = &mut pages[page_index].blocks[block_index] {
            *level = section.level;
        }
        pages[page_index].semantic_regions.push(SemanticRegion {
            id: format!("xml:{}", section.id),
            role: format!("H{}", section.level),
            bbox,
            confidence: score,
            source: "external_xml_section_match".into(),
            alt_text: None,
            label: None,
            caption: nonempty(&section.title),
            target_id: None,
            external_url: None,
        });
    }
}

pub(crate) fn reconcile_references(references: &[XmlReference], pages: &mut [Page]) {
    for reference in references {
        let best = pages
            .iter()
            .enumerate()
            .flat_map(|(page_index, page)| {
                page.blocks
                    .iter()
                    .enumerate()
                    .flat_map(move |(block_index, block)| match block {
                        Block::ReferenceList { items, .. } => items
                            .iter()
                            .enumerate()
                            .filter_map(|(item_index, item)| {
                                let score = token_similarity(&reference.text, &item.text);
                                (score >= 0.56).then_some((
                                    page_index,
                                    block_index,
                                    item_index,
                                    score,
                                    item.bbox,
                                ))
                            })
                            .collect::<Vec<_>>(),
                        _ => Vec::new(),
                    })
            })
            .max_by(|left, right| left.3.total_cmp(&right.3));
        let Some((page_index, _block_index, _item_index, score, bbox)) = best else {
            continue;
        };
        pages[page_index].semantic_regions.push(SemanticRegion {
            id: format!("xml:{}", reference.id),
            role: "Reference".into(),
            bbox,
            confidence: score,
            source: "external_xml_reference_match".into(),
            alt_text: None,
            label: nonempty(&reference.label),
            caption: nonempty(&reference.text),
            target_id: None,
            external_url: reference.external_url.clone(),
        });
    }
}

fn local<'a>(node: Node<'a, '_>) -> &'a str {
    node.tag_name().name()
}
fn nonempty(text: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}
fn xml_external_url(node: Node<'_, '_>) -> Option<String> {
    node.attribute(("http://www.w3.org/1999/xlink", "href"))
        .or_else(|| node.attribute("href"))
        .or_else(|| {
            (local(node) == "pub-id" && node.attribute("pub-id-type") == Some("doi"))
                .then(|| node.text())
                .flatten()
        })
        .map(|value| {
            if value.starts_with("10.") {
                format!("https://doi.org/{value}")
            } else {
                value.to_owned()
            }
        })
}
fn xml_id(node: Node<'_, '_>) -> Option<String> {
    node.attribute(("http://www.w3.org/XML/1998/namespace", "id"))
        .or_else(|| node.attribute("id"))
        .map(str::to_owned)
}
fn numeric_attr(node: Node<'_, '_>, names: &[&str]) -> Option<usize> {
    names
        .iter()
        .find_map(|name| node.attribute(*name)?.parse().ok())
}
fn node_text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|child| child.is_text())
        .filter_map(|child| child.text())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn looks_like_label(text: &str, kind: &str) -> bool {
    normalized(text).starts_with(kind)
}
fn normalized(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn token_similarity(left: &str, right: &str) -> f32 {
    let left = normalized(left)
        .split_whitespace()
        .filter(|token| token.len() > 1)
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let right = normalized(right)
        .split_whitespace()
        .filter(|token| token.len() > 1)
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f32;
    intersection / (left.len().min(right.len()) as f32).max(1.0)
}
fn overlap(left: BBox, right: BBox) -> f32 {
    let width = (left.right().min(right.right()) - left.x.max(right.x)).max(0.0);
    let height = (left.bottom().min(right.bottom()) - left.y.max(right.y)).max(0.0);
    width * height
        / (left.width * left.height)
            .min(right.width * right.height)
            .max(1.0)
}

fn position_spanning_cells(rows: &mut [Vec<XmlCell>]) {
    let mut occupied = Vec::<usize>::new();
    for row in rows {
        let mut column = 0usize;
        for cell in row {
            while occupied.get(column).copied().unwrap_or(0) > 0 {
                column += 1;
            }
            cell.column = column;
            let end = column + cell.column_span.max(1);
            if occupied.len() < end {
                occupied.resize(end, 0);
            }
            if cell.row_span > 1 {
                for slot in &mut occupied[column..end] {
                    *slot = (*slot).max(cell.row_span);
                }
            }
            column = end;
        }
        for slot in &mut occupied {
            *slot = slot.saturating_sub(1);
        }
    }
}

fn table_columns(rows: &[Vec<XmlCell>]) -> usize {
    rows.iter()
        .flatten()
        .map(|cell| cell.column + cell.column_span.max(1))
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_external_and_internal_doctypes_without_expanding_them() {
        let external = r#"<?xml version="1.0"?><!DOCTYPE article PUBLIC "-//NLM//DTD JATS 1.3//EN" "JATS.dtd"><article><body><sec id="s"><title>Results</title></sec></body></article>"#;
        assert_eq!(
            parse_xml_source(external).unwrap().sections[0].title,
            "Results"
        );

        let internal =
            r#"<!DOCTYPE article [<!ELEMENT article ANY><!ENTITY quoted ">">]><article/>"#;
        assert!(strip_doctype(internal).unwrap().starts_with("<article"));
        assert!(strip_doctype("<!DOCTYPE article [").is_err());
    }

    #[test]
    fn similarity_tolerates_partial_pdf_text() {
        assert!(token_similarity("Age, years Female sex", "Female sex n (%)") > 0.45);
    }

    #[test]
    fn parses_tei_and_jats_table_shapes_and_spans() {
        let tei = r#"<TEI><text><table id="t1"><head type="label">Table 1</head><head>Outcomes</head><row><cell cols="2">Header</cell></row><row><cell>A</cell><cell>B</cell></row></table><figure id="f1"><head type="label">Fig. 1</head><figDesc>Flow chart</figDesc></figure></text></TEI>"#;
        let evidence = parse_xml_source(tei).unwrap();
        assert_eq!(evidence.tables.len(), 1);
        assert_eq!(evidence.tables[0].rows[0][0].column_span, 2);
        assert_eq!(evidence.figures[0].caption, "Flow chart");

        let jats = r#"<article><table-wrap id="t2"><label>Table 2</label><caption><title>Baseline</title></caption><table><tr><th>A</th><th>B</th></tr><tr><td rowspan="2">x</td><td>y</td></tr><tr><td>z</td></tr></table></table-wrap></article>"#;
        let evidence = parse_xml_source(jats).unwrap();
        assert_eq!(evidence.tables[0].label, "Table 2");
        assert_eq!(evidence.tables[0].rows[1][0].row_span, 2);
        assert_eq!(evidence.tables[0].rows[2][0].column, 1);
    }

    #[test]
    fn parses_accessibility_and_link_evidence_without_conflating_caption_and_alt() {
        let jats = r##"<article xmlns:xlink="http://www.w3.org/1999/xlink"><body>
          <sec id="s1"><title>Methods</title><p>See <xref ref-type="fig" rid="f1">Figure 1</xref>.</p>
          <fig id="f1"><label>Figure 1</label><caption><title>Flow</title></caption><alt-text>A directed flow diagram</alt-text></fig>
          <disp-formula id="e1"><label>(1)</label><tex-math>E = mc2</tex-math></disp-formula></sec>
          <ref-list><ref id="r1"><label>1</label><element-citation>Example paper <pub-id pub-id-type="doi">10.1/example</pub-id></element-citation></ref></ref-list>
        </body></article>"##;
        let evidence = parse_xml_source(jats).unwrap();
        assert_eq!(evidence.figures[0].caption, "Flow");
        assert_eq!(
            evidence.figures[0].alt_text.as_deref(),
            Some("A directed flow diagram")
        );
        assert_eq!(evidence.formulas[0].id, "e1");
        assert_eq!(evidence.sections[0].level, 1);
        assert_eq!(evidence.cross_references[0].target_id, "f1");
        assert_eq!(
            evidence.references[0].external_url.as_deref(),
            Some("https://doi.org/10.1/example")
        );
    }

    #[test]
    fn partitions_xml_rows_monotonically_by_visible_page_text() {
        let table = XmlTable {
            id: "t".into(),
            label: String::new(),
            caption: String::new(),
            rows: vec![
                vec![XmlCell {
                    text: "Header Value".into(),
                    column: 0,
                    row_span: 1,
                    column_span: 1,
                }],
                vec![XmlCell {
                    text: "Alpha 10".into(),
                    column: 0,
                    row_span: 1,
                    column_span: 1,
                }],
                vec![XmlCell {
                    text: "Beta 20".into(),
                    column: 0,
                    row_span: 1,
                    column_span: 1,
                }],
                vec![XmlCell {
                    text: "Gamma 30".into(),
                    column: 0,
                    row_span: 1,
                    column_span: 1,
                }],
            ],
        };
        assert_eq!(
            monotonic_row_ranges(
                &table,
                &[
                    "Header Value Alpha 10".into(),
                    "Header Value Beta 20 Gamma 30".into()
                ]
            ),
            vec![(0, 2), (2, 4)]
        );
    }
}
