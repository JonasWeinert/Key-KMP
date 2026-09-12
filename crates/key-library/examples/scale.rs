//! Synthetic storage/migration qualification. Does not claim PDF/ONNX latency.
use key_library::{Filter, Library};
use std::{path::PathBuf, time::Instant};
fn main() -> Result<(), String> {
    let root = PathBuf::from(std::env::args().nth(1).ok_or("usage: scale LIBRARY")?);
    let start = Instant::now();
    let library = Library::open(&root)?;
    let migration_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut samples = Vec::new();
    for n in 0..500 {
        let start = Instant::now();
        let id = format!("scale-{}-{}", n % 100, (n * 197) % 1000);
        let hit = library
            .passage(&id)?
            .ok_or_else(|| format!("Missing {id}"))?;
        if hit.target_text != "Synthetic" || hit.rects.len() != 1 {
            return Err(format!("Wrong anchor {id}"));
        }
        samples.push(start.elapsed().as_secs_f64() * 1000.);
    }
    samples.sort_by(f64::total_cmp);
    let start = Instant::now();
    let docs = library.documents(&Filter {
        year_from: Some(2020),
        year_to: Some(2020),
        ..Default::default()
    })?;
    if docs.len() != 10 {
        return Err(format!("Expected 10 eligible docs, got {}", docs.len()));
    }
    println!(
        "{}",
        serde_json::json!({"documents":100,"passages":100000,"migrationMs":migration_ms,"anchorReadP50Ms":samples[250],"anchorReadP95Ms":samples[475],"filterMs":start.elapsed().as_secs_f64()*1000.,"filteredDocuments":docs.len()})
    );
    Ok(())
}
