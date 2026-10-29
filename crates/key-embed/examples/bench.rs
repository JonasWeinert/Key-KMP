// cargo run -p key-embed --example bench [--release]
fn main() {
    let dir = key_embed::ModelDir::from_env();
    let started = std::time::Instant::now();
    let embedder = key_embed::Embedder::load(&dir).unwrap();
    println!("load {:?}", started.elapsed());
    let text = "Individuals were asked to choose between policies that trade off health outcomes against household income during the pandemic. ".repeat(9);
    let items: Vec<(&str, &str)> = (0..64).map(|_| ("Health versus income", text.as_str())).collect();
    let started = std::time::Instant::now();
    embedder.embed_documents(&items).unwrap();
    let elapsed = started.elapsed();
    println!("64 chunks of {} chars: {:?} ({:.1} chunks/s)", text.len(), elapsed, 64.0 / elapsed.as_secs_f64());
}
