use crate::semantic_chunks::SemanticChunk;
use frankensearch::{
    ContentHasher, DocumentRecord, EmbedderStack, IndexBuilder, Storage, StorageConfig,
    TwoTierConfig, TwoTierIndex, TwoTierSearcher,
};
#[cfg(test)]
use frankensearch::{Embedder, HashEmbedder};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::{HashMap, HashSet},
    env,
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Instant,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchHitDto {
    pub id: String,
    pub document_id: String,
    pub document_hash: String,
    pub page: usize,
    pub text: String,
    pub target_text: String,
    pub score: f32,
}

pub type Progress = Arc<dyn Fn(usize, usize) + Send + Sync>;

enum Request {
    Index {
        chunks: Vec<SemanticChunk>,
        progress: Progress,
        reply: mpsc::Sender<Result<IndexStats, String>>,
    },
    Search {
        query: String,
        limit: usize,
        reply: mpsc::Sender<Result<Vec<SemanticSearchHitDto>, String>>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub chunks: usize,
    pub elapsed_ms: f64,
}

#[derive(Clone)]
pub struct SemanticSearchService {
    requests: Arc<Mutex<mpsc::Sender<Request>>>,
}

impl SemanticSearchService {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::channel::<Request>();
        let requests = Arc::new(Mutex::new(sender));
        let index_root = env::temp_dir().join("key-sidecars").join("frankensearch");
        thread::Builder::new()
            .name("pdf-semantic-search".to_owned())
            .spawn(move || search_worker(receiver, index_root))
            .expect("failed to start semantic search worker");
        Self { requests }
    }

    pub fn index_document(
        &self,
        chunks: Vec<SemanticChunk>,
        progress: Progress,
    ) -> Result<IndexStats, String> {
        let (reply, result) = mpsc::channel();
        self.requests
            .lock()
            .map_err(|_| "semantic search worker is poisoned".to_owned())?
            .send(Request::Index {
                chunks,
                progress,
                reply,
            })
            .map_err(|_| "semantic search worker stopped".to_owned())?;
        result
            .recv()
            .map_err(|_| "semantic search worker stopped".to_owned())?
    }

    pub fn search(&self, query: String, limit: usize) -> Result<Vec<SemanticSearchHitDto>, String> {
        let (reply, result) = mpsc::channel();
        self.requests
            .lock()
            .map_err(|_| "semantic search worker is poisoned".to_owned())?
            .send(Request::Search {
                query,
                limit,
                reply,
            })
            .map_err(|_| "semantic search worker stopped".to_owned())?;
        result
            .recv()
            .map_err(|_| "semantic search worker stopped".to_owned())?
    }
}

fn search_worker(receiver: mpsc::Receiver<Request>, index_root: PathBuf) {
    let mut chunks = HashMap::<String, SemanticChunk>::new();
    load_cached_chunks(&mut chunks);
    let storage = Storage::open(StorageConfig {
        db_path: index_root.join("metadata.sqlite3"),
        ..StorageConfig::default()
    })
    .ok();
    let embedders = initialize_embedders(&index_root);
    for request in receiver {
        match request {
            Request::Index {
                chunks: additions,
                progress,
                reply,
            } => {
                let started = Instant::now();
                let mut changed_shards = HashSet::new();
                for chunk in additions {
                    let content_hash = ContentHasher::hash(chunk.text.as_str());
                    let unchanged = storage
                        .as_ref()
                        .and_then(|db| db.get_document(&chunk.id).ok().flatten())
                        .is_some_and(|record| record.content_hash == content_hash);
                    if !unchanged || !index_root.join(&chunk.document_hash).exists() {
                        changed_shards.insert(chunk.document_hash.clone());
                        if let Some(db) = &storage {
                            let now = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map(|duration| duration.as_secs() as i64)
                                .unwrap_or_default();
                            let record = DocumentRecord::new(
                                chunk.id.clone(),
                                chunk.text.clone(),
                                content_hash,
                                chunk.text.len(),
                                now,
                                now,
                            );
                            let _ = db.upsert_document(&record);
                        }
                    }
                    chunks.insert(chunk.id.clone(), chunk);
                }
                let documents = chunks.values().cloned().collect::<Vec<_>>();
                let result = (|| {
                    for document_hash in changed_shards {
                        let shard = documents
                            .iter()
                            .filter(|chunk| chunk.document_hash == document_hash)
                            .cloned()
                            .collect::<Vec<_>>();
                        rebuild_index(
                            &index_root.join(&document_hash),
                            &shard,
                            &embedders,
                            Arc::clone(&progress),
                        )?;
                    }
                    Ok(IndexStats {
                        chunks: documents.len(),
                        elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
                    })
                })();
                let _ = reply.send(result);
            }
            Request::Search {
                query,
                limit,
                reply,
            } => {
                let result = search_index(&index_root, &chunks, &embedders, &query, limit);
                let _ = reply.send(result);
            }
        }
    }
}

fn load_cached_chunks(chunks: &mut HashMap<String, SemanticChunk>) {
    let directory = env::temp_dir().join("key-sidecars").join("chunks");
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(cached) = serde_json::from_slice::<Vec<SemanticChunk>>(&bytes) else {
            continue;
        };
        for chunk in cached {
            chunks.insert(chunk.id.clone(), chunk);
        }
    }
}

fn initialize_embedders(root: &PathBuf) -> EmbedderStack {
    #[cfg(test)]
    {
        let _ = root;
        let fast = Arc::new(HashEmbedder::default_256()) as Arc<dyn Embedder>;
        let quality = Arc::new(HashEmbedder::default_384()) as Arc<dyn Embedder>;
        return EmbedderStack::from_parts(fast, Some(quality));
    }
    #[cfg(not(test))]
    {
        frankensearch_embed::ensure_default_semantic_models(Some(root))
            .unwrap_or_else(|error| panic!("failed to materialize bundled neural models: {error}"));
        // Frankensearch checks its model cache first. If the user explicitly
        // grants FRANKENSEARCH_ALLOW_DOWNLOAD=1, the first semantic job may
        // download its neural models in this isolated worker. The release
        // build embeds and materializes the pinned neural models above.
        let stack = EmbedderStack::auto_detect_with(Some(root)).unwrap_or_else(|error| {
            eprintln!("semantic embedder detection failed: {error}");
            panic!("no usable Frankensearch embedder")
        });
        if matches!(stack.availability(), frankensearch::TwoTierAvailability::HashOnly) {
            panic!("semantic search requires bundled neural embedders; hash fallback is disabled");
        }
        stack
    }
}

fn rebuild_index(
    root: &PathBuf,
    chunks: &[SemanticChunk],
    embedders: &EmbedderStack,
    progress: Progress,
) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let root = root.clone();
    let chunks = chunks.to_owned();
    let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
        .build()
        .map_err(|error| format!("failed to build search runtime: {error}"))?;
    let build_root = root.clone();
    let result = runtime.block_on(async move {
        let cx = frankensearch::Cx::current().expect("search runtime has no context");
        let mut builder = IndexBuilder::new(build_root).with_embedder_stack(embedders.clone());
        for chunk in chunks {
            builder = builder.add_document(chunk.id, chunk.text);
        }
        builder
            .with_progress(move |update| (progress)(update.completed, update.total))
            .build(&cx)
            .await
    });
    result.map_err(|error| format!("semantic index build failed: {error:?}"))?;
    // IndexBuilder reports errors inside the runtime; reopening gives us a
    // concrete failure instead of claiming that the document is searchable.
    TwoTierIndex::open(root.as_path(), TwoTierConfig::default())
        .map(|_| ())
        .map_err(|error| format!("failed to open semantic index: {error}"))
}

fn search_index(
    root: &PathBuf,
    chunks: &HashMap<String, SemanticChunk>,
    embedders: &EmbedderStack,
    query: &str,
    limit: usize,
) -> Result<Vec<SemanticSearchHitDto>, String> {
    let shard_roots = chunks
        .values()
        .map(|chunk| root.join(&chunk.document_hash))
        .collect::<HashSet<_>>();
    let query = query.to_owned();
    let hits = Arc::new(Mutex::new((Vec::<(String, f32)>::new(), None)));
    let output = Arc::clone(&hits);
    let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
        .build()
        .map_err(|error| format!("failed to build search runtime: {error}"))?;
    runtime.block_on(async move {
        let Some(cx) = frankensearch::Cx::current() else {
            output.lock().expect("search result lock").1 =
                Some("search runtime has no context".to_owned());
            return;
        };
        for shard_root in shard_roots {
            let Ok(index) = TwoTierIndex::open(&shard_root, TwoTierConfig::default()) else {
                continue;
            };
            let mut searcher = TwoTierSearcher::new(
                Arc::new(index),
                embedders.fast_arc(),
                TwoTierConfig::default(),
            );
            if let Some(quality) = embedders.quality_arc() {
                searcher = searcher.with_quality_embedder(quality);
            }
            match searcher.search_collect(&cx, &query, limit).await {
                Ok((results, _metrics)) => {
                    output.lock().expect("search result lock").0.extend(
                        results
                            .into_iter()
                            .map(|result| (result.doc_id.to_string(), result.score)),
                    );
                }
                Err(search_error) => {
                    output.lock().expect("search result lock").1 = Some(search_error.to_string());
                    break;
                }
            }
        }
    });
    let (mut results, error) = Arc::try_unwrap(hits)
        .map_err(|_| "search result lock still referenced".to_owned())?
        .into_inner()
        .map_err(|_| "search result lock poisoned".to_owned())?;
    if let Some(error) = error {
        return Err(error);
    }
    results.sort_by(|left, right| right.1.total_cmp(&left.1));
    Ok(results
        .into_iter()
        .take(limit)
        .filter_map(|result| {
            chunks
                .get(result.0.as_str())
                .map(|chunk| SemanticSearchHitDto {
                    id: chunk.id.clone(),
                    document_id: chunk.document_id.clone(),
                    document_hash: chunk.document_hash.clone(),
                    page: chunk.page,
                    text: chunk.text.clone(),
                    target_text: chunk.target_text.clone(),
                    score: result.1,
                })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::SemanticSearchService;
    use crate::semantic_analysis::CompactRect;
    use crate::semantic_chunks::SemanticChunk;
    use std::{sync::Arc, time::Duration};

    fn chunk(id: &str, text: &str) -> SemanticChunk {
        SemanticChunk {
            id: id.to_owned(),
            document_id: "paper".to_owned(),
            document_hash: id.to_owned(),
            page: 0,
            block_index: 0,
            sentence_index: 0,
            text: text.to_owned(),
            target_text: text.to_owned(),
            target_rects: vec![CompactRect {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            }],
        }
    }

    #[test]
    fn worker_indexes_and_searches_chunks_off_thread() {
        let service = SemanticSearchService::start();
        let progress = Arc::new(|_, _| {});
        let stats = service
            .index_document(
                vec![
                    chunk("rust", "Rust ownership prevents data races"),
                    chunk("pdf", "PDF reading order preserves paragraphs"),
                ],
                progress,
            )
            .expect("index chunks");
        assert_eq!(stats.chunks, 2);
        let hits = service
            .search("reading order".to_owned(), 5)
            .expect("search chunks");
        assert!(hits.iter().any(|hit| hit.id == "pdf"));
        // Keep the worker alive long enough for its receiver to observe the
        // request before the test drops its sender.
        std::thread::sleep(Duration::from_millis(1));
    }

}
