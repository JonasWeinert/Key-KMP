use crate::{Library, Result, err, now_ms};
use rusqlite::params;
use std::{collections::HashSet, fs, time::Duration};
impl Library {
    pub fn record_maintenance(&self, kind: &str, detail: &str) -> Result<()> {
        self.connection()?.execute("INSERT INTO maintenance_events(kind,detail,created_at) SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM maintenance_events WHERE kind=?1 AND detail=?2)", params![kind,detail,now_ms()]).map_err(err)?;
        Ok(())
    }

    pub fn prepare_index_upgrade(&self, format: &str) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction().map_err(err)?;
        tx.execute("UPDATE documents SET status=CASE WHEN EXISTS(SELECT 1 FROM jobs WHERE document_hash=documents.hash AND paused=1) THEN 'paused' WHEN deleted_at IS NULL AND has_source=1 THEN 'queued' ELSE status END,keyword_ready=0 WHERE hash IN (SELECT document_hash FROM index_generations WHERE version<>?1)", [format]).map_err(err)?;
        tx.execute("DELETE FROM index_publications WHERE version<>?1", [format])
            .map_err(err)?;
        tx.execute("DELETE FROM index_generations WHERE version<>?1", [format])
            .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// Soft removal retains originals and annotations, including across restarts.
    pub fn set_removed(&self, hash: &str, removed: bool) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction().map_err(err)?;
        tx.execute(
            "UPDATE documents SET deleted_at=?2,updated_at=?3 WHERE hash=?1",
            params![hash, removed.then(now_ms), now_ms()],
        )
        .map_err(err)?;
        if removed {
            tx.execute("INSERT INTO jobs(document_hash,paused,updated_at) VALUES(?1,1,?2) ON CONFLICT(document_hash) DO UPDATE SET paused=1,updated_at=excluded.updated_at",params![hash,now_ms()]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }
    pub fn invalidate_index(
        &self,
        hash: &str,
        kind: &str,
        expected: &std::path::Path,
        detail: &str,
    ) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction().map_err(err)?;
        let changed = tx
            .execute(
                "DELETE FROM index_generations WHERE document_hash=?1 AND kind=?2 AND path=?3",
                params![hash, kind, expected.to_string_lossy()],
            )
            .map_err(err)?;
        if changed == 0 {
            return Ok(());
        }
        tx.execute("UPDATE documents SET status='failed',keyword_ready=CASE WHEN ?2='lexical' THEN 0 ELSE keyword_ready END,error=?3,updated_at=?4 WHERE hash=?1",params![hash,kind,format!("The {kind} index needs rebuilding: {detail}"),now_ms()]).map_err(err)?;
        tx.execute("INSERT INTO maintenance_events(document_hash,kind,detail,created_at) VALUES(?1,'damaged-index',?2,?3)",params![hash,detail,now_ms()]).map_err(err)?;
        tx.commit().map_err(err)
    }
    /// Only unreferenced generations older than the grace period are eligible.
    /// Originals, annotations, current pointers and fresh/in-progress builds stay intact.
    pub fn collect_old_generations(&self, grace: Duration) -> Result<usize> {
        if grace < Duration::from_secs(24 * 3600) {
            return Err("Generation grace period must be at least one day".into());
        }
        // One cross-process pin per query avoids one file descriptor per shard.
        // A reader or publisher in any process prevents collecting its generation.
        let guard = self.generation_lock_file()?;
        match guard.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Ok(0),
            Err(std::fs::TryLockError::Error(error)) => return Err(err(error)),
        }
        let conn = self.connection()?;
        let mut q = conn
            .prepare("SELECT path FROM index_generations UNION SELECT path FROM index_publications")
            .map_err(err)?;
        let live = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?
            .into_iter()
            .filter_map(|p| fs::canonicalize(p).ok())
            .collect::<HashSet<_>>();
        let root = self.root.join("frankensearch");
        if !root.exists() {
            return Ok(0);
        }
        let mut removed = 0;
        for entry in fs::read_dir(&root).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let parts = name.split('-').collect::<Vec<_>>();
            if parts.len() != 4
                || crate::valid_hash(parts[0]).is_err()
                || !matches!(parts[1], "lexical" | "vector")
                || parts[2].parse::<u32>().is_err()
                || parts[3].parse::<u128>().is_err()
            {
                continue;
            }
            let metadata = entry.metadata().map_err(err)?;
            if entry.file_type().map_err(err)?.is_symlink()
                || !metadata.is_dir()
                || metadata
                    .modified()
                    .map_err(err)?
                    .elapsed()
                    .unwrap_or_default()
                    < grace
            {
                continue;
            }
            let path = fs::canonicalize(entry.path()).map_err(err)?;
            if !live.contains(&path) && path.parent() == Some(root.as_path()) {
                fs::remove_dir_all(path).map_err(err)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_active_query_pins_superseded_generations_until_reader_drop() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"pin", "Pin", 1).unwrap();
        let path = lib
            .root()
            .join("frankensearch")
            .join(format!("{hash}-lexical-1-1"));
        fs::create_dir_all(&path).unwrap();
        lib.publish_index(&hash, "lexical", "v1", &path).unwrap();
        let reader = lib.index_reader().unwrap();
        assert!(reader.path(&hash, "lexical", "v1").unwrap().is_some());
        lib.invalidate_index(&hash, "lexical", &path, "superseded test")
            .unwrap();
        fs::File::open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 3600),
                ),
            )
            .unwrap();
        assert_eq!(
            lib.collect_old_generations(Duration::from_secs(7 * 24 * 3600))
                .unwrap(),
            0
        );
        assert!(path.exists());
        drop(reader);
        assert_eq!(
            lib.collect_old_generations(Duration::from_secs(7 * 24 * 3600))
                .unwrap(),
            1
        );
        assert!(!path.exists());
    }
    #[test]
    fn collection_preserves_current_generations_and_removes_only_old_orphans() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"gc", "GC", 1).unwrap();
        let root = lib.root().join("frankensearch");
        fs::create_dir_all(&root).unwrap();
        let live = root.join(format!("{hash}-lexical-1-1"));
        let orphan = root.join(format!("{hash}-lexical-1-2"));
        let fresh = root.join(format!("{hash}-vector-1-3"));
        for path in [&live, &orphan, &fresh] {
            fs::create_dir(path).unwrap();
        }
        lib.publish_index(&hash, "lexical", "v1", &live).unwrap();
        for path in [&live, &orphan] {
            fs::File::open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 3600),
                ))
                .unwrap();
        }
        assert_eq!(
            lib.collect_old_generations(Duration::from_secs(7 * 24 * 3600))
                .unwrap(),
            1
        );
        assert!(live.exists());
        assert!(fresh.exists());
        assert!(!orphan.exists());
        lib.invalidate_index(&hash, "lexical", &fresh, "stale reader")
            .unwrap();
        assert_eq!(
            lib.index_path(&hash, "lexical", "v1").unwrap(),
            Some(live.clone())
        );
        lib.invalidate_index(&hash, "lexical", &live, "damaged")
            .unwrap();
        assert!(lib.index_path(&hash, "lexical", "v1").unwrap().is_none());
    }
    #[test]
    fn removal_hides_searchable_metadata_and_preserves_annotations() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"source", "Title", 1).unwrap();
        lib.set_removed(&hash, true).unwrap();
        assert!(lib.documents(&Default::default()).unwrap().is_empty());
        assert!(lib.source_path(&hash).unwrap().exists());
        let lib = Library::open(tmp.path()).unwrap();
        lib.set_removed(&hash, false).unwrap();
        assert_eq!(lib.documents(&Default::default()).unwrap().len(), 1);
        assert!(lib.collect_old_generations(Duration::ZERO).is_err());
    }
}
