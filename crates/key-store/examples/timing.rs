//! Times the store queries that run on every status poll and indexer tick.
//! cargo run -p key-store --example timing -- <workspace>/.key
use std::time::Instant;

fn main() {
    let dir = std::env::args().nth(1).expect("workspace .key directory");
    let store = key_store::Store::open(&dir).expect("open store");
    let started = Instant::now();
    let missing = store.chunks_without_vectors(64).unwrap().len();
    println!("chunks_without_vectors: {missing} in {:.0?}", started.elapsed());
    let started = Instant::now();
    let count = store.vector_count().unwrap();
    println!("vector_count: {count} in {:.0?}", started.elapsed());
    let started = Instant::now();
    let page = store.list_sources(&key_store::ListQuery { limit: Some(0), ..Default::default() }).unwrap();
    println!("status counts: {} in {:.0?}", page.counts.all, started.elapsed());
}
