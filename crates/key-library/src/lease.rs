use crate::{Library, Result, err, now_ms};
use rusqlite::{OptionalExtension, params};
pub struct ProcessingLease {
    library: Library,
    hash: String,
    stage: String,
    token: String,
}
impl Library {
    pub fn try_lease(&self, hash: &str, stage: &str) -> Result<Option<ProcessingLease>> {
        let token:Option<String>=self.connection()?.query_row("INSERT INTO processing_leases(document_hash,stage,token,expires_at) VALUES(?1,?2,hex(randomblob(16)),?3) ON CONFLICT(document_hash,stage) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,attempt=processing_leases.attempt+1 WHERE processing_leases.expires_at<=?4 RETURNING token",params![hash,stage,now_ms()+30_000,now_ms()],|r|r.get(0)).optional().map_err(err)?;
        Ok(token.map(|token| ProcessingLease {
            library: self.clone(),
            hash: hash.into(),
            stage: stage.into(),
            token,
        }))
    }
}
impl ProcessingLease {
    pub fn renew(&self) -> Result<()> {
        let changed=self.library.connection()?.execute("UPDATE processing_leases SET expires_at=?4 WHERE document_hash=?1 AND stage=?2 AND token=?3 AND expires_at>?5",params![self.hash,self.stage,self.token,now_ms()+30_000,now_ms()]).map_err(err)?;
        if changed == 1 {
            Ok(())
        } else {
            Err("Processing lease expired or was replaced".into())
        }
    }
}
impl Drop for ProcessingLease {
    fn drop(&mut self) {
        if let Ok(conn) = self.library.connection() {
            let _=conn.execute("UPDATE processing_leases SET expires_at=0 WHERE document_hash=?1 AND stage=?2 AND token=?3",params![self.hash,self.stage,self.token]);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_exclude_concurrent_workers_and_recover_expired_owners() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"lease", "Lease", 1).unwrap();
        let lease = lib.try_lease(&hash, "native").unwrap().unwrap();
        assert!(lib.try_lease(&hash, "native").unwrap().is_none());
        lease.renew().unwrap();
        lib.connection()
            .unwrap()
            .execute("UPDATE processing_leases SET expires_at=0", [])
            .unwrap();
        let replacement = lib.try_lease(&hash, "native").unwrap().unwrap();
        assert!(lease.renew().is_err());
        drop(lease);
        replacement.renew().unwrap();
        drop(replacement);
        assert!(lib.try_lease(&hash, "native").unwrap().is_some());
    }
}
