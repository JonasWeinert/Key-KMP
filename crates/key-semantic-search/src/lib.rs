//! Isolated semantic PDF processing and hybrid search.
//!
//! The crate owns extraction DTOs, sentence-context chunking, neural embedding,
//! Frankensearch persistence, and the disposable helper-process protocol. UI
//! hosts only launch helpers and consume the serializable results.

#![forbid(unsafe_code)]

mod pagination;
pub use pagination::{SearchPage, SearchSessions};
mod analysis;
mod chunk_source;
mod chunks;
pub use chunk_source::{ChunkSource, PreparedChunks};
mod embedder;
mod embedding_service;
mod lexical;
mod process;
mod search;

pub use analysis::{
    CompactRect, SemanticBlockDto, SemanticDocumentDto, SemanticPageDto, SemanticSentenceDto,
    convert_file,
};
pub use chunks::{
    SemanticChunk, build_sentence_context_chunks, load_or_create_sentence_context_chunks,
    load_or_create_sentence_context_chunks_at,
};
pub use process::{SemanticLibraryDocument, SemanticSearchService, maybe_run_helper};
pub use search::{IndexStats, SemanticSearchHitDto, index_keywords};
