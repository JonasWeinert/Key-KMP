use super::*;
use serde_json::json;

fn input(value: Json) -> SourceInput {
    serde_json::from_value(value).unwrap()
}

fn unit(index: usize) -> Vec<f32> {
    let mut v = vec![0.0; EMBEDDING_DIMENSIONS];
    v[index] = 1.0;
    v
}

#[test]
fn stores_bibliographic_fields_properties_and_collections() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let thesis = store.create_collection("Thesis", None, None).unwrap();
    let chapter = store.create_collection("Chapter 2", Some(&thesis.id), None).unwrap();
    let source = store
        .insert_source(input(json!({
            "kind": "pdf", "itemType": "article", "title": "Health versus income",
            "creators": [{"family": "Palma", "given": "Marco"}], "year": 2022, "doi": "10.1/abc",
            "containerTitle": "Social Science & Medicine", "tags": ["covid", "valuation", "Covid"],
            "properties": {"rating": 4}, "collections": [chapter.id]
        })))
        .unwrap();
    assert_eq!(source.title(), "Health versus income");
    assert_eq!(source.tags, vec!["covid", "valuation"]);
    assert_eq!(source.fields["year"], json!(2022));
    assert_eq!(source.properties["rating"], json!(4));

    // Parent collections include sub-collection items; text search covers creators.
    let page = store.list_sources(&ListQuery { collection_id: Some(thesis.id.clone()), ..Default::default() }).unwrap();
    assert_eq!(page.total, 1);
    let page = store.list_sources(&ListQuery { text: Some("palm soc".into()), ..Default::default() }).unwrap();
    assert_eq!(page.total, 1);

    let mut patch = Map::new();
    patch.insert("properties".into(), json!({"rating": null, "status": "read"}));
    patch.insert("starred".into(), json!(true));
    let updated = store.update_source(&source.id, &patch).unwrap();
    assert!(updated.starred);
    assert_eq!(updated.properties, json!({"status": "read"}).as_object().unwrap().clone());
    assert_eq!(store.list_sources(&ListQuery { scope: Some("starred".into()), ..Default::default() }).unwrap().total, 1);

    store.trash(&[source.id.clone()], true).unwrap();
    let page = store.list_sources(&ListQuery::default()).unwrap();
    assert_eq!((page.total, page.counts.trashed), (0, 1));
}

#[test]
fn hybrid_search_fuses_keyword_and_vector_passages() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let a = store.insert_source(input(json!({"kind": "pdf", "title": "Willingness to pay"}))).unwrap();
    let b = store.insert_source(input(json!({"kind": "pdf", "title": "Malaria nets"}))).unwrap();
    store
        .replace_chunks(&a.id, &[ChunkInput { page: Some(2), text: "People value income over health in some countries.".into(), embedding: Some(unit(0)), ..Default::default() }])
        .unwrap();
    store
        .replace_chunks(&b.id, &[ChunkInput { page: Some(0), text: "Bed nets reduce malaria transmission.".into(), embedding: Some(unit(1)), ..Default::default() }])
        .unwrap();

    let keyword = store.search(&SearchQuery { text: "income".into(), ..Default::default() }, None).unwrap();
    assert_eq!(keyword.hits[0].source_id, a.id);
    assert!(keyword.hits[0].passages[0].snippet.contains("[[income]]"));

    // A query vector near document b finds it with no shared words.
    let semantic = store
        .search(&SearchQuery { text: "mosquito".into(), ..Default::default() }, Some(&unit(1)))
        .unwrap();
    assert_eq!(semantic.hits[0].source_id, b.id);
    assert_eq!(semantic.hits[0].passages[0].page, Some(0));

    let passage_id: i64 = keyword.hits[0].passages[0].id.parse().unwrap();
    assert_eq!(store.passage(passage_id).unwrap().unwrap().page, 2);

    // Re-indexing replaces chunks and their vectors.
    store.replace_chunks(&a.id, &[]).unwrap();
    assert_eq!(store.vector_count().unwrap(), 1);
}

#[test]
fn reimports_by_origin_key_without_duplicating() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let first = store
        .insert_sources(vec![input(json!({"kind": "reference", "title": "A", "origin": "zotero", "originKey": "K1"}))])
        .unwrap();
    let second = store
        .insert_sources(vec![input(json!({"kind": "reference", "title": "A (edited)", "origin": "zotero", "originKey": "K1"}))])
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(store.source(&first[0]).unwrap().unwrap().title(), "A (edited)");
    let note = store.save_note(None, Some(&first[0]), "Reading note", "Key argument about trade-offs", Some("N1")).unwrap();
    assert_eq!(store.save_note(None, Some(&first[0]), "Reading note", "Edited", Some("N1")).unwrap().id, note.id);
    assert_eq!(store.list_sources(&ListQuery { text: Some("edited".into()), ..Default::default() }).unwrap().total, 1);
    let facets = store.facets(&ListQuery::default()).unwrap();
    assert_eq!(facets.kinds[0].value, "reference");
}

#[test]
fn property_definitions_rename_and_proposals() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.save_property_definition("Status", &json!({"type": "select", "options": ["To read", "Read"]})).unwrap();
    let source = store.insert_source(input(json!({"kind": "pdf", "title": "A", "properties": {"Status": "Read"}}))).unwrap();
    assert_eq!(store.property_definitions().unwrap()[0]["options"][1], "Read");
    store.rename_property("Status", "Reading status").unwrap();
    let renamed = store.source(&source.id).unwrap().unwrap();
    assert_eq!(renamed.properties["Reading status"], "Read");
    assert!(!renamed.properties.contains_key("Status"));
    // Proposals only land if the value is unchanged since they were generated.
    assert!(store.apply_property_proposal(&source.id, "Reading status", &json!("To read"), &Json::Null, &json!({})).is_err());
    store.apply_property_proposal(&source.id, "Reading status", &json!("To read"), &json!("Read"), &json!({"model": "m"})).unwrap();
    assert_eq!(store.property_provenance(&source.id).unwrap()["Reading status"]["model"], "m");
    assert_eq!(store.delete_property("Reading status", true).unwrap(), 1);
    assert!(store.source(&source.id).unwrap().unwrap().properties.is_empty());
}

#[test]
fn search_reports_matching_fields_and_follows_typing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let source = store
        .insert_source(input(json!({
            "kind": "reference", "title": "Health versus income",
            "creators": [{"family": "Ozdemir"}, {"family": "Palma", "given": "Marco"}],
            "abstract": "Public efforts to battle COVID-19 trade health against income."
        })))
        .unwrap();
    store
        .replace_chunks(&source.id, &[ChunkInput { text: "Public efforts to battle COVID-19 trade health against income.".into(), ..Default::default() }])
        .unwrap();

    // Two letters already find the second author, and say where the match is.
    let typing = store.search(&SearchQuery { text: "pa".into(), ..Default::default() }, None).unwrap();
    let hit = &typing.hits[0];
    assert_eq!(hit.source.as_ref().unwrap().id, source.id);
    assert_eq!(hit.fields[0].field, "creators");
    assert!(hit.fields[0].snippet.contains("[[Palma]]"));

    // An abstract match is reported once, as the field, not again as a passage.
    let result = store.search(&SearchQuery { text: "battle".into(), ..Default::default() }, None).unwrap();
    assert!(result.hits[0].fields.iter().any(|f| f.field == "abstract" && f.snippet.contains("[[battle]]")));
    assert!(result.hits[0].passages.is_empty());
}

#[test]
fn hybrid_search_works_with_filters() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let thesis = store.create_collection("Thesis", None, None).unwrap();
    let a = store.insert_source(input(json!({"kind": "pdf", "title": "Nets", "tags": ["malaria"], "collections": [thesis.id]}))).unwrap();
    store
        .replace_chunks(&a.id, &[ChunkInput { page: Some(0), text: "Bed nets reduce malaria.".into(), embedding: Some(unit(1)), ..Default::default() }])
        .unwrap();
    // Each filter adds a bound value next to the query vector and keyword parameters.
    for filter in [
        json!({"text": "malaria", "collectionId": thesis.id}),
        json!({"text": "malaria", "kind": "pdf", "tag": "malaria"}),
        json!({"text": "mosquito", "collectionId": thesis.id, "scope": "starred"}),
    ] {
        let query: SearchQuery = serde_json::from_value(filter.clone()).unwrap();
        let result = store.search(&query, Some(&unit(1))).unwrap_or_else(|e| panic!("{filter}: {e}"));
        assert_eq!(result.hits.len(), usize::from(filter["scope"].is_null()), "{filter}");
    }
}
