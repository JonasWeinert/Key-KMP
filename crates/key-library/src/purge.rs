//! Explicit permanent deletion with restartable filesystem cleanup. The app
//! must reject this operation while a corresponding reader is open.
use crate::{Library, Result, err, now_ms, valid_hash};
use rusqlite::{OptionalExtension, params};
use std::{fs, path::PathBuf};
impl Library {
    pub fn purge_document(&self, hash: &str) -> Result<()> {
        valid_hash(hash)?;
        let mut paths = vec![self.root.join("sources").join(format!("{hash}.pdf"))];
        let index_root = self.root.join("frankensearch");
        if index_root.exists() {
            for entry in fs::read_dir(&index_root).map_err(err)? {
                let entry = entry.map_err(err)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(&format!("{hash}-lexical-"))
                    || name.starts_with(&format!("{hash}-vector-"))
                {
                    paths.push(entry.path());
                }
            }
        }
        let hash = hash.to_owned();
        self.writer.run(true,move |conn| {
            let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(err)?;
            let removed:Option<bool>=tx.query_row("SELECT deleted_at IS NOT NULL FROM documents WHERE hash=?1",[&hash],|r|r.get(0)).optional().map_err(err)?;
            if removed != Some(true) { return Err("Remove the document before permanently deleting it".into()); }
            let leased:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM processing_leases WHERE document_hash=?1 AND expires_at>?2)",params![hash,now_ms()],|r|r.get(0)).map_err(err)?;
            if leased { return Err("Document processing is stopping; retry deletion after it stops".into()); }
            tx.execute("INSERT INTO purge_tombstones(hash,purged_at) VALUES(?1,?2)",params![hash,now_ms()]).map_err(err)?;
            for path in paths { tx.execute("INSERT OR IGNORE INTO purge_files(path,document_hash,queued_at) VALUES(?1,?2,?3)",params![path.to_string_lossy(),hash,now_ms()]).map_err(err)?; }
            tx.execute("DELETE FROM documents WHERE hash=?1",[&hash]).map_err(err)?;
            tx.execute("INSERT INTO maintenance_events(document_hash,kind,detail,created_at) VALUES(?1,'permanent-delete','Canonical records deleted; filesystem cleanup queued',?2)",params![hash,now_ms()]).map_err(err)?;
            tx.commit().map_err(err)
        })?;
        self.finish_purges()
    }
    pub fn finish_purges(&self) -> Result<()> {
        self.finish_purges_for(None)
    }
    fn finish_purges_for(&self, only_hash: Option<&str>) -> Result<()> {
        let guard = self.generation_lock_file()?;
        guard.lock().map_err(err)?;
        let conn = self.connection()?;
        let mut query = conn
            .prepare("SELECT path,document_hash FROM purge_files")
            .map_err(err)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        for (path, hash) in rows {
            if only_hash.is_some_and(|only| only != hash) {
                continue;
            }
            valid_hash(&hash)?;
            let path = PathBuf::from(path);
            let source = self.root.join("sources").join(format!("{hash}.pdf"));
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let index = path.parent() == Some(self.root.join("frankensearch").as_path())
                && (name.starts_with(&format!("{hash}-lexical-"))
                    || name.starts_with(&format!("{hash}-vector-")));
            if path != source && !index {
                return Err("Invalid pending purge path".into());
            }
            match fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {
                    fs::remove_dir_all(&path).map_err(err)?
                }
                Ok(_) => fs::remove_file(&path).map_err(err)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(err(e)),
            }
            conn.execute(
                "DELETE FROM purge_files WHERE path=?1",
                [path.to_string_lossy().as_ref()],
            )
            .map_err(err)?;
        }
        Ok(())
    }
    /// Called only by a verified explicit import, never by a processing worker.
    pub(crate) fn prepare_reimport(&self, hash: &str) -> Result<()> {
        self.finish_purges_for(Some(hash))?;
        self.connection()?
            .execute("DELETE FROM purge_tombstones WHERE hash=?1", [hash])
            .map_err(err)?;
        Ok(())
    }
    pub fn is_purged(&self, hash: &str) -> Result<bool> {
        self.connection()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM purge_tombstones WHERE hash=?1)",
                [hash],
                |r| r.get(0),
            )
            .map_err(err)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn purge_requires_removal_and_no_lease_preserves_tombstone_and_allows_explicit_import() {
        let root = tempfile::tempdir().unwrap();
        let lib = Library::open(root.path()).unwrap();
        let hash = lib.store_source(b"purge", "Purge", 1).unwrap();
        let source = lib.source_path(&hash).unwrap();
        assert!(lib.purge_document(&hash).is_err());
        let lease = lib.try_lease(&hash, "test").unwrap().unwrap();
        lib.set_removed(&hash, true).unwrap();
        assert!(lib.purge_document(&hash).is_err());
        drop(lease);
        lib.purge_document(&hash).unwrap();
        assert!(!source.exists());
        assert!(lib.is_purged(&hash).unwrap());
        assert!(lib.register(&hash, "Stale worker", 1).is_err());
        assert_eq!(
            lib.store_source(b"purge", "Explicit reimport", 1).unwrap(),
            hash
        );
        assert!(!lib.is_purged(&hash).unwrap());
        assert_eq!(
            lib.connection()
                .unwrap()
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
}
