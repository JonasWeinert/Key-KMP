//! Ten real PDF jobs through supervised helpers, including active-reader
//! preemption. Small-fixture qualification, not a large/scanned-PDF SLO.
use key_semantic_search::{SemanticDocumentDto, SemanticSearchService, maybe_run_helper};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
struct Context {
    service: SemanticSearchService,
    scheduler: key_processing::Scheduler,
    root: PathBuf,
}
fn schedule(
    context: Arc<Context>,
    hash: String,
    number: usize,
    finished: mpsc::Sender<(usize, Result<(), String>)>,
) {
    let scheduler = context.scheduler.clone();
    scheduler.submit(hash.clone(), "semantic", 0, move || {
        let result = (|| {
            let service = &context.service;
            let chunks = match service.prepare_cached_chunks(&hash, &hash, false)? {
                Some(chunks) => chunks,
                None => {
                    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
                    let mut helper =
                        Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
                    helper
                        .arg("--key-semantic-helper")
                        .arg(service.library().source_path(&hash)?)
                        .arg(output.path())
                        .arg("--hash")
                        .arg(&hash)
                        .arg("--library")
                        .arg(service.library().root())
                        .arg("--canonical");
                    key_processing::run_helper(
                        helper,
                        service.library(),
                        &hash,
                        "semantic-extraction",
                    )?;
                    service
                        .prepare_cached_chunks(&hash, &hash, false)?
                        .ok_or("Missing canonical semantic pages")?
                }
            };
            let pages = service
                .library()
                .get::<SemanticDocumentDto>(&hash, "semantic-header", "v5", "false")?
                .ok_or("Missing semantic header")?
                .page_count;
            service.register_document(
                hash.clone(),
                hash.clone(),
                format!("Fairness {number}"),
                pages,
            )?;
            let stats = service.index_document(chunks, Arc::new(|_, _| {}))?;
            if stats.chunks == 0 {
                return Err("No passages".into());
            }
            Ok(())
        })();
        if result
            .as_ref()
            .is_err_and(|e| e == key_processing::YIELDED_TO_READER)
        {
            schedule(context, hash, number, finished);
        } else {
            let _ = finished.send((number, result));
        }
    });
}
fn main() -> Result<(), String> {
    if let Some(code) = maybe_run_helper() {
        std::process::exit(code);
    }
    let args = std::env::args().collect::<Vec<_>>();
    let source = PathBuf::from(
        args.get(1)
            .ok_or("usage: library-fairness PDF_OR_DIRECTORY EMPTY_LIBRARY")?,
    );
    let mut corpus = if source.is_dir() {
        std::fs::read_dir(&source)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "pdf"))
            .collect::<Vec<_>>()
    } else {
        vec![source]
    };
    corpus.sort();
    if corpus.is_empty() {
        return Err("No PDF fixtures".into());
    }
    let root = PathBuf::from(args.get(2).ok_or("missing root")?);
    if root.join("library.sqlite3").exists() {
        return Err("Use a fresh test library directory".into());
    }
    let service = SemanticSearchService::try_start_at(root.clone())?;
    let mut hashes = Vec::new();
    for n in 0..10 {
        let mut bytes = std::fs::read(&corpus[n % corpus.len()]).map_err(|e| e.to_string())?;
        bytes.extend_from_slice(format!("\n% key fairness fixture {n}\n").as_bytes());
        let hash = service
            .library()
            .store_source(&bytes, &format!("Fairness {n}"), 7)?;
        service
            .library()
            .set_property(&hash, "fixture", &serde_json::json!(n))?;
        hashes.push(hash);
    }
    let context = Arc::new(Context {
        service,
        scheduler: key_processing::Scheduler::new(2),
        root,
    });
    let (finished, events) = mpsc::channel();
    let started = Instant::now();
    for (n, hash) in hashes.iter().enumerate() {
        schedule(context.clone(), hash.clone(), n, finished.clone());
    }
    // Pick the final queued document while the first helper is doing real work.
    std::thread::sleep(Duration::from_millis(100));
    context.scheduler.prioritize(&hashes[9]);
    let selected = Instant::now();
    let mut order = Vec::new();
    let mut active_ms = 0.;
    for _ in 0..10 {
        let (n, result) = events
            .recv_timeout(Duration::from_secs(120))
            .map_err(|e| e.to_string())?;
        result?;
        if n == 9 {
            active_ms = selected.elapsed().as_secs_f64() * 1000.;
        }
        order.push(n);
    }
    if order.iter().position(|n| *n == 9).unwrap() > 1 {
        return Err(format!(
            "Active document waited behind queued work: {order:?}"
        ));
    }
    for n in 0..10 {
        let mut filter = key_library::Filter::default();
        filter
            .properties
            .insert("fixture".into(), serde_json::json!(n));
        let hits = context
            .service
            .search("zzxqvnonlexicalprobe".into(), 3, filter)?;
        if hits.is_empty() || hits.iter().any(|h| h.document_hash != hashes[n]) {
            return Err(format!("Invalid filtered vector results for {n}"));
        }
    }
    println!(
        "{}",
        serde_json::json!({"jobs":10,"completionOrder":order,"selectedDocument":9,"selectedCompletionMs":active_ms,"elapsedMs":started.elapsed().as_secs_f64()*1000.,"filteredVectorQueries":10})
    );
    Ok(())
}
