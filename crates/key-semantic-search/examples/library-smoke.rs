//! Reproducible native extraction/index/query smoke test. No UI or network needed.
use key_semantic_search::{ChunkSource, SemanticSearchService, maybe_run_helper};
use std::{path::PathBuf, sync::Arc, time::Instant};
fn main() -> Result<(), String> {
    if let Some(code) = maybe_run_helper() {
        std::process::exit(code);
    }
    let args = std::env::args().collect::<Vec<_>>();
    let input = PathBuf::from(
        args.get(1)
            .ok_or("usage: library-smoke PDF LIBRARY_DIRECTORY")?,
    );
    let root = PathBuf::from(args.get(2).ok_or("missing library directory")?);
    let started = Instant::now();
    let service = SemanticSearchService::try_start_at(root.clone())?;
    let bytes = std::fs::read(&input).map_err(|e| e.to_string())?;
    let hash = service
        .library()
        .store_source(&bytes, "Smoke test paper", 0)?;
    drop(bytes);
    let cached = service.prepare_cached_chunks(&hash, &hash, false)?;
    let extraction_reused = cached.is_some();
    let chunks = match cached {
        Some(chunks) => chunks,
        None => {
            let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
            let mut helper =
                std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
            helper
                .arg("--key-semantic-helper")
                .arg(&input)
                .arg(output.path())
                .arg("--hash")
                .arg(&hash)
                .arg("--library")
                .arg(service.library().root())
                .arg("--canonical");
            key_processing::run_helper(helper, service.library(), &hash, "semantic-extraction")?;
            service
                .prepare_cached_chunks(&hash, &hash, false)?
                .ok_or("Missing canonical semantic pages")?
        }
    };
    let page_count = service
        .library()
        .get::<key_semantic_search::SemanticDocumentDto>(&hash, "semantic-header", "v5", "false")?
        .ok_or("Missing semantic header")?
        .page_count;
    service.register_document(
        hash.clone(),
        hash.clone(),
        "Smoke test paper".into(),
        page_count,
    )?;
    if chunks.is_empty() {
        service.set_document_progress(&hash, "no_text", 0, 0, None)?;
        if std::env::var_os("KEY_EXPECT_NO_TEXT").is_none() {
            return Err("Unexpected textless PDF".into());
        }
        println!(
            "{}",
            serde_json::json!({"hash":hash,"pages":page_count,"status":"no_text","chunks":0})
        );
        return Ok(());
    }
    let mut expected = None;
    for chunk in chunks.reader()? {
        let chunk = chunk?;
        if !chunk.target_text.trim().is_empty() {
            expected = Some(chunk);
            break;
        }
    }
    let expected = expected.ok_or("PDF has no text chunks")?;
    let stats = service.index_document(chunks, Arc::new(|_, _| {}))?;
    drop(service);
    let reopened = SemanticSearchService::try_start_at(root)?;
    let query = expected
        .target_text
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    let cold = Instant::now();
    let results = reopened.search(query.clone(), 5, key_library::Filter::default())?;
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
    let warm = Instant::now();
    let warm_results = reopened.search(query, 5, key_library::Filter::default())?;
    let warm_ms = warm.elapsed().as_secs_f64() * 1000.0;
    // This token has no lexical posting. A result proves the shared model RPC
    // and vector generation work, rather than silently passing via keywords.
    let semantic_probe = reopened.search(
        "zzxqvnonlexicalprobe".into(),
        3,
        key_library::Filter::default(),
    )?;
    if semantic_probe.is_empty() {
        return Err("Vector-only probe returned no hits".into());
    }
    let mut recovery_verified = false;
    #[cfg(unix)]
    if std::env::var_os("KEY_SMOKE_RECOVERY").is_some() {
        let snapshot = std::process::Command::new("ps")
            .args(["-axo", "pid=,ppid=,command="])
            .output()
            .map_err(|e| e.to_string())?;
        let own = std::process::id().to_string();
        let snapshot = String::from_utf8_lossy(&snapshot.stdout);
        let pid = snapshot
            .lines()
            .find_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?;
                let parent = fields.next()?;
                (parent == own && line.contains("--key-embedding-service")).then(|| pid.to_owned())
            })
            .ok_or("No owned embedding child found")?;
        let status = std::process::Command::new("kill")
            .args(["-KILL", &pid])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not kill the test's embedding child".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        let recovered = reopened.search(
            "zzxqvanotherrecoveryprobe".into(),
            3,
            key_library::Filter::default(),
        )?;
        if recovered.is_empty() {
            return Err("Embedding service did not recover after crash".into());
        }
        recovery_verified = true;
    }

    if results.is_empty() || warm_results.is_empty() {
        return Err("No search hits after restarting service".into());
    }
    let target = reopened
        .library()
        .passage(&results[0].id)?
        .ok_or("Missing search anchor")?;
    if target.document_hash != hash || target.rects.is_empty() {
        return Err("Search target has wrong hash or no geometry".into());
    }
    if key_library::content_hash(
        &std::fs::read(reopened.library().source_path(&hash)?).map_err(|e| e.to_string())?,
    ) != hash
    {
        return Err("Managed source changed".into());
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"embeddingRecoveryVerified":recovery_verified,"semanticProbeHits":semantic_probe.len(),"hash":hash,"pages":page_count,"extractionReused":extraction_reused,"index":stats,"coldSearchMs":cold_ms,"warmSearchMs":warm_ms,"firstResultPage":target.page,"anchorRects":target.rects.len(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0})).map_err(|e|e.to_string())?);
    Ok(())
}
