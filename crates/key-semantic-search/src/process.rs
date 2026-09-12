use crate::{
    ChunkSource, PreparedChunks, SemanticDocumentDto,
    chunk_source::ChunkFile,
    embedder::default_model_dir,
    search::{IndexStats, SemanticSearchHitDto, index_document, index_keywords, search_index_at},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::time::Instant;
use std::{
    collections::HashMap,
    env,
    ffi::OsStr,
    fs::{self, File},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

pub type Progress = Arc<dyn Fn(usize, usize) + Send + Sync>;

static IPC_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub use key_library::Document as SemanticLibraryDocument;

#[derive(Serialize, Deserialize)]
struct StoredPage {
    structure: crate::SemanticPageDto,
    block_keys: Vec<String>,
}

#[derive(Clone)]
pub struct SemanticSearchService {
    executable: Arc<Result<PathBuf, String>>,
    model_dir: Arc<Result<PathBuf, String>>,
    index_root: PathBuf,
    chunk_root: PathBuf,
    library: key_library::Library,
    document_ids: Arc<Mutex<HashMap<String, String>>>,
    operation: Arc<Mutex<()>>,
    query_worker: std::sync::mpsc::SyncSender<QueryWork>,
}

impl SemanticSearchService {
    #[must_use]
    pub fn start() -> Self {
        Self::start_at(env::temp_dir().join("key-sidecars"))
    }

    #[must_use]
    pub fn start_at(storage_root: PathBuf) -> Self {
        Self::try_start_at(storage_root).expect("could not open canonical library")
    }

    pub fn try_start_at(storage_root: PathBuf) -> Result<Self, String> {
        let library = key_library::Library::open(&storage_root)?;
        if let Err(error) = library.finish_purges() {
            library.record_maintenance("pending-purge", &error)?;
        }
        library.prepare_index_upgrade(crate::search::INDEX_FORMAT_VERSION)?;
        let storage_root = library.root().to_owned();
        // Keep legacy files untouched. A legacy index is not admitted until its
        // source and extraction identity can be verified against canonical rows.
        let mut known = library
            .documents(&key_library::Filter::default())?
            .into_iter()
            .map(|d| d.document_hash)
            .collect::<std::collections::HashSet<_>>();
        known.extend(
            library
                .documents(&key_library::Filter {
                    removed: true,
                    ..Default::default()
                })?
                .into_iter()
                .map(|d| d.document_hash),
        );
        for name in ["library.json", "semantic-library.json"] {
            let path = storage_root.join(name);
            if !path.exists() {
                continue;
            }
            let manifest: serde_json::Value = match read_json(&path) {
                Ok(manifest) => manifest,
                Err(error) => {
                    library.record_maintenance(
                        "legacy-manifest-error",
                        &format!("{}: {error}", path.display()),
                    )?;
                    continue;
                }
            };
            let Some(documents) = manifest.get("documents").and_then(|v| v.as_array()) else {
                library.record_maintenance(
                    "legacy-manifest-error",
                    &format!("{}: missing documents array", path.display()),
                )?;
                continue;
            };
            for (index, document) in documents.iter().enumerate() {
                let Some(hash) = document
                    .get("documentHash")
                    .and_then(|v| v.as_str())
                    .filter(|hash| key_library::valid_hash(hash).is_ok())
                else {
                    library.record_maintenance(
                        "legacy-manifest-error",
                        &format!(
                            "{}: entry {index} has an invalid content hash",
                            path.display()
                        ),
                    )?;
                    continue;
                };
                if known.contains(hash) || library.is_purged(hash)? {
                    continue;
                }
                let title = document
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled PDF");
                let pages = document
                    .get("pageCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                library.register(hash, title, pages)?;
                library.put(hash, "legacy-library", "v1", name, document)?;
                library.progress(
                    hash,
                    "needs_source",
                    0,
                    0,
                    Some("Open the original PDF to restore this library entry".into()),
                )?;
                known.insert(hash.to_owned());
            }
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel::<QueryWork>(1);
        thread::Builder::new()
            .name("key-query-worker".into())
            .spawn(move || {
                let mut embedder: Option<Arc<dyn frankensearch::Embedder>> = None;
                loop {
                    match receiver.recv_timeout(Duration::from_secs(30)) {
                        Ok(work) => {
                            let has_vectors = key_library::Library::open(
                                work.request
                                    .chunk_root
                                    .parent()
                                    .unwrap_or(&work.request.chunk_root),
                            )
                            .ok()
                            .and_then(|db| db.index_reader().ok())
                            .is_some_and(|db| {
                                work.request.document_ids.keys().any(|hash| {
                                    db.path(hash, "vector", crate::search::INDEX_FORMAT_VERSION)
                                        .ok()
                                        .flatten()
                                        .is_some()
                                })
                            });
                            if embedder.is_none() && has_vectors {
                                embedder = crate::embedding_service::RemoteEmbedder::load(
                                    &work.request.model_dir,
                                )
                                .ok()
                                .map(|e| Arc::new(e) as Arc<dyn frankensearch::Embedder>);
                            }
                            let r = &work.request;
                            let result = crate::search::search_with_embedder(
                                &r.chunk_root,
                                &r.document_ids,
                                &r.query,
                                r.limit,
                                embedder.clone(),
                            );
                            let _ = work.reply.send(result);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            embedder = None;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            query_worker: sender,
            executable: Arc::new(env::current_exe().map_err(|error| error.to_string())),
            model_dir: Arc::new(default_model_dir()),
            index_root: storage_root.join("frankensearch"),
            chunk_root: storage_root.join("chunks"),
            library,
            document_ids: Arc::new(Mutex::new(HashMap::new())),
            operation: Arc::new(Mutex::new(())),
        })
    }

    pub fn library(&self) -> &key_library::Library {
        &self.library
    }

    pub fn register_document(
        &self,
        document_hash: String,
        document_id: String,
        title: String,
        page_count: usize,
    ) -> Result<(), String> {
        self.document_ids
            .lock()
            .map_err(|_| "document map poisoned")?
            .insert(document_hash.clone(), document_id);
        self.library.register(&document_hash, &title, page_count)
    }

    pub fn set_document_progress(
        &self,
        hash: &str,
        status: &str,
        completed: usize,
        total: usize,
        error: Option<String>,
    ) -> Result<(), String> {
        self.library.progress(hash, status, completed, total, error)
    }

    pub fn library_documents(&self) -> Result<Vec<SemanticLibraryDocument>, String> {
        self.library.documents(&key_library::Filter::default())
    }

    pub fn prepare_chunks(
        &self,
        document_id: &str,
        semantic: &SemanticDocumentDto,
    ) -> Result<PreparedChunks, String> {
        persist_semantic_chunks(&self.library, document_id, semantic)
    }
    /// Rebuild index input with a single hydrated page, never a document-sized DTO.
    pub fn prepare_cached_chunks(
        &self,
        document_id: &str,
        hash: &str,
        onnx: bool,
    ) -> Result<Option<PreparedChunks>, String> {
        let Some(mut header) = self.library.get::<SemanticDocumentDto>(
            hash,
            "semantic-header",
            "v5",
            &onnx.to_string(),
        )?
        else {
            return Ok(None);
        };
        let reader = self.library.artifact_reader()?;
        let mut complete = true;
        let chunks = PreparedChunks::create(|emit| {
            for page in 0..header.page_count {
                let Some(stored) = reader.get::<StoredPage>(
                    hash,
                    "semantic-structure",
                    "v5",
                    &format!("{onnx}:{page}"),
                )?
                else {
                    complete = false;
                    break;
                };
                let mut structure = stored.structure;
                for (i, block) in structure.blocks.iter_mut().enumerate() {
                    block.text = reader
                        .block_text(hash, stored.block_keys.get(i).ok_or("missing block key")?)?;
                    for sentence in &mut block.sentences {
                        sentence.text = block
                            .text
                            .get(sentence.start as usize..sentence.end as usize)
                            .ok_or("invalid persisted sentence range")?
                            .to_owned();
                    }
                }
                header.pages = vec![structure];
                for chunk in crate::build_sentence_context_chunks(document_id, &header) {
                    emit(&chunk)?;
                }
                header.pages.clear();
            }
            Ok(())
        })?;
        Ok(complete.then_some(chunks))
    }
    pub fn cached_semantic(
        &self,
        hash: &str,
        onnx: bool,
    ) -> Result<Option<SemanticDocumentDto>, String> {
        let Some(mut doc) = self.library.get::<SemanticDocumentDto>(
            hash,
            "semantic-header",
            "v5",
            &onnx.to_string(),
        )?
        else {
            return Ok(None);
        };
        for page in 0..doc.page_count {
            let Some(stored) = self.library.get::<StoredPage>(
                hash,
                "semantic-structure",
                "v5",
                &format!("{onnx}:{page}"),
            )?
            else {
                return Ok(None);
            };
            let mut structure = stored.structure;
            for (i, block) in structure.blocks.iter_mut().enumerate() {
                block.text = self
                    .library
                    .block_text(hash, stored.block_keys.get(i).ok_or("missing block key")?)?;
                for sentence in &mut block.sentences {
                    sentence.text = block
                        .text
                        .get(sentence.start as usize..sentence.end as usize)
                        .ok_or("invalid persisted sentence range")?
                        .to_owned();
                }
            }
            doc.pages.push(structure);
        }
        Ok(Some(doc))
    }

    pub fn index_document(
        &self,
        chunks: PreparedChunks,
        progress: Progress,
    ) -> Result<IndexStats, String> {
        let Some(first) = chunks.first_chunk()? else {
            return Ok(empty_reused_stats());
        };
        let document_hash = first.document_hash.clone();
        if self.library.is_paused(&document_hash)? {
            return Err("Indexing paused".into());
        }
        let document_id = first.document_id.clone();
        let chunk_count = chunks.len();
        self.document_ids
            .lock()
            .map_err(|_| "semantic document map is poisoned".to_owned())?
            .insert(document_hash.clone(), document_id);
        index_keywords(&self.index_root, &chunks)?;
        self.set_document_progress(&document_hash, "indexing", 0, chunk_count, None)?;

        let _operation = self
            .operation
            .lock()
            .map_err(|_| "semantic process lock is poisoned".to_owned())?;
        let request = IndexRequest {
            index_root: self.index_root.clone(),
            model_dir: self.model_dir()?,
            chunks: chunks.source.clone(),
        };
        let progress_hash = document_hash.clone();
        let library_service = self.clone();
        let forwarded_progress: Progress = Arc::new(move |completed, total| {
            let _ = library_service.set_document_progress(
                &progress_hash,
                "indexing",
                completed,
                total,
                None,
            );
            progress(completed, total);
        });
        match self.run_index_helper(request, forwarded_progress) {
            Ok(stats) => {
                self.set_document_progress(
                    &document_hash,
                    "indexed",
                    stats.chunks,
                    stats.chunks,
                    None,
                )?;
                Ok(stats)
            }
            Err(error) => {
                let _ = self.set_document_progress(
                    &document_hash,
                    if error == key_processing::YIELDED_TO_READER {
                        "queued"
                    } else {
                        "failed"
                    },
                    0,
                    chunk_count,
                    if error == key_processing::YIELDED_TO_READER {
                        None
                    } else {
                        Some(error.clone())
                    },
                );
                Err(error)
            }
        }
    }

    pub fn search(
        &self,
        query: String,
        limit: usize,
        mut filter: key_library::Filter,
    ) -> Result<Vec<SemanticSearchHitDto>, String> {
        filter.removed = false;
        let document_ids = self
            .library
            .documents(&filter)?
            .into_iter()
            .map(|d| (d.document_hash.clone(), d.document_hash))
            .collect::<HashMap<_, _>>();
        if document_ids.is_empty() || query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let request = SearchRequest {
            index_root: self.index_root.clone(),
            chunk_root: self.chunk_root.clone(),
            model_dir: self.model_dir().unwrap_or_default(),
            document_ids,
            query,
            limit,
        };
        let (reply, receiver) = std::sync::mpsc::channel();
        self.query_worker
            .send(QueryWork { request, reply })
            .map_err(|_| "Search worker stopped")?;
        receiver
            .recv()
            .map_err(|_| "Search worker stopped before responding")?
    }

    fn model_dir(&self) -> Result<PathBuf, String> {
        self.model_dir.as_ref().clone()
    }

    fn executable(&self) -> Result<PathBuf, String> {
        self.executable.as_ref().clone()
    }

    fn run_index_helper(
        &self,
        request: IndexRequest,
        progress: Progress,
    ) -> Result<IndexStats, String> {
        let paths = IpcPaths::create("index")?;
        write_json(&paths.input, &request)?;
        let hash = request.chunks.first_chunk()?.map(|c| c.document_hash);
        drop(request);
        let lease = hash
            .as_ref()
            .map(|hash| key_processing::acquire_lease(&self.library, hash, "vectors"))
            .transpose()?;
        let mut renewed = Instant::now();
        let initial_embeddings = hash
            .as_ref()
            .map(|hash| self.library.artifact_count(hash, "embedding"))
            .transpose()?
            .unwrap_or(0);
        let mut child = Command::new(self.executable()?)
            .arg("--key-semantic-index-helper")
            .env(
                "KEY_EMBEDDING_ENDPOINT",
                crate::embedding_service::endpoint(&self.model_dir()?)?.encoded()?,
            )
            .arg(&paths.input)
            .arg(&paths.output)
            .arg(&paths.progress)
            .stdout(Stdio::null())
            .stderr(Stdio::from(
                File::create(&paths.stderr).map_err(|e| e.to_string())?,
            ))
            .spawn()
            .map_err(|error| format!("failed to launch semantic index helper: {error}"))?;
        let quantum = Instant::now();
        let mut last_progress = None;
        let mut changed = Instant::now();
        let status = loop {
            if changed.elapsed() > Duration::from_secs(300) {
                let _ = child.kill();
                let _ = child.wait();
                paths.cleanup();
                return Err(
                    "Index helper stalled; completed embedding checkpoints were retained for retry"
                        .into(),
                );
            }
            if renewed.elapsed() > Duration::from_secs(5) {
                if let Some(lease) = &lease {
                    if let Err(error) = lease.renew() {
                        let _ = child.kill();
                        let _ = child.wait();
                        paths.cleanup();
                        return Err(error);
                    }
                }
                renewed = Instant::now();
            }
            if hash
                .as_ref()
                .is_some_and(|hash| key_processing::should_yield_to_reader(hash))
            {
                let _ = child.kill();
                let _ = child.wait();
                paths.cleanup();
                return Err(key_processing::YIELDED_TO_READER.into());
            }
            if hash
                .as_ref()
                .is_some_and(|hash| self.library.is_paused(hash).unwrap_or(false))
            {
                let _ = child.kill();
                let _ = child.wait();
                paths.cleanup();
                return Err("Indexing paused".into());
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break status;
            }
            if let Ok(update) = read_json::<ProgressUpdate>(&paths.progress) {
                let value = (update.completed, update.total, update.revision);
                if last_progress != Some(value) {
                    if update.completed < update.total {
                        if let Some(hash) = hash.as_ref() {
                            if key_processing::should_yield_checkpoint(hash, quantum.elapsed())
                                && self
                                    .library
                                    .artifact_count(hash, "embedding")
                                    .is_ok_and(|count| count > initial_embeddings)
                            {
                                let _ = child.kill();
                                let _ = child.wait();
                                paths.cleanup();
                                return Err(key_processing::YIELDED_TO_READER.into());
                            }
                        }
                    }
                    progress(update.completed, update.total);
                    last_progress = Some(value);
                    changed = Instant::now();
                }
            }
            thread::sleep(Duration::from_millis(50));
        };
        let detail = fs::read_to_string(&paths.stderr).unwrap_or_default();
        let result = if status.success() {
            read_json(&paths.output)
        } else if detail.is_empty() {
            Err(format!("semantic index helper exited with {status}"))
        } else {
            Err(format!(
                "semantic index helper exited with {status}: {detail}"
            ))
        };
        paths.cleanup();
        result
    }
}

struct QueryWork {
    request: SearchRequest,
    reply: std::sync::mpsc::Sender<Result<Vec<SemanticSearchHitDto>, String>>,
}

#[derive(Deserialize, Serialize)]
struct IndexRequest {
    index_root: PathBuf,
    model_dir: PathBuf,
    chunks: ChunkFile,
}

#[derive(Deserialize, Serialize)]
struct SearchRequest {
    index_root: PathBuf,
    chunk_root: PathBuf,
    model_dir: PathBuf,
    document_ids: HashMap<String, String>,
    query: String,
    limit: usize,
}

#[derive(Deserialize, Serialize)]
struct ProgressUpdate {
    #[serde(default)]
    revision: u64,
    completed: usize,
    total: usize,
}

struct IpcPaths {
    input: PathBuf,
    output: PathBuf,
    progress: PathBuf,
    stderr: PathBuf,
}

impl IpcPaths {
    fn create(kind: &str) -> Result<Self, String> {
        let directory = env::temp_dir().join("key-sidecars").join("semantic-ipc");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let id = format!(
            "{}-{}-{}",
            std::process::id(),
            IPC_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            kind
        );
        Ok(Self {
            input: directory.join(format!("{id}.input.json")),
            output: directory.join(format!("{id}.output.json")),
            progress: directory.join(format!("{id}.progress.json")),
            stderr: directory.join(format!("{id}.stderr.log")),
        })
    }

    fn cleanup(&self) {
        let _ = fs::remove_file(&self.input);
        let _ = fs::remove_file(&self.output);
        let _ = fs::remove_file(&self.progress);
        let _ = fs::remove_file(&self.stderr);
    }
}

fn persist_semantic_chunks(
    library: &key_library::Library,
    document_id: &str,
    semantic: &SemanticDocumentDto,
) -> Result<PreparedChunks, String> {
    let chunks = PreparedChunks::create(|emit| {
        for page in &semantic.pages {
            let page_document = SemanticDocumentDto {
                version: semantic.version,
                document_hash: semantic.document_hash.clone(),
                page_count: semantic.page_count,
                onnx_enabled: semantic.onnx_enabled,
                processing_ms: 0.0,
                pages: vec![page.clone()],
            };
            let chunks = crate::build_sentence_context_chunks(document_id, &page_document);
            let mut offset = 0;
            let mut structure = page.clone();
            for block in &mut structure.blocks {
                block.text.clear();
                for sentence in &mut block.sentences {
                    sentence.text.clear();
                }
            }
            let block_keys = page
                .blocks
                .iter()
                .map(|b| key_library::content_hash(b.text.as_bytes()))
                .collect::<Vec<_>>();
            let mut canonical_blocks = Vec::new();
            for (block_index, block) in page.blocks.iter().enumerate() {
                let text = &block.text;
                let ranges = block
                    .sentences
                    .iter()
                    .map(|s| (s.start as usize, s.end as usize))
                    .collect::<Vec<_>>();
                let anchors = ranges
                    .iter()
                    .enumerate()
                    .map(|(i, (start, end))| {
                        let chunk = &chunks[offset + i];
                        key_library::ChunkAnchor {
                            id: chunk.id.clone(),
                            page: page.page,
                            context_start: ranges[i.saturating_sub(1)].0,
                            context_end: ranges[(i + 1).min(ranges.len() - 1)].1,
                            target_start: *start,
                            target_end: *end,
                            rects: chunk
                                .target_rects
                                .iter()
                                .map(|r| [r.x, r.y, r.width, r.height])
                                .collect(),
                        }
                    })
                    .collect::<Vec<_>>();
                canonical_blocks.push(key_library::CanonicalBlock {
                    key: block_keys[block_index].clone(),
                    text: text.clone(),
                    chunks: anchors,
                });
                offset += ranges.len();
            }
            library.store_semantic_page(
                &semantic.document_hash,
                "v5",
                &format!("{}:{}", semantic.onnx_enabled, page.page),
                &StoredPage {
                    structure,
                    block_keys,
                },
                canonical_blocks,
            )?;
            for chunk in &chunks {
                emit(chunk)?;
            }
        }
        Ok(())
    })?;
    let header = SemanticDocumentDto {
        version: semantic.version,
        document_hash: semantic.document_hash.clone(),
        page_count: semantic.page_count,
        onnx_enabled: semantic.onnx_enabled,
        processing_ms: semantic.processing_ms,
        pages: Vec::new(),
    };
    library.put(
        &semantic.document_hash,
        "semantic-header",
        "v5",
        &semantic.onnx_enabled.to_string(),
        &header,
    )?;
    Ok(chunks)
}

pub fn maybe_run_helper() -> Option<i32> {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let command = arguments.next()?;
    let result = if command == OsStr::new("--key-embedding-service") {
        crate::embedding_service::serve(arguments.collect())
    } else if command == OsStr::new("--key-semantic-helper") {
        run_extraction_helper(arguments.collect())
    } else if command == OsStr::new("--key-semantic-index-helper") {
        run_index_process(arguments.collect())
    } else if command == OsStr::new("--key-semantic-search-helper") {
        run_search_process(arguments.collect())
    } else {
        return None;
    };
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

fn run_extraction_helper(arguments: Vec<std::ffi::OsString>) -> Result<(), String> {
    let input = arguments
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| "missing semantic input path".to_owned())?;
    let output = arguments
        .get(1)
        .map(PathBuf::from)
        .ok_or_else(|| "missing semantic output path".to_owned())?;
    let mut document_hash = None;
    let mut onnx_enabled = false;
    let mut canonical = false;
    let mut library = None;
    let mut index = 2;
    while index < arguments.len() {
        if arguments[index] == OsStr::new("--canonical") {
            canonical = true;
        } else if arguments[index] == OsStr::new("--onnx") {
            onnx_enabled = true;
        } else if arguments[index] == OsStr::new("--library") {
            index += 1;
            library = arguments.get(index).map(PathBuf::from);
        } else if arguments[index] == OsStr::new("--hash") {
            index += 1;
            document_hash = arguments
                .get(index)
                .and_then(|value| value.clone().into_string().ok());
        }
        index += 1;
    }
    let document_hash = document_hash.ok_or_else(|| "missing semantic document hash".to_owned())?;
    let worker = thread::Builder::new()
        .name("semantic-pdfium-worker".to_owned())
        .spawn(move || {
            semantic_file_to_sidecar(
                &input,
                &output,
                &document_hash,
                onnx_enabled,
                library,
                canonical,
            )
        })
        .map_err(|error| error.to_string())?;
    worker
        .join()
        .map_err(|_| "semantic helper thread panicked".to_owned())?
}

fn run_index_process(arguments: Vec<std::ffi::OsString>) -> Result<(), String> {
    let input = required_path(&arguments, 0, "index request")?;
    let output = required_path(&arguments, 1, "index response")?;
    let progress_path = required_path(&arguments, 2, "index progress")?;
    let request: IndexRequest = read_json(&input)?;
    let last_emitted = Mutex::new(Instant::now());
    let progress = move |completed, total| {
        let mut emitted = last_emitted.lock().unwrap_or_else(|e| e.into_inner());
        if completed != total && emitted.elapsed() < Duration::from_millis(250) {
            return;
        }
        *emitted = Instant::now();
        let _ = write_json_atomic(
            &progress_path,
            &ProgressUpdate {
                completed,
                total,
                revision: IPC_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            },
        );
    };
    let response = index_document(
        &request.index_root,
        &request.model_dir,
        &request.chunks,
        progress,
    )?;
    write_json_atomic(&output, &response)
}

fn run_search_process(arguments: Vec<std::ffi::OsString>) -> Result<(), String> {
    let input = required_path(&arguments, 0, "search request")?;
    let output = required_path(&arguments, 1, "search response")?;
    let request: SearchRequest = read_json(&input)?;
    let response = search_index_at(
        &request.index_root,
        &request.chunk_root,
        &request.model_dir,
        &request.document_ids,
        &request.query,
        request.limit,
    )?;
    write_json_atomic(&output, &response)
}

fn semantic_file_to_sidecar(
    input: &Path,
    output: &Path,
    document_hash: &str,
    onnx_enabled: bool,
    library: Option<PathBuf>,
    canonical: bool,
) -> Result<(), String> {
    let library = library.map(key_library::Library::open).transpose()?;
    let mut semantic: SemanticDocumentDto = crate::analysis::convert_file_cached(
        input,
        document_hash.to_owned(),
        onnx_enabled,
        library.clone(),
    )
    .map_err(|error| format!("failed to extract semantic PDF data: {error:#}"))?;
    if canonical {
        persist_semantic_chunks(
            library
                .as_ref()
                .ok_or("Canonical extraction requires a library")?,
            document_hash,
            &semantic,
        )?;
        semantic.pages.clear();
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = output.with_extension("json.partial");
    let mut writer = BufWriter::new(
        File::create(&temporary)
            .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?,
    );
    serde_json::to_writer(&mut writer, &semantic).map_err(|error| error.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    writer.get_ref().sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temporary, output).map_err(|error| {
        format!(
            "failed to move {} to {}: {error}",
            temporary.display(),
            output.display()
        )
    })
}

fn required_path(
    arguments: &[std::ffi::OsString],
    index: usize,
    label: &str,
) -> Result<PathBuf, String> {
    arguments
        .get(index)
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing semantic {label} path"))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut writer = BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
    serde_json::to_writer(&mut writer, value).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension("json.partial");
    write_json(&temporary, value)?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    serde_json::from_reader(reader).map_err(|e| e.to_string())
}

fn empty_reused_stats() -> IndexStats {
    IndexStats {
        chunks: 0,
        embedded_chunks: 0,
        elapsed_ms: 0.0,
        model_load_ms: 0.0,
        embedding_ms: 0.0,
        index_build_ms: 0.0,
        reused: true,
    }
}

#[cfg(test)]
mod tests {
    use super::SemanticSearchService;
    use crate::ChunkSource;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn semantic_library_survives_service_restart() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("key-semantic-library-test-{nonce}"));
        let service = SemanticSearchService::start_at(root.clone());
        service
            .register_document(
                key_library::content_hash(b"test"),
                "open-document".to_owned(),
                "A useful paper".to_owned(),
                12,
            )
            .expect("register document");
        service
            .set_document_progress(
                &key_library::content_hash(b"test"),
                "indexing",
                24,
                96,
                None,
            )
            .expect("save progress");
        drop(service);

        let reopened = SemanticSearchService::start_at(root.clone());
        let documents = reopened.library_documents().expect("load library");
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].title, "A useful paper");
        assert_eq!(documents[0].status, "indexing");
        assert_eq!(documents[0].completed, 24);
        assert_eq!(documents[0].total, 96);

        std::fs::remove_dir_all(root).expect("clean test library");
    }
    #[test]
    fn real_pdf_structure_round_trips_without_repeated_context_text() {
        let root = tempfile::tempdir().unwrap();
        let service = SemanticSearchService::start_at(root.path().into());
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/interaction.pdf");
        let bytes = std::fs::read(&fixture).unwrap();
        let hash = service
            .library()
            .store_source(&bytes, "Fixture", 3)
            .unwrap();
        let semantic = crate::convert_file(&fixture, hash.clone(), false).unwrap();
        let chunks = service.prepare_chunks(&hash, &semantic).unwrap();
        assert!(!chunks.is_empty());
        for c in crate::ChunkSource::reader(&chunks).unwrap() {
            let c = c.unwrap();
            let p = service.library().passage(&c.id).unwrap().unwrap();
            assert_eq!(p.target_text, c.target_text);
            assert_eq!(p.page, c.page);
        }
        let streamed = service
            .prepare_cached_chunks(&hash, &hash, false)
            .unwrap()
            .unwrap();
        let before = chunks
            .reader()
            .unwrap()
            .map(|c| serde_json::to_value(c.unwrap()).unwrap())
            .collect::<Vec<_>>();
        let after = streamed
            .reader()
            .unwrap()
            .map(|c| serde_json::to_value(c.unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(before, after);
        let mut restored = service.cached_semantic(&hash, false).unwrap().unwrap();
        // JSON timing telemetry can round by one ULP; document structure must be exact.
        assert!((restored.processing_ms - semantic.processing_ms).abs() < 1e-9);
        restored.processing_ms = semantic.processing_ms;
        assert_eq!(restored, semantic);
        assert!(service.cached_semantic(&hash, true).unwrap().is_none());
    }
    #[test]
    fn legacy_manifest_is_preserved_and_imported_idempotently() {
        let temp = tempfile::tempdir().unwrap();
        let hash = key_library::content_hash(b"old");
        let path = temp.path().join("library.json");
        let bytes=serde_json::to_vec(&serde_json::json!({"version":1,"documents":[{"documentHash":hash,"title":"Old paper","pageCount":9,"status":"indexed"}]})).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let service = SemanticSearchService::start_at(temp.path().into());
        assert_eq!(
            service.library_documents().unwrap()[0].status,
            "needs_source"
        );
        drop(service);
        let service = SemanticSearchService::start_at(temp.path().into());
        assert_eq!(service.library_documents().unwrap().len(), 1);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
