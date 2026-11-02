#[cfg(test)]
use crate::SemanticChunk;
use crate::lexical::KeywordReader;
use crate::{
    ChunkSource,
    embedder::{ArcticEmbedder, MODEL_ID, PrecomputedEmbedder},
};
use frankensearch::{
    Embedder, EmbedderStack, IndexBuilder, TwoTierConfig, TwoTierIndex, TwoTierSearcher,
};
use frankensearch_core::LexicalRead;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

pub const INDEX_FORMAT_VERSION: &str = "key-arctic-xs-q-sql-tantivy-v6";
const EMBEDDING_BATCH_SIZE: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub chunks: usize,
    pub embedded_chunks: usize,
    pub elapsed_ms: f64,
    pub model_load_ms: f64,
    pub embedding_ms: f64,
    pub index_build_ms: f64,
    pub reused: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct IndexMarker {
    format_version: String,
    model_id: String,
    document_hash: String,
    chunks: usize,
    corpus: String,
    producer: String,
}

fn corpus_id(chunks: &(impl ChunkSource + ?Sized)) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for c in chunks.reader()? {
        let c = c?;
        h.update(c.id.as_bytes());
        h.update([0]);
        h.update(c.text.as_bytes());
        h.update([0]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn corpus_matches(root: &Path, chunks: &(impl ChunkSource + ?Sized)) -> bool {
    fs::read_to_string(root.join("corpus.sha256"))
        .is_ok_and(|s| corpus_id(chunks).is_ok_and(|id| s == id))
}

pub fn is_current_index(index_root: &Path, document_hash: &str) -> bool {
    let Ok(library) = key_library::Library::open(index_root.parent().unwrap_or(index_root)) else {
        return false;
    };
    let Ok(Some(root)) = library.index_path(document_hash, "vector", INDEX_FORMAT_VERSION) else {
        return false;
    };
    let path = marker_path(&root);
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<IndexMarker>(&bytes).is_ok_and(|marker| {
        marker.format_version == INDEX_FORMAT_VERSION
            && marker.model_id == MODEL_ID
            && marker.document_hash == document_hash
    })
}

pub fn index_keywords(
    index_root: &Path,
    chunks: &(impl ChunkSource + ?Sized),
) -> Result<(), String> {
    let Some(first) = chunks.first_chunk()? else {
        return Ok(());
    };
    let library = key_library::Library::open(index_root.parent().ok_or("missing library root")?)?;
    if library
        .index_path(&first.document_hash, "lexical", INDEX_FORMAT_VERSION)?
        .is_some_and(|p| corpus_matches(&p, chunks) && KeywordReader::open(&p).is_ok())
    {
        return library.keyword_ready(&first.document_hash);
    }
    let root = generation_root(index_root, &first.document_hash, "lexical");
    KeywordReader::build(&root, chunks)?;
    KeywordReader::open(&root)?;
    fs::write(root.join("corpus.sha256"), corpus_id(chunks)?).map_err(|e| e.to_string())?;
    flush_generation(&root)?;
    library.publish_index(&first.document_hash, "lexical", INDEX_FORMAT_VERSION, &root)?;
    library.keyword_ready(&first.document_hash)
}
fn flush_generation(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            flush_generation(&entry.path())?;
        } else {
            fs::File::open(entry.path())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn generation_root(index_root: &Path, hash: &str, kind: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    index_root.join(format!("{hash}-{kind}-{}-{nonce}", std::process::id()))
}

pub fn index_document(
    index_root: &Path,
    model_dir: &Path,
    chunks: &(impl ChunkSource + ?Sized),
    progress: impl Fn(usize, usize),
) -> Result<IndexStats, String> {
    let started = Instant::now();
    let Some(first) = chunks.first_chunk()? else {
        return Ok(IndexStats {
            chunks: 0,
            embedded_chunks: 0,
            elapsed_ms: 0.0,
            model_load_ms: 0.0,
            embedding_ms: 0.0,
            index_build_ms: 0.0,
            reused: true,
        });
    };
    let document_hash = first.document_hash.as_str();
    for chunk in chunks.reader()? {
        if chunk?.document_hash != document_hash {
            return Err("one indexing request must contain exactly one document hash".into());
        }
    }
    let library = key_library::Library::open(index_root.parent().ok_or("missing library root")?)?;
    index_keywords(index_root, chunks)?;
    let producer = crate::embedder::model_fingerprint(model_dir)?;
    if is_current_index(index_root, document_hash)
        && library
            .index_path(document_hash, "vector", INDEX_FORMAT_VERSION)?
            .is_some_and(|p| {
                corpus_matches(&p, chunks)
                    && fs::read(marker_path(&p))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<IndexMarker>(&b).ok())
                        .is_some_and(|m| m.producer == producer)
            })
    {
        progress(chunks.len(), chunks.len());
        return Ok(IndexStats {
            chunks: chunks.len(),
            embedded_chunks: 0,
            elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
            model_load_ms: 0.0,
            embedding_ms: 0.0,
            index_build_ms: 0.0,
            reused: true,
        });
    }

    index_keywords(index_root, chunks)?;
    fs::create_dir_all(index_root).map_err(|error| error.to_string())?;
    let model_started = Instant::now();
    let model = crate::embedding_service::IndexEmbedder::load(model_dir)?;
    let model_load_ms = model_started.elapsed().as_secs_f64() * 1_000.0;

    let cache = key_library::Library::open(index_root.parent().ok_or("missing library root")?)?;
    let cache_version = key_library::content_hash(
        &serde_json::to_vec(model.identity_bundle()).map_err(|e| e.to_string())?,
    );
    let mut embedded_chunks = 0;
    let embedding_started = Instant::now();
    let cache_reader = cache.artifact_reader()?;
    let mut input = chunks.reader()?;
    let mut completed = 0;
    loop {
        let batch = input
            .by_ref()
            .take(EMBEDDING_BATCH_SIZE)
            .collect::<Result<Vec<_>, _>>()?;
        if batch.is_empty() {
            break;
        }

        let mut missing = Vec::new();
        for chunk in &batch {
            let key = key_library::content_hash(chunk.text.as_bytes());
            if let Some(vector) =
                cache_reader.get::<Vec<f32>>(document_hash, "embedding", &cache_version, &key)?
            {
                if vector.len() == crate::embedder::DIMENSION
                    && vector.iter().all(|v| v.is_finite())
                {
                    continue;
                }
            }
            missing.push(chunk);
        }
        let texts = missing.iter().map(|c| c.text.as_str()).collect::<Vec<_>>();
        let embedded = model.embed_texts(&texts).map_err(|e| e.to_string())?;
        embedded_chunks += embedded.len();
        for (chunk, vector) in missing.into_iter().zip(embedded) {
            cache.put(
                document_hash,
                "embedding",
                &cache_version,
                &key_library::content_hash(chunk.text.as_bytes()),
                &vector,
            )?;
        }
        completed += batch.len();
        progress(completed, chunks.len());
    }
    let embedding_ms = embedding_started.elapsed().as_secs_f64() * 1_000.0;
    let identity = model.identity_bundle().clone();
    drop(model);

    let build_root = generation_root(index_root, document_hash, "vector");
    let precomputed = Arc::new(PrecomputedEmbedder::new(
        cache_reader,
        document_hash.to_owned(),
        cache_version,
        identity,
    )) as Arc<dyn Embedder>;
    let index_started = Instant::now();
    rebuild_index(&build_root, chunks, precomputed, || {
        progress(chunks.len(), chunks.len())
    })?;
    write_marker(
        &build_root,
        document_hash,
        chunks.len(),
        corpus_id(chunks)?,
        producer,
    )?;
    fs::write(build_root.join("corpus.sha256"), corpus_id(chunks)?).map_err(|e| e.to_string())?;
    let library = key_library::Library::open(index_root.parent().ok_or("missing library root")?)?;
    // Publishing only swaps a SQLite pointer. Concurrent readers keep using their
    // immutable generation, including through a crash during a replacement build.
    flush_generation(&build_root)?;
    library.publish_index(document_hash, "vector", INDEX_FORMAT_VERSION, &build_root)?;
    let index_build_ms = index_started.elapsed().as_secs_f64() * 1_000.0;

    Ok(IndexStats {
        chunks: chunks.len(),
        embedded_chunks,
        elapsed_ms: started.elapsed().as_secs_f64() * 1_000.0,
        model_load_ms,
        embedding_ms,
        index_build_ms,
        reused: false,
    })
}

const VECTOR_SEGMENT_CHUNKS: usize = 2048;

fn vector_segments(root: &Path) -> Result<Vec<PathBuf>, String> {
    let path = root.join("segments.json");
    let count: usize = serde_json::from_reader(std::io::BufReader::new(
        fs::File::open(path).map_err(|e| e.to_string())?,
    ))
    .map_err(|e| e.to_string())?;
    if count == 0 || count > 100_000 {
        return Err("Invalid vector segment count".into());
    }
    Ok((0..count)
        .map(|n| root.join(format!("segment-{n}")))
        .collect())
}

fn rebuild_index(
    root: &Path,
    chunks: &(impl ChunkSource + ?Sized),
    embedder: Arc<dyn Embedder>,
    segment_completed: impl Fn(),
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // Upstream builders retain their input and vectors. Bounded immutable
    // segments cap that working set without changing embedding identities.
    let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
        .build()
        .map_err(|e| e.to_string())?;
    let mut input = chunks.reader()?;
    for number in 0..chunks.len().div_ceil(VECTOR_SEGMENT_CHUNKS) {
        let batch = input
            .by_ref()
            .take(VECTOR_SEGMENT_CHUNKS)
            .collect::<Result<Vec<_>, _>>()?;
        key_processing::check_batch_memory()?;
        let segment = root.join(format!("segment-{number}"));
        let stack = EmbedderStack::from_parts(Arc::clone(&embedder), None);
        runtime.block_on(async {
            let cx = frankensearch::Cx::current().ok_or("Search runtime has no context")?;
            let mut builder = IndexBuilder::new(segment.clone())
                .with_embedder_stack(stack)
                .with_batch_size(64);
            for chunk in &batch {
                builder = builder.add_document(chunk.id.clone(), chunk.text.clone());
            }
            builder
                .build(&cx)
                .await
                .map_err(|e| format!("Vector segment build failed: {e:?}"))?;
            Ok::<_, String>(())
        })?;
        TwoTierIndex::open(&segment, TwoTierConfig::default()).map_err(|e| e.to_string())?;
        segment_completed();
    }
    let mut manifest = fs::File::create(root.join("segments.json")).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut manifest, &chunks.len().div_ceil(VECTOR_SEGMENT_CHUNKS))
        .map_err(|e| e.to_string())?;
    manifest.sync_all().map_err(|e| e.to_string())
}

pub fn search_index_at(
    _index_root: &Path,
    chunk_root: &Path,
    model_dir: &Path,
    document_ids: &HashMap<String, String>,
    query: &str,
    limit: usize,
) -> Result<Vec<SemanticSearchHitDto>, String> {
    let embedder = ArcticEmbedder::load(model_dir)
        .ok()
        .map(|e| Arc::new(e) as Arc<dyn Embedder>);
    search_with_embedder(chunk_root, document_ids, query, limit, embedder)
}
pub(crate) fn search_with_embedder(
    chunk_root: &Path,
    document_ids: &HashMap<String, String>,
    query: &str,
    limit: usize,
    embedder: Option<Arc<dyn Embedder>>,
) -> Result<Vec<SemanticSearchHitDto>, String> {
    let library = key_library::Library::open(chunk_root.parent().ok_or("missing library root")?)?;
    if document_ids.is_empty() || query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut shard_roots = Vec::new();
    let index_paths = library.index_reader()?;
    for hash in document_ids.keys() {
        let lexical = index_paths.path(hash, "lexical", INDEX_FORMAT_VERSION)?;
        let vector = index_paths.path(hash, "vector", INDEX_FORMAT_VERSION)?;
        // Metadata or extraction changes may publish lexical before vectors.
        // Never fuse results from different passage generations.
        let vector = vector.filter(|v| {
            lexical.as_ref().is_some_and(|l| {
                let left = fs::read_to_string(l.join("corpus.sha256"));
                let right = fs::read_to_string(v.join("corpus.sha256"));
                matches!((left,right), (Ok(a),Ok(b)) if a==b)
            })
        });
        shard_roots.push((hash.clone(), vector, lexical));
    }
    // Two bounded passes keep only query-term statistics, never all shard readers.
    let mut statistics = crate::lexical::CorpusStatistics::default();
    for (hash, _, root) in &mut shard_roots {
        if let Some(path) = root {
            match KeywordReader::open(path)
                .and_then(|reader| reader.accumulate_statistics(query, &mut statistics))
            {
                Ok(()) => {}
                Err(error) => {
                    library.invalidate_index(hash, "lexical", path, &error)?;
                    *root = None;
                }
            }
        }
    }
    let statistics = Arc::new(statistics);
    let candidate_limit = limit.saturating_mul(4).clamp(64, 1000);
    let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
        .build()
        .map_err(|e| e.to_string())?;
    let (lexical, semantic) = runtime.block_on(async {
        let cx = frankensearch::Cx::current().ok_or("search runtime has no context")?;
        let mut lexical = Vec::new();
        let mut semantic = Vec::new();
        let mut semantic_available = true;
        for (hash, vector_root, lexical_root) in shard_roots {
            if let Some(root) = lexical_root {
                let reader = KeywordReader::open(&root)?.with_statistics(Arc::clone(&statistics));
                let results = reader
                    .search(&cx, query.trim(), candidate_limit)
                    .await
                    .map_err(|e| e.to_string())?;
                lexical.extend(results.into_iter().map(|r| (r.doc_id.to_string(), r.score)));
                retain_best(&mut lexical, candidate_limit);
            }
            if let (Some(root), Some(embedder)) = (
                vector_root,
                embedder.as_ref().filter(|_| semantic_available),
            ) {
                let segments = match vector_segments(&root) {
                    Ok(segments) => segments,
                    Err(error) => {
                        library.invalidate_index(&hash, "vector", &root, &error)?;
                        continue;
                    }
                };
                for segment in segments {
                    let index = match TwoTierIndex::open(&segment, TwoTierConfig::default()) {
                        Ok(index) => index,
                        Err(error) => {
                            library.invalidate_index(&hash, "vector", &root, &error.to_string())?;
                            break;
                        }
                    };
                    let searcher = TwoTierSearcher::new(
                        Arc::new(index),
                        Arc::clone(embedder),
                        TwoTierConfig::default(),
                    );
                    let (results, _) = match searcher
                        .search_collect(&cx, query.trim(), candidate_limit)
                        .await
                    {
                        Ok(results) => results,
                        Err(error) => {
                            eprintln!(
                                "Semantic query unavailable; returning keyword results: {error}"
                            );
                            semantic_available = false;
                            semantic.clear();
                            break;
                        }
                    };
                    semantic.extend(results.into_iter().map(|r| {
                        (
                            r.doc_id.to_string(),
                            r.quality_score.or(r.fast_score).unwrap_or(r.score),
                        )
                    }));
                    retain_best(&mut semantic, candidate_limit);
                }
            }
        }
        Ok::<_, String>((lexical, semantic))
    })?;
    // Rank each modality across the eligible library before fusion. Per-document
    // RRF scores cannot be compared: every shard would otherwise have a rank 1.
    let mut fused = HashMap::<String, f32>::new();
    for candidates in [lexical, semantic] {
        for (rank, (id, _)) in candidates.into_iter().enumerate() {
            *fused.entry(id).or_default() += 1.0 / (60.0 + rank as f32 + 1.0);
        }
    }
    let mut results = fused.into_iter().collect::<Vec<_>>();
    retain_best(&mut results, limit);
    let mut output = Vec::new();
    let passages = library.passage_reader()?;
    for (id, score) in results.into_iter().take(limit) {
        if let Some(chunk) = passages.passage(&id)? {
            output.push(SemanticSearchHitDto {
                id: chunk.id,
                document_id: chunk.document_hash.clone(),
                document_hash: chunk.document_hash,
                page: chunk.page,
                text: chunk.text,
                target_text: chunk.target_text,
                score,
            });
        }
    }
    Ok(output)
}

fn retain_best(results: &mut Vec<(String, f32)>, limit: usize) {
    results.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    results.truncate(limit);
}

fn marker_path(shard_root: &Path) -> PathBuf {
    shard_root.join("key-semantic-index.json")
}

fn write_marker(
    root: &Path,
    document_hash: &str,
    chunks: usize,
    corpus: String,
    producer: String,
) -> Result<(), String> {
    let marker = IndexMarker {
        format_version: INDEX_FORMAT_VERSION.to_owned(),
        model_id: MODEL_ID.to_owned(),
        document_hash: document_hash.to_owned(),
        chunks,
        corpus,
        producer,
    };
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?;
    fs::write(marker_path(root), bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SemanticChunk;
    use crate::{CompactRect, embedder::default_model_dir};
    #[test]
    fn keyword_and_hybrid_search_hydrate_canonical_anchors_after_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let library = key_library::Library::open(temp.path()).unwrap();
        let hash = library.store_source(b"fixture", "Paper", 1).unwrap();
        let chunks = [
            ("rust", "Rust ownership and borrowing prevent memory races."),
            (
                "cooking",
                "Fresh basil and tomatoes make a simple pasta sauce.",
            ),
        ]
        .into_iter()
        .map(|(id, text)| SemanticChunk {
            id: id.into(),
            document_id: hash.clone(),
            document_hash: hash.clone(),
            page: 0,
            block_index: 0,
            sentence_index: 0,
            text: text.into(),
            target_text: text.into(),
            target_rects: vec![CompactRect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
        })
        .collect::<Vec<_>>();
        for c in &chunks {
            library
                .store_block(
                    &hash,
                    &c.id,
                    &c.text,
                    &[key_library::ChunkAnchor {
                        id: c.id.clone(),
                        page: 0,
                        context_start: 0,
                        context_end: c.text.len(),
                        target_start: 0,
                        target_end: c.text.len(),
                        rects: vec![[1, 2, 3, 4]],
                    }],
                )
                .unwrap();
        }
        let root = temp.path().join("frankensearch");
        let chunk_root = temp.path().join("chunks");
        let ids = HashMap::from([(hash.clone(), hash.clone())]);
        index_keywords(&root, &chunks).unwrap();
        let keyword = search_index_at(
            &root,
            &chunk_root,
            Path::new("/missing-model"),
            &ids,
            "ownership",
            5,
        )
        .unwrap();
        assert_eq!(keyword[0].id, "rust");
        assert_eq!(
            library.passage(&keyword[0].id).unwrap().unwrap().rects,
            vec![[1, 2, 3, 4]]
        );
        let model = default_model_dir().expect("bundled model");
        let stats = index_document(&root, &model, &chunks, |_, _| {}).unwrap();
        assert_eq!(stats.embedded_chunks, 2);
        let hits = search_index_at(&root, &chunk_root, &model, &ids, "memory safety", 5).unwrap();
        assert_eq!(hits[0].id, "rust");
        assert_eq!(hits[0].document_hash, hash);
        library
            .update_metadata(&hash, "Paper", Some(2024), &["Alice".into()])
            .unwrap();
        let service = crate::SemanticSearchService::start_at(temp.path().into());
        assert!(
            service
                .search(
                    "memory safety".into(),
                    5,
                    key_library::Filter {
                        year_from: Some(2025),
                        ..Default::default()
                    }
                )
                .unwrap()
                .is_empty()
        );
        let first = Instant::now();
        assert_eq!(
            service
                .search("memory safety".into(), 5, key_library::Filter::default())
                .unwrap()[0]
                .id,
            "rust"
        );
        let cold = first.elapsed();
        let warm = Instant::now();
        assert_eq!(
            service
                .search("memory safety".into(), 5, key_library::Filter::default())
                .unwrap()[0]
                .id,
            "rust"
        );
        eprintln!(
            "query fixture: cold={}ms warm={}ms",
            cold.as_millis(),
            warm.elapsed().as_millis()
        );
        assert!(is_current_index(&root, &hash));
        assert!(
            index_document(&root, &model, &chunks, |_, _| {})
                .unwrap()
                .reused
        );
    }
}

#[cfg(test)]
mod segment_tests {
    use super::*;
    #[test]
    fn bounded_segments_preserve_every_vector_and_boundary_id() {
        let temp = tempfile::tempdir().unwrap();
        let library = key_library::Library::open(temp.path()).unwrap();
        let hash = library.store_source(b"segments", "Segments", 1).unwrap();
        let model = ArcticEmbedder::load(&crate::embedder::default_model_dir().unwrap()).unwrap();
        let text = "Scientific methods and experimental evidence.";
        let vector = model.embed_texts(&[text]).unwrap().remove(0);
        library
            .put(
                &hash,
                "embedding",
                "test",
                &key_library::content_hash(text.as_bytes()),
                &vector,
            )
            .unwrap();
        let embedder = Arc::new(PrecomputedEmbedder::new(
            library.artifact_reader().unwrap(),
            hash.clone(),
            "test".into(),
            model.identity_bundle().clone(),
        ));
        drop(model);
        let chunks = (0..VECTOR_SEGMENT_CHUNKS + 1)
            .map(|n| SemanticChunk {
                id: format!("segment-{n}"),
                document_id: hash.clone(),
                document_hash: hash.clone(),
                page: 0,
                block_index: 0,
                sentence_index: n,
                text: text.into(),
                target_text: text.into(),
                target_rects: Vec::new(),
            })
            .collect::<Vec<_>>();
        let root = temp.path().join("segments");
        rebuild_index(&root, &chunks, embedder, || {}).unwrap();
        let paths = vector_segments(&root).unwrap();
        assert_eq!(paths.len(), 2);
        let first = TwoTierIndex::open(&paths[0], TwoTierConfig::default()).unwrap();
        let last = TwoTierIndex::open(&paths[1], TwoTierConfig::default()).unwrap();
        for (n, chunk) in chunks.iter().enumerate() {
            let index = if n < VECTOR_SEGMENT_CHUNKS {
                &first
            } else {
                &last
            };
            assert!(
                index.fast_vector_for_doc_id(&chunk.id).unwrap().is_some(),
                "Missing {}",
                chunk.id
            );
        }
    }
}
