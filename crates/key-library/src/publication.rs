//! Completed, verified generations are journaled before their pointer is swapped.
//! Replay is conditional on the pointer observed when the intent was created.
use crate::{Library, Result, err, now_ms};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

fn generation_digest(path: &Path) -> Result<String> {
    fn visit(root: &Path, path: &Path, digest: &mut Sha256) -> Result<()> {
        let mut entries = fs::read_dir(path)
            .map_err(err)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(err)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let kind = entry.file_type().map_err(err)?;
            if kind.is_symlink() {
                return Err("Index generations cannot contain symbolic links".into());
            }
            let path = entry.path();
            let name = path
                .strip_prefix(root)
                .map_err(err)?
                .to_str()
                .ok_or("Non-UTF8 generation path")?;
            digest.update((name.len() as u64).to_le_bytes());
            digest.update(name.as_bytes());
            if kind.is_dir() {
                digest.update([0]);
                visit(root, &path, digest)?;
            } else if kind.is_file() {
                digest.update([1]);
                let mut file = fs::File::open(&path).map_err(err)?;
                digest.update(file.metadata().map_err(err)?.len().to_le_bytes());
                let mut buffer = [0u8; 65536];
                loop {
                    let n = file.read(&mut buffer).map_err(err)?;
                    if n == 0 {
                        break;
                    }
                    digest.update(&buffer[..n]);
                }
                file.sync_all().map_err(err)?;
            } else {
                return Err("Invalid generation entry".into());
            }
        }
        #[cfg(unix)]
        fs::File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(err)?;
        Ok(())
    }
    let mut digest = Sha256::new();
    visit(path, path, &mut digest)?;
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("Generation has no parent")?)
        .and_then(|f| f.sync_all())
        .map_err(err)?;
    Ok(format!("{:x}", digest.finalize()))
}
impl Library {
    fn stage_publication(
        &self,
        hash: &str,
        kind: &str,
        version: &str,
        path: &Path,
    ) -> Result<String> {
        let path = fs::canonicalize(path).map_err(err)?;
        if !path.is_dir() || !path.starts_with(&self.root) || path == self.root {
            return Err("invalid index generation path".into());
        }
        let digest = generation_digest(&path)?;
        let path = path.to_string_lossy().into_owned();
        let (hash, kind, version, output) = (
            hash.to_owned(),
            kind.to_owned(),
            version.to_owned(),
            path.clone(),
        );
        self.writer.run(false, move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(err)?;
            let allowed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM documents d WHERE hash=?1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE document_hash=d.hash AND paused=1))", [&hash], |r|r.get(0)).map_err(err)?;
            if !allowed { return Err("Index publication cancelled: document removed or paused".into()); }
            tx.execute("INSERT INTO index_publications(path,document_hash,kind,version,expected_path,digest,queued_at) VALUES(?1,?2,?3,?4,(SELECT path FROM index_generations WHERE document_hash=?2 AND kind=?3),?5,?6) ON CONFLICT(path) DO NOTHING", params![path,hash,kind,version,digest,now_ms()]).map_err(err)?;
            tx.commit().map_err(err)
        })?;
        Ok(output)
    }
    fn complete_publication(&self, path: &str) -> Result<bool> {
        let path = path.to_owned();
        self.writer.run(false, move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(err)?;
            let changed = tx.execute("INSERT INTO index_generations(document_hash,kind,version,path,published_at) SELECT p.document_hash,p.kind,p.version,p.path,?2 FROM index_publications p JOIN documents d ON d.hash=p.document_hash WHERE p.path=?1 AND d.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE document_hash=d.hash AND paused=1) AND (SELECT path FROM index_generations WHERE document_hash=p.document_hash AND kind=p.kind) IS p.expected_path ON CONFLICT(document_hash,kind) DO UPDATE SET version=excluded.version,path=excluded.path,published_at=excluded.published_at", params![path,now_ms()]).map_err(err)?;
            if changed != 0 {
                tx.execute("UPDATE documents SET keyword_ready=1 WHERE hash IN (SELECT document_hash FROM index_publications WHERE path=?1 AND kind='lexical')", [&path]).map_err(err)?;
            }
            // Paused work remains replayable. Superseded and removed intents are discarded.
            tx.execute("DELETE FROM index_publications WHERE path=?1 AND (?2 OR NOT EXISTS(SELECT 1 FROM documents d JOIN jobs j ON j.document_hash=d.hash WHERE d.hash=index_publications.document_hash AND d.deleted_at IS NULL AND j.paused=1))", params![path,changed!=0]).map_err(err)?;
            let published: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM index_generations WHERE path=?1)", [&path], |r| r.get(0)).map_err(err)?;
            tx.commit().map_err(err)?;
            Ok(changed != 0 || published)
        })
    }
    pub fn publish_index(&self, hash: &str, kind: &str, version: &str, path: &Path) -> Result<()> {
        let _guard = self.pin_generations()?;
        let path = self.stage_publication(hash, kind, version, path)?;
        if !self.complete_publication(&path)? {
            return Err("Index publication paused or superseded".into());
        }
        Ok(())
    }
    pub fn recover_publications(&self) -> Result<()> {
        // Common library opens avoid acquiring another file lock when there is no work.
        let conn = self.connection()?;
        let mut query = conn
            .prepare("SELECT p.path,p.digest FROM index_publications p JOIN documents d ON d.hash=p.document_hash WHERE d.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jobs j WHERE j.document_hash=d.hash AND j.paused=1) ORDER BY p.queued_at,p.path")
            .map_err(err)?;
        let pending = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        if pending.is_empty() {
            return Ok(());
        }
        let _guard = self.pin_generations()?;
        for (path, digest) in pending {
            let valid = fs::canonicalize(&path).is_ok_and(|p| {
                p.starts_with(&self.root)
                    && p != self.root
                    && generation_digest(&p).is_ok_and(|actual| actual == digest)
            });
            if valid {
                self.complete_publication(&path)?;
            } else {
                conn.execute(
                    "DELETE FROM index_publications WHERE path=?1 AND digest=?2",
                    params![path, digest],
                )
                .map_err(err)?;
                self.record_maintenance(
                    "publication-recovery",
                    &format!("Discarded incomplete or damaged generation: {path}"),
                )?;
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_verified_intent_after_reopen_but_never_replace_a_newer_pointer() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"journal", "Journal", 1).unwrap();
        let paths = ["first", "second", "stale", "newest", "damaged"].map(|name| {
            let path = lib.root().join(name);
            fs::create_dir(&path).unwrap();
            fs::write(path.join("index"), name).unwrap();
            path
        });
        lib.publish_index(&hash, "lexical", "v1", &paths[0])
            .unwrap();
        lib.stage_publication(&hash, "lexical", "v1", &paths[1])
            .unwrap();
        drop(lib);
        let lib = Library::open(tmp.path()).unwrap();
        assert_eq!(
            lib.index_path(&hash, "lexical", "v1").unwrap(),
            Some(paths[1].clone())
        );
        lib.stage_publication(&hash, "lexical", "v1", &paths[2])
            .unwrap();
        lib.publish_index(&hash, "lexical", "v1", &paths[3])
            .unwrap();
        lib.recover_publications().unwrap();
        assert!(
            lib.complete_publication(paths[3].to_str().unwrap())
                .unwrap()
        );
        assert_eq!(
            lib.index_path(&hash, "lexical", "v1").unwrap(),
            Some(paths[3].clone())
        );
        lib.stage_publication(&hash, "lexical", "v1", &paths[4])
            .unwrap();
        fs::write(paths[4].join("index"), "corrupted").unwrap();
        lib.recover_publications().unwrap();
        assert_eq!(
            lib.index_path(&hash, "lexical", "v1").unwrap(),
            Some(paths[3].clone())
        );
        assert_eq!(
            lib.connection()
                .unwrap()
                .query_row("SELECT count(*) FROM index_publications", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn paused_intent_waits_and_removed_intent_cannot_publish() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"paused journal", "Paused", 1).unwrap();
        let path = lib.root().join("ready");
        fs::create_dir(&path).unwrap();
        lib.stage_publication(&hash, "vector", "v1", &path).unwrap();
        lib.pause(&hash, true).unwrap();
        lib.recover_publications().unwrap();
        assert!(lib.index_path(&hash, "vector", "v1").unwrap().is_none());
        lib.pause(&hash, false).unwrap();
        lib.recover_publications().unwrap();
        assert_eq!(
            lib.index_path(&hash, "vector", "v1").unwrap(),
            Some(path.clone())
        );
        lib.stage_publication(&hash, "vector", "v2", &path).unwrap();
        lib.set_removed(&hash, true).unwrap();
        lib.recover_publications().unwrap();
        assert!(lib.index_path(&hash, "vector", "v2").unwrap().is_none());
    }
}
