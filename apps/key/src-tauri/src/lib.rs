mod native_process;
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
use tauri::{
    Emitter, Manager,
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
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
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vendor/pdfium/lib"));
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

#[tauri::command]
async fn preprocess_paper(
    service: tauri::State<'_, NativePdfService>,
    id: String,
    bytes: Vec<u8>,
) -> Result<PaperPreprocessingDto, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
async fn preprocess_paper_disposable(
    search: tauri::State<'_, SemanticSearchService>,
    store: tauri::State<'_, CompanionStore>,
    id: String,
    bytes: Vec<u8>,
    include_text: Option<bool>,
) -> Result<serde_json::Value, String> {
    let library = search.library().clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
fn library_import_begin(
    search: tauri::State<'_, SemanticSearchService>,
    imports: tauri::State<'_, key_library::Imports>,
    title: String,
    length: u64,
) -> Result<String, String> {
    imports.begin(search.library(), title, length)
}
#[tauri::command]
fn library_import_chunk(
    imports: tauri::State<'_, key_library::Imports>,
    request: tauri::ipc::Request<'_>,
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
        tauri::ipc::InvokeBody::Raw(bytes) => imports.append(id, offset, bytes),
        _ => Err("Import requires binary chunks".into()),
    }
}
#[tauri::command]
fn library_import_finish(
    search: tauri::State<'_, SemanticSearchService>,
    imports: tauri::State<'_, key_library::Imports>,
    id: String,
) -> Result<key_library::SourceInfo, String> {
    imports.finish(search.library(), &id)
}
#[tauri::command]
fn library_import_cancel(
    imports: tauri::State<'_, key_library::Imports>,
    id: String,
) -> Result<(), String> {
    imports.cancel(&id)
}
#[tauri::command]
async fn library_source_info(
    search: tauri::State<'_, SemanticSearchService>,
    hash: String,
) -> Result<key_library::SourceInfo, String> {
    let library = search.library().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.verify_source(&hash)?;
        library.source_info(&hash)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn library_source_range(
    search: tauri::State<'_, SemanticSearchService>,
    hash: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    let library = search.library().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library
            .source_range(&hash, offset, length)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn begin_pdfjs_companion_managed(
    service: tauri::State<'_, NativePdfService>,
    store: tauri::State<'_, CompanionStore>,
    search: tauri::State<'_, SemanticSearchService>,
    hash: String,
) -> Result<CompanionSnapshotDto, String> {
    let service = service.inner().clone();
    let store = store.inner().clone();
    let search = search.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
async fn begin_pdfjs_companion_binary(
    service: tauri::State<'_, NativePdfService>,
    store: tauri::State<'_, CompanionStore>,
    search: tauri::State<'_, SemanticSearchService>,
    request: tauri::ipc::Request<'_>,
) -> Result<CompanionSnapshotDto, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
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

#[tauri::command]
async fn begin_pdfjs_companion(
    service: tauri::State<'_, NativePdfService>,
    store: tauri::State<'_, CompanionStore>,
    search: tauri::State<'_, SemanticSearchService>,
    id: String,
    file_name: Option<String>,
    bytes: Vec<u8>,
    semantic_onnx: Option<bool>,
) -> Result<CompanionSnapshotDto, String> {
    let service = service.inner().clone();
    let store = store.inner().clone();
    let search = search.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
fn pdfjs_companion_snapshot(
    search: tauri::State<'_, SemanticSearchService>,
    store: tauri::State<'_, CompanionStore>,
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

#[tauri::command]
fn pdfjs_companion_list(store: tauri::State<'_, CompanionStore>) -> Vec<CompanionSnapshotDto> {
    store.storage.list()
}

#[tauri::command]
fn processing_interaction() {
    key_processing::mark_interaction();
}

#[tauri::command]
fn library_prioritize(hash: String) {
    processing_scheduler().prioritize(&hash);
}

#[tauri::command]
fn semantic_library(
    service: tauri::State<'_, SemanticSearchService>,
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
#[tauri::command]
fn library_processing_control(
    native: tauri::State<'_, NativePdfService>,
    store: tauri::State<'_, CompanionStore>,
    search: tauri::State<'_, SemanticSearchService>,
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
#[tauri::command]
fn library_removed_documents(
    search: tauri::State<'_, SemanticSearchService>,
) -> Result<Vec<key_library::Document>, String> {
    search.library().documents(&key_library::Filter {
        removed: true,
        ..Default::default()
    })
}
#[tauri::command]
async fn library_purge(
    search: tauri::State<'_, SemanticSearchService>,
    store: tauri::State<'_, CompanionStore>,
    hash: String,
) -> Result<(), String> {
    let library = search.library().clone();
    let readers = store.reader_ids.clone();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
fn library_set_removed(
    search: tauri::State<'_, SemanticSearchService>,
    hash: String,
    removed: bool,
) -> Result<(), String> {
    search.library().set_removed(&hash, removed)
}
#[tauri::command]
fn library_metadata_details(
    search: tauri::State<'_, SemanticSearchService>,
    hash: String,
) -> Result<key_library::MetadataDetails, String> {
    search.library().metadata_details(&hash)
}
#[tauri::command]
fn library_set_labels(
    search: tauri::State<'_, SemanticSearchService>,
    hash: String,
    tags: Vec<String>,
    collections: Vec<String>,
) -> Result<(), String> {
    search.library().set_labels(&hash, &tags, &collections)
}
#[tauri::command]
fn library_update_metadata(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
    title: String,
    year: Option<i64>,
    authors: Vec<String>,
) -> Result<(), String> {
    service
        .library()
        .update_metadata(&hash, &title, year, &authors)
}
#[tauri::command]
fn library_set_property(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    service.library().set_property(&hash, &name, &value)
}

#[tauri::command]
fn library_annotations(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
) -> Result<Vec<serde_json::Value>, String> {
    service.library().annotations(&hash)
}
#[tauri::command]
fn library_apply_annotations(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
    upserts: Vec<serde_json::Value>,
    deleted: Vec<String>,
) -> Result<(), String> {
    service
        .library()
        .apply_annotations(&hash, &upserts, &deleted)
}
#[tauri::command]
fn library_save_annotations(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
    annotations: Vec<serde_json::Value>,
) -> Result<(), String> {
    service.library().save_annotations(&hash, &annotations)
}
#[tauri::command]
fn library_import_annotations(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
    legacy_id: String,
    annotations: Vec<serde_json::Value>,
) -> Result<(), String> {
    service
        .library()
        .import_annotations(&hash, &legacy_id, &annotations)
}
#[tauri::command]
fn resolve_search_target(
    service: tauri::State<'_, SemanticSearchService>,
    id: String,
) -> Result<key_library::Passage, String> {
    service
        .library()
        .passage(&id)?
        .ok_or_else(|| "This search passage is no longer available. Search again.".into())
}

#[tauri::command]
fn library_source(
    service: tauri::State<'_, SemanticSearchService>,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(service.library().source_path(&hash)?).map_err(|e| e.to_string())?;
    if sha256_hex(&bytes) != hash {
        return Err("The saved PDF failed its content hash check".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn global_search_page(
    service: tauri::State<'_, SemanticSearchService>,
    sessions: tauri::State<'_, Arc<key_semantic_search::SearchSessions>>,
    query: String,
    filter: Option<key_library::Filter>,
    cursor: Option<String>,
) -> Result<key_semantic_search::SearchPage, String> {
    let service = service.inner().clone();
    let sessions = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sessions.search(&service, query, filter.unwrap_or_default(), cursor)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn global_search(
    service: tauri::State<'_, SemanticSearchService>,
    query: String,
    limit: Option<usize>,
    filter: Option<key_library::Filter>,
) -> Result<Vec<SemanticSearchHitDto>, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.search(
            query,
            limit.unwrap_or(20).clamp(1, 100),
            filter.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn scholarly_lookup_resource(resource: String) -> Result<ScholarlyMetadataDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
async fn disposable_text_page(
    store: tauri::State<'_, CompanionStore>,
    native: tauri::State<'_, NativePdfService>,
    search: tauri::State<'_, SemanticSearchService>,
    id: String,
    page: usize,
) -> Result<TextPageDto, String> {
    let store = store.inner().clone();
    let native = native.inner().clone();
    let library = search.library().clone();
    tauri::async_runtime::spawn_blocking(move || {
        cached_or_repaired_text_page(&store, &native, &library, &id, page)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn disposable_search(
    store: tauri::State<'_, CompanionStore>,
    native: tauri::State<'_, NativePdfService>,
    search: tauri::State<'_, SemanticSearchService>,
    id: String,
    query: String,
) -> Result<Vec<SearchMatchDto>, String> {
    let store = store.inner().clone();
    let native = native.inner().clone();
    let library = search.library().clone();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
fn release_disposable_document(store: tauri::State<'_, CompanionStore>, id: String) {
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

#[tauri::command]
async fn native_open_buffer(
    service: tauri::State<'_, NativePdfService>,
    id: String,
    bytes: Vec<u8>,
) -> Result<DocumentDto, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match service.request(|reply| Request::OpenBytes { id, bytes, reply })? {
            Reply::Document(document) => Ok(document),
            _ => Err("native PDFium returned an unexpected open reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn native_render(
    service: tauri::State<'_, NativePdfService>,
    request_id: u64,
    id: String,
    page: usize,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    rect_width: u32,
    rect_height: u32,
) -> Result<tauri::ipc::Response, String> {
    let service = service.inner().clone();
    let cancellation = service.render_cancellation(request_id);
    let worker_service = service.clone();
    #[cfg(debug_assertions)]
    eprintln!(
        "native_render begin request={request_id} page={page} raster={width}x{height} rect={x},{y} {rect_width}x{rect_height}"
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
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
        Reply::Pixels(pixels) => Ok(tauri::ipc::Response::new(pixels)),
        _ => Err("native PDFium returned an unexpected render reply".to_owned()),
    }
}

#[tauri::command]
fn native_cancel_render(service: tauri::State<'_, NativePdfService>, request_id: u64) {
    service.cancel_render(request_id);
}

#[tauri::command]
async fn native_text(
    service: tauri::State<'_, NativePdfService>,
    id: String,
    page: usize,
) -> Result<TextPageDto, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match service.request(|reply| Request::Text { id, page, reply })? {
            Reply::Text(text) => Ok(text),
            _ => Err("native PDFium returned an unexpected text reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn native_search(
    service: tauri::State<'_, NativePdfService>,
    id: String,
    query: String,
) -> Result<Vec<SearchMatchDto>, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match service.request(|reply| Request::Search { id, query, reply })? {
            Reply::Search(results) => Ok(results),
            _ => Err("native PDFium returned an unexpected search reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn native_hibernate(
    service: tauri::State<'_, NativePdfService>,
    id: String,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match service.request(|reply| Request::Hibernate { id, reply })? {
            Reply::Hibernated => Ok(()),
            _ => Err("native PDFium returned an unexpected hibernate reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn native_close(
    service: tauri::State<'_, NativePdfService>,
    id: String,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match service.request(|reply| Request::Close { id, reply })? {
            Reply::Closed => Ok(()),
            _ => Err("native PDFium returned an unexpected close reply".to_owned()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn benchmark_workspace_mode() -> bool {
    env::var_os("KEY_WORKSPACE_BENCHMARK").is_some()
}

#[tauri::command]
fn benchmark_has_single_fixture() -> bool {
    env::var_os("KEY_BENCHMARK_PDF").is_some()
}

#[tauri::command]
async fn benchmark_preprocess_sidecar(index: usize) -> Result<BenchmarkSidecarDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
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

#[tauri::command]
async fn benchmark_open_renderer(
    app: tauri::AppHandle,
    slot: usize,
    generation: usize,
    fixture_index: usize,
) -> Result<String, String> {
    let label = format!("pdf-renderer-{slot}-{generation}");
    let url = format!(
        "index.html?renderer=pdfjs-isolated-pane&fixtureIndex={fixture_index}&slot={slot}&generation={generation}"
    );
    let x = if slot == 0 { 20.0 } else { 740.0 };
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(format!("PDF renderer {}", slot + 1))
        .inner_size(700.0, 860.0)
        .position(x, 60.0)
        .decorations(false)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(label)
}

#[tauri::command]
async fn benchmark_close_renderer(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn benchmark_phase(name: String) {
    eprintln!("[key-benchmark-phase] {name}");
}

#[tauri::command]
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
        let root = env::temp_dir().join(format!("key-native-library-test-{}", std::process::id()));
        let library = key_library::Library::open(&root).unwrap();
        let input =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/interaction.pdf");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativePdfService::start())
        .manage(key_library::Imports::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let semantic_root = if env::var_os("KEY_BENCHMARK_PDF").is_some()
                || env::var_os("KEY_BENCHMARK_PDFS").is_some()
            {
                env::var_os("KEY_BENCHMARK_LIBRARY")
                    .map(PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?.join("semantic-search"))
            } else {
                app.path().app_data_dir()?.join("semantic-search")
            };
            let search = SemanticSearchService::try_start_at(semantic_root)
                .map_err(std::io::Error::other)?;
            app.manage(CompanionStore {
                reader_ids: Arc::default(),
                storage: Arc::new(MemoryCompanionStorage {
                    library: Some(search.library().clone()),
                    ..Default::default()
                }),
            });
            let store = app.state::<CompanionStore>().inner().clone();
            for doc in search.library_documents().map_err(std::io::Error::other)? {
                if doc.has_source
                    && (matches!(doc.status.as_str(), "queued" | "processing" | "indexing")
                        || (matches!(doc.status.as_str(), "indexed" | "no_text")
                            && search
                                .library()
                                .get::<bool>(
                                    &doc.document_hash,
                                    "native-complete",
                                    "pdfium-v4",
                                    "document",
                                )
                                .map_err(std::io::Error::other)?
                                != Some(true)))
                {
                    let native = app.state::<NativePdfService>().inner().clone();
                    let store = store.clone();
                    let search = search.clone();
                    processing_scheduler().submit(
                        doc.document_hash.clone(),
                        "resume",
                        10,
                        move || {
                            if let Err(error) = resume_library_document(
                                store.clone(),
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
                        },
                    );
                }
            }
            let maintenance = search.library().clone();
            processing_scheduler().submit("maintenance".into(), "generations", 0, move || {
                if let Err(error) =
                    maintenance.collect_old_generations(Duration::from_secs(7 * 24 * 3600))
                {
                    eprintln!("Generation cleanup failed: {error}");
                }
            });
            app.manage(Arc::new(key_semantic_search::SearchSessions::default()));
            app.manage(search);
            let open_pdf = MenuItemBuilder::with_id("workspace.open", "Open PDF…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let zoom_out = MenuItemBuilder::with_id("control.zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let actual_size = MenuItemBuilder::with_id("control.actual-size", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;
            let zoom_in = MenuItemBuilder::with_id("control.zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let fit_width =
                MenuItemBuilder::with_id("control.fit-width", "Fit Width").build(app)?;
            let search = MenuItemBuilder::with_id("control.search", "Search")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;
            let outline =
                MenuItemBuilder::with_id("control.outline", "Document Outline").build(app)?;
            let references =
                MenuItemBuilder::with_id("control.references", "References").build(app)?;
            let comments = MenuItemBuilder::with_id("control.comments", "Comments").build(app)?;
            let sidebar =
                MenuItemBuilder::with_id("workspace.sidebar", "Open Documents").build(app)?;
            let split = MenuItemBuilder::with_id("workspace.split", "Split View").build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_pdf)
                .separator()
                .close_window()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&zoom_out)
                .item(&actual_size)
                .item(&zoom_in)
                .item(&fit_width)
                .separator()
                .item(&search)
                .item(&outline)
                .item(&references)
                .item(&comments)
                .separator()
                .item(&sidebar)
                .item(&split)
                .separator()
                .fullscreen()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            #[cfg(target_os = "macos")]
            let application_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .separator()
                .quit()
                .build()?;

            let menu = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            let menu = menu.item(&application_menu);
            let menu = menu
                .items(&[&file_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("app-menu-action", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            preprocess_paper,
            preprocess_paper_disposable,
            begin_pdfjs_companion,
            begin_pdfjs_companion_binary,
            begin_pdfjs_companion_managed,
            library_import_begin,
            library_import_chunk,
            library_import_finish,
            library_import_cancel,
            library_source_info,
            library_source_range,
            pdfjs_companion_snapshot,
            pdfjs_companion_list,
            semantic_library,
            library_prioritize,
            processing_interaction,
            library_processing_control,
            library_removed_documents,
            library_set_removed,
            library_purge,
            library_metadata_details,
            library_set_labels,
            library_update_metadata,
            library_set_property,
            library_annotations,
            library_save_annotations,
            library_apply_annotations,
            library_import_annotations,
            library_source,
            resolve_search_target,
            global_search_page,
            global_search,
            scholarly_lookup_resource,
            disposable_text_page,
            disposable_search,
            release_disposable_document,
            native_open_buffer,
            native_render,
            native_cancel_render,
            native_text,
            native_search,
            native_hibernate,
            native_close,
            benchmark_fixture,
            benchmark_fixture_names,
            benchmark_workspace_mode,
            benchmark_has_single_fixture,
            benchmark_fixture_at,
            benchmark_preprocess_sidecar,
            benchmark_open_renderer,
            benchmark_close_renderer,
            benchmark_phase,
            benchmark_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running Key");
}
