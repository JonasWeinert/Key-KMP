//! Calibration and timing for search on a real workspace. For each query, prints the nearest
//! passages with their cosine distance, then times keyword-only and hybrid search.
//! cargo run -p key-index --example probe -- <workspace>/.key "query" …
use key_embed::{Embedder, ModelDir};
use key_store::{SearchQuery, Store};
use rusqlite::Connection;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("workspace .key directory");
    let store = Store::open(&dir).expect("open store");
    let db = Connection::open(std::path::Path::new(&dir).join("key.db")).unwrap();
    let embedder = Embedder::load(&ModelDir::from_env()).expect("load model");
    let quiet = std::env::var_os("PROBE_TIMING_ONLY").is_some();
    for query in args {
        let started = Instant::now();
        let vector = embedder.embed_query(&query).unwrap();
        let embed = started.elapsed();
        println!("\n== {query}  (embed {embed:.0?})");
        if !quiet {
            let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            let mut statement = db
                .prepare(
                    "SELECT knn.distance, s.title, substr(c.text, 1, 90) FROM
                     (SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ?1 AND k = 8) knn
                     JOIN chunks c ON c.id = knn.rowid JOIN sources s ON s.id = c.source_id ORDER BY knn.distance",
                )
                .unwrap();
            let rows = statement
                .query_map([blob], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
                .unwrap();
            for row in rows {
                let (distance, title, text) = row.unwrap();
                println!("{distance:.3}  {:.50}  | {}", title, text.replace('\n', " "));
            }
        }
        let request = SearchQuery { text: query.clone(), passages_per_source: Some(3), ..Default::default() };
        let started = Instant::now();
        let keyword = store.search(&request, None).unwrap();
        let keyword_time = started.elapsed();
        let started = Instant::now();
        let hybrid = store.search(&request, Some(&vector)).unwrap();
        println!("keyword {keyword_time:.0?} ({} hits) · hybrid {:.0?} ({} hits)", keyword.hits.len(), started.elapsed(), hybrid.hits.len());
    }
    key_embed::shutdown();
}
