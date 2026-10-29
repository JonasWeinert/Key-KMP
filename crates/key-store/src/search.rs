// Hybrid search: FTS5 keyword ranks and sqlite-vec nearest neighbours are fused
// with reciprocal-rank fusion, then grouped into one hit per source.
use crate::{ListQuery, Result, e, fts_any, vector_blob, where_clause};
use rusqlite::{Connection, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const CANDIDATES: usize = 300;
const RRF_K: f64 = 60.0;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    /// hybrid (default) | keyword | semantic
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(flatten)]
    pub filter: ListQuery,
    #[serde(default)]
    pub passages_per_source: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPassage {
    pub id: String,
    pub page: Option<i64>,
    pub start_seconds: Option<f64>,
    /// Snippet with matches wrapped in `[[` `]]` when the keyword index found them.
    pub snippet: String,
    pub text: String,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub source_id: String,
    pub document_hash: String,
    pub title: String,
    pub score: f64,
    pub metadata_match: bool,
    pub passages: Vec<SearchPassage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub semantic: bool,
    pub keyword_passages: usize,
    pub semantic_passages: usize,
}

struct Candidate {
    source_id: String,
    score: f64,
    snippet: Option<String>,
}

pub(crate) fn run(db: &Connection, query: &SearchQuery, vector: Option<&[f32]>) -> Result<SearchResult> {
    let mode = query.mode.as_deref().unwrap_or("hybrid");
    let mut filter = query.filter.clone();
    filter.text = None;
    let (clause, values) = where_clause(&filter);
    let eligible = format!("SELECT s.id FROM sources s {clause}");
    let limit = filter.limit.unwrap_or(50).min(500);
    let mut chunks: HashMap<i64, Candidate> = HashMap::new();
    let mut keyword_passages = 0;
    let mut semantic_passages = 0;

    if mode != "semantic" {
        if let Some(phrase) = fts_any(&query.text) {
            let mut args: Vec<Value> = vec![Value::Text(phrase)];
            args.extend(values.iter().cloned());
            let mut statement = db
                .prepare(&format!(
                    "SELECT c.id, c.source_id, snippet(chunks_fts, 0, '[[', ']]', '…', 28)
                     FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
                     WHERE chunks_fts MATCH ?1 AND c.source_id IN ({eligible})
                     ORDER BY bm25(chunks_fts) LIMIT {CANDIDATES}"
                ))
                .map_err(e)?;
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
                .map_err(e)?;
            for (rank, row) in rows.enumerate() {
                let (id, source_id, snippet) = row.map_err(e)?;
                keyword_passages += 1;
                chunks.insert(id, Candidate { source_id, score: 1.0 / (RRF_K + rank as f64 + 1.0), snippet: Some(snippet) });
            }
        }
    }

    if mode != "keyword" {
        if let Some(vector) = vector {
            let mut statement = db
                .prepare(&format!(
                    "SELECT knn.rowid, c.source_id
                     FROM (SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ?1 AND k = {CANDIDATES}) knn
                     JOIN chunks c ON c.id = knn.rowid
                     WHERE c.source_id IN ({eligible})
                     ORDER BY knn.distance"
                ))
                .map_err(e)?;
            let mut args: Vec<Value> = vec![Value::Blob(vector_blob(vector)?)];
            args.extend(values.iter().cloned());
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(e)?;
            for (rank, row) in rows.enumerate() {
                let (id, source_id) = row.map_err(e)?;
                semantic_passages += 1;
                let rrf = 1.0 / (RRF_K + rank as f64 + 1.0);
                chunks
                    .entry(id)
                    .and_modify(|c| c.score += rrf)
                    .or_insert(Candidate { source_id, score: rrf, snippet: None });
            }
        }
    }

    // Title, author, journal, tag and note matches lift a source even without passages.
    let mut metadata: HashMap<String, f64> = HashMap::new();
    if let Some(phrase) = fts_any(&query.text) {
        let mut args: Vec<Value> = vec![Value::Text(phrase)];
        args.extend(values.iter().cloned());
        let mut statement = db
            .prepare(&format!(
                "SELECT s.id FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
                 WHERE sources_fts MATCH ?1 AND s.id IN ({eligible})
                 ORDER BY bm25(sources_fts, 10.0, 6.0, 3.0, 2.0, 4.0, 1.0, 8.0) LIMIT {CANDIDATES}"
            ))
            .map_err(e)?;
        let rows = statement
            .query_map(params_from_iter(args.iter()), |r| r.get::<_, String>(0))
            .map_err(e)?;
        for (rank, row) in rows.enumerate() {
            metadata.insert(row.map_err(e)?, 2.0 / (RRF_K + rank as f64 + 1.0));
        }
    }

    let mut by_source: HashMap<String, Vec<(i64, Candidate)>> = HashMap::new();
    for (id, candidate) in chunks {
        by_source.entry(candidate.source_id.clone()).or_default().push((id, candidate));
    }
    let mut ranked: Vec<(String, f64)> = by_source
        .iter()
        .map(|(id, list)| {
            let best = list.iter().map(|(_, c)| c.score).fold(0.0, f64::max);
            // A little credit for several matching passages, without letting long documents dominate.
            let breadth = list.iter().map(|(_, c)| c.score).sum::<f64>() * 0.15;
            (id.clone(), best + breadth + metadata.get(id).copied().unwrap_or(0.0))
        })
        .collect();
    for (id, score) in &metadata {
        if !by_source.contains_key(id) {
            ranked.push((id.clone(), *score));
        }
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked.truncate(limit);

    let per_source = query.passages_per_source.unwrap_or(3).min(20);
    let mut hits = Vec::with_capacity(ranked.len());
    let mut text_of = db
        .prepare("SELECT page, start_seconds, text FROM chunks WHERE id = ?")
        .map_err(e)?;
    let mut source_of = db
        .prepare("SELECT title, coalesce(file_hash, id) FROM sources WHERE id = ?")
        .map_err(e)?;
    for (source_id, score) in ranked {
        let (title, document_hash): (String, String) = source_of
            .query_row([&source_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(e)?;
        let mut list = by_source.remove(&source_id).unwrap_or_default();
        list.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
        let mut passages = Vec::new();
        for (id, candidate) in list.into_iter().take(per_source) {
            let (page, start_seconds, text): (Option<i64>, Option<f64>, String) = text_of
                .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(e)?;
            let snippet = candidate.snippet.unwrap_or_else(|| excerpt(&text, 220));
            passages.push(SearchPassage { id: id.to_string(), page, start_seconds, snippet, text, score: candidate.score });
        }
        hits.push(SearchHit {
            metadata_match: metadata.contains_key(&source_id),
            source_id,
            document_hash,
            title,
            score,
            passages,
        });
    }
    Ok(SearchResult { hits, semantic: vector.is_some() && mode != "keyword", keyword_passages, semantic_passages })
}

fn excerpt(text: &str, limit: usize) -> String {
    let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= limit {
        return clean;
    }
    let cut: String = clean.chars().take(limit).collect();
    format!("{}…", cut.rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut))
}
