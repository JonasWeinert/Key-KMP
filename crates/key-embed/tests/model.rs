// Downloads the real model; run with `KEY_EMBED_TEST=1 cargo test -p key-embed`.
use key_embed::{Embedder, ModelDir};

#[test]
fn ranks_documents_by_meaning() {
    if std::env::var_os("KEY_EMBED_TEST").is_none() {
        return;
    }
    let dir = ModelDir::from_env();
    assert!(dir.download().unwrap(), "another process holds the download lock");
    let embedder = Embedder::load(&dir).unwrap();
    let docs = [
        ("", "Venus is often called Earth's twin because of its similar size and proximity."),
        ("", "Mars, known for its reddish appearance, is often referred to as the Red Planet."),
        ("", "Jupiter, the largest planet in our solar system, has a prominent red spot."),
    ];
    let documents = embedder.embed_documents(&docs).unwrap();
    let query = embedder.embed_query("Which planet is known as the Red Planet?").unwrap();
    let scores: Vec<f32> = documents.iter().map(|d| d.iter().zip(&query).map(|(a, b)| a * b).sum()).collect();
    println!("scores {scores:?}");
    assert!(scores[1] > scores[0] && scores[1] > scores[2]);
}
