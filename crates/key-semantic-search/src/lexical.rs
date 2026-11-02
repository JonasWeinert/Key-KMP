//! A read-only Tantivy adapter. Querying never acquires a writer or its heap.
use crate::ChunkSource;
#[cfg(test)]
use crate::SemanticChunk;
use frankensearch_core::{Cx, LexicalRead, ScoreSource, ScoredResult, SearchError, SearchFuture};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};
use tantivy::{
    Index, IndexReader, TantivyDocument,
    collector::TopDocs,
    query::QueryParser,
    schema::{Field, STORED, STRING, Schema, TEXT, Value},
};
use tantivy::{Term, query::Bm25StatisticsProvider};

pub struct KeywordReader {
    index: Index,
    reader: IndexReader,
    id: Field,
    text: Field,
    statistics: Option<Arc<CorpusStatistics>>,
}
fn error(e: impl std::error::Error + Send + Sync + 'static) -> SearchError {
    SearchError::SubsystemError {
        subsystem: "tantivy",
        source: Box::new(e),
    }
}
#[derive(Default)]
pub struct CorpusStatistics {
    docs: u64,
    tokens: u64,
    frequencies: HashMap<Term, u64>,
}
impl Bm25StatisticsProvider for CorpusStatistics {
    fn total_num_docs(&self) -> tantivy::Result<u64> {
        Ok(self.docs)
    }
    fn total_num_tokens(&self, _field: Field) -> tantivy::Result<u64> {
        Ok(self.tokens)
    }
    fn doc_freq(&self, term: &Term) -> tantivy::Result<u64> {
        Ok(*self.frequencies.get(term).unwrap_or(&0))
    }
}
impl KeywordReader {
    pub fn accumulate_statistics(
        &self,
        query: &str,
        stats: &mut CorpusStatistics,
    ) -> Result<(), String> {
        let parser = QueryParser::for_index(&self.index, vec![self.text]);
        let (query, _) = parser.parse_query_lenient(query);
        let mut terms = HashSet::new();
        query.query_terms(&mut |term, _| {
            terms.insert(term.clone());
        });
        let searcher = self.reader.searcher();
        stats.docs += searcher.num_docs();
        stats.tokens += searcher
            .total_num_tokens(self.text)
            .map_err(|e| e.to_string())?;
        for term in terms {
            let count = searcher.doc_freq(&term).map_err(|e| e.to_string())?;
            *stats.frequencies.entry(term).or_default() += count;
        }
        Ok(())
    }
    pub fn with_statistics(mut self, statistics: Arc<CorpusStatistics>) -> Self {
        self.statistics = Some(statistics);
        self
    }

    pub fn build(path: &Path, chunks: &(impl ChunkSource + ?Sized)) -> Result<(), String> {
        std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
        let mut schema = Schema::builder();
        let id = schema.add_text_field("id", STRING | STORED);
        // Text is canonical in SQLite. Tantivy only needs postings and positions.
        let text = schema.add_text_field("text", TEXT);
        let index = Index::create_in_dir(path, schema.build()).map_err(|e| e.to_string())?;
        let mut writer = index
            .writer_with_num_threads(1, 15_000_000)
            .map_err(|e| e.to_string())?;
        for chunk in chunks.reader()? {
            let chunk = chunk?;
            writer
                .add_document(tantivy::doc!(id=>chunk.id.clone(),text=>chunk.text.clone()))
                .map_err(|e| e.to_string())?;
        }
        writer.commit().map_err(|e| e.to_string())?;
        writer.wait_merging_threads().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        let index = Index::open_in_dir(path).map_err(|e| e.to_string())?;
        let id = index.schema().get_field("id").map_err(|e| e.to_string())?;
        let text = index
            .schema()
            .get_field("text")
            .map_err(|e| e.to_string())?;
        let reader = index
            .reader_builder()
            .reload_policy(tantivy::ReloadPolicy::Manual)
            .try_into()
            .map_err(|e: tantivy::TantivyError| e.to_string())?;
        Ok(Self {
            index,
            reader,
            id,
            text,
            statistics: None,
        })
    }
}
impl LexicalRead for KeywordReader {
    fn search<'a>(
        &'a self,
        _cx: &'a Cx,
        query: &'a str,
        limit: usize,
    ) -> SearchFuture<'a, Vec<ScoredResult>> {
        Box::pin(async move {
            if limit == 0 || query.trim().is_empty() {
                return Ok(Vec::new());
            }
            let parser = QueryParser::for_index(&self.index, vec![self.text]);
            let (query, _diagnostics) = parser.parse_query_lenient(query);
            let searcher = self.reader.searcher();
            let hits = searcher
                .search_with_statistics_provider(
                    &query,
                    &TopDocs::with_limit(limit).order_by_score(),
                    self.statistics
                        .as_deref()
                        .map(|s| s as &dyn Bm25StatisticsProvider)
                        .unwrap_or(&searcher),
                )
                .map_err(error)?;
            hits.into_iter()
                .map(|(score, address)| {
                    let doc: TantivyDocument = searcher.doc(address).map_err(error)?;
                    let id = doc
                        .get_first(self.id)
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| error(std::io::Error::other("keyword result has no ID")))?;
                    Ok(ScoredResult {
                        doc_id: id.into(),
                        score,
                        source: ScoreSource::Lexical,
                        index: None,
                        fast_score: None,
                        quality_score: None,
                        lexical_score: Some(score),
                        rerank_score: None,
                        explanation: None,
                        metadata: None,
                    })
                })
                .collect()
        })
    }
    fn doc_count(&self) -> usize {
        self.reader.searcher().num_docs() as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_statistics_match_a_single_corpus_index() {
        let dir = tempfile::tempdir().unwrap();
        let chunks = [
            "rare common",
            "common common common",
            "unrelated vocabulary",
            "common vocabulary",
        ]
        .iter()
        .enumerate()
        .map(|(i, text)| SemanticChunk {
            id: i.to_string(),
            document_id: "d".into(),
            document_hash: "h".into(),
            page: 0,
            block_index: 0,
            sentence_index: i,
            text: text.to_string(),
            target_text: text.to_string(),
            target_rects: vec![],
        })
        .collect::<Vec<_>>();
        KeywordReader::build(&dir.path().join("all"), &chunks).unwrap();
        KeywordReader::build(&dir.path().join("a"), &chunks[..1]).unwrap();
        KeywordReader::build(&dir.path().join("b"), &chunks[1..]).unwrap();
        let all = KeywordReader::open(&dir.path().join("all")).unwrap();
        let a = KeywordReader::open(&dir.path().join("a")).unwrap();
        let b = KeywordReader::open(&dir.path().join("b")).unwrap();
        let mut stats = CorpusStatistics::default();
        for reader in [&a, &b] {
            reader
                .accumulate_statistics("rare common", &mut stats)
                .unwrap();
        }
        let scores = |reader: &KeywordReader, stats: &dyn Bm25StatisticsProvider| {
            let parser = QueryParser::for_index(&reader.index, vec![reader.text]);
            let query = parser.parse_query("rare common").unwrap();
            let searcher = reader.reader.searcher();
            searcher
                .search_with_statistics_provider(
                    &query,
                    &TopDocs::with_limit(10).order_by_score(),
                    stats,
                )
                .unwrap()
                .into_iter()
                .map(|(score, addr)| {
                    let doc: TantivyDocument = searcher.doc(addr).unwrap();
                    (
                        doc.get_first(reader.id)
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .to_string(),
                        score,
                    )
                })
                .collect::<HashMap<_, _>>()
        };
        let expected = scores(&all, &all.reader.searcher());
        let mut actual = scores(&a, &stats);
        actual.extend(scores(&b, &stats));
        assert_eq!(actual.len(), expected.len());
        for (id, score) in expected {
            assert!(
                (actual[&id] - score).abs() < 0.00001,
                "{id}: {} != {score}",
                actual[&id]
            );
        }
    }
}
