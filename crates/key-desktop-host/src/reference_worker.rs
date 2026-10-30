// Reference detection and lookup for the key-store library, after a PDF's text is in.
// The bibliography is found by the native paper analyser (the same one the reader's
// References panel uses), stored with where each entry is printed, then each entry is
// looked up (Crossref and friends, cached in the scholarly cache the reader shares) and
// linked to a library source when the cited work is already there.
use super::{BoundsDto, NativePdfService, Reply, Request, ScientificReferenceDto, scholarly_resolver};
use key_store::{ReferenceInput, Store};
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
            match store.next_reference_job(&focus) {
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
    let started = analysis.analyzed_at;
    // Still the same analysis? A re-run in the meantime starts this over.
    let current = || store.analysis(id).ok().flatten().is_some_and(|a| a.analyzed_at == started);
    let source = store.source(id)?.ok_or("The source no longer exists")?;
    let path = source.file_path().filter(|p| p.is_file()).ok_or("The PDF file is missing")?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        return store.set_references_status(id, "none", Some("Too large to analyse"), 0, 0);
    }
    store.set_references_status(id, "detecting", None, 0, 0)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let analysed = match native.request(|reply| Request::Preprocess { id: format!("references:{id}"), bytes, reply })? {
        Reply::Preprocessing(analysis) => analysis,
        _ => return Err("Unexpected analysis reply".into()),
    };
    if !current() {
        return Ok(());
    }
    let references = analysed.references;
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

/// [x, y, width, height] on a 0..65535 page scale.
fn rect(bounds: &BoundsDto) -> [u16; 4] {
    let q = |v: f32| (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16;
    let (x, y) = (q(bounds.left), q(bounds.top));
    [x, y, q(bounds.right).saturating_sub(x), q(bounds.bottom).saturating_sub(y)]
}
