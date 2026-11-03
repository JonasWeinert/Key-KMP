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
fn note_passages_keep_unchanged_vectors_and_show_in_search() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let source = store.insert_source(input(json!({"kind": "reference", "title": "Nets"}))).unwrap();
    let chunk = |text: &str| ChunkInput { text: text.into(), kind: Some("paragraph".into()), ..Default::default() };
    let attached = store.save_note(None, Some(&source.id), "", "…", None).unwrap();
    let standalone = store.save_note(None, None, "Ideas", "…", None).unwrap();
    assert_eq!(store.stale_notes(10).unwrap().len(), 2);
    store.replace_note_chunks(&attached.id, attached.updated_at, &[chunk("Larval habitats shrank near rivers."), chunk("Bed nets cut transmission.")]).unwrap();
    store.replace_note_chunks(&standalone.id, standalone.updated_at, &[chunk("Chapter plan for malaria work.")]).unwrap();
    assert!(store.stale_notes(10).unwrap().is_empty());
    // An outdated version never overwrites newer passages.
    store.replace_note_chunks(&standalone.id, standalone.updated_at - 1, &[chunk("Old text.")]).unwrap();

    // Vectors wait until a note has been left alone; then each passage gets its note's title, or its source's.
    assert!(store.chunks_without_vectors(10).unwrap().is_empty());
    let settle = |store: &Store| store.db().unwrap().execute("UPDATE notes SET updated_at = updated_at - 60000, indexed_at = indexed_at - 60000", []).unwrap();
    settle(&store);
    let waiting = store.chunks_without_vectors(10).unwrap();
    let titles: Vec<(&str, &str)> = waiting.iter().map(|(_, title, text)| (title.as_str(), text.as_str())).collect();
    assert_eq!(titles, vec![("Nets", "Larval habitats shrank near rivers."), ("Nets", "Bed nets cut transmission."), ("Ideas", "Chapter plan for malaria work.")]);
    store.set_chunk_vectors(&waiting.iter().enumerate().map(|(i, (id, _, _))| (*id, unit(i))).collect::<Vec<_>>()).unwrap();

    // An edit re-embeds only the passage that changed.
    let edited = store.save_note(Some(&attached.id), None, "", "…", None).unwrap();
    store.replace_note_chunks(&edited.id, edited.updated_at, &[chunk("Larval habitats shrank near rivers."), chunk("Bed nets cut transmission sharply.")]).unwrap();
    settle(&store);
    let waiting = store.chunks_without_vectors(10).unwrap();
    assert_eq!(waiting.iter().map(|(_, _, text)| text.as_str()).collect::<Vec<_>>(), vec!["Bed nets cut transmission sharply."]);
    assert_eq!(store.vector_count().unwrap(), 2);

    // A source's note passages show under the source; standalone notes beside the sources.
    let search = |text: &str, filter: ListQuery| store.search(&SearchQuery { text: text.into(), filter, ..Default::default() }, None).unwrap();
    let found = search("larval", ListQuery::default());
    assert_eq!(found.hits[0].source_id, source.id);
    assert_eq!(found.hits[0].passages[0].note_id.as_deref(), Some(attached.id.as_str()));
    assert!(found.hits[0].fields.iter().all(|f| f.field != "notes"));
    let found = search("malaria", ListQuery::default());
    assert_eq!((found.notes[0].note_id.as_str(), found.notes[0].title.as_str()), (standalone.id.as_str(), "Ideas"));
    assert!(search("malaria", ListQuery { kind: Some("pdf".into()), ..Default::default() }).notes.is_empty());

    // Deleting a note takes its passages and vectors with it.
    store.delete_note(&attached.id).unwrap();
    assert!(search("larval", ListQuery::default()).hits.is_empty());
    assert_eq!(store.vector_count().unwrap(), 1);
    assert_eq!(store.db().unwrap().query_row("SELECT count(*) FROM chunk_vectors", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
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

#[test]
fn finds_imported_sources_and_notes_by_origin_and_moves_notes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let ids = store
        .insert_sources(vec![
            input(json!({"kind": "reference", "title": "One", "origin": "zotero", "originKey": "AAAA1111"})),
            input(json!({"kind": "reference", "title": "Two", "origin": "zotero", "originKey": "BBBB2222"})),
            input(json!({"kind": "reference", "title": "Mine"})),
        ])
        .unwrap();
    let index = store.origin_index("zotero").unwrap();
    assert_eq!(index.len(), 2);
    assert_eq!(index["AAAA1111"].0, ids[0]);

    let note = store.save_note(None, Some(&ids[0]), "", "Walked **far**", Some("zotero:NOTE0001")).unwrap();
    assert_eq!(store.note_by_origin("zotero:NOTE0001").unwrap().unwrap().id, note.id);
    assert!(store.note_by_origin("zotero:NOPE").unwrap().is_none());
    store.set_note_source(&note.id, Some(&ids[1])).unwrap();
    assert!(store.notes(&ids[0]).unwrap().is_empty());
    assert_eq!(store.notes(&ids[1]).unwrap()[0].body, "Walked **far**");
    // Note text is searchable under the source it moved to.
    let page = store.list_sources(&ListQuery { text: Some("walked".into()), ..Default::default() }).unwrap();
    assert_eq!(page.items.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), vec![ids[1].clone()]);
    store.set_note_source(&note.id, None).unwrap();
    assert_eq!(store.standalone_notes().unwrap().len(), 1);
}

#[test]
fn sorts_by_several_levels_and_reorders_nested_collections() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for (title, year) in [("Beta", 2020), ("Alpha", 2020), ("Gamma", 2019)] {
        store.insert_source(input(json!({"kind": "reference", "title": title, "year": year}))).unwrap();
    }
    let page = store
        .list_sources(&ListQuery {
            sorts: vec![SortKey { field: "year".into(), descending: true }, SortKey { field: "title".into(), descending: false }],
            ..Default::default()
        })
        .unwrap();
    let titles: Vec<_> = page.items.iter().map(|s| s.title().to_string()).collect();
    assert_eq!(titles, ["Alpha", "Beta", "Gamma"]);
    for (title, rank) in [("Alpha", 2), ("Gamma", 1)] {
        let id = page.items.iter().find(|s| s.title() == title).unwrap().id.clone();
        store.update_source(&id, json!({"properties": {"Rank": rank}}).as_object().unwrap()).unwrap();
    }
    let page = store
        .list_sources(&ListQuery { sorts: vec![SortKey { field: "property:Rank".into(), descending: false }], ..Default::default() })
        .unwrap();
    let titles: Vec<_> = page.items.iter().map(|s| s.title().to_string()).collect();
    assert_eq!(titles, ["Gamma", "Alpha", "Beta"]);

    let a = store.create_collection("A", None, None).unwrap();
    let b = store.create_collection("B", None, None).unwrap();
    let c = store.create_collection("C", Some(&a.id), None).unwrap();
    // A collection cannot move into its own descendant.
    assert!(store.update_collection(&a.id, None, Some(Some(&c.id))).is_err());
    store.reorder_collections(None, &[b.id.clone(), c.id.clone()]).unwrap();
    let all = store.collections().unwrap();
    let top: Vec<_> = all.iter().filter(|x| x.parent_id.is_none()).map(|x| x.name.as_str()).collect();
    assert_eq!(top, ["B", "C", "A"]);
}

fn link(from: ItemRef, to: ItemRef, label: &str) -> LinkInput {
    LinkInput { from, to, label: Some(label.into()), context: Some(format!("about {label}")) }
}

#[test]
fn backlinks_follow_renames_and_survive_deletes_as_broken() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let paper = store.insert_source(input(json!({"kind": "pdf", "title": "Health versus income"}))).unwrap();
    let plan = store.save_note(None, None, "Plan", "", None).unwrap();
    let draft = store.save_note(None, None, "", "Draft first line\n\nmore", None).unwrap();
    store.apply_annotations(&paper.id, &[json!({"id": "h1", "text": "Income  and health", "color": "green", "anchor": {"pages": [{"page": 3}]}})], &[]).unwrap();
    let from = ItemRef::new("note", &draft.id, None);
    store
        .replace_note_links(
            &draft.id,
            draft.updated_at,
            &[
                link(from.clone(), ItemRef::new("source", &paper.id, None), "Palma"),
                link(from.clone(), ItemRef::new("source", &paper.id, Some("highlight:h1")), "quote"),
                link(from.clone(), ItemRef::new("note", &plan.id, None), "the plan"),
            ],
        )
        .unwrap();

    let links = store.item_links("note", &plan.id).unwrap();
    assert_eq!(links.backlinks.len(), 1);
    assert_eq!(links.backlinks[0].from.title, "Draft first line");
    assert_eq!(links.backlinks[0].context.as_deref(), Some("about the plan"));
    let out = store.item_links("note", &draft.id).unwrap().outgoing;
    assert_eq!(out.iter().map(|l| l.to.title.as_str()).collect::<Vec<_>>(), vec!["Health versus income", "Health versus income", "Plan"]);
    assert_eq!(out[1].to.anchor_label.as_deref(), Some("Income and health"));
    assert!(out.iter().all(|l| !l.broken));

    // Renames show at once: titles are read by id.
    store.save_note(Some(&plan.id), None, "Research plan", "", None).unwrap();
    let mut patch = Map::new();
    patch.insert("title".into(), json!("Health vs income"));
    store.update_source(&paper.id, &patch).unwrap();
    let out = store.item_links("note", &draft.id).unwrap().outgoing;
    assert_eq!(out[0].to.title, "Health vs income");
    assert_eq!(out[2].to.title, "Research plan");

    // A deleted highlight breaks the link to it; bringing it back mends it.
    store.apply_annotations(&paper.id, &[], &["h1".into()]).unwrap();
    assert!(store.item_links("note", &draft.id).unwrap().outgoing[1].broken);
    store.apply_annotations(&paper.id, &[json!({"id": "h1", "text": "Income and health"})], &[]).unwrap();
    assert!(!store.item_links("note", &draft.id).unwrap().outgoing[1].broken);

    // Deleting the target keeps the link, broken, under the label it was written with.
    store.delete_note(&plan.id).unwrap();
    let out = store.item_links("note", &draft.id).unwrap().outgoing;
    assert!(out[2].broken && !out[2].to.exists);
    assert_eq!(out[2].to.title, "the plan");

    // Deleting the linking note removes what it wrote.
    assert_eq!(store.item_links("source", &paper.id).unwrap().backlinks.len(), 2);
    store.delete_note(&draft.id).unwrap();
    assert!(store.item_links("source", &paper.id).unwrap().backlinks.is_empty());
}

#[test]
fn a_newer_save_wins_and_a_sources_own_notes_are_not_backlinks() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let paper = store.insert_source(input(json!({"kind": "pdf", "title": "Paper"}))).unwrap();
    let own = store.save_note(None, Some(&paper.id), "", "quote", None).unwrap();
    let to_paper = |note: &str| vec![link(ItemRef::new("note", note, None), ItemRef::new("source", &paper.id, Some("page:2")), "p")];
    store.replace_note_links(&own.id, own.updated_at, &to_paper(&own.id)).unwrap();
    assert!(store.item_links("source", &paper.id).unwrap().backlinks.is_empty());
    assert_eq!(store.item_links("note", &own.id).unwrap().outgoing[0].to.anchor_label.as_deref(), Some("p. 3"));
    // A stale version (saved before the current one) writes nothing.
    store.replace_note_links(&own.id, own.updated_at - 1, &[]).unwrap();
    assert_eq!(store.item_links("note", &own.id).unwrap().outgoing.len(), 1);

    // Deleting the source takes its notes and their links with it; links to it break.
    let other = store.save_note(None, None, "Other", "", None).unwrap();
    store.replace_note_links(&other.id, other.updated_at, &to_paper(&other.id)).unwrap();
    store.delete(&[paper.id.clone()]).unwrap();
    let out = store.item_links("note", &other.id).unwrap().outgoing;
    assert!(out[0].broken);
    assert!(store.item_links("note", &own.id).unwrap().outgoing.is_empty());
}

#[test]
fn canvases_link_their_cards_and_connectors() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let paper = store.insert_source(input(json!({"kind": "pdf", "title": "Paper"}))).unwrap();
    let note = store.save_note(None, None, "Idea", "", None).unwrap();
    let doc = json!({
        "nodes": [
            {"id": "a", "type": "item", "ref": {"kind": "source", "id": paper.id}, "title": "Paper"},
            {"id": "b", "type": "item", "ref": {"kind": "note", "id": note.id}},
            {"id": "t", "type": "text", "text": "free text"}
        ],
        "edges": [
            {"id": "e1", "from": {"node": "a"}, "to": {"node": "b"}, "label": "supports"},
            {"id": "e2", "from": {"node": "t"}, "to": {"node": "b"}}
        ]
    });
    let canvas = store.save_canvas(None, Some("Board"), Some(&doc)).unwrap();
    assert_eq!(store.canvases().unwrap()[0].title, "Board");
    assert_eq!(store.canvas(&canvas.id).unwrap().unwrap().doc["nodes"][2]["text"], json!("free text"));

    let back = store.item_links("note", &note.id).unwrap().backlinks;
    let mut seen: Vec<(String, Option<String>)> = back.iter().map(|l| (l.from.title.clone(), l.via.as_ref().map(|v| v.title.clone()))).collect();
    seen.sort();
    assert_eq!(seen, vec![("Board".into(), None), ("Paper".into(), Some("Board".into()))]);
    assert_eq!(back.iter().find(|l| l.via.is_some()).unwrap().context.as_deref(), Some("supports"));
    assert_eq!(back.iter().find(|l| l.via.is_none()).unwrap().from.anchor.as_deref(), Some("node:b"));

    // Renaming keeps the doc; removing the connector removes its link.
    store.save_canvas(Some(&canvas.id), Some("Board 2"), None).unwrap();
    assert_eq!(store.item_links("note", &note.id).unwrap().backlinks.len(), 2);
    let mut doc = doc;
    doc["edges"] = json!([]);
    store.save_canvas(Some(&canvas.id), None, Some(&doc)).unwrap();
    let back = store.item_links("note", &note.id).unwrap().backlinks;
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].from.title, "Board 2");

    // A note linking to the canvas sees it broken once the canvas is deleted, mended if it returns.
    store.replace_note_links(&note.id, note.updated_at, &[link(ItemRef::new("note", &note.id, None), ItemRef::new("canvas", &canvas.id, None), "board")]).unwrap();
    store.delete_canvas(&canvas.id).unwrap();
    assert!(store.item_links("note", &note.id).unwrap().backlinks.is_empty());
    assert!(store.item_links("note", &note.id).unwrap().outgoing[0].broken);
    store.save_canvas(Some(&canvas.id), Some("Board 2"), Some(&doc)).unwrap();
    assert!(!store.item_links("note", &note.id).unwrap().outgoing[0].broken);
}

#[test]
fn the_link_picker_finds_every_kind() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let paper = store.insert_source(input(json!({"kind": "pdf", "title": "Growth paper"}))).unwrap();
    store.save_note(None, None, "Growth ideas", "", None).unwrap();
    store.save_canvas(None, Some("Growth board"), None).unwrap();
    store.apply_annotations(&paper.id, &[json!({"id": "h9", "text": "growth slows", "color": "blue", "anchor": {"pages": [{"page": 1}]}})], &[]).unwrap();
    let found = store.link_targets("growth", &[], 10).unwrap();
    let kinds: Vec<(&str, Option<&str>)> = found.iter().map(|t| (t.item.kind.as_str(), t.item.anchor.as_deref())).collect();
    assert_eq!(kinds, vec![("note", None), ("source", None), ("canvas", None), ("source", Some("highlight:h9"))]);
    assert_eq!(found[3].context.as_deref(), Some("Growth paper"));
    assert_eq!(found[3].page, Some(1));
    assert_eq!(store.link_targets("growth", &["canvas".into()], 10).unwrap().len(), 1);
    // With no text, recent highlights come only when asked for.
    assert!(store.link_targets("", &[], 10).unwrap().iter().all(|t| t.item.anchor.is_none()));
    assert_eq!(store.link_targets("", &["highlight".into()], 10).unwrap().len(), 1);
}

#[test]
fn notes_and_sources_keep_page_fields_properties_and_appearance() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let note = store.save_note(None, None, "Plan", "Body", None).unwrap();
    assert!(note.fields.is_empty() && note.properties.is_empty() && note.appearance.is_empty());
    let patch = |value: Json| value.as_object().unwrap().clone();
    store
        .update_note_meta(&note.id, &patch(json!({
            "fields": {"creators": [{"family": "Ada"}], "year": 2024},
            "properties": {"Status": "Draft"},
            "appearance": {"icon": "🌿", "cover": {"kind": "gradient", "value": "sunset"}}
        })))
        .unwrap();
    // A text save leaves the page metadata alone, and a later patch merges into it.
    store.save_note(Some(&note.id), None, "Plan 2", "Body 2", None).unwrap();
    let updated = store.update_note_meta(&note.id, &patch(json!({"fields": {"year": null}, "properties": {"Score": 3}}))).unwrap();
    assert_eq!(updated.title, "Plan 2");
    assert_eq!(updated.fields, patch(json!({"creators": [{"family": "Ada"}]})));
    assert_eq!(updated.properties, patch(json!({"Status": "Draft", "Score": 3})));
    assert_eq!(store.note(&note.id).unwrap().unwrap().appearance["icon"], json!("🌿"));

    let source = store.insert_source(input(json!({"kind": "reference", "title": "Nets"}))).unwrap();
    let source = store.update_source(&source.id, &patch(json!({"appearance": {"icon": "📘"}}))).unwrap();
    assert_eq!(source.appearance["icon"], json!("📘"));
    let source = store.update_source(&source.id, &patch(json!({"appearance": {"cover": {"kind": "color", "value": "#f4d9b0"}}}))).unwrap();
    assert_eq!(source.appearance.len(), 2);
}
