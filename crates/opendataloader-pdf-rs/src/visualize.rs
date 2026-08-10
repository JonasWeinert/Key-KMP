use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use image::{Rgba, RgbaImage};
use pdfium_render::prelude::*;

use crate::extract::bind_pdfium;
use crate::metrics::Profiler;
use crate::model::{BBox, Block, Document, Page};

const PARAGRAPH: Rgba<u8> = Rgba([28, 107, 255, 255]);
const HEADING: Rgba<u8> = Rgba([204, 32, 143, 255]);
const TABLE: Rgba<u8> = Rgba([0, 151, 91, 255]);
const IMAGE: Rgba<u8> = Rgba([238, 117, 24, 255]);
const HEADER: Rgba<u8> = Rgba([0, 154, 188, 255]);
const FOOTER: Rgba<u8> = Rgba([100, 116, 139, 255]);
const PAGE_NUMBER: Rgba<u8> = Rgba([124, 58, 237, 255]);
const REFERENCE_LIST: Rgba<u8> = Rgba([180, 83, 9, 255]);
const REFERENCE_ITEM: Rgba<u8> = Rgba([217, 119, 6, 255]);
const NOTE: Rgba<u8> = Rgba([202, 138, 4, 255]);
const CITATION: Rgba<u8> = Rgba([220, 38, 38, 255]);
const NOTE_REFERENCE: Rgba<u8> = Rgba([147, 51, 234, 255]);
const STRUCTURE_REGION: Rgba<u8> = Rgba([14, 165, 233, 255]);

/// Renders selected PDF pages and overlays the semantic layout carried by the
/// converted document. Coordinates are scaled independently to the actual
/// PDFium bitmap dimensions, which keeps crop boxes and page rotation aligned.
pub fn render_layout_visualizations(
    pdf_path: &Path,
    password: Option<&str>,
    document: &Document,
    output_dir: &Path,
    scale: f32,
) -> Result<Vec<PathBuf>> {
    let mut profiler = None;
    render_layout_visualizations_profiled(
        pdf_path,
        password,
        document,
        output_dir,
        scale,
        &mut profiler,
    )
}

pub fn render_layout_visualizations_profiled(
    pdf_path: &Path,
    password: Option<&str>,
    document: &Document,
    output_dir: &Path,
    scale: f32,
    profiler: &mut Option<&mut Profiler>,
) -> Result<Vec<PathBuf>> {
    anyhow::ensure!(
        scale > 0.0 && scale.is_finite(),
        "visualization scale must be positive"
    );
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create visualization directory {}", output_dir.display()))?;

    let before = profiler.as_deref().map(Profiler::start);
    let pdfium = bind_pdfium()?;
    let pdf = pdfium
        .load_pdf_from_file(pdf_path, password)
        .with_context(|| format!("open {} for visualization", pdf_path.display()))?;
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("visualization_document_load", before);
    }
    let render_config = PdfRenderConfig::new().scale_page_by_factor(scale);
    let mut outputs = Vec::with_capacity(document.pages.len());

    for model_page in &document.pages {
        let page_index =
            i32::try_from(model_page.number - 1).context("page index exceeds PDFium limit")?;
        let before = profiler.as_deref().map(Profiler::start);
        let pdf_page = pdf.pages().get(page_index)?;
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("visualization_page_load", before);
        }
        let before = profiler.as_deref().map(Profiler::start);
        let mut canvas = pdf_page
            .render_with_config(&render_config)?
            .as_image()?
            .to_rgba8();
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("visualization_pdfium_render", before);
        }
        let before = profiler.as_deref().map(Profiler::start);
        draw_page_overlay(&mut canvas, model_page);
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("visualization_overlay_drawing", before);
        }
        let output = output_dir.join(format!("page-{:03}.png", model_page.number));
        let before = profiler.as_deref().map(Profiler::start);
        canvas
            .save(&output)
            .with_context(|| format!("write {}", output.display()))?;
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("visualization_png_encoding", before);
        }
        let before = profiler.as_deref().map(Profiler::start);
        drop(canvas);
        drop(pdf_page);
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("visualization_page_release", before);
        }
        outputs.push(output);
    }
    let before = profiler.as_deref().map(Profiler::start);
    drop(pdf);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("visualization_document_close", before);
    }
    Ok(outputs)
}

fn draw_page_overlay(canvas: &mut RgbaImage, page: &Page) {
    let scale_x = canvas.width() as f32 / page.width.max(1.0);
    let scale_y = canvas.height() as f32 / page.height.max(1.0);
    for (index, block) in page.blocks.iter().enumerate() {
        let (color, label) = match block {
            Block::Paragraph { .. } => (PARAGRAPH, format!("{} P", index + 1)),
            Block::Heading { level, .. } => (HEADING, format!("{} H{}", index + 1, level)),
            Block::Table { rows, columns, .. } => {
                (TABLE, format!("{} TABLE {}X{}", index + 1, rows, columns))
            }
            Block::List { ordered, items, .. } => (
                HEADING,
                format!(
                    "{} {}LIST {}",
                    index + 1,
                    if *ordered { "O" } else { "U" },
                    items.len()
                ),
            ),
            Block::Equation { label, .. } => (
                NOTE_REFERENCE,
                format!(
                    "{} EQUATION{}",
                    index + 1,
                    label
                        .as_deref()
                        .map(|v| format!(" {v}"))
                        .unwrap_or_default()
                ),
            ),
            Block::Algorithm { title, .. } => (
                TABLE,
                format!(
                    "{} ALGORITHM {}",
                    index + 1,
                    title.split_whitespace().nth(1).unwrap_or("")
                ),
            ),
            Block::Header { .. } => (HEADER, format!("{} HEADER", index + 1)),
            Block::Footer { .. } => (FOOTER, format!("{} FOOTER", index + 1)),
            Block::PageNumber { value, .. } => {
                (PAGE_NUMBER, format!("{} PAGE {}", index + 1, value))
            }
            Block::ReferenceList { items, .. } => (
                REFERENCE_LIST,
                format!("{} REFERENCES {}", index + 1, items.len()),
            ),
            Block::Footnote { .. } => (NOTE, format!("{} FOOTNOTE", index + 1)),
            Block::EndnoteList { items, .. } => {
                (NOTE, format!("{} ENDNOTES {}", index + 1, items.len()))
            }
        };
        draw_annotation(canvas, block.bbox(), scale_x, scale_y, color, &label);
        if let Block::ReferenceList { items, .. } = block {
            for (item_index, item) in items.iter().enumerate() {
                let label = item
                    .label
                    .as_deref()
                    .map(|label| format!("REF {label}"))
                    .unwrap_or_else(|| {
                        if item.continued {
                            "REF CONT".to_owned()
                        } else {
                            format!("REF {}", item_index + 1)
                        }
                    });
                draw_annotation(canvas, item.bbox, scale_x, scale_y, REFERENCE_ITEM, &label);
            }
        }
        if let Block::EndnoteList { items, .. } = block {
            for item in items {
                draw_annotation(canvas, item.bbox, scale_x, scale_y, NOTE, "ENDNOTE");
            }
        }
    }
    for citation in &page.citations {
        draw_annotation(canvas, citation.bbox, scale_x, scale_y, CITATION, "CITE");
    }
    for reference in &page.note_references {
        draw_annotation(
            canvas,
            reference.bbox,
            scale_x,
            scale_y,
            NOTE_REFERENCE,
            "NOTE REF",
        );
    }
    for (index, bbox) in page.images.iter().enumerate() {
        draw_annotation(
            canvas,
            *bbox,
            scale_x,
            scale_y,
            IMAGE,
            &format!("IMG {}", index + 1),
        );
    }
    for region in &page.semantic_regions {
        draw_annotation(
            canvas,
            region.bbox,
            scale_x,
            scale_y,
            STRUCTURE_REGION,
            &format!("TAG {} {:.0}%", region.role, region.confidence * 100.0),
        );
    }
}

fn draw_annotation(
    canvas: &mut RgbaImage,
    bbox: BBox,
    scale_x: f32,
    scale_y: f32,
    color: Rgba<u8>,
    label: &str,
) {
    if bbox.width <= 0.0 || bbox.height <= 0.0 {
        return;
    }
    let max_x = canvas.width().saturating_sub(1) as i32;
    let max_y = canvas.height().saturating_sub(1) as i32;
    let x0 = (bbox.x * scale_x).floor() as i32;
    let y0 = (bbox.y * scale_y).floor() as i32;
    let x1 = (bbox.right() * scale_x).ceil() as i32;
    let y1 = (bbox.bottom() * scale_y).ceil() as i32;
    let x0 = x0.clamp(0, max_x);
    let y0 = y0.clamp(0, max_y);
    let x1 = x1.clamp(x0, max_x);
    let y1 = y1.clamp(y0, max_y);

    fill_rect_alpha(canvas, x0, y0, x1, y1, color, 24);
    for inset in 0..3 {
        stroke_rect(
            canvas,
            x0 + inset,
            y0 + inset,
            x1 - inset,
            y1 - inset,
            color,
        );
    }

    let text_scale = 2;
    let text_width = label.chars().count() as i32 * 6 * text_scale;
    let label_width = (text_width + 6).min(max_x + 1);
    let label_height = 7 * text_scale + 6;
    let label_x = x0.min((max_x + 1 - label_width).max(0));
    let label_y = if y0 >= label_height {
        y0 - label_height
    } else {
        y0
    };
    fill_rect(
        canvas,
        label_x,
        label_y,
        label_x + label_width - 1,
        label_y + label_height - 1,
        color,
    );
    draw_text(
        canvas,
        label_x + 3,
        label_y + 3,
        label,
        text_scale,
        Rgba([255, 255, 255, 255]),
    );
}

fn stroke_rect(canvas: &mut RgbaImage, x0: i32, y0: i32, x1: i32, y1: i32, color: Rgba<u8>) {
    if x1 < x0 || y1 < y0 {
        return;
    }
    for x in x0..=x1 {
        put_pixel(canvas, x, y0, color);
        put_pixel(canvas, x, y1, color);
    }
    for y in y0..=y1 {
        put_pixel(canvas, x0, y, color);
        put_pixel(canvas, x1, y, color);
    }
}

fn fill_rect(canvas: &mut RgbaImage, x0: i32, y0: i32, x1: i32, y1: i32, color: Rgba<u8>) {
    for y in y0.max(0)..=y1.min(canvas.height() as i32 - 1) {
        for x in x0.max(0)..=x1.min(canvas.width() as i32 - 1) {
            canvas.put_pixel(x as u32, y as u32, color);
        }
    }
}

fn fill_rect_alpha(
    canvas: &mut RgbaImage,
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    color: Rgba<u8>,
    alpha: u8,
) {
    let alpha = alpha as u16;
    for y in y0.max(0)..=y1.min(canvas.height() as i32 - 1) {
        for x in x0.max(0)..=x1.min(canvas.width() as i32 - 1) {
            let pixel = canvas.get_pixel_mut(x as u32, y as u32);
            for channel in 0..3 {
                pixel[channel] = (((pixel[channel] as u16 * (255 - alpha))
                    + color[channel] as u16 * alpha)
                    / 255) as u8;
            }
        }
    }
}

fn draw_text(canvas: &mut RgbaImage, mut x: i32, y: i32, text: &str, scale: i32, color: Rgba<u8>) {
    for ch in text.chars() {
        for (row, bits) in glyph(ch).iter().enumerate() {
            for column in 0..5 {
                if bits & (1 << (4 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        put_pixel(
                            canvas,
                            x + column * scale + dx,
                            y + row as i32 * scale + dy,
                            color,
                        );
                    }
                }
            }
        }
        x += 6 * scale;
    }
}

fn put_pixel(canvas: &mut RgbaImage, x: i32, y: i32, color: Rgba<u8>) {
    if x >= 0 && y >= 0 && x < canvas.width() as i32 && y < canvas.height() as i32 {
        canvas.put_pixel(x as u32, y as u32, color);
    }
}

fn glyph(ch: char) -> [u8; 7] {
    match ch.to_ascii_uppercase() {
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '6' => [14, 16, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 25, 21, 19, 17, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        ' ' => [0; 7],
        _ => [31, 1, 2, 4, 4, 0, 4],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_draws_box_and_label() {
        let mut canvas = RgbaImage::from_pixel(200, 200, Rgba([255, 255, 255, 255]));
        draw_annotation(
            &mut canvas,
            BBox {
                x: 20.0,
                y: 30.0,
                width: 80.0,
                height: 40.0,
            },
            1.0,
            1.0,
            HEADING,
            "1 H2",
        );
        assert_eq!(*canvas.get_pixel(20, 30), HEADING);
        assert_ne!(*canvas.get_pixel(40, 50), Rgba([255, 255, 255, 255]));
    }
}
