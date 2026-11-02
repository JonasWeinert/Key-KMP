//! Rewindable, bounded indexing input. Helpers receive a locator, never a whole
//! document's duplicated sentence contexts in their JSON control message.
use crate::SemanticChunk;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::PathBuf,
};

pub trait ChunkSource {
    fn len(&self) -> usize;
    fn reader(
        &self,
    ) -> Result<Box<dyn Iterator<Item = Result<SemanticChunk, String>> + '_>, String>;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn first_chunk(&self) -> Result<Option<SemanticChunk>, String> {
        self.reader()?.next().transpose()
    }
}
impl ChunkSource for [SemanticChunk] {
    fn len(&self) -> usize {
        <[SemanticChunk]>::len(self)
    }
    fn reader(
        &self,
    ) -> Result<Box<dyn Iterator<Item = Result<SemanticChunk, String>> + '_>, String> {
        Ok(Box::new(self.iter().cloned().map(Ok)))
    }
}
impl ChunkSource for Vec<SemanticChunk> {
    fn len(&self) -> usize {
        Vec::len(self)
    }
    fn reader(
        &self,
    ) -> Result<Box<dyn Iterator<Item = Result<SemanticChunk, String>> + '_>, String> {
        self.as_slice().reader()
    }
}
impl<const N: usize> ChunkSource for [SemanticChunk; N] {
    fn len(&self) -> usize {
        N
    }
    fn reader(
        &self,
    ) -> Result<Box<dyn Iterator<Item = Result<SemanticChunk, String>> + '_>, String> {
        self.as_slice().reader()
    }
}

const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Deserialize, Serialize)]
pub struct ChunkFile {
    pub path: PathBuf,
    pub count: usize,
}
pub struct PreparedChunks {
    pub(crate) source: ChunkFile,
    _file: tempfile::NamedTempFile,
}
impl PreparedChunks {
    pub fn len(&self) -> usize {
        self.source.count
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub(crate) fn create(
        mut producer: impl FnMut(
            &mut dyn FnMut(&SemanticChunk) -> Result<(), String>,
        ) -> Result<(), String>,
    ) -> Result<Self, String> {
        let file = tempfile::Builder::new()
            .prefix("key-chunks-")
            .tempfile()
            .map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file.as_file());
        let mut count = 0;
        producer(&mut |chunk| {
            let bytes = serde_json::to_vec(chunk).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_CHUNK_BYTES {
                return Err("Sentence context exceeds the 4 MiB indexing limit".into());
            }
            writer
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .and_then(|_| writer.write_all(&bytes))
                .map_err(|e| e.to_string())?;
            count += 1;
            Ok(())
        })?;
        writer.flush().map_err(|e| e.to_string())?;
        drop(writer);
        Ok(Self {
            source: ChunkFile {
                path: file.path().to_owned(),
                count,
            },
            _file: file,
        })
    }
}
impl ChunkSource for PreparedChunks {
    fn len(&self) -> usize {
        self.source.count
    }
    fn reader(
        &self,
    ) -> Result<Box<dyn Iterator<Item = Result<SemanticChunk, String>> + '_>, String> {
        self.source.reader()
    }
}
impl ChunkSource for ChunkFile {
    fn len(&self) -> usize {
        self.count
    }
    fn reader(
        &self,
    ) -> Result<Box<dyn Iterator<Item = Result<SemanticChunk, String>> + '_>, String> {
        let mut reader = BufReader::new(File::open(&self.path).map_err(|e| e.to_string())?);
        let mut remaining = self.count;
        let mut failed = false;
        Ok(Box::new(std::iter::from_fn(move || {
            if failed {
                return None;
            }
            if remaining == 0 {
                let mut extra = [0];
                return match reader.read(&mut extra) {
                    Ok(0) => None,
                    _ => {
                        failed = true;
                        Some(Err("Trailing bytes in chunk input".into()))
                    }
                };
            }
            let result = (|| {
                let mut prefix = [0; 4];
                reader
                    .read_exact(&mut prefix)
                    .map_err(|e| format!("Truncated chunk input: {e}"))?;
                let length = u32::from_le_bytes(prefix) as usize;
                if length == 0 || length > MAX_CHUNK_BYTES {
                    return Err("Invalid chunk frame length".into());
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())
            })();
            remaining -= 1;
            failed = result.is_err();
            Some(result)
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_input_rewinds_preserves_unicode_and_rejects_truncation() {
        let chunks = PreparedChunks::create(|emit| {
            for n in 0..4097 {
                emit(&SemanticChunk {
                    id: n.to_string(),
                    document_id: "session".into(),
                    document_hash: "hash".into(),
                    page: n / 100,
                    block_index: 0,
                    sentence_index: n,
                    text: "αβ — context".into(),
                    target_text: "αβ".into(),
                    target_rects: vec![],
                })?;
            }
            Ok(())
        })
        .unwrap();
        for _ in 0..2 {
            let mut seen = 0;
            for result in chunks.reader().unwrap() {
                let c = result.unwrap();
                assert_eq!(c.id, seen.to_string());
                assert_eq!(c.text, "αβ — context");
                seen += 1;
            }
            assert_eq!(seen, 4097);
        }
        chunks._file.as_file().set_len(12).unwrap();
        assert!(chunks.reader().unwrap().next().unwrap().is_err());
    }
}
