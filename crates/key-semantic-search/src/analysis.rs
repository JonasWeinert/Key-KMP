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
    convert_file_cached(path, document_hash, onnx_enabled, None)
}

pub(crate) fn convert_file_cached(
    path: &Path,
    document_hash: String,
    onnx_enabled: bool,
    library: Option<key_library::Library>,
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

    let normalized = tempfile::NamedTempFile::new()?;
    let rotations = opendataloader_pdf::extract::normalize_page_rotations(path, normalized.path())?;
    let analysis_path = if rotations.iter().any(|rotation| *rotation != 0) {
        normalized.path()
    } else {
        path
    };
    let document = if let Some(library) = library {
        let mut cache = PageCache {
            library,
            hash: document_hash.clone(),
        };
        opendataloader_pdf::convert_with_page_cache(analysis_path, &options, &mut cache)
    } else {
        opendataloader_pdf::convert(analysis_path, &options)
    }
    .with_context(|| format!("semantic extraction failed for {}", path.display()))?;
    let mut dto = to_dto(
        document,
        document_hash,
        onnx_enabled,
        started.elapsed().as_secs_f64() * 1000.,
    );
    for page in &mut dto.pages {
        let rotation = rotations.get(page.page).copied().unwrap_or(0);
        if rotation == 90 || rotation == 270 {
            std::mem::swap(&mut page.width, &mut page.height);
        }
        for block in &mut page.blocks {
            block.bounds = rotate_rect(block.bounds, rotation);
            for sentence in &mut block.sentences {
                for rect in &mut sentence.rects {
                    *rect = rotate_rect(*rect, rotation);
                }
            }
        }
    }
    Ok(dto)
}

fn rotate_rect(rect: CompactRect, rotation: u16) -> CompactRect {
    let right = rect.x.saturating_add(rect.width);
    let bottom = rect.y.saturating_add(rect.height);
    match rotation {
        90 => CompactRect {
            x: u16::MAX - bottom,
            y: rect.x,
            width: rect.height,
            height: rect.width,
        },
        180 => CompactRect {
            x: u16::MAX - right,
            y: u16::MAX - bottom,
            width: rect.width,
            height: rect.height,
        },
        270 => CompactRect {
            x: rect.y,
            y: u16::MAX - right,
            width: rect.height,
            height: rect.width,
        },
        _ => rect,
    }
}

fn to_dto(
    document: Document,
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
        pages: document
            .pages
            .into_iter()
            .map(|page| to_page(&page))
            .collect(),
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
    fn rotated_cropped_pages_keep_reading_order_and_viewport_anchors() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/rotated-cropped.pdf");
        let hash = key_library::file_hash(&fixture).unwrap();
        let document = super::convert_file(&fixture, hash, false).unwrap();
        assert_eq!(document.pages.len(), 4);
        for page in &document.pages {
            let sentences = page
                .blocks
                .iter()
                .flat_map(|block| &block.sentences)
                .collect::<Vec<_>>();
            assert!(sentences.len() >= 25, "page {} lost text", page.page);
            assert!(
                sentences
                    .iter()
                    .any(|s| s.text.contains("Canonical evidence remains anchored")),
                "page {} reversed text",
                page.page
            );
            for sentence in sentences {
                for rect in &sentence.rects {
                    assert!(u32::from(rect.x) + u32::from(rect.width) <= 65535);
                    assert!(u32::from(rect.y) + u32::from(rect.height) <= 65535);
                }
            }
            if page.page % 2 == 0 {
                assert!(page.height > page.width);
            } else {
                assert!(page.width > page.height);
            }
        }
    }
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

struct PageCache {
    library: key_library::Library,
    hash: String,
}
impl opendataloader_pdf::extract::RawPageCache for PageCache {
    fn load(&mut self, index: usize) -> Result<Option<opendataloader_pdf::extract::RawPage>> {
        if self
            .library
            .is_paused(&self.hash)
            .map_err(anyhow::Error::msg)?
        {
            anyhow::bail!("Semantic extraction paused");
        }
        self.library
            .get(
                &self.hash,
                "semantic-raw-page",
                "pdfium-raw-v2",
                &index.to_string(),
            )
            .map_err(anyhow::Error::msg)
    }
    fn store(
        &mut self,
        index: usize,
        total: usize,
        page: &opendataloader_pdf::extract::RawPage,
    ) -> Result<()> {
        key_processing::check_batch_memory().map_err(anyhow::Error::msg)?;
        self.library
            .put(
                &self.hash,
                "semantic-raw-page",
                "pdfium-raw-v2",
                &index.to_string(),
                page,
            )
            .map_err(anyhow::Error::msg)?;
        self.library
            .progress(&self.hash, "processing", index + 1, total, None)
            .map_err(anyhow::Error::msg)
    }
}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;
    use opendataloader_pdf::extract::{RawPage, RawPageCache};
    struct InterruptedCache {
        pages: std::collections::HashMap<usize, Vec<u8>>,
        interrupt: bool,
        reused: usize,
    }
    impl RawPageCache for InterruptedCache {
        fn load(&mut self, index: usize) -> Result<Option<RawPage>> {
            self.pages
                .get(&index)
                .map(|bytes| {
                    self.reused += 1;
                    serde_json::from_slice(bytes).map_err(Into::into)
                })
                .transpose()
        }
        fn store(&mut self, index: usize, _: usize, page: &RawPage) -> Result<()> {
            self.pages.insert(index, serde_json::to_vec(page)?);
            if self.interrupt && index == 2 {
                anyhow::bail!("injected interruption");
            }
            Ok(())
        }
    }
    #[test]
    fn resumes_raw_pages_without_changing_reconciled_semantics() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/PUBMED_16226083.pdf");
        let hash = key_library::content_hash(&std::fs::read(&path).unwrap());
        let baseline = convert_file(&path, hash.clone(), false).unwrap();
        let mut cache = InterruptedCache {
            pages: Default::default(),
            interrupt: true,
            reused: 0,
        };
        assert!(
            opendataloader_pdf::convert_with_page_cache(
                &path,
                &ConvertOptions::default(),
                &mut cache
            )
            .is_err()
        );
        assert_eq!(cache.pages.len(), 3);
        cache.interrupt = false;
        let resumed = opendataloader_pdf::convert_with_page_cache(
            &path,
            &ConvertOptions::default(),
            &mut cache,
        )
        .unwrap();
        assert_eq!(cache.reused, 3);
        assert_eq!(to_dto(resumed, hash, false, 0.).pages, baseline.pages);
    }
}
