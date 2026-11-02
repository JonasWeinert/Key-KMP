// Import and sync against a small zotero.sqlite with the tables Key reads.
use super::*;
use key_store::Store;
use rusqlite::Connection;
use serde_json::json;

const SCHEMA: &str = "
CREATE TABLE itemTypes(itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items(itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT DEFAULT '2024-01-02 03:04:05', dateModified TEXT, libraryID INT DEFAULT 1, key TEXT);
CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT UNIQUE);
CREATE TABLE itemData(itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID));
CREATE TABLE creators(creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
CREATE TABLE creatorTypes(creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators(itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE tags(tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE itemTags(itemID INT, tagID INT);
CREATE TABLE collections(collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, key TEXT);
CREATE TABLE deletedCollections(collectionID INTEGER PRIMARY KEY);
CREATE TABLE collectionItems(collectionID INT, itemID INT, orderIndex INT DEFAULT 0);
CREATE TABLE itemAttachments(itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, path TEXT);
CREATE TABLE itemNotes(itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE TABLE itemAnnotations(itemID INTEGER PRIMARY KEY, parentItemID INT, type INT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT, position TEXT);
CREATE TABLE deletedItems(itemID INTEGER PRIMARY KEY);
INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'book'), (3, 'report'), (14, 'attachment'), (26, 'note'), (40, 'annotation');
INSERT INTO fields VALUES (1, 'title'), (2, 'publicationTitle'), (3, 'date'), (4, 'libraryCatalog');
INSERT INTO creatorTypes VALUES (1, 'author');
INSERT INTO collections VALUES (1, 'Thesis', NULL, 'COLLAAAA'), (2, 'Chapter', 1, 'COLLBBBB'), (3, 'Other', NULL, 'COLLCCCC');
INSERT INTO items(itemID, itemTypeID, key) VALUES
  (1, 1, 'ITEMAAAA'), (2, 14, 'ATTAAAAA'), (3, 26, 'NOTEAAAA'), (4, 40, 'ANNOAAAA'),
  (5, 2, 'ITEMBBBB'), (6, 3, 'ITEMCCCC'), (7, 26, 'NOTEBBBB');
INSERT INTO creators VALUES (1, 'Marco', 'Palma', 0);
INSERT INTO itemCreators VALUES (1, 1, 1, 0);
INSERT INTO collectionItems(collectionID, itemID) VALUES (2, 1), (3, 5);
INSERT INTO itemAttachments VALUES (2, 1, 0, 'application/pdf', 'storage:paper.pdf');
INSERT INTO itemNotes VALUES (3, 1, '<div class=\"zotero-note znv1\"><p><strong>Bold</strong> idea</p></div>', 'Bold idea'),
  (7, NULL, '<p>A loose thought</p>', 'A loose thought');
INSERT INTO itemAnnotations VALUES (4, 2, 1, 'A highlighted sentence', 'Worth citing', '#2ea8e5', '3', '00002|000100|00200', '{\"pageIndex\":2,\"rects\":[[1,2,3,4]]}');
";

struct Zotero {
    dir: tempfile::TempDir,
    db: Connection,
}

impl Zotero {
    fn new() -> Zotero {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("zotero.sqlite")).unwrap();
        db.execute_batch(SCHEMA).unwrap();
        let zotero = Zotero { dir, db };
        zotero.field(1, "title", "Health versus income");
        zotero.field(1, "libraryCatalog", "ScienceDirect");
        zotero.field(5, "title", "A Book");
        zotero.field(6, "title", "Report");
        zotero.tag(1, "covid");
        zotero.tag(5, "x");
        let storage = zotero.dir.path().join("storage/ATTAAAAA");
        std::fs::create_dir_all(&storage).unwrap();
        std::fs::write(storage.join("paper.pdf"), b"%PDF-1.4").unwrap();
        zotero
    }
    fn sql(&self, sql: &str) {
        self.db.execute_batch(sql).unwrap();
    }
    fn field(&self, item: i64, name: &str, value: &str) {
        self.db.execute("INSERT OR IGNORE INTO itemDataValues(value) VALUES (?)", [value]).unwrap();
        self.db
            .execute(
                "INSERT OR REPLACE INTO itemData VALUES (?1, (SELECT fieldID FROM fields WHERE fieldName = ?2), (SELECT valueID FROM itemDataValues WHERE value = ?3))",
                rusqlite::params![item, name, value],
            )
            .unwrap();
    }
    fn tag(&self, item: i64, name: &str) {
        self.db.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", [name]).unwrap();
        self.db.execute("INSERT INTO itemTags VALUES (?1, (SELECT tagID FROM tags WHERE name = ?2))", rusqlite::params![item, name]).unwrap();
    }
    fn options(&self) -> ImportOptions {
        ImportOptions { data_dir: Some(self.dir.path().to_path_buf()), ..Default::default() }
    }
}

fn by_key(store: &Store, key: &str) -> key_store::Source {
    let index = store.origin_index(ORIGIN).unwrap();
    store.source(&index[key].0).unwrap().unwrap()
}

fn collection(store: &Store, name: &str) -> Option<key_store::Collection> {
    store.collections().unwrap().into_iter().find(|c| c.name == name)
}

#[test]
fn imports_then_syncs_changes_from_zotero_keeping_edits_made_in_key() {
    let zotero = Zotero::new();
    let library = tempfile::tempdir().unwrap();
    let store = Store::open(library.path()).unwrap();

    let preview = preview(&zotero.options()).unwrap();
    assert_eq!(preview.collections.len(), 3);
    let thesis = preview.collections.iter().find(|c| c.name == "Thesis").unwrap();
    assert_eq!((thesis.items, thesis.total), (0, 1));
    assert_eq!((preview.library.items, preview.library.files, preview.library.notes, preview.library.annotations), (3, 1, 1, 1));
    assert_eq!(preview.unfiled, 1);
    let only_other = preview_of(&zotero, &["COLLCCCC"]);
    assert_eq!((only_other.items, only_other.files), (1, 0));

    let report = import(&store, &zotero.options()).unwrap();
    assert_eq!((report.added, report.collections, report.linked_files), (3, 3, 1));
    assert_eq!(report.notes, 3, "the child note, the standalone note and the annotations note");
    let article = by_key(&store, "ITEMAAAA");
    assert_eq!(article.kind, "pdf");
    assert_eq!(article.collections, vec![collection(&store, "Chapter").unwrap().id]);
    assert_eq!(collection(&store, "Chapter").unwrap().parent_id, Some(collection(&store, "Thesis").unwrap().id));
    let notes = store.notes(&article.id).unwrap();
    let child = notes.iter().find(|n| n.origin_key.as_deref() == Some("zotero:NOTEAAAA")).unwrap();
    assert_eq!(child.body, "**Bold** idea");
    let highlights = notes.iter().find(|n| n.title == "Zotero annotations").unwrap();
    assert_eq!(highlights.body, format!("```quote source=\"{}\" page=\"2\" color=\"blue\"\nA highlighted sentence\n```\n\nWorth citing", article.id));
    assert_eq!(store.standalone_notes().unwrap()[0].body, "A loose thought");

    // Edits in Key.
    let mut patch = serde_json::Map::new();
    patch.insert("title".into(), json!("My title"));
    patch.insert("properties".into(), json!({"Status": "read"}));
    store.update_source(&article.id, &patch).unwrap();
    store.save_note(Some(&child.id), Some(&article.id), "Bold idea", "**Bold** idea, and my thoughts", None).unwrap();
    let book = by_key(&store, "ITEMBBBB");
    store.set_tags(&book.id, &["x".into(), "mine".into()]).unwrap();

    // Changes in Zotero.
    zotero.field(1, "title", "Health vs income");
    zotero.field(1, "publicationTitle", "Social Science & Medicine");
    zotero.field(5, "title", "A Better Book");
    zotero.sql("DELETE FROM itemTags WHERE itemID = 5;");
    zotero.tag(5, "y");
    zotero.sql(
        "UPDATE itemNotes SET note = '<p><strong>Bold</strong> idea, revised</p>' WHERE itemID = 3;
         UPDATE collectionItems SET collectionID = 1 WHERE itemID = 5;
         UPDATE collections SET collectionName = 'Misc' WHERE collectionID = 3;
         INSERT INTO deletedCollections VALUES (2); DELETE FROM collectionItems WHERE collectionID = 2;
         INSERT INTO deletedItems VALUES (6);
         DELETE FROM itemNotes WHERE itemID = 7; DELETE FROM items WHERE itemID = 7;",
    );

    let report = run(&store, &zotero.options(), Mode::Sync, &|_| {}).unwrap();
    let article = by_key(&store, "ITEMAAAA");
    assert_eq!(article.title(), "My title", "Key's title edit is kept");
    assert!(report.conflicts.iter().any(|c| c.what == "title" && c.detail.contains("Health vs income")), "{:?}", report.conflicts);
    assert_eq!(article.field("containerTitle"), Some("Social Science & Medicine"));
    assert_eq!(article.properties["Status"], "read");
    assert_eq!(article.properties["Library catalog"], "ScienceDirect");
    assert!(article.collections.is_empty());
    assert!(collection(&store, "Chapter").is_none(), "an emptied collection deleted in Zotero goes");
    assert_eq!(report.collections_deleted, 1);

    let book = by_key(&store, "ITEMBBBB");
    assert_eq!(book.title(), "A Better Book");
    let mut tags = book.tags.clone();
    tags.sort();
    assert_eq!(tags, vec!["mine", "y"]);
    assert_eq!(book.collections, vec![collection(&store, "Thesis").unwrap().id]);
    assert!(collection(&store, "Misc").is_some());

    assert!(by_key(&store, "ITEMCCCC").trashed_at.is_some());
    assert_eq!(report.trashed, 1);

    let notes = store.notes(&article.id).unwrap();
    assert_eq!(notes.iter().find(|n| n.id == child.id).unwrap().body, "**Bold** idea, and my thoughts");
    let theirs = notes.iter().find(|n| n.title == "Bold idea (Zotero version)").unwrap();
    assert_eq!(theirs.body, "**Bold** idea, revised");
    assert!(store.standalone_notes().unwrap().is_empty(), "an unedited note deleted in Zotero goes");
    assert_eq!(report.notes_deleted, 1);

    // Back from Zotero's trash.
    zotero.sql("DELETE FROM deletedItems WHERE itemID = 6;");
    let report = run(&store, &zotero.options(), Mode::Sync, &|_| {}).unwrap();
    assert_eq!(report.restored, 1);
    assert!(by_key(&store, "ITEMCCCC").trashed_at.is_none());

    // Nothing changed: nothing is written and nothing conflicts.
    let report = run(&store, &zotero.options(), Mode::Sync, &|_| {}).unwrap();
    assert_eq!((report.updated, report.added, report.notes, report.notes_updated, report.conflict_count), (0, 0, 0, 0, 0), "{report:?}");
    assert_eq!(report.unchanged, 3);

    // Deleted in Key: not brought back.
    store.delete(&[by_key(&store, "ITEMCCCC").id]).unwrap();
    zotero.field(6, "title", "Report, second edition");
    let report = import(&store, &zotero.options()).unwrap();
    assert_eq!(report.kept_deleted, 1);
    assert!(!store.origin_index(ORIGIN).unwrap().contains_key("ITEMCCCC"));
}

fn preview_of(zotero: &Zotero, keys: &[&str]) -> Counts {
    let options = ImportOptions { collection_keys: Some(keys.iter().map(|k| k.to_string()).collect()), ..zotero.options() };
    preview(&options).unwrap().selected
}

#[test]
fn chosen_collections_and_options_limit_the_import() {
    let zotero = Zotero::new();
    let library = tempfile::tempdir().unwrap();
    let store = Store::open(library.path()).unwrap();
    let options = ImportOptions {
        collection_keys: Some(vec!["COLLBBBB".into()]),
        attachments: false,
        annotations: false,
        mirror_collections: false,
        ..zotero.options()
    };
    let report = import(&store, &options).unwrap();
    assert_eq!((report.added, report.skipped, report.collections, report.linked_files), (1, 2, 0, 0));
    let article = by_key(&store, "ITEMAAAA");
    assert_eq!(article.kind, "reference");
    assert!(article.file_path().is_none());
    let notes = store.notes(&article.id).unwrap();
    assert_eq!(notes.len(), 1, "notes but no annotations");
    assert!(store.standalone_notes().unwrap().is_empty(), "the standalone note is in no chosen collection");
}

#[test]
fn notes_from_the_first_importer_become_markdown_unless_edited() {
    let zotero = Zotero::new();
    let library = tempfile::tempdir().unwrap();
    let store = Store::open(library.path()).unwrap();
    // What the first importer left: sources written in one batch, notes as plain text.
    let input = |key: &str, kind: &str, item_type: &str, title: &str| SourceInput {
        kind: kind.into(),
        origin: Some(ORIGIN.into()),
        origin_key: Some(key.into()),
        fields: [("title".to_string(), json!(title)), ("itemType".to_string(), json!(item_type))].into_iter().collect(),
        ..Default::default()
    };
    let ids = store
        .insert_sources(vec![
            input("ITEMAAAA", "pdf", "article", "Health versus income"),
            input("ITEMBBBB", "reference", "book", "Old book title"),
            input("ITEMCCCC", "reference", "report", "Report"),
        ])
        .unwrap();
    store.save_note(None, Some(&ids[0]), "Bold idea", "Bold idea", Some("zotero:NOTEAAAA")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let mut patch = serde_json::Map::new();
    patch.insert("title".into(), json!("Edited in Key"));
    store.update_source(&ids[2], &patch).unwrap();
    zotero.field(6, "title", "Report, revised");

    let report = import(&store, &zotero.options()).unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(store.notes(&ids[0]).unwrap()[0].body, "**Bold** idea", "the unedited plain-text note is converted");
    assert_eq!(by_key(&store, "ITEMBBBB").title(), "A Book", "an unedited source takes Zotero's values");
    assert_eq!(by_key(&store, "ITEMCCCC").title(), "Edited in Key", "an edited one keeps Key's");
    assert_eq!(report.conflict_count, 1, "{:?}", report.conflicts);
}

/// Imports a real library twice into a throwaway store: `KEY_ZOTERO_DIR=… cargo test --release -- --ignored real_library`.
#[test]
#[ignore]
fn real_library() {
    let Some(dir) = std::env::var_os("KEY_ZOTERO_DIR") else { return };
    let library = tempfile::tempdir().unwrap();
    let store = Store::open(library.path()).unwrap();
    let options = ImportOptions { data_dir: Some(dir.into()), ..Default::default() };
    let started = std::time::Instant::now();
    let preview = preview(&options).unwrap();
    println!("preview {:?} {:?} in {:?}", preview.library, preview.selected, started.elapsed());
    let started = std::time::Instant::now();
    let report = import(&store, &options).unwrap();
    println!("import in {:?}: {}", started.elapsed(), serde_json::to_string(&ImportReport { conflicts: vec![], ..report }).unwrap());
    let started = std::time::Instant::now();
    let report = run(&store, &options, Mode::Sync, &|_| {}).unwrap();
    println!("sync in {:?}: {}", started.elapsed(), serde_json::to_string(&report).unwrap());
    if let Some(out) = std::env::var_os("KEY_ZOTERO_NOTES_OUT") {
        let notes: Vec<String> = store.origin_index(ORIGIN).unwrap().values().flat_map(|(id, _)| store.notes(id).unwrap()).map(|n| format!("=== {}\n{}", n.title, n.body)).collect();
        std::fs::write(out, notes.join("\n\n")).unwrap();
    }
}
