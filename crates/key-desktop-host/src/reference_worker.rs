// Reference detection and lookup for the key-store library, after a PDF's text is in.
// The bibliography is found by the native paper analyser (the same one the reader's
// References panel uses), stored with where each entry is printed, then each entry is
// looked up (Crossref and friends, cached in the scholarly cache the reader shares) and
// linked to a library source when the cited work is already there. The in-text citations
// found alongside are stored too, so the reader can show them without analysing again.
use super::{
    BoundsDto, DocumentDto, LinkDto, LinkTargetDto, NativePdfService, PaperPreprocessingDto, Reply, Request, ScientificCitationDto,
    ScientificReferenceDto, scholarly_resolver,
};
use key_store::{CitationInput, ReferenceInput, Store};
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

/// Documents larger than this are skipped (the analyser reads them whole).
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const LOOKUPS_AT_ONCE: usize = 3;
/// The analyser that finds in-text citations; raising it finds them again for every PDF.
/// 1: numbered and superscript citations, and author–year ones with unnumbered lists.
pub const CITATIONS_VERSION: i64 = 1;

#[derive(Clone, Default)]
pub struct ReferenceWorker {
    signal: Arc<(Mutex<bool>, Condvar)>,
    /// Sources open in a reader go first.
    focus: Arc<Mutex<Vec<String>>>,
}

impl ReferenceWorker {
    pub fn start(store: Store, native: NativePdfService, cache: key_library::Library) -> Self {
        let worker = Self::default();
        let run = worker.clone();
        thread::Builder::new()
            .name("key-references".into())
            .spawn(move || run.run(store, native, cache))
            .expect("spawn reference worker");
        worker
    }

    pub fn wake(&self) {
        let (lock, condvar) = &*self.signal;
        if let Ok(mut woken) = lock.lock() {
            *woken = true;
            condvar.notify_all();
        }
    }

    pub fn focus(&self, id: &str) {
        if let Ok(mut focus) = self.focus.lock() {
            focus.retain(|f| f != id);
            focus.insert(0, id.to_string());
            focus.truncate(8);
        }
        self.wake();
    }

    fn run(self, store: Store, native: NativePdfService, cache: key_library::Library) {
        loop {
            let focus = self.focus.lock().map(|f| f.clone()).unwrap_or_default();
            match store.next_reference_job(&focus, CITATIONS_VERSION) {
                Ok(Some(id)) => {
                    if let Err(error) = process(&store, &native, &cache, &id) {
                        let _ = store.set_references_status(&id, "failed", Some(&error), 0, 0);
                    }
                }
                Ok(None) | Err(_) => {
                    let (lock, condvar) = &*self.signal;
                    if let Ok(guard) = lock.lock() {
                        if let Ok((mut guard, _)) = condvar.wait_timeout_while(guard, Duration::from_secs(15), |woken| !*woken) {
                            *guard = false;
                        }
                    }
                }
            }
        }
    }
}

fn process(store: &Store, native: &NativePdfService, cache: &key_library::Library, id: &str) -> Result<(), String> {
    let Some(analysis) = store.analysis(id)? else { return Ok(()) };
    // References already done: only the in-text citations are missing (or outdated).
    let refresh = matches!(analysis.references_status.as_str(), "done" | "none");
    match detect(store, native, cache, id, analysis.analyzed_at, refresh) {
        // Keep what was found before; don't try this PDF's citations again.
        Err(_) if refresh => store.replace_citations(id, CITATIONS_VERSION, false, None, &[]),
        result => result,
    }
}

fn detect(store: &Store, native: &NativePdfService, cache: &key_library::Library, id: &str, started: i64, refresh: bool) -> Result<(), String> {
    // Still the same analysis? A re-run in the meantime starts this over.
    let current = || store.analysis(id).ok().flatten().is_some_and(|a| a.analyzed_at == started);
    let source = store.source(id)?.ok_or("The source no longer exists")?;
    let path = source.file_path().filter(|p| p.is_file()).ok_or("The PDF file is missing")?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        store.replace_citations(id, CITATIONS_VERSION, false, None, &[])?;
        return store.set_references_status(id, "none", Some("Too large to analyse"), 0, 0);
    }
    if !refresh {
        store.set_references_status(id, "detecting", None, 0, 0)?;
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let analysed = match native.request(|reply| Request::Preprocess { id: format!("references:{id}"), bytes, reply })? {
        Reply::Preprocessing(analysis) => analysis,
        _ => return Err("Unexpected analysis reply".into()),
    };
    if !current() {
        return Ok(());
    }
    let citations = analysed.citations.iter().map(citation).collect::<Vec<_>>();
    let signals = serde_json::to_value(&analysed.signals).ok();
    store.replace_citations(id, CITATIONS_VERSION, analysed.is_scientific, signals.as_ref(), &citations)?;
    let references = analysed.references;
    // The same bibliography as before keeps its lookups.
    if refresh && store.references(id)?.iter().map(|r| r.text.as_str()).eq(references.iter().map(|r| r.text.as_str())) {
        return Ok(());
    }
    if references.is_empty() {
        store.replace_references(id, &[])?;
        return store.set_references_status(id, "none", None, 0, 0);
    }
    store.replace_references(id, &references.iter().map(input).collect::<Vec<_>>())?;
    let total = references.len() as i64;
    store.set_references_status(id, "resolving", None, 0, total)?;
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    thread::scope(|scope| {
        for _ in 0..LOOKUPS_AT_ONCE.min(references.len()) {
            scope.spawn(|| {
                loop {
                    let seq = next.fetch_add(1, Ordering::Relaxed);
                    let Some(reference) = references.get(seq) else { break };
                    if !current() {
                        break;
                    }
                    if let Some(metadata) = &reference.metadata {
                        let _ = scholarly_resolver::seed(cache, &reference.text, metadata);
                    }
                    let (metadata, error) = match scholarly_resolver::resolve(cache, &reference.text, false) {
                        Ok(metadata) => (serde_json::to_value(metadata).ok(), None),
                        Err(error) => (None, Some(error)),
                    };
                    let _ = store.resolve_reference(id, seq as i64, metadata.as_ref(), error.as_deref());
                    let finished = done.fetch_add(1, Ordering::Relaxed) as i64 + 1;
                    let _ = store.set_references_status(id, "resolving", None, finished, total);
                }
            });
        }
    });
    if current() {
        store.set_references_status(id, "done", None, total, total)?;
    }
    Ok(())
}

fn input(reference: &ScientificReferenceDto) -> ReferenceInput {
    ReferenceInput {
        number: Some(reference.number as i64),
        page: Some(reference.page as i64),
        rects: reference.text_runs.iter().map(rect).collect(),
        text: reference.text.clone(),
        metadata: reference.metadata.as_ref().and_then(|m| serde_json::to_value(m).ok()),
    }
}

fn citation(citation: &ScientificCitationDto) -> CitationInput {
    CitationInput {
        page: citation.page as i64,
        start: citation.start as i64,
        end: citation.end as i64,
        rect: rect(&citation.bounds),
        text: citation.source.clone(),
        numbers: citation.numbers.iter().map(|&n| n as i64).collect(),
    }
}

/// The reader's analysis of a library PDF, rebuilt from what was stored, and whether
/// reference lookups are still running. None until its citations have been found by the
/// current analyser.
pub(super) fn stored_analysis(store: &Store, id: &str, document: &DocumentDto) -> Option<(PaperPreprocessingDto, bool)> {
    let analysis = store.analysis(id).ok()??;
    if analysis.citations_version.unwrap_or(0) < CITATIONS_VERSION || !matches!(analysis.references_status.as_str(), "resolving" | "done" | "none") {
        return None;
    }
    let references = store
        .references(id)
        .ok()?
        .into_iter()
        .filter_map(|reference| {
            let text_runs = reference.rects.iter().map(bounds).collect::<Vec<_>>();
            let first = text_runs.first().copied();
            Some(ScientificReferenceDto {
                number: u32::try_from(reference.number?).ok()?,
                page: reference.page.unwrap_or(0) as usize,
                x_fraction: first.map(|b| (b.left + b.right) * 0.5),
                y_fraction: first.map(|b| b.top),
                text: reference.text,
                text_runs,
                metadata: reference.metadata.and_then(|m| serde_json::from_value(m).ok()),
                metadata_error: reference.error,
            })
        })
        .collect::<Vec<_>>();
    let citations = store
        .citations(id)
        .ok()?
        .into_iter()
        .map(|citation| ScientificCitationDto {
            id: format!("{}:{}:{}:{}", citation.page, citation.start, citation.end, citation.seq),
            page: citation.page as usize,
            start: citation.start as usize,
            end: citation.end as usize,
            bounds: bounds(&citation.rect),
            source: citation.text,
            numbers: citation.numbers.into_iter().filter_map(|n| u32::try_from(n).ok()).collect(),
        })
        .collect::<Vec<_>>();
    // Each citation also links to its first entry, unless the PDF already has a link there.
    let mut synthetic_links: Vec<LinkDto> = Vec::new();
    for citation in &citations {
        let Some(reference) = citation.numbers.iter().find_map(|n| references.iter().find(|r| r.number == *n)) else { continue };
        let taken = document.links.iter().chain(&synthetic_links).any(|link| link.page == citation.page && overlap(&link.bounds, &citation.bounds));
        if !taken {
            synthetic_links.push(LinkDto {
                id: document.links.len() + synthetic_links.len(),
                page: citation.page,
                bounds: citation.bounds,
                target: LinkTargetDto::Internal { page: reference.page, x_fraction: reference.x_fraction, y_fraction: reference.y_fraction },
            });
        }
    }
    Some((
        PaperPreprocessingDto {
            document: document.clone(),
            is_scientific: analysis.scientific.unwrap_or(false),
            synthetic_links,
            citations,
            references,
            signals: analysis.signals.and_then(|s| serde_json::from_value(s).ok()).unwrap_or_default(),
            processing_ms: 0.0,
        },
        analysis.references_status == "resolving",
    ))
}

fn bounds(rect: &[u16; 4]) -> BoundsDto {
    let f = |v: u16| v as f32 / u16::MAX as f32;
    BoundsDto { left: f(rect[0]), top: f(rect[1]), right: f(rect[0].saturating_add(rect[2])), bottom: f(rect[1].saturating_add(rect[3])) }
}

fn overlap(a: &BoundsDto, b: &BoundsDto) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/// [x, y, width, height] on a 0..65535 page scale.
fn rect(bounds: &BoundsDto) -> [u16; 4] {
    let q = |v: f32| (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16;
    let (x, y) = (q(bounds.left), q(bounds.top));
    [x, y, q(bounds.right).saturating_sub(x), q(bounds.bottom).saturating_sub(y)]
}
