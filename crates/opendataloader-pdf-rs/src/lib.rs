mod algorithms;
mod document_semantics;
mod equations;
#[cfg(feature = "xml")]
pub mod external_xml;
pub mod extract;
mod heading_levels;
pub mod layout;
mod lists;
pub mod metrics;
pub mod model;
mod notes_citations;
#[cfg(feature = "onnx")]
pub mod onnx_layout;
pub mod reading_order;
mod sentences;
pub mod table_evidence;
pub mod table_partition;
pub mod tagged_pdf;
pub mod visualize;
#[cfg(feature = "xml")]
pub mod xml_fusion;

use std::path::Path;

use anyhow::Result;
use metrics::Profiler;
use model::{Block, Document, Page};
pub use tagged_pdf::TableReconciliationMode;

#[derive(Clone, Debug)]
pub struct ConvertOptions {
    pub password: Option<String>,
    pub pages: Option<Vec<usize>>,
    pub include_debug_lines: bool,
    /// Fuse the raw PDF structure tree and MCID geometry into the geometric
    /// layout result. Disable this only for controlled geometry-only baselines.
    pub reconcile_structure: bool,
    /// Determines whether table output comes from PDFium geometry, the PDF
    /// structure tree, or confidence-gated fusion of both.
    pub table_reconciliation: TableReconciliationMode,
    /// Minimum per-table trust score required to create a table directly from
    /// structure-tree and MCID evidence.
    pub tree_trust_threshold: f32,
    /// Optional normalized TEI or publisher JATS used as semantic evidence.
    pub xml_input: Option<std::path::PathBuf>,
    /// Optional PP-DocLayoutV3 model. When present, native ONNX layout
    /// detections are confidence-gated into the same geometry/tree/XML graph.
    pub onnx_model: Option<std::path::PathBuf>,
    pub table_partition: table_partition::TablePartitionConfig,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        Self {
            password: None,
            pages: None,
            include_debug_lines: false,
            reconcile_structure: true,
            table_reconciliation: TableReconciliationMode::Fused,
            tree_trust_threshold: 0.9,
            xml_input: None,
            onnx_model: None,
            table_partition: table_partition::TablePartitionConfig::default(),
        }
    }
}

impl ConvertOptions {
    /// Enable the bundled PP-DocLayoutV3 model. The model is shipped inside
    /// this crate, so this does not perform a network request.
    #[cfg(feature = "onnx")]
    pub fn with_bundled_onnx(mut self) -> Result<Self> {
        self.onnx_model = Some(bundled_onnx_model_path());
        Ok(self)
    }

    #[cfg(not(feature = "onnx"))]
    pub fn with_bundled_onnx(self) -> Result<Self> {
        anyhow::bail!("ONNX support is not compiled in; enable the `onnx` Cargo feature")
    }

    /// Reconcile a local publisher JATS or normalized TEI file with the PDF.
    #[cfg(feature = "xml")]
    pub fn with_xml(mut self, path: impl Into<std::path::PathBuf>) -> Result<Self> {
        self.xml_input = Some(path.into());
        Ok(self)
    }

    #[cfg(not(feature = "xml"))]
    pub fn with_xml(self, path: impl Into<std::path::PathBuf>) -> Result<Self> {
        let _ = path;
        anyhow::bail!("XML support is not compiled in; enable the `xml` Cargo feature")
    }
}

/// Path to the ONNX model bundled with this crate.
#[cfg(feature = "onnx")]
pub fn bundled_onnx_model_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("models")
        .join("model_fp16.onnx")
}

pub fn convert(path: &Path, options: &ConvertOptions) -> Result<Document> {
    let mut profiler = None;
    convert_internal(path, options, &mut profiler, None)
}

pub fn convert_profiled(path: &Path, options: &ConvertOptions) -> Result<(Document, Profiler)> {
    let mut profiler = Profiler::new();
    let document = convert_internal(path, options, &mut Some(&mut profiler), None)?;
    Ok((document, profiler))
}

/// Streams raw pages into reconstruction and persists resumable extraction checkpoints.
/// Document-wide reconciliation still sees the reconstructed pages together.
pub fn convert_with_page_cache(
    path: &Path,
    options: &ConvertOptions,
    cache: &mut dyn extract::RawPageCache,
) -> Result<Document> {
    convert_internal(path, options, &mut None, Some(cache))
}

fn convert_internal(
    path: &Path,
    options: &ConvertOptions,
    profiler: &mut Option<&mut Profiler>,
    cache: Option<&mut dyn extract::RawPageCache>,
) -> Result<Document> {
    #[cfg(not(feature = "onnx"))]
    if options.onnx_model.is_some() {
        anyhow::bail!("ONNX support is not compiled in; enable the `onnx` Cargo feature");
    }
    #[cfg(not(feature = "xml"))]
    if options.xml_input.is_some() {
        anyhow::bail!("XML support is not compiled in; enable the `xml` Cargo feature");
    }
    let before = profiler.as_deref().map(Profiler::start);
    let mut structure = tagged_pdf::inspect(path, options.password.as_deref()).ok();
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("raw_pdf_structure", before);
    }
    let mut pages = Vec::new();
    let number_of_pages = extract::extract_document_streamed(
        path,
        options.password.as_deref(),
        profiler,
        cache,
        |index, raw, profiler| {
            let number = index + 1;
            if options
                .pages
                .as_ref()
                .is_some_and(|selected| !selected.contains(&number))
            {
                return Ok(());
            }
            let reconstructed =
                layout::reconstruct_page_profiled(raw.lines, &raw.rules, raw.width, profiler);
            let page_rules = raw.rules.clone();
            let before = profiler.as_deref().map(Profiler::start);
            let mut images = raw.images;
            images.extend(infer_figure_regions(
                &reconstructed.blocks,
                raw.width,
                raw.height,
            ));
            deduplicate_regions(&mut images);
            if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
                profiler.record("image_figure_region_inference", before);
            }
            pages.push(Page {
                number,
                width: raw.width,
                height: raw.height,
                blocks: reconstructed.blocks,
                citations: Vec::new(),
                note_references: Vec::new(),
                sentences: Vec::new(),
                semantic_regions: Vec::new(),
                internal_links: raw.internal_links,
                marked_objects: raw.marked_objects,
                images,
                // Raw lines remain available through tagged reconciliation so a
                // semantic table can repair split geometric fragments. They are
                // removed immediately afterwards unless explicitly requested.
                lines: reconstructed.source_lines,
                rules: page_rules,
            });
            Ok(())
        },
    )?;
    let before = profiler.as_deref().map(Profiler::start);
    layout::reconcile_geometry_table_continuations(&mut pages);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("geometry_table_continuation", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    if options.reconcile_structure {
        if let Some(report) = structure.as_mut() {
            tagged_pdf::reconcile(
                report,
                &mut pages,
                options.table_reconciliation,
                options.tree_trust_threshold,
            );
        }
    }
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("tagged_table_reconciliation", before);
    }
    #[cfg(feature = "onnx")]
    if let Some(model_path) = options.onnx_model.as_deref() {
        let before = profiler.as_deref().map(Profiler::start);
        let detections = onnx_layout::detect_document(
            path,
            options.password.as_deref(),
            options.pages.as_deref(),
            model_path,
        )?;
        onnx_layout::reconcile(&mut pages, &detections);
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("onnx_layout_and_reconciliation", before);
        }
    }
    let before = profiler.as_deref().map(Profiler::start);
    table_partition::normalize_pages(&mut pages, &options.table_partition);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("table_partition_normalization", before);
    }
    #[cfg(feature = "xml")]
    let mut xml_evidence = None;
    #[cfg(feature = "xml")]
    if let Some(xml_path) = options.xml_input.as_deref() {
        let before = profiler.as_deref().map(Profiler::start);
        let evidence = xml_fusion::parse_xml_evidence(xml_path)?;
        xml_fusion::reconcile_xml(&evidence, &mut pages);
        xml_evidence = Some(evidence);
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("xml_semantic_reconciliation", before);
        }
    }
    if !options.include_debug_lines {
        for page in &mut pages {
            page.lines.clear();
        }
    }
    let before = profiler.as_deref().map(Profiler::start);
    algorithms::recognize_algorithms(&mut pages);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("geometry_algorithm_detection", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    equations::recognize_display_equations(&mut pages);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("geometry_equation_detection", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    document_semantics::recognize_document_semantics(&mut pages);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("document_semantics", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    lists::recognize_lists(&mut pages);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("geometry_list_detection", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    notes_citations::recognize_notes_and_citations(&mut pages);
    #[cfg(feature = "xml")]
    if let Some(evidence) = xml_evidence.as_ref() {
        xml_fusion::reconcile_references(&evidence.references, &mut pages);
        xml_fusion::link_citations(evidence, &mut pages);
    }
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("notes_citations_and_xml_links", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    sentences::recognize_sentences(&mut pages);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("sentence_coordinates", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    heading_levels::normalize_heading_levels(&mut pages);
    #[cfg(feature = "xml")]
    if let Some(evidence) = xml_evidence.as_ref() {
        xml_fusion::reconcile_sections(&evidence.sections, &mut pages);
    }
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("document_heading_normalization", before);
    }
    let page_labels = structure
        .as_ref()
        .map(|report| report.page_labels.clone())
        .unwrap_or_default();
    Ok(Document {
        file_name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        number_of_pages,
        pages,
        page_labels,
        structure,
    })
}

/// Many academic-paper figures are entirely vector content, so PDFium exposes
/// no image object to label. Figure captions provide a strong semantic anchor:
/// use the horizontal caption extent and the closest substantial block above
/// it to recover the visual region without treating ordinary vector rules as
/// images.
fn infer_figure_regions(blocks: &[Block], page_width: f32, page_height: f32) -> Vec<model::BBox> {
    let mut figures = Vec::new();
    for caption in blocks {
        let Block::Paragraph { bbox, text, .. } = caption else {
            continue;
        };
        let normalized = text.trim_start();
        if !normalized.starts_with("Figure ") || bbox.y < 40.0 {
            continue;
        }
        let default_top = (bbox.y - page_height * 0.75).max(0.0);
        let top = blocks
            .iter()
            .filter(|candidate| candidate.bbox().bottom() <= bbox.y - 24.0)
            .filter(|candidate| match candidate {
                Block::Heading { text, .. } => {
                    // Repeated labels such as "Input-Input Layer5" belong to
                    // the graphic itself, not to the surrounding document.
                    blocks
                        .iter()
                        .filter(|other| {
                            matches!(other, Block::Heading { text: other_text, .. } if other_text == text)
                                && other.bbox().y < bbox.y
                        })
                        .count()
                        == 1
                }
                Block::Paragraph { text, .. } => text.chars().count() >= 80,
                Block::List { items, .. } => items.iter().map(|item| item.text.len()).sum::<usize>() >= 80,
                Block::Table { .. } => true,
                Block::Header { .. }
                | Block::Footer { .. }
                | Block::PageNumber { .. }
                | Block::ReferenceList { .. }
                | Block::Footnote { .. }
                | Block::EndnoteList { .. } => false,
                Block::Equation { .. } => false,
                Block::Algorithm { .. } => false,
            })
            .map(|candidate| candidate.bbox().bottom())
            .filter(|bottom| *bottom >= default_top)
            .max_by(f32::total_cmp)
            .map(|bottom| bottom + 6.0)
            .unwrap_or(default_top);
        let bottom = bbox.y - 4.0;
        if bottom - top < 28.0 {
            continue;
        }
        let horizontal_padding = (bbox.width * 0.03).clamp(4.0, 16.0);
        let left = (bbox.x - horizontal_padding).max(0.0);
        let right = (bbox.right() + horizontal_padding).min(page_width);
        figures.push(model::BBox {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        });
    }
    figures
}

fn deduplicate_regions(regions: &mut Vec<model::BBox>) {
    regions.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    let mut unique = Vec::<model::BBox>::new();
    for region in regions.drain(..) {
        let duplicate = unique.iter().any(|existing| {
            let left = existing.x.max(region.x);
            let top = existing.y.max(region.y);
            let right = existing.right().min(region.right());
            let bottom = existing.bottom().min(region.bottom());
            let intersection = (right - left).max(0.0) * (bottom - top).max(0.0);
            intersection / existing.area().min(region.area()).max(1.0) > 0.8
        });
        if !duplicate {
            unique.push(region);
        }
    }
    *regions = unique;
}

pub fn to_markdown(document: &Document) -> String {
    let mut output = String::new();
    let notes: Vec<&model::NoteItem> = document
        .pages
        .iter()
        .flat_map(|page| page.blocks.iter())
        .flat_map(|block| match block {
            Block::Footnote { item, .. } => vec![item],
            Block::EndnoteList { items, .. } => items.iter().collect(),
            _ => Vec::new(),
        })
        .collect();
    for (page_index, page) in document.pages.iter().enumerate() {
        if page_index > 0 {
            output.push_str("\n\n---\n\n");
        }
        for (block_index, block) in page.blocks.iter().enumerate() {
            match block {
                Block::Heading { text, level, .. } => {
                    output.push_str(&"#".repeat((*level).clamp(1, 6) as usize));
                    output.push(' ');
                    output.push_str(text.trim());
                    output.push_str("\n\n");
                }
                Block::Paragraph { text, .. } => {
                    output.push_str(
                        render_note_references(text, block_index, &page.note_references).trim(),
                    );
                    output.push_str("\n\n");
                }
                Block::Table {
                    rows,
                    columns,
                    cells,
                    ..
                } => {
                    if *rows == 0 || *columns == 0 {
                        continue;
                    }
                    let mut grid = vec![vec![String::new(); *columns]; *rows];
                    for cell in cells {
                        if cell.row < *rows && cell.column < *columns {
                            grid[cell.row][cell.column] = escape_table_text(&cell.text);
                        }
                    }
                    output.push('|');
                    for cell in &grid[0] {
                        output.push(' ');
                        output.push_str(cell);
                        output.push_str(" |");
                    }
                    output.push('\n');
                    output.push('|');
                    for _ in 0..*columns {
                        output.push_str(" --- |");
                    }
                    output.push('\n');
                    for row in grid.iter().skip(1) {
                        output.push('|');
                        for cell in row {
                            output.push(' ');
                            output.push_str(cell);
                            output.push_str(" |");
                        }
                        output.push('\n');
                    }
                    output.push('\n');
                }
                Block::List { ordered, items, .. } => {
                    for (item_index, item) in items.iter().enumerate() {
                        output.push_str(&"  ".repeat(item.level));
                        if *ordered {
                            output.push_str(&format!("{}. ", item_index + 1));
                        } else {
                            output.push_str("- ");
                        }
                        output.push_str(item.text.trim());
                        output.push('\n');
                    }
                    output.push('\n');
                }
                Block::Equation {
                    text, latex, label, ..
                } => {
                    output.push_str("$$\n");
                    output.push_str(latex.as_deref().unwrap_or(text).trim());
                    if let Some(label) = label {
                        output.push(' ');
                        output.push_str(label);
                    }
                    output.push_str("\n$$\n\n");
                }
                Block::Algorithm { title, text, .. } => {
                    output.push_str("**");
                    output.push_str(title.trim());
                    output.push_str("**\n\n```text\n");
                    let body = text.strip_prefix(title).unwrap_or(text).trim();
                    output.push_str(body);
                    output.push_str("\n```\n\n");
                }
                Block::ReferenceList { items, .. } => {
                    for item in items {
                        if let Some(label) = &item.label {
                            output.push_str(label);
                            output.push_str(". ");
                        } else {
                            output.push_str("- ");
                        }
                        output.push_str(item.text.trim());
                        output.push('\n');
                    }
                    output.push('\n');
                }
                Block::Header { .. }
                | Block::Footer { .. }
                | Block::PageNumber { .. }
                | Block::Footnote { .. }
                | Block::EndnoteList { .. } => {}
            }
        }
    }
    if !notes.is_empty() {
        output.push_str("\n\n## Notes\n\n");
        for note in notes {
            output.push_str("[^");
            output.push_str(&note.id);
            output.push_str("]: ");
            output.push_str(note.text.trim());
            output.push('\n');
        }
    }
    output.trim_end().to_owned() + "\n"
}

fn render_note_references(
    text: &str,
    block_index: usize,
    references: &[model::NoteReference],
) -> String {
    let mut output = text.to_owned();
    let mut ranges: Vec<_> = references
        .iter()
        .filter(|reference| reference.block_index == block_index)
        .collect();
    ranges.sort_by_key(|reference| std::cmp::Reverse(reference.start));
    for reference in ranges {
        if reference.start <= reference.end
            && reference.end <= output.len()
            && output.is_char_boundary(reference.start)
            && output.is_char_boundary(reference.end)
        {
            output.replace_range(
                reference.start..reference.end,
                &format!("[^{}]", reference.note_id),
            );
        }
    }
    output
}

fn escape_table_text(text: &str) -> String {
    text.replace('|', "\\|").replace(['\n', '\r'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::BBox;

    fn paragraph(text: &str, y: f32) -> Block {
        Block::Paragraph {
            bbox: BBox {
                x: 100.0,
                y,
                width: 400.0,
                height: 30.0,
            },
            text: text.into(),
            lines: Vec::new(),
        }
    }

    fn heading(text: &str, y: f32) -> Block {
        Block::Heading {
            bbox: BBox {
                x: 100.0,
                y,
                width: 200.0,
                height: 25.0,
            },
            text: text.into(),
            level: 2,
            lines: Vec::new(),
        }
    }

    #[test]
    fn vector_figure_uses_caption_and_ignores_repeated_internal_labels() {
        let blocks = vec![
            heading("Input-Input Layer5", 100.0),
            heading("Input-Input Layer5", 320.0),
            paragraph("Figure 5: vector attention visualization", 600.0),
        ];
        let figures = infer_figure_regions(&blocks, 612.0, 792.0);
        assert_eq!(figures.len(), 1);
        assert_eq!(figures[0].y, 6.0);
        assert_eq!(figures[0].bottom(), 596.0);
    }
}
