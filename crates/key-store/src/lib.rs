// Workspace library database. One SQLite file holds sources (fixed bibliographic
// columns plus user JSON properties), collections, notes, annotations and the
// chunked text of documents and notes that full-text and vector search run over.
mod analysis;
mod filters;
mod graph;
mod linked;
mod links;
mod openalex;
mod properties;
mod search;
pub use analysis::{CitationInput, ReferenceInput, SourceAnalysis, SourceCitation, SourceReference};
pub use filters::{Filter, Suggestion};
pub use graph::{
    CitingSource, Grant, Institution, Keyword, MergeSuggestion, NamedCount, Person, PersonPage, Publisher, SourceGraph, SourcePerson, SourceTopic, Topic,
    TopicPage, TopicRef, Venue, VenuePage, WorkReference, name_key,
};
pub use openalex::{EnrichJob, abstract_text};
pub use properties::PropertyOption;
pub use linked::{LinkedDir, LinkedEntries, LinkedFile, LinkedFolder, MAX_PDF_BYTES, MAX_TEXT_BYTES, SyncReport, file_kind};
pub use links::{Canvas, CanvasSummary, ItemLinks, ItemRef, Link, LinkEnd, LinkInput, LinkTarget, canvas_links, note_title};
pub use search::{FileHit, NoteHit, SearchHit, SearchPassage, SearchQuery, SearchResult};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Once},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
pub const EMBEDDING_DIMENSIONS: usize = 768;
/// A note's new passages get their vectors once it has been left alone this long, so
/// typing does not re-embed a paragraph every few seconds. Keyword search is immediate.
pub const NOTE_SETTLE_MS: i64 = 30_000;
/// Passages without a vector that are ready for one (`?1`: notes edited before this time).
/// Sources still in the pipeline are embedded there instead.
const AWAITING_VECTOR: &str = "FROM chunks c
     LEFT JOIN sources s ON s.id = c.source_id
     LEFT JOIN notes n ON n.id = c.note_id
     LEFT JOIN sources ns ON ns.id = n.source_id
     LEFT JOIN linked_files lf ON lf.id = c.file_id
     WHERE c.embedded = 0 AND (s.index_status IN ('ready', 'no_text', 'missing') OR n.updated_at <= ?1 OR c.file_id IS NOT NULL)";
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/001_initial.sql"),
    include_str!("migrations/002_properties.sql"),
    include_str!("migrations/003_embedded.sql"),
    include_str!("migrations/004_analysis.sql"),
    include_str!("migrations/005_citations.sql"),
    include_str!("migrations/006_note_passages.sql"),
    include_str!("migrations/007_links_canvases.sql"),
    include_str!("migrations/008_pages.sql"),
    include_str!("migrations/009_linked_folders.sql"),
    include_str!("migrations/010_metadata_graph.sql"),
];
/// The migration after which existing sources are linked to the new people and venue tables.
const GRAPH_MIGRATION: usize = 10;

/// Bibliographic columns accepted by `SourceInput` and returned on `Source`, in the
/// order of the table. Kept in one list so inserts, patches and reads cannot drift.
const TEXT_FIELDS: &[(&str, &str)] = &[
    ("itemType", "item_type"),
    ("title", "title"),
    ("shortTitle", "short_title"),
    ("date", "date"),
    ("containerTitle", "container_title"),
    ("containerShort", "container_short"),
    ("volume", "volume"),
    ("issue", "issue"),
    ("pages", "pages"),
    ("edition", "edition"),
    ("series", "series"),
    ("publisher", "publisher"),
    ("place", "place"),
    ("institution", "institution"),
    ("genre", "genre"),
    ("doi", "doi"),
    ("isbn", "isbn"),
    ("issn", "issn"),
    ("pmid", "pmid"),
    ("pmcid", "pmcid"),
    ("arxivId", "arxiv_id"),
    ("url", "url"),
    ("accessed", "accessed"),
    ("abstract", "abstract"),
    ("language", "language"),
    ("rights", "rights"),
    ("citationKey", "citation_key"),
    ("extra", "extra"),
    ("readState", "read_state"),
    ("filePath", "file_path"),
    ("fileHash", "file_hash"),
    ("mime", "mime"),
    // From OpenAlex (see openalex.rs); `venueId` and `publisherId` link to their tables.
    ("openalexId", "openalex_id"),
    ("workType", "work_type"),
    ("oaStatus", "oa_status"),
    ("oaUrl", "oa_url"),
    ("enrichStatus", "enrich_status"),
    ("enrichError", "enrich_error"),
    ("venueId", "venue_id"),
    ("publisherId", "publisher_id"),
];
const NUMBER_FIELDS: &[(&str, &str)] = &[
    ("year", "year"),
    ("durationSeconds", "duration_seconds"),
    ("fileSize", "file_size"),
    ("pageCount", "page_count"),
    ("retracted", "retracted"),
    ("citedByCount", "cited_by_count"),
    ("fwci", "fwci"),
    ("metricsAt", "metrics_at"),
    ("enrichedAt", "enriched_at"),
];
/// Fields only the store writes: a patch naming them is ignored.
const DERIVED_FIELDS: &[&str] = &["venueId", "publisherId", "enrichStatus", "enrichError", "enrichedAt", "metricsAt"];
/// Identifiers a source can be looked up by; a new one queues the lookup.
const LOOKUP_FIELDS: &[&str] = &["doi", "pmid", "openalexId"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub given: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
    #[serde(default = "author_role")]
    pub role: String,
    /// The person this creator is (see graph.rs); filled when read, never stored in the JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
}
fn author_role() -> String {
    "author".into()
}
impl Creator {
    pub fn display(&self) -> String {
        match (&self.family, &self.given, &self.literal) {
            (_, _, Some(literal)) => literal.clone(),
            (Some(family), Some(given), _) => format!("{family}, {given}"),
            (Some(family), None, _) => family.clone(),
            (None, Some(given), _) => given.clone(),
            _ => String::new(),
        }
    }
}

/// A full source row. Bibliographic fields are flattened into `fields` so the
/// renderer receives one flat camelCase object.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub creators: Vec<Creator>,
    pub tags: Vec<String>,
    pub properties: Map<String, Json>,
    pub collections: Vec<String>,
    pub starred: bool,
    pub index_status: String,
    pub index_error: Option<String>,
    pub indexed_chunks: i64,
    pub index_total: i64,
    pub origin: Option<String>,
    pub origin_key: Option<String>,
    pub added_at: i64,
    pub updated_at: i64,
    pub trashed_at: Option<i64>,
    pub note_count: i64,
    pub annotation_count: i64,
    /// The page header: `icon`, `cover`.
    #[serde(default)]
    pub appearance: Map<String, Json>,
    #[serde(flatten)]
    pub fields: Map<String, Json>,
}
impl Source {
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).and_then(Json::as_str)
    }
    pub fn title(&self) -> &str {
        self.field("title").unwrap_or("")
    }
    pub fn file_path(&self) -> Option<PathBuf> {
        self.field("filePath").map(PathBuf::from)
    }
    pub fn file_hash(&self) -> Option<&str> {
        self.field("fileHash")
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub kind: String,
    #[serde(default)]
    pub creators: Vec<Creator>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub properties: Map<String, Json>,
    #[serde(default)]
    pub collections: Vec<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub origin_key: Option<String>,
    #[serde(default)]
    pub added_at: Option<i64>,
    #[serde(default)]
    pub index_status: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Json>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub collection_id: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub item_type: Option<String>,
    /// all | trashed | starred | unfiled | attention | indexing | ready | open
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// Matches title, creators, container, abstract, tags, notes and identifiers.
    #[serde(default)]
    pub text: Option<String>,
    /// Filters picked from search suggestions; all must match.
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub year_from: Option<i64>,
    #[serde(default)]
    pub year_to: Option<i64>,
    /// title | year | added | updated | creator | container
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub descending: bool,
    /// Sort levels, first one wins; replaces `sort`/`descending` when given.
    #[serde(default)]
    pub sorts: Vec<SortKey>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub field: String,
    #[serde(default)]
    pub descending: bool,
}

fn sort_expression(field: &str) -> String {
    // `property:<name>` sorts by a typed property; the name is quoted into a JSON path.
    if let Some(name) = field.strip_prefix("property:") {
        let name: String = name.chars().filter(|c| !matches!(c, '"' | '\\' | '\0')).collect::<String>().replace('\'', "''");
        return format!("json_extract(s.properties, '$.\"{name}\"')");
    }
    match field {
        "title" => "s.title COLLATE NOCASE",
        "year" => "s.year",
        "updated" => "s.updated_at",
        "creator" => "json_extract(s.creators, '$[0].family') COLLATE NOCASE",
        "container" => "s.container_title COLLATE NOCASE",
        "type" => "s.item_type",
        "citations" => "s.cited_by_count",
        "kind" => "s.kind",
        "pages" => "s.page_count",
        _ => "s.added_at",
    }
    .into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePage {
    pub items: Vec<Source>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub counts: Counts,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub all: i64,
    pub trashed: i64,
    pub starred: i64,
    pub unfiled: i64,
    pub ready: i64,
    pub indexing: i64,
    pub attention: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub source_count: i64,
    pub origin_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub source_id: Option<String>,
    pub title: String,
    pub body: String,
    pub origin_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Standard fields under a source's camelCase keys (`creators`, `year`, `url` ...).
    #[serde(default)]
    pub fields: Map<String, Json>,
    /// The user's own properties, as on a source.
    #[serde(default)]
    pub properties: Map<String, Json>,
    /// The page header: `icon`, `cover` (`{ kind: color|gradient|image, value }`).
    #[serde(default)]
    pub appearance: Map<String, Json>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    pub value: String,
    pub count: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub tags: Vec<Facet>,
    pub item_types: Vec<Facet>,
    pub kinds: Vec<Facet>,
    pub years: Vec<Facet>,
}

/// A chunk of extracted text. `embedding` is optional so text can be searchable
/// by keyword before the embedding model is available.
#[derive(Clone, Debug, Default)]
pub struct ChunkInput {
    pub page: Option<i64>,
    pub start_seconds: Option<f64>,
    pub text: String,
    pub rects: Vec<[u16; 4]>,
    pub embedding: Option<Vec<f32>>,
    /// The layout block it came from (paragraph, list, table …) and the heading above it.
    pub kind: Option<String>,
    pub section: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: String,
    pub source_id: String,
    pub document_hash: String,
    pub page: i64,
    pub text: String,
    pub target_text: String,
    pub rects: Vec<[u16; 4]>,
}

#[derive(Clone)]
pub struct Store {
    root: PathBuf,
    conn: Arc<Mutex<Connection>>,
    /// A second, read-only connection for lists and search, so they never wait behind
    /// the indexer's writes on `conn` (WAL lets readers run alongside a writer).
    reader: Arc<Mutex<Connection>>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    use sha2::{Digest, Sha256};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let seed = format!("{}:{}:{n}:{:?}", now_ms(), std::process::id(), std::thread::current().id());
    let digest = Sha256::digest(seed.as_bytes());
    digest[..12].iter().map(|b| format!("{b:02x}")).collect()
}

fn register_vector_extension() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // sqlite-vec registers itself on every connection opened after this call.
        #[allow(clippy::missing_transmute_annotations)]
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

fn e<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

impl Store {
    /// Opens (and creates or migrates) `<dir>/key.db`.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        register_vector_extension();
        let root = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&root).map_err(e)?;
        let conn = Connection::open(root.join("key.db")).map_err(e)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )
        .map_err(e)?;
        let version = conn
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .map_err(e)? as usize;
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            let tx = conn.unchecked_transaction().map_err(e)?;
            tx.execute_batch(sql).map_err(|error| format!("migration {}: {error}", index + 1))?;
            if index + 1 == GRAPH_MIGRATION {
                graph::backfill(&tx)
                    .and_then(|()| properties::backfill_choices(&tx))
                    .map_err(|error| format!("migration {}: {error}", index + 1))?;
            }
            tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1)).map_err(e)?;
            tx.commit().map_err(e)?;
        }
        let reader = Connection::open(root.join("key.db")).map_err(e)?;
        reader.execute_batch("PRAGMA query_only=1; PRAGMA busy_timeout=5000;").map_err(e)?;
        Ok(Self { root, conn: Arc::new(Mutex::new(conn)), reader: Arc::new(Mutex::new(reader)) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| "Library database lock poisoned".to_string())
    }

    fn read(&self) -> Result<MutexGuard<'_, Connection>> {
        self.reader.lock().map_err(|_| "Library database lock poisoned".to_string())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        self.db()?
            .query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0))
            .optional()
            .map_err(e)
    }
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db()?
            .execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(e)
    }

    // ── Sources ─────────────────────────────────────────────

    pub fn insert_source(&self, input: SourceInput) -> Result<Source> {
        let id = new_id();
        let now = now_ms();
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            insert_source_row(&tx, &id, &input, now)?;
            for collection in &input.collections {
                tx.execute(
                    "INSERT OR IGNORE INTO source_collections(source_id, collection_id) VALUES (?1, ?2)",
                    params![id, collection],
                )
                .map_err(e)?;
            }
            sync_graph(&tx, &id, None)?;
            refresh_fts(&tx, &id)?;
            tx.commit().map_err(e)?;
        }
        self.source(&id)?.ok_or_else(|| "Source was not saved".into())
    }

    /// Inserts many sources in one transaction (used by importers). Returns ids in input order.
    pub fn insert_sources(&self, inputs: Vec<SourceInput>) -> Result<Vec<String>> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let now = now_ms();
        let mut ids = Vec::with_capacity(inputs.len());
        for input in &inputs {
            let existing: Option<String> = match (&input.origin, &input.origin_key) {
                (Some(origin), Some(key)) => tx
                    .query_row(
                        "SELECT id FROM sources WHERE origin = ?1 AND origin_key = ?2",
                        params![origin, key],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(e)?,
                _ => None,
            };
            let id = match existing {
                Some(id) => {
                    let patch = input_patch(input);
                    patch_source_row(&tx, &id, &patch, now)?;
                    sync_graph(&tx, &id, Some(&patch))?;
                    id
                }
                None => {
                    let id = new_id();
                    insert_source_row(&tx, &id, input, now)?;
                    sync_graph(&tx, &id, None)?;
                    id
                }
            };
            for collection in &input.collections {
                tx.execute(
                    "INSERT OR IGNORE INTO source_collections(source_id, collection_id) VALUES (?1, ?2)",
                    params![id, collection],
                )
                .map_err(e)?;
            }
            refresh_fts(&tx, &id)?;
            ids.push(id);
        }
        tx.commit().map_err(e)?;
        Ok(ids)
    }

    /// Applies a camelCase JSON patch: bibliographic fields, `creators`, `tags`,
    /// `properties` (merged; null removes a key), `starred`, `kind`.
    pub fn update_source(&self, id: &str, patch: &Map<String, Json>) -> Result<Source> {
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            patch_source_row(&tx, id, patch, now_ms())?;
            sync_graph(&tx, id, Some(patch))?;
            refresh_fts(&tx, id)?;
            tx.commit().map_err(e)?;
        }
        self.source(id)?.ok_or_else(|| "Source not found".into())
    }

    pub fn source(&self, id: &str) -> Result<Option<Source>> {
        let db = self.read()?;
        db.query_row(&format!("{} WHERE s.id = ?", select_sources()), [id], read_source)
            .optional()
            .map_err(e)
    }

    pub fn source_by_hash(&self, hash: &str) -> Result<Option<Source>> {
        let db = self.db()?;
        db.query_row(
            &format!("{} WHERE s.file_hash = ?1 OR s.id = ?1 ORDER BY s.trashed_at IS NOT NULL LIMIT 1", select_sources()),
            [hash],
            read_source,
        )
        .optional()
        .map_err(e)
    }

    pub fn list_sources(&self, query: &ListQuery) -> Result<SourcePage> {
        let db = self.read()?;
        let (clause, values) = where_clause(query);
        let levels = if query.sorts.is_empty() {
            vec![SortKey { field: query.sort.clone().unwrap_or_else(|| "added".into()), descending: query.descending }]
        } else {
            query.sorts.clone()
        };
        let order = levels
            .iter()
            .map(|k| format!("{} {} NULLS LAST", sort_expression(&k.field), if k.descending { "DESC" } else { "ASC" }))
            .collect::<Vec<_>>()
            .join(", ");
        let direction = if levels[0].descending { "DESC" } else { "ASC" };
        let limit = query.limit.unwrap_or(200).min(2000);
        let total = db
            .query_row(
                &format!("SELECT count(*) FROM sources s {clause}"),
                params_from_iter(values.iter()),
                |r| r.get::<_, i64>(0),
            )
            .map_err(e)? as usize;
        let sql = format!(
            "{} {clause} ORDER BY {order}, s.rowid {direction} LIMIT {limit} OFFSET {}",
            select_sources(),
            query.offset
        );
        let mut statement = db.prepare(&sql).map_err(e)?;
        let items = statement
            .query_map(params_from_iter(values.iter()), read_source)
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)?;
        let next = query.offset + items.len();
        let counts = counts(&db, query)?;
        Ok(SourcePage {
            items,
            total,
            next_offset: (next < total).then_some(next),
            counts,
        })
    }

    pub fn trash(&self, ids: &[String], trashed: bool) -> Result<usize> {
        let db = self.db()?;
        let now = now_ms();
        let mut changed = 0;
        for id in ids {
            changed += db
                .execute(
                    "UPDATE sources SET trashed_at = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, trashed.then_some(now), now],
                )
                .map_err(e)?;
        }
        Ok(changed)
    }

    /// Permanently removes sources and everything derived from them. Linked files stay on disk.
    pub fn delete(&self, ids: &[String]) -> Result<usize> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let mut removed = 0;
        for id in ids {
            tx.execute(
                "DELETE FROM sources_fts WHERE rowid = (SELECT rowid FROM sources WHERE id = ?)",
                [id],
            )
            .map_err(e)?;
            // Its notes go with it (cascade); so do the links they wrote.
            let notes: Vec<String> = {
                let mut statement = tx.prepare("SELECT id FROM notes WHERE source_id = ?").map_err(e)?;
                let rows = statement.query_map([id], |r| r.get(0)).map_err(e)?;
                rows.collect::<std::result::Result<_, _>>().map_err(e)?
            };
            for note in notes {
                links::forget_item(&tx, links::NOTE, &note)?;
            }
            links::forget_item(&tx, links::SOURCE, id)?;
            removed += tx.execute("DELETE FROM sources WHERE id = ?", [id]).map_err(e)?;
        }
        graph::prune_orphans(&tx)?;
        tx.commit().map_err(e)?;
        Ok(removed)
    }

    pub fn set_tags(&self, id: &str, tags: &[String]) -> Result<()> {
        let mut patch = Map::new();
        patch.insert("tags".into(), Json::from(normalize_tags(tags)));
        self.update_source(id, &patch).map(|_| ())
    }

    /// Adds or removes tags across many sources.
    pub fn bulk_tag(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<usize> {
        let mut changed = 0;
        for id in ids {
            let Some(source) = self.source(id)? else { continue };
            let mut tags: Vec<String> = source.tags.into_iter().filter(|t| !remove.contains(t)).collect();
            tags.extend(add.iter().cloned());
            self.set_tags(id, &tags)?;
            changed += 1;
        }
        Ok(changed)
    }

    /// Renames or merges tags workspace-wide. Returns the number of sources touched.
    pub fn retag(&self, from: &[String], to: &str) -> Result<usize> {
        let ids: Vec<String> = {
            let db = self.db()?;
            let mut statement = db
                .prepare("SELECT DISTINCT s.id FROM sources s, json_each(s.tags) t WHERE t.value = ?")
                .map_err(e)?;
            let mut ids = Vec::new();
            for tag in from {
                for id in statement.query_map([tag], |r| r.get::<_, String>(0)).map_err(e)? {
                    ids.push(id.map_err(e)?);
                }
            }
            ids.sort();
            ids.dedup();
            ids
        };
        let add = if to.trim().is_empty() { vec![] } else { vec![to.trim().to_string()] };
        self.bulk_tag(&ids, &add, from)
    }

    pub fn facets(&self, query: &ListQuery) -> Result<Facets> {
        let db = self.read()?;
        let (clause, values) = where_clause(query);
        // The view is evaluated once; every facet is counted from it in a single pass.
        let mut statement = db
            .prepare(&format!(
                "WITH v AS MATERIALIZED (SELECT s.tags, s.item_type, s.kind, s.year FROM sources s {clause})
                 SELECT 'tag', t.value, count(*) FROM v, json_each(v.tags) t GROUP BY t.value
                 UNION ALL SELECT 'type', item_type, count(*) FROM v GROUP BY item_type
                 UNION ALL SELECT 'kind', kind, count(*) FROM v GROUP BY kind
                 UNION ALL SELECT 'year', CAST(year AS TEXT), count(*) FROM v WHERE year IS NOT NULL GROUP BY year"
            ))
            .map_err(e)?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), |r| {
                Ok((r.get::<_, String>(0)?, Facet { value: r.get::<_, Option<String>>(1)?.unwrap_or_default(), count: r.get(2)? }))
            })
            .map_err(e)?;
        let mut facets = Facets { tags: Vec::new(), item_types: Vec::new(), kinds: Vec::new(), years: Vec::new() };
        for row in rows {
            let (group, facet) = row.map_err(e)?;
            match group.as_str() {
                "tag" => facets.tags.push(facet),
                "type" => facets.item_types.push(facet),
                "kind" => facets.kinds.push(facet),
                _ => facets.years.push(facet),
            }
        }
        let by_count = |a: &Facet, b: &Facet| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value));
        facets.tags.sort_by(by_count);
        facets.tags.truncate(500);
        facets.item_types.sort_by(by_count);
        facets.kinds.sort_by(by_count);
        facets.years.sort_by(|a, b| b.value.cmp(&a.value));
        Ok(facets)
    }

    // ── Collections ─────────────────────────────────────────

    pub fn collections(&self) -> Result<Vec<Collection>> {
        let db = self.read()?;
        let mut statement = db
            .prepare(
                "SELECT c.id, c.parent_id, c.name, c.position, c.origin_key,
                        (SELECT count(*) FROM source_collections sc JOIN sources s ON s.id = sc.source_id
                          WHERE sc.collection_id = c.id AND s.trashed_at IS NULL)
                 FROM collections c ORDER BY c.position, c.name COLLATE NOCASE",
            )
            .map_err(e)?;
        statement
            .query_map([], |r| {
                Ok(Collection {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    name: r.get(2)?,
                    position: r.get(3)?,
                    origin_key: r.get(4)?,
                    source_count: r.get(5)?,
                })
            })
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    pub fn create_collection(&self, name: &str, parent_id: Option<&str>, origin_key: Option<&str>) -> Result<Collection> {
        let id = new_id();
        let db = self.db()?;
        if let Some(key) = origin_key {
            if let Some(existing) = db
                .query_row("SELECT id FROM collections WHERE origin_key = ?", [key], |r| r.get::<_, String>(0))
                .optional()
                .map_err(e)?
            {
                db.execute("UPDATE collections SET name = ?2, parent_id = ?3 WHERE id = ?1", params![existing, name, parent_id])
                    .map_err(e)?;
                drop(db);
                return self.collections()?.into_iter().find(|c| c.id == existing).ok_or_else(|| "Collection missing".into());
            }
        }
        db.execute(
            "INSERT INTO collections(id, parent_id, name, position, origin_key)
             VALUES (?1, ?2, ?3, (SELECT coalesce(max(position), 0) + 1 FROM collections), ?4)",
            params![id, parent_id, name.trim(), origin_key],
        )
        .map_err(e)?;
        drop(db);
        self.collections()?.into_iter().find(|c| c.id == id).ok_or_else(|| "Collection missing".into())
    }

    pub fn update_collection(&self, id: &str, name: Option<&str>, parent_id: Option<Option<&str>>) -> Result<()> {
        let db = self.db()?;
        if let Some(name) = name {
            db.execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, name.trim()]).map_err(e)?;
        }
        if let Some(parent) = parent_id {
            if let Some(parent) = parent {
                let inside: bool = db
                    .query_row(
                        "WITH RECURSIVE up(id) AS (SELECT ?1 UNION SELECT c.parent_id FROM collections c JOIN up ON c.id = up.id WHERE c.parent_id IS NOT NULL)
                         SELECT EXISTS(SELECT 1 FROM up WHERE id = ?2)",
                        params![parent, id],
                        |r| r.get(0),
                    )
                    .map_err(e)?;
                if inside {
                    return Err("A collection cannot contain itself".into());
                }
            }
            db.execute("UPDATE collections SET parent_id = ?2 WHERE id = ?1", params![id, parent]).map_err(e)?;
        }
        Ok(())
    }

    /// Puts `ids` under `parent_id` in this order; other siblings keep their relative order after them.
    pub fn reorder_collections(&self, parent_id: Option<&str>, ids: &[String]) -> Result<()> {
        for id in ids {
            self.update_collection(id, None, Some(parent_id))?;
        }
        let mut db = self.db()?;
        let tx = db.transaction().map_err(e)?;
        let siblings: Vec<String> = {
            let mut statement = tx
                .prepare("SELECT id FROM collections WHERE parent_id IS ?1 ORDER BY position, name COLLATE NOCASE")
                .map_err(e)?;
            let rows = statement.query_map([parent_id], |r| r.get::<_, String>(0)).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        let order = ids.iter().cloned().chain(siblings.into_iter().filter(|s| !ids.contains(s)));
        for (position, id) in order.enumerate() {
            tx.execute("UPDATE collections SET position = ?2 WHERE id = ?1", params![id, position as i64]).map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    pub fn delete_collection(&self, id: &str) -> Result<()> {
        self.db()?.execute("DELETE FROM collections WHERE id = ?", [id]).map(|_| ()).map_err(e)
    }

    pub fn set_membership(&self, collection_id: &str, ids: &[String], present: bool) -> Result<usize> {
        let db = self.db()?;
        let mut changed = 0;
        for id in ids {
            changed += if present {
                db.execute(
                    "INSERT OR IGNORE INTO source_collections(source_id, collection_id) VALUES (?1, ?2)",
                    params![id, collection_id],
                )
            } else {
                db.execute(
                    "DELETE FROM source_collections WHERE source_id = ?1 AND collection_id = ?2",
                    params![id, collection_id],
                )
            }
            .map_err(e)?;
        }
        Ok(changed)
    }

    // ── Notes & annotations ─────────────────────────────────

    pub fn notes(&self, source_id: &str) -> Result<Vec<Note>> {
        let db = self.db()?;
        let mut statement = db
            .prepare("SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes WHERE source_id = ? ORDER BY created_at")
            .map_err(e)?;
        statement
            .query_map([source_id], read_note)
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    /// Notes that belong to no source, most recently edited first.
    pub fn standalone_notes(&self) -> Result<Vec<Note>> {
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes WHERE source_id IS NULL ORDER BY updated_at DESC")
            .map_err(e)?;
        statement
            .query_map([], read_note)
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    /// The first passage on a page, so a quote or link can open the reader there.
    pub fn page_chunk(&self, source_id: &str, page: i64) -> Result<Option<i64>> {
        self.read()?
            .query_row("SELECT id FROM chunks WHERE source_id = ? AND page = ? ORDER BY seq LIMIT 1", params![source_id, page], |r| r.get(0))
            .optional()
            .map_err(e)
    }

    pub fn note(&self, id: &str) -> Result<Option<Note>> {
        self.read()?
            .query_row("SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes WHERE id = ?", [id], read_note)
            .optional()
            .map_err(e)
    }

    pub fn save_note(&self, id: Option<&str>, source_id: Option<&str>, title: &str, body: &str, origin_key: Option<&str>) -> Result<Note> {
        let now = now_ms();
        let db = self.db()?;
        let existing = match (id, origin_key) {
            (Some(id), _) => Some(id.to_string()),
            (None, Some(key)) => db
                .query_row("SELECT id FROM notes WHERE origin_key = ?", [key], |r| r.get(0))
                .optional()
                .map_err(e)?,
            _ => None,
        };
        let id = existing.unwrap_or_else(new_id);
        db.execute(
            "INSERT INTO notes(id, source_id, title, body, origin_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at",
            params![id, source_id, title, body, origin_key, now],
        )
        .map_err(e)?;
        let note = db
            .query_row(
                "SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes WHERE id = ?",
                [&id],
                read_note,
            )
            .map_err(e)?;
        // An edit from anywhere (a note tab passes no source) keeps the source's note text searchable.
        if let Some(source) = &note.source_id {
            refresh_fts(&db, source)?;
        }
        Ok(note)
    }

    /// Replaces a note's passages as cut from the version saved at `version` (its updated_at).
    /// Passages whose text is unchanged keep their row, so their vector is kept and only new
    /// or edited ones wait for embedding. A newer save wins: its own indexing writes instead.
    pub fn replace_note_chunks(&self, note_id: &str, version: i64, chunks: &[ChunkInput]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let current: Option<i64> = tx
            .query_row("SELECT updated_at FROM notes WHERE id = ?", [note_id], |r| r.get(0))
            .optional()
            .map_err(e)?;
        if current != Some(version) {
            return Ok(());
        }
        let mut existing: HashMap<String, Vec<i64>> = HashMap::new();
        {
            let mut rows = tx.prepare("SELECT id, text FROM chunks WHERE note_id = ? ORDER BY seq DESC").map_err(e)?;
            for row in rows.query_map([note_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(e)? {
                let (id, text) = row.map_err(e)?;
                existing.entry(text).or_default().push(id);
            }
            let mut keep = tx.prepare("UPDATE chunks SET seq = ?2, kind = ?3, section = ?4 WHERE id = ?1").map_err(e)?;
            let mut insert = tx
                .prepare("INSERT INTO chunks(note_id, seq, text, kind, section) VALUES (?1, ?2, ?3, ?4, ?5)")
                .map_err(e)?;
            for (seq, chunk) in chunks.iter().enumerate() {
                match existing.get_mut(&chunk.text).and_then(Vec::pop) {
                    Some(id) => keep.execute(params![id, seq as i64, chunk.kind, chunk.section]).map_err(e)?,
                    None => insert.execute(params![note_id, seq as i64, chunk.text, chunk.kind, chunk.section]).map_err(e)?,
                };
            }
            let mut delete = tx.prepare("DELETE FROM chunks WHERE id = ?").map_err(e)?;
            for id in existing.into_values().flatten() {
                delete.execute([id]).map_err(e)?;
            }
        }
        tx.execute("UPDATE notes SET indexed_at = ?2 WHERE id = ?1", params![note_id, version]).map_err(e)?;
        tx.commit().map_err(e)
    }

    /// Notes edited since their passages were cut (or never cut, like imported ones).
    pub fn stale_notes(&self, limit: usize) -> Result<Vec<Note>> {
        let db = self.read()?;
        let mut statement = db
            .prepare(
                "SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes
                 WHERE indexed_at IS NULL OR indexed_at < updated_at ORDER BY updated_at DESC LIMIT ?",
            )
            .map_err(e)?;
        statement
            .query_map([limit as i64], read_note)
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    pub fn delete_note(&self, id: &str) -> Result<()> {
        let db = self.db()?;
        let source: Option<String> = db
            .query_row("SELECT source_id FROM notes WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(e)?
            .flatten();
        db.execute("DELETE FROM notes WHERE id = ?", [id]).map_err(e)?;
        links::forget_item(&db, links::NOTE, id)?;
        if let Some(source) = source {
            refresh_fts(&db, &source)?;
        }
        Ok(())
    }

    /// Merges a note's page metadata: `fields`, `properties` and `appearance`, each a
    /// patch where null removes a key. The body and title are left alone, so this never
    /// races a save of the text.
    pub fn update_note_meta(&self, id: &str, patch: &Map<String, Json>) -> Result<Note> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let (fields, properties, appearance): (String, String, String) = tx
            .query_row("SELECT fields, properties, appearance FROM notes WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(e)?
            .ok_or("Note not found")?;
        let merged = |current: &str, key: &str| -> String {
            let base: Map<String, Json> = serde_json::from_str(current).unwrap_or_default();
            match patch.get(key) {
                Some(Json::Object(p)) => Json::Object(merge_json(base, p)).to_string(),
                _ => Json::Object(base).to_string(),
            }
        };
        tx.execute(
            "UPDATE notes SET fields = ?2, properties = ?3, appearance = ?4, updated_at = ?5 WHERE id = ?1",
            params![id, merged(&fields, "fields"), merged(&properties, "properties"), merged(&appearance, "appearance"), now_ms()],
        )
        .map_err(e)?;
        let note = tx
            .query_row("SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes WHERE id = ?", [id], read_note)
            .map_err(e)?;
        tx.commit().map_err(e)?;
        Ok(note)
    }

    /// The note an importer created under `origin_key`.
    pub fn note_by_origin(&self, origin_key: &str) -> Result<Option<Note>> {
        self.read()?
            .query_row("SELECT id, source_id, title, body, origin_key, created_at, updated_at, fields, properties, appearance FROM notes WHERE origin_key = ?", [origin_key], read_note)
            .optional()
            .map_err(e)
    }

    /// Moves a note to another source (or makes it standalone), keeping its id and text.
    pub fn set_note_source(&self, id: &str, source_id: Option<&str>) -> Result<()> {
        let db = self.db()?;
        let before: Option<String> = db
            .query_row("SELECT source_id FROM notes WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(e)?
            .ok_or("Note not found")?;
        db.execute("UPDATE notes SET source_id = ?2 WHERE id = ?1", params![id, source_id]).map_err(e)?;
        for source in before.iter().map(String::as_str).chain(source_id) {
            refresh_fts(&db, source)?;
        }
        Ok(())
    }

    /// Every source an importer brought in from `origin`: its origin key, id and last change.
    pub fn origin_index(&self, origin: &str) -> Result<HashMap<String, (String, i64)>> {
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT origin_key, id, updated_at FROM sources WHERE origin = ? AND origin_key IS NOT NULL")
            .map_err(e)?;
        statement
            .query_map([origin], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, i64>(2)?))))
            .map_err(e)?
            .collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(e)
    }

    pub fn annotations(&self, source_id: &str) -> Result<Vec<Json>> {
        let db = self.db()?;
        let mut statement = db
            .prepare("SELECT payload FROM annotations WHERE source_id = ? ORDER BY updated_at")
            .map_err(e)?;
        statement
            .query_map([source_id], |r| r.get::<_, String>(0))
            .map_err(e)?
            .map(|row| row.map_err(e).and_then(|text| serde_json::from_str(&text).map_err(e)))
            .collect()
    }

    pub fn apply_annotations(&self, source_id: &str, upserts: &[Json], deleted: &[String]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let now = now_ms();
        for annotation in upserts {
            let id = annotation.get("id").and_then(Json::as_str).ok_or("Annotation is missing an id")?;
            tx.execute(
                "INSERT INTO annotations(id, source_id, payload, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
                params![id, source_id, annotation.to_string(), now],
            )
            .map_err(e)?;
        }
        for id in deleted {
            tx.execute("DELETE FROM annotations WHERE id = ?1 AND source_id = ?2", params![id, source_id])
                .map_err(e)?;
        }
        links::sync_highlight_links(&tx, source_id)?;
        tx.commit().map_err(e)
    }

    pub fn replace_annotations(&self, source_id: &str, annotations: &[Json]) -> Result<()> {
        self.db()?
            .execute("DELETE FROM annotations WHERE source_id = ?", [source_id])
            .map_err(e)?;
        self.apply_annotations(source_id, annotations, &[])
    }

    // ── Indexing ────────────────────────────────────────────

    pub fn set_index_status(&self, id: &str, status: &str, error: Option<&str>, done: i64, total: i64) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE sources SET index_status = ?2, index_error = ?3, indexed_chunks = ?4, index_total = ?5 WHERE id = ?1",
                params![id, status, error, done, total],
            )
            .map(|_| ())
            .map_err(e)
    }

    /// Queues every failed source for another attempt. Returns how many.
    pub fn retry_failed(&self) -> Result<usize> {
        self.db()?
            .execute("UPDATE sources SET index_status = 'pending', index_error = NULL WHERE index_status = 'failed' AND trashed_at IS NULL", [])
            .map_err(e)
    }

    /// How many sources wait for (or are in) indexing.
    pub fn index_queue_len(&self) -> Result<i64> {
        self.read()?
            .query_row("SELECT count(*) FROM sources WHERE trashed_at IS NULL AND index_status IN ('pending','indexing')", [], |r| r.get(0))
            .map_err(e)
    }

    /// Passages waiting for their vector (see `AWAITING_VECTOR`).
    pub fn unembedded_chunks(&self) -> Result<i64> {
        self.read()?
            .query_row(&format!("SELECT count(*) {AWAITING_VECTOR}"), [now_ms() - NOTE_SETTLE_MS], |r| r.get(0))
            .map_err(e)
    }

    /// Ids waiting for indexing, oldest first. `include_failed` also retries failures.
    pub fn pending_sources(&self, limit: usize, include_failed: bool) -> Result<Vec<String>> {
        let db = self.db()?;
        let statuses = if include_failed { "('pending','indexing','failed')" } else { "('pending','indexing')" };
        let mut statement = db
            .prepare(&format!(
                "SELECT id FROM sources WHERE trashed_at IS NULL AND index_status IN {statuses}
                 ORDER BY index_status = 'indexing' DESC, file_path IS NULL, added_at DESC LIMIT ?"
            ))
            .map_err(e)?;
        statement
            .query_map([limit as i64], |r| r.get(0))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    /// Atomically replaces a source's chunks (text, rects and optional embeddings).
    pub fn replace_chunks(&self, source_id: &str, chunks: &[ChunkInput]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute("DELETE FROM chunks WHERE source_id = ?", [source_id]).map_err(e)?;
        {
            let mut insert = tx
                .prepare("INSERT INTO chunks(source_id, seq, page, start_seconds, text, rects, embedded, kind, section) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
                .map_err(e)?;
            let mut vector = tx
                .prepare("INSERT INTO chunk_vectors(rowid, embedding) VALUES (?1, ?2)")
                .map_err(e)?;
            for (seq, chunk) in chunks.iter().enumerate() {
                let rects = (!chunk.rects.is_empty()).then(|| serde_json::to_string(&chunk.rects).unwrap_or_default());
                insert
                    .execute(params![source_id, seq as i64, chunk.page, chunk.start_seconds, chunk.text, rects, chunk.embedding.is_some(), chunk.kind, chunk.section])
                    .map_err(e)?;
                if let Some(embedding) = &chunk.embedding {
                    vector
                        .execute(params![tx.last_insert_rowid(), vector_blob(embedding)?])
                        .map_err(e)?;
                }
            }
        }
        tx.commit().map_err(e)
    }

    /// Passages waiting for their vector, with the title they are embedded under: the
    /// source's, or for a note its own title, else its source's.
    pub fn chunks_without_vectors(&self, limit: usize) -> Result<Vec<(i64, String, String)>> {
        let db = self.db()?;
        let mut statement = db
            .prepare(&format!(
                "SELECT c.id, coalesce(s.title, nullif(n.title, ''), ns.title, lf.name, ''), c.text {AWAITING_VECTOR} ORDER BY c.id LIMIT ?2"
            ))
            .map_err(e)?;
        statement
            .query_map(params![now_ms() - NOTE_SETTLE_MS, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    pub fn set_chunk_vectors(&self, vectors: &[(i64, Vec<f32>)]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        {
            let mut statement = tx
                .prepare("INSERT OR REPLACE INTO chunk_vectors(rowid, embedding) VALUES (?1, ?2)")
                .map_err(e)?;
            let mut mark = tx.prepare("UPDATE chunks SET embedded = 1 WHERE id = ?").map_err(e)?;
            for (id, vector) in vectors {
                statement.execute(params![id, vector_blob(vector)?]).map_err(e)?;
                mark.execute([id]).map_err(e)?;
            }
        }
        tx.commit().map_err(e)
    }

    pub fn vector_count(&self) -> Result<i64> {
        self.read()?.query_row("SELECT count(*) FROM chunks WHERE embedded = 1", [], |r| r.get(0)).map_err(e)
    }

    pub fn passage(&self, chunk_id: i64) -> Result<Option<Passage>> {
        let db = self.read()?;
        db.query_row(
            "SELECT c.id, c.source_id, coalesce(s.file_hash, s.id), coalesce(c.page, 0), c.text, c.rects
             FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?",
            [chunk_id],
            |r| {
                let rects: Option<String> = r.get(5)?;
                let text: String = r.get(4)?;
                Ok(Passage {
                    id: r.get::<_, i64>(0)?.to_string(),
                    source_id: r.get(1)?,
                    document_hash: r.get(2)?,
                    page: r.get(3)?,
                    target_text: text.clone(),
                    text,
                    rects: rects.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default(),
                })
            },
        )
        .optional()
        .map_err(e)
    }

    pub fn search(&self, query: &SearchQuery, query_vector: Option<&[f32]>) -> Result<SearchResult> {
        let db = self.read()?;
        search::run(&db, query, query_vector)
    }
}

// ── Row helpers ─────────────────────────────────────────────

fn select_sources() -> String {
    let mut columns: Vec<String> = TEXT_FIELDS.iter().chain(NUMBER_FIELDS).map(|(_, c)| format!("s.{c}")).collect();
    columns.extend(
        [
            "s.id", "s.kind", "s.creators", "s.tags", "s.properties", "s.starred", "s.index_status", "s.index_error",
            "s.indexed_chunks", "s.index_total", "s.origin", "s.origin_key", "s.added_at", "s.updated_at", "s.trashed_at",
            "(SELECT group_concat(collection_id, char(31)) FROM source_collections WHERE source_id = s.id)",
            "(SELECT count(*) FROM notes WHERE source_id = s.id)",
            "(SELECT count(*) FROM annotations WHERE source_id = s.id)",
            "s.appearance",
            "(SELECT json_group_object(position, person_id) FROM source_people WHERE source_id = s.id)",
        ]
        .map(String::from),
    );
    format!("SELECT {} FROM sources s", columns.join(", "))
}

fn read_source(row: &Row) -> rusqlite::Result<Source> {
    let mut fields = Map::new();
    let mut index = 0;
    for (name, _) in TEXT_FIELDS {
        if let Some(value) = row.get::<_, Option<String>>(index)? {
            fields.insert((*name).into(), Json::String(value));
        }
        index += 1;
    }
    for (name, _) in NUMBER_FIELDS {
        if let Some(value) = row.get::<_, Option<f64>>(index)? {
            let number = if value.fract() == 0.0 { Json::from(value as i64) } else { Json::from(value) };
            fields.insert((*name).into(), number);
        }
        index += 1;
    }
    let text = |i: usize| row.get::<_, String>(i);
    let collections: Option<String> = row.get(index + 15)?;
    let mut creators: Vec<Creator> = serde_json::from_str(&text(index + 2)?).unwrap_or_default();
    let people: Map<String, Json> = row.get::<_, Option<String>>(index + 19)?.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_default();
    for (position, creator) in creators.iter_mut().enumerate() {
        creator.person_id = people.get(&position.to_string()).and_then(Json::as_str).map(String::from);
    }
    Ok(Source {
        id: text(index)?,
        kind: text(index + 1)?,
        creators,
        tags: serde_json::from_str(&text(index + 3)?).unwrap_or_default(),
        properties: serde_json::from_str(&text(index + 4)?).unwrap_or_default(),
        starred: row.get::<_, i64>(index + 5)? != 0,
        index_status: text(index + 6)?,
        index_error: row.get(index + 7)?,
        indexed_chunks: row.get(index + 8)?,
        index_total: row.get(index + 9)?,
        origin: row.get(index + 10)?,
        origin_key: row.get(index + 11)?,
        added_at: row.get(index + 12)?,
        updated_at: row.get(index + 13)?,
        trashed_at: row.get(index + 14)?,
        collections: collections
            .map(|value| value.split('\u{1f}').map(String::from).collect())
            .unwrap_or_default(),
        note_count: row.get(index + 16)?,
        annotation_count: row.get(index + 17)?,
        appearance: serde_json::from_str(&text(index + 18)?).unwrap_or_default(),
        fields,
    })
}

fn read_note(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        source_id: r.get(1)?,
        title: r.get(2)?,
        body: r.get(3)?,
        origin_key: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        fields: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
        properties: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        appearance: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
    })
}

/// Shallow merge: each key of `patch` replaces the one in `base`; null removes it.
fn merge_json(mut base: Map<String, Json>, patch: &Map<String, Json>) -> Map<String, Json> {
    for (key, value) in patch {
        if value.is_null() {
            base.remove(key);
        } else {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn json_to_sql(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        Json::String(s) if s.trim().is_empty() => Value::Null,
        Json::String(s) => Value::Text(s.trim().to_string()),
        other => Value::Text(other.to_string()),
    }
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if !tag.is_empty() && !out.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            out.push(tag.to_string());
        }
    }
    out
}

fn input_patch(input: &SourceInput) -> Map<String, Json> {
    let mut patch = input.fields.clone();
    patch.insert("kind".into(), Json::from(input.kind.clone()));
    patch.insert("creators".into(), serde_json::to_value(&input.creators).unwrap_or_default());
    patch.insert("tags".into(), Json::from(input.tags.clone()));
    patch.insert("replaceProperties".into(), Json::Object(input.properties.clone()));
    patch
}

fn insert_source_row(db: &Connection, id: &str, input: &SourceInput, now: i64) -> Result<()> {
    let mut columns = vec!["id", "kind", "creators", "tags", "properties", "origin", "origin_key", "added_at", "updated_at", "index_status"];
    let mut values: Vec<Value> = vec![
        Value::Text(id.into()),
        Value::Text(input.kind.clone()),
        Value::Text(creators_json(&input.creators)?),
        Value::Text(serde_json::to_string(&normalize_tags(&input.tags)).map_err(e)?),
        Value::Text(Json::Object(input.properties.clone()).to_string()),
        input.origin.clone().map(Value::Text).unwrap_or(Value::Null),
        input.origin_key.clone().map(Value::Text).unwrap_or(Value::Null),
        Value::Integer(input.added_at.unwrap_or(now)),
        Value::Integer(now),
        Value::Text(input.index_status.clone().unwrap_or_else(|| "pending".into())),
    ];
    for (name, column) in TEXT_FIELDS.iter().chain(NUMBER_FIELDS) {
        if DERIVED_FIELDS.contains(name) {
            continue;
        }
        if let Some(value) = input.fields.get(*name) {
            columns.push(column);
            values.push(json_to_sql(value));
        }
    }
    if !input.fields.contains_key("title") {
        columns.push("title");
        values.push(Value::Text(String::new()));
    }
    let placeholders = vec!["?"; columns.len()].join(", ");
    db.execute(
        &format!("INSERT INTO sources({}) VALUES ({placeholders})", columns.join(", ")),
        params_from_iter(values.iter()),
    )
    .map(|_| ())
    .map_err(e)
}

fn patch_source_row(db: &Connection, id: &str, patch: &Map<String, Json>, now: i64) -> Result<()> {
    let mut sets = vec!["updated_at = ?".to_string()];
    let mut values: Vec<Value> = vec![Value::Integer(now)];
    let lookup_before = lookup_ids(db, id, patch)?;
    for (name, column) in TEXT_FIELDS.iter().chain(NUMBER_FIELDS) {
        if DERIVED_FIELDS.contains(name) {
            continue;
        }
        if let Some(value) = patch.get(*name) {
            sets.push(format!("{column} = ?"));
            values.push(if *column == "title" && value.is_null() { Value::Text(String::new()) } else { json_to_sql(value) });
        }
    }
    if let Some(kind) = patch.get("kind").and_then(Json::as_str) {
        sets.push("kind = ?".into());
        values.push(Value::Text(kind.into()));
    }
    if let Some(creators) = patch.get("creators") {
        let creators: Vec<Creator> = serde_json::from_value(creators.clone()).map_err(e)?;
        sets.push("creators = ?".into());
        values.push(Value::Text(creators_json(&creators)?));
    }
    if let Some(tags) = patch.get("tags") {
        let tags: Vec<String> = serde_json::from_value(tags.clone()).map_err(e)?;
        sets.push("tags = ?".into());
        values.push(Value::Text(serde_json::to_string(&normalize_tags(&tags)).map_err(e)?));
    }
    if let Some(starred) = patch.get("starred").and_then(Json::as_bool) {
        sets.push("starred = ?".into());
        values.push(Value::Integer(starred as i64));
    }
    if let Some(Json::Object(appearance)) = patch.get("appearance") {
        let current: String = db
            .query_row("SELECT appearance FROM sources WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(e)?
            .ok_or("Source not found")?;
        sets.push("appearance = ?".into());
        values.push(Value::Text(Json::Object(merge_json(serde_json::from_str(&current).unwrap_or_default(), appearance)).to_string()));
    }
    if let Some(Json::Object(replace)) = patch.get("replaceProperties") {
        sets.push("properties = ?".into());
        values.push(Value::Text(Json::Object(replace.clone()).to_string()));
    } else if let Some(Json::Object(properties)) = patch.get("properties") {
        let current: String = db
            .query_row("SELECT properties FROM sources WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(e)?
            .ok_or("Source not found")?;
        let merged = merge_json(serde_json::from_str(&current).unwrap_or_default(), properties);
        sets.push("properties = ?".into());
        values.push(Value::Text(Json::Object(merged).to_string()));
    }
    // A different file invalidates the text index; the right-hand side sees the old row.
    if let Some(path) = patch.get("filePath") {
        sets.push("index_status = CASE WHEN coalesce(file_path, '') <> coalesce(?, '') THEN 'pending' ELSE index_status END".into());
        values.push(json_to_sql(path));
    }
    values.push(Value::Text(id.into()));
    let changed = db
        .execute(&format!("UPDATE sources SET {} WHERE id = ?", sets.join(", ")), params_from_iter(values.iter()))
        .map_err(e)?;
    if changed == 0 {
        return Err("Source not found".into());
    }
    // A new identifier means a new lookup.
    if lookup_before.is_some() && lookup_ids(db, id, patch)? != lookup_before {
        db.execute(
            "UPDATE sources SET enrich_status = CASE WHEN coalesce(nullif(doi, ''), nullif(pmid, ''), nullif(openalex_id, '')) IS NULL THEN NULL ELSE 'pending' END,
               enrich_error = NULL, enrich_attempts = 0, enrich_after = NULL WHERE id = ?",
            [id],
        )
        .map_err(e)?;
    }
    Ok(())
}

/// The identifiers a source is looked up by, when `patch` touches any of them.
fn lookup_ids(db: &Connection, id: &str, patch: &Map<String, Json>) -> Result<Option<(Option<String>, Option<String>, Option<String>)>> {
    if !LOOKUP_FIELDS.iter().any(|f| patch.contains_key(*f)) {
        return Ok(None);
    }
    db.query_row("SELECT nullif(doi, ''), nullif(pmid, ''), nullif(openalex_id, '') FROM sources WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(e)
}

/// Creators as stored: without the person ids that are only added when reading.
fn creators_json(creators: &[Creator]) -> Result<String> {
    let bare: Vec<Creator> = creators.iter().cloned().map(|c| Creator { person_id: None, ..c }).collect();
    serde_json::to_string(&bare).map_err(e)
}

/// Keeps the tables around a source in step with what a write changed (`None`: a new source).
fn sync_graph(db: &Connection, id: &str, patch: Option<&Map<String, Json>>) -> Result<()> {
    let has = |key: &str| patch.is_none_or(|p| p.contains_key(key));
    if has("creators") {
        graph::sync_people(db, id, true)?;
    }
    if has("containerTitle") || has("issn") || has("publisher") {
        graph::sync_venue(db, id)?;
    }
    if patch.is_none() {
        db.execute(
            "UPDATE sources SET enrich_status = 'pending' WHERE id = ? AND enrich_status IS NULL
               AND coalesce(nullif(doi, ''), nullif(pmid, ''), nullif(openalex_id, '')) IS NOT NULL",
            [id],
        )
        .map_err(e)?;
    }
    if LOOKUP_FIELDS.iter().any(|f| has(f)) {
        graph::relink_citations(db, id)?;
    }
    if has("properties") || has("replaceProperties") {
        properties::sync_choices(db, id)?;
    }
    Ok(())
}

/// Rewrites the metadata FTS row for one source (title, creators, notes, identifiers...).
pub(crate) fn refresh_fts(db: &Connection, id: &str) -> Result<()> {
    db.execute("DELETE FROM sources_fts WHERE rowid = (SELECT rowid FROM sources WHERE id = ?)", [id])
        .map_err(e)?;
    db.execute(
        "INSERT INTO sources_fts(rowid, title, creators, container, abstract, tags, notes, identifiers)
         SELECT s.rowid, s.title || ' ' || coalesce(s.short_title, ''),
           (SELECT group_concat(coalesce(json_extract(c.value, '$.family'), '') || ' ' ||
                                coalesce(json_extract(c.value, '$.given'), '') || ' ' ||
                                coalesce(json_extract(c.value, '$.literal'), ''), ' ')
              FROM json_each(s.creators) c),
           coalesce(s.container_title, '') || ' ' || coalesce(s.container_short, '') || ' ' || coalesce(s.publisher, ''),
           coalesce(s.abstract, ''),
           (SELECT group_concat(t.value, ' ') FROM json_each(s.tags) t),
           (SELECT group_concat(n.title || ' ' || n.body, ' ') FROM notes n WHERE n.source_id = s.id),
           concat_ws(' ', s.doi, s.isbn, s.issn, s.pmid, s.pmcid, s.arxiv_id, s.citation_key, s.url, s.extra, s.year)
         FROM sources s WHERE s.id = ?",
        [id],
    )
    .map(|_| ())
    .map_err(e)
}

/// Filter syntax: every word must match, as a prefix ("heal inco" finds "health income").
pub(crate) fn fts_phrase(text: &str) -> Option<String> {
    let terms: Vec<String> = words(text).into_iter().map(|t| format!("\"{t}\"*")).collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Ranking syntax: any word may match and bm25 rewards passages that match more of them.
/// Whole words only, so "off" does not match "offer"; a longer last word is still a
/// prefix, which keeps search-as-you-type useful.
pub(crate) fn fts_any(text: &str) -> Option<String> {
    fts_any_prefix(text, 4)
}

/// Any word matches; the last one also as a prefix once it has `min_prefix` characters.
pub(crate) fn fts_any_prefix(text: &str, min_prefix: usize) -> Option<String> {
    let words = words(text);
    let last = words.len().saturating_sub(1);
    let terms: Vec<String> = words
        .iter()
        .enumerate()
        .map(|(i, t)| if i == last && t.chars().count() >= min_prefix { format!("\"{t}\"*") } else { format!("\"{t}\"") })
        .collect();
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

fn words(text: &str) -> Vec<String> {
    // Function words carry no topic; questions like "how do people…" match on the rest.
    const STOP: &[&str] = &["a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "has", "have", "how", "i", "in", "is", "it", "its", "of", "on", "or", "than", "that", "the", "their", "there", "these", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with"];
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty() && !STOP.contains(&t.to_lowercase().as_str()))
        .map(|t| t.replace('"', ""))
        .collect()
}

fn where_clause(query: &ListQuery) -> (String, Vec<Value>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    match query.scope.as_deref().unwrap_or("all") {
        "trashed" => conditions.push("s.trashed_at IS NOT NULL".into()),
        scope => {
            conditions.push("s.trashed_at IS NULL".into());
            match scope {
                "starred" => conditions.push("s.starred = 1".into()),
                "unfiled" => conditions.push("NOT EXISTS (SELECT 1 FROM source_collections sc WHERE sc.source_id = s.id)".into()),
                "attention" => conditions.push("s.index_status IN ('failed','missing','no_text')".into()),
                "indexing" => conditions.push("s.index_status IN ('pending','indexing')".into()),
                "ready" => conditions.push("s.index_status = 'ready'".into()),
                _ => {}
            }
        }
    }
    if let Some(collection) = &query.collection_id {
        // A collection includes items filed in any of its sub-collections.
        conditions.push(
            "s.id IN (SELECT sc.source_id FROM source_collections sc WHERE sc.collection_id IN (
               WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id)
               SELECT id FROM tree))"
                .into(),
        );
        values.push(Value::Text(collection.clone()));
    }
    if let Some(tag) = &query.tag {
        conditions.push("EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value = ?)".into());
        values.push(Value::Text(tag.clone()));
    }
    if let Some(kind) = &query.kind {
        conditions.push("s.kind = ?".into());
        values.push(Value::Text(kind.clone()));
    }
    if let Some(item_type) = &query.item_type {
        conditions.push("s.item_type = ?".into());
        values.push(Value::Text(item_type.clone()));
    }
    if let Some(ids) = &query.ids {
        if ids.is_empty() {
            conditions.push("0".into());
        } else {
            conditions.push(format!("(s.id IN ({0}) OR s.file_hash IN ({0}))", vec!["?"; ids.len()].join(",")));
            values.extend(ids.iter().map(|id| Value::Text(id.clone())));
            values.extend(ids.iter().map(|id| Value::Text(id.clone())));
        }
    }
    if let Some(from) = query.year_from {
        conditions.push("s.year >= ?".into());
        values.push(Value::Integer(from));
    }
    if let Some(to) = query.year_to {
        conditions.push("s.year <= ?".into());
        values.push(Value::Integer(to));
    }
    if let Some(phrase) = query.text.as_deref().and_then(fts_phrase) {
        conditions.push("s.rowid IN (SELECT rowid FROM sources_fts WHERE sources_fts MATCH ?)".into());
        values.push(Value::Text(phrase));
    }
    for (condition, bound) in query.filters.iter().filter_map(filters::condition) {
        conditions.push(condition);
        values.extend(bound);
    }
    (format!("WHERE {}", conditions.join(" AND ")), values)
}

fn counts(db: &Connection, query: &ListQuery) -> Result<Counts> {
    // Counts describe the current collection/tag/text filter, independent of scope.
    let mut base = query.clone();
    base.scope = Some("everything".into());
    let (clause, values) = where_clause(&base);
    let clause = clause.replacen("s.trashed_at IS NULL", "1", 1);
    db.query_row(
        &format!(
            "SELECT
               sum(s.trashed_at IS NULL),
               sum(s.trashed_at IS NOT NULL),
               sum(s.trashed_at IS NULL AND s.starred = 1),
               sum(s.trashed_at IS NULL AND NOT EXISTS (SELECT 1 FROM source_collections sc WHERE sc.source_id = s.id)),
               sum(s.trashed_at IS NULL AND s.index_status = 'ready'),
               sum(s.trashed_at IS NULL AND s.index_status IN ('pending','indexing')),
               sum(s.trashed_at IS NULL AND s.index_status IN ('failed','missing','no_text'))
             FROM sources s {clause}"
        ),
        params_from_iter(values.iter()),
        |r| {
            let n = |i: usize| r.get::<_, Option<i64>>(i).map(|v| v.unwrap_or(0));
            Ok(Counts { all: n(0)?, trashed: n(1)?, starred: n(2)?, unfiled: n(3)?, ready: n(4)?, indexing: n(5)?, attention: n(6)? })
        },
    )
    .map_err(e)
}

fn vector_blob(vector: &[f32]) -> Result<Vec<u8>> {
    if vector.len() != EMBEDDING_DIMENSIONS {
        return Err(format!("Expected a {EMBEDDING_DIMENSIONS}-dimension embedding, got {}", vector.len()));
    }
    Ok(vector.iter().flat_map(|v| v.to_le_bytes()).collect())
}

#[cfg(test)]
mod tests;
