//! Desktop backend orchestration migrated from the Key Tauri shell.
#[path = "native_process.rs"]
mod native_process;
use crate::ipc;
use crate::ipc::{HostState, Output, arg, json_output};
use key_pdf_core::{
    PdfLink, PdfLinkTarget, PixelRect, RasterSize, ScientificAnalysis, ScientificAnalyzer,
    SearchPageOutcome, SearchQuery, TextBounds, TextChar, TextLayer, TileKey, search_page,
};
use key_pdf_runtime::{
    CancellationSource, CancellationToken, ColorMode, DemandIntent, DemandPriority,
    DocumentSession, DocumentSessionManager, EngineDocument, PdfEngine, TextDemandPurpose,
};
use key_pdfium::{PdfiumDocumentSource, PdfiumEngine, PdfiumEngineDocument, PdfiumLibraryConfig};
use key_reference::{
    ReferenceExecutor, ReferenceExecutorConfig, ScholarlyFetcher, ScholarlyMetadata,
    ScholarlyMetadataState, ScholarlySession, detect_doi,
};
pub use key_semantic_search::maybe_run_helper as maybe_run_semantic_helper;
use key_semantic_search::{
    SemanticDocumentDto, SemanticLibraryDocument, SemanticSearchHitDto, SemanticSearchService,
};
pub use native_process::maybe_run_interactive_helper;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fs::File,
    io::BufWriter,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageDto {
    index: usize,
    width: f32,
    height: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TocDto {
    title: String,
    page: usize,
    depth: u16,
    destination_y: Option<f32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LinkTargetDto {
    Internal {
        page: usize,
        x_fraction: Option<f32>,
        y_fraction: Option<f32>,
    },
    External {
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkDto {
    id: usize,
    page: usize,
    bounds: BoundsDto,
    target: LinkTargetDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct BoundsDto {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl From<TextBounds> for BoundsDto {
    fn from(value: TextBounds) -> Self {
        Self {
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentDto {
    id: String,
    title: Option<String>,
    pages: Vec<PageDto>,
    toc: Vec<TocDto>,
    links: Vec<LinkDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TextCharacterDto {
    value: String,
    bounds: Option<BoundsDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextPageDto {
    page: usize,
    text: String,
    characters: Vec<TextCharacterDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatchDto {
    page: usize,
    start: usize,
    end: usize,
    preview: String,
    bounds: Vec<BoundsDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScientificSignalsDto {
    reference_entries: usize,
    doi_entries: usize,
    bracket_citations: usize,
    superscript_citations: usize,
    concentrated_internal_links: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScientificReferenceDto {
    number: u32,
    page: usize,
    x_fraction: Option<f32>,
    y_fraction: Option<f32>,
    text: String,
    text_runs: Vec<BoundsDto>,
    metadata: Option<ScholarlyMetadataDto>,
    metadata_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScientificCitationDto {
    id: String,
    page: usize,
    start: usize,
    end: usize,
    bounds: BoundsDto,
    source: String,
    numbers: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaperPreprocessingDto {
    document: DocumentDto,
    is_scientific: bool,
    synthetic_links: Vec<LinkDto>,
    citations: Vec<ScientificCitationDto>,
    references: Vec<ScientificReferenceDto>,
    signals: ScientificSignalsDto,
    processing_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkFixtureDto {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskPreprocessingSidecar {
    analysis: PaperPreprocessingDto,
    text_pages: Vec<TextPageDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionSnapshotDto {
    generation: u64,
    revision: u64,
    analysis_revision: u64,
    stage: String,
    document: DocumentDto,
    analysis: Option<PaperPreprocessingDto>,
    semantic: Option<SemanticDocumentDto>,
    document_hash: String,
    semantic_status: String,
    semantic_completed: usize,
    semantic_total: usize,
    semantic_error: Option<String>,
    has_native_text: bool,
    completed_references: usize,
    total_references: usize,
    error: Option<String>,
}

#[derive(Clone)]
struct CompanionRecord {
    generation: u64,
    revision: u64,
    analysis_revision: u64,
    stage: String,
    document: DocumentDto,
    analysis: Option<PaperPreprocessingDto>,
    semantic: Option<SemanticDocumentDto>,
    document_hash: String,
    semantic_status: String,
    semantic_completed: usize,
    semantic_total: usize,
    semantic_error: Option<String>,
    text_pages: Vec<TextPageDto>,
    native_text_ready: bool,
    completed_references: usize,
    total_references: usize,
    error: Option<String>,
}

impl CompanionRecord {
    fn snapshot(&self, after_analysis_revision: Option<u64>) -> CompanionSnapshotDto {
        CompanionSnapshotDto {
            generation: self.generation,
            revision: self.revision,
            analysis_revision: self.analysis_revision,
            stage: self.stage.clone(),
            document: self.document.clone(),
            analysis: if after_analysis_revision == Some(self.analysis_revision) {
                None
            } else {
                self.analysis.clone()
            },
            semantic: self.semantic.clone(),
            document_hash: self.document_hash.clone(),
            semantic_status: self.semantic_status.clone(),
            semantic_completed: self.semantic_completed,
            semantic_total: self.semantic_total,
            semantic_error: self.semantic_error.clone(),
            has_native_text: self.native_text_ready,
            completed_references: self.completed_references,
            total_references: self.total_references,
            error: self.error.clone(),
        }
    }
}

/// Runtime storage boundary for staged PDF companions.
///
/// Only lightweight live progress lives in memory; canonical page data is in SQLite.
trait CompanionStorage: Send + Sync {
    fn begin(&self, id: String, document: DocumentDto) -> u64;
    fn snapshot(&self, id: &str) -> Result<CompanionSnapshotDto, String> {
        self.snapshot_since(id, None)
    }
    fn snapshot_since(
        &self,
        id: &str,
        after_analysis_revision: Option<u64>,
    ) -> Result<CompanionSnapshotDto, String>;
    fn list(&self) -> Vec<CompanionSnapshotDto>;
    fn set_document_hash(&self, id: &str, generation: u64, document_hash: String);
    fn set_semantic_progress(
        &self,
        id: &str,
        generation: u64,
        status: &str,
        completed: usize,
        total: usize,
    );
    fn install_local_analysis(
        &self,
        id: &str,
        generation: u64,
        analysis: PaperPreprocessingDto,
        text_pages: Vec<TextPageDto>,
    ) -> bool;
    fn install_semantic_analysis(&self, id: &str, generation: u64) -> bool;
    fn update_reference(
        &self,
        id: &str,
        generation: u64,
        reference: ScientificReferenceDto,
    ) -> bool;
    fn finish(&self, id: &str, generation: u64);
    fn fail(&self, id: &str, generation: u64, error: String);
    fn page(&self, id: &str, page: usize) -> Result<TextPageDto, String>;
    fn release(&self, id: &str);
}

#[derive(Default)]
struct MemoryCompanionStorage {
    records: Mutex<HashMap<String, CompanionRecord>>,
    next_generation: AtomicU64,
    library: Option<key_library::Library>,
}

impl CompanionStorage for MemoryCompanionStorage {
    fn begin(&self, id: String, document: DocumentDto) -> u64 {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        self.records
            .lock()
            .expect("companion storage is poisoned")
            .insert(
                id,
                CompanionRecord {
                    generation,
                    revision: 1,
                    analysis_revision: 0,
                    stage: "analyzing".to_owned(),
                    document,
                    analysis: None,
                    semantic: None,
                    document_hash: String::new(),
                    semantic_status: "pending".to_owned(),
                    semantic_completed: 0,
                    semantic_total: 0,
                    semantic_error: None,
                    text_pages: Vec::new(),
                    native_text_ready: false,
                    completed_references: 0,
                    total_references: 0,
                    error: None,
                },
            );
        generation
    }

    fn snapshot_since(
        &self,
        id: &str,
        after_analysis_revision: Option<u64>,
    ) -> Result<CompanionSnapshotDto, String> {
        self.records
            .lock()
            .map_err(|_| "companion storage is poisoned".to_owned())?
            .get(id)
            .map(|r| r.snapshot(after_analysis_revision))
            .ok_or_else(|| format!("companion {id} is unavailable"))
    }

    fn list(&self) -> Vec<CompanionSnapshotDto> {
        self.records
            .lock()
            .map(|records| {
                records
                    .values()
                    .map(|r| r.snapshot(Some(r.analysis_revision)))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn set_document_hash(&self, id: &str, generation: u64, document_hash: String) {
        if let Ok(mut records) = self.records.lock()
            && let Some(record) = records
                .get_mut(id)
                .filter(|record| record.generation == generation)
        {
            record.document_hash = document_hash;
            record.revision += 1;
        }
    }

    fn set_semantic_progress(
        &self,
        id: &str,
        generation: u64,
        status: &str,
        completed: usize,
        total: usize,
    ) {
        if let Ok(mut records) = self.records.lock()
            && let Some(record) = records
                .get_mut(id)
                .filter(|record| record.generation == generation)
        {
            record.semantic_status = status.to_owned();
            record.semantic_completed = completed;
            record.semantic_total = total;
            record.revision += 1;
        }
    }

    fn install_local_analysis(
        &self,
        id: &str,
        generation: u64,
        analysis: PaperPreprocessingDto,
        text_pages: Vec<TextPageDto>,
    ) -> bool {
        let snapshot = match self.snapshot(id) {
            Ok(s) if s.generation == generation => s,
            _ => return false,
        };
        let hash = snapshot.document_hash;
        if let Some(library) = &self.library {
            let persisted = (|| -> Result<(), String> {
                for page in &text_pages {
                    library.put(
                        &hash,
                        "native-page",
                        "pdfium-v4",
                        &page.page.to_string(),
                        page,
                    )?;
                }
                library.put(&hash, "analysis", "pdfium-v4", "document", &analysis)
            })();
            if let Err(error) = persisted {
                self.fail(id, generation, error);
                return false;
            }
        }
        let Ok(mut records) = self.records.lock() else {
            return false;
        };
        let Some(record) = records
            .get_mut(id)
            .filter(|record| record.generation == generation)
        else {
            return false;
        };
        record.document = analysis.document.clone();
        record.total_references = analysis.references.len();
        record.completed_references = analysis
            .references
            .iter()
            .filter(|reference| reference.metadata.is_some() || reference.metadata_error.is_some())
            .count();
        record.native_text_ready = !text_pages.is_empty()
            || (self.library.is_some() && !analysis.document.pages.is_empty());
        record.analysis = Some(analysis);
        record.analysis_revision += 1;
        if self.library.is_none() {
            record.text_pages = text_pages;
        }
        record.stage = if record.total_references == 0 {
            "ready".to_owned()
        } else {
            "enriching".to_owned()
        };
        record.error = None;
        record.revision += 1;
        true
    }

    fn install_semantic_analysis(&self, id: &str, generation: u64) -> bool {
        let Ok(mut records) = self.records.lock() else {
            return false;
        };
        let Some(record) = records
            .get_mut(id)
            .filter(|record| record.generation == generation)
        else {
            return false;
        };
        // Search passages and geometry are persisted once, never copied into progress polls.
        record.semantic = None;
        record.semantic_status = "ready".to_owned();
        record.semantic_completed = record.semantic_total;
        record.semantic_error = None;
        record.revision += 1;
        true
    }

    fn update_reference(
        &self,
        id: &str,
        generation: u64,
        reference: ScientificReferenceDto,
    ) -> bool {
        let Ok(mut records) = self.records.lock() else {
            return false;
        };
        let Some(record) = records
            .get_mut(id)
            .filter(|record| record.generation == generation)
        else {
            return false;
        };
        let Some(target) = record.analysis.as_mut().and_then(|analysis| {
            analysis
                .references
                .iter_mut()
                .find(|candidate| candidate.number == reference.number)
        }) else {
            return false;
        };
        let was_complete = target.metadata.is_some() || target.metadata_error.is_some();
        *target = reference;
        record.analysis_revision += 1;
        let is_complete = target.metadata.is_some() || target.metadata_error.is_some();
        if !was_complete && is_complete {
            record.completed_references += 1;
        }
        record.revision += 1;
        true
    }

    fn finish(&self, id: &str, generation: u64) {
        if let Ok(mut records) = self.records.lock()
            && let Some(record) = records
                .get_mut(id)
                .filter(|record| record.generation == generation)
        {
            record.stage = "ready".to_owned();
            record.revision += 1;
        }
    }

    fn fail(&self, id: &str, generation: u64, error: String) {
        if let Ok(mut records) = self.records.lock()
            && let Some(record) = records
                .get_mut(id)
                .filter(|record| record.generation == generation)
        {
            record.stage = "failed".to_owned();
            record.error = Some(error);
            record.revision += 1;
        }
    }

    fn page(&self, id: &str, page: usize) -> Result<TextPageDto, String> {
        if let Some(library) = &self.library {
            let hash = self.snapshot(id)?.document_hash;
            return library
                .get(&hash, "native-page", "pdfium-v4", &page.to_string())?
                .ok_or_else(|| format!("PDFium text page {page} is unavailable for {id}"));
        }
        self.records
            .lock()
            .map_err(|_| "companion storage is poisoned".to_owned())?
            .get(id)
            .and_then(|record| record.text_pages.get(page))
            .cloned()
            .ok_or_else(|| format!("PDFium text page {page} is unavailable for {id}"))
    }

    fn release(&self, id: &str) {
        if let Ok(mut records) = self.records.lock() {
            // Closing a tab must not cancel durable indexing. Finished records can
            // be released; active records are tiny and finish independently.
            if records.get(id).is_some_and(|r| {
                matches!(
                    r.semantic_status.as_str(),
                    "ready" | "indexed" | "failed" | "no_text"
                ) && matches!(r.stage.as_str(), "ready" | "failed")
            }) {
                records.remove(id);
            }
        }
    }
}

#[derive(Clone)]
struct CompanionStore {
    storage: Arc<dyn CompanionStorage>,
    reader_ids: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl Default for CompanionStore {
    fn default() -> Self {
        Self {
            storage: Arc::new(MemoryCompanionStorage::default()),
            reader_ids: Arc::default(),
        }
    }
}

fn enrichment_scheduler() -> &'static key_processing::Scheduler {
    static SCHEDULER: OnceLock<key_processing::Scheduler> = OnceLock::new();
    SCHEDULER.get_or_init(|| key_processing::Scheduler::new(1))
}

fn processing_scheduler() -> &'static key_processing::Scheduler {
    static SCHEDULER: OnceLock<key_processing::Scheduler> = OnceLock::new();
    SCHEDULER.get_or_init(|| key_processing::Scheduler::new(2))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScholarlyMetadataDto {
    source: String,
    sources: Vec<String>,
    title: String,
    abstract_text: Option<String>,
    tldr_text: Option<String>,
    authors: Vec<String>,
    year: Option<u32>,
    journal: Option<String>,
    journal_short: Option<String>,
    journal_url: Option<String>,
    doi: Option<String>,
    open_access: Option<bool>,
    full_text_url: Option<String>,
    landing_url: Option<String>,
    certainty: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkSidecarDto {
    index: usize,
    name: String,
    path: String,
    bytes: u64,
    elapsed_ms: f64,
}

#[derive(Serialize, Deserialize)]
enum Request {
    Preprocess {
        id: String,
        bytes: Vec<u8>,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    OpenFile {
        id: String,
        path: PathBuf,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    OpenBytes {
        id: String,
        bytes: Vec<u8>,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    Render {
        request_id: u64,
        id: String,
        page: usize,
        width: u32,
        height: u32,
        x: u32,
        y: u32,
        rect_width: u32,
        rect_height: u32,
        #[serde(skip)]
        cancellation: CancellationSource,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    Text {
        id: String,
        page: usize,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    Search {
        id: String,
        query: String,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    Hibernate {
        id: String,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
    Close {
        id: String,
        #[serde(skip, default = "native_process::discard_reply")]
        reply: Sender<Result<Reply, String>>,
    },
}

#[derive(Serialize, Deserialize)]
enum Reply {
    Preprocessing(PaperPreprocessingDto),
    Document(DocumentDto),
    Pixels(Vec<u8>),
    Text(TextPageDto),
    Search(Vec<SearchMatchDto>),
    Hibernated,
    Closed,
}

struct NativeDocument {
    document: Option<PdfiumEngineDocument>,
    page_count: usize,
    session: DocumentSession,
    text_cache: HashMap<usize, TextLayer>,
    text_cache_order: VecDeque<usize>,
    text_cache_limit: usize,
}

#[derive(Clone)]
struct NativePdfService {
    sender: mpsc::SyncSender<Request>,
    process_input: native_process::ProcessInput,
    render_cancellations: Arc<Mutex<HashMap<u64, CancellationSource>>>,
}

impl NativePdfService {
    fn start() -> Self {
        let (sender, receiver) = mpsc::sync_channel(32);
        let process_input = Arc::new(Mutex::new(None));
        let worker_input = process_input.clone();
        let render_cancellations = Arc::new(Mutex::new(HashMap::new()));
        thread::Builder::new()
            .name("key-interactive-pdf-bridge".to_owned())
            .spawn(move || native_process::run_bridge(receiver, worker_input))
            .expect("failed to start the PDFium owner thread");
        Self {
            sender,
            process_input,
            render_cancellations,
        }
    }

    fn request(
        &self,
        make: impl FnOnce(Sender<Result<Reply, String>>) -> Request,
    ) -> Result<Reply, String> {
        let (reply, receiver) = mpsc::channel();
        self.sender
            .send(make(reply))
            .map_err(|_| "native PDFium owner is unavailable".to_owned())?;
        receiver
            .recv()
            .map_err(|_| "native PDFium owner dropped its reply".to_owned())?
    }

    fn render_cancellation(&self, request_id: u64) -> CancellationSource {
        self.render_cancellations
            .lock()
            .expect("render cancellation registry is poisoned")
            .entry(request_id)
            .or_default()
            .clone()
    }

    fn cancel_render(&self, request_id: u64) {
        self.render_cancellation(request_id).cancel();
        native_process::cancel(&self.process_input, request_id);
    }

    fn finish_render(&self, request_id: u64) {
        self.render_cancellations
            .lock()
            .expect("render cancellation registry is poisoned")
            .remove(&request_id);
    }
}

fn pdfium_config() -> PdfiumLibraryConfig {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("PDFIUM_DYNAMIC_LIB_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(executable) = env::current_exe()
        && let Some(macos_directory) = executable.parent()
    {
        candidates.push(macos_directory.join("../Frameworks"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor/pdfium/lib"));
    PdfiumLibraryConfig::new(candidates).with_system_fallback(true)
}

fn run_pdfium_owner(receiver: Receiver<Request>) {
    let mut engine = PdfiumEngine::new(pdfium_config());
    let mut documents: HashMap<String, NativeDocument> = HashMap::new();
    while let Ok(request) = receiver.recv() {
        match request {
            Request::Preprocess { id, bytes, reply } => {
                let started = Instant::now();
                let result = open_document(&mut engine, id, bytes).and_then(
                    |(id, mut document, descriptor)| {
                        document.text_cache_limit = 12;
                        let analysis = analyze_paper(&mut document)?;
                        let output = preprocessing_dto(
                            descriptor,
                            analysis,
                            started.elapsed().as_secs_f64() * 1_000.0,
                        );
                        documents.insert(id, document);
                        Ok(Reply::Preprocessing(output))
                    },
                );
                let _ = reply.send(result);
            }
            Request::OpenFile { id, path, reply } => {
                let result =
                    open_document_source(&mut engine, id, PdfiumDocumentSource::file(path)).map(
                        |(id, document, dto)| {
                            documents.insert(id, document);
                            Reply::Document(dto)
                        },
                    );
                let _ = reply.send(result);
            }
            Request::OpenBytes { id, bytes, reply } => {
                let result = open_document(&mut engine, id, bytes).map(|(id, document, dto)| {
                    documents.insert(id, document);
                    Reply::Document(dto)
                });
                let _ = reply.send(result);
            }
            Request::Render {
                request_id,
                id,
                page,
                width,
                height,
                x,
                y,
                rect_width,
                rect_height,
                cancellation,
                reply,
            } => {
                let result = if cancellation.is_cancelled() {
                    Err(format!("render request {request_id} was cancelled"))
                } else {
                    documents
                        .get_mut(&id)
                        .ok_or_else(|| format!("document {id} is not open"))
                        .and_then(|document| {
                            render(
                                document,
                                page,
                                width,
                                height,
                                PixelRect {
                                    x,
                                    y,
                                    width: rect_width,
                                    height: rect_height,
                                },
                                &cancellation.token(),
                            )
                        })
                        .map(Reply::Pixels)
                };
                let _ = reply.send(result);
            }
            Request::Text { id, page, reply } => {
                let result = documents
                    .get_mut(&id)
                    .ok_or_else(|| format!("document {id} is not open"))
                    .and_then(|document| text_page(document, page))
                    .map(Reply::Text);
                let _ = reply.send(result);
            }
            Request::Search { id, query, reply } => {
                let result = documents
                    .get_mut(&id)
                    .ok_or_else(|| format!("document {id} is not open"))
                    .and_then(|document| search(document, &query))
                    .map(Reply::Search);
                let _ = reply.send(result);
            }
            Request::Hibernate { id, reply } => {
                let result = documents
                    .get_mut(&id)
                    .ok_or_else(|| format!("document {id} is not open"))
                    .map(|document| {
                        document.document = None;
                        document.text_cache.clear();
                        document.text_cache_order.clear();
                        document.session.cancel();
                        Reply::Hibernated
                    });
                let _ = reply.send(result);
            }
            Request::Close { id, reply } => {
                if let Some(document) = documents.remove(&id) {
                    document.session.cancel();
                }
                let _ = reply.send(Ok(Reply::Closed));
            }
        }
    }
}

fn open_document(
    engine: &mut PdfiumEngine,
    id: String,
    bytes: Vec<u8>,
) -> Result<(String, NativeDocument, DocumentDto), String> {
    open_document_source(engine, id, PdfiumDocumentSource::bytes(bytes))
}
fn open_document_source(
    engine: &mut PdfiumEngine,
    id: String,
    source: PdfiumDocumentSource,
) -> Result<(String, NativeDocument, DocumentDto), String> {
    let mut sessions = DocumentSessionManager::new();
    let session = sessions.begin().map_err(|error| error.to_string())?;
    let document = engine
        .open(source, &session.cancellation())
        .map_err(|error| error.to_string())?;
    let descriptor = document.descriptor();
    let page_count = descriptor.page_count();
    let dto = DocumentDto {
        id: id.clone(),
        title: descriptor.title().map(ToOwned::to_owned),
        pages: descriptor
            .pages()
            .iter()
            .enumerate()
            .map(|(index, page)| PageDto {
                index,
                width: page.width,
                height: page.height,
            })
            .collect(),
        toc: descriptor
            .table_of_contents()
            .iter()
            .map(|entry| TocDto {
                title: entry.title.clone(),
                page: entry.page,
                depth: entry.depth,
                destination_y: entry.destination_y,
            })
            .collect(),
        links: descriptor.links().iter().map(link_dto).collect(),
    };
    Ok((
        id,
        NativeDocument {
            document: Some(document),
            page_count,
            session,
            text_cache: HashMap::new(),
            text_cache_order: VecDeque::new(),
            text_cache_limit: 12,
        },
        dto,
    ))
}

fn link_dto(link: &PdfLink) -> LinkDto {
    LinkDto {
        id: link.id,
        page: link.page,
        bounds: link.bounds.into(),
        target: match &link.target {
            PdfLinkTarget::Internal {
                page,
                x_fraction,
                y_fraction,
            } => LinkTargetDto::Internal {
                page: *page,
                x_fraction: *x_fraction,
                y_fraction: *y_fraction,
            },
            PdfLinkTarget::External { url } => LinkTargetDto::External { url: url.clone() },
        },
    }
}

fn analyze_paper(document: &mut NativeDocument) -> Result<ScientificAnalysis, String> {
    let descriptor = document
        .document
        .as_ref()
        .ok_or_else(|| "document is hibernated".to_owned())?
        .descriptor();
    let mut analyzer = ScientificAnalyzer::new(descriptor.page_count(), descriptor.links());
    let page_order = analyzer.page_order().to_vec();
    for page in page_order {
        let text = ensure_text(document, page)?.clone();
        analyzer.ingest_page(page, &text);
    }
    Ok(analyzer.finish())
}

fn preprocessing_dto(
    document: DocumentDto,
    analysis: ScientificAnalysis,
    processing_ms: f64,
) -> PaperPreprocessingDto {
    let signals = analysis.signals;
    PaperPreprocessingDto {
        document,
        is_scientific: analysis.is_scientific,
        synthetic_links: analysis.synthetic_links.iter().map(link_dto).collect(),
        citations: analysis
            .citations
            .into_iter()
            .enumerate()
            .map(|(index, citation)| ScientificCitationDto {
                id: format!(
                    "{}:{}:{}:{}",
                    citation.page, citation.start, citation.end, index
                ),
                page: citation.page,
                start: citation.start,
                end: citation.end,
                bounds: citation.bounds.into(),
                source: citation.source,
                numbers: citation.numbers,
            })
            .collect(),
        references: analysis
            .references
            .into_iter()
            .map(|reference| ScientificReferenceDto {
                number: reference.number,
                page: reference.page,
                x_fraction: reference.x_fraction,
                y_fraction: reference.y_fraction,
                // Keep the analyzer's link/reference graph intact. Some
                // multi-column PDFs place post-reference headings later in
                // extracted text order, causing only the final preview string
                // to absorb boilerplate. Trimming at serialization avoids
                // corrupting classification or valid numbered references.
                text: trim_reference_preview(&reference.text),
                text_runs: reference.text_runs.into_iter().map(Into::into).collect(),
                metadata: None,
                metadata_error: None,
            })
            .collect(),
        signals: ScientificSignalsDto {
            reference_entries: signals.reference_entries,
            doi_entries: signals.doi_entries,
            bracket_citations: signals.bracket_citations,
            superscript_citations: signals.superscript_citations,
            concentrated_internal_links: signals.concentrated_internal_links,
        },
        processing_ms,
    }
}

fn trim_reference_preview(text: &str) -> String {
    const HEADINGS: &[&str] = &[
        "acknowledgements",
        "acknowledgments",
        "author contributions",
        "competing interests",
        "additional information",
        "publisher’s note",
        "publisher's note",
    ];
    let lower = text.to_ascii_lowercase();
    let end = HEADINGS
        .iter()
        .filter_map(|heading| lower.find(heading))
        .filter(|index| *index > 24)
        .min()
        .unwrap_or(text.len());
    text[..end].trim().to_owned()
}

fn render(
    document: &mut NativeDocument,
    page: usize,
    width: u32,
    height: u32,
    rect: PixelRect,
    operation_cancellation: &CancellationToken,
) -> Result<Vec<u8>, String> {
    if u64::from(rect.width) * u64::from(rect.height) * 4 > 32 * 1024 * 1024 {
        return Err("Native render exceeds the 32 MiB tile budget".into());
    }
    let demand = document
        .session
        .render_demand(
            TileKey {
                page,
                raster: RasterSize { width, height },
                column: rect.x,
                row: rect.y,
            },
            rect,
            rect,
            ColorMode::Original,
            DemandPriority::INTERACTIVE,
            DemandIntent::Interactive,
        )
        .map_err(|error| error.to_string())?;
    let image = document
        .document
        .as_mut()
        .ok_or_else(|| "document is hibernated and cannot render".to_owned())?
        .render(
            &demand,
            &document
                .session
                .cancellation()
                .combined(operation_cancellation),
        )
        .map_err(|error| error.to_string())?;
    Ok(image.pixels().to_vec())
}

fn ensure_text(document: &mut NativeDocument, page: usize) -> Result<&TextLayer, String> {
    if !document.text_cache.contains_key(&page) {
        let demand = document
            .session
            .text_demand(
                page,
                TextDemandPurpose::Search,
                DemandPriority::INTERACTIVE,
                DemandIntent::Explicit,
            )
            .map_err(|error| error.to_string())?;
        let layer = document
            .document
            .as_mut()
            .ok_or_else(|| format!("text page {page} was not cached before document hibernation"))?
            .extract_text(&demand, &document.session.cancellation())
            .map_err(|error| error.to_string())?;
        document.text_cache.insert(page, layer);
        document.text_cache_order.retain(|cached| *cached != page);
        document.text_cache_order.push_back(page);
        while document.text_cache.len() > document.text_cache_limit {
            let Some(evicted) = document.text_cache_order.pop_front() else {
                break;
            };
            if evicted != page {
                document.text_cache.remove(&evicted);
            }
        }
    } else {
        document.text_cache_order.retain(|cached| *cached != page);
        document.text_cache_order.push_back(page);
    }
    Ok(document
        .text_cache
        .get(&page)
        .expect("text cache was inserted"))
}

fn text_page(document: &mut NativeDocument, page: usize) -> Result<TextPageDto, String> {
    let layer = ensure_text(document, page)?;
    Ok(TextPageDto {
        page,
        text: layer
            .as_slice()
            .iter()
            .map(|character| character.value)
            .collect(),
        characters: layer
            .as_slice()
            .iter()
            .map(|character| TextCharacterDto {
                value: character.value.to_string(),
                bounds: character.bounds.map(Into::into),
            })
            .collect(),
    })
}

fn search(document: &mut NativeDocument, query: &str) -> Result<Vec<SearchMatchDto>, String> {
    let query = SearchQuery::new(query).map_err(|error| error.to_string())?;
    let page_count = document.page_count;
    let mut output = Vec::new();
    for page in 0..page_count {
        let remaining = 20_000usize.saturating_sub(output.len());
        if remaining == 0 {
            break;
        }
        let layer = ensure_text(document, page)?;
        let SearchPageOutcome::Complete(results) =
            search_page(page, layer.as_slice(), &query, remaining, || false)
        else {
            return Err("search was cancelled".to_owned());
        };
        output.extend(results.matches.into_iter().map(|result| SearchMatchDto {
            page: result.id.page,
            start: result.id.start,
            end: result.id.end,
            preview: result.preview,
            bounds: result.highlight_runs.into_iter().map(Into::into).collect(),
        }));
    }
    Ok(output)
}

async fn preprocess_paper(
    service: HostState<'_, NativePdfService>,
    id: String,
    bytes: Vec<u8>,
) -> Result<PaperPreprocessingDto, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        match service.request(|reply| Request::Preprocess { id, bytes, reply })? {
            Reply::Preprocessing(mut analysis) => {
                let started = Instant::now();
                enrich_reference_metadata(&mut analysis.references);
                analysis.processing_ms += started.elapsed().as_secs_f64() * 1_000.0;
                Ok(analysis)
            }
            _ => Err("paper preprocessor returned an unexpected reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn preprocess_paper_disposable(
    search: HostState<'_, SemanticSearchService>,
    store: HostState<'_, CompanionStore>,
    id: String,
    bytes: Vec<u8>,
    include_text: Option<bool>,
) -> Result<serde_json::Value, String> {
    let library = search.library().clone();
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || {
        let hash = sha256_hex(&bytes);
        let mut sidecar = load_or_create_disposable_sidecar(&id, bytes)?;
        library.register(
            &hash,
            sidecar.analysis.document.title.as_deref().unwrap_or("PDF"),
            sidecar.analysis.document.pages.len(),
        )?;
        enrich_reference_metadata(&mut sidecar.analysis.references);
        let text_pages = sidecar.text_pages;
        let has_native_text = !text_pages.is_empty();
        let generation = store
            .storage
            .begin(id.clone(), sidecar.analysis.document.clone());
        store.storage.set_document_hash(&id, generation, hash);
        store.storage.install_local_analysis(
            &id,
            generation,
            sidecar.analysis.clone(),
            text_pages.clone(),
        );
        store.storage.finish(&id, generation);
        Ok(serde_json::json!({
            "analysis": sidecar.analysis,
            "textPages": if include_text == Some(false) {
                Vec::<TextPageDto>::new()
            } else {
                text_pages
            },
            "hasNativeText": has_native_text,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn load_or_create_disposable_sidecar(
    _id: &str,
    bytes: Vec<u8>,
) -> Result<DiskPreprocessingSidecar, String> {
    let cache_key = format!("pdfium-v4-{}", sha256_hex(&bytes));
    let directory = env::temp_dir().join("key-sidecars").join("interactive");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
    let input = directory.join(format!("{cache_key}.pdf"));
    let output = directory.join(format!("{cache_key}.json"));

    if !output.exists() {
        std::fs::write(&input, bytes)
            .map_err(|error| format!("failed to write {}: {error}", input.display()))?;
        let helper = Command::new(env::current_exe().map_err(|error| error.to_string())?)
            .arg("--key-preprocess-helper")
            .arg(&input)
            .arg(&output)
            .output()
            .map_err(|error| format!("failed to launch preprocessing helper: {error}"))?;
        let _ = std::fs::remove_file(&input);
        if !helper.status.success() {
            let detail = String::from_utf8_lossy(&helper.stderr).trim().to_owned();
            return Err(if detail.is_empty() {
                format!("preprocessing helper exited with {}", helper.status)
            } else {
                format!(
                    "preprocessing helper exited with {}: {detail}",
                    helper.status
                )
            });
        }
    }

    let sidecar = std::fs::read(&output)
        .map_err(|error| format!("failed to read {}: {error}", output.display()))?;
    serde_json::from_slice(&sidecar)
        .map_err(|error| format!("invalid PDFium preprocessing sidecar: {error}"))
}

fn load_or_create_semantic_sidecar(
    search: &SemanticSearchService,
    document_hash: &str,
    input: &Path,
    onnx_enabled: bool,
) -> Result<key_semantic_search::PreparedChunks, String> {
    if let Some(chunks) =
        search.prepare_cached_chunks(document_hash, document_hash, onnx_enabled)?
    {
        return Ok(chunks);
    }
    search.library().verify_source(document_hash)?;
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut helper = Command::new(env::current_exe().map_err(|e| e.to_string())?);
    helper
        .arg("--key-semantic-helper")
        .arg(input)
        .arg(output.path())
        .arg("--hash")
        .arg(document_hash)
        .arg("--library")
        .arg(search.library().root())
        .arg("--canonical");
    if onnx_enabled {
        helper.arg("--onnx");
    }
    key_processing::run_helper(
        helper,
        search.library(),
        document_hash,
        "semantic-extraction",
    )?;
    search
        .prepare_cached_chunks(document_hash, document_hash, onnx_enabled)?
        .ok_or_else(|| "Semantic helper did not publish all pages".into())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn schedule_semantic_analysis(
    semantic_store: CompanionStore,
    search: SemanticSearchService,
    semantic_id: String,
    generation: u64,
    semantic_source: PathBuf,
    onnx_enabled: bool,
) {
    processing_scheduler().submit(semantic_id.clone(), "semantic", 0, move || {
            if !matches!(
                semantic_store.storage.snapshot(&semantic_id),
                Ok(snapshot) if snapshot.generation == generation
            ) {
                return;
            }
            let document_hash = semantic_id.clone();
            if search.library().is_paused(&document_hash).unwrap_or(true) { return; }
            let _ = search.set_document_progress(&document_hash,"processing",0,0,None);
            semantic_store.storage.set_semantic_progress(
                &semantic_id,
                generation,
                "processing",
                0,
                0,
            );
            let extraction=load_or_create_semantic_sidecar(&search,&document_hash,&semantic_source,onnx_enabled);
            match extraction {
                Ok(chunks) => {
                    if !matches!(semantic_store.storage.snapshot(&semantic_id),Ok(s) if s.generation==generation) {return;}
                    if chunks.is_empty() {
                        let _=search.set_document_progress(&document_hash,"no_text",0,0,None);
                        semantic_store.storage.set_semantic_progress(&semantic_id,generation,"no_text",0,0);
                        return;
                    }
                    semantic_store.storage.set_semantic_progress(
                        &semantic_id,
                        generation,
                        "indexing",
                        0,
                        chunks.len(),
                    );
                    let progress_store = semantic_store.storage.clone();
                    let progress_id = semantic_id.clone();
                    let progress = std::sync::Arc::new(move |completed, total| {
                        progress_store.set_semantic_progress(
                            &progress_id,
                            generation,
                            "indexing",
                            completed,
                            total,
                        );
                    });
                    match search.index_document(chunks, progress) {
                        Ok(stats) => {
                            if let Ok(stats) = serde_json::to_string(&stats) {
                                eprintln!("[key-semantic-index-stats] {stats}");
                            }
                        }
                        Err(error) => {
                            if error == key_processing::YIELDED_TO_READER {
                                let _ = search.set_document_progress(&document_hash, "queued", 0, 0, None);
                                semantic_store.storage.set_semantic_progress(&semantic_id, generation, "queued", 0, 0);
                                schedule_semantic_analysis(semantic_store, search, semantic_id, generation, semantic_source, onnx_enabled);
                                return;
                            }
                            semantic_store.storage.set_semantic_progress(
                                &semantic_id,
                                generation,
                                "failed",
                                0,
                                0,
                            );
                            if search.library().is_paused(&document_hash).unwrap_or(false) {semantic_store.storage.set_semantic_progress(&semantic_id,generation,"paused",0,0);}
                            eprintln!("semantic indexing for {semantic_id} failed: {error}");
                            return;
                        }
                    }
                    semantic_store.storage.set_semantic_progress(
                        &semantic_id,
                        generation,
                        "indexed",
                        semantic_store
                            .storage
                            .snapshot(&semantic_id)
                            .map(|snapshot| snapshot.semantic_total)
                            .unwrap_or(0),
                        semantic_store
                            .storage
                            .snapshot(&semantic_id)
                            .map(|snapshot| snapshot.semantic_total)
                            .unwrap_or(0),
                    );
                    let _ = semantic_store.storage.install_semantic_analysis(
                        &semantic_id,
                        generation,
                    );
                }
                Err(error) => {
                    if error == key_processing::YIELDED_TO_READER {
                                let _ = search.set_document_progress(&document_hash, "queued", 0, 0, None);
                                semantic_store.storage.set_semantic_progress(&semantic_id, generation, "queued", 0, 0);
                                schedule_semantic_analysis(semantic_store, search, semantic_id, generation, semantic_source, onnx_enabled);
                                return;
                            }
                            semantic_store.storage.set_semantic_progress(
                        &semantic_id,
                        generation,
                        "failed",
                        0,
                        0,
                    );
                    let _ = search.set_document_progress(
                        &document_hash,
                        "failed",
                        0,
                        0,
                        Some(error.clone()),
                    );
                    eprintln!("semantic analysis for {semantic_id} failed: {error}");
                }
            }
        });
}

fn begin_background_companion_analysis(
    store: CompanionStore,
    search: SemanticSearchService,
    id: String,
    generation: u64,
    bytes: Vec<u8>,
    onnx_enabled: bool,
) {
    let semantic_store = store.clone();
    let semantic_id = id.clone();
    // Queued work retains paths, not PDF byte buffers.
    drop(bytes);
    let source = match search.library().source_path(&id) {
        Ok(path) => path,
        Err(error) => {
            store.storage.fail(&id, generation, error);
            return;
        }
    };
    let semantic_source = source.clone();
    let native_library = search.library().clone();
    schedule_semantic_analysis(
        semantic_store,
        search,
        semantic_id,
        generation,
        semantic_source,
        onnx_enabled,
    );

    processing_scheduler().submit(id.clone(), "native", 10, move || {
        if !matches!(
            store.storage.snapshot(&id),
            Ok(snapshot) if snapshot.generation == generation
        ) {
            return;
        }
        let analysis = match load_or_create_native_analysis(&native_library, &id, &source) {
            Ok(analysis) => analysis,
            Err(error) => {
                store.storage.fail(&id, generation, error);
                return;
            }
        };
        if let Err(error) = native_library
            .store_relations(&id, "citation", &analysis.citations)
            .and_then(|_| native_library.store_relations(&id, "reference", &analysis.references))
        {
            store.storage.fail(&id, generation, error);
            return;
        }
        let mut references = analysis.references.clone();
        if !store
            .storage
            .install_local_analysis(&id, generation, analysis, Vec::new())
        {
            return;
        }
        if references.is_empty() {
            match native_library.put(&id, "native-complete", "pdfium-v4", "document", &true) {
                Ok(()) => store.storage.finish(&id, generation),
                Err(error) => store.storage.fail(&id, generation, error),
            }
            return;
        }
        enrichment_scheduler().submit(id.clone(), "references", 0, move || {
            enrich_reference_metadata_streaming(&store, &id, generation, &mut references);
            let Ok(snapshot) = store.storage.snapshot(&id) else {
                return;
            };
            if snapshot.generation != generation {
                return;
            }
            let Some(analysis) = snapshot.analysis else {
                return;
            };
            let result = (|| {
                native_library.store_relations(&id, "reference", &analysis.references)?;
                native_library.put(&id, "analysis", "pdfium-v4", "document", &analysis)?;
                native_library.put(&id, "native-complete", "pdfium-v4", "document", &true)
            })();
            match result {
                Ok(()) => store.storage.finish(&id, generation),
                Err(error) => store.storage.fail(&id, generation, error),
            }
        });
    });
}

fn library_import_begin(
    search: HostState<'_, SemanticSearchService>,
    imports: HostState<'_, key_library::Imports>,
    title: String,
    length: u64,
) -> Result<String, String> {
    imports.begin(search.library(), title, length)
}
fn library_import_chunk(
    imports: HostState<'_, key_library::Imports>,
    request: ipc::Request<'_>,
) -> Result<u64, String> {
    let id = request
        .headers()
        .get("x-key-import")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing import ID")?;
    let offset = request
        .headers()
        .get("x-key-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("missing import offset")?;
    match request.body() {
        ipc::InvokeBody::Raw(bytes) => imports.append(id, offset, bytes),
        _ => Err("Import requires binary chunks".into()),
    }
}
fn library_import_finish(
    search: HostState<'_, SemanticSearchService>,
    imports: HostState<'_, key_library::Imports>,
    id: String,
) -> Result<key_library::SourceInfo, String> {
    imports.finish(search.library(), &id)
}
fn library_import_cancel(
    imports: HostState<'_, key_library::Imports>,
    id: String,
) -> Result<(), String> {
    imports.cancel(&id)
}
async fn library_source_info(
    search: HostState<'_, SemanticSearchService>,
    hash: String,
) -> Result<key_library::SourceInfo, String> {
    let library = search.library().clone();
    tokio::task::spawn_blocking(move || {
        library.verify_source(&hash)?;
        library.source_info(&hash)
    })
    .await
    .map_err(|e| e.to_string())?
}
async fn library_source_range(
    search: HostState<'_, SemanticSearchService>,
    hash: String,
    offset: u64,
    length: usize,
) -> Result<ipc::Response, String> {
    let library = search.library().clone();
    tokio::task::spawn_blocking(move || {
        library
            .source_range(&hash, offset, length)
            .map(ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}
async fn begin_pdfjs_companion_managed(
    service: HostState<'_, NativePdfService>,
    store: HostState<'_, CompanionStore>,
    search: HostState<'_, SemanticSearchService>,
    hash: String,
) -> Result<CompanionSnapshotDto, String> {
    let service = service.inner().clone();
    let store = store.inner().clone();
    let search = search.inner().clone();
    tokio::task::spawn_blocking(move || {
        processing_scheduler().prioritize(&hash);
        if let Ok(snapshot) = store.storage.snapshot(&hash) {
            store
                .reader_ids
                .lock()
                .map_err(|_| "Reader registry poisoned")?
                .insert(hash.clone());
            return Ok(snapshot);
        }
        search.library().verify_source(&hash)?;
        let path = search.library().source_path(&hash)?;
        let document = match service.request(|reply| Request::OpenFile {
            id: hash.clone(),
            path,
            reply,
        })? {
            Reply::Document(d) => d,
            _ => return Err("Unexpected open reply".into()),
        };
        let title = search.library().source_info(&hash)?.title;
        search.register_document(hash.clone(), hash.clone(), title, document.pages.len())?;
        search
            .library()
            .put(&hash, "document", "v1", "descriptor", &document)?;
        let generation = store.storage.begin(hash.clone(), document);
        store
            .storage
            .set_document_hash(&hash, generation, hash.clone());
        let snapshot = store.storage.snapshot(&hash)?;
        store
            .reader_ids
            .lock()
            .map_err(|_| "Reader registry poisoned")?
            .insert(hash.clone());
        begin_background_companion_analysis(store, search, hash, generation, Vec::new(), false);
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn begin_pdfjs_companion_binary(
    service: HostState<'_, NativePdfService>,
    store: HostState<'_, CompanionStore>,
    search: HostState<'_, SemanticSearchService>,
    request: ipc::Request<'_>,
) -> Result<CompanionSnapshotDto, String> {
    let bytes = match request.body() {
        ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("PDF upload must be binary".into()),
    };
    let id = request
        .headers()
        .get("x-key-hash")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing PDF hash")?
        .to_owned();
    let name = request
        .headers()
        .get("x-key-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| serde_json::from_str::<String>(v).ok());
    begin_pdfjs_companion(service, store, search, id, name, bytes, Some(false)).await
}

async fn begin_pdfjs_companion(
    service: HostState<'_, NativePdfService>,
    store: HostState<'_, CompanionStore>,
    search: HostState<'_, SemanticSearchService>,
    id: String,
    file_name: Option<String>,
    bytes: Vec<u8>,
    semantic_onnx: Option<bool>,
) -> Result<CompanionSnapshotDto, String> {
    let service = service.inner().clone();
    let store = store.inner().clone();
    let search = search.inner().clone();
    tokio::task::spawn_blocking(move || {
        let document_hash = sha256_hex(&bytes);
        if id != document_hash {
            return Err("PDF identity does not match its bytes".into());
        }
        if let Ok(existing) = store.storage.snapshot(&id) {
            store
                .reader_ids
                .lock()
                .map_err(|_| "Reader registry poisoned")?
                .insert(id.clone());
            return Ok(existing);
        }
        let analysis_bytes = bytes.clone();
        let document = match service.request(|reply| Request::OpenBytes {
            id: id.clone(),
            bytes,
            reply,
        })? {
            Reply::Document(document) => document,
            _ => return Err("native PDFium returned an unexpected open reply".to_owned()),
        };
        let document_hash = sha256_hex(&analysis_bytes);
        let title = document
            .title
            .clone()
            .or(file_name)
            .unwrap_or_else(|| "Untitled PDF".to_owned());
        let page_count = document.pages.len();
        search
            .library()
            .store_source(&analysis_bytes, &title, page_count)?;
        search
            .library()
            .put(&id, "document", "v1", "descriptor", &document)?;
        let generation = store.storage.begin(id.clone(), document);
        store
            .storage
            .set_document_hash(&id, generation, document_hash.clone());
        search.register_document(document_hash, id.clone(), title, page_count)?;
        let snapshot = store.storage.snapshot(&id)?;
        store
            .reader_ids
            .lock()
            .map_err(|_| "Reader registry poisoned")?
            .insert(id.clone());
        begin_background_companion_analysis(
            store,
            search,
            id,
            generation,
            analysis_bytes,
            semantic_onnx.unwrap_or(false),
        );
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn pdfjs_companion_snapshot(
    search: HostState<'_, SemanticSearchService>,
    store: HostState<'_, CompanionStore>,
    id: String,
    after_analysis_revision: Option<u64>,
) -> Result<CompanionSnapshotDto, String> {
    let snapshot = store.storage.snapshot_since(&id, after_analysis_revision)?;
    if snapshot.semantic_status == "processing" {
        if let Some((completed, total)) = search
            .library()
            .extraction_progress(&snapshot.document_hash)?
        {
            if completed != snapshot.semantic_completed || total != snapshot.semantic_total {
                store.storage.set_semantic_progress(
                    &id,
                    snapshot.generation,
                    "processing",
                    completed,
                    total,
                );
                return store.storage.snapshot_since(&id, after_analysis_revision);
            }
        }
    }
    Ok(snapshot)
}

fn pdfjs_companion_list(store: HostState<'_, CompanionStore>) -> Vec<CompanionSnapshotDto> {
    store.storage.list()
}

fn processing_interaction() {
    key_processing::mark_interaction();
}

fn library_prioritize(hash: String) {
    processing_scheduler().prioritize(&hash);
}

fn semantic_library(
    service: HostState<'_, SemanticSearchService>,
) -> Result<Vec<SemanticLibraryDocument>, String> {
    service.library_documents()
}

fn resume_library_document(
    store: CompanionStore,
    search: SemanticSearchService,
    native: NativePdfService,
    hash: String,
) -> Result<(), String> {
    let document =
        match search
            .library()
            .get::<DocumentDto>(&hash, "document", "v1", "descriptor")?
        {
            Some(document) => document,
            None => {
                search.library().verify_source(&hash)?;
                let descriptor_id = format!("descriptor:{hash}");
                let path = search.library().source_path(&hash)?;
                let reply = native.request(|reply| Request::OpenFile {
                    id: descriptor_id.clone(),
                    path,
                    reply,
                })?;
                let Reply::Document(mut document) = reply else {
                    return Err("Unexpected PDF descriptor response".into());
                };
                let _ = native.request(|reply| Request::Close {
                    id: descriptor_id,
                    reply,
                });
                document.id = hash.clone();
                search
                    .library()
                    .put(&hash, "document", "v1", "descriptor", &document)?;
                document
            }
        };
    let generation = store.storage.begin(hash.clone(), document);
    store
        .storage
        .set_document_hash(&hash, generation, hash.clone());
    begin_background_companion_analysis(store, search, hash, generation, Vec::new(), false);
    Ok(())
}
fn library_processing_control(
    native: HostState<'_, NativePdfService>,
    store: HostState<'_, CompanionStore>,
    search: HostState<'_, SemanticSearchService>,
    hash: String,
    action: String,
) -> Result<(), String> {
    match action.as_str() {
        "pause" => {
            search.library().pause(&hash, true)?;
            if let Ok(snapshot) = store.storage.snapshot(&hash) {
                store.storage.set_semantic_progress(
                    &hash,
                    snapshot.generation,
                    "paused",
                    snapshot.semantic_completed,
                    snapshot.semantic_total,
                );
            }
            Ok(())
        }
        "resume" | "retry" => {
            search.library().pause(&hash, false)?;
            resume_library_document(
                store.inner().clone(),
                search.inner().clone(),
                native.inner().clone(),
                hash,
            )
        }
        _ => Err("Unknown processing action".into()),
    }
}
fn library_removed_documents(
    search: HostState<'_, SemanticSearchService>,
) -> Result<Vec<key_library::Document>, String> {
    search.library().documents(&key_library::Filter {
        removed: true,
        ..Default::default()
    })
}
async fn library_purge(
    search: HostState<'_, SemanticSearchService>,
    store: HostState<'_, CompanionStore>,
    hash: String,
) -> Result<(), String> {
    let library = search.library().clone();
    let readers = store.reader_ids.clone();
    tokio::task::spawn_blocking(move || {
        if readers
            .lock()
            .map_err(|_| "Reader registry poisoned")?
            .contains(&hash)
        {
            return Err("Close this PDF in every pane before permanently deleting it".into());
        }
        library.purge_document(&hash)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn library_set_removed(
    search: HostState<'_, SemanticSearchService>,
    hash: String,
    removed: bool,
) -> Result<(), String> {
    search.library().set_removed(&hash, removed)
}
fn library_metadata_details(
    search: HostState<'_, SemanticSearchService>,
    hash: String,
) -> Result<key_library::MetadataDetails, String> {
    search.library().metadata_details(&hash)
}
fn library_set_labels(
    search: HostState<'_, SemanticSearchService>,
    hash: String,
    tags: Vec<String>,
    collections: Vec<String>,
) -> Result<(), String> {
    search.library().set_labels(&hash, &tags, &collections)
}
fn library_update_metadata(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
    title: String,
    year: Option<i64>,
    authors: Vec<String>,
) -> Result<(), String> {
    service
        .library()
        .update_metadata(&hash, &title, year, &authors)
}
fn library_set_property(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    service.library().set_property(&hash, &name, &value)
}

fn library_annotations(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
) -> Result<Vec<serde_json::Value>, String> {
    service.library().annotations(&hash)
}
fn library_apply_annotations(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
    upserts: Vec<serde_json::Value>,
    deleted: Vec<String>,
) -> Result<(), String> {
    service
        .library()
        .apply_annotations(&hash, &upserts, &deleted)
}
fn library_save_annotations(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
    annotations: Vec<serde_json::Value>,
) -> Result<(), String> {
    service.library().save_annotations(&hash, &annotations)
}
fn library_import_annotations(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
    legacy_id: String,
    annotations: Vec<serde_json::Value>,
) -> Result<(), String> {
    service
        .library()
        .import_annotations(&hash, &legacy_id, &annotations)
}
fn resolve_search_target(
    service: HostState<'_, SemanticSearchService>,
    id: String,
) -> Result<key_library::Passage, String> {
    service
        .library()
        .passage(&id)?
        .ok_or_else(|| "This search passage is no longer available. Search again.".into())
}

fn library_source(
    service: HostState<'_, SemanticSearchService>,
    hash: String,
) -> Result<ipc::Response, String> {
    let bytes = std::fs::read(service.library().source_path(&hash)?).map_err(|e| e.to_string())?;
    if sha256_hex(&bytes) != hash {
        return Err("The saved PDF failed its content hash check".into());
    }
    Ok(ipc::Response::new(bytes))
}

async fn global_search_page(
    service: HostState<'_, SemanticSearchService>,
    sessions: HostState<'_, Arc<key_semantic_search::SearchSessions>>,
    query: String,
    filter: Option<key_library::Filter>,
    cursor: Option<String>,
) -> Result<key_semantic_search::SearchPage, String> {
    let service = service.inner().clone();
    let sessions = sessions.inner().clone();
    tokio::task::spawn_blocking(move || {
        sessions.search(&service, query, filter.unwrap_or_default(), cursor)
    })
    .await
    .map_err(|e| e.to_string())?
}
async fn global_search(
    service: HostState<'_, SemanticSearchService>,
    query: String,
    limit: Option<usize>,
    filter: Option<key_library::Filter>,
) -> Result<Vec<SemanticSearchHitDto>, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        service.search(
            query,
            limit.unwrap_or(20).clamp(1, 100),
            filter.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn scholarly_lookup_resource(resource: String) -> Result<ScholarlyMetadataDto, String> {
    tokio::task::spawn_blocking(move || {
        let (fetcher, events) = ScholarlyFetcher::new();
        let mut session = ScholarlySession::default();
        let generation = 1;
        fetcher.begin_document(generation);
        if !session.request(&fetcher, generation, &resource) {
            return Err("the link did not contain a usable DOI or Crossref resource".to_owned());
        }
        let event = events
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "scholarly resource lookup timed out".to_owned())?;
        session.apply(event);
        match session.state(&resource) {
            Some(ScholarlyMetadataState::Ready(metadata)) => {
                Ok(ScholarlyMetadataDto::from((**metadata).clone()))
            }
            Some(ScholarlyMetadataState::Failed(error)) => Err(error.clone()),
            Some(ScholarlyMetadataState::Loading) => {
                Err("scholarly resource lookup is still pending".to_owned())
            }
            None => Err("scholarly resource lookup returned no result".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn text_layer_from_dto(page: &TextPageDto) -> TextLayer {
    page.characters
        .iter()
        .filter_map(|character| {
            let mut values = character.value.chars();
            let value = values.next()?;
            Some(TextChar {
                value,
                bounds: character.bounds.map(|bounds| TextBounds {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom,
                }),
            })
        })
        .collect::<Vec<_>>()
        .into()
}

fn cached_or_repaired_text_page(
    store: &CompanionStore,
    native: &NativePdfService,
    library: &key_library::Library,
    id: &str,
    page: usize,
) -> Result<TextPageDto, String> {
    let snapshot = store.storage.snapshot(id)?;
    if page >= snapshot.document.pages.len() {
        return Err("PDF page is out of range".into());
    }
    let hash = snapshot.document_hash;
    if let Some(text) = library.get(&hash, "native-page", "pdfium-v4", &page.to_string())? {
        return Ok(text);
    }
    // A missing/corrupt derived page is recoverable directly from its managed source.
    // Unique handles keep concurrent search and overlay repairs independent.
    static REPAIR_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let repair_id = format!(
        "repair:{}",
        REPAIR_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    library.verify_source(&hash)?;
    let path = library.source_path(&hash)?;
    native.request(|reply| Request::OpenFile {
        id: repair_id.clone(),
        path,
        reply,
    })?;
    let result = native.request(|reply| Request::Text {
        id: repair_id.clone(),
        page,
        reply,
    });
    let _ = native.request(|reply| Request::Close {
        id: repair_id,
        reply,
    });
    let Reply::Text(text) = result? else {
        return Err("Unexpected PDF text response".into());
    };
    library.put(&hash, "native-page", "pdfium-v4", &page.to_string(), &text)?;
    Ok(text)
}

async fn disposable_text_page(
    store: HostState<'_, CompanionStore>,
    native: HostState<'_, NativePdfService>,
    search: HostState<'_, SemanticSearchService>,
    id: String,
    page: usize,
) -> Result<TextPageDto, String> {
    let store = store.inner().clone();
    let native = native.inner().clone();
    let library = search.library().clone();
    tokio::task::spawn_blocking(move || {
        cached_or_repaired_text_page(&store, &native, &library, &id, page)
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn disposable_search(
    store: HostState<'_, CompanionStore>,
    native: HostState<'_, NativePdfService>,
    search: HostState<'_, SemanticSearchService>,
    id: String,
    query: String,
) -> Result<Vec<SearchMatchDto>, String> {
    let store = store.inner().clone();
    let native = native.inner().clone();
    let library = search.library().clone();
    tokio::task::spawn_blocking(move || {
        let query = SearchQuery::new(&query).map_err(|error| error.to_string())?;
        let count = store.storage.snapshot(&id)?.document.pages.len();
        let mut output = Vec::new();
        for page_index in 0..count {
            let page = cached_or_repaired_text_page(&store, &native, &library, &id, page_index)?;
            let remaining = 20_000usize.saturating_sub(output.len());
            if remaining == 0 {
                break;
            }
            let layer = text_layer_from_dto(&page);
            let SearchPageOutcome::Complete(results) =
                search_page(page.page, layer.as_slice(), &query, remaining, || false)
            else {
                return Err("search was cancelled".to_owned());
            };
            output.extend(results.matches.into_iter().map(|result| SearchMatchDto {
                page: result.id.page,
                start: result.id.start,
                end: result.id.end,
                preview: result.preview,
                bounds: result.highlight_runs.into_iter().map(Into::into).collect(),
            }));
        }
        Ok(output)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn release_disposable_document(store: HostState<'_, CompanionStore>, id: String) {
    if let Ok(mut readers) = store.reader_ids.lock() {
        readers.remove(&id);
    }
    store.storage.release(&id);
}

impl From<ScholarlyMetadata> for ScholarlyMetadataDto {
    fn from(metadata: ScholarlyMetadata) -> Self {
        Self {
            source: metadata.source.label().to_owned(),
            sources: metadata
                .sources
                .iter()
                .map(|source| source.label().to_owned())
                .collect(),
            title: metadata.title,
            abstract_text: metadata.abstract_text,
            tldr_text: metadata.tldr_text,
            authors: metadata.authors,
            year: metadata.year,
            journal: metadata.journal,
            journal_short: metadata.journal_short,
            journal_url: metadata.journal_url,
            doi: metadata.doi,
            open_access: metadata.open_access,
            full_text_url: metadata.full_text_url,
            landing_url: metadata.landing_url,
            certainty: metadata
                .certainty
                .map(|certainty| certainty.label().to_owned()),
        }
    }
}

fn enrich_reference_metadata_streaming(
    store: &CompanionStore,
    id: &str,
    generation: u64,
    references: &mut [ScientificReferenceDto],
) {
    let (fetcher, events) = ScholarlyFetcher::new();
    let mut session = ScholarlySession::default();
    fetcher.begin_document(generation);
    let mut requested = 0;
    let mut completed = HashSet::new();

    let mut lookup_order = (0..references.len()).collect::<Vec<_>>();
    lookup_order.sort_by_key(|index| detect_doi(&references[*index].text).is_some());
    for index in lookup_order {
        let reference = &mut references[index];
        if session.request(&fetcher, generation, &reference.text) {
            requested += 1;
        } else if session.state(&reference.text).is_none() {
            reference.metadata_error =
                Some("the reference did not contain a usable DOI or title".to_owned());
            completed.insert(reference.number);
            store
                .storage
                .update_reference(id, generation, reference.clone());
        }
    }

    'events: for _ in 0..requested {
        let waiting_since = Instant::now();
        let event = loop {
            if !matches!(
                store.storage.snapshot(id),
                Ok(snapshot) if snapshot.generation == generation
            ) {
                return;
            }
            match events.recv_timeout(Duration::from_millis(250)) {
                Ok(event) => break event,
                Err(_) if waiting_since.elapsed() < Duration::from_secs(25) => continue,
                Err(_) => break 'events,
            }
        };
        session.apply(event);
        for reference in references.iter_mut() {
            if completed.contains(&reference.number) {
                continue;
            }
            match session.state(&reference.text) {
                Some(ScholarlyMetadataState::Ready(metadata)) => {
                    reference.metadata = Some(ScholarlyMetadataDto::from((**metadata).clone()));
                    reference.metadata_error = None;
                }
                Some(ScholarlyMetadataState::Failed(error)) => {
                    reference.metadata = None;
                    reference.metadata_error = Some(error.clone());
                }
                Some(ScholarlyMetadataState::Loading) | None => continue,
            }
            completed.insert(reference.number);
            store
                .storage
                .update_reference(id, generation, reference.clone());
        }
    }

    for reference in references.iter_mut() {
        if completed.contains(&reference.number) {
            continue;
        }
        reference.metadata = None;
        reference.metadata_error = Some("scholarly preprocessing timed out".to_owned());
        completed.insert(reference.number);
        store
            .storage
            .update_reference(id, generation, reference.clone());
    }
}

fn enrich_reference_metadata(references: &mut [ScientificReferenceDto]) {
    if references.is_empty() {
        return;
    }
    enrich_reference_metadata_pass(references);
}

fn enrich_reference_metadata_pass(references: &mut [ScientificReferenceDto]) {
    if references.is_empty() {
        return;
    }
    let queue_capacity = references.len().clamp(64, 4_096);
    let executor = match ReferenceExecutor::new(ReferenceExecutorConfig {
        queue_capacity,
        ..ReferenceExecutorConfig::default()
    }) {
        Ok(executor) => executor,
        Err(error) => {
            for reference in references {
                reference.metadata_error =
                    Some(format!("could not start scholarly preprocessing: {error}"));
            }
            return;
        }
    };
    let (fetcher, events) = ScholarlyFetcher::with_executor(executor);
    let mut session = ScholarlySession::default();
    fetcher.begin_document(1);
    let mut lookup_order = (0..references.len()).collect::<Vec<_>>();
    lookup_order.sort_by_key(|index| detect_doi(&references[*index].text).is_some());
    let requested = lookup_order
        .into_iter()
        .filter(|index| session.request(&fetcher, 1, &references[*index].text))
        .count();
    for _ in 0..requested {
        match events.recv_timeout(Duration::from_secs(20)) {
            Ok(event) => {
                session.apply(event);
            }
            Err(_) => break,
        }
    }

    for reference in references {
        match session.state(&reference.text) {
            Some(ScholarlyMetadataState::Ready(metadata)) => {
                reference.metadata = Some(ScholarlyMetadataDto::from((**metadata).clone()));
                reference.metadata_error = None;
            }
            Some(ScholarlyMetadataState::Failed(error)) => {
                reference.metadata = None;
                reference.metadata_error = Some(error.clone());
            }
            Some(ScholarlyMetadataState::Loading) => {
                reference.metadata = None;
                reference.metadata_error = Some("scholarly preprocessing timed out".to_owned());
            }
            None => {
                reference.metadata = None;
                reference.metadata_error =
                    Some("the reference did not contain a usable DOI or title".to_owned());
            }
        }
    }
}

async fn native_open_buffer(
    service: HostState<'_, NativePdfService>,
    id: String,
    bytes: Vec<u8>,
) -> Result<DocumentDto, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        match service.request(|reply| Request::OpenBytes { id, bytes, reply })? {
            Reply::Document(document) => Ok(document),
            _ => Err("native PDFium returned an unexpected open reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn native_render(
    service: HostState<'_, NativePdfService>,
    request_id: u64,
    id: String,
    page: usize,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    rect_width: u32,
    rect_height: u32,
) -> Result<ipc::Response, String> {
    let service = service.inner().clone();
    let cancellation = service.render_cancellation(request_id);
    let worker_service = service.clone();
    #[cfg(debug_assertions)]
    eprintln!(
        "native_render begin request={request_id} page={page} raster={width}x{height} rect={x},{y} {rect_width}x{rect_height}"
    );
    let result = tokio::task::spawn_blocking(move || {
        worker_service.request(|reply| Request::Render {
            request_id,
            id,
            page,
            width,
            height,
            x,
            y,
            rect_width,
            rect_height,
            cancellation,
            reply,
        })
    })
    .await
    .map_err(|error| error.to_string())?;
    service.finish_render(request_id);
    #[cfg(debug_assertions)]
    match &result {
        Ok(Reply::Pixels(pixels)) => {
            eprintln!(
                "native_render end request={request_id} bytes={}",
                pixels.len()
            )
        }
        Ok(_) => eprintln!("native_render end request={request_id} unexpected reply"),
        Err(error) => eprintln!("native_render end request={request_id} error={error}"),
    }
    match result? {
        Reply::Pixels(pixels) => Ok(ipc::Response::new(pixels)),
        _ => Err("native PDFium returned an unexpected render reply".to_owned()),
    }
}

fn native_cancel_render(service: HostState<'_, NativePdfService>, request_id: u64) {
    service.cancel_render(request_id);
}

async fn native_text(
    service: HostState<'_, NativePdfService>,
    id: String,
    page: usize,
) -> Result<TextPageDto, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        match service.request(|reply| Request::Text { id, page, reply })? {
            Reply::Text(text) => Ok(text),
            _ => Err("native PDFium returned an unexpected text reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn native_search(
    service: HostState<'_, NativePdfService>,
    id: String,
    query: String,
) -> Result<Vec<SearchMatchDto>, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        match service.request(|reply| Request::Search { id, query, reply })? {
            Reply::Search(results) => Ok(results),
            _ => Err("native PDFium returned an unexpected search reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn native_hibernate(
    service: HostState<'_, NativePdfService>,
    id: String,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        match service.request(|reply| Request::Hibernate { id, reply })? {
            Reply::Hibernated => Ok(()),
            _ => Err("native PDFium returned an unexpected hibernate reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn native_close(service: HostState<'_, NativePdfService>, id: String) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        match service.request(|reply| Request::Close { id, reply })? {
            Reply::Closed => Ok(()),
            _ => Err("native PDFium returned an unexpected close reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn benchmark_fixture() -> Result<Option<BenchmarkFixtureDto>, String> {
    let Some(path) = env::var_os("KEY_BENCHMARK_PDF").map(PathBuf::from) else {
        return Ok(None);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("benchmark.pdf")
        .to_owned();
    let bytes = std::fs::read(&path).map_err(|error| {
        format!(
            "failed to read benchmark fixture {}: {error}",
            path.display()
        )
    })?;
    Ok(Some(BenchmarkFixtureDto { name, bytes }))
}

fn benchmark_fixture_paths() -> Vec<PathBuf> {
    env::var_os("KEY_BENCHMARK_PDFS")
        .map(|paths| env::split_paths(&paths).collect())
        .unwrap_or_default()
}

fn load_or_create_native_analysis(
    library: &key_library::Library,
    hash: &str,
    source: &Path,
) -> Result<PaperPreprocessingDto, String> {
    if let Some(analysis) = library.get(hash, "analysis", "pdfium-v4", "document")? {
        return Ok(analysis);
    }
    let mut command = Command::new(env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg("--key-native-library-helper")
        .arg(source)
        .arg(library.root())
        .arg(hash);
    key_processing::run_helper(command, library, hash, "native-extraction")?;
    library
        .get(hash, "analysis", "pdfium-v4", "document")?
        .ok_or("Native extraction produced no analysis".into())
}
fn preprocess_file_to_library(input: &Path, root: &Path, hash: &str) -> Result<(), String> {
    let library = key_library::Library::open(root)?;
    if key_library::file_hash(input)? != hash {
        return Err("PDF content changed before native extraction".into());
    }
    let mut engine = PdfiumEngine::new(pdfium_config());
    let started = Instant::now();
    let (_, mut document, descriptor) = open_document_source(
        &mut engine,
        hash.to_owned(),
        PdfiumDocumentSource::file(input),
    )?;
    library.register(
        hash,
        descriptor.title.as_deref().unwrap_or("PDF"),
        document.page_count,
    )?;
    let links = document
        .document
        .as_ref()
        .ok_or("Document unavailable")?
        .descriptor()
        .links();
    let mut analyzer = ScientificAnalyzer::new(document.page_count, links);
    // Persist each page as soon as it is extracted; keep PDFium's bounded cache.
    for page in analyzer.page_order().to_vec() {
        let text = ensure_text(&mut document, page)?.clone();
        analyzer.ingest_page(page, &text);
        let dto = text_page(&mut document, page)?;
        library.put(hash, "native-page", "pdfium-v4", &page.to_string(), &dto)?;
    }
    let analysis = preprocessing_dto(
        descriptor,
        analyzer.finish(),
        started.elapsed().as_secs_f64() * 1000.0,
    );
    library.put(hash, "analysis", "pdfium-v4", "document", &analysis)
}

fn preprocess_file_to_sidecar(input: &Path, output: &Path) -> Result<(), String> {
    let bytes = std::fs::read(input)
        .map_err(|error| format!("failed to read {}: {error}", input.display()))?;
    let mut engine = PdfiumEngine::new(pdfium_config());
    let id = input
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("paper.pdf")
        .to_owned();
    let started = Instant::now();
    let (_, mut document, descriptor) = open_document(&mut engine, id, bytes)?;
    document.text_cache_limit = 12;
    let analysis = analyze_paper(&mut document)?;
    let mut analysis = preprocessing_dto(descriptor, analysis, 0.0);
    analysis.processing_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let text_pages = (0..document.page_count)
        .map(|page| text_page(&mut document, page))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let temporary = output.with_extension("json.partial");
    let writer = BufWriter::new(
        File::create(&temporary)
            .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?,
    );
    serde_json::to_writer(
        writer,
        &DiskPreprocessingSidecar {
            analysis,
            text_pages,
        },
    )
    .map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, output).map_err(|error| {
        format!(
            "failed to move {} to {}: {error}",
            temporary.display(),
            output.display()
        )
    })?;
    Ok(())
}

pub fn maybe_run_preprocess_helper() -> Option<i32> {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let command = arguments.next();
    let canonical = command.as_deref() == Some(std::ffi::OsStr::new("--key-native-library-helper"));
    if !canonical && command.as_deref() != Some(std::ffi::OsStr::new("--key-preprocess-helper")) {
        return None;
    }
    let Some(input) = arguments.next().map(PathBuf::from) else {
        eprintln!("missing preprocessing input path");
        return Some(2);
    };
    let Some(output) = arguments.next().map(PathBuf::from) else {
        eprintln!("missing preprocessing output path");
        return Some(2);
    };
    let result = if canonical {
        let Some(hash) = arguments.next().and_then(|v| v.into_string().ok()) else {
            eprintln!("missing PDF hash");
            return Some(2);
        };
        preprocess_file_to_library(&input, &output, &hash)
    } else {
        preprocess_file_to_sidecar(&input, &output)
    };
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

fn benchmark_fixture_names() -> Vec<String> {
    benchmark_fixture_paths()
        .iter()
        .map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("benchmark.pdf")
                .to_owned()
        })
        .collect()
}

fn benchmark_workspace_mode() -> bool {
    env::var_os("KEY_WORKSPACE_BENCHMARK").is_some()
}

fn benchmark_has_single_fixture() -> bool {
    env::var_os("KEY_BENCHMARK_PDF").is_some()
}

async fn benchmark_preprocess_sidecar(index: usize) -> Result<BenchmarkSidecarDto, String> {
    tokio::task::spawn_blocking(move || {
        let paths = benchmark_fixture_paths();
        let input = paths
            .get(index)
            .ok_or_else(|| format!("benchmark fixture {index} does not exist"))?;
        let name = input
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("paper.pdf")
            .to_owned();
        let directory = env::temp_dir().join("key-sidecars");
        let output = directory.join(format!("{index}-{name}.json"));
        let started = Instant::now();
        let status = Command::new(env::current_exe().map_err(|error| error.to_string())?)
            .arg("--key-preprocess-helper")
            .arg(input)
            .arg(&output)
            .status()
            .map_err(|error| format!("failed to launch preprocessing helper: {error}"))?;
        if !status.success() {
            return Err(format!("preprocessing helper exited with {status}"));
        }
        let bytes = std::fs::metadata(&output)
            .map_err(|error| error.to_string())?
            .len();
        Ok(BenchmarkSidecarDto {
            index,
            name,
            path: output.to_string_lossy().into_owned(),
            bytes,
            elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn benchmark_fixture_at(index: usize) -> Result<Option<BenchmarkFixtureDto>, String> {
    let paths = benchmark_fixture_paths();
    let Some(path) = paths.get(index) else {
        return Ok(None);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("benchmark.pdf")
        .to_owned();
    let bytes = std::fs::read(path).map_err(|error| {
        format!(
            "failed to read benchmark fixture {}: {error}",
            path.display()
        )
    })?;
    Ok(Some(BenchmarkFixtureDto { name, bytes }))
}

fn benchmark_phase(name: String) {
    eprintln!("[key-benchmark-phase] {name}");
}

fn benchmark_report(payload: serde_json::Value) {
    eprintln!("[key-benchmark-result] {payload}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(id: &str) -> DocumentDto {
        DocumentDto {
            id: id.to_owned(),
            title: None,
            pages: Vec::new(),
            toc: Vec::new(),
            links: Vec::new(),
        }
    }

    #[test]
    fn companion_store_rejects_updates_from_replaced_generations() {
        let storage = MemoryCompanionStorage::default();
        let stale = storage.begin("paper".to_owned(), document("paper"));
        let current = storage.begin("paper".to_owned(), document("paper"));
        let analysis = PaperPreprocessingDto {
            document: document("paper"),
            is_scientific: false,
            synthetic_links: Vec::new(),
            citations: Vec::new(),
            references: Vec::new(),
            signals: ScientificSignalsDto {
                reference_entries: 0,
                doi_entries: 0,
                bracket_citations: 0,
                superscript_citations: 0,
                concentrated_internal_links: 0,
            },
            processing_ms: 1.0,
        };

        assert!(!storage.install_local_analysis("paper", stale, analysis.clone(), Vec::new()));
        assert!(storage.install_local_analysis("paper", current, analysis, Vec::new()));
        assert_eq!(storage.snapshot("paper").unwrap().stage, "ready");
    }
    #[test]
    fn canonical_native_pages_are_persisted_without_retaining_whole_document_text() {
        let root = env::temp_dir().join(format!(
            "key-host-native-library-test-{}",
            std::process::id()
        ));
        let library = key_library::Library::open(&root).unwrap();
        let input =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/interaction.pdf");
        let bytes = std::fs::read(&input).unwrap();
        let hash = sha256_hex(&bytes);
        preprocess_file_to_library(&input, &root, &hash).unwrap();
        let analysis: PaperPreprocessingDto = library
            .get(&hash, "analysis", "pdfium-v4", "document")
            .unwrap()
            .unwrap();
        let storage = MemoryCompanionStorage {
            library: Some(library.clone()),
            ..Default::default()
        };
        let generation = storage.begin(hash.clone(), analysis.document.clone());
        storage.set_document_hash(&hash, generation, hash.clone());
        assert!(storage.install_local_analysis(&hash, generation, analysis, Vec::new()));
        let snapshot = storage.snapshot(&hash).unwrap();
        assert!(snapshot.has_native_text);
        assert!(
            storage
                .snapshot_since(&hash, Some(snapshot.analysis_revision))
                .unwrap()
                .analysis
                .is_none()
        );
        assert!(storage.records.lock().unwrap()[&hash].text_pages.is_empty());
        assert!(
            storage
                .page(&hash, 0)
                .unwrap()
                .text
                .contains("Select this sentence")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub struct Host {
    native: NativePdfService,
    store: CompanionStore,
    search: SemanticSearchService,
    imports: key_library::Imports,
    sessions: Arc<key_semantic_search::SearchSessions>,
}
impl Host {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let search = SemanticSearchService::try_start_at(root)?;
        let host = Self {
            native: NativePdfService::start(),
            store: CompanionStore {
                reader_ids: Arc::default(),
                storage: Arc::new(MemoryCompanionStorage {
                    library: Some(search.library().clone()),
                    ..Default::default()
                }),
            },
            search,
            imports: Default::default(),
            sessions: Arc::default(),
        };
        for doc in host.search.library_documents()? {
            if doc.has_source
                && (matches!(doc.status.as_str(), "queued" | "processing" | "indexing")
                    || (matches!(doc.status.as_str(), "indexed" | "no_text")
                        && host.search.library().get::<bool>(
                            &doc.document_hash,
                            "native-complete",
                            "pdfium-v4",
                            "document",
                        )? != Some(true)))
            {
                let (store, search, native) =
                    (host.store.clone(), host.search.clone(), host.native.clone());
                processing_scheduler().submit(doc.document_hash.clone(), "resume", 10, move || {
                    if let Err(error) = resume_library_document(
                        store,
                        search.clone(),
                        native,
                        doc.document_hash.clone(),
                    ) {
                        let _ = search.set_document_progress(
                            &doc.document_hash,
                            "failed",
                            doc.completed,
                            doc.total,
                            Some(error),
                        );
                    }
                });
            }
        }
        Ok(host)
    }
    pub fn can_suspend(&self) -> bool {
        self.imports.is_empty()
            && self
                .store
                .reader_ids
                .lock()
                .map(|ids| ids.is_empty())
                .unwrap_or(false)
            && self
                .search
                .library_documents()
                .map(|documents| {
                    !documents.iter().any(|document| {
                        matches!(
                            document.status.as_str(),
                            "queued" | "processing" | "indexing"
                        )
                    })
                })
                .unwrap_or(false)
    }
    pub fn immediate(
        &self,
        command: &str,
        args: &serde_json::Value,
    ) -> Option<Result<Output, String>> {
        match command {
            "native_cancel_render" => Some(
                arg(args, "requestId")
                    .and_then(|id| json_output(native_cancel_render(HostState(&self.native), id))),
            ),
            "processing_interaction" => Some(json_output(processing_interaction())),
            "library_prioritize" => {
                Some(arg(args, "hash").and_then(|hash| json_output(library_prioritize(hash))))
            }
            _ => None,
        }
    }
    pub async fn dispatch(
        &self,
        command: &str,
        args: &serde_json::Value,
        binary: &[u8],
        headers: &http::HeaderMap,
    ) -> Result<Output, String> {
        let body = ipc::InvokeBody::Raw(binary.to_vec());
        let request = ipc::Request {
            headers,
            body: &body,
        };
        match command {
            "preprocess_paper" => json_output(
                preprocess_paper(
                    HostState(&self.native),
                    arg(args, "id")?,
                    if !binary.is_empty() {
                        binary.to_vec()
                    } else {
                        arg(args, "bytes")?
                    },
                )
                .await?,
            ),
            "preprocess_paper_disposable" => json_output(
                preprocess_paper_disposable(
                    HostState(&self.search),
                    HostState(&self.store),
                    arg(args, "id")?,
                    if !binary.is_empty() {
                        binary.to_vec()
                    } else {
                        arg(args, "bytes")?
                    },
                    arg(args, "includeText")?,
                )
                .await?,
            ),
            "library_import_begin" => json_output(library_import_begin(
                HostState(&self.search),
                HostState(&self.imports),
                arg(args, "title")?,
                arg(args, "length")?,
            )?),
            "library_import_chunk" => {
                json_output(library_import_chunk(HostState(&self.imports), request)?)
            }
            "library_import_finish" => json_output(library_import_finish(
                HostState(&self.search),
                HostState(&self.imports),
                arg(args, "id")?,
            )?),
            "library_import_cancel" => json_output(library_import_cancel(
                HostState(&self.imports),
                arg(args, "id")?,
            )?),
            "library_source_info" => {
                json_output(library_source_info(HostState(&self.search), arg(args, "hash")?).await?)
            }
            "library_source_range" => Ok(Output::Binary(
                library_source_range(
                    HostState(&self.search),
                    arg(args, "hash")?,
                    arg(args, "offset")?,
                    arg(args, "length")?,
                )
                .await?
                .0,
            )),
            "begin_pdfjs_companion_managed" => json_output(
                begin_pdfjs_companion_managed(
                    HostState(&self.native),
                    HostState(&self.store),
                    HostState(&self.search),
                    arg(args, "hash")?,
                )
                .await?,
            ),
            "begin_pdfjs_companion_binary" => json_output(
                begin_pdfjs_companion_binary(
                    HostState(&self.native),
                    HostState(&self.store),
                    HostState(&self.search),
                    request,
                )
                .await?,
            ),
            "begin_pdfjs_companion" => json_output(
                begin_pdfjs_companion(
                    HostState(&self.native),
                    HostState(&self.store),
                    HostState(&self.search),
                    arg(args, "id")?,
                    arg(args, "fileName")?,
                    if !binary.is_empty() {
                        binary.to_vec()
                    } else {
                        arg(args, "bytes")?
                    },
                    arg(args, "semanticOnnx")?,
                )
                .await?,
            ),
            "pdfjs_companion_snapshot" => json_output(pdfjs_companion_snapshot(
                HostState(&self.search),
                HostState(&self.store),
                arg(args, "id")?,
                arg(args, "afterAnalysisRevision")?,
            )?),
            "pdfjs_companion_list" => json_output(pdfjs_companion_list(HostState(&self.store))),
            "processing_interaction" => json_output(processing_interaction()),
            "library_prioritize" => json_output(library_prioritize(arg(args, "hash")?)),
            "semantic_library_page" => {
                let mut filter: key_library::Filter = arg::<Option<key_library::Filter>>(args, "filter")?.unwrap_or_default();
                if filter.project_id.is_none() { filter.project_id = arg(args,"projectId")?; }
                filter.removed = arg::<Option<bool>>(args,"removed")?.unwrap_or(filter.removed);
                filter.sort = arg::<Option<String>>(args,"sort")?.or(filter.sort);
                filter.statuses = arg::<Option<Vec<String>>>(args,"statuses")?.or(filter.statuses);
                filter.document_hashes = arg::<Option<Vec<String>>>(args,"documentHashes")?.or(filter.document_hashes);
                let counts = self.search.library().document_status_counts(filter.project_id.as_deref())?;
                let limit = arg::<Option<usize>>(args,"limit")?.unwrap_or(100).clamp(1,500);
                let offset = arg::<Option<usize>>(args,"offset")?.unwrap_or(0);
                let (documents,total) = self.search.library().documents_page(&filter,limit,offset)?;
                let next_offset = offset.saturating_add(documents.len());
                json_output(serde_json::json!({"documents":documents,"total":total,"counts":counts,"nextOffset":if next_offset<total {Some(next_offset)}else{None}}))
            }
            "semantic_library" => {
                let mut filter: key_library::Filter =
                    arg::<Option<key_library::Filter>>(args, "filter")?.unwrap_or_default();
                if filter.project_id.is_none() {
                    filter.project_id = arg(args, "projectId")?;
                }
                let eligible: HashSet<String> = self
                    .search
                    .library()
                    .documents(&filter)?
                    .into_iter()
                    .map(|doc| doc.document_hash)
                    .collect();
                let documents = semantic_library(HostState(&self.search))?
                    .into_iter()
                    .filter(|doc| eligible.contains(&doc.document_hash))
                    .collect::<Vec<_>>();
                json_output(documents)
            }
            "library_processing_control" => json_output(library_processing_control(
                HostState(&self.native),
                HostState(&self.store),
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "action")?,
            )?),
            "library_removed_documents" => {
                let mut filter: key_library::Filter =
                    arg::<Option<key_library::Filter>>(args, "filter")?.unwrap_or_default();
                filter.removed = true;
                if filter.project_id.is_none() {
                    filter.project_id = arg(args, "projectId")?;
                }
                json_output(self.search.library().documents(&filter)?)
            }
            "library_purge" => json_output(
                library_purge(
                    HostState(&self.search),
                    HostState(&self.store),
                    arg(args, "hash")?,
                )
                .await?,
            ),
            "library_set_removed" => json_output(library_set_removed(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "removed")?,
            )?),
            "library_tags" => json_output(self.search.library().library_tags(arg::<Option<usize>>(args,"offset")?.unwrap_or(0),arg::<Option<usize>>(args,"limit")?.unwrap_or(200))?),
            "library_retag" => json_output(self.search.library().library_retag(&arg::<Vec<String>>(args,"from")?,arg::<Option<String>>(args,"to")?.as_deref())?),
            "library_metadata_details" => json_output(library_metadata_details(
                HostState(&self.search),
                arg(args, "hash")?,
            )?),
            "library_set_labels" => json_output(library_set_labels(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "tags")?,
                arg(args, "collections")?,
            )?),
            "library_update_metadata" => json_output(library_update_metadata(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "title")?,
                arg(args, "year")?,
                arg(args, "authors")?,
            )?),
            "library_set_property" => json_output(library_set_property(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "name")?,
                arg(args, "value")?,
            )?),
            "library_annotations" => json_output(library_annotations(
                HostState(&self.search),
                arg(args, "hash")?,
            )?),
            "library_apply_annotations" => json_output(library_apply_annotations(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "upserts")?,
                arg(args, "deleted")?,
            )?),
            "library_save_annotations" => json_output(library_save_annotations(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "annotations")?,
            )?),
            "library_import_annotations" => json_output(library_import_annotations(
                HostState(&self.search),
                arg(args, "hash")?,
                arg(args, "legacyId")?,
                arg(args, "annotations")?,
            )?),
            "resolve_search_target" => json_output(resolve_search_target(
                HostState(&self.search),
                arg(args, "id")?,
            )?),
            "library_source" => Ok(Output::Binary(
                library_source(HostState(&self.search), arg(args, "hash")?)?.0,
            )),
            "global_search_page" => json_output(
                global_search_page(
                    HostState(&self.search),
                    HostState(&self.sessions),
                    arg(args, "query")?,
                    arg(args, "filter")?,
                    arg(args, "cursor")?,
                )
                .await?,
            ),
            "global_search" => json_output(
                global_search(
                    HostState(&self.search),
                    arg(args, "query")?,
                    arg(args, "limit")?,
                    arg(args, "filter")?,
                )
                .await?,
            ),
            "scholarly_lookup_resource" => {
                json_output(scholarly_lookup_resource(arg(args, "resource")?).await?)
            }
            "disposable_text_page" => json_output(
                disposable_text_page(
                    HostState(&self.store),
                    HostState(&self.native),
                    HostState(&self.search),
                    arg(args, "id")?,
                    arg(args, "page")?,
                )
                .await?,
            ),
            "disposable_search" => json_output(
                disposable_search(
                    HostState(&self.store),
                    HostState(&self.native),
                    HostState(&self.search),
                    arg(args, "id")?,
                    arg(args, "query")?,
                )
                .await?,
            ),
            "release_disposable_document" => json_output(release_disposable_document(
                HostState(&self.store),
                arg(args, "id")?,
            )),
            "native_open_buffer" => json_output(
                native_open_buffer(
                    HostState(&self.native),
                    arg(args, "id")?,
                    if !binary.is_empty() {
                        binary.to_vec()
                    } else {
                        arg(args, "bytes")?
                    },
                )
                .await?,
            ),
            "native_render" => Ok(Output::Binary(
                native_render(
                    HostState(&self.native),
                    arg(args, "requestId")?,
                    arg(args, "id")?,
                    arg(args, "page")?,
                    arg(args, "width")?,
                    arg(args, "height")?,
                    arg(args, "x")?,
                    arg(args, "y")?,
                    arg(args, "rectWidth")?,
                    arg(args, "rectHeight")?,
                )
                .await?
                .0,
            )),
            "native_cancel_render" => json_output(native_cancel_render(
                HostState(&self.native),
                arg(args, "requestId")?,
            )),
            "native_text" => json_output(
                native_text(
                    HostState(&self.native),
                    arg(args, "id")?,
                    arg(args, "page")?,
                )
                .await?,
            ),
            "native_search" => json_output(
                native_search(
                    HostState(&self.native),
                    arg(args, "id")?,
                    arg(args, "query")?,
                )
                .await?,
            ),
            "native_hibernate" => {
                json_output(native_hibernate(HostState(&self.native), arg(args, "id")?).await?)
            }
            "native_close" => {
                json_output(native_close(HostState(&self.native), arg(args, "id")?).await?)
            }
            "benchmark_fixture" => json_output(benchmark_fixture()?),
            "benchmark_fixture_names" => json_output(benchmark_fixture_names()),
            "benchmark_workspace_mode" => json_output(benchmark_workspace_mode()),
            "benchmark_has_single_fixture" => json_output(benchmark_has_single_fixture()),
            "benchmark_preprocess_sidecar" => {
                json_output(benchmark_preprocess_sidecar(arg(args, "index")?).await?)
            }
            "benchmark_fixture_at" => json_output(benchmark_fixture_at(arg(args, "index")?)?),
            "benchmark_phase" => json_output(benchmark_phase(arg(args, "name")?)),
            "benchmark_report" => json_output(benchmark_report(arg(args, "payload")?)),
            "workspace_save_entry" => json_output(self.search.library().save_source_entry(arg::<Option<String>>(args,"id")?.as_deref(), &arg::<String>(args,"sourceType")?, &arg::<String>(args,"title")?, arg::<Option<String>>(args,"url")?.as_deref(), &arg::<Option<String>>(args,"content")?.unwrap_or_default(), &arg::<Option<serde_json::Value>>(args,"properties")?.unwrap_or(serde_json::json!({})), arg(args,"expectedRevision")?, arg::<Option<String>>(args,"projectId")?.as_deref())?),
            "workspace_entries" => json_output(self.search.library().source_entries(arg::<Option<String>>(args,"projectId")?.as_deref(),arg::<Option<String>>(args,"query")?.as_deref(),arg::<Option<usize>>(args,"limit")?.unwrap_or(50),arg::<Option<usize>>(args,"offset")?.unwrap_or(0))?),
            "workspace_entry" => json_output(self.search.library().source_entry(&arg::<String>(args,"id")?)?),
            "workspace_attributes" => json_output(self.search.library().workspace_attributes()?),
            "workspace_save_attribute" => json_output(self.search.library().save_workspace_attribute(&arg::<String>(args,"name")?,&arg::<serde_json::Value>(args,"config")?)?),
            "workspace_rename_attribute" => json_output(self.search.library().rename_workspace_attribute(&arg::<String>(args,"name")?,&arg::<String>(args,"newName")?)?),
            "workspace_delete_attribute" => json_output(self.search.library().delete_workspace_attribute(&arg::<String>(args,"name")?,arg::<Option<bool>>(args,"deleteValues")?.unwrap_or(false))?),
            "workspace_agent_property" => json_output(self.search.library().agent_property(&arg::<String>(args,"name")?)?),
            "workspace_save_agent_property" => json_output(self.search.library().save_agent_property(&arg::<String>(args,"name")?,&arg::<serde_json::Value>(args,"config")?)?),
            "workspace_fill_known_property" => json_output(self.search.library().fill_known_property(&arg::<Vec<String>>(args,"hashes")?,&arg::<String>(args,"name")?,&arg::<String>(args,"input")?)?),
            "workspace_agent_context" => json_output(self.search.library().agent_context(&arg::<String>(args,"hash")?,&arg::<Vec<String>>(args,"inputs")?)?),
            "workspace_apply_property_proposal" => json_output(self.search.library().apply_property_proposal(&arg::<String>(args,"hash")?,&arg::<String>(args,"name")?,&arg::<serde_json::Value>(args,"value")?,&arg::<serde_json::Value>(args,"expectedValue")?,&arg::<serde_json::Value>(args,"provenance")?)?),
            "workspace_initialize" => json_output(self.search.library().initialize_workspace(
                &arg::<String>(args, "name")?,
                &arg::<PathBuf>(args, "workspaceRoot")?,
            )?),
            "workspace_set_appearance" => json_output(self.search.library().set_workspace_appearance(&arg::<String>(args,"icon")?,&arg::<String>(args,"color")?)?),
            "workspace_info" => json_output(self.search.library().workspace_info()?),
            "workspace_projects" => json_output(self.search.library().projects()?),
            "workspace_create_project" => json_output(
                self.search
                    .library()
                    .create_project(&arg::<String>(args, "name")?)?,
            ),
            "workspace_record" => json_output(self.search.library().workspace_record(&arg::<String>(args, "id")?)?),
            "workspace_records" => json_output(self.search.library().records(
                arg::<Option<String>>(args, "projectId")?.as_deref(),
                arg::<Option<String>>(args, "query")?.as_deref(),
                arg::<Option<usize>>(args, "limit")?.unwrap_or(100),
                arg::<Option<usize>>(args, "offset")?.unwrap_or(0),
            )?),
            "workspace_save_record" => json_output(self.search.library().save_record(
                arg::<Option<String>>(args, "id")?.as_deref(),
                &arg::<String>(args, "kind")?,
                &arg::<String>(args, "title")?,
                &arg::<serde_json::Value>(args, "properties")?,
                &arg::<String>(args, "body")?,
                arg(args, "expectedRevision")?,
            )?),
            "workspace_register_file" => json_output(self.search.library().register_workspace_file(
                &arg::<PathBuf>(args, "path")?, &arg::<String>(args, "editor")?, &arg::<String>(args, "title")?
            )?),
            "workspace_set_project_membership" => {
                json_output(self.search.library().set_project_membership(
                    &arg::<String>(args, "projectId")?,
                    &arg::<String>(args, "recordId")?,
                    arg(args, "present")?,
                )?)
            }
            "workspace_link_folder" => json_output(self.search.library().link_folder(
                &arg::<String>(args, "projectId")?,
                &arg::<PathBuf>(args, "path")?,
            )?),
            "workspace_linked_folders" => json_output(self.search.library().linked_folders()?),
            "workspace_scan_linked_folder" => {
                let report = self.search.library().scan_linked_folder(
                    &arg::<String>(args, "id")?,
                    arg::<Option<usize>>(args, "maxEntries")?.unwrap_or(10000),
                )?;
                for hash in &report.pdf_hashes {
                    let (store, search, native, hash) = (
                        self.store.clone(),
                        self.search.clone(),
                        self.native.clone(),
                        hash.clone(),
                    );
                    processing_scheduler().submit(hash.clone(), "linked-import", 10, move || {
                        if let Err(error) =
                            resume_library_document(store, search.clone(), native, hash.clone())
                        {
                            let _ =
                                search.set_document_progress(&hash, "failed", 0, 0, Some(error));
                        }
                    });
                }
                json_output(report)
            }
            "library_import_file" => {
                use std::io::Read;
                let expected: Option<String> = arg(args, "expectedHash")?;
                let path: PathBuf = arg(args, "path")?;
                let mut file = File::open(&path).map_err(|e| e.to_string())?;
                if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                    return Err("Import requires a regular PDF file".into());
                }
                let title = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Document.pdf")
                    .to_owned();
                let length = file.metadata().map_err(|e| e.to_string())?.len();
                let id = self.imports.begin(self.search.library(), title, length)?;
                let result = (|| {
                    let mut buffer = vec![0; 1024 * 1024];
                    let mut offset = 0;
                    loop {
                        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                        if count == 0 {
                            break;
                        }
                        offset = self.imports.append(&id, offset, &buffer[..count])?;
                    }
                    self.imports.finish_expected(self.search.library(), &id, expected.as_deref())
                })();
                if result.is_err() {
                    let _ = self.imports.cancel(&id);
                }
                json_output(result?)
            }
            "host_info" => json_output(
                serde_json::json!({"protocol":1,"backend":"key-rust","binaryLimit":33554432}),
            ),
            _ => Err(format!("Unknown Key command: {command}")),
        }
    }
}
