// Background indexing for a key-store workspace. Sources are hashed, their text is
// extracted (PDF pages through the host's PDFium service, HTML snapshots, plain
// text), cut into overlapping chunks that keep page geometry for highlighting,
// and embedded with EmbeddingGemma 2 when the model is available. Text becomes
// keyword-searchable immediately; vectors are back-filled once the model arrives.
//
// Scheduling: one source is extracted while the previous one is embedded. What the
// user is working with goes first (opened in the reader, then selected, then on
// screen); everything else follows files-before-references, newest first.
//
// Notes are cut into passages as they are saved (cheap, so keyword search is current);
// their vectors follow through the same back-fill once a note has been left alone.
//
// Files in indexed linked folders are read between sources, a few per round, opened ones
// first (`prioritize` with `file:<id>`); their vectors also come from the back-fill.
mod chunk;
mod layout;
mod links;
mod note;
pub use chunk::{PageText, TextChar, chunk_pages};
pub use layout::{Layout, LayoutBlock, LayoutSentence, chunk_layout};
pub use links::{note_links, parse_href};
pub use note::chunk_note;

use key_embed::{Embedder, ModelDir};
use key_store::{ChunkInput, LinkedFile, Note, Source, Store};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;

/// Page text for a PDF on disk. Implemented by the host, which owns PDFium.
/// `progress(done, total)` is called as pages are read.
pub trait PdfText: Send + Sync + 'static {
    fn pages(&self, path: &Path, hash: &str, progress: &dyn Fn(usize, usize)) -> Result<Vec<PageText>>;
    /// Layout analysis (blocks in reading order, Markdown), with the layout model when
    /// `model` is set. `None` when the host has none; errors fall back to `pages`.
    fn layout(&self, _path: &Path, _hash: &str, _model: bool) -> Result<Option<Layout>> {
        Ok(None)
    }
}

/// Why a source jumps the queue, strongest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Visible,
    Selected,
    Opened,
}
impl Priority {
    pub fn parse(reason: &str) -> Option<Self> {
        match reason {
            "visible" => Some(Self::Visible),
            "selected" => Some(Self::Selected),
            "opened" => Some(Self::Opened),
            _ => None,
        }
    }
    /// How long a request stays in force: rows scroll away, selections change.
    fn lifetime(self) -> Duration {
        Duration::from_secs(match self {
            Self::Visible => 120,
            Self::Selected => 600,
            Self::Opened => 3600,
        })
    }
}

/// One source moving through a stage.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// opening | reading | chunking | embedding
    pub stage: String,
    /// Pages read, or passages embedded, so far.
    pub done: u64,
    pub total: u64,
    pub priority: Option<Priority>,
}

/// What indexing is doing right now, for progress displays.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub paused: bool,
    pub reading: Option<Job>,
    pub embedding: Option<Job>,
    pub up_next: Vec<Job>,
    /// Sources finished since indexing last went idle, and that batch's size.
    pub batch_done: u64,
    pub batch_total: u64,
    /// Recent average time per source, once a few have finished.
    pub seconds_per_source: Option<f64>,
    /// Passages waiting for vectors (indexed before the search model was ready).
    pub vectors_pending: u64,
}

#[derive(Default)]
struct Live {
    reading: Option<Job>,
    embedding: Option<Job>,
    batch_done: u64,
    finishes: VecDeque<Instant>,
}

#[derive(Default)]
struct Signal {
    wake: Mutex<bool>,
    condvar: Condvar,
}

/// One indexing worker per workspace store.
#[derive(Clone)]
pub struct Indexer {
    store: Store,
    models: ModelDir,
    embedder: Arc<Mutex<Option<Arc<Embedder>>>>,
    signal: Arc<Signal>,
    paused: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    finished: Arc<Mutex<Vec<String>>>,
    live: Arc<Mutex<Live>>,
    priorities: Arc<Mutex<HashMap<String, (Priority, Instant)>>>,
    /// Run the layout model during layout analysis (on by default).
    layout_model: Arc<AtomicBool>,
}

impl Indexer {
    pub fn start(store: Store, models: ModelDir, pdf: Arc<dyn PdfText>) -> Self {
        let indexer = Self {
            store,
            models,
            embedder: Arc::default(),
            signal: Arc::default(),
            paused: Arc::default(),
            busy: Arc::default(),
            finished: Arc::default(),
            live: Arc::default(),
            priorities: Arc::default(),
            layout_model: Arc::new(AtomicBool::new(true)),
        };
        let worker = indexer.clone();
        thread::Builder::new()
            .name("key-index".into())
            .spawn(move || worker.run(pdf))
            .expect("spawn indexer");
        indexer
    }

    pub fn wake(&self) {
        if let Ok(mut wake) = self.signal.wake.lock() {
            *wake = true;
            self.signal.condvar.notify_all();
        }
    }
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        self.wake();
    }
    /// Whether layout analysis uses the layout model; applies to sources analysed from now on.
    pub fn set_layout_model(&self, enabled: bool) {
        self.layout_model.store(enabled, Ordering::SeqCst);
    }
    pub fn layout_model(&self) -> bool {
        self.layout_model.load(Ordering::SeqCst)
    }
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Moves sources ahead in the queue. A stronger reason is never downgraded by a weaker one.
    pub fn prioritize(&self, ids: &[String], priority: Priority) {
        let Ok(mut wanted) = self.priorities.lock() else { return };
        let now = Instant::now();
        for id in ids {
            let entry = wanted.entry(id.clone()).or_insert((priority, now));
            if priority >= entry.0 || entry.1.elapsed() > entry.0.lifetime() {
                *entry = (priority, now);
            }
        }
        drop(wanted);
        self.wake();
    }

    pub fn activity(&self) -> Activity {
        let (reading, embedding, batch_done, seconds_per_source) = match self.live.lock() {
            Ok(live) => {
                let pace = (live.finishes.len() >= 3).then(|| {
                    let span = live.finishes.back().unwrap().duration_since(*live.finishes.front().unwrap());
                    span.as_secs_f64() / (live.finishes.len() - 1) as f64
                });
                (live.reading.clone(), live.embedding.clone(), live.batch_done, pace)
            }
            Err(_) => Default::default(),
        };
        let queued = self.store.index_queue_len().unwrap_or(0).max(0) as u64;
        let busy = [&reading, &embedding].into_iter().flatten().map(|j| j.id.as_str()).collect::<Vec<_>>();
        let up_next = self
            .queue(6, &busy.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .into_iter()
            .take(5)
            .filter_map(|(id, priority)| {
                let source = self.store.source(&id).ok()??;
                Some(Job { title: source.title().to_string(), kind: source.kind.clone(), stage: "queued".into(), priority, id, ..Default::default() })
            })
            .collect();
        Activity {
            paused: self.paused.load(Ordering::SeqCst),
            reading,
            embedding,
            up_next,
            batch_done,
            batch_total: if queued > 0 { batch_done + queued } else { 0 },
            seconds_per_source,
            vectors_pending: self.store.unembedded_chunks().unwrap_or(0).max(0) as u64,
        }
    }

    /// The next sources to index: requested ones first, then the store's order.
    fn queue(&self, limit: usize, skip: &[String]) -> Vec<(String, Option<Priority>)> {
        let mut out: Vec<(String, Option<Priority>)> = Vec::new();
        if let Ok(mut wanted) = self.priorities.lock() {
            wanted.retain(|_, (priority, at)| at.elapsed() <= priority.lifetime());
            let mut ranked: Vec<(String, Priority, Instant)> = wanted.iter().map(|(id, (p, at))| (id.clone(), *p, *at)).collect();
            ranked.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
            for (id, priority, _) in ranked {
                if out.len() == limit {
                    break;
                }
                if skip.contains(&id) || id.starts_with(FILE_PREFIX) {
                    continue;
                }
                match self.store.source(&id) {
                    Ok(Some(s)) if s.trashed_at.is_none() && matches!(s.index_status.as_str(), "pending" | "indexing") => {
                        out.push((id, Some(priority)))
                    }
                    // Already indexed (or gone): the request is spent.
                    _ => {
                        wanted.remove(&id);
                    }
                }
            }
        }
        if out.len() < limit {
            let rest = self.store.pending_sources(limit + skip.len() + out.len(), false).unwrap_or_default();
            for id in rest {
                if out.len() == limit {
                    break;
                }
                if !skip.contains(&id) && !out.iter().any(|(o, _)| *o == id) {
                    out.push((id, None));
                }
            }
        }
        out
    }

    fn priority_of(&self, id: &str) -> Option<Priority> {
        self.priorities.lock().ok()?.get(id).map(|(p, _)| *p)
    }
    pub fn model_status(&self) -> key_embed::ModelStatus {
        self.models.status()
    }

    /// The loaded embedder, loading it once the files exist.
    pub fn embedder(&self) -> Option<Arc<Embedder>> {
        let mut slot = self.embedder.lock().ok()?;
        if slot.is_none() && self.models.is_ready() {
            match Embedder::load(&self.models) {
                Ok(embedder) => *slot = Some(Arc::new(embedder)),
                Err(error) => eprintln!("Key search model: {error}"),
            }
        }
        slot.clone()
    }

    /// Cuts a note into passages and records its links. Unchanged passages keep their
    /// vectors; the rest are embedded by the back-fill once the note settles.
    pub fn index_note(&self, note: &Note) -> Result<()> {
        let title = note.title.trim();
        let markdown = if title.is_empty() { note.body.clone() } else { format!("{title}\n\n{}", note.body) };
        self.store.replace_note_links(&note.id, note.updated_at, &note_links(&note.id, &note.body))?;
        self.store.replace_note_chunks(&note.id, note.updated_at, &chunk_note(&markdown))
    }

    /// Notes saved without passing through `index_note` (imports, older libraries).
    fn index_stale_notes(&self) {
        for note in self.store.stale_notes(50).unwrap_or_default() {
            if let Err(error) = self.index_note(&note) {
                eprintln!("Key note indexing for {}: {error}", note.id);
            }
        }
    }

    /// Reads a few changed files of indexed linked folders: opened ones first, then the most
    /// recently changed. Answers whether any were read, so the loop comes back for more.
    fn index_linked_files(&self, pdf: &dyn PdfText) -> bool {
        let wanted: Vec<String> = self
            .priorities
            .lock()
            .map(|p| p.keys().filter_map(|id| id.strip_prefix(FILE_PREFIX).map(String::from)).collect())
            .unwrap_or_default();
        let files = self.store.stale_linked_files(LINKED_FILES_PER_ROUND, &wanted).unwrap_or_default();
        for file in &files {
            let job = Job { id: format!("{FILE_PREFIX}{}", file.id), title: file.name.clone(), kind: "file".into(), stage: "reading".into(), ..Default::default() };
            self.set_reading(Some(job));
            let (chunks, error) = match linked_chunks(file, pdf) {
                Ok(chunks) => (chunks, None),
                Err(error) => (Vec::new(), Some(error)),
            };
            if let Err(error) = self.store.replace_file_chunks(&file.id, file.mtime, &chunks, error.as_deref()) {
                eprintln!("Key linked file indexing for {}: {error}", file.abs_path);
            }
            if let Ok(mut wanted) = self.priorities.lock() {
                wanted.remove(&format!("{FILE_PREFIX}{}", file.id));
            }
        }
        self.set_reading(None);
        !files.is_empty()
    }

    pub fn embed_query(&self, text: &str) -> Option<Vec<f32>> {
        self.embedder()?.embed_query(text).ok()
    }

    fn wait(&self, timeout: Duration) {
        if let Ok(guard) = self.signal.wake.lock() {
            if let Ok((mut guard, _)) = self.signal.condvar.wait_timeout_while(guard, timeout, |wake| !*wake) {
                *guard = false;
            }
        }
    }

    fn run(self, pdf: Arc<dyn PdfText>) {
        // Start the model download in the background so text indexing never waits on it.
        let models = self.models.clone();
        let signal = self.clone();
        thread::spawn(move || {
            loop {
                match models.download() {
                    Ok(true) => {
                        // Start the search model now, so the first search does not wait for it.
                        let _ = signal.embedder();
                        break signal.wake();
                    }
                    Ok(false) => thread::sleep(Duration::from_secs(5)),
                    Err(error) => {
                        eprintln!("Key search model download: {error}");
                        thread::sleep(Duration::from_secs(60));
                    }
                }
            }
        });
        // Two stages: extraction of the next documents overlaps embedding of the current one.
        let (sender, receiver) = mpsc::sync_channel::<Prepared>(2);
        let embedding = self.clone();
        thread::Builder::new()
            .name("key-embed".into())
            .spawn(move || embedding.embed_stage(receiver))
            .expect("spawn embedder");
        let mut in_flight: Vec<String> = Vec::new();
        loop {
            if self.paused.load(Ordering::SeqCst) {
                self.wait(Duration::from_secs(30));
                continue;
            }
            if let Ok(done) = self.finished.lock().map(|mut done| std::mem::take(&mut *done)) {
                in_flight.retain(|id| !done.contains(id));
            }
            self.index_stale_notes();
            let read_files = self.index_linked_files(pdf.as_ref());
            let next = self.queue(1, &in_flight).into_iter().next().map(|(id, _)| id);
            let Some(id) = next else {
                if read_files {
                    continue;
                }
                if in_flight.is_empty() {
                    self.busy.store(false, Ordering::SeqCst);
                    if let Ok(mut live) = self.live.lock() {
                        *live = Live::default();
                    }
                }
                self.wait(Duration::from_secs(if in_flight.is_empty() { 60 } else { 2 }));
                continue;
            };
            self.busy.store(true, Ordering::SeqCst);
            match self.prepare(&id, pdf.as_ref()) {
                Ok(Some(prepared)) => {
                    in_flight.push(id);
                    if sender.send(prepared).is_err() {
                        return;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = self.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                }
            }
        }
    }

    fn embed_stage(self, receiver: mpsc::Receiver<Prepared>) {
        loop {
            match receiver.recv_timeout(Duration::from_secs(3)) {
                Ok(prepared) => {
                    let id = prepared.id.clone();
                    if let Err(error) = self.embed(prepared) {
                        let _ = self.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                    }
                    self.finish(id);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Idle: give chunks indexed before the model was ready their vectors, one
                    // batch at a time so newly prepared documents are never kept waiting.
                    while !self.paused.load(Ordering::SeqCst) && self.backfill_vectors() {
                        if let Ok(prepared) = receiver.try_recv() {
                            let id = prepared.id.clone();
                            if let Err(error) = self.embed(prepared) {
                                let _ = self.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                            }
                            self.finish(id);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn finish(&self, id: String) {
        if let Ok(mut live) = self.live.lock() {
            live.batch_done += 1;
            live.finishes.push_back(Instant::now());
            while live.finishes.len() > 20 {
                live.finishes.pop_front();
            }
        }
        if let Ok(mut done) = self.finished.lock() {
            done.push(id);
        }
        self.wake();
    }

    fn set_reading(&self, job: Option<Job>) {
        if let Ok(mut live) = self.live.lock() {
            live.reading = job;
        }
    }

    /// Embeds up to one batch of chunks that were indexed before the model was ready.
    fn backfill_vectors(&self) -> bool {
        let Some(embedder) = self.embedder() else { return false };
        let Ok(rows) = self.store.chunks_without_vectors(64) else { return false };
        if rows.is_empty() {
            return false;
        }
        let items: Vec<(&str, &str)> = rows.iter().map(|(_, title, text)| (title.as_str(), text.as_str())).collect();
        match embedder.embed_documents(&items) {
            Ok(vectors) => {
                let pairs: Vec<(i64, Vec<f32>)> = rows.iter().map(|(id, _, _)| *id).zip(vectors).collect();
                self.store.set_chunk_vectors(&pairs).is_ok()
            }
            Err(error) => {
                eprintln!("Key embedding: {error}");
                false
            }
        }
    }

    /// Indexes one source synchronously (both stages).
    pub fn index(&self, id: &str, pdf: &dyn PdfText) -> Result<()> {
        match self.prepare(id, pdf)? {
            Some(prepared) => self.embed(prepared),
            None => Ok(()),
        }
    }

    /// Stage one: hash, extract and chunk. Chunks are saved so keyword search works at once.
    fn prepare(&self, id: &str, pdf: &dyn PdfText) -> Result<Option<Prepared>> {
        let result = self.prepare_inner(id, pdf);
        self.set_reading(None);
        result
    }

    fn prepare_inner(&self, id: &str, pdf: &dyn PdfText) -> Result<Option<Prepared>> {
        let Some(source) = self.store.source(id)? else { return Ok(None) };
        self.store.set_index_status(id, "indexing", None, 0, 0)?;
        let job = Job {
            id: id.to_string(),
            title: source.title().to_string(),
            kind: source.kind.clone(),
            stage: "opening".into(),
            priority: self.priority_of(id),
            ..Default::default()
        };
        self.set_reading(Some(job.clone()));
        let mut chunks = abstract_chunk(&source).into_iter().collect::<Vec<_>>();
        let mut status = "ready";
        let mut analysis = None;
        if let Some(path) = source.file_path() {
            if !path.is_file() {
                self.store.replace_chunks(id, &chunks)?;
                self.store.set_index_status(id, "missing", Some("The linked file was moved or deleted"), 0, 0)?;
                return Ok(None);
            }
            let hash = file_hash(&path)?;
            let mut patch = serde_json::Map::new();
            if source.file_hash() != Some(hash.as_str()) {
                patch.insert("fileHash".into(), serde_json::Value::from(hash.clone()));
            }
            // PDFs go through layout analysis (reading order, sections, no page furniture);
            // plain PDF text is the fallback when it is unavailable or fails.
            let mut analysed = None;
            if source.kind == "pdf" {
                self.set_reading(Some(Job { stage: "analysing".into(), ..job.clone() }));
                match pdf.layout(&path, &hash, self.layout_model()) {
                    Ok(layout) => analysed = layout,
                    Err(error) => eprintln!("Key layout analysis for {id} fell back to PDF text: {error}"),
                }
            }
            let (body, page_count, engine, markdown) = match analysed {
                Some(layout) => {
                    self.set_reading(Some(Job { stage: "chunking".into(), done: layout.page_count as u64, total: layout.page_count as u64, ..job.clone() }));
                    (chunk_layout(&layout.blocks), layout.page_count, layout.engine, Some(layout.markdown))
                }
                None => {
                    let pages = match source.kind.as_str() {
                        "pdf" => pdf.pages(&path, &hash, &|done, total| {
                            self.set_reading(Some(Job { stage: "reading".into(), done: done as u64, total: total as u64, ..job.clone() }))
                        })?,
                        "web" | "file" if is_text_like(&path, source.field("mime")) => vec![PageText::plain(read_text(&path)?)],
                        _ => Vec::new(),
                    };
                    self.set_reading(Some(Job { stage: "chunking".into(), done: pages.len() as u64, total: pages.len() as u64, ..job.clone() }));
                    let engine = if source.kind == "pdf" { "pdfium" } else { "text" };
                    (chunk_pages(&pages), pages.len(), engine.to_string(), None)
                }
            };
            if source.kind == "pdf" {
                patch.insert("pageCount".into(), serde_json::Value::from(page_count));
            }
            if !patch.is_empty() {
                self.store.update_source(id, &patch)?;
            }
            if body.is_empty() && matches!(source.kind.as_str(), "pdf" | "web") {
                status = "no_text";
            }
            chunks.extend(body);
            analysis = Some((engine, markdown, source.kind == "pdf"));
        }
        self.store.replace_chunks(id, &chunks)?;
        if let Some((engine, markdown, references)) = analysis {
            self.store.set_analysis(id, &engine, markdown.as_deref(), references && status == "ready")?;
        }
        self.store.set_index_status(id, "indexing", None, 0, chunks.len() as i64)?;
        Ok(Some(Prepared { id: id.to_string(), title: source.title().to_string(), kind: source.kind.clone(), chunks, status }))
    }

    /// Stage two: embed the chunks and mark the source ready.
    fn embed(&self, prepared: Prepared) -> Result<()> {
        let result = self.embed_inner(prepared);
        if let Ok(mut live) = self.live.lock() {
            live.embedding = None;
        }
        result
    }

    fn embed_inner(&self, mut prepared: Prepared) -> Result<()> {
        let total = prepared.chunks.len() as i64;
        let job = Job {
            id: prepared.id.clone(),
            title: prepared.title.clone(),
            kind: prepared.kind.clone(),
            stage: "embedding".into(),
            total: total as u64,
            priority: self.priority_of(&prepared.id),
            ..Default::default()
        };
        if let Some(embedder) = self.embedder().filter(|_| total > 0) {
            if let Ok(mut live) = self.live.lock() {
                live.embedding = Some(job.clone());
            }
            let mut done = 0;
            for batch in prepared.chunks.chunks_mut(32) {
                let items: Vec<(&str, &str)> = batch.iter().map(|c| (prepared.title.as_str(), c.text.as_str())).collect();
                let vectors = embedder.embed_documents(&items)?;
                for (chunk, vector) in batch.iter_mut().zip(vectors) {
                    chunk.embedding = Some(vector);
                }
                done += batch.len() as i64;
                self.store.set_index_status(&prepared.id, "indexing", None, done, total)?;
                if let Ok(mut live) = self.live.lock() {
                    live.embedding = Some(Job { done: done as u64, ..job.clone() });
                }
            }
            self.store.replace_chunks(&prepared.id, &prepared.chunks)?;
        }
        self.store.set_index_status(&prepared.id, prepared.status, None, total, total)
    }
}

struct Prepared {
    id: String,
    title: String,
    kind: String,
    chunks: Vec<ChunkInput>,
    status: &'static str,
}

/// Title + abstract as one chunk, so metadata-only references are semantically searchable.
fn abstract_chunk(source: &Source) -> Option<ChunkInput> {
    let text = source.field("abstract")?.trim();
    (!text.is_empty()).then(|| ChunkInput { text: text.to_string(), ..Default::default() })
}

const FILE_PREFIX: &str = "file:";
const LINKED_FILES_PER_ROUND: usize = 8;

/// A linked file's passages: Markdown by blocks like a note, text as paragraphs, PDFs by page.
fn linked_chunks(file: &LinkedFile, pdf: &dyn PdfText) -> Result<Vec<ChunkInput>> {
    let path = Path::new(&file.abs_path);
    match file.kind.as_str() {
        "pdf" => {
            let hash = file.hash.clone().unwrap_or_default();
            Ok(chunk_pages(&pdf.pages(path, &hash, &|_, _| {})?))
        }
        "markdown" | "text" => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            if bytes.iter().take(8192).any(|b| *b == 0) {
                return Err("Not a text file".into());
            }
            let text = String::from_utf8_lossy(&bytes);
            if file.kind == "markdown" {
                Ok(chunk_note(&format!("{}\n\n{text}", file.name)))
            } else {
                let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                let text = if matches!(extension.as_str(), "html" | "htm") { chunk::html_text(&text) } else { text.into_owned() };
                Ok(chunk_pages(&[PageText::plain(text)]))
            }
        }
        _ => Ok(Vec::new()),
    }
}

pub fn file_hash(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn is_text_like(path: &Path, mime: Option<&str>) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    mime.is_some_and(|m| m.starts_with("text/")) || matches!(extension.as_str(), "html" | "htm" | "txt" | "md" | "markdown")
}

fn read_text(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    Ok(if matches!(extension.as_str(), "html" | "htm") { chunk::html_text(&text) } else { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An indexer without its worker threads, to inspect scheduling.
    fn idle(store: &Store, models: &Path) -> Indexer {
        Indexer {
            store: store.clone(),
            models: ModelDir::new(models),
            embedder: Arc::default(),
            signal: Arc::default(),
            paused: Arc::default(),
            busy: Arc::default(),
            finished: Arc::default(),
            live: Arc::default(),
            priorities: Arc::default(),
            layout_model: Arc::new(AtomicBool::new(true)),
        }
    }

    #[test]
    fn what_the_user_works_with_goes_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let add = |title: &str| {
            let input = serde_json::from_value(serde_json::json!({"kind": "reference", "title": title, "indexStatus": "pending"})).unwrap();
            let id = store.insert_source(input).unwrap().id;
            thread::sleep(Duration::from_millis(5));
            id
        };
        let (old, middle, new) = (add("old"), add("middle"), add("new"));
        let indexer = idle(&store, dir.path());
        let order = |indexer: &Indexer| indexer.queue(3, &[]).into_iter().map(|(id, p)| (id, p)).collect::<Vec<_>>();

        // Default: newest first.
        assert_eq!(order(&indexer)[0].0, new);
        // A selected row, then an opened one, move ahead in that order.
        indexer.prioritize(&[old.clone()], Priority::Selected);
        indexer.prioritize(&[middle.clone()], Priority::Opened);
        assert_eq!(order(&indexer), vec![(middle.clone(), Some(Priority::Opened)), (old.clone(), Some(Priority::Selected)), (new.clone(), None)]);
        // Scrolling past never downgrades a stronger request.
        indexer.prioritize(&[middle.clone()], Priority::Visible);
        assert_eq!(order(&indexer)[0].1, Some(Priority::Opened));
        // Once indexed, the request is spent.
        store.set_index_status(&middle, "ready", None, 1, 1).unwrap();
        assert_eq!(order(&indexer)[0].0, old);
        assert!(indexer.priority_of(&middle).is_none());
    }

    #[test]
    fn saving_a_note_records_its_links_and_edits_replace_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let indexer = idle(&store, dir.path());
        let input = serde_json::from_value(serde_json::json!({"kind": "pdf", "title": "Palma 2022"})).unwrap();
        let paper = store.insert_source(input).unwrap();
        let note = store.save_note(None, None, "Reading", &format!("See [Palma](key://source/{}) on income.", paper.id), None).unwrap();
        indexer.index_note(&note).unwrap();
        let back = store.item_links("source", &paper.id).unwrap().backlinks;
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].from.title, "Reading");
        assert_eq!(back[0].context.as_deref(), Some("See Palma on income."));

        thread::sleep(Duration::from_millis(2));
        let note = store.save_note(Some(&note.id), None, "Reading", "No more links.", None).unwrap();
        indexer.index_note(&note).unwrap();
        assert!(store.item_links("source", &paper.id).unwrap().backlinks.is_empty());
    }

    struct NoPdf;
    impl PdfText for NoPdf {
        fn pages(&self, _: &Path, _: &str, _: &dyn Fn(usize, usize)) -> Result<Vec<PageText>> {
            Err("no PDFs here".into())
        }
    }

    #[test]
    fn files_of_indexed_linked_folders_become_searchable_passages() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("field notes.md"), "# Visit\n\nThe clinic hands out bed nets.").unwrap();
        std::fs::write(outside.path().join("scan.pdf"), "%PDF").unwrap();
        let store = Store::open(dir.path().join(".key")).unwrap();
        let indexer = idle(&store, dir.path());
        let folder = store.link_folder(outside.path()).unwrap();
        store.sync_linked_folder(&folder.id, &[]).unwrap();
        assert!(!indexer.index_linked_files(&NoPdf), "not indexed: nothing to read");
        store.set_linked_folder(&folder.id, None, Some(true)).unwrap();
        assert!(indexer.index_linked_files(&NoPdf));
        // Read once; the PDF that failed is not retried until it changes.
        assert!(!indexer.index_linked_files(&NoPdf));
        let found = store.search(&key_store::SearchQuery { text: "bed nets".into(), ..Default::default() }, None).unwrap();
        assert_eq!(found.files.len(), 1);
        assert_eq!(found.files[0].name, "field notes.md");
        let folders = store.linked_folders().unwrap();
        assert_eq!((folders[0].indexed_files, folders[0].pending_files), (1, 0));
    }
}
