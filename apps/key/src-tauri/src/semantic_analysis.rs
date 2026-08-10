use anyhow::{Context, Result};
use opendataloader_pdf::{
    ConvertOptions,
    model::{BBox, Block, Document, Sentence},
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Instant;

const QUANTIZATION_MAX: f32 = u16::MAX as f32;

/// A normalized page-local rectangle. Four u16 values occupy eight bytes in
/// the in-memory representation while retaining approximately 1/65,535 page
/// precision. This is more efficient and more accurate for sparse PDF text
/// than a bitmap, whose resolution would either waste memory or lose narrow
/// glyph/line geometry.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSentenceDto {
    /// UTF-8 byte offsets into the containing block's text.
    pub start: u32,
    pub end: u32,
    pub text: String,
    pub rects: Vec<CompactRect>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticBlockDto {
    pub kind: String,
    pub text: String,
    pub bounds: CompactRect,
    pub sentences: Vec<SemanticSentenceDto>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticPageDto {
    pub page: usize,
    pub width: f32,
    pub height: f32,
    pub blocks: Vec<SemanticBlockDto>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticDocumentDto {
    pub version: u8,
    pub document_hash: String,
    pub page_count: usize,
    pub onnx_enabled: bool,
    pub processing_ms: f64,
    pub pages: Vec<SemanticPageDto>,
}

pub fn convert_file(
    path: &Path,
    document_hash: String,
    onnx_enabled: bool,
) -> Result<SemanticDocumentDto> {
    let started = Instant::now();
    let options = ConvertOptions::default();
    #[cfg(feature = "semantic-onnx")]
    let options = if onnx_enabled {
        options.with_bundled_onnx()?
    } else {
        options
    };
    #[cfg(not(feature = "semantic-onnx"))]
    if onnx_enabled {
        anyhow::bail!(
            "semantic ONNX support is not compiled in; rebuild with --features semantic-onnx"
        );
    }

    let document = opendataloader_pdf::convert(path, &options)
        .with_context(|| format!("semantic extraction failed for {}", path.display()))?;
    Ok(to_dto(
        &document,
        document_hash,
        onnx_enabled,
        started.elapsed().as_secs_f64() * 1_000.0,
    ))
}

fn to_dto(
    document: &Document,
    document_hash: String,
    onnx_enabled: bool,
    processing_ms: f64,
) -> SemanticDocumentDto {
    SemanticDocumentDto {
        version: 1,
        document_hash,
        page_count: document.number_of_pages,
        onnx_enabled,
        processing_ms,
        pages: document.pages.iter().map(to_page).collect(),
    }
}

fn to_page(page: &opendataloader_pdf::model::Page) -> SemanticPageDto {
    SemanticPageDto {
        page: page.number.saturating_sub(1),
        width: page.width,
        height: page.height,
        blocks: page
            .blocks
            .iter()
            .enumerate()
            .map(|(index, block)| SemanticBlockDto {
                kind: block_kind(block).to_owned(),
                text: block.text(),
                bounds: quantize_bbox(block.bbox(), page.width, page.height),
                sentences: page
                    .sentences
                    .iter()
                    .filter(|sentence| sentence.block_index == index)
                    .map(|sentence| to_sentence(sentence, page.width, page.height))
                    .collect(),
            })
            .collect(),
    }
}

fn to_sentence(sentence: &Sentence, page_width: f32, page_height: f32) -> SemanticSentenceDto {
    SemanticSentenceDto {
        start: sentence.start.min(u32::MAX as usize) as u32,
        end: sentence.end.min(u32::MAX as usize) as u32,
        text: sentence.text.clone(),
        rects: sentence
            .rects
            .iter()
            .map(|bbox| quantize_bbox(*bbox, page_width, page_height))
            .collect(),
    }
}

fn quantize_bbox(bbox: BBox, page_width: f32, page_height: f32) -> CompactRect {
    let width = page_width.max(1.0);
    let height = page_height.max(1.0);
    let x = quantize(bbox.x / width);
    let y = quantize(bbox.y / height);
    let right = quantize(bbox.right() / width);
    let bottom = quantize(bbox.bottom() / height);
    CompactRect {
        x,
        y,
        width: right.saturating_sub(x),
        height: bottom.saturating_sub(y),
    }
}

fn quantize(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * QUANTIZATION_MAX).round() as u16
}

fn block_kind(block: &Block) -> &'static str {
    match block {
        Block::Paragraph { .. } => "paragraph",
        Block::Heading { .. } => "heading",
        Block::Table { .. } => "table",
        Block::List { .. } => "list",
        Block::Equation { .. } => "equation",
        Block::Algorithm { .. } => "algorithm",
        Block::Header { .. } => "header",
        Block::Footer { .. } => "footer",
        Block::PageNumber { .. } => "page_number",
        Block::ReferenceList { .. } => "reference_list",
        Block::Footnote { .. } => "footnote",
        Block::EndnoteList { .. } => "endnote_list",
    }
}

#[cfg(test)]
mod tests {
    use super::quantize_bbox;
    use opendataloader_pdf::model::BBox;

    #[test]
    fn quantized_rects_are_page_local_and_bounded() {
        let rect = quantize_bbox(
            BBox {
                x: 10.0,
                y: 20.0,
                width: 30.0,
                height: 40.0,
            },
            100.0,
            200.0,
        );
        assert_eq!(rect.x, 6_554);
        assert_eq!(rect.y, 6_554);
        assert_eq!(rect.width, 19_660);
        assert_eq!(rect.height, 13_107);
    }

    #[test]
    fn quantized_rects_clamp_geometry_outside_the_page() {
        let rect = quantize_bbox(
            BBox {
                x: -10.0,
                y: -10.0,
                width: 200.0,
                height: 300.0,
            },
            100.0,
            100.0,
        );
        assert_eq!(rect.x, 0);
        assert_eq!(rect.y, 0);
        assert_eq!(rect.width, u16::MAX);
        assert_eq!(rect.height, u16::MAX);
    }
}
