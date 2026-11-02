// Layout analysis for indexing, in a helper process: PDFium and the layout model run
// outside the host so a crash or a runaway document cannot take the library down.
// The helper writes the document's blocks (reading order, kind, geometry, sentences)
// and its Markdown as JSON; the indexer turns them into passages.
use key_index::{Layout, LayoutBlock, LayoutSentence};
use opendataloader_pdf::{
    ConvertOptions,
    model::{BBox, Block, Page},
};
use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const FLAG: &str = "--key-layout-helper";
/// A document that takes longer than this falls back to plain PDF text.
const TIMEOUT: Duration = Duration::from_secs(600);

/// The layout model: `KEY_LAYOUT_MODEL` (set by the app for packaged builds), else the
/// copy next to the extraction crate in development.
pub fn model_path() -> Option<PathBuf> {
    env::var_os("KEY_LAYOUT_MODEL")
        .map(PathBuf::from)
        .into_iter()
        .chain([opendataloader_pdf::bundled_onnx_model_path()])
        .find(|path| path.is_file())
}

/// Analyses one PDF in a helper process.
pub fn analyze(path: &Path, model: bool) -> Result<Layout, String> {
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut command = Command::new(env::current_exe().map_err(|e| e.to_string())?);
    command.arg(FLAG).arg(path).arg(output.path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    if model {
        if let Some(model) = model_path() {
            command.arg("--model").arg(model);
        }
    }
    // Half the cores at most: indexing runs in the background while the user works.
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(1, 4)).unwrap_or(2);
    command.env("KEY_LAYOUT_THREADS", threads.to_string());
    let mut child = command.spawn().map_err(|e| format!("layout helper: {e}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("layout analysis took too long".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if !status.success() {
        let mut message = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut stderr, &mut message);
        }
        return Err(format!("layout helper failed: {}", message.trim().lines().last().unwrap_or("no output")));
    }
    let bytes = std::fs::read(output.path()).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn maybe_run_layout_helper() -> Option<i32> {
    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(OsStr::new(FLAG)) {
        return None;
    }
    let input = arguments.next().map(PathBuf::from);
    let output = arguments.next().map(PathBuf::from);
    let model = match (arguments.next(), arguments.next()) {
        (Some(flag), Some(path)) if flag == "--model" => Some(PathBuf::from(path)),
        _ => None,
    };
    let (Some(input), Some(output)) = (input, output) else {
        eprintln!("usage: {FLAG} INPUT OUTPUT [--model PATH]");
        return Some(2);
    };
    // PDFium gets a thread with a generous stack; deep structure trees recurse.
    let worker = std::thread::Builder::new().stack_size(64 << 20).spawn(move || run(&input, &output, model));
    match worker.map_err(|e| e.to_string()).and_then(|w| w.join().map_err(|_| "layout helper panicked".to_string())) {
        Ok(Ok(())) => Some(0),
        Ok(Err(error)) | Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

fn run(input: &Path, output: &Path, model: Option<PathBuf>) -> Result<(), String> {
    let mut options = ConvertOptions::default();
    let engine = if model.is_some() { "layout-onnx" } else { "layout" };
    options.onnx_model = model;
    // Rotated pages are analysed upright, then their geometry is turned back.
    let normalized = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let rotations = opendataloader_pdf::extract::normalize_page_rotations(input, normalized.path()).map_err(|e| format!("{e:#}"))?;
    let path = if rotations.iter().any(|r| *r != 0) { normalized.path() } else { input };
    let document = opendataloader_pdf::convert(path, &options).map_err(|e| format!("{e:#}"))?;
    let markdown = opendataloader_pdf::to_markdown(&document);
    let mut blocks = Vec::new();
    for page in &document.pages {
        let rotation = rotations.get(page.number.saturating_sub(1)).copied().unwrap_or(0);
        blocks.extend(page_blocks(page, rotation));
    }
    let layout = Layout { engine: engine.into(), page_count: document.number_of_pages, markdown, blocks };
    std::fs::write(output, serde_json::to_vec(&layout).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn page_blocks(page: &Page, rotation: u16) -> Vec<LayoutBlock> {
    let rect = |b: BBox| rotate(quantize(b, page.width, page.height), rotation);
    page.blocks
        .iter()
        .enumerate()
        .map(|(index, block)| LayoutBlock {
            page: page.number.saturating_sub(1) as i64,
            kind: kind(block).into(),
            text: block.text(),
            bounds: rect(block.bbox()),
            sentences: page
                .sentences
                .iter()
                .filter(|s| s.block_index == index)
                .map(|s| LayoutSentence { text: s.text.clone(), rects: s.rects.iter().map(|r| rect(*r)).collect() })
                .collect(),
        })
        .collect()
}

fn kind(block: &Block) -> &'static str {
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

/// [x, y, width, height] on a 0..65535 page scale.
fn quantize(b: BBox, width: f32, height: f32) -> [u16; 4] {
    let q = |v: f32| (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16;
    let (w, h) = (width.max(1.0), height.max(1.0));
    let (x, y) = (q(b.x / w), q(b.y / h));
    [x, y, q(b.right() / w).saturating_sub(x), q(b.bottom() / h).saturating_sub(y)]
}

fn rotate([x, y, width, height]: [u16; 4], rotation: u16) -> [u16; 4] {
    let right = x.saturating_add(width);
    let bottom = y.saturating_add(height);
    match rotation {
        90 => [u16::MAX - bottom, x, height, width],
        180 => [u16::MAX - right, u16::MAX - bottom, width, height],
        270 => [y, u16::MAX - right, height, width],
        _ => [x, y, width, height],
    }
}
