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

#[test]
fn standalone_and_source_notes_stay_searchable() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let source = store.insert_source(input(json!({"kind": "reference", "title": "Nets"}))).unwrap();
    let attached = store.save_note(None, Some(&source.id), "", "Mosquito density fell", None).unwrap();
    let standalone = store.save_note(None, None, "Ideas", "# Chapter plan", None).unwrap();
    assert_eq!(store.standalone_notes().unwrap().iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec![standalone.id.clone()]);
    assert_eq!(store.note(&standalone.id).unwrap().unwrap().title, "Ideas");

    // Editing from a note tab passes no source; the note keeps it and stays searchable.
    let edited = store.save_note(Some(&attached.id), None, "", "Larval habitats shrank", None).unwrap();
    assert_eq!(edited.source_id.as_deref(), Some(source.id.as_str()));
    let find = |text: &str| store.list_sources(&ListQuery { text: Some(text.into()), ..Default::default() }).unwrap().total;
    assert_eq!((find("larval"), find("mosquito")), (1, 0));
    store.delete_note(&attached.id).unwrap();
    assert_eq!(find("larval"), 0);
}

#[test]
fn suggestions_become_filters_that_narrow_lists_and_search() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let thesis = store.create_collection("Thesis chapters", None, None).unwrap();
    let a = store
        .insert_source(input(json!({
            "kind": "pdf", "title": "Health versus income", "year": 2022, "containerTitle": "PLoS ONE",
            "creators": [{"given": "Mohamed", "family": "Ali"}, {"given": "Marco", "family": "Palma"}],
            "tags": ["covid"], "properties": {"Status": "To read"}, "collections": [thesis.id]
        })))
        .unwrap();
    let b = store
        .insert_source(input(json!({
            "kind": "reference", "title": "Malaria nets", "year": 2019, "containerTitle": "The Lancet",
            "creators": [{"given": "Sara", "family": "Mohamedi"}], "tags": ["malaria"]
        })))
        .unwrap();
    store.replace_chunks(&b.id, &[ChunkInput { page: Some(0), text: "Bed nets reduce transmission.".into(), ..Default::default() }]).unwrap();
    store.save_property_definition("Status", &json!({"type": "select", "options": ["To read", "Read"]})).unwrap();

    // Word starts match: "moh" finds both names, the exact first-word match first.
    let people: Vec<_> = store
        .suggest("moh", &ListQuery::default(), 6)
        .unwrap()
        .into_iter()
        .filter(|s| s.filter.field == "creator")
        .map(|s| (s.label, s.count))
        .collect();
    assert_eq!(people, vec![("Mohamed Ali".to_string(), 1), ("Sara Mohamedi".to_string(), 1)]);
    // A later word in a name ("Ali"), a journal, a tag, a collection, a property value and a year.
    let labels = |text: &str| store.suggest(text, &ListQuery::default(), 6).unwrap().into_iter().map(|s| (s.filter.field, s.label)).collect::<Vec<_>>();
    assert!(labels("ali").contains(&("creator".into(), "Mohamed Ali".into())));
    assert!(labels("lan").contains(&("container".into(), "The Lancet".into())));
    assert!(labels("mal").contains(&("tag".into(), "malaria".into())));
    assert!(labels("chap").contains(&("collection".into(), "Thesis chapters".into())));
    assert!(labels("to r").contains(&("property".into(), "To read".into())));
    assert_eq!(labels("2019"), vec![("year".to_string(), "2019".to_string())]);
    assert!(labels("m").is_empty(), "one letter suggests nothing");

    // Each filter narrows the list; several must all match; search respects them too.
    let count = |filters: Vec<Filter>| store.list_sources(&ListQuery { filters, ..Default::default() }).unwrap().total;
    let f = |field: &str, op: &str, value: &str| Filter { field: field.into(), op: Some(op.into()), value: value.into(), key: None };
    assert_eq!(count(vec![f("creator", "is", "mohamed ali")]), 1);
    assert_eq!(count(vec![f("creator", "contains", "moham")]), 2);
    assert_eq!(count(vec![f("container", "contains", "lancet")]), 1);
    assert_eq!(count(vec![f("tag", "is", "COVID")]), 1);
    assert_eq!(count(vec![f("collection", "is", &thesis.id)]), 1);
    assert_eq!(count(vec![f("year", "is", "2019")]), 1);
    assert_eq!(count(vec![f("fulltext", "contains", "transmission")]), 1);
    assert_eq!(count(vec![Filter { field: "property".into(), op: Some("is".into()), value: "to read".into(), key: Some("Status".into()) }]), 1);
    assert_eq!(count(vec![f("creator", "contains", "moham"), f("year", "is", "2022")]), 1);
    let found = store
        .search(&SearchQuery { text: "nets".into(), filter: ListQuery { filters: vec![f("year", "is", "2022")], ..Default::default() }, ..Default::default() }, Some(&unit(0)))
        .unwrap();
    assert!(found.hits.iter().all(|h| h.source_id == a.id));
    // Suggestion counts follow the current view.
    let in_view = store.suggest("moh", &ListQuery { filters: vec![f("year", "is", "2019")], ..Default::default() }, 6).unwrap();
    assert_eq!(in_view.iter().filter(|s| s.filter.field == "creator").map(|s| s.label.as_str()).collect::<Vec<_>>(), vec!["Sara Mohamedi"]);
}

#[test]
fn analysis_keeps_references_with_their_place_and_links_cited_works() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let citing = store.insert_source(input(json!({"kind": "pdf", "title": "Health versus income", "filePath": "/tmp/a.pdf"}))).unwrap();
    let cited = store.insert_source(input(json!({"kind": "pdf", "title": "Income and health over the life course", "doi": "10.1/Cited"}))).unwrap();
    store
        .replace_chunks(&citing.id, &[ChunkInput { page: Some(2), text: "Health and income".into(), kind: Some("paragraph".into()), section: Some("1 Introduction".into()), ..Default::default() }])
        .unwrap();
    store.set_analysis(&citing.id, "layout-onnx", Some("# Health versus income\n\nHealth and income"), true).unwrap();
    assert_eq!(store.next_reference_job(&[], 0).unwrap(), Some(citing.id.clone()));
    store
        .replace_references(
            &citing.id,
            &[
                ReferenceInput { number: Some(1), page: Some(9), rects: vec![[1, 2, 3, 4]], text: "Someone (2020) Income and health.".into(), metadata: None },
                ReferenceInput { number: Some(2), page: Some(9), rects: vec![], text: "Nobody (2019) Unknown.".into(), metadata: None },
            ],
        )
        .unwrap();
    let matched = store.resolve_reference(&citing.id, 0, Some(&json!({"title": "Something else", "doi": "10.1/cited"})), None).unwrap();
    assert_eq!(matched.as_deref(), Some(cited.id.as_str()), "matched by DOI, case-insensitively");
    store.resolve_reference(&citing.id, 1, None, Some("Not found")).unwrap();
    store.set_references_status(&citing.id, "done", None, 2, 2).unwrap();

    let analysis = store.analysis(&citing.id).unwrap().unwrap();
    assert_eq!((analysis.engine.as_str(), analysis.references_status.as_str(), analysis.references_matched), ("layout-onnx", "done", 1));
    assert!(analysis.has_markdown);
    let references = store.references(&citing.id).unwrap();
    assert_eq!(references[0].rects, vec![[1, 2, 3, 4]]);
    assert_eq!(references[1].error.as_deref(), Some("Not found"));
    assert_eq!(store.next_reference_job(&[], 0).unwrap(), None);
    assert_eq!(store.outdated_analyses("layout-onnx").unwrap(), 0, "a PDF without a file is not counted");

    // In-text citations are found with the references; a newer analyser finds them again.
    assert_eq!(store.next_reference_job(&[], 1).unwrap(), Some(citing.id.clone()), "no citations stored yet");
    store
        .replace_citations(
            &citing.id,
            1,
            true,
            Some(&json!({"bracketCitations": 1})),
            &[CitationInput { page: 2, start: 10, end: 14, rect: [5, 6, 7, 8], text: "[1, 2]".into(), numbers: vec![1, 2] }],
        )
        .unwrap();
    assert_eq!(store.next_reference_job(&[], 1).unwrap(), None);
    assert_eq!(store.next_reference_job(&[], 2).unwrap(), Some(citing.id.clone()));
    let citations = store.citations(&citing.id).unwrap();
    assert_eq!((citations[0].text.as_str(), citations[0].numbers.clone(), citations[0].rect), ("[1, 2]", vec![1, 2], [5, 6, 7, 8]));
    let analysis = store.analysis(&citing.id).unwrap().unwrap();
    assert_eq!((analysis.citations_version, analysis.scientific), (Some(1), Some(true)));

    // Running it again starts from scratch.
    store.reanalyze(&citing.id).unwrap();
    assert!(store.analysis(&citing.id).unwrap().is_none());
    assert!(store.references(&citing.id).unwrap().is_empty());
    assert!(store.citations(&citing.id).unwrap().is_empty());
    assert_eq!(store.source(&citing.id).unwrap().unwrap().index_status, "pending");
    assert_eq!(store.outdated_analyses("layout-onnx").unwrap(), 1);
}
