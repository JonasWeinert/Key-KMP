use crate::analysis::{CompactRect, SemanticDocumentDto};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticChunk {
    pub id: String,
    pub document_id: String,
    pub document_hash: String,
    pub page: usize,
    pub block_index: usize,
    pub sentence_index: usize,
    pub text: String,
    pub target_text: String,
    pub target_rects: Vec<CompactRect>,
}

pub fn build_sentence_context_chunks(
    document_id: &str,
    semantic: &SemanticDocumentDto,
) -> Vec<SemanticChunk> {
    let mut chunks = Vec::new();
    for page in &semantic.pages {
        for (block_index, block) in page.blocks.iter().enumerate() {
            if block.sentences.is_empty() {
                continue;
            }
            for sentence_index in 0..block.sentences.len() {
                let start = sentence_index.saturating_sub(1);
                let end = (sentence_index + 2).min(block.sentences.len());
                let context = block.sentences[start..end]
                    .iter()
                    .map(|sentence| sentence.text.trim())
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                let target = &block.sentences[sentence_index];
                let mut hasher = Sha256::new();
                hasher.update(b"key-sentence-context-v3");
                hasher.update([semantic.version, u8::from(semantic.onnx_enabled)]);
                hasher.update(block.text.as_bytes());
                hasher.update(semantic.document_hash.as_bytes());
                hasher.update((page.page as u64).to_le_bytes());
                hasher.update((block_index as u64).to_le_bytes());
                hasher.update((sentence_index as u64).to_le_bytes());
                hasher.update(target.start.to_le_bytes());
                hasher.update(target.end.to_le_bytes());
                for r in &target.rects {
                    for v in [r.x, r.y, r.width, r.height] {
                        hasher.update(v.to_le_bytes());
                    }
                }
                let id = format!("{:x}", hasher.finalize());
                chunks.push(SemanticChunk {
                    id,
                    document_id: document_id.to_owned(),
                    document_hash: semantic.document_hash.clone(),
                    page: page.page,
                    block_index,
                    sentence_index,
                    text: context,
                    target_text: target.text.clone(),
                    target_rects: target.rects.clone(),
                });
            }
        }
    }
    chunks
}

pub fn load_or_create_sentence_context_chunks(
    document_id: &str,
    semantic: &SemanticDocumentDto,
) -> Result<Vec<SemanticChunk>, String> {
    let directory = env::temp_dir().join("key-sidecars").join("chunks");
    load_or_create_sentence_context_chunks_at(&directory, document_id, semantic)
}

pub fn load_or_create_sentence_context_chunks_at(
    directory: &Path,
    document_id: &str,
    semantic: &SemanticDocumentDto,
) -> Result<Vec<SemanticChunk>, String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let identity =
        key_library::content_hash(&serde_json::to_vec(semantic).map_err(|e| e.to_string())?);
    let output = directory.join(format!(
        "{}-context-v3-{identity}.json",
        semantic.document_hash
    ));
    let mut chunks = if output.exists() {
        let bytes = std::fs::read(&output).map_err(|error| error.to_string())?;
        serde_json::from_slice::<Vec<SemanticChunk>>(&bytes).map_err(|error| error.to_string())?
    } else {
        let chunks = build_sentence_context_chunks(document_id, semantic);
        let partial: PathBuf = output.with_extension("json.partial");
        let bytes = serde_json::to_vec(&chunks).map_err(|error| error.to_string())?;
        std::fs::write(&partial, bytes).map_err(|error| error.to_string())?;
        std::fs::rename(&partial, &output).map_err(|error| error.to_string())?;
        chunks
    };
    // The canonical cache belongs to the content hash. Map it to the current
    // open tab only when returning it; this preserves reuse across tab IDs.
    for chunk in &mut chunks {
        chunk.document_id = document_id.to_owned();
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::{SemanticChunk, build_sentence_context_chunks};
    use crate::analysis::{
        CompactRect, SemanticBlockDto, SemanticDocumentDto, SemanticPageDto, SemanticSentenceDto,
    };

    fn sentence(text: &str) -> SemanticSentenceDto {
        SemanticSentenceDto {
            start: 0,
            end: text.len() as u32,
            text: text.to_owned(),
            rects: vec![CompactRect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
        }
    }

    #[test]
    fn chunks_embed_one_sentence_with_one_sentence_on_each_side() {
        let document = SemanticDocumentDto {
            version: 1,
            document_hash: "hash".to_owned(),
            page_count: 1,
            onnx_enabled: false,
            processing_ms: 0.0,
            pages: vec![SemanticPageDto {
                page: 0,
                width: 100.0,
                height: 100.0,
                blocks: vec![SemanticBlockDto {
                    kind: "paragraph".to_owned(),
                    text: "one two three".to_owned(),
                    bounds: CompactRect {
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    },
                    sentences: vec![sentence("one"), sentence("two"), sentence("three")],
                }],
            }],
        };
        let chunks: Vec<SemanticChunk> = build_sentence_context_chunks("doc", &document);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].text, "one two");
        assert_eq!(chunks[1].text, "one two three");
        assert_eq!(chunks[2].text, "two three");
        assert_eq!(chunks[1].target_text, "two");
    }
}
