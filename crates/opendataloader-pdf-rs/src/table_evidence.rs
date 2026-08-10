//! Lossless, table-scoped evidence export for training and diagnostics.
//!
//! Coordinates use the converter's top-left page coordinate system in PDF
//! points. Raw lopdf operands retain their native PDF bottom-left coordinates.

use std::{collections::BTreeMap, path::Path};

use anyhow::{Context, Result};
use lopdf::{content::Content, Document as LoDocument};
use pdfium_render::prelude::*;
use serde::Serialize;

use crate::{
    extract::bind_pdfium,
    model::{BBox, Block, Document, TableCell},
};

#[derive(Serialize)]
pub struct TableEvidenceDocument {
    pub schema_version: &'static str,
    pub source_pdf: String,
    pub coordinate_system: &'static str,
    pub tables: Vec<TableEvidence>,
}

#[derive(Serialize)]
pub struct TableEvidence {
    pub id: String,
    pub page: usize,
    pub bbox: BBox,
    pub rows: usize,
    pub columns: usize,
    pub ruled: bool,
    pub semantic_table_id: Option<String>,
    pub semantic_confidence: Option<f32>,
    /// Complete matching raw tag/MCID table evidence, when available.
    pub tagged_table: Option<crate::tagged_pdf::TaggedTableEvidence>,
    pub html: String,
    pub structure: Vec<RowEvidence>,
    pub text_layer: TextLayer,
    pub pdfium_vectors: Vec<VectorEvidence>,
    pub lopdf_content: RawContentEvidence,
}

#[derive(Serialize)]
pub struct RowEvidence {
    pub row: usize,
    pub cells: Vec<CellEvidence>,
}

#[derive(Serialize)]
pub struct CellEvidence {
    pub id: String,
    pub row: usize,
    pub column: usize,
    pub row_span: usize,
    pub column_span: usize,
    /// PDFium characters reconstructed inside the table-clipped cell.
    pub text: String,
    /// Original text emitted by the geometry/tag reconstruction.
    pub algorithm_text: String,
    pub bbox: BBox,
    pub text_layer_ids: Vec<String>,
    pub word_ids: Vec<String>,
    pub character_ids: Vec<String>,
    pub typography: TypographySummary,
    pub shading: ShadingEvidence,
}

#[derive(Default, Serialize)]
pub struct TypographySummary {
    pub fonts: BTreeMap<String, usize>,
    pub weights: BTreeMap<u16, usize>,
    pub sizes: BTreeMap<String, usize>,
    pub bold_character_fraction: f32,
}

#[derive(Default, Serialize)]
pub struct ShadingEvidence {
    pub detected: bool,
    pub confidence: f32,
    pub rgba: Option<[u8; 4]>,
    pub source_vector_ids: Vec<String>,
    pub coverage: f32,
    pub rationale: String,
}

#[derive(Serialize)]
pub struct TextLayer {
    pub characters: Vec<CharacterEvidence>,
    pub words: Vec<WordEvidence>,
}

#[derive(Clone, Serialize)]
pub struct CharacterEvidence {
    pub id: String,
    pub source_index: usize,
    pub text: String,
    pub bbox: BBox,
    pub font_name: String,
    pub font_size: f32,
    pub font_weight: u16,
    pub bold: bool,
    pub italic: bool,
    pub rotation: f32,
    pub fill_rgba: Option<[u8; 4]>,
    pub stroke_rgba: Option<[u8; 4]>,
    pub render_mode: String,
}

#[derive(Serialize)]
pub struct WordEvidence {
    pub id: String,
    pub text: String,
    pub bbox: BBox,
    pub character_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct VectorEvidence {
    pub id: String,
    pub object_index: usize,
    pub bbox: BBox,
    pub fill_mode: String,
    pub filled: bool,
    pub stroked: bool,
    pub fill_rgba: Option<[u8; 4]>,
    pub stroke_rgba: Option<[u8; 4]>,
    pub stroke_width: Option<f32>,
    pub segments: Vec<PathSegmentEvidence>,
}

#[derive(Clone, Serialize)]
pub struct PathSegmentEvidence {
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub closes_subpath: bool,
}

#[derive(Serialize)]
pub struct RawContentEvidence {
    pub page_object_id: [u32; 2],
    pub content_stream_ids: Vec<[u32; 2]>,
    pub operators: Vec<RawOperator>,
}

#[derive(Serialize)]
pub struct RawOperator {
    pub stream_id: [u32; 2],
    pub index: usize,
    pub operator: String,
    pub operands: Vec<String>,
    pub graphics_state_depth: usize,
}

pub fn export(
    path: &Path,
    password: Option<&str>,
    document: &Document,
) -> Result<TableEvidenceDocument> {
    let pdfium = bind_pdfium()?;
    let pdf = pdfium.load_pdf_from_file(path, password)?;
    let raw = LoDocument::load(path)?;
    let raw_pages = raw.get_pages();
    let mut tables = Vec::new();
    for page in &document.pages {
        let pdf_page = pdf.pages().get(i32::try_from(page.number - 1)?)?;
        let page_text = extract_text_layer(&pdf_page, page.number)?;
        let vectors = extract_vectors(&pdf_page, page.number);
        let raw_content = extract_raw_content(
            &raw,
            *raw_pages
                .get(&(page.number as u32))
                .context("raw page missing")?,
        )?;
        for (block_index, block) in page.blocks.iter().enumerate() {
            let Block::Table {
                bbox,
                rows,
                columns,
                cells,
                ruled,
                semantic_table_id,
                semantic_confidence,
                ..
            } = block
            else {
                continue;
            };
            let id = format!("p{}-table{}", page.number, block_index);
            let scoped_text = TextLayer {
                characters: page_text
                    .characters
                    .iter()
                    .filter(|item| intersects(item.bbox, *bbox))
                    .cloned()
                    .collect(),
                words: page_text
                    .words
                    .iter()
                    .filter(|item| intersects(item.bbox, *bbox))
                    .map(|item| WordEvidence {
                        id: item.id.clone(),
                        text: item.text.clone(),
                        bbox: item.bbox,
                        character_ids: item.character_ids.clone(),
                    })
                    .collect(),
            };
            let scoped_vectors = vectors
                .iter()
                .filter(|item| intersects(item.bbox, *bbox))
                .cloned()
                .collect::<Vec<_>>();
            let structure =
                build_structure(&id, *bbox, *rows, cells, &scoped_text, &scoped_vectors);
            let html = evidence_table_html(*rows, *columns, &structure);
            tables.push(TableEvidence {
                id,
                page: page.number,
                bbox: *bbox,
                rows: *rows,
                columns: *columns,
                ruled: *ruled,
                semantic_table_id: semantic_table_id.clone(),
                semantic_confidence: *semantic_confidence,
                tagged_table: semantic_table_id.as_ref().and_then(|id| {
                    document
                        .structure
                        .as_ref()?
                        .tables
                        .iter()
                        .find(|table| &table.id == id)
                        .cloned()
                }),
                html,
                structure,
                text_layer: scoped_text,
                pdfium_vectors: scoped_vectors,
                lopdf_content: RawContentEvidence {
                    page_object_id: raw_content.page_object_id,
                    content_stream_ids: raw_content.content_stream_ids.clone(),
                    operators: raw_content
                        .operators
                        .iter()
                        .filter(|op| relevant_raw_operator(&op.operator))
                        .map(|op| RawOperator {
                            stream_id: op.stream_id,
                            index: op.index,
                            operator: op.operator.clone(),
                            operands: op.operands.clone(),
                            graphics_state_depth: op.graphics_state_depth,
                        })
                        .collect(),
                },
            });
        }
    }
    Ok(TableEvidenceDocument {
        schema_version: "table-evidence-v1",
        source_pdf: path.display().to_string(),
        coordinate_system:
            "top-left PDF points; lopdf operands remain native bottom-left user space",
        tables,
    })
}

fn extract_text_layer(page: &PdfPage<'_>, page_number: usize) -> Result<TextLayer> {
    let config = PdfRenderConfig::new().scale_page_by_factor(1.0);
    let rotation = page
        .rotation()
        .map(|value| value.as_degrees())
        .unwrap_or(0.0);
    let text = page.text()?;
    let mut characters = Vec::new();
    for (index, ch) in text.chars().iter().enumerate() {
        let Some(value) = ch.unicode_char() else {
            continue;
        };
        if value.is_control() {
            continue;
        }
        let Ok(bounds) = ch.loose_bounds().or_else(|_| ch.tight_bounds()) else {
            continue;
        };
        let bbox = viewport_bbox(page, &config, bounds)?;
        if bbox.area() <= 0.0 {
            continue;
        }
        let font_name = ch.font_name();
        let weight = super::extract::font_weight_number(ch.font_weight());
        characters.push(CharacterEvidence {
            id: format!("p{page_number}-ch{index}"),
            source_index: index,
            text: value.to_string(),
            bbox,
            font_name: font_name.clone(),
            font_size: ch.scaled_font_size().value,
            font_weight: weight,
            bold: weight >= 600,
            italic: font_name.to_ascii_lowercase().contains("italic")
                || font_name.to_ascii_lowercase().contains("oblique"),
            rotation: (ch.angle_degrees().unwrap_or(0.0) - rotation).rem_euclid(360.0),
            fill_rgba: ch.fill_color().ok().map(rgba),
            stroke_rgba: ch.stroke_color().ok().map(rgba),
            render_mode: format!("{:?}", ch.render_mode().ok()),
        });
    }
    let words = build_words(&characters, page_number);
    Ok(TextLayer { characters, words })
}

fn build_words(chars: &[CharacterEvidence], page: usize) -> Vec<WordEvidence> {
    let mut sorted = chars
        .iter()
        .filter(|ch| !ch.text.chars().all(char::is_whitespace))
        .collect::<Vec<_>>();
    sorted.sort_by(|a, b| {
        a.bbox
            .center_y()
            .total_cmp(&b.bbox.center_y())
            .then(a.bbox.x.total_cmp(&b.bbox.x))
    });
    let mut groups: Vec<Vec<&CharacterEvidence>> = Vec::new();
    for ch in sorted {
        let join = groups
            .last()
            .and_then(|group| group.last())
            .is_some_and(|previous| {
                (previous.bbox.center_y() - ch.bbox.center_y()).abs()
                    <= previous.bbox.height.max(ch.bbox.height) * 0.45
                    && ch.bbox.x - previous.bbox.right()
                        <= previous.font_size.min(ch.font_size) * 0.18
            });
        if join {
            groups.last_mut().unwrap().push(ch);
        } else {
            groups.push(vec![ch]);
        }
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| WordEvidence {
            id: format!("p{page}-w{index}"),
            text: group.iter().map(|ch| ch.text.as_str()).collect(),
            bbox: group
                .iter()
                .map(|ch| ch.bbox)
                .reduce(BBox::union)
                .unwrap_or_default(),
            character_ids: group.iter().map(|ch| ch.id.clone()).collect(),
        })
        .collect()
}

fn extract_vectors(page: &PdfPage<'_>, page_number: usize) -> Vec<VectorEvidence> {
    let config = PdfRenderConfig::new().scale_page_by_factor(1.0);
    page.objects()
        .iter()
        .enumerate()
        .filter_map(|(index, object)| {
            let path = object.as_path_object()?;
            let bounds = object.bounds().ok()?;
            let bbox = viewport_bbox_edges(
                page,
                &config,
                bounds.left(),
                bounds.top(),
                bounds.right(),
                bounds.bottom(),
            )
            .ok()?;
            let matrix = path.matrix().ok();
            let segments = matrix
                .map(|m| path.segments().transform(m))
                .unwrap_or_else(|| path.segments());
            let segments = segments
                .iter()
                .filter_map(|segment| {
                    let point = segment.point();
                    let (x, y) = page.points_to_pixels(point.0, point.1, &config).ok()?;
                    Some(PathSegmentEvidence {
                        kind: format!("{:?}", segment.segment_type()),
                        x: x as f32,
                        y: y as f32,
                        closes_subpath: segment.is_close(),
                    })
                })
                .collect();
            let fill_mode = path.fill_mode().ok();
            let filled = fill_mode.is_some_and(|mode| mode != PdfPathFillMode::None);
            Some(VectorEvidence {
                id: format!("p{page_number}-path{index}"),
                object_index: index,
                bbox,
                fill_mode: format!("{fill_mode:?}"),
                filled,
                stroked: path.is_stroked().unwrap_or(false),
                fill_rgba: path.fill_color().ok().map(rgba),
                stroke_rgba: path.stroke_color().ok().map(rgba),
                stroke_width: path.stroke_width().ok().map(|v| v.value),
                segments,
            })
        })
        .collect()
}

fn extract_raw_content(doc: &LoDocument, page_id: lopdf::ObjectId) -> Result<RawContentEvidence> {
    let mut operators = Vec::new();
    let mut stream_ids = Vec::new();
    for id in doc.get_page_contents(page_id) {
        stream_ids.push([id.0, id.1.into()]);
        let bytes = doc.get_object(id)?.as_stream()?.decompressed_content()?;
        let content = Content::decode(&bytes)?;
        let mut depth = 0usize;
        for (index, operation) in content.operations.into_iter().enumerate() {
            if operation.operator == "Q" {
                depth = depth.saturating_sub(1);
            }
            operators.push(RawOperator {
                stream_id: [id.0, id.1.into()],
                index,
                operator: operation.operator.clone(),
                operands: operation
                    .operands
                    .iter()
                    .map(|value| format!("{value:?}"))
                    .collect(),
                graphics_state_depth: depth,
            });
            if operation.operator == "q" {
                depth += 1;
            }
        }
    }
    Ok(RawContentEvidence {
        page_object_id: [page_id.0, page_id.1.into()],
        content_stream_ids: stream_ids,
        operators,
    })
}

fn build_structure(
    table_id: &str,
    table_bbox: BBox,
    rows: usize,
    cells: &[TableCell],
    text: &TextLayer,
    vectors: &[VectorEvidence],
) -> Vec<RowEvidence> {
    (0..rows)
        .map(|row| RowEvidence {
            row,
            cells: cells
                .iter()
                .filter(|cell| cell.row == row)
                .map(|cell| {
                    let clipped_bbox =
                        intersection_bbox(cell.bbox, table_bbox).unwrap_or(cell.bbox);
                    let chars = text
                        .characters
                        .iter()
                        .filter(|item| clipped_bbox.contains_center(item.bbox))
                        .collect::<Vec<_>>();
                    let words = text
                        .words
                        .iter()
                        .filter(|item| clipped_bbox.contains_center(item.bbox))
                        .collect::<Vec<_>>();
                    let mut typography = TypographySummary::default();
                    for ch in &chars {
                        *typography.fonts.entry(ch.font_name.clone()).or_default() += 1;
                        *typography.weights.entry(ch.font_weight).or_default() += 1;
                        *typography
                            .sizes
                            .entry(format!("{:.2}", ch.font_size))
                            .or_default() += 1;
                    }
                    typography.bold_character_fraction = chars.iter().filter(|ch| ch.bold).count()
                        as f32
                        / chars.len().max(1) as f32;
                    CellEvidence {
                        id: format!("{table_id}-r{}c{}", cell.row, cell.column),
                        row: cell.row,
                        column: cell.column,
                        row_span: cell.row_span,
                        column_span: cell.column_span,
                        text: reconstruct_cell_text(&chars),
                        algorithm_text: cell.text.clone(),
                        bbox: clipped_bbox,
                        text_layer_ids: chars.iter().map(|ch| ch.id.clone()).collect(),
                        word_ids: words.iter().map(|word| word.id.clone()).collect(),
                        character_ids: chars.iter().map(|ch| ch.id.clone()).collect(),
                        typography,
                        shading: infer_shading(clipped_bbox, vectors),
                    }
                })
                .collect(),
        })
        .collect()
}

fn infer_shading(cell: BBox, vectors: &[VectorEvidence]) -> ShadingEvidence {
    let mut candidates = vectors
        .iter()
        .filter_map(|vector| {
            if !vector.filled || vector.fill_rgba.is_none() {
                return None;
            }
            let intersection = intersection_area(cell, vector.bbox);
            let coverage = intersection / cell.area().max(1.0);
            (coverage >= 0.55 && vector.bbox.area() <= cell.area() * 2.5)
                .then_some((vector, coverage))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
    let Some((best, coverage)) = candidates.first() else {
        return ShadingEvidence {
            rationale: "no filled vector covers at least 55% of cell".into(),
            ..Default::default()
        };
    };
    ShadingEvidence {
        detected: true,
        confidence: (0.55 + coverage * 0.4).min(0.98),
        rgba: best.fill_rgba,
        source_vector_ids: candidates
            .iter()
            .filter(|(_, c)| *c >= coverage - 0.05)
            .map(|(v, _)| v.id.clone())
            .collect(),
        coverage: *coverage,
        rationale:
            "filled PDFium path substantially covers the cell and is not much larger than it".into(),
    }
}

fn reconstruct_cell_text(chars: &[&CharacterEvidence]) -> String {
    let mut chars = chars.to_vec();
    chars.sort_by(|left, right| {
        left.bbox
            .center_y()
            .total_cmp(&right.bbox.center_y())
            .then(left.bbox.x.total_cmp(&right.bbox.x))
    });
    let mut output = String::new();
    let mut previous: Option<&CharacterEvidence> = None;
    for ch in chars {
        if let Some(before) = previous {
            let new_line = (before.bbox.center_y() - ch.bbox.center_y()).abs()
                > before.bbox.height.max(ch.bbox.height) * 0.45;
            let word_gap =
                ch.bbox.x - before.bbox.right() > before.font_size.min(ch.font_size) * 0.18;
            if new_line || word_gap {
                output.push(' ');
            }
        }
        output.push_str(&ch.text);
        previous = Some(ch);
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn evidence_table_html(rows: usize, columns: usize, structure: &[RowEvidence]) -> String {
    let mut out = String::from("<table><tbody>");
    for row in 0..rows {
        out.push_str("<tr>");
        for column in 0..columns {
            if let Some(cell) = structure
                .iter()
                .flat_map(|row| row.cells.iter())
                .find(|cell| cell.row == row && cell.column == column)
            {
                out.push_str("<td");
                if cell.row_span > 1 {
                    out.push_str(&format!(" rowspan=\"{}\"", cell.row_span));
                }
                if cell.column_span > 1 {
                    out.push_str(&format!(" colspan=\"{}\"", cell.column_span));
                }
                out.push('>');
                out.push_str(&escape_html(&cell.text));
                out.push_str("</td>");
            }
        }
        out.push_str("</tr>");
    }
    out.push_str("</tbody></table>");
    out
}

fn viewport_bbox(page: &PdfPage<'_>, config: &PdfRenderConfig, rect: PdfRect) -> Result<BBox> {
    viewport_bbox_edges(
        page,
        config,
        rect.left(),
        rect.top(),
        rect.right(),
        rect.bottom(),
    )
}

fn viewport_bbox_edges(
    page: &PdfPage<'_>,
    config: &PdfRenderConfig,
    left_edge: PdfPoints,
    top_edge: PdfPoints,
    right_edge: PdfPoints,
    bottom_edge: PdfPoints,
) -> Result<BBox> {
    let points = [
        (left_edge, top_edge),
        (right_edge, top_edge),
        (left_edge, bottom_edge),
        (right_edge, bottom_edge),
    ]
    .into_iter()
    .map(|(x, y)| page.points_to_pixels(x, y, config))
    .collect::<std::result::Result<Vec<_>, _>>()?;
    let left = points
        .iter()
        .map(|p| p.0 as f32)
        .fold(f32::INFINITY, f32::min);
    let right = points
        .iter()
        .map(|p| p.0 as f32)
        .fold(f32::NEG_INFINITY, f32::max);
    let top = points
        .iter()
        .map(|p| p.1 as f32)
        .fold(f32::INFINITY, f32::min);
    let bottom = points
        .iter()
        .map(|p| p.1 as f32)
        .fold(f32::NEG_INFINITY, f32::max);
    Ok(BBox {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}
fn rgba(color: PdfColor) -> [u8; 4] {
    [color.red(), color.green(), color.blue(), color.alpha()]
}
fn intersects(a: BBox, b: BBox) -> bool {
    intersection_area(a, b) > 0.0
}
fn intersection_area(a: BBox, b: BBox) -> f32 {
    (a.right().min(b.right()) - a.x.max(b.x)).max(0.0)
        * (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0.0)
}
fn intersection_bbox(a: BBox, b: BBox) -> Option<BBox> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = a.right().min(b.right());
    let bottom = a.bottom().min(b.bottom());
    (right > x && bottom > y).then_some(BBox {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}
fn relevant_raw_operator(op: &str) -> bool {
    matches!(
        op,
        "q" | "Q"
            | "cm"
            | "m"
            | "l"
            | "c"
            | "v"
            | "y"
            | "h"
            | "re"
            | "S"
            | "s"
            | "f"
            | "F"
            | "f*"
            | "B"
            | "B*"
            | "b"
            | "b*"
            | "n"
            | "W"
            | "W*"
            | "w"
            | "J"
            | "j"
            | "d"
            | "M"
            | "rg"
            | "RG"
            | "g"
            | "G"
            | "k"
            | "K"
            | "gs"
            | "Do"
            | "BMC"
            | "BDC"
            | "EMC"
    )
}
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
