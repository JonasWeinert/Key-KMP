//! Workspace-wide scholarly lookup cache. Keys identify normalized external
//! identifiers or versioned queries, independently of a document's content hash.
use crate::{Library, Result, err, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub(crate) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS scholarly_cache (
             key TEXT PRIMARY KEY NOT NULL,
             payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
             error TEXT,
             fetched_at INTEGER NOT NULL,
             retry_after INTEGER NOT NULL,
             expires_at INTEGER NOT NULL,
             attempts INTEGER NOT NULL CHECK(attempts >= 0),
             updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS scholarly_cache_expiry ON scholarly_cache(expires_at);
         CREATE INDEX IF NOT EXISTS scholarly_cache_retry ON scholarly_cache(retry_after) WHERE error IS NOT NULL;
         PRAGMA user_version=14;
         COMMIT;",
    ).map_err(err)
}

/// Lookup outcome and durable freshness/backoff state. Times are Unix milliseconds.
/// A failed refresh can retain the previous payload while recording its error.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ScholarlyCacheEntry {
    pub key: String,
    pub payload: Option<serde_json::Value>,
    pub error: Option<String>,
    pub fetched_at: i64,
    pub retry_after: i64,
    pub expires_at: i64,
    pub attempts: u32,
}

impl Library {
    /// Bounded durable retry queue; interrupted leases and failures resume after restart.
    pub fn scholarly_due(&self, at: i64, limit: usize) -> Result<Vec<ScholarlyCacheEntry>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT key FROM scholarly_cache WHERE error IS NOT NULL AND retry_after>0 AND retry_after<=?1 ORDER BY retry_after LIMIT ?2").map_err(err)?;
        let keys = stmt
            .query_map(params![at, limit.clamp(1, 64) as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        keys.into_iter()
            .filter_map(|key| self.scholarly_get(&key).transpose())
            .collect()
    }
    /// Returns stale entries too, allowing callers to serve saved metadata while
    /// respecting the persisted retry deadline before refreshing.
    pub fn scholarly_get(&self, key: &str) -> Result<Option<ScholarlyCacheEntry>> {
        let conn = self.connection()?;
        let entry = conn.query_row(
            "SELECT key,payload,error,fetched_at,retry_after,expires_at,attempts FROM scholarly_cache WHERE key=?1",
            [key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, u32>(6)?)),
        ).optional().map_err(err)?;
        entry
            .map(
                |(key, payload, error, fetched_at, retry_after, expires_at, attempts)| {
                    Ok(ScholarlyCacheEntry {
                        key,
                        payload: payload
                            .map(|value| serde_json::from_str(&value))
                            .transpose()
                            .map_err(err)?,
                        error,
                        fetched_at,
                        retry_after,
                        expires_at,
                        attempts,
                    })
                },
            )
            .transpose()
    }

    pub fn scholarly_put(&self, entry: &ScholarlyCacheEntry) -> Result<()> {
        if entry.key.trim().is_empty() {
            return Err("A scholarly cache key cannot be empty".into());
        }
        let entry = entry.clone();
        let payload = entry
            .payload
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(err)?;
        self.writer.run(false, move |conn| {
            conn.execute(
                "INSERT INTO scholarly_cache(key,payload,error,fetched_at,retry_after,expires_at,attempts,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,error=excluded.error,
                 fetched_at=excluded.fetched_at,retry_after=excluded.retry_after,
                 expires_at=excluded.expires_at,attempts=excluded.attempts,updated_at=excluded.updated_at",
                params![entry.key,payload,entry.error,entry.fetched_at,entry.retry_after,entry.expires_at,entry.attempts,now_ms()],
            ).map_err(err)?;
            Ok(())
        })
    }

    /// Save one resolved reference immediately without replacing the other
    /// references or relation kinds. `ordinal` is its original array index.
    pub fn store_reference<T: Serialize>(
        &self,
        hash: &str,
        ordinal: usize,
        payload: &T,
    ) -> Result<()> {
        let hash = hash.to_owned();
        let ordinal = i64::try_from(ordinal).map_err(err)?;
        let payload = serde_json::to_string(payload).map_err(err)?;
        self.writer.run(false, move |conn| {
            conn.execute(
                "INSERT INTO document_relations(document_hash,kind,ordinal,payload) VALUES(?1,'reference',?2,?3)
                 ON CONFLICT(document_hash,kind,ordinal) DO UPDATE SET payload=excluded.payload",
                params![hash,ordinal,payload],
            ).map_err(err)?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_are_due_only_after_persisted_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        lib.scholarly_put(&ScholarlyCacheEntry {
            key: "doi:10.1000/retry".into(),
            payload: None,
            error: Some("offline".into()),
            fetched_at: 0,
            retry_after: 9000,
            expires_at: 0,
            attempts: 2,
        })
        .unwrap();
        drop(lib);
        let lib = Library::open(dir.path()).unwrap();
        assert!(lib.scholarly_due(8999, 16).unwrap().is_empty());
        assert_eq!(lib.scholarly_due(9000, 16).unwrap().len(), 1);
    }

    #[test]
    fn upgrades_existing_workspace_without_changing_documents() {
        let dir = tempfile::tempdir().unwrap();
        let hash = crate::content_hash(b"existing paper");
        {
            let lib = Library::open(dir.path()).unwrap();
            lib.register(&hash, "Existing paper", 3).unwrap();
            lib.connection()
                .unwrap()
                .execute_batch("DROP TABLE scholarly_cache; PRAGMA user_version=13;")
                .unwrap();
        }
        let lib = Library::open(dir.path()).unwrap();
        assert_eq!(lib.documents(&crate::Filter::default()).unwrap().len(), 1);
        assert_eq!(lib.scholarly_get("doi:absent").unwrap(), None);
        assert!(
            dir.path()
                .join("library-before-v13-migration.sqlite3")
                .exists()
        );
        assert_eq!(
            lib.connection()
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            14
        );
    }

    #[test]
    fn cache_survives_restart_and_preserves_failed_refresh_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let mut expected = ScholarlyCacheEntry {
            key: "doi:10.1234/example".into(),
            payload: Some(serde_json::json!({"title":"A paper", "provider":"crossref"})),
            error: None,
            fetched_at: 1000,
            retry_after: 0,
            expires_at: 5000,
            attempts: 1,
        };
        {
            let lib = Library::open(dir.path()).unwrap();
            assert_eq!(lib.scholarly_get(&expected.key).unwrap(), None);
            lib.scholarly_put(&expected).unwrap();
        }
        {
            let lib = Library::open(dir.path()).unwrap();
            assert_eq!(
                lib.scholarly_get(&expected.key).unwrap(),
                Some(expected.clone())
            );
            expected.error = Some("429 Too Many Requests".into());
            expected.retry_after = 9000;
            expected.attempts = 2;
            lib.scholarly_put(&expected).unwrap();
        }
        let lib = Library::open(dir.path()).unwrap();
        assert_eq!(lib.scholarly_get(&expected.key).unwrap(), Some(expected));
        let miss = ScholarlyCacheEntry {
            key: "query:v1:missing paper".into(),
            payload: None,
            error: Some("Not found".into()),
            fetched_at: 1100,
            retry_after: 9900,
            expires_at: 9900,
            attempts: 1,
        };
        lib.scholarly_put(&miss).unwrap();
        drop(lib);
        assert_eq!(
            Library::open(dir.path())
                .unwrap()
                .scholarly_get(&miss.key)
                .unwrap(),
            Some(miss)
        );
    }

    #[test]
    fn incremental_reference_replaces_only_its_original_ordinal() {
        let dir = tempfile::tempdir().unwrap();
        let hash = crate::content_hash(b"paper");
        {
            let lib = Library::open(dir.path()).unwrap();
            lib.register(&hash, "Paper", 1).unwrap();
            lib.store_relations(
                &hash,
                "reference",
                &[serde_json::json!({"id": 1}), serde_json::json!({"id": 2})],
            )
            .unwrap();
            lib.store_relations(
                &hash,
                "link",
                &[serde_json::json!({"url":"https://example.org"})],
            )
            .unwrap();
            lib.store_reference(&hash, 1, &serde_json::json!({"id":2,"title":"Resolved"}))
                .unwrap();
            lib.store_reference(&hash, 7, &serde_json::json!({"id":8}))
                .unwrap();
        }
        let lib = Library::open(dir.path()).unwrap();
        let conn = lib.connection().unwrap();
        let mut query = conn.prepare("SELECT ordinal,payload FROM document_relations WHERE document_hash=?1 AND kind='reference' ORDER BY ordinal").unwrap();
        let rows: Vec<(i64, String)> = query
            .query_map([&hash], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            rows,
            vec![
                (0, "{\"id\":1}".into()),
                (1, "{\"id\":2,\"title\":\"Resolved\"}".into()),
                (7, "{\"id\":8}".into())
            ]
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM document_relations WHERE kind='link'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert!(
            lib.store_reference("unknown", 0, &serde_json::json!({}))
                .is_err()
        );
    }
}
