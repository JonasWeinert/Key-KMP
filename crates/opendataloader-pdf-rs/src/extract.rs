use anyhow::{Context, Result};
use libloading::Library;
use pdfium_render::prelude::*;
use std::collections::HashSet;
use std::ffi::CString;
use std::os::raw::{c_char, c_float, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::metrics::Profiler;
use crate::model::{BBox, InternalLink, MarkedObjectGeometry, Rule, Span, TextLine};

#[derive(Clone, Debug)]
struct Glyph {
    ch: char,
    bbox: BBox,
    font_size: f32,
    font_weight: u16,
    font_name: String,
    rotation: f32,
    explicit_space_before: bool,
}

pub struct RawPage {
    pub width: f32,
    pub height: f32,
    pub lines: Vec<TextLine>,
    pub rules: Vec<Rule>,
    pub images: Vec<BBox>,
    pub(crate) internal_links: Vec<InternalLink>,
    pub(crate) marked_objects: Vec<MarkedObjectGeometry>,
}

static PDFIUM: OnceLock<std::result::Result<Pdfium, String>> = OnceLock::new();

pub fn bind_pdfium() -> Result<&'static Pdfium> {
    let slot = PDFIUM.get_or_init(|| try_bind_pdfium().map_err(|error| format!("{error:#}")));
    slot.as_ref()
        .map_err(|error| anyhow::anyhow!(error.clone()))
}

fn try_bind_pdfium() -> Result<Pdfium> {
    if let Ok(path) = std::env::var("PDFIUM_LIB_PATH") {
        if let Ok(bindings) = Pdfium::bind_to_library(PathBuf::from(path)) {
            return Ok(Pdfium::new(bindings));
        }
    }
    if let Some(path) = option_env!("PDFIUM_BUNDLE_PATH") {
        if let Ok(bindings) = Pdfium::bind_to_library(path) {
            return Ok(Pdfium::new(bindings));
        }
    }
    let local = Pdfium::pdfium_platform_library_name_at_path(".");
    if let Ok(bindings) = Pdfium::bind_to_library(&local) {
        return Ok(Pdfium::new(bindings));
    }
    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .context("bind PDFium (set PDFIUM_LIB_PATH if no bundled library is available)")
}

pub fn extract_document(path: &Path, password: Option<&str>) -> Result<Vec<RawPage>> {
    let mut profiler = None;
    extract_document_profiled(path, password, &mut profiler)
}

pub(crate) fn extract_document_profiled(
    path: &Path,
    password: Option<&str>,
    profiler: &mut Option<&mut Profiler>,
) -> Result<Vec<RawPage>> {
    let before = profiler.as_deref().map(Profiler::start);
    let marked_objects = extract_marked_object_geometry(path, password).unwrap_or_default();
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, password)
        .with_context(|| format!("open {}", path.display()))?;
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("pdfium_document_load", before);
    }
    let mut pages = Vec::with_capacity(document.pages().len() as usize);
    for index in document.pages().as_range() {
        let before = profiler.as_deref().map(Profiler::start);
        let page = document.pages().get(index)?;
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("pdfium_page_load", before);
        }
        let mut raw_page = extract_page(&page, profiler)?;
        raw_page.marked_objects = marked_objects
            .get(index as usize)
            .cloned()
            .unwrap_or_default();
        let before = profiler.as_deref().map(Profiler::start);
        drop(page);
        if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
            profiler.record("pdfium_page_release", before);
        }
        pages.push(raw_page);
    }
    let before = profiler.as_deref().map(Profiler::start);
    drop(document);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("pdfium_document_close", before);
    }
    Ok(pages)
}

fn extract_page(page: &PdfPage<'_>, profiler: &mut Option<&mut Profiler>) -> Result<RawPage> {
    let width = page.width().value;
    let height = page.height().value;
    let render_config = PdfRenderConfig::new().scale_page_by_factor(1.0);
    let page_rotation = page.rotation().map(|r| r.as_degrees()).unwrap_or(0.0);
    let before = profiler.as_deref().map(Profiler::start);
    let text = page.text()?;
    let mut glyphs = Vec::new();
    let mut pending_space = false;
    for ch in text.chars().iter() {
        let Some(value) = ch.unicode_char() else {
            continue;
        };
        if value == '\n' || value == '\r' {
            pending_space = false;
            continue;
        }
        if value.is_whitespace() {
            pending_space = true;
            continue;
        }
        if value == '\0' || value == '\u{fffe}' || value == '\u{ffff}' {
            continue;
        }
        let rotation = (ch.angle_degrees().unwrap_or(0.0) - page_rotation).rem_euclid(360.0);
        // The Java core's target block stream is horizontal prose/tables.
        // Sideways archive stamps and chart labels otherwise fragment into
        // one-character body blocks and poison XY-cut projections.
        if !(rotation <= 5.0 || rotation >= 355.0 || (rotation - 180.0).abs() <= 5.0) {
            continue;
        }
        let bounds = ch.loose_bounds().or_else(|_| ch.tight_bounds());
        let Ok(bounds) = bounds else { continue };
        let corners = [
            (bounds.left(), bounds.top()),
            (bounds.right(), bounds.top()),
            (bounds.left(), bounds.bottom()),
            (bounds.right(), bounds.bottom()),
        ];
        let viewport: Vec<(f32, f32)> = corners
            .into_iter()
            .filter_map(|(x, y)| page.points_to_pixels(x, y, &render_config).ok())
            .map(|(x, y)| (x as f32, y as f32))
            .collect();
        if viewport.len() != 4 {
            continue;
        }
        let left = viewport.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
        let right = viewport
            .iter()
            .map(|p| p.0)
            .fold(f32::NEG_INFINITY, f32::max);
        let top = viewport.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
        let bottom = viewport
            .iter()
            .map(|p| p.1)
            .fold(f32::NEG_INFINITY, f32::max);
        let box_height = bottom - top;
        let box_width = right - left;
        if box_height < 0.25 || box_width <= 0.0 {
            continue;
        }
        let bbox = BBox {
            x: left,
            y: top,
            width: box_width,
            height: box_height,
        };
        glyphs.push(Glyph {
            ch: normalize_punctuation(value),
            bbox,
            font_size: ch.scaled_font_size().value.max(0.1),
            font_weight: font_weight_number(ch.font_weight()),
            font_name: ch.font_name(),
            rotation,
            explicit_space_before: std::mem::take(&mut pending_space),
        });
    }
    let lines = build_lines(glyphs);
    drop(text);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("pdfium_text_layer", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    let rules = extract_rules(page, height);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("pdfium_vector_paths", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    let images = extract_images(page);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("pdfium_image_objects", before);
    }
    let before = profiler.as_deref().map(Profiler::start);
    let internal_links = extract_internal_links(page);
    if let (Some(profiler), Some(before)) = (profiler.as_deref_mut(), before) {
        profiler.record("pdfium_internal_links", before);
    }
    Ok(RawPage {
        width,
        height,
        lines,
        rules,
        images,
        internal_links,
        marked_objects: Vec::new(),
    })
}

/// Uses PDFium's low-level page-object API to retain the bridge that the
/// high-level pdfium-render object wrappers currently omit: page-object MCID.
/// The document is opened independently but against the same bundled PDFium.
fn extract_marked_object_geometry(
    path: &Path,
    password: Option<&str>,
) -> Result<Vec<Vec<MarkedObjectGeometry>>> {
    type Handle = *mut c_void;
    let library_path = std::env::var_os("PDFIUM_LIB_PATH")
        .map(PathBuf::from)
        .or_else(|| option_env!("PDFIUM_BUNDLE_PATH").map(PathBuf::from))
        .unwrap_or_else(|| Pdfium::pdfium_platform_library_name_at_path("."));
    // SAFETY: the library path is the same trusted PDFium binary selected by
    // pdfium-render. All symbols below use signatures from PDFium's public C API.
    let library = unsafe { Library::new(&library_path) }
        .with_context(|| format!("load PDFium MCID bridge from {}", library_path.display()))?;
    let file = CString::new(path.to_string_lossy().as_bytes())?;
    let password = password.map(CString::new).transpose()?;
    // SAFETY: symbols are called only while `library` is alive; handles are
    // checked for null and closed in the reverse order in which they are opened.
    unsafe {
        let init = library.get::<unsafe extern "C" fn()>(b"FPDF_InitLibrary\0")?;
        let load_document = library
            .get::<unsafe extern "C" fn(*const c_char, *const c_char) -> Handle>(
                b"FPDF_LoadDocument\0",
            )?;
        let page_count =
            library.get::<unsafe extern "C" fn(Handle) -> c_int>(b"FPDF_GetPageCount\0")?;
        let load_page =
            library.get::<unsafe extern "C" fn(Handle, c_int) -> Handle>(b"FPDF_LoadPage\0")?;
        let page_height =
            library.get::<unsafe extern "C" fn(Handle) -> c_float>(b"FPDF_GetPageHeightF\0")?;
        let get_crop_box = library.get::<unsafe extern "C" fn(
            Handle,
            *mut c_float,
            *mut c_float,
            *mut c_float,
            *mut c_float,
        ) -> c_int>(b"FPDFPage_GetCropBox\0")?;
        let count_objects =
            library.get::<unsafe extern "C" fn(Handle) -> c_int>(b"FPDFPage_CountObjects\0")?;
        let get_object = library
            .get::<unsafe extern "C" fn(Handle, c_int) -> Handle>(b"FPDFPage_GetObject\0")?;
        let get_mcid = library
            .get::<unsafe extern "C" fn(Handle) -> c_int>(b"FPDFPageObj_GetMarkedContentID\0")?;
        let get_bounds = library.get::<unsafe extern "C" fn(
            Handle,
            *mut c_float,
            *mut c_float,
            *mut c_float,
            *mut c_float,
        ) -> c_int>(b"FPDFPageObj_GetBounds\0")?;
        let close_page = library.get::<unsafe extern "C" fn(Handle)>(b"FPDF_ClosePage\0")?;
        let close_document =
            library.get::<unsafe extern "C" fn(Handle)>(b"FPDF_CloseDocument\0")?;
        init();
        let document = load_document(
            file.as_ptr(),
            password
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
        );
        if document.is_null() {
            anyhow::bail!("PDFium MCID bridge could not open {}", path.display());
        }
        let mut pages = Vec::with_capacity(page_count(document).max(0) as usize);
        for page_index in 0..page_count(document).max(0) {
            let page = load_page(document, page_index);
            if page.is_null() {
                pages.push(Vec::new());
                continue;
            }
            let height = page_height(page);
            let (mut crop_left, mut crop_bottom, mut crop_right, mut crop_top) =
                (0.0, 0.0, 0.0, height);
            if get_crop_box(
                page,
                &mut crop_left,
                &mut crop_bottom,
                &mut crop_right,
                &mut crop_top,
            ) == 0
            {
                crop_left = 0.0;
                crop_top = height;
            }
            let mut objects = Vec::new();
            for object_index in 0..count_objects(page).max(0) {
                let object = get_object(page, object_index);
                if object.is_null() {
                    continue;
                }
                let mcid = get_mcid(object);
                if mcid < 0 {
                    continue;
                }
                let (mut left, mut bottom, mut right, mut top) = (0.0, 0.0, 0.0, 0.0);
                if get_bounds(object, &mut left, &mut bottom, &mut right, &mut top) == 0 {
                    continue;
                }
                let bbox = BBox {
                    x: left - crop_left,
                    y: crop_top - top,
                    width: right - left,
                    height: top - bottom,
                };
                if bbox.width > 0.0 && bbox.height > 0.0 {
                    objects.push(MarkedObjectGeometry {
                        mcid: i64::from(mcid),
                        bbox,
                    });
                }
            }
            close_page(page);
            pages.push(objects);
        }
        close_document(document);
        Ok(pages)
    }
}

fn extract_internal_links(page: &PdfPage<'_>) -> Vec<InternalLink> {
    let render_config = PdfRenderConfig::new().scale_page_by_factor(1.0);
    page.links()
        .iter()
        .filter_map(|link| {
            let target_page = if let Some(destination) = link.destination() {
                destination.page_index().ok()? as usize + 1
            } else {
                let action = link.action()?;
                let destination = action.as_local_destination_action()?.destination().ok()?;
                destination.page_index().ok()? as usize + 1
            };
            let rect = link.rect().ok()?;
            let points = [
                (rect.left(), rect.top()),
                (rect.right(), rect.top()),
                (rect.left(), rect.bottom()),
                (rect.right(), rect.bottom()),
            ];
            let viewport: Vec<(f32, f32)> = points
                .into_iter()
                .filter_map(|(x, y)| page.points_to_pixels(x, y, &render_config).ok())
                .map(|(x, y)| (x as f32, y as f32))
                .collect();
            if viewport.len() != 4 {
                return None;
            }
            let left = viewport
                .iter()
                .map(|point| point.0)
                .fold(f32::INFINITY, f32::min);
            let right = viewport
                .iter()
                .map(|point| point.0)
                .fold(f32::NEG_INFINITY, f32::max);
            let top = viewport
                .iter()
                .map(|point| point.1)
                .fold(f32::INFINITY, f32::min);
            let bottom = viewport
                .iter()
                .map(|point| point.1)
                .fold(f32::NEG_INFINITY, f32::max);
            let bbox = BBox {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            };
            (bbox.width > 0.0 && bbox.height > 0.0).then_some(InternalLink { bbox, target_page })
        })
        .collect()
}

fn extract_images(page: &PdfPage<'_>) -> Vec<BBox> {
    let render_config = PdfRenderConfig::new().scale_page_by_factor(1.0);
    page.objects()
        .iter()
        .filter(|object| object_contains_image(object))
        .filter_map(|object| object.bounds().ok())
        .filter_map(|bounds| {
            let points = [
                (bounds.left(), bounds.top()),
                (bounds.right(), bounds.top()),
                (bounds.left(), bounds.bottom()),
                (bounds.right(), bounds.bottom()),
            ];
            let viewport: Vec<(f32, f32)> = points
                .into_iter()
                .filter_map(|(x, y)| page.points_to_pixels(x, y, &render_config).ok())
                .map(|(x, y)| (x as f32, y as f32))
                .collect();
            if viewport.len() != 4 {
                return None;
            }
            let left = viewport.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
            let right = viewport
                .iter()
                .map(|p| p.0)
                .fold(f32::NEG_INFINITY, f32::max);
            let top = viewport.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
            let bottom = viewport
                .iter()
                .map(|p| p.1)
                .fold(f32::NEG_INFINITY, f32::max);
            let bbox = BBox {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            };
            (bbox.width >= 2.0 && bbox.height >= 2.0).then_some(bbox)
        })
        .collect()
}

fn object_contains_image(object: &PdfPageObject<'_>) -> bool {
    if object.as_image_object().is_some() {
        return true;
    }
    object
        .as_x_object_form_object()
        .is_some_and(|form| form.iter().any(|child| object_contains_image(&child)))
}

pub(crate) fn font_weight_number(weight: Option<PdfFontWeight>) -> u16 {
    match weight {
        Some(PdfFontWeight::Weight100) => 100,
        Some(PdfFontWeight::Weight200) => 200,
        Some(PdfFontWeight::Weight300) => 300,
        Some(PdfFontWeight::Weight400Normal) => 400,
        Some(PdfFontWeight::Weight500) => 500,
        Some(PdfFontWeight::Weight600) => 600,
        Some(PdfFontWeight::Weight700Bold) => 700,
        Some(PdfFontWeight::Weight800) => 800,
        Some(PdfFontWeight::Weight900) => 900,
        Some(PdfFontWeight::Custom(value)) => value.min(u16::MAX as u32) as u16,
        None => 400,
    }
}

fn normalize_punctuation(ch: char) -> char {
    match ch {
        '\u{0002}' => '-',
        '\u{2018}' | '\u{2019}' | '\u{201a}' => '\'',
        '\u{201c}' | '\u{201d}' | '\u{201e}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        _ => ch,
    }
}

fn build_lines(mut glyphs: Vec<Glyph>) -> Vec<TextLine> {
    glyphs.sort_by(|a, b| {
        a.bbox
            .center_y()
            .total_cmp(&b.bbox.center_y())
            .then(a.bbox.x.total_cmp(&b.bbox.x))
    });
    let mut rows: Vec<Vec<Glyph>> = Vec::new();
    for glyph in glyphs {
        let best = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let representative = &row[0];
                let tolerance = glyph.bbox.height.max(representative.bbox.height) * 0.45;
                let delta = (glyph.bbox.center_y() - representative.bbox.center_y()).abs();
                (delta <= tolerance).then_some((index, delta))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|x| x.0);
        if let Some(index) = best {
            rows[index].push(glyph);
        } else {
            rows.push(vec![glyph]);
        }
    }
    rows.sort_by(|a, b| a[0].bbox.center_y().total_cmp(&b[0].bbox.center_y()));
    let mut lines = Vec::new();
    for mut row in rows {
        row.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
        let mut run = Vec::new();
        for glyph in row {
            let split = run.last().is_some_and(|previous: &Glyph| {
                let gap = glyph.bbox.x - previous.bbox.right();
                // PDFium reports no semantic column boundary. Use the smaller
                // adjacent font when body text shares a baseline with a larger
                // heading in the next column; scaling from the larger glyph
                // can otherwise swallow a narrow journal gutter and mask the
                // column cut for the entire page. Ordinary word spaces are
                // typically 0.2-0.5 em, so 0.9 em remains conservative.
                let adjacent_font = glyph.font_size.min(previous.font_size);
                gap > 8.0_f32.max(adjacent_font * 0.90)
            });
            if split {
                lines.push(line_from_glyphs(std::mem::take(&mut run)));
            }
            run.push(glyph);
        }
        if !run.is_empty() {
            lines.push(line_from_glyphs(run));
        }
    }
    lines.sort_by(|a, b| {
        a.bbox
            .y
            .total_cmp(&b.bbox.y)
            .then(a.bbox.x.total_cmp(&b.bbox.x))
    });
    lines
}

fn line_from_glyphs(glyphs: Vec<Glyph>) -> TextLine {
    let bbox = glyphs
        .iter()
        .map(|g| g.bbox)
        .reduce(BBox::union)
        .unwrap_or_default();
    let mut spans = Vec::<Span>::new();
    for glyph in glyphs {
        let gap = spans
            .last()
            .map(|span| glyph.bbox.x - span.bbox.right())
            .unwrap_or(0.0);
        let add_space = glyph.explicit_space_before || gap > (glyph.font_size * 0.18).max(0.8);
        let same_style = !add_space
            && spans.last().is_some_and(|span| {
                span.font_name == glyph.font_name
                    && (span.font_size - glyph.font_size).abs() <= 0.35
                    && span.font_weight.abs_diff(glyph.font_weight) <= 100
                    && (span.rotation - glyph.rotation).abs() <= 1.0
            });
        if same_style {
            let span = spans.last_mut().unwrap();
            span.text.push(glyph.ch);
            span.bbox = span.bbox.union(glyph.bbox);
        } else {
            let mut text = String::new();
            text.push(glyph.ch);
            spans.push(Span {
                text,
                bbox: glyph.bbox,
                font_size: glyph.font_size,
                font_weight: glyph.font_weight,
                font_name: glyph.font_name,
                rotation: glyph.rotation,
            });
        }
    }
    let mut text = String::new();
    let mut previous_right = None;
    for span in &spans {
        if previous_right.is_some_and(|right| span.bbox.x - right > 0.1) {
            text.push(' ');
        }
        text.push_str(&span.text);
        previous_right = Some(span.bbox.right());
    }
    let total_chars: usize = spans
        .iter()
        .map(|s| s.text.chars().filter(|c| !c.is_whitespace()).count())
        .sum();
    let weighted_size = spans
        .iter()
        .map(|s| s.font_size * s.text.chars().filter(|c| !c.is_whitespace()).count() as f32)
        .sum::<f32>();
    let weighted_weight = spans
        .iter()
        .map(|s| s.font_weight as usize * s.text.chars().filter(|c| !c.is_whitespace()).count())
        .sum::<usize>();
    TextLine {
        text,
        bbox,
        font_size: if total_chars == 0 {
            bbox.height
        } else {
            weighted_size / total_chars as f32
        },
        font_weight: weighted_weight
            .checked_div(total_chars)
            .map_or(400, |weight| weight as u16),
        spans,
    }
}

fn extract_rules(page: &PdfPage<'_>, page_height: f32) -> Vec<Rule> {
    let mut rules = Vec::new();
    let mut filled_candidates = Vec::<(usize, Rule)>::new();
    let render_config = PdfRenderConfig::new().scale_page_by_factor(1.0);
    for (object_index, object) in page.objects().iter().enumerate() {
        let Some(path) = object.as_path_object() else {
            continue;
        };
        let stroked = path.is_stroked().unwrap_or(false);
        let filled = path
            .fill_mode()
            .map(|mode| mode != PdfPathFillMode::None)
            .unwrap_or(false);
        if !stroked && !filled {
            continue;
        }
        let width = path.stroke_width().map(|v| v.value).unwrap_or(1.0);
        let segments = match path.matrix() {
            Ok(matrix) => path.segments().transform(matrix),
            Err(_) => path.segments(),
        };
        let mut path_rules = Vec::new();
        let mut path_points = Vec::new();
        let mut previous: Option<(f32, f32)> = None;
        let mut start: Option<(f32, f32)> = None;
        for segment in segments.iter() {
            let point = segment.point();
            let point = page
                .points_to_pixels(point.0, point.1, &render_config)
                .map(|(x, y)| (x as f32, y as f32))
                .unwrap_or((point.0.value, page_height - point.1.value));
            path_points.push(point);
            match segment.segment_type() {
                PdfPathSegmentType::MoveTo => {
                    previous = Some(point);
                    start = Some(point);
                }
                PdfPathSegmentType::LineTo => {
                    if let Some((x, y)) = previous {
                        let rule = Rule {
                            x1: x,
                            y1: y,
                            x2: point.0,
                            y2: point.1,
                            width,
                        };
                        if rule.horizontal() || rule.vertical() {
                            path_rules.push(rule);
                        }
                    }
                    previous = Some(point);
                    if segment.is_close() {
                        if let (Some((x, y)), Some((sx, sy))) = (previous, start) {
                            let rule = Rule {
                                x1: x,
                                y1: y,
                                x2: sx,
                                y2: sy,
                                width,
                            };
                            if rule.horizontal() || rule.vertical() {
                                path_rules.push(rule);
                            }
                        }
                    }
                }
                _ => previous = Some(point),
            }
        }
        // Some generators paint table rules as narrow filled rectangles rather
        // than strokes. Admit only strongly line-like filled objects here:
        // unrestricted filled paths also include backgrounds, charts and
        // illustrations and would connect unrelated content into false grids.
        let accept_filled_rule = if !stroked && filled && !path_points.is_empty() {
            let left = path_points
                .iter()
                .map(|point| point.0)
                .fold(f32::MAX, f32::min);
            let right = path_points
                .iter()
                .map(|point| point.0)
                .fold(f32::MIN, f32::max);
            let top = path_points
                .iter()
                .map(|point| point.1)
                .fold(f32::MAX, f32::min);
            let bottom = path_points
                .iter()
                .map(|point| point.1)
                .fold(f32::MIN, f32::max);
            let path_width = right - left;
            let path_height = bottom - top;
            let long = path_width.max(path_height);
            let short = path_width.min(path_height);
            long >= 8.0 && short <= 3.0 && long >= short.max(0.25) * 4.0
        } else {
            false
        };
        if stroked {
            rules.extend(path_rules);
        } else if accept_filled_rule {
            let long_axis = path_rules
                .iter()
                .map(|rule| {
                    if rule.horizontal() {
                        (rule.x2 - rule.x1).abs()
                    } else {
                        (rule.y2 - rule.y1).abs()
                    }
                })
                .fold(0.0, f32::max);
            filled_candidates.extend(
                path_rules
                    .into_iter()
                    .filter(|rule| {
                        if !rule.horizontal() {
                            return false;
                        }
                        let length = if rule.horizontal() {
                            (rule.x2 - rule.x1).abs()
                        } else {
                            (rule.y2 - rule.y1).abs()
                        };
                        length >= long_axis * 0.8
                    })
                    .map(|rule| (object_index, rule)),
            );
        }
    }
    for (object_index, candidate) in &filled_candidates {
        let supporting_objects: HashSet<usize> = filled_candidates
            .iter()
            .filter(|(other_index, other)| {
                other_index != object_index
                    && candidate.horizontal() == other.horizontal()
                    && parallel_rule_overlap(*candidate, *other) >= 0.5
            })
            .map(|(other_index, _)| *other_index)
            .collect();
        if supporting_objects.len() >= 2 {
            rules.push(*candidate);
        }
    }
    rules
}

fn parallel_rule_overlap(a: Rule, b: Rule) -> f32 {
    let (a_start, a_end, b_start, b_end) = if a.horizontal() {
        (
            a.x1.min(a.x2),
            a.x1.max(a.x2),
            b.x1.min(b.x2),
            b.x1.max(b.x2),
        )
    } else {
        (
            a.y1.min(a.y2),
            a.y1.max(a.y2),
            b.y1.min(b.y2),
            b.y1.max(b.y2),
        )
    };
    let overlap = (a_end.min(b_end) - a_start.max(b_start)).max(0.0);
    overlap / (a_end - a_start).min(b_end - b_start).max(0.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn glyph(ch: char, x: f32, y: f32) -> Glyph {
        Glyph {
            ch,
            bbox: BBox {
                x,
                y,
                width: 5.0,
                height: 10.0,
            },
            font_size: 10.0,
            font_weight: 400,
            font_name: "Test".into(),
            rotation: 0.0,
            explicit_space_before: false,
        }
    }
    #[test]
    fn line_builder_splits_column_gap_and_restores_word_space() {
        let mut chars = vec![
            glyph('A', 0.0, 0.0),
            glyph('B', 8.0, 0.0),
            glyph('C', 100.0, 0.0),
        ];
        chars[1].explicit_space_before = true;
        let lines = build_lines(chars);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "A B");
        assert_eq!(lines[1].text, "C");
    }

    #[test]
    fn line_builder_splits_narrow_gutter_between_body_and_heading() {
        let mut body = glyph('a', 0.0, 1.0);
        body.bbox.width = 5.0;
        body.bbox.height = 9.0;
        body.font_size = 9.0;
        let mut heading = glyph('H', 17.0, 0.0);
        heading.bbox.height = 11.0;
        heading.font_size = 11.0;
        heading.font_weight = 600;

        let lines = build_lines(vec![body, heading]);
        let mut texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        texts.sort_unstable();

        assert_eq!(lines.len(), 2);
        assert_eq!(texts, ["H", "a"]);
    }
}
