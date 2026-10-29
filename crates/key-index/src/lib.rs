// Background indexing for a key-store workspace. Sources are hashed, their text is
// extracted (PDF pages through the host's PDFium service, HTML snapshots, plain
// text), cut into overlapping chunks that keep page geometry for highlighting,
// and embedded with EmbeddingGemma 2 when the model is available. Text becomes
// keyword-searchable immediately; vectors are back-filled once the model arrives.
mod chunk;
pub use chunk::{PageText, TextChar, chunk_pages};

use key_embed::{Embedder, ModelDir};
use key_store::{ChunkInput, Source, Store};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

pub type Result<T> = std::result::Result<T, String>;

/// Page text for a PDF on disk. Implemented by the host, which owns PDFium.
pub trait PdfText: Send + Sync + 'static {
    fn pages(&self, path: &Path, hash: &str) -> Result<Vec<PageText>>;
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
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
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
                    Ok(true) => break signal.wake(),
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
            let next = self
                .store
                .pending_sources(in_flight.len() + 1, false)
                .ok()
                .and_then(|ids| ids.into_iter().find(|id| !in_flight.contains(id)));
            let Some(id) = next else {
                if in_flight.is_empty() {
                    self.busy.store(false, Ordering::SeqCst);
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
                    if let Ok(mut done) = self.finished.lock() {
                        done.push(id);
                    }
                    self.wake();
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
                            if let Ok(mut done) = self.finished.lock() {
                                done.push(id);
                            }
                            self.wake();
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
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
        let Some(source) = self.store.source(id)? else { return Ok(None) };
        self.store.set_index_status(id, "indexing", None, 0, 0)?;
        let mut chunks = abstract_chunk(&source).into_iter().collect::<Vec<_>>();
        let mut status = "ready";
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
            let pages = match source.kind.as_str() {
                "pdf" => pdf.pages(&path, &hash)?,
                "web" | "file" if is_text_like(&path, source.field("mime")) => vec![PageText::plain(read_text(&path)?)],
                _ => Vec::new(),
            };
            if source.kind == "pdf" {
                patch.insert("pageCount".into(), serde_json::Value::from(pages.len()));
            }
            if !patch.is_empty() {
                self.store.update_source(id, &patch)?;
            }
            let body = chunk_pages(&pages);
            if body.is_empty() && matches!(source.kind.as_str(), "pdf" | "web") {
                status = "no_text";
            }
            chunks.extend(body);
        }
        self.store.replace_chunks(id, &chunks)?;
        self.store.set_index_status(id, "indexing", None, 0, chunks.len() as i64)?;
        Ok(Some(Prepared { id: id.to_string(), title: source.title().to_string(), chunks, status }))
    }

    /// Stage two: embed the chunks and mark the source ready.
    fn embed(&self, mut prepared: Prepared) -> Result<()> {
        let total = prepared.chunks.len() as i64;
        if let Some(embedder) = self.embedder().filter(|_| total > 0) {
            let mut done = 0;
            for batch in prepared.chunks.chunks_mut(32) {
                let items: Vec<(&str, &str)> = batch.iter().map(|c| (prepared.title.as_str(), c.text.as_str())).collect();
                let vectors = embedder.embed_documents(&items)?;
                for (chunk, vector) in batch.iter_mut().zip(vectors) {
                    chunk.embedding = Some(vector);
                }
                done += batch.len() as i64;
                self.store.set_index_status(&prepared.id, "indexing", None, done, total)?;
            }
            self.store.replace_chunks(&prepared.id, &prepared.chunks)?;
        }
        self.store.set_index_status(&prepared.id, prepared.status, None, total, total)
    }
}

struct Prepared {
    id: String,
    title: String,
    chunks: Vec<ChunkInput>,
    status: &'static str,
}

/// Title + abstract as one chunk, so metadata-only references are semantically searchable.
fn abstract_chunk(source: &Source) -> Option<ChunkInput> {
    let text = source.field("abstract")?.trim();
    (!text.is_empty()).then(|| ChunkInput { text: text.to_string(), ..Default::default() })
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
