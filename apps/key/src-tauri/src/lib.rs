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
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fs::File,
    hash::{Hash, Hasher},
    io::BufWriter,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Condvar, Mutex, OnceLock,
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
    stage: String,
    document: DocumentDto,
    analysis: Option<PaperPreprocessingDto>,
    has_native_text: bool,
    completed_references: usize,
    total_references: usize,
    error: Option<String>,
}

#[derive(Clone)]
struct CompanionRecord {
    generation: u64,
    revision: u64,
    stage: String,
    document: DocumentDto,
    analysis: Option<PaperPreprocessingDto>,
    text_pages: Vec<TextPageDto>,
    completed_references: usize,
    total_references: usize,
    error: Option<String>,
}

impl CompanionRecord {
    fn snapshot(&self) -> CompanionSnapshotDto {
        CompanionSnapshotDto {
            generation: self.generation,
            revision: self.revision,
            stage: self.stage.clone(),
            document: self.document.clone(),
            analysis: self.analysis.clone(),
            has_native_text: !self.text_pages.is_empty(),
            completed_references: self.completed_references,
            total_references: self.total_references,
            error: self.error.clone(),
        }
    }
}

/// Runtime storage boundary for staged PDF companions.
///
/// The current implementation is deliberately in-memory. A SQLite-backed
/// implementation can replace it later without changing Tauri commands or the
/// PDF.js reader's snapshot protocol.
trait CompanionStorage: Send + Sync {
    fn begin(&self, id: String, document: DocumentDto) -> u64;
    fn snapshot(&self, id: &str) -> Result<CompanionSnapshotDto, String>;
    fn install_local_analysis(
        &self,
        id: &str,
        generation: u64,
        analysis: PaperPreprocessingDto,
        text_pages: Vec<TextPageDto>,
    ) -> bool;
    fn update_reference(
        &self,
        id: &str,
        generation: u64,
        reference: ScientificReferenceDto,
    ) -> bool;
    fn finish(&self, id: &str, generation: u64);
    fn fail(&self, id: &str, generation: u64, error: String);
    fn page(&self, id: &str, page: usize) -> Result<TextPageDto, String>;
    fn pages(&self, id: &str) -> Result<Vec<TextPageDto>, String>;
    fn release(&self, id: &str);
}

#[derive(Default)]
struct MemoryCompanionStorage {
    records: Mutex<HashMap<String, CompanionRecord>>,
    next_generation: AtomicU64,
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
                    stage: "analyzing".to_owned(),
                    document,
                    analysis: None,
                    text_pages: Vec::new(),
                    completed_references: 0,
                    total_references: 0,
                    error: None,
                },
            );
        generation
    }

    fn snapshot(&self, id: &str) -> Result<CompanionSnapshotDto, String> {
        self.records
            .lock()
            .map_err(|_| "companion storage is poisoned".to_owned())?
            .get(id)
            .map(CompanionRecord::snapshot)
            .ok_or_else(|| format!("companion {id} is unavailable"))
    }

    fn install_local_analysis(
        &self,
        id: &str,
        generation: u64,
        analysis: PaperPreprocessingDto,
        text_pages: Vec<TextPageDto>,
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
        record.document = analysis.document.clone();
        record.total_references = analysis.references.len();
        record.completed_references = analysis
            .references
            .iter()
            .filter(|reference| reference.metadata.is_some() || reference.metadata_error.is_some())
            .count();
        record.analysis = Some(analysis);
        record.text_pages = text_pages;
        record.stage = if record.total_references == 0 {
            "ready".to_owned()
        } else {
            "enriching".to_owned()
        };
        record.error = None;
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
        self.records
            .lock()
            .map_err(|_| "companion storage is poisoned".to_owned())?
            .get(id)
            .and_then(|record| record.text_pages.get(page))
            .cloned()
            .ok_or_else(|| format!("PDFium text page {page} is unavailable for {id}"))
    }

    fn pages(&self, id: &str) -> Result<Vec<TextPageDto>, String> {
        self.records
            .lock()
            .map_err(|_| "companion storage is poisoned".to_owned())?
            .get(id)
            .map(|record| record.text_pages.clone())
            .ok_or_else(|| format!("PDFium text is unavailable for {id}"))
    }

    fn release(&self, id: &str) {
        if let Ok(mut records) = self.records.lock() {
            records.remove(id);
        }
    }
}

#[derive(Clone)]
struct CompanionStore {
    storage: Arc<dyn CompanionStorage>,
}

impl Default for CompanionStore {
    fn default() -> Self {
        Self {
            storage: Arc::new(MemoryCompanionStorage::default()),
        }
    }
}

struct AnalysisGate {
    active: Mutex<usize>,
    wake: Condvar,
}

struct AnalysisPermit(&'static AnalysisGate);

impl Drop for AnalysisPermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.wake.notify_one();
        }
    }
}

fn acquire_analysis_permit() -> AnalysisPermit {
    const MAX_CONCURRENT_ANALYSES: usize = 2;
    static GATE: OnceLock<AnalysisGate> = OnceLock::new();
    let gate = GATE.get_or_init(|| AnalysisGate {
        active: Mutex::new(0),
        wake: Condvar::new(),
    });
    let mut active = gate.active.lock().expect("analysis scheduler is poisoned");
    while *active >= MAX_CONCURRENT_ANALYSES {
        active = gate
            .wake
            .wait(active)
            .expect("analysis scheduler is poisoned");
    }
    *active += 1;
    drop(active);
    AnalysisPermit(gate)
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

enum Request {
    Preprocess {
        id: String,
        bytes: Vec<u8>,
        reply: Sender<Result<Reply, String>>,
    },
    OpenBytes {
        id: String,
        bytes: Vec<u8>,
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
        cancellation: CancellationSource,
        reply: Sender<Result<Reply, String>>,
    },
    Text {
        id: String,
        page: usize,
        reply: Sender<Result<Reply, String>>,
    },
    Search {
        id: String,
        query: String,
        reply: Sender<Result<Reply, String>>,
    },
    Hibernate {
        id: String,
        reply: Sender<Result<Reply, String>>,
    },
    Close {
        id: String,
        reply: Sender<Result<Reply, String>>,
    },
}

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
    sender: Sender<Request>,
    render_cancellations: Arc<Mutex<HashMap<u64, CancellationSource>>>,
}

impl NativePdfService {
    fn start() -> Self {
        let (sender, receiver) = mpsc::channel();
        let render_cancellations = Arc::new(Mutex::new(HashMap::new()));
        thread::Builder::new()
            .name("tauri-pdfium-owner".to_owned())
            .spawn(move || run_pdfium_owner(receiver))
            .expect("failed to start the PDFium owner thread");
        Self {
            sender,
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
                        document.text_cache_limit = usize::MAX;
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
    let mut sessions = DocumentSessionManager::new();
    let session = sessions.begin().map_err(|error| error.to_string())?;
    let document = engine
        .open(PdfiumDocumentSource::bytes(bytes), &session.cancellation())
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
    store: tauri::State<'_, CompanionStore>,
    id: String,
    bytes: Vec<u8>,
    include_text: Option<bool>,
) -> Result<serde_json::Value, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sidecar = load_or_create_disposable_sidecar(&id, bytes)?;
        enrich_reference_metadata(&mut sidecar.analysis.references);
        let text_pages = sidecar.text_pages;
        let has_native_text = !text_pages.is_empty();
        let generation = store
            .storage
            .begin(id.clone(), sidecar.analysis.document.clone());
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
    id: &str,
    bytes: Vec<u8>,
) -> Result<DiskPreprocessingSidecar, String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // v4 separates local PDF analysis from network metadata enrichment.
    4_u8.hash(&mut hasher);
    id.hash(&mut hasher);
    bytes.hash(&mut hasher);
    let cache_key = hasher.finish();
    let directory = env::temp_dir().join("key-sidecars").join("interactive");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
    let input = directory.join(format!("{cache_key:016x}.pdf"));
    let output = directory.join(format!("{cache_key:016x}.json"));

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

fn begin_background_companion_analysis(
    store: CompanionStore,
    id: String,
    generation: u64,
    bytes: Vec<u8>,
) {
    thread::Builder::new()
        .name(format!("pdf-companion-{generation}"))
        .spawn(move || {
            let _permit = acquire_analysis_permit();
            if !matches!(
                store.storage.snapshot(&id),
                Ok(snapshot) if snapshot.generation == generation
            ) {
                return;
            }
            let sidecar = match load_or_create_disposable_sidecar(&id, bytes) {
                Ok(sidecar) => sidecar,
                Err(error) => {
                    store.storage.fail(&id, generation, error);
                    return;
                }
            };
            let mut references = sidecar.analysis.references.clone();
            if !store.storage.install_local_analysis(
                &id,
                generation,
                sidecar.analysis,
                sidecar.text_pages,
            ) {
                return;
            }
            if references.is_empty() {
                store.storage.finish(&id, generation);
                return;
            }
            enrich_reference_metadata_streaming(&store, &id, generation, &mut references);
            store.storage.finish(&id, generation);
        })
        .expect("failed to start staged PDF companion analysis");
}

#[tauri::command]
async fn begin_pdfjs_companion(
    service: tauri::State<'_, NativePdfService>,
    store: tauri::State<'_, CompanionStore>,
    id: String,
    bytes: Vec<u8>,
) -> Result<CompanionSnapshotDto, String> {
    let service = service.inner().clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let analysis_bytes = bytes.clone();
        let document = match service.request(|reply| Request::OpenBytes {
            id: id.clone(),
            bytes,
            reply,
        })? {
            Reply::Document(document) => document,
            _ => return Err("native PDFium returned an unexpected open reply".to_owned()),
        };
        let generation = store.storage.begin(id.clone(), document);
        let snapshot = store.storage.snapshot(&id)?;
        begin_background_companion_analysis(store, id, generation, analysis_bytes);
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn pdfjs_companion_snapshot(
    store: tauri::State<'_, CompanionStore>,
    id: String,
) -> Result<CompanionSnapshotDto, String> {
    store.storage.snapshot(&id)
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

#[tauri::command]
async fn disposable_text_page(
    store: tauri::State<'_, CompanionStore>,
    id: String,
    page: usize,
) -> Result<TextPageDto, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.storage.page(&id, page))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn disposable_search(
    store: tauri::State<'_, CompanionStore>,
    id: String,
    query: String,
) -> Result<Vec<SearchMatchDto>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let query = SearchQuery::new(&query).map_err(|error| error.to_string())?;
        let pages = store.storage.pages(&id)?;
        let mut output = Vec::new();
        for page in pages {
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
    document.text_cache_limit = usize::MAX;
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
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--key-preprocess-helper")) {
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
    match preprocess_file_to_sidecar(&input, &output) {
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativePdfService::start())
        .manage(CompanionStore::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            pdfjs_companion_snapshot,
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
