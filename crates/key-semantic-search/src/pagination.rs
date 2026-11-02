//! Short-lived search snapshots keep passage IDs and scores, not snippet copies.
use crate::{SemanticSearchHitDto, SemanticSearchService};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
#[derive(Default)]
pub struct SearchSessions {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    next: u64,
    snapshots: HashMap<u64, Snapshot>,
}
struct Snapshot {
    created: Instant,
    hits: Vec<(String, f32)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<SemanticSearchHitDto>,
    pub next_cursor: Option<String>,
    pub capped: bool,
}
impl SearchSessions {
    pub fn search(
        &self,
        service: &SemanticSearchService,
        query: String,
        filter: key_library::Filter,
        cursor: Option<String>,
    ) -> Result<SearchPage, String> {
        let (token, offset) = if let Some(cursor) = cursor {
            let (token, offset) = cursor.split_once(':').ok_or("Invalid search cursor")?;
            (
                token.parse::<u64>().map_err(|_| "Invalid search cursor")?,
                offset
                    .parse::<usize>()
                    .map_err(|_| "Invalid search cursor")?,
            )
        } else {
            let hits = service
                .search(query, 1000, filter)?
                .into_iter()
                .map(|h| (h.id, h.score))
                .collect();
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Search snapshot lock poisoned")?;
            state
                .snapshots
                .retain(|_, s| s.created.elapsed() < Duration::from_secs(300));
            if state.snapshots.len() >= 4 {
                if let Some(oldest) = state
                    .snapshots
                    .iter()
                    .min_by_key(|(_, s)| s.created)
                    .map(|(key, _)| *key)
                {
                    state.snapshots.remove(&oldest);
                }
            }
            state.next = state.next.wrapping_add(1);
            let token = state.next;
            state.snapshots.insert(
                token,
                Snapshot {
                    created: Instant::now(),
                    hits,
                },
            );
            (token, 0)
        };
        let (ids, next_cursor, capped) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Search snapshot lock poisoned")?;
            let snapshot = state
                .snapshots
                .get(&token)
                .filter(|s| s.created.elapsed() < Duration::from_secs(300))
                .ok_or("Search expired; search again to refresh results")?;
            if offset > snapshot.hits.len() {
                return Err("Invalid search cursor offset".into());
            }
            let end = offset.saturating_add(30).min(snapshot.hits.len());
            (
                snapshot.hits[offset..end].to_vec(),
                (end < snapshot.hits.len()).then(|| format!("{token}:{end}")),
                snapshot.hits.len() == 1000,
            )
        };
        let mut hits = Vec::new();
        let passages = service.library().passage_reader()?;
        for (id, score) in ids {
            if let Some(p) = passages.passage(&id)? {
                hits.push(SemanticSearchHitDto {
                    id: p.id,
                    document_id: p.document_hash.clone(),
                    document_hash: p.document_hash,
                    page: p.page,
                    text: p.text,
                    target_text: p.target_text,
                    score,
                });
            }
        }
        Ok(SearchPage {
            hits,
            next_cursor,
            capped,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_are_stable_disjoint_and_hide_removed_documents() {
        let tmp = tempfile::tempdir().unwrap();
        let service = SemanticSearchService::try_start_at(tmp.path().into()).unwrap();
        let lib = service.library();
        let hash = lib.store_source(b"paging", "Paging", 1).unwrap();
        let chunks = (0..70)
            .map(|i| {
                let id = format!("passage-{i:03}");
                lib.store_block(
                    &hash,
                    &id,
                    "term",
                    &[key_library::ChunkAnchor {
                        id: id.clone(),
                        page: 0,
                        context_start: 0,
                        context_end: 4,
                        target_start: 0,
                        target_end: 4,
                        rects: vec![],
                    }],
                )
                .unwrap();
                crate::SemanticChunk {
                    id,
                    document_id: hash.clone(),
                    document_hash: hash.clone(),
                    page: 0,
                    block_index: i,
                    sentence_index: 0,
                    text: "term".into(),
                    target_text: "term".into(),
                    target_rects: vec![],
                }
            })
            .collect::<Vec<_>>();
        crate::search::index_keywords(&tmp.path().join("frankensearch"), &chunks).unwrap();
        let sessions = SearchSessions::default();
        let a = sessions
            .search(&service, "term".into(), Default::default(), None)
            .unwrap();
        assert_eq!(a.hits.len(), 30);
        let b = sessions
            .search(&service, "term".into(), Default::default(), a.next_cursor)
            .unwrap();
        assert_eq!(b.hits.len(), 30);
        assert!(a.hits.iter().all(|a| b.hits.iter().all(|b| a.id != b.id)));
        lib.set_removed(&hash, true).unwrap();
        let c = sessions
            .search(&service, "term".into(), Default::default(), b.next_cursor)
            .unwrap();
        assert!(c.hits.is_empty());
        assert!(c.next_cursor.is_none());
        assert!(
            sessions
                .search(
                    &service,
                    "term".into(),
                    Default::default(),
                    Some("invalid".into())
                )
                .is_err()
        );
    }
}
