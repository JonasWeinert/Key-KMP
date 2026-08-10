//! Native PP-DocLayoutV3 inference and conservative fusion with the PDF-native result.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use half::f16;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionOutputs};
use ort::value::{Shape, Tensor, Value};
use pdfium_render::prelude::*;

use crate::extract::bind_pdfium;
use crate::model::{BBox, Block, Page, SemanticRegion};

const INPUT: i64 = 800;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

#[derive(Clone, Debug)]
pub struct Detection {
    pub class_id: i32,
    pub score: f32,
    pub bbox: BBox,
}

pub fn detect_document(
    path: &Path,
    password: Option<&str>,
    selected_pages: Option<&[usize]>,
    model: &Path,
) -> Result<HashMap<usize, Vec<Detection>>> {
    let mut engine = Engine::open(model)?;
    let pdfium = bind_pdfium()?;
    let document = pdfium.load_pdf_from_file(path, password)?;
    let mut result = HashMap::new();
    for index in document.pages().as_range() {
        let number = index as usize + 1;
        if selected_pages.is_some_and(|pages| !pages.contains(&number)) {
            continue;
        }
        let page = document.pages().get(index)?;
        let width = page.width().value;
        let height = page.height().value;
        // 200 DPI, matching the Java main-app detector. The model itself is
        // 800x800; this preserves small text/rules before downsampling.
        let bitmap =
            page.render_with_config(&PdfRenderConfig::new().scale_page_by_factor(200.0 / 72.0))?;
        let rgba = bitmap.as_rgba_bytes();
        let detections = engine.infer(&rgba, bitmap.width() as u32, bitmap.height() as u32)?;
        let sx = width / bitmap.width() as f32;
        let sy = height / bitmap.height() as f32;
        result.insert(
            number,
            detections
                .into_iter()
                .map(|mut detection| {
                    detection.bbox.x *= sx;
                    detection.bbox.width *= sx;
                    detection.bbox.y *= sy;
                    detection.bbox.height *= sy;
                    detection
                })
                .collect(),
        );
    }
    Ok(result)
}

struct Engine {
    session: Session,
    image: String,
    shape: String,
    scale: String,
}

impl Engine {
    fn open(path: &Path) -> Result<Self> {
        let mut builder = Session::builder().map_err(ort_error)?;
        // Keep the distributable converter deterministic and portable. The
        // Core ML provider currently rejects this graph on some macOS/ORT
        // combinations during model compilation; CPU EP is available on all
        // supported desktop targets and is the benchmarked baseline.
        builder = builder
            .with_execution_providers([ort::ep::CPU::default().build()])
            .map_err(ort_error)?;
        builder = builder
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(ort_error)?;
        let session = builder
            .commit_from_file(path)
            .map_err(ort_error)
            .with_context(|| format!("load ONNX model {}", path.display()))?;
        let names: Vec<String> = session
            .inputs()
            .iter()
            .map(|v| v.name().to_owned())
            .collect();
        Ok(Self {
            image: input_name(&names, &["image"], 0),
            shape: input_name(&names, &["im_shape", "shape"], 1),
            scale: input_name(&names, &["scale_factor", "scale"], 2),
            session,
        })
    }

    fn infer(&mut self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<Detection>> {
        let resized = resize_nearest(rgba, width, height, INPUT as u32, INPUT as u32);
        let chw = normalize(&resized);
        let feeds: Vec<(String, Value)> = vec![
            (
                self.image.clone(),
                Value::from(
                    Tensor::from_array(([1_i64, 3, INPUT, INPUT], chw)).map_err(ort_error)?,
                ),
            ),
            (
                self.shape.clone(),
                Value::from(
                    Tensor::from_array(([1_i64, 2], vec![INPUT as f32, INPUT as f32]))
                        .map_err(ort_error)?,
                ),
            ),
            (
                self.scale.clone(),
                Value::from(
                    Tensor::from_array((
                        [1_i64, 2],
                        vec![INPUT as f32 / height as f32, INPUT as f32 / width as f32],
                    ))
                    .map_err(ort_error)?,
                ),
            ),
        ];
        let outputs = self.session.run(feeds).map_err(ort_error)?;
        parse_outputs(&outputs, width as f32, height as f32)
    }
}

fn parse_outputs(outputs: &SessionOutputs<'_>, width: f32, height: f32) -> Result<Vec<Detection>> {
    let count = outputs.iter().find_map(|(_, value)| {
        value
            .try_extract_tensor::<i32>()
            .ok()
            .and_then(|(shape, data)| {
                (shape.len() == 1 && !data.is_empty()).then_some(data[0].max(0) as usize)
            })
    });
    let mut best: Option<(Shape, Vec<f32>)> = None;
    for (_, value) in outputs.iter() {
        if let Ok((shape, data)) = value.try_extract_tensor::<f32>() {
            if shape.len() >= 2 && *shape.last().unwrap_or(&0) >= 6 {
                best = Some((shape.clone(), data.to_vec()));
            }
        } else if let Ok((shape, data)) = value.try_extract_tensor::<f16>() {
            if shape.len() >= 2 && *shape.last().unwrap_or(&0) >= 6 {
                best = Some((shape.clone(), data.iter().copied().map(f32::from).collect()));
            }
        }
    }
    let (shape, data) = best.context("ONNX model returned no detection matrix")?;
    let cols = *shape.last().unwrap() as usize;
    let rows = count.unwrap_or(data.len() / cols).min(data.len() / cols);
    let raw_rows: Vec<&[f32]> = data.chunks_exact(cols).take(rows).collect();
    let max_coordinate = raw_rows
        .iter()
        .flat_map(|row| [row[2], row[3], row[4], row[5]])
        .filter(|value| value.is_finite())
        .fold(0.0_f32, f32::max);
    // With scale_factor PP-DocLayout normally returns source-image pixels.
    // Some exported graphs instead retain 800x800 model space, so scale only
    // when all coordinates fit that space (same heuristic as the web viewer).
    let model_space = max_coordinate <= INPUT as f32 * 1.08
        && ((width - INPUT as f32).abs() > 2.0 || (height - INPUT as f32).abs() > 2.0);
    let sx = if model_space {
        width / INPUT as f32
    } else {
        1.0
    };
    let sy = if model_space {
        height / INPUT as f32
    } else {
        1.0
    };
    let mut result = Vec::new();
    for row in raw_rows {
        let score = row[1];
        if !score.is_finite() || !(0.0..=1.5).contains(&score) {
            continue;
        }
        let x1 = row[2].min(row[4]) * sx;
        let y1 = row[3].min(row[5]) * sy;
        let x2 = row[2].max(row[4]) * sx;
        let y2 = row[3].max(row[5]) * sy;
        if x2 > x1 && y2 > y1 {
            result.push(Detection {
                class_id: row[0].round() as i32,
                score,
                bbox: BBox {
                    x: x1,
                    y: y1,
                    width: x2 - x1,
                    height: y2 - y1,
                },
            });
        }
    }
    Ok(result)
}

/// Fuse only signals for which the visual model has demonstrated useful
/// precision. PP-DocLayout is authoritative for ambiguous outer table regions;
/// native geometry keeps authority only when it forms a dense, coherent grid
/// or has semantic/caption corroboration.
pub fn reconcile(pages: &mut [Page], detections: &HashMap<usize, Vec<Detection>>) {
    for page in pages {
        let Some(dets) = detections.get(&page.number) else {
            continue;
        };
        let accepted: Vec<&Detection> = dets
            .iter()
            .filter(|d| threshold(d.class_id) <= d.score)
            .collect();

        reconcile_table_regions(page, &accepted);

        for (index, d) in accepted.iter().enumerate() {
            let native_table_support = page.blocks.iter().any(|block| {
                matches!(block, Block::Table { .. }) && overlap(block.bbox(), d.bbox) >= 0.20
            });
            let figure_conflict = page
                .images
                .iter()
                .any(|bbox| overlap(*bbox, d.bbox) >= 0.35);
            if d.class_id == 21 && figure_conflict && !native_table_support {
                // PP-DocLayout occasionally calls heatmaps/plots tables. A
                // native image/figure region wins unless PDF geometry already
                // found an actual table at the same location.
                continue;
            }
            let role = match d.class_id {
                3 | 14 => "Figure",
                7 => "Caption",
                18 | 19 => "ReferenceRegion",
                21 => "TableRegion",
                _ => continue,
            };
            if role == "Figure" && !page.images.iter().any(|b| overlap(*b, d.bbox) > 0.80) {
                page.images.push(d.bbox);
            }
            if !page
                .semantic_regions
                .iter()
                .any(|r| r.role == role && overlap(r.bbox, d.bbox) > 0.85)
            {
                page.semantic_regions.push(SemanticRegion {
                    id: format!("onnx:{}:{}", page.number, index),
                    role: role.into(),
                    bbox: d.bbox,
                    confidence: d.score,
                    source: "onnx:pp-doclayoutv3".into(),
                    alt_text: None,
                    label: None,
                    caption: None,
                    target_id: None,
                    external_url: None,
                });
            }
        }

        // The detector is a candidate gate; typography/numbering/XML later
        // assigns the actual heading level.
        for block in &mut page.blocks {
            let Block::Paragraph { bbox, text, lines } = block else {
                continue;
            };
            let heading = accepted.iter().any(|d| {
                matches!(d.class_id, 6 | 17)
                    && overlap(*bbox, d.bbox) >= 0.62
                    && text.chars().count() <= 180
            });
            if heading {
                *block = Block::Heading {
                    bbox: *bbox,
                    text: std::mem::take(text),
                    level: 2,
                    lines: std::mem::take(lines),
                };
            }
        }
        page.blocks.retain(|block| {
            let Block::Heading { bbox, text, .. } = block else {
                return true;
            };
            !page.images.iter().any(|image| {
                image.area() < page.width * page.height * 0.80
                    && overlap(*bbox, *image) >= 0.85
                    && text.chars().count() <= 80
            })
        });
        dedupe_boxes(&mut page.images);
    }
}

fn reconcile_table_regions(page: &mut Page, accepted: &[&Detection]) {
    let table_priors: Vec<&Detection> = accepted
        .iter()
        .copied()
        .filter(|d| d.class_id == 21)
        .collect();
    let figure_priors: Vec<&Detection> = accepted
        .iter()
        .copied()
        .filter(|d| matches!(d.class_id, 3 | 14))
        .collect();
    let strengths: Vec<f32> = page
        .blocks
        .iter()
        .map(|block| geometry_table_strength(page, block))
        .collect();
    let strong_geometry: Vec<bool> = page
        .blocks
        .iter()
        .zip(&strengths)
        .map(|(block, strength)| {
            *strength >= 0.72
                || matches!(block,
                    Block::Table { rows, columns, cells, .. }
                    if *rows >= 4
                        && (2..=20).contains(columns)
                        && cells.len() as f32 / rows.saturating_mul(*columns).max(1) as f32 >= 0.80)
        })
        .collect();
    let mut assigned = vec![None; page.blocks.len()];

    for (index, block) in page.blocks.iter_mut().enumerate() {
        if !matches!(block, Block::Table { .. }) {
            continue;
        }
        let native = block.bbox();
        let best = table_priors
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| overlap(native, a.bbox).total_cmp(&overlap(native, b.bbox)))
            .filter(|(_, detection)| overlap(native, detection.bbox) >= 0.20);
        if let Some((prior_index, prior)) = best {
            assigned[index] = Some(prior_index);
            // Dense, well-ruled tables such as LTC/BRWS retain their precise
            // native envelope. Ambiguous/partial geometry adopts the visual
            // detector's region exactly instead of forming an ever-growing
            // union with it.
            let visual_expands_core =
                prior.bbox.width > native.width * 1.25 || prior.bbox.height > native.height * 1.25;
            if !strong_geometry[index] || visual_expands_core {
                if let Block::Table { bbox, .. } = block {
                    *bbox = prior.bbox;
                }
            }
        }
    }

    // Several geometric fragments inside one visual table are one region.
    // Retain the fragment with the richest usable structure and suppress the
    // duplicate regions. Strong independent grids are deliberately exempt.
    let mut remove = vec![false; page.blocks.len()];
    for prior_index in 0..table_priors.len() {
        let mut candidates: Vec<usize> = assigned
            .iter()
            .enumerate()
            .filter_map(|(index, assigned)| {
                (*assigned == Some(prior_index)
                    && !strong_geometry[index]
                    && matches!(page.blocks[index], Block::Table { .. }))
                .then_some(index)
            })
            .collect();
        if candidates.len() < 2 {
            continue;
        }
        candidates.sort_by(|a, b| {
            table_structure_quality(&page.blocks[*b])
                .total_cmp(&table_structure_quality(&page.blocks[*a]))
        });
        for index in candidates.into_iter().skip(1) {
            remove[index] = true;
        }
    }

    // An explicit visual figure prediction vetoes a weak native table when no
    // table prediction supports it. This targets plots, PRISMA diagrams and
    // boxed process graphics without weakening dense ruled tables.
    for (index, block) in page.blocks.iter().enumerate() {
        let Block::Table {
            semantic_table_id, ..
        } = block
        else {
            continue;
        };
        let bbox = block.bbox();
        let table_support = table_priors
            .iter()
            .any(|prior| overlap(bbox, prior.bbox) >= 0.25);
        let figure_support = figure_priors
            .iter()
            .any(|prior| overlap(bbox, prior.bbox) >= 0.55);
        let image_support = page
            .images
            .iter()
            .any(|image| overlap(bbox, *image) >= 0.55);
        if (figure_support || image_support) && !table_support && semantic_table_id.is_none() {
            remove[index] = true;
            continue;
        }
        // In ONNX mode, an unsupported weak geometric candidate is not a
        // table. Explicit figure evidence is the clearest veto, but the
        // detector's absence is itself meaningful once dense/caption/tagged
        // exceptions have been removed above.
        if !table_support && !strong_geometry[index] {
            remove[index] = true;
        }
    }
    let mut index = 0;
    page.blocks.retain(|_| {
        let keep = !remove[index];
        index += 1;
        keep
    });

    // ONNX can recover an outer table region even when native geometry found
    // no grid at all. Build a conservative text-row scaffold so JSON/Markdown
    // still receive a table block; XML/tag fusion may replace this provisional
    // structure later.
    for prior in table_priors {
        if page.blocks.iter().any(|block| {
            matches!(block, Block::Table { .. }) && overlap(block.bbox(), prior.bbox) >= 0.25
        }) {
            continue;
        }
        let figure_conflict = figure_priors
            .iter()
            .any(|figure| overlap(figure.bbox, prior.bbox) >= 0.55);
        if !figure_conflict {
            create_table_from_visual_region(page, prior.bbox);
        }
    }
}

fn create_table_from_visual_region(page: &mut Page, region: BBox) -> bool {
    let mut candidates: Vec<(usize, BBox, String)> = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            if matches!(block, Block::Table { .. }) {
                return None;
            }
            let bbox = block.bbox();
            let center_inside = bbox.center_x() >= region.x
                && bbox.center_x() <= region.right()
                && bbox.center_y() >= region.y
                && bbox.center_y() <= region.bottom();
            let text = block.text().trim().to_owned();
            (center_inside && !text.is_empty() && !text.to_ascii_lowercase().starts_with("table "))
                .then_some((index, bbox, text))
        })
        .collect();
    if candidates.len() < 4 {
        return false;
    }
    candidates.sort_by(|a, b| {
        a.1.center_y()
            .total_cmp(&b.1.center_y())
            .then(a.1.x.total_cmp(&b.1.x))
    });
    let mut visual_rows = Vec::<Vec<(usize, BBox, String)>>::new();
    for candidate in candidates {
        if let Some(row) = visual_rows.last_mut().filter(|row| {
            let band = row
                .iter()
                .map(|item| item.1)
                .reduce(|a, b| a.union(b))
                .unwrap();
            (band.center_y() - candidate.1.center_y()).abs()
                <= band.height.max(candidate.1.height).min(12.0) * 0.55
        }) {
            row.push(candidate);
        } else {
            visual_rows.push(vec![candidate]);
        }
    }
    if visual_rows.len() < 2 {
        return false;
    }
    for row in &mut visual_rows {
        row.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
    }
    let columns = visual_rows.iter().map(Vec::len).max().unwrap_or(1);
    let mut cells = Vec::new();
    let mut consumed = Vec::new();
    for (row_index, row) in visual_rows.into_iter().enumerate() {
        for (column, (block_index, bbox, text)) in row.into_iter().enumerate() {
            consumed.push(block_index);
            cells.push(crate::model::TableCell {
                row: row_index,
                column,
                row_span: 1,
                column_span: 1,
                text,
                bbox,
            });
        }
    }
    consumed.sort_unstable();
    consumed.dedup();
    for index in consumed.into_iter().rev() {
        page.blocks.remove(index);
    }
    page.blocks.push(Block::Table {
        bbox: region,
        rows: cells.iter().map(|cell| cell.row + 1).max().unwrap_or(1),
        columns,
        cells,
        ruled: false,
        semantic_table_id: None,
        semantic_confidence: None,
        continues_from_previous_page: false,
        continues_on_next_page: false,
    });
    true
}

fn geometry_table_strength(page: &Page, block: &Block) -> f32 {
    let Block::Table {
        bbox,
        rows,
        columns,
        cells,
        ruled,
        semantic_table_id,
        ..
    } = block
    else {
        return 0.0;
    };
    if semantic_table_id.is_some() {
        return 1.0;
    }
    let slots = rows.saturating_mul(*columns).max(1);
    let density = cells.len() as f32 / slots as f32;
    let horizontal = page
        .rules
        .iter()
        .filter(|rule| {
            rule.horizontal()
                && rule.y1 >= bbox.y - 2.0
                && rule.y1 <= bbox.bottom() + 2.0
                && axis_overlap(rule.x1, rule.x2, bbox.x, bbox.right()) >= 0.55
        })
        .count();
    let vertical = page
        .rules
        .iter()
        .filter(|rule| {
            rule.vertical()
                && rule.x1 >= bbox.x - 2.0
                && rule.x1 <= bbox.right() + 2.0
                && axis_overlap(rule.y1, rule.y2, bbox.y, bbox.bottom()) >= 0.55
        })
        .count();
    let caption = page.blocks.iter().any(|candidate| {
        let text = candidate.text();
        let normalized = text.trim().to_ascii_lowercase();
        normalized.starts_with("table ")
            && candidate.bbox().bottom() <= bbox.y + 8.0
            && bbox.y - candidate.bbox().bottom() <= page.height * 0.08
            && axis_overlap(
                candidate.bbox().x,
                candidate.bbox().right(),
                bbox.x,
                bbox.right(),
            ) >= 0.25
    });
    let mut score: f32 = 0.0;
    if *ruled {
        score += 0.12;
    }
    if density >= 0.80 {
        score += 0.42;
    } else if density >= 0.60 {
        score += 0.30;
    } else if density >= 0.45 {
        score += 0.14;
    }
    if (2..=20).contains(columns) && *rows >= 3 {
        score += 0.10;
    }
    if horizontal >= (*rows).min(5) {
        score += 0.16;
    }
    if vertical >= (*columns).min(4) {
        score += 0.12;
    }
    if caption {
        score += 0.30;
    }
    score.min(1.0)
}

fn table_structure_quality(block: &Block) -> f32 {
    let Block::Table {
        rows,
        columns,
        cells,
        ..
    } = block
    else {
        return 0.0;
    };
    let nonempty = cells
        .iter()
        .filter(|cell| !cell.text.trim().is_empty())
        .count();
    nonempty as f32 + cells.len() as f32 * 0.25 + (*rows * *columns) as f32 * 0.01
}

fn axis_overlap(a1: f32, a2: f32, b1: f32, b2: f32) -> f32 {
    let a_start = a1.min(a2);
    let a_end = a1.max(a2);
    let b_start = b1.min(b2);
    let b_end = b1.max(b2);
    (a_end.min(b_end) - a_start.max(b_start)).max(0.0)
        / (a_end - a_start).min(b_end - b_start).max(0.1)
}

fn threshold(class_id: i32) -> f32 {
    match class_id {
        21 => 0.45,
        3 | 14 => 0.55,
        7 => 0.50,
        18 | 19 => 0.50,
        6 | 17 => 0.58,
        _ => 2.0,
    }
}

fn overlap(a: BBox, b: BBox) -> f32 {
    let area = (a.right().min(b.right()) - a.x.max(b.x)).max(0.0)
        * (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0.0);
    area / a.area().min(b.area()).max(1.0)
}
fn dedupe_boxes(boxes: &mut Vec<BBox>) {
    let mut keep = Vec::new();
    for bbox in boxes.drain(..) {
        if !keep.iter().any(|other| overlap(*other, bbox) > 0.85) {
            keep.push(bbox);
        }
    }
    *boxes = keep;
}
fn ort_error(error: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{error}")
}
fn input_name(names: &[String], hints: &[&str], fallback: usize) -> String {
    names
        .iter()
        .find(|name| hints.iter().any(|hint| name.to_lowercase().contains(hint)))
        .cloned()
        .or_else(|| names.get(fallback).cloned())
        .unwrap_or_default()
}
fn resize_nearest(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut dst = vec![0; (dw * dh * 4) as usize];
    for y in 0..dh {
        for x in 0..dw {
            let si = ((((y as u64 * sh as u64 / dh as u64) as u32) * sw
                + (x as u64 * sw as u64 / dw as u64) as u32)
                * 4) as usize;
            let di = ((y * dw + x) * 4) as usize;
            dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
    dst
}
fn normalize(rgba: &[u8]) -> Vec<f32> {
    let plane = rgba.len() / 4;
    let mut result = vec![0.0; plane * 3];
    for (i, pixel) in rgba.chunks_exact(4).enumerate() {
        for channel in 0..3 {
            result[channel * plane + i] =
                (pixel[channel] as f32 / 255.0 - MEAN[channel]) / STD[channel];
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Rule, TableCell};

    fn test_page(blocks: Vec<Block>) -> Page {
        Page {
            number: 1,
            width: 600.0,
            height: 800.0,
            blocks,
            citations: Vec::new(),
            note_references: Vec::new(),
            sentences: Vec::new(),
            semantic_regions: Vec::new(),
            internal_links: Vec::new(),
            marked_objects: Vec::new(),
            images: Vec::new(),
            lines: Vec::new(),
            rules: Vec::<Rule>::new(),
        }
    }

    fn table(rows: usize, columns: usize, filled: usize) -> Block {
        Block::Table {
            bbox: BBox {
                x: 100.0,
                y: 100.0,
                width: 300.0,
                height: 200.0,
            },
            rows,
            columns,
            cells: (0..filled)
                .map(|index| TableCell {
                    row: index / columns,
                    column: index % columns,
                    row_span: 1,
                    column_span: 1,
                    text: index.to_string(),
                    bbox: BBox {
                        x: 100.0,
                        y: 100.0,
                        width: 10.0,
                        height: 10.0,
                    },
                })
                .collect(),
            ruled: true,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        }
    }

    #[test]
    fn overlap_and_thresholds_are_conservative() {
        let a = BBox {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        let b = BBox {
            x: 5.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert_eq!(overlap(a, b), 0.5);
        assert!(threshold(21) < threshold(17));
        assert!(threshold(5) > 1.0); // formulas intentionally ignored
    }

    #[test]
    fn visual_figure_vetoes_geometry_while_dense_grid_survives_detector_absence() {
        let figure = Detection {
            class_id: 3,
            score: 0.95,
            bbox: BBox {
                x: 90.0,
                y: 90.0,
                width: 320.0,
                height: 220.0,
            },
        };
        let mut sparse = test_page(vec![table(20, 10, 15)]);
        reconcile_table_regions(&mut sparse, &[&figure]);
        assert!(sparse.blocks.is_empty());

        let mut dense = test_page(vec![table(20, 10, 190)]);
        reconcile_table_regions(&mut dense, &[]);
        assert!(matches!(dense.blocks.as_slice(), [Block::Table { .. }]));
    }

    #[test]
    fn visual_table_region_replaces_a_clipped_native_core() {
        let prior = Detection {
            class_id: 21,
            score: 0.95,
            bbox: BBox {
                x: 50.0,
                y: 90.0,
                width: 500.0,
                height: 220.0,
            },
        };
        let mut page = test_page(vec![table(10, 3, 30)]);
        reconcile_table_regions(&mut page, &[&prior]);
        assert_eq!(page.blocks[0].bbox(), prior.bbox);
    }
}
