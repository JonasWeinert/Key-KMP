mod tags;
mod attributes;
#[cfg(test)]
use flate2::{Compression, write::ZlibEncoder};
mod codec;
mod entries;
mod workspace;
pub use workspace::*;
mod lease;
mod publication;
mod purge;
mod writer;
pub use lease::ProcessingLease;
mod lifecycle;
mod metadata;
pub use metadata::*;
mod import;
pub use import::{Imports, SourceInfo, file_hash};
// Canonical, content-addressed library. Search indexes are derived artifacts.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct Library {
    root: PathBuf,
    writer: std::sync::Arc<writer::Writer>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub document_id: String,
    pub document_hash: String,
    pub title: String,
    pub page_count: usize,
    pub status: String,
    pub completed: usize,
    pub total: usize,
    pub error: Option<String>,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub added_at_ms: Option<i64>,
    pub has_source: bool,
    pub keyword_ready: bool,
    pub year: Option<i64>,
    pub authors: Vec<String>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    #[serde(default)]
    pub removed: bool,
    pub project_id: Option<String>,
    /// Bounded listing order; absent preserves newest-update-first behavior.
    pub sort: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub document_hashes: Option<Vec<String>>,
    pub year_from: Option<i64>,
    pub year_to: Option<i64>,
    pub author: Option<String>,
    pub has_annotations: Option<bool>,
    pub metadata_text: Option<String>,
    pub tag: Option<String>,
    pub collection: Option<String>,
    #[serde(default)]
    pub properties: std::collections::BTreeMap<String, serde_json::Value>,
}

/// A reusable read connection for bounded artifact consumers such as index builders.
pub struct ArtifactReader {
    connection: std::sync::Mutex<Connection>,
    library: Library,
}
impl ArtifactReader {
    pub fn block_text(&self, hash: &str, key: &str) -> Result<String> {
        self.connection.lock().map_err(|_|"Artifact reader lock poisoned")?.prepare_cached("SELECT text FROM block_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?1)) AND block_key=?2").map_err(err)?.query_row(params![hash,key],|row|row.get(0)).map_err(err)
    }
    pub fn get<T: DeserializeOwned>(
        &self,
        hash: &str,
        kind: &str,
        version: &str,
        key: &str,
    ) -> Result<Option<T>> {
        let bytes: Option<Vec<u8>> = {
            let conn = self
                .connection
                .lock()
                .map_err(|_| "Artifact reader lock poisoned")?;
            conn.prepare_cached("SELECT payload FROM artifact_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?1)) AND namespace_id=(SELECT id FROM artifact_namespaces WHERE kind=?2 AND version=?3) AND key=?4").map_err(err)?.query_row(params![hash,kind,version,key],|r|r.get(0)).optional().map_err(err)?
        };
        match bytes {
            None => Ok(None),
            Some(bytes) => match codec::decode(&bytes) {
                Ok(value) => Ok(Some(value)),
                Err(error)
                    if matches!(
                        kind,
                        "embedding"
                            | "native-page"
                            | "semantic-raw-page"
                            | "semantic-structure"
                            | "semantic-header"
                            | "analysis"
                            | "native-complete"
                    ) =>
                {
                    self.library
                        .discard_corrupt_artifact(hash, kind, version, key, bytes, error)?;
                    Ok(None)
                }
                Err(error) => Err(error),
            },
        }
    }
}
pub struct IndexReader {
    _generation_guard: fs::File,
    library: Library,
    connection: Connection,
}
impl IndexReader {
    pub fn path(&self, hash: &str, kind: &str, version: &str) -> Result<Option<PathBuf>> {
        let value: Option<String> = self.connection.prepare_cached("SELECT path FROM index_generations WHERE document_hash=?1 AND kind=?2 AND version=?3").map_err(err)?.query_row(params![hash,kind,version],|r|r.get(0)).optional().map_err(err)?;
        let Some(value) = value else {
            return Ok(None);
        };
        match fs::canonicalize(&value) {
            Ok(path) if path.starts_with(self.library.root()) && path.is_dir() => Ok(Some(path)),
            _ => {
                self.library.invalidate_index(
                    hash,
                    kind,
                    Path::new(&value),
                    "The index directory is missing or unavailable",
                )?;
                Ok(None)
            }
        }
    }
}

pub struct PassageReader(Connection);
impl PassageReader {
    pub fn passage(&self, id: &str) -> Result<Option<Passage>> {
        self.0.query_row("SELECT c.external_id,lower(hex(k.digest)),c.page,CAST(substr(CAST(b.text AS BLOB),c.context_start+1,c.context_end-c.context_start) AS TEXT),CAST(substr(CAST(b.text AS BLOB),c.target_start+1,c.target_end-c.target_start) AS TEXT),c.rects FROM passage_data c JOIN block_data b ON b.id=c.block_id JOIN content_keys k ON k.id=b.document_id WHERE c.external_id=?1 AND EXISTS(SELECT 1 FROM documents d WHERE d.hash=lower(hex(k.digest)) AND d.deleted_at IS NULL)",[id],|r| {
            let bytes:Vec<u8>=r.get(5)?;
            let rects=bytes.chunks_exact(8).map(|b|[u16::from_le_bytes([b[0],b[1]]),u16::from_le_bytes([b[2],b[3]]),u16::from_le_bytes([b[4],b[5]]),u16::from_le_bytes([b[6],b[7]])]).collect();
            Ok(Passage{id:r.get(0)?,document_hash:r.get(1)?,page:r.get::<_,u32>(2)? as usize,text:r.get(3)?,target_text:r.get(4)?,rects})
        }).optional().map_err(err)
    }
}
pub struct CanonicalBlock {
    pub key: String,
    pub text: String,
    pub chunks: Vec<ChunkAnchor>,
}
#[derive(Clone)]
pub struct ChunkAnchor {
    pub id: String,
    pub page: usize,
    pub context_start: usize,
    pub context_end: usize,
    pub target_start: usize,
    pub target_end: usize,
    pub rects: Vec<[u16; 4]>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: String,
    pub document_hash: String,
    pub page: usize,
    pub text: String,
    pub target_text: String,
    pub rects: Vec<[u16; 4]>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_hash(hash: &str) -> Result<()> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("invalid PDF content hash".into());
    }
    Ok(())
}

fn store_block_on(
    tx: &rusqlite::Transaction<'_>,
    hash: &str,
    key: &str,
    text: &str,
    chunks: &[ChunkAnchor],
) -> Result<()> {
    tx.execute("INSERT INTO block_data(document_id,block_key,text) VALUES((SELECT id FROM content_keys WHERE digest=unhex(?1)),?2,?3) ON CONFLICT(document_id,block_key) DO NOTHING",params![hash,key,text]).map_err(err)?;
    for c in chunks {
        if text.get(c.context_start..c.context_end).is_none()
            || text.get(c.target_start..c.target_end).is_none()
        {
            return Err("invalid chunk text offsets".into());
        }
        let rects = c
            .rects
            .iter()
            .flat_map(|r| r.iter().flat_map(|v| v.to_le_bytes()))
            .collect::<Vec<_>>();
        tx.execute("INSERT INTO passage_data(external_id,block_id,page,context_start,context_end,target_start,target_end,rects) VALUES(?1,(SELECT id FROM block_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?2)) AND block_key=?3),?4,?5,?6,?7,?8,?9) ON CONFLICT(external_id) DO UPDATE SET block_id=excluded.block_id,page=excluded.page,context_start=excluded.context_start,context_end=excluded.context_end,target_start=excluded.target_start,target_end=excluded.target_end,rects=excluded.rects",params![c.id,hash,key,c.page as i64,c.context_start as i64,c.context_end as i64,c.target_start as i64,c.target_end as i64,rects]).map_err(err)?;
    }

    Ok(())
}

impl Library {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root: PathBuf = root.into();
        fs::create_dir_all(root.join("sources")).map_err(err)?;
        let root = fs::canonicalize(root).map_err(err)?;
        let library = Self {
            writer: writer::Writer::for_root(&root)?,
            root,
        };
        let conn = library.connection()?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(err)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(err)?;
        if version > 12 {
            return Err("library was created by a newer Key version".into());
        }
        if version > 0 && version < 12 {
            let backup = library
                .root
                .join(format!("library-before-v{version}-migration.sqlite3"));
            if !backup.exists() {
                conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
                    .map_err(err)?;
            }
        }
        if version == 0 {
            conn.execute_batch(include_str!("migrations/001_initial.sql"))
                .map_err(err)?;
        }
        if version < 2 {
            conn.execute_batch(include_str!("migrations/002_indexes_properties_jobs.sql"))
                .map_err(err)?;
        }
        if version < 3 {
            conn.execute_batch(include_str!("migrations/003_metadata.sql"))
                .map_err(err)?;
        }
        if version < 4 {
            conn.execute_batch(include_str!("migrations/004_lifecycle.sql"))
                .map_err(err)?;
        }
        if version < 5 {
            conn.execute_batch(include_str!("migrations/005_leases.sql"))
                .map_err(err)?;
        }
        if version < 6 {
            conn.execute_batch(include_str!("migrations/006_metadata_search.sql"))
                .map_err(err)?;
        }
        if version < 7 {
            conn.execute_batch(include_str!("migrations/007_compact_content.sql"))
                .map_err(err)?;
        }
        if version < 8 {
            conn.execute_batch(include_str!("migrations/008_purge.sql"))
                .map_err(err)?;
        }
        if version < 9 {
            conn.execute_batch(include_str!("migrations/009_publication.sql"))
                .map_err(err)?;
        }
        if version < 10 {
            conn.execute_batch(include_str!("migrations/010_workspace.sql"))
                .map_err(err)?;
        }
        if version < 11 {
            conn.execute_batch(include_str!("migrations/011_record_path.sql"))
                .map_err(err)?;
        }
        if version < 12 {
            conn.execute_batch(include_str!("migrations/012_source_entries.sql"))
                .map_err(err)?;
        }
        library.recover_publications()?;
        Ok(library)
    }
    pub fn artifact_count(&self, hash: &str, kind: &str) -> Result<usize> {
        self.connection()?.query_row("SELECT count(*) FROM artifact_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?1)) AND namespace_id IN (SELECT id FROM artifact_namespaces WHERE kind=?2)",params![hash,kind],|row|Ok(row.get::<_,i64>(0)? as usize)).map_err(err)
    }
    pub fn extraction_progress(&self, hash: &str) -> Result<Option<(usize, usize)>> {
        self.connection()?
            .query_row(
                "SELECT completed,total FROM documents WHERE hash=?1 AND status='processing'",
                [hash],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as usize,
                        row.get::<_, i64>(1)? as usize,
                    ))
                },
            )
            .optional()
            .map_err(err)
    }
    pub fn artifact_reader(&self) -> Result<ArtifactReader> {
        Ok(ArtifactReader {
            connection: std::sync::Mutex::new(self.connection()?),
            library: self.clone(),
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn pause(&self, hash: &str, paused: bool) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction().map_err(err)?;
        tx.execute("INSERT INTO jobs(document_hash,paused,updated_at) VALUES(?1,?2,?3) ON CONFLICT(document_hash) DO UPDATE SET paused=excluded.paused,updated_at=excluded.updated_at",params![hash,paused,now_ms()]).map_err(err)?;
        tx.execute(
            "UPDATE documents SET status=?2,error=NULL,updated_at=?3 WHERE hash=?1",
            params![hash, if paused { "paused" } else { "queued" }, now_ms()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }
    pub fn is_paused(&self, hash: &str) -> Result<bool> {
        self.connection()?
            .query_row(
                "SELECT paused FROM jobs WHERE document_hash=?1",
                [hash],
                |r| r.get(0),
            )
            .optional()
            .map(|v| v.unwrap_or(false))
            .map_err(err)
    }
    fn generation_lock_file(&self) -> Result<fs::File> {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("index-readers.lock"))
            .map_err(err)
    }
    fn pin_generations(&self) -> Result<fs::File> {
        let guard = self.generation_lock_file()?;
        guard.lock_shared().map_err(err)?;
        Ok(guard)
    }
    pub fn index_reader(&self) -> Result<IndexReader> {
        Ok(IndexReader {
            _generation_guard: self.pin_generations()?,
            library: self.clone(),
            connection: self.connection()?,
        })
    }
    pub fn index_path(&self, hash: &str, kind: &str, version: &str) -> Result<Option<PathBuf>> {
        self.index_reader()?.path(hash, kind, version)
    }

    pub fn set_property(&self, hash: &str, name: &str, value: &serde_json::Value) -> Result<()> {
        if name.trim().is_empty()
            || name.len() > 128
            || !(value.is_null() || value.is_boolean() || value.is_number() || value.is_string())
        {
            return Err("properties require a name and a scalar value".into());
        }
        let hash = hash.to_owned();
        let name = name.to_owned();
        let value = value.clone();
        self.writer.run(true, move |conn| {
        let tx = conn.transaction().map_err(err)?;
        if !value.is_null() {
            let kind = if value.is_string() {
                "text"
            } else if value.is_number() {
                "number"
            } else {
                "boolean"
            };
            tx.execute(
                "INSERT OR IGNORE INTO property_definitions(name,kind) VALUES(?1,?2)",
                params![name, kind],
            )
            .map_err(err)?;
            let existing: String = tx
                .query_row(
                    "SELECT kind FROM property_definitions WHERE name=?1",
                    [&name],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if existing != kind {
                return Err(format!("Property {name} requires {existing} values"));
            }
        }
        tx.execute("INSERT INTO document_properties(document_hash,name,value) VALUES(?1,?2,?3) ON CONFLICT(document_hash,name) DO UPDATE SET value=excluded.value",params![hash,name,value.to_string()]).map_err(err)?;
        tx.execute("INSERT INTO metadata_observations(document_hash,field,value,producer,observed_at) VALUES(?1,?2,?3,'user',?4)",params![hash,format!("property:{name}"),value.to_string(),now_ms()]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
        })
    }
    pub fn block_text(&self, hash: &str, key: &str) -> Result<String> {
        self.connection()?
            .query_row(
                "SELECT text FROM block_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?1)) AND block_key=?2",
                params![hash, key],
                |r| r.get(0),
            )
            .map_err(err)
    }
    pub fn store_block(
        &self,
        hash: &str,
        key: &str,
        text: &str,
        chunks: &[ChunkAnchor],
    ) -> Result<()> {
        let hash = hash.to_owned();
        let key = key.to_owned();
        let text = text.to_owned();
        let chunks = chunks.to_vec();
        self.writer.run(false, move |conn| {
            let tx = conn.transaction().map_err(err)?;
            store_block_on(&tx, &hash, &key, &text, &chunks)?;
            tx.commit().map_err(err)
        })
    }
    /// Page structure and its anchors become durable together. A reader cannot
    /// observe a published page whose canonical block transaction failed.
    pub fn store_semantic_page<T: Serialize>(
        &self,
        hash: &str,
        version: &str,
        key: &str,
        structure: &T,
        blocks: Vec<CanonicalBlock>,
    ) -> Result<()> {
        let bytes = codec::encode("semantic-structure", structure)?;
        let hash = hash.to_owned();
        let version = version.to_owned();
        let key = key.to_owned();
        self.writer.run(false, move |conn| {
            let tx=conn.transaction().map_err(err)?;
            for block in &blocks { store_block_on(&tx,&hash,&block.key,&block.text,&block.chunks)?; }
            tx.execute("INSERT OR IGNORE INTO artifact_namespaces(kind,version) VALUES('semantic-structure',?1)",[&version]).map_err(err)?;
            tx.execute("INSERT INTO artifact_data(document_id,namespace_id,key,payload) VALUES((SELECT id FROM content_keys WHERE digest=unhex(?1)),(SELECT id FROM artifact_namespaces WHERE kind='semantic-structure' AND version=?2),?3,?4) ON CONFLICT(document_id,namespace_id,key) DO UPDATE SET payload=excluded.payload",params![hash,version,key,bytes]).map_err(err)?;
            tx.commit().map_err(err)
        })
    }
    pub fn passage_reader(&self) -> Result<PassageReader> {
        Ok(PassageReader(self.connection()?))
    }
    pub fn passage(&self, id: &str) -> Result<Option<Passage>> {
        self.passage_reader()?.passage(id)
    }
    fn connection(&self) -> Result<Connection> {
        let c = Connection::open(self.root.join("library.sqlite3")).map_err(err)?;
        c.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        c.pragma_update(None, "foreign_keys", "ON").map_err(err)?;
        c.pragma_update(None, "synchronous", "FULL").map_err(err)?;
        Ok(c)
    }
    pub fn register(&self, hash: &str, title: &str, pages: usize) -> Result<()> {
        valid_hash(hash)?;
        if self.is_purged(hash)? {
            return Err("Document was permanently deleted".into());
        }
        self.connection()?.execute("INSERT INTO documents(hash,title,page_count,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(hash) DO UPDATE SET page_count=CASE WHEN excluded.page_count>0 THEN excluded.page_count ELSE documents.page_count END,updated_at=excluded.updated_at", params![hash,title,pages as i64,now_ms()]).map_err(err)?;
        Ok(())
    }
    pub fn store_source(&self, bytes: &[u8], title: &str, pages: usize) -> Result<String> {
        let hash = content_hash(bytes);
        self.prepare_reimport(&hash)?;
        let path = self.root.join("sources").join(format!("{hash}.pdf"));
        if !path.exists() {
            let mut temp =
                tempfile::NamedTempFile::new_in(self.root.join("sources")).map_err(err)?;
            temp.write_all(bytes).map_err(err)?;
            temp.as_file().sync_all().map_err(err)?;
            match temp.persist_noclobber(&path) {
                Ok(_) => {}
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(err(e)),
            }
        }
        self.register(&hash, title, pages)?;
        self.connection()?
            .execute("UPDATE documents SET has_source=1 WHERE hash=?1", [&hash])
            .map_err(err)?;
        Ok(hash)
    }
    pub fn source_path(&self, hash: &str) -> Result<PathBuf> {
        valid_hash(hash)?;
        let path = self.root.join("sources").join(format!("{hash}.pdf"));
        if !path.is_file() {
            return Err(
                "The source PDF is unavailable. Open the original PDF to relink it.".into(),
            );
        }
        Ok(path)
    }
    pub fn progress(
        &self,
        hash: &str,
        status: &str,
        completed: usize,
        total: usize,
        error: Option<String>,
    ) -> Result<()> {
        self.connection()?.execute("UPDATE documents SET status=?2,completed=?3,total=?4,error=?5,updated_at=?6 WHERE hash=?1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE document_hash=?1 AND paused=1)",params![hash,status,completed as i64,total as i64,error,now_ms()]).map_err(err)?;
        Ok(())
    }
    pub fn keyword_ready(&self, hash: &str) -> Result<()> {
        self.connection()?
            .execute("UPDATE documents SET keyword_ready=1 WHERE hash=?1", [hash])
            .map_err(err)?;
        Ok(())
    }
    pub fn documents(&self, filter: &Filter) -> Result<Vec<Document>> {
        self.document_window(filter, i64::MAX, 0)
            .map(|(documents, _)| documents)
    }
    pub fn documents_page(
        &self,
        filter: &Filter,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<Document>, usize)> {
        self.document_window(
            filter,
            limit.clamp(1, 500) as i64,
            offset.min(i64::MAX as usize) as i64,
        )
    }
    fn document_window(
        &self,
        filter: &Filter,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Document>, usize)> {
        let conn = self.connection()?;
        let metadata = filter
            .metadata_text
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("\"{}\"", s.replace('"', "\"\"")));
        let properties = serde_json::to_string(&filter.properties).map_err(err)?;
        let statuses = filter.statuses.as_ref().map(serde_json::to_string).transpose().map_err(err)?;
        let hashes = filter.document_hashes.as_ref().map(serde_json::to_string).transpose().map_err(err)?;
        let bindings = params![
            filter.year_from,
            filter.year_to,
            filter.author,
            filter.has_annotations,
            metadata,
            properties,
            filter.tag,
            filter.collection,
            filter.removed,
            filter.project_id,
            statuses,
            hashes
        ];
        let sql = "SELECT hash,title,page_count,status,completed,total,error,updated_at,has_source,keyword_ready,year,authors,added_at FROM documents d WHERE (deleted_at IS NOT NULL)=?9 AND (?10 IS NULL OR EXISTS(SELECT 1 FROM workspace_project_records pr JOIN workspace_records wr ON wr.id=pr.record_id WHERE pr.project_id=?10 AND wr.document_hash=d.hash)) AND (?1 IS NULL OR year>=?1) AND (?2 IS NULL OR year<=?2) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM document_authors a WHERE a.document_hash=d.hash AND a.name=?3 COLLATE NOCASE)) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM annotations a WHERE a.document_hash=d.hash)=?4) AND (?5 IS NULL OR hash IN (SELECT hash FROM metadata_fts WHERE metadata_fts MATCH ?5) OR hash IN (SELECT document_hash FROM comment_fts WHERE comment_fts MATCH ?5) OR hash IN (SELECT document_hash FROM extra_metadata_fts WHERE extra_metadata_fts MATCH ?5)) AND NOT EXISTS(SELECT 1 FROM json_each(?6) f WHERE NOT EXISTS(SELECT 1 FROM document_properties p WHERE p.document_hash=d.hash AND p.name=f.key AND (json_type(p.value)=f.type OR (json_type(p.value) IN ('integer','real') AND f.type IN ('integer','real'))) AND json_extract(p.value,'$') IS f.value)) AND (?7 IS NULL OR EXISTS(SELECT 1 FROM document_labels l WHERE l.document_hash=d.hash AND l.kind='tag' AND l.name=?7)) AND (?8 IS NULL OR EXISTS(SELECT 1 FROM document_labels l WHERE l.document_hash=d.hash AND l.kind='collection' AND l.name=?8)) AND (?11 IS NULL OR d.status IN (SELECT value FROM json_each(?11))) AND (?12 IS NULL OR d.hash IN (SELECT value FROM json_each(?12)))";
        let order = match filter.sort.as_deref() {
            Some("title") => "title COLLATE NOCASE ASC, hash ASC",
            Some("year") => "year DESC, title COLLATE NOCASE ASC, hash ASC",
            Some("updated") | None => "updated_at DESC, hash ASC",
            Some(_) => return Err("Unsupported document sort".into()),
        };
        let total = if limit == i64::MAX {
            0
        } else {
            conn.query_row(
                &format!(
                    "SELECT count(*) FROM ({})",
                    sql.split(" ORDER BY").next().unwrap_or(sql)
                ),
                bindings,
                |r| r.get::<_, i64>(0),
            )
            .map_err(err)? as usize
        };
        let mut q = conn
            .prepare(&format!("{sql} ORDER BY {order} LIMIT ?13 OFFSET ?14"))
            .map_err(err)?;
        let mut page_bindings = bindings.to_vec();
        page_bindings.push(&limit);
        page_bindings.push(&offset);
        let rows = q
            .query_map(page_bindings.as_slice(), |r| {
                let hash: String = r.get(0)?;
                let authors: String = r.get(11)?;
                Ok(Document {
                    document_id: hash.clone(),
                    document_hash: hash,
                    title: r.get(1)?,
                    page_count: r.get::<_, u32>(2)? as usize,
                    status: r.get(3)?,
                    completed: r.get::<_, u32>(4)? as usize,
                    total: r.get::<_, u32>(5)? as usize,
                    error: r.get(6)?,
                    updated_at_ms: r.get(7)?,
                    added_at_ms: r.get(12)?,
                    has_source: r.get(8)?,
                    keyword_ready: r.get(9)?,
                    year: r.get(10)?,
                    authors: serde_json::from_str(&authors).unwrap_or_default(),
                })
            })
            .map_err(err)?;
        let documents = rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok((documents, total))
    }
    /// Counts cover the entire workspace/project, independently of a page or status tab.
    pub fn document_status_counts(&self, project_id: Option<&str>) -> Result<serde_json::Value> {
        let conn = self.connection()?;
        let mut query = conn.prepare("SELECT status,deleted_at IS NOT NULL,count(*) FROM documents d WHERE (?1 IS NULL OR EXISTS(SELECT 1 FROM workspace_project_records pr JOIN workspace_records wr ON wr.id=pr.record_id WHERE pr.project_id=?1 AND wr.document_hash=d.hash)) GROUP BY status,deleted_at IS NOT NULL").map_err(err)?;
        let rows = query.query_map([project_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,i64>(2)?))).map_err(err)?;
        let (mut all,mut removed,mut searchable,mut processing,mut attention)=(0i64,0i64,0i64,0i64,0i64);
        for row in rows {
            let (status,is_removed,count)=row.map_err(err)?;
            if is_removed { removed+=count; continue; }
            all+=count;
            match status.as_str() {
                "indexed" => searchable+=count,
                "queued"|"processing"|"indexing" => processing+=count,
                "failed"|"paused"|"needs_source"|"no_text" => attention+=count,
                _=>{}
            }
        }
        Ok(serde_json::json!({"all":all,"removed":removed,"searchable":searchable,"processing":processing,"attention":attention}))
    }
    pub fn update_metadata(
        &self,
        hash: &str,
        title: &str,
        year: Option<i64>,
        authors: &[String],
    ) -> Result<()> {
        let hash = hash.to_owned();
        let title = title.to_owned();
        let authors = authors.to_vec();
        self.writer.run(true, move |conn| {
        let tx = conn.transaction().map_err(err)?;
        tx.execute(
            "UPDATE documents SET title=?2,year=?3,authors=?4,updated_at=?5 WHERE hash=?1",
            params![
                hash,
                title,
                year,
                serde_json::to_string(&authors).map_err(err)?,
                now_ms()
            ],
        )
        .map_err(err)?;
        for (field, value) in [
            ("title", serde_json::json!(title)),
            ("year", serde_json::json!(year)),
            ("authors", serde_json::json!(authors)),
        ] {
            tx.execute("INSERT INTO metadata_observations(document_hash,field,value,producer,observed_at) VALUES(?1,?2,?3,'user',?4)",params![hash,field,value.to_string(),now_ms()]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(())
        })
    }
    /// Compressed per-page artifacts; large geometry is never returned by list/progress APIs.
    pub fn put<T: Serialize>(
        &self,
        hash: &str,
        kind: &str,
        version: &str,
        key: &str,
        value: &T,
    ) -> Result<()> {
        let bytes = codec::encode(kind, value)?;
        let hash = hash.to_owned();
        let kind = kind.to_owned();
        let version = version.to_owned();
        let key = key.to_owned();
        self.writer.run(false, move |conn| {
        let tx = conn.transaction().map_err(err)?;
        tx.execute("INSERT INTO artifact_namespaces(kind,version) VALUES(?1,?2) ON CONFLICT(kind,version) DO NOTHING", params![kind,version]).map_err(err)?;
        tx.execute("INSERT INTO artifact_data(document_id,namespace_id,key,payload) VALUES((SELECT id FROM content_keys WHERE digest=unhex(?1)),(SELECT id FROM artifact_namespaces WHERE kind=?2 AND version=?3),?4,?5) ON CONFLICT(document_id,namespace_id,key) DO UPDATE SET payload=excluded.payload",params![hash,kind,version,key,bytes]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
        })
    }
    pub fn get<T: DeserializeOwned>(
        &self,
        hash: &str,
        kind: &str,
        version: &str,
        key: &str,
    ) -> Result<Option<T>> {
        self.artifact_reader()?.get(hash, kind, version, key)
    }
    fn discard_corrupt_artifact(
        &self,
        hash: &str,
        kind: &str,
        version: &str,
        key: &str,
        expected: Vec<u8>,
        detail: String,
    ) -> Result<()> {
        let hash = hash.to_owned();
        let kind = kind.to_owned();
        let version = version.to_owned();
        let key = key.to_owned();
        self.writer.run(false,move |conn| {
            let tx=conn.transaction().map_err(err)?;
            let changed=tx.execute("DELETE FROM artifact_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?1)) AND namespace_id=(SELECT id FROM artifact_namespaces WHERE kind=?2 AND version=?3) AND key=?4 AND payload=?5",params![hash,kind,version,key,expected]).map_err(err)?;
            if changed>0 { tx.execute("INSERT INTO maintenance_events(document_hash,kind,detail,created_at) VALUES(?1,'corrupt-artifact',?2,?3)",params![hash,format!("{kind}/{version}/{key}: {detail}"),now_ms()]).map_err(err)?; }
            tx.commit().map_err(err)
        })
    }
    pub fn annotations(&self, hash: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.connection()?;
        let mut q = conn
            .prepare("SELECT payload FROM annotations WHERE document_hash=?1 ORDER BY id")
            .map_err(err)?;
        let values = q
            .query_map([hash], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        values
            .into_iter()
            .map(|s| serde_json::from_str(&s).map_err(err))
            .collect()
    }
    pub fn apply_annotations(
        &self,
        hash: &str,
        upserts: &[serde_json::Value],
        deleted: &[String],
    ) -> Result<()> {
        valid_hash(hash)?;
        let hash = hash.to_owned();
        let upserts = upserts.to_vec();
        let deleted = deleted.to_vec();
        self.writer.run(true, move |conn| {
            let tx = conn.transaction().map_err(err)?;
            for id in &deleted {
                tx.execute(
                    "DELETE FROM annotations WHERE document_hash=?1 AND id=?2",
                    params![hash, id],
                )
                .map_err(err)?;
            }
            for value in &upserts {
                let id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or("annotation has no ID")?;
                if value.get("documentId").and_then(|v| v.as_str()) != Some(hash.as_str()) {
                    return Err("annotation belongs to another document".into());
                }
                tx.execute(
                    "DELETE FROM annotations WHERE document_hash=?1 AND id=?2",
                    params![hash, id],
                )
                .map_err(err)?;
                tx.execute(
                    "INSERT INTO annotations(id,document_hash,payload,comment) VALUES(?1,?2,?3,?4)",
                    params![
                        id,
                        hash,
                        serde_json::to_string(value).map_err(err)?,
                        value.get("comment").and_then(|v| v.as_str()).unwrap_or("")
                    ],
                )
                .map_err(err)?;
            }
            tx.commit().map_err(err)
        })
    }
    pub fn save_annotations(&self, hash: &str, values: &[serde_json::Value]) -> Result<()> {
        valid_hash(hash)?;
        let hash = hash.to_owned();
        let values = values.to_vec();
        self.writer.run(true, move |conn| {
            let tx = conn.transaction().map_err(err)?;
            tx.execute("DELETE FROM annotations WHERE document_hash=?1", [&hash])
                .map_err(err)?;
            for value in &values {
                let id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or("annotation has no ID")?;
                if value.get("documentId").and_then(|v| v.as_str()) != Some(hash.as_str()) {
                    return Err("annotation belongs to another document".into());
                }
                tx.execute(
                    "INSERT INTO annotations(id,document_hash,payload,comment) VALUES(?1,?2,?3,?4)",
                    params![
                        id,
                        hash,
                        serde_json::to_string(value).map_err(err)?,
                        value.get("comment").and_then(|v| v.as_str()).unwrap_or("")
                    ],
                )
                .map_err(err)?;
            }
            tx.commit().map_err(err)
        })
    }
    pub fn import_annotations(
        &self,
        hash: &str,
        legacy_id: &str,
        values: &[serde_json::Value],
    ) -> Result<()> {
        let hash = hash.to_owned();
        let legacy_id = legacy_id.to_owned();
        let values = values.to_vec();
        self.writer.run(true, move |conn| {
        let tx = conn.transaction().map_err(err)?;
        for value in &values {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("legacy annotation has no ID")?;
            let receipt = format!("{legacy_id}:{id}");
            let added = tx
                .execute(
                    "INSERT OR IGNORE INTO legacy_imports(receipt) VALUES(?1)",
                    [receipt],
                )
                .map_err(err)?;
            if added == 0 {
                continue;
            }
            let mut value = value.clone();
            value["documentId"] = hash.clone().into();
            tx.execute("INSERT OR IGNORE INTO annotations(id,document_hash,payload,comment) VALUES(?1,?2,?3,?4)",params![id,hash,serde_json::to_string(&value).map_err(err)?,value.get("comment").and_then(|v|v.as_str()).unwrap_or("")]).map_err(err)?;
        }
        tx.commit().map_err(err)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_timestamp_is_immutable_and_historical_unknown_is_null() {
        let dir=tempfile::tempdir().unwrap();
        let lib=Library::open(dir.path()).unwrap();
        let hash=lib.store_source(b"added-time","Original",1).unwrap();
        let timestamp=lib.documents(&Filter::default()).unwrap()[0].added_at_ms;
        assert!(timestamp.is_some_and(|time|time>0));
        lib.update_metadata(&hash,"Renamed",Some(2026),&[]).unwrap();
        assert_eq!(lib.documents(&Filter::default()).unwrap()[0].added_at_ms,timestamp);
        // Simulate a row created before migration12; future metadata edits do not invent history.
        lib.connection().unwrap().execute("UPDATE documents SET added_at=NULL WHERE hash=?1",[&hash]).unwrap();
        lib.update_metadata(&hash,"Historical",None,&[]).unwrap();
        assert_eq!(lib.documents(&Filter::default()).unwrap()[0].added_at_ms,None);
    }
    #[test]
    fn document_page_sorts_and_filters_before_limit_with_project_counts() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(&dir.path().join(".key")).unwrap();
        lib.initialize_workspace("Test",dir.path()).unwrap();
        let z=lib.store_source(b"sort-z","Zebra",1).unwrap();
        let a=lib.store_source(b"sort-a","alpha",1).unwrap();
        let m=lib.store_source(b"sort-m","Middle",1).unwrap();
        lib.update_metadata(&z,"Zebra",Some(2025),&[]).unwrap();
        lib.update_metadata(&a,"alpha",Some(2020),&[]).unwrap();
        lib.connection().unwrap().execute("UPDATE documents SET status='failed' WHERE hash=?1",[&a]).unwrap();
        let filter=Filter{sort:Some("title".into()),..Filter::default()};
        let (first,total)=lib.documents_page(&filter,1,0).unwrap();
        assert_eq!(total,3); assert_eq!(first[0].document_hash,a);
        assert_eq!(lib.documents_page(&filter,1,1).unwrap().0[0].document_hash,m);
        assert_eq!(lib.documents_page(&Filter{sort:Some("year".into()),..Filter::default()},1,0).unwrap().0[0].document_hash,z);
        assert_eq!(lib.documents_page(&Filter{statuses:Some(vec!["failed".into()]),..Filter::default()},1,0).unwrap().1,1);
        assert_eq!(lib.documents_page(&Filter{document_hashes:Some(vec![]),..Filter::default()},1,0).unwrap().1,0);
        assert_eq!(lib.documents_page(&Filter{document_hashes:Some(vec![z.clone()]),..Filter::default()},1,0).unwrap().0[0].document_hash,z);
        let project=lib.create_project("One").unwrap();
        lib.set_project_membership(&project.id,&format!("source:{a}"),true).unwrap();
        let counts=lib.document_status_counts(Some(&project.id)).unwrap();
        assert_eq!(counts["all"],1);assert_eq!(counts["attention"],1);
        assert_eq!(lib.document_status_counts(None).unwrap()["all"],3);
        assert!(lib.documents_page(&Filter{sort:Some("bad SQL".into()),..Filter::default()},1,0).is_err());
    }
    #[test]
    fn bundled_sqlite_includes_wal_locking_and_reset_fixes() {
        assert!(
            rusqlite::version_number() >= 3_051_003,
            "SQLite {} predates required WAL fixes",
            rusqlite::version()
        );
    }
    #[test]
    fn corrupt_derived_artifact_is_discarded_and_can_be_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let hash = lib.store_source(b"corrupt-page", "Corruption", 1).unwrap();
        lib.put(&hash, "native-page", "pdfium-v4", "0", &vec![1.0_f32])
            .unwrap();
        lib.connection()
            .unwrap()
            .execute("UPDATE artifact_data SET payload=x'010203'", [])
            .unwrap();
        assert!(
            lib.get::<Vec<f32>>(&hash, "native-page", "pdfium-v4", "0")
                .unwrap()
                .is_none()
        );
        assert_eq!(lib.artifact_count(&hash, "native-page").unwrap(), 0);
        assert_eq!(
            lib.connection()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM maintenance_events WHERE kind='corrupt-artifact'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        lib.put(&hash, "native-page", "pdfium-v4", "0", &vec![2.0_f32])
            .unwrap();
        assert_eq!(
            lib.get::<Vec<f32>>(&hash, "native-page", "pdfium-v4", "0")
                .unwrap()
                .unwrap(),
            vec![2.0]
        );
    }
    #[test]
    fn failed_page_transaction_exposes_neither_structure_nor_anchors() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let hash = lib.store_source(b"page-transaction", "Page", 1).unwrap();
        let result = lib.store_semantic_page(
            &hash,
            "v4",
            "false:0",
            &serde_json::json!({"page":0}),
            vec![CanonicalBlock {
                key: "block".into(),
                text: "é".into(),
                chunks: vec![ChunkAnchor {
                    id: "invalid".into(),
                    page: 0,
                    context_start: 0,
                    context_end: 2,
                    target_start: 1,
                    target_end: 2,
                    rects: vec![],
                }],
            }],
        );
        assert!(result.is_err());
        assert!(
            lib.get::<serde_json::Value>(&hash, "semantic-structure", "v4", "false:0")
                .unwrap()
                .is_none()
        );
        assert!(lib.block_text(&hash, "block").is_err());
        assert!(lib.passage("invalid").unwrap().is_none());
    }
    #[test]
    fn canonical_source_metadata_and_annotations_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let l = Library::open(dir.path()).unwrap();
        let hash = l.store_source(b"PDF bytes", "Paper", 12).unwrap();
        assert_eq!(
            l.store_source(b"PDF bytes", "renamed.pdf", 12).unwrap(),
            hash
        );
        l.update_metadata(&hash, "Paper", Some(2024), &["Alice".into()])
            .unwrap();
        let annotation = serde_json::json!({"id":"a","documentId":hash,"comment":"note","range":{"start":{"page":0,"index":0},"end":{"page":0,"index":2}}});
        l.save_annotations(&hash, &[annotation.clone()]).unwrap();
        l.put(&hash, "page", "v1", "0", &vec![1, 2, 3]).unwrap();
        drop(l);
        let l = Library::open(dir.path()).unwrap();
        assert_eq!(l.annotations(&hash).unwrap(), vec![annotation]);
        assert_eq!(
            l.get::<Vec<i32>>(&hash, "page", "v1", "0").unwrap(),
            Some(vec![1, 2, 3])
        );
        assert!(
            l.get::<Vec<i32>>(&hash, "page", "v2", "0")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            l.documents(&Filter {
                year_from: Some(2023),
                author: Some("alice".into()),
                has_annotations: Some(true),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
        assert!(
            l.documents(&Filter {
                year_from: Some(2025),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
        );
        assert!(l.source_path("../../etc").is_err());
    }
    #[test]
    fn invalid_annotation_batch_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let l = Library::open(dir.path()).unwrap();
        let hash = l.store_source(b"x", "x", 1).unwrap();
        let a = serde_json::json!({"id":"a","documentId":hash});
        l.save_annotations(&hash, &[a.clone()]).unwrap();
        assert!(
            l.save_annotations(&hash, &[serde_json::json!({"id":"b","documentId":"wrong"})])
                .is_err()
        );
        assert_eq!(l.annotations(&hash).unwrap(), vec![a]);
    }
    #[test]
    fn unicode_anchors_filters_and_publication_are_durable() {
        let dir = tempfile::tempdir().unwrap();
        let l = Library::open(dir.path()).unwrap();
        let hash = l.store_source(b"doc", "Café methods", 2).unwrap();
        let text = "αβ Café 🦀. Next.";
        let start = text.find("Café").unwrap();
        let end = text.find(" Next").unwrap();
        l.store_block(
            &hash,
            "b",
            text,
            &[ChunkAnchor {
                id: "c".into(),
                page: 1,
                context_start: 0,
                context_end: text.len(),
                target_start: start,
                target_end: end,
                rects: vec![[1, 2, 3, 4]],
            }],
        )
        .unwrap();
        let p = l.passage("c").unwrap().unwrap();
        assert_eq!(p.target_text, "Café 🦀.");
        assert_eq!(p.text, text);
        l.set_property(&hash, "reviewed", &serde_json::json!(true))
            .unwrap();
        let mut filter = Filter {
            metadata_text: Some("Café".into()),
            ..Default::default()
        };
        filter
            .properties
            .insert("reviewed".into(), serde_json::json!(true));
        assert_eq!(l.documents(&filter).unwrap().len(), 1);
        filter
            .properties
            .insert("reviewed".into(), serde_json::json!("true"));
        assert!(l.documents(&filter).unwrap().is_empty());
        l.pause(&hash, true).unwrap();
        l.progress(&hash, "indexed", 4, 4, None).unwrap();
        assert_eq!(l.documents(&Filter::default()).unwrap()[0].status, "paused");
        let generation = dir.path().join("index-v1");
        fs::create_dir(&generation).unwrap();
        assert!(
            l.publish_index(&hash, "lexical", "v1", &generation)
                .unwrap_err()
                .contains("paused")
        );
        l.pause(&hash, false).unwrap();
        l.publish_index(&hash, "lexical", "v1", &generation)
            .unwrap();
        assert!(
            l.publish_index(&hash, "lexical", "v1", &dir.path().join("missing"))
                .is_err()
        );
        let reopened = Library::open(dir.path()).unwrap();
        assert_eq!(
            reopened.index_path(&hash, "lexical", "v1").unwrap(),
            Some(fs::canonicalize(generation).unwrap())
        );
        let result: String = reopened
            .connection()
            .unwrap()
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(result, "ok");
    }
    #[test]
    fn comment_fts_tracks_replacement_and_legacy_receipts_prevent_resurrection() {
        let dir = tempfile::tempdir().unwrap();
        let l = Library::open(dir.path()).unwrap();
        let hash = l.store_source(b"a", "Paper", 1).unwrap();
        let a = serde_json::json!({"id":"a","documentId":"legacy","comment":"remarkable"});
        l.import_annotations(&hash, "legacy", &[a.clone()]).unwrap();
        assert_eq!(
            l.documents(&Filter {
                metadata_text: Some("remarkable".into()),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
        l.save_annotations(&hash, &[]).unwrap();
        l.import_annotations(&hash, "legacy", &[a]).unwrap();
        assert!(l.annotations(&hash).unwrap().is_empty());
        assert!(
            l.documents(&Filter {
                metadata_text: Some("remarkable".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
        );
    }
}

#[cfg(test)]
mod compact_migration_tests {
    use super::*;
    #[test]
    fn upgrades_populated_v6_preserves_anchors_artifacts_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("library.sqlite3");
        let conn = Connection::open(&db).unwrap();
        for sql in [
            include_str!("migrations/001_initial.sql"),
            include_str!("migrations/002_indexes_properties_jobs.sql"),
            include_str!("migrations/003_metadata.sql"),
            include_str!("migrations/004_lifecycle.sql"),
            include_str!("migrations/005_leases.sql"),
            include_str!("migrations/006_metadata_search.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }
        let hash = content_hash(b"migration PDF");
        conn.execute(
            "INSERT INTO documents(hash,title,page_count,updated_at) VALUES(?1,'Before',1,0)",
            [&hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO text_blocks VALUES(?1,'body','Unicode café passage')",
            [&hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks VALUES('stable-anchor',?1,'body',0,0,21,0,21,x'0000000001000100')",
            [&hash],
        )
        .unwrap();
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(b"[1,2,3]").unwrap();
        conn.execute(
            "INSERT INTO artifacts VALUES(?1,'test','v1','page',?2)",
            params![hash, encoder.finish().unwrap()],
        )
        .unwrap();
        drop(conn);
        let library = Library::open(dir.path()).unwrap();
        assert_eq!(
            library.passage("stable-anchor").unwrap().unwrap().text,
            "Unicode café passage"
        );
        assert_eq!(
            library
                .get::<Vec<u32>>(&hash, "test", "v1", "page")
                .unwrap()
                .unwrap(),
            [1, 2, 3]
        );
        library
            .put(&hash, "test", "v1", "page", &vec![4u32, 5])
            .unwrap();
        assert_eq!(
            library
                .get::<Vec<u32>>(&hash, "test", "v1", "page")
                .unwrap()
                .unwrap(),
            [4, 5]
        );
        let conn = library.connection().unwrap();
        assert_eq!(
            conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(
            !conn
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap()
        );
        assert_eq!(
            conn.query_row("SELECT length(digest) FROM content_keys", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            32
        );
        let backup =
            Connection::open(dir.path().join("library-before-v6-migration.sqlite3")).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            6
        );
        assert_eq!(
            backup
                .query_row("SELECT count(*) FROM chunks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute("DELETE FROM documents WHERE hash=?1", [&hash])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM passage_data", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM artifact_data", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
