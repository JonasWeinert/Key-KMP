//! Backpressured, content-addressed imports and bounded random-access reads.
use crate::{Library, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::Mutex,
};
const CHUNK_LIMIT: usize = 4 * 1024 * 1024;
struct Upload {
    file: tempfile::NamedTempFile,
    digest: Sha256,
    length: u64,
    received: u64,
    title: String,
}
#[derive(Default)]
pub struct Imports {
    uploads: Mutex<HashMap<String, Upload>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub hash: String,
    pub size: u64,
    pub title: String,
}
impl Imports {
    pub fn begin(&self, library: &Library, title: String, length: u64) -> Result<String> {
        if length == 0 {
            return Err("The PDF is empty".into());
        }
        let mut uploads = self.uploads.lock().map_err(|_| "Import lock poisoned")?;
        if uploads.len() >= 8 {
            return Err("Eight imports are already active; wait for one to finish".into());
        }
        let file = tempfile::Builder::new()
            .prefix(".import-")
            .tempfile_in(library.root.join("sources"))
            .map_err(|e| e.to_string())?;
        let id = file
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        uploads.insert(
            id.clone(),
            Upload {
                file,
                digest: Sha256::new(),
                length,
                received: 0,
                title,
            },
        );
        Ok(id)
    }
    pub fn append(&self, id: &str, offset: u64, bytes: &[u8]) -> Result<u64> {
        if bytes.is_empty() || bytes.len() > CHUNK_LIMIT {
            return Err("Import chunks must contain 1 byte to 4 MiB".into());
        }
        let mut uploads = self.uploads.lock().map_err(|_| "Import lock poisoned")?;
        let u = uploads.get_mut(id).ok_or("Import no longer exists")?;
        if offset != u.received || bytes.len() as u64 > u.length - u.received {
            return Err("Out-of-order or oversized import chunk".into());
        }
        if let Err(error) = u.file.write_all(bytes) {
            // Restore the checkpoint after a short write; callers may safely retry.
            u.file
                .as_file()
                .set_len(u.received)
                .map_err(|e| e.to_string())?;
            u.file
                .seek(SeekFrom::Start(u.received))
                .map_err(|e| e.to_string())?;
            return Err(error.to_string());
        }
        u.digest.update(bytes);
        u.received += bytes.len() as u64;
        Ok(u.received)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.uploads
            .lock()
            .map_err(|_| "Import lock poisoned")?
            .remove(id);
        Ok(())
    }
    pub fn finish(&self, library: &Library, id: &str) -> Result<SourceInfo> {
        let mut uploads = self.uploads.lock().map_err(|_| "Import lock poisoned")?;
        if uploads.get(id).ok_or("Import no longer exists")?.received != uploads[id].length {
            return Err("PDF import is incomplete".into());
        }
        let u = uploads.remove(id).unwrap();
        drop(uploads);
        let hash = format!("{:x}", u.digest.finalize());
        library.prepare_reimport(&hash)?;
        u.file.as_file().sync_all().map_err(|e| e.to_string())?;
        let path = library.root.join("sources").join(format!("{hash}.pdf"));
        match u.file.persist_noclobber(&path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if library.verify_source(&hash).is_err() {
                    e.file.persist(&path).map_err(|e| e.to_string())?;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        library.register(&hash, &u.title, 0)?;
        library
            .connection()?
            .execute("UPDATE documents SET has_source=1 WHERE hash=?1", [&hash])
            .map_err(|e| e.to_string())?;
        Ok(SourceInfo {
            hash,
            size: u.length,
            title: u.title,
        })
    }
}
pub fn file_hash(path: &std::path::Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
impl Library {
    pub fn verify_source(&self, hash: &str) -> Result<()> {
        if file_hash(&self.source_path(hash)?)? != hash {
            return Err(
                "The saved PDF failed its content hash check; relink the original PDF".into(),
            );
        }
        Ok(())
    }
    pub fn source_info(&self, hash: &str) -> Result<SourceInfo> {
        let size = self
            .source_path(hash)?
            .metadata()
            .map_err(|e| e.to_string())?
            .len();
        let title = self
            .connection()?
            .query_row("SELECT title FROM documents WHERE hash=?1", [hash], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        Ok(SourceInfo {
            hash: hash.into(),
            size,
            title,
        })
    }
    pub fn source_range(&self, hash: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        if length == 0 || length > CHUNK_LIMIT {
            return Err("PDF range must contain 1 byte to 4 MiB".into());
        }
        let mut file = File::open(self.source_path(hash)?).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if offset > size || length as u64 > size - offset {
            return Err("PDF range exceeds source length".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_import_is_ordered_durable_and_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let imports = Imports::default();
        let id = imports.begin(&lib, "Paper".into(), 6).unwrap();
        assert!(imports.append(&id, 1, b"abc").is_err());
        imports.append(&id, 0, b"abc").unwrap();
        assert!(imports.finish(&lib, &id).is_err());
        imports.append(&id, 3, b"def").unwrap();
        let source = imports.finish(&lib, &id).unwrap();
        assert_eq!(source.hash, crate::content_hash(b"abcdef"));
        assert_eq!(lib.source_range(&source.hash, 2, 3).unwrap(), b"cde");
        assert!(lib.source_range(&source.hash, 4, 3).is_err());
        let id = imports.begin(&lib, "Cancel".into(), 1).unwrap();
        imports.cancel(&id).unwrap();
        assert!(imports.append(&id, 0, b"x").is_err());
    }
}
