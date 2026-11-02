// cargo run -p key-zotero --example import -- <workspace data dir>
fn main() {
    let target = std::env::args().nth(1).expect("target directory");
    let store = key_store::Store::open(&target).unwrap();
    let started = std::time::Instant::now();
    let report = key_zotero::import(&store, &Default::default()).unwrap();
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    println!("took {:?}", started.elapsed());
    let page = store.list_sources(&key_store::ListQuery { text: Some("health income".into()), limit: Some(3), ..Default::default() }).unwrap();
    for s in page.items {
        println!("- [{}|{}|{}] {} — {:?} ({:?}) tags={:?} cols={} notes={}", s.kind, s.fields.get("itemType").unwrap(), s.index_status, s.title(), s.creators.first().map(|c| c.display()), s.fields.get("year"), s.tags, s.collections.len(), s.note_count);
    }
    println!("{}", serde_json::to_string(&store.facets(&Default::default()).unwrap().kinds).unwrap());
    println!("counts {:?}", store.list_sources(&Default::default()).unwrap().counts);
}
