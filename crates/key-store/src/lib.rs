// Workspace library database. One SQLite file holds sources (fixed bibliographic
// columns plus user JSON properties), collections, notes, annotations and the
// chunked text that full-text and vector search run over.
mod search;
pub use search::{SearchHit, SearchPassage, SearchQuery, SearchResult};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Once},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
pub const EMBEDDING_DIMENSIONS: usize = 768;
const MIGRATIONS: &[&str] = &[include_str!("migrations/001_initial.sql")];

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
];
const NUMBER_FIELDS: &[(&str, &str)] = &[
    ("year", "year"),
    ("durationSeconds", "duration_seconds"),
    ("fileSize", "file_size"),
    ("pageCount", "page_count"),
];

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
    #[serde(default)]
    pub year_from: Option<i64>,
    #[serde(default)]
    pub year_to: Option<i64>,
    /// title | year | added | updated | creator | container
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub descending: bool,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
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
            tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1)).map_err(e)?;
            tx.commit().map_err(e)?;
        }
        Ok(Self { root, conn: Arc::new(Mutex::new(conn)) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| "Library database lock poisoned".to_string())
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
                    patch_source_row(&tx, &id, &input_patch(input), now)?;
                    id
                }
                None => {
                    let id = new_id();
                    insert_source_row(&tx, &id, input, now)?;
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
            refresh_fts(&tx, id)?;
            tx.commit().map_err(e)?;
        }
        self.source(id)?.ok_or_else(|| "Source not found".into())
    }

    pub fn source(&self, id: &str) -> Result<Option<Source>> {
        let db = self.db()?;
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
        let db = self.db()?;
        let (clause, values) = where_clause(query);
        let order = match query.sort.as_deref().unwrap_or("added") {
            "title" => "s.title COLLATE NOCASE",
            "year" => "s.year",
            "updated" => "s.updated_at",
            "creator" => "json_extract(s.creators, '$[0].family') COLLATE NOCASE",
            "container" => "s.container_title COLLATE NOCASE",
            _ => "s.added_at",
        };
        let direction = if query.descending { "DESC" } else { "ASC" };
        let limit = query.limit.unwrap_or(200).min(2000);
        let total = db
            .query_row(
                &format!("SELECT count(*) FROM sources s {clause}"),
                params_from_iter(values.iter()),
                |r| r.get::<_, i64>(0),
            )
            .map_err(e)? as usize;
        let sql = format!(
            "{} {clause} ORDER BY {order} {direction} NULLS LAST, s.rowid {direction} LIMIT {limit} OFFSET {}",
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
            removed += tx.execute("DELETE FROM sources WHERE id = ?", [id]).map_err(e)?;
        }
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
        let db = self.db()?;
        let (clause, values) = where_clause(query);
        let facet = |sql: String| -> Result<Vec<Facet>> {
            let mut statement = db.prepare(&sql).map_err(e)?;
            let rows = statement
                .query_map(params_from_iter(values.iter()), |r| {
                    Ok(Facet { value: r.get::<_, Option<String>>(0)?.unwrap_or_default(), count: r.get(1)? })
                })
                .map_err(e)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(e);
            rows
        };
        Ok(Facets {
            tags: facet(format!(
                "SELECT t.value, count(*) FROM sources s, json_each(s.tags) t {clause} GROUP BY t.value ORDER BY count(*) DESC, t.value LIMIT 500"
            ))?,
            item_types: facet(format!(
                "SELECT s.item_type, count(*) FROM sources s {clause} GROUP BY s.item_type ORDER BY count(*) DESC"
            ))?,
            kinds: facet(format!(
                "SELECT s.kind, count(*) FROM sources s {clause} GROUP BY s.kind ORDER BY count(*) DESC"
            ))?,
            years: facet(format!(
                "SELECT CAST(s.year AS TEXT), count(*) FROM sources s {clause} {} s.year IS NOT NULL GROUP BY s.year ORDER BY s.year DESC",
                if clause.is_empty() { "WHERE" } else { "AND" }
            ))?,
        })
    }

    // ── Collections ─────────────────────────────────────────

    pub fn collections(&self) -> Result<Vec<Collection>> {
        let db = self.db()?;
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
            if parent == Some(id) {
                return Err("A collection cannot contain itself".into());
            }
            db.execute("UPDATE collections SET parent_id = ?2 WHERE id = ?1", params![id, parent]).map_err(e)?;
        }
        Ok(())
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
            .prepare("SELECT id, source_id, title, body, origin_key, created_at, updated_at FROM notes WHERE source_id = ? ORDER BY created_at")
            .map_err(e)?;
        statement
            .query_map([source_id], read_note)
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
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
        if let Some(source) = source_id {
            refresh_fts(&db, source)?;
        }
        db.query_row(
            "SELECT id, source_id, title, body, origin_key, created_at, updated_at FROM notes WHERE id = ?",
            [&id],
            read_note,
        )
        .map_err(e)
    }

    pub fn delete_note(&self, id: &str) -> Result<()> {
        self.db()?.execute("DELETE FROM notes WHERE id = ?", [id]).map(|_| ()).map_err(e)
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
                .prepare("INSERT INTO chunks(source_id, seq, page, start_seconds, text, rects) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
                .map_err(e)?;
            let mut vector = tx
                .prepare("INSERT INTO chunk_vectors(rowid, embedding) VALUES (?1, ?2)")
                .map_err(e)?;
            for (seq, chunk) in chunks.iter().enumerate() {
                let rects = (!chunk.rects.is_empty()).then(|| serde_json::to_string(&chunk.rects).unwrap_or_default());
                insert
                    .execute(params![source_id, seq as i64, chunk.page, chunk.start_seconds, chunk.text, rects])
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

    /// Chunks that have text but no vector yet, for back-filling once the model is ready.
    pub fn chunks_without_vectors(&self, limit: usize) -> Result<Vec<(i64, String, String)>> {
        let db = self.db()?;
        let mut statement = db
            .prepare(
                "SELECT c.id, s.title, c.text FROM chunks c JOIN sources s ON s.id = c.source_id
                 WHERE NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.rowid = c.id) ORDER BY c.id LIMIT ?",
            )
            .map_err(e)?;
        statement
            .query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
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
            for (id, vector) in vectors {
                statement.execute(params![id, vector_blob(vector)?]).map_err(e)?;
            }
        }
        tx.commit().map_err(e)
    }

    pub fn vector_count(&self) -> Result<i64> {
        self.db()?.query_row("SELECT count(*) FROM chunk_vectors", [], |r| r.get(0)).map_err(e)
    }

    pub fn passage(&self, chunk_id: i64) -> Result<Option<Passage>> {
        let db = self.db()?;
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
        let db = self.db()?;
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
    Ok(Source {
        id: text(index)?,
        kind: text(index + 1)?,
        creators: serde_json::from_str(&text(index + 2)?).unwrap_or_default(),
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
    })
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
        Value::Text(serde_json::to_string(&input.creators).map_err(e)?),
        Value::Text(serde_json::to_string(&normalize_tags(&input.tags)).map_err(e)?),
        Value::Text(Json::Object(input.properties.clone()).to_string()),
        input.origin.clone().map(Value::Text).unwrap_or(Value::Null),
        input.origin_key.clone().map(Value::Text).unwrap_or(Value::Null),
        Value::Integer(input.added_at.unwrap_or(now)),
        Value::Integer(now),
        Value::Text(input.index_status.clone().unwrap_or_else(|| "pending".into())),
    ];
    for (name, column) in TEXT_FIELDS.iter().chain(NUMBER_FIELDS) {
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
    for (name, column) in TEXT_FIELDS.iter().chain(NUMBER_FIELDS) {
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
        values.push(Value::Text(serde_json::to_string(&creators).map_err(e)?));
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
    if let Some(Json::Object(replace)) = patch.get("replaceProperties") {
        sets.push("properties = ?".into());
        values.push(Value::Text(Json::Object(replace.clone()).to_string()));
    } else if let Some(Json::Object(properties)) = patch.get("properties") {
        let current: String = db
            .query_row("SELECT properties FROM sources WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(e)?
            .ok_or("Source not found")?;
        let mut merged: Map<String, Json> = serde_json::from_str(&current).unwrap_or_default();
        for (key, value) in properties {
            if value.is_null() {
                merged.remove(key);
            } else {
                merged.insert(key.clone(), value.clone());
            }
        }
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
    Ok(())
}

/// Rewrites the metadata FTS row for one source (title, creators, notes, identifiers...).
fn refresh_fts(db: &Connection, id: &str) -> Result<()> {
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
    fts_terms(text).map(|terms| terms.join(" "))
}

/// Ranking syntax: any word may match; bm25 rewards passages that match more of them.
pub(crate) fn fts_any(text: &str) -> Option<String> {
    fts_terms(text).map(|terms| terms.join(" OR "))
}

fn fts_terms(text: &str) -> Option<Vec<String>> {
    const STOP: &[&str] = &["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"];
    let terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty() && !STOP.contains(&t.to_lowercase().as_str()))
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    (!terms.is_empty()).then_some(terms)
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
