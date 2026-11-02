// Hybrid search: FTS5 keyword ranks and sqlite-vec nearest neighbours are fused
// with reciprocal-rank fusion, then grouped into one hit per source. Each hit carries
// the source itself, the metadata fields that matched and its best passages, including
// those of its notes. Standalone notes are ranked the same way and returned beside them.
use crate::{ListQuery, Result, Source, e, fts_any, fts_any_prefix, read_source, select_sources, vector_blob, where_clause};
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const CANDIDATES: usize = 300;
const RRF_K: f64 = 60.0;
/// Passages found only by meaning must be at least this close (cosine distance). Measured on
/// a 4,400-item library: relevant passages sit below 0.26, unrelated queries never reach 0.30.
const MAX_SEMANTIC_DISTANCE: f64 = 0.27;
/// sources_fts columns shown as field matches, by index. The title is always on screen.
const FIELDS: [(usize, &str); 6] = [(1, "creators"), (2, "container"), (3, "abstract"), (4, "tags"), (5, "notes"), (6, "identifiers")];

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
    /// Found by meaning only: no query word occurs in it.
    pub related: bool,
    /// Set when the passage is from a note rather than the document.
    pub note_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMatch {
    /// creators | container | abstract | tags | notes | identifiers
    pub field: String,
    /// The matching stretch with matches wrapped in `[[` `]]`.
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub source_id: String,
    pub document_hash: String,
    pub title: String,
    pub score: f64,
    pub metadata_match: bool,
    pub source: Option<Source>,
    pub fields: Vec<FieldMatch>,
    pub passages: Vec<SearchPassage>,
}

/// A note that belongs to no source.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteHit {
    pub note_id: String,
    /// Its title, or else its first line.
    pub title: String,
    pub score: f64,
    pub passages: Vec<SearchPassage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// Standalone notes, only when nothing narrows the search to part of the library.
    pub notes: Vec<NoteHit>,
    pub semantic: bool,
    pub keyword_passages: usize,
    pub semantic_passages: usize,
}

/// What a passage is ranked under: its source (also for a source's note), or a standalone note.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Owner {
    Source(String),
    Note(String),
}

struct Candidate {
    owner: Owner,
    score: f64,
    snippet: Option<String>,
}

fn owner(source_id: Option<String>, note_id: Option<String>) -> Owner {
    match source_id {
        Some(id) => Owner::Source(id),
        None => Owner::Note(note_id.unwrap_or_default()),
    }
}

/// Standalone notes belong to no collection, kind or tag, so they only match when nothing
/// narrows the search.
fn whole_library(filter: &ListQuery) -> bool {
    filter.collection_id.is_none()
        && filter.tag.is_none()
        && filter.kind.is_none()
        && filter.item_type.is_none()
        && filter.ids.is_none()
        && filter.filters.is_empty()
        && filter.year_from.is_none()
        && filter.year_to.is_none()
        && matches!(filter.scope.as_deref(), None | Some("all"))
}

pub(crate) fn run(db: &Connection, query: &SearchQuery, vector: Option<&[f32]>) -> Result<SearchResult> {
    let mode = query.mode.as_deref().unwrap_or("hybrid");
    let mut filter = query.filter.clone();
    filter.text = None;
    let (clause, values) = where_clause(&filter);
    let eligible = format!("SELECT s.id FROM sources s {clause}");
    // Passages of eligible sources and their notes, and of standalone notes when they count.
    let standalone = if whole_library(&filter) { "OR (c.note_id IS NOT NULL AND n.source_id IS NULL)" } else { "" };
    let owned = format!("(coalesce(c.source_id, n.source_id) IN ({eligible}) {standalone})");
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
                    "SELECT c.id, coalesce(c.source_id, n.source_id), c.note_id, snippet(chunks_fts, 0, '[[', ']]', '…', 28)
                     FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid LEFT JOIN notes n ON n.id = c.note_id
                     WHERE chunks_fts MATCH ?1 AND {owned}
                     ORDER BY bm25(chunks_fts) LIMIT {CANDIDATES}"
                ))
                .map_err(e)?;
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, i64>(0)?, owner(r.get(1)?, r.get(2)?), r.get::<_, String>(3)?)))
                .map_err(e)?;
            for (rank, row) in rows.enumerate() {
                let (id, owner, snippet) = row.map_err(e)?;
                keyword_passages += 1;
                chunks.insert(id, Candidate { owner, score: 1.0 / (RRF_K + rank as f64 + 1.0), snippet: Some(snippet) });
            }
        }
    }

    if mode != "keyword" {
        if let Some(vector) = vector {
            let mut statement = db
                .prepare(&format!(
                    "SELECT knn.rowid, coalesce(c.source_id, n.source_id), c.note_id
                     FROM (SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ?1 AND k = {CANDIDATES}) knn
                     JOIN chunks c ON c.id = knn.rowid LEFT JOIN notes n ON n.id = c.note_id
                     WHERE (knn.distance <= {MAX_SEMANTIC_DISTANCE} OR knn.rowid IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?2))
                       AND {owned}
                     ORDER BY knn.distance"
                ))
                .map_err(e)?;
            // Keyword passages keep their semantic credit at any distance; the rest must be close.
            // ?2 must appear before the filter's unnumbered placeholders, which SQLite numbers
            // after the highest index seen so far.
            let keyword = fts_any(&query.text).unwrap_or_else(|| "\"\"".into());
            let mut args: Vec<Value> = vec![Value::Blob(vector_blob(vector)?), Value::Text(keyword)];
            args.extend(values.iter().cloned());
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, i64>(0)?, owner(r.get(1)?, r.get(2)?))))
                .map_err(e)?;
            for (rank, row) in rows.enumerate() {
                let (id, owner) = row.map_err(e)?;
                semantic_passages += 1;
                let rrf = 1.0 / (RRF_K + rank as f64 + 1.0);
                chunks
                    .entry(id)
                    .and_modify(|c| c.score += rrf)
                    .or_insert(Candidate { owner, score: rrf, snippet: None });
            }
        }
    }

    // Title, author, journal, tag and note matches lift a source even without passages.
    // The last word matches as a prefix from two letters, so results follow typing.
    let metadata_phrase = fts_any_prefix(&query.text, 2);
    let mut metadata: HashMap<String, f64> = HashMap::new();
    if let Some(phrase) = &metadata_phrase {
        let mut args: Vec<Value> = vec![Value::Text(phrase.clone())];
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

    let mut by_owner: HashMap<Owner, Vec<(i64, Candidate)>> = HashMap::new();
    for (id, candidate) in chunks {
        by_owner.entry(candidate.owner.clone()).or_default().push((id, candidate));
    }
    let mut ranked: Vec<(Owner, f64)> = by_owner
        .iter()
        .map(|(owner, list)| {
            let best = list.iter().map(|(_, c)| c.score).fold(0.0, f64::max);
            // A little credit for several matching passages, without letting long documents dominate.
            let breadth = list.iter().map(|(_, c)| c.score).sum::<f64>() * 0.15;
            let lift = match owner {
                Owner::Source(id) => metadata.get(id).copied().unwrap_or(0.0),
                Owner::Note(_) => 0.0,
            };
            (owner.clone(), best + breadth + lift)
        })
        .collect();
    for (id, score) in &metadata {
        if !by_owner.contains_key(&Owner::Source(id.clone())) {
            ranked.push((Owner::Source(id.clone()), *score));
        }
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let (mut sources, mut notes): (Vec<_>, Vec<_>) = ranked.into_iter().partition(|(owner, _)| matches!(owner, Owner::Source(_)));
    sources.truncate(limit);
    notes.truncate(limit.min(10));

    let per_source = query.passages_per_source.unwrap_or(3).min(20);
    let mut text_of = db
        .prepare("SELECT page, start_seconds, text, note_id FROM chunks WHERE id = ?")
        .map_err(e)?;
    // The best passages of one hit; `skip_abstract` when the abstract already shows as a field.
    let mut passages_of = |owner: &Owner, skip_abstract: bool| -> Result<Vec<SearchPassage>> {
        let mut list = by_owner.remove(owner).unwrap_or_default();
        list.sort_by(|a, b| b.1.score.total_cmp(&a.1.score));
        let mut passages = Vec::new();
        for (id, candidate) in list {
            if passages.len() == per_source {
                break;
            }
            let (page, start_seconds, text, note_id): (Option<i64>, Option<f64>, String, Option<String>) = text_of
                .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map_err(e)?;
            if skip_abstract && note_id.is_none() && page.is_none() && start_seconds.is_none() {
                continue;
            }
            let related = candidate.snippet.is_none();
            let snippet = candidate.snippet.unwrap_or_else(|| excerpt(&text, 220));
            passages.push(SearchPassage { id: id.to_string(), page, start_seconds, snippet, text, score: candidate.score, related, note_id });
        }
        Ok(passages)
    };

    let mut hits = Vec::with_capacity(sources.len());
    let mut source_of = db.prepare(&format!("{} WHERE s.id = ?", select_sources())).map_err(e)?;
    let snippets = FIELDS
        .iter()
        .map(|(column, _)| {
            let tokens = if matches!(column, 3 | 5) { 28 } else { 16 };
            format!("snippet(sources_fts, {column}, '[[', ']]', '…', {tokens})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut fields_of = db
        .prepare(&format!(
            "SELECT {snippets} FROM sources_fts WHERE sources_fts MATCH ?1 AND rowid = (SELECT rowid FROM sources WHERE id = ?2)"
        ))
        .map_err(e)?;
    for (owner, score) in sources {
        let Owner::Source(source_id) = &owner else { continue };
        let Some(source) = source_of.query_row([source_id], read_source).optional().map_err(e)? else { continue };
        let mut fields = Vec::new();
        if let (Some(phrase), true) = (&metadata_phrase, metadata.contains_key(source_id)) {
            let found = fields_of
                .query_row([phrase.as_str(), source_id.as_str()], |r| {
                    (0..FIELDS.len()).map(|i| r.get::<_, Option<String>>(i)).collect::<rusqlite::Result<Vec<_>>>()
                })
                .optional()
                .map_err(e)?
                .unwrap_or_default();
            for ((_, field), snippet) in FIELDS.iter().zip(found) {
                if let Some(snippet) = snippet.filter(|s| s.contains("[[")) {
                    fields.push(FieldMatch { field: (*field).into(), snippet });
                }
            }
        }
        // The abstract is also indexed as a passage, and notes are too; show each once.
        let abstract_shown = fields.iter().any(|f| f.field == "abstract");
        let passages = passages_of(&owner, abstract_shown)?;
        if passages.iter().any(|p| p.note_id.is_some()) {
            fields.retain(|f| f.field != "notes");
        }
        hits.push(SearchHit {
            metadata_match: metadata.contains_key(source_id),
            document_hash: source.file_hash().unwrap_or(source_id).to_string(),
            title: source.title().to_string(),
            source_id: source_id.clone(),
            score,
            source: Some(source),
            fields,
            passages,
        });
    }

    let mut title_of = db
        .prepare("SELECT title, (SELECT text FROM chunks WHERE note_id = notes.id ORDER BY seq LIMIT 1) FROM notes WHERE id = ?")
        .map_err(e)?;
    let mut note_hits = Vec::with_capacity(notes.len());
    for (owner, score) in notes {
        let Owner::Note(note_id) = &owner else { continue };
        let Some((title, first)) = title_of
            .query_row([note_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
            .optional()
            .map_err(e)?
        else {
            continue;
        };
        let title = if title.trim().is_empty() { excerpt(first.as_deref().unwrap_or("").lines().next().unwrap_or(""), 80) } else { title };
        note_hits.push(NoteHit { note_id: note_id.clone(), title, score, passages: passages_of(&owner, false)? });
    }
    Ok(SearchResult { hits, notes: note_hits, semantic: vector.is_some() && mode != "keyword", keyword_passages, semantic_passages })
}

fn excerpt(text: &str, limit: usize) -> String {
    let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= limit {
        return clean;
    }
    let cut: String = clean.chars().take(limit).collect();
    format!("{}…", cut.rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut))
}
