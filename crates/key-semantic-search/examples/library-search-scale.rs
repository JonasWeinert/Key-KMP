//! Synthetic 100-document / 100k-passage lexical retrieval qualification.
use key_semantic_search::{SemanticChunk, SemanticSearchService, index_keywords};
use std::{path::PathBuf, time::Instant};
fn main() -> Result<(), String> {
    if let Some(code) = key_semantic_search::maybe_run_helper() {
        std::process::exit(code);
    }
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: library-search-scale EMPTY_LIBRARY")?,
    );
    let reused = root.join("library.sqlite3").exists();
    let service = SemanticSearchService::try_start_at(root.clone())?;
    let started = Instant::now();
    let mut eligible = std::collections::HashSet::new();
    for d in 0..100 {
        let hash = key_library::content_hash(format!("search-scale-{d}").as_bytes());
        if d % 10 == 5 {
            eligible.insert(hash.clone());
        }
        if reused {
            continue;
        }
        service
            .library()
            .register(&hash, &format!("Scale {d}"), 100)?;
        service.library().update_metadata(
            &hash,
            &format!("Scale {d}"),
            Some(2000 + d % 10),
            &[],
        )?;
        if d % 10 == 5 {
            eligible.insert(hash.clone());
        }
        let mut body = String::new();
        let mut anchors = Vec::new();
        let mut chunks = Vec::new();
        for p in 0..1000 {
            let text = format!(
                "Calibration evidence from experimental sample {p} in study {d}. Shared measurement methods and uncertainty estimates."
            );
            let start = body.len();
            body.push_str(&text);
            let end = body.len();
            body.push('\n');
            let id = format!("scale-{d}-{p}");
            anchors.push(key_library::ChunkAnchor {
                id: id.clone(),
                page: p % 100,
                context_start: start,
                context_end: end,
                target_start: start,
                target_end: end,
                rects: vec![[1, 2, 3, 4]],
            });
            chunks.push(SemanticChunk {
                id,
                document_id: hash.clone(),
                document_hash: hash.clone(),
                page: p % 100,
                block_index: 0,
                sentence_index: p,
                text: text.clone(),
                target_text: text,
                target_rects: Vec::new(),
            });
        }
        service
            .library()
            .store_block(&hash, "body", &body, &anchors)?;
        index_keywords(&root.join("frankensearch"), &chunks)?;
    }
    let build_ms = started.elapsed().as_secs_f64() * 1000.;
    let mut unfiltered = Vec::new();
    let mut filtered = Vec::new();
    for _ in 0..20 {
        let now = Instant::now();
        let hits = service.search(
            "calibration uncertainty".into(),
            30,
            key_library::Filter::default(),
        )?;
        if hits.len() != 30 {
            return Err(format!("Expected 30 hits, got {}", hits.len()));
        }
        unfiltered.push(now.elapsed().as_secs_f64() * 1000.);
        let now = Instant::now();
        let hits = service.search(
            "calibration uncertainty".into(),
            30,
            key_library::Filter {
                year_from: Some(2005),
                year_to: Some(2005),
                ..Default::default()
            },
        )?;
        if hits.len() != 30 || hits.iter().any(|h| !eligible.contains(&h.document_hash)) {
            return Err("Selective filter failed".into());
        }
        filtered.push(now.elapsed().as_secs_f64() * 1000.);
    }
    unfiltered.sort_by(f64::total_cmp);
    filtered.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"reusedCorpus":reused,"documents":100,"passages":100000,"buildMs":build_ms,"unfilteredP50Ms":unfiltered[10],"unfilteredP95Ms":unfiltered[19],"filteredP50Ms":filtered[10],"filteredP95Ms":filtered[19],"queries":40,"modality":"Tantivy only; synthetic text; debug build"})
    );
    Ok(())
}
