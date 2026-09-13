//! Workspace-persistent DOI/title resolution. No PDF bytes or responses retained in RAM.
use super::*;
use key_library::{Library, ScholarlyCacheEntry};
use key_reference::ScholarlyQuery;
use serde_json::Value;
use std::sync::{Condvar, Weak};

const DAY: i64 = 86_400_000;
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
type Flight = (Mutex<bool>, Condvar);
fn flights() -> &'static Mutex<HashMap<(PathBuf, String), Weak<Flight>>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<(PathBuf, String), Weak<Flight>>>> = OnceLock::new();
    FLIGHTS.get_or_init(Default::default)
}
struct Owner(Arc<Flight>);
impl Drop for Owner {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.0.1.notify_all();
    }
}
fn key(resource: &str) -> Result<String, String> {
    ScholarlyQuery::from_reference(resource)
        .map(|q| q.cache_key())
        .ok_or("No usable DOI or title".into())
}
fn cached(entry: &ScholarlyCacheEntry, at: i64) -> Option<Result<Value, String>> {
    if entry.expires_at > at || entry.retry_after > at {
        return Some(entry.payload.clone().ok_or_else(|| {
            entry
                .error
                .clone()
                .unwrap_or("Metadata lookup is pending".into())
        }));
    }
    None
}
/// Legacy document results become reusable records without another network request.
pub(super) fn seed(
    library: &Library,
    resource: &str,
    metadata: &ScholarlyMetadataDto,
) -> Result<(), String> {
    let Ok(key) = key(resource) else {
        return Ok(());
    };
    if library.scholarly_get(&key)?.is_none() {
        let at = now();
        library.scholarly_put(&ScholarlyCacheEntry {
            key,
            payload: Some(serde_json::to_value(metadata).map_err(|e| e.to_string())?),
            error: None,
            fetched_at: at,
            expires_at: at + 30 * DAY,
            retry_after: 0,
            attempts: 0,
        })?;
    }
    Ok(())
}
fn resolve_with(
    library: &Library,
    resource: &str,
    fetch: impl FnOnce() -> Result<Value, String>,
) -> Result<Value, String> {
    let cache_key = key(resource)?;
    if let Some(entry) = library.scholarly_get(&cache_key)? {
        if !entry
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("Metadata lookup pending"))
        {
            if let Some(result) = cached(&entry, now()) {
                return result;
            }
        }
    }
    let flight = {
        let mut all = flights().lock().unwrap_or_else(|e| e.into_inner());
        all.retain(|_, flight| flight.strong_count() > 0);
        let id = (library.root().to_path_buf(), cache_key.clone());
        if let Some(flight) = all.get(&id).and_then(Weak::upgrade) {
            flight
        } else {
            let flight = Arc::new((Mutex::new(false), Condvar::new()));
            all.insert(id, Arc::downgrade(&flight));
            flight
        }
    };
    let mut running = flight.0.lock().unwrap_or_else(|e| e.into_inner());
    while *running {
        running = flight.1.wait(running).unwrap_or_else(|e| e.into_inner());
    }
    // The preceding owner persisted before waking waiters.
    if let Some(entry) = library.scholarly_get(&cache_key)? {
        if let Some(result) = cached(&entry, now()) {
            return result;
        }
    }
    *running = true;
    drop(running);
    let _owner = Owner(flight);
    let previous = library.scholarly_get(&cache_key)?;
    let at = now();
    // Persist an expiring lease: interruption cannot leave an immortal Loading entry.
    library.scholarly_put(&ScholarlyCacheEntry {
        key: cache_key.clone(),
        payload: previous.as_ref().and_then(|e| e.payload.clone()),
        error: Some("Metadata lookup pending; retry after lease expiry".into()),
        fetched_at: previous.as_ref().map_or(0, |e| e.fetched_at),
        expires_at: 0,
        retry_after: at + 45_000,
        attempts: previous.as_ref().map_or(0, |e| e.attempts),
    })?;
    let result = fetch();
    let mut entry = match result {
        Ok(payload) => ScholarlyCacheEntry {
            key: cache_key.clone(),
            payload: Some(payload),
            error: None,
            fetched_at: now(),
            expires_at: now() + 30 * DAY,
            retry_after: 0,
            attempts: 0,
        },
        Err(error) => {
            let attempts = previous
                .as_ref()
                .map_or(1, |e| e.attempts.saturating_add(1));
            let delay = if error.to_ascii_lowercase().contains("not found") {
                12 * 60 * 60 * 1000
            } else {
                60_000i64
                    .saturating_mul(1i64 << attempts.min(9))
                    .min(6 * 60 * 60 * 1000)
            };
            let provider_delay = error
                .split("retry after about ")
                .nth(1)
                .and_then(|s| s.split('s').next())
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0)
                .clamp(0, 30 * DAY / 1000)
                * 1000;
            let delay = delay.max(provider_delay);
            ScholarlyCacheEntry {
                key: cache_key.clone(),
                payload: previous.as_ref().and_then(|e| e.payload.clone()),
                error: Some(error),
                fetched_at: previous.as_ref().map_or(0, |e| e.fetched_at),
                expires_at: 0,
                retry_after: now() + delay,
                attempts,
            }
        }
    };
    library.scholarly_put(&entry)?;
    // DOI aliases share the result of a title/landing-page lookup.
    if entry.error.is_none() {
        if let Some(doi) = entry
            .payload
            .as_ref()
            .and_then(|v| v.get("doi"))
            .and_then(Value::as_str)
        {
            if let Ok(alias) = key(doi) {
                if alias != cache_key {
                    entry.key = alias;
                    library.scholarly_put(&entry)?;
                }
            }
        }
    }
    entry
        .payload
        .ok_or_else(|| entry.error.unwrap_or("Metadata unavailable".into()))
}
fn fetch(resource: &str, interactive: bool) -> Result<Value, String> {
    let (fetcher, events) = ScholarlyFetcher::new();
    let mut session = ScholarlySession::default();
    fetcher.begin_document(1);
    let requested = if interactive {
        session.request_interactive(&fetcher, 1, resource)
    } else {
        session.request(&fetcher, 1, resource)
    };
    if !requested {
        return Err("Metadata lookup unavailable (queue full or invalid reference)".into());
    }
    session.apply(
        events
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Metadata lookup timed out")?,
    );
    match session.state(resource) {
        Some(ScholarlyMetadataState::Ready(metadata)) => {
            serde_json::to_value(ScholarlyMetadataDto::from((**metadata).clone()))
                .map_err(|e| e.to_string())
        }
        Some(ScholarlyMetadataState::Failed(error)) => Err(error.clone()),
        _ => Err("Metadata lookup incomplete".into()),
    }
}
pub(super) fn resolve(
    library: &Library,
    resource: &str,
    interactive: bool,
) -> Result<ScholarlyMetadataDto, String> {
    // Display stale success immediately on click; refresh through the bounded background queue.
    if interactive {
        if let Some(entry) = library.scholarly_get(&key(resource)?)? {
            if let Some(payload) = entry.payload {
                if entry.expires_at <= now() && entry.retry_after <= now() {
                    let library = library.clone();
                    let resource = resource.to_owned();
                    enrichment_scheduler().submit(
                        format!("scholarly:{}", entry.key),
                        "refresh",
                        0,
                        move || {
                            let _ = resolve_with(&library, &resource, || fetch(&resource, false));
                        },
                    );
                }
                return serde_json::from_value(payload).map_err(|e| e.to_string());
            }
        }
    }
    serde_json::from_value(resolve_with(library, resource, || {
        fetch(resource, interactive)
    })?)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn persisted_reuse_aliases_and_failure_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let calls = AtomicUsize::new(0);
        let value = resolve_with(&lib, "An example research title", || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({"title":"Example","doi":"10.1000/EXAMPLE"}))
        })
        .unwrap();
        drop(lib);
        let lib = Library::open(dir.path()).unwrap();
        assert_eq!(
            resolve_with(&lib, "https://doi.org/10.1000/example", || panic!(
                "must reuse DOI alias"
            ))
            .unwrap(),
            value
        );
        assert!(resolve_with(&lib, "10.1000/failure", || Err("offline".into())).is_err());
        assert!(
            resolve_with(&lib, "10.1000/failure", || panic!(
                "backoff must survive database writes"
            ))
            .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn concurrent_requests_share_one_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let count = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let lib = &lib;
                let count = &count;
                scope.spawn(move || {
                    let result = resolve_with(lib, "10.1000/shared", || {
                        count.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(30));
                        Ok(serde_json::json!({"title":"Shared"}))
                    });
                    assert_eq!(result.unwrap()["title"], "Shared");
                });
            }
        });
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn saved_document_metadata_hydrates_after_restart_and_serves_clicks() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let metadata:ScholarlyMetadataDto=serde_json::from_value(serde_json::json!({"source":"Crossref","sources":["Crossref"],"title":"Saved paper","authors":["A. Author"],"doi":"10.1000/saved"})).unwrap();
        seed(&lib, "https://doi.org/10.1000/SAVED", &metadata).unwrap();
        drop(lib);
        let lib = Library::open(dir.path()).unwrap();
        let mut references = vec![ScientificReferenceDto {
            number: 1,
            page: 0,
            x_fraction: None,
            y_fraction: None,
            text: "10.1000/saved".into(),
            text_runs: vec![],
            metadata: None,
            metadata_error: None,
        }];
        hydrate(&lib, &mut references).unwrap();
        assert_eq!(
            references[0].metadata.as_ref().unwrap().title,
            "Saved paper"
        );
        assert_eq!(
            resolve(&lib, "https://doi.org/10.1000/SAVED", true)
                .unwrap()
                .title,
            "Saved paper"
        );
    }
    #[test]
    fn interrupted_lookup_retries_after_lease_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        lib.scholarly_put(&ScholarlyCacheEntry {
            key: key("10.1000/interrupted").unwrap(),
            payload: None,
            error: Some("Metadata lookup pending; retry after lease expiry".into()),
            fetched_at: 0,
            expires_at: 0,
            retry_after: 1,
            attempts: 0,
        })
        .unwrap();
        assert_eq!(
            resolve_with(&lib, "10.1000/interrupted", || Ok(
                serde_json::json!({"title":"Recovered"})
            ))
            .unwrap()["title"],
            "Recovered"
        );
    }
    #[test]
    fn provider_cooldown_is_not_shortened_by_generic_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let before = now();
        assert!(
            resolve_with(&lib, "10.1000/rate", || Err(
                "Semantic Scholar rate limited the lookup; retry after about 3600s".into()
            ))
            .is_err()
        );
        assert!(
            lib.scholarly_get(&key("10.1000/rate").unwrap())
                .unwrap()
                .unwrap()
                .retry_after
                >= before + 3_600_000
        );
    }
    #[test]
    fn failed_refresh_preserves_last_good_value() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        lib.scholarly_put(&ScholarlyCacheEntry {
            key: key("10.1000/stale").unwrap(),
            payload: Some(serde_json::json!({"title":"Saved"})),
            error: None,
            fetched_at: 1,
            expires_at: 1,
            retry_after: 0,
            attempts: 0,
        })
        .unwrap();
        assert_eq!(
            resolve_with(&lib, "10.1000/stale", || Err("offline".into())).unwrap()["title"],
            "Saved"
        );
    }
}

pub(super) fn hydrate(
    library: &Library,
    references: &mut [ScientificReferenceDto],
) -> Result<(), String> {
    for reference in references {
        let Ok(key) = key(&reference.text) else {
            continue;
        };
        if let Some(entry) = library.scholarly_get(&key)? {
            if let Some(payload) = entry.payload {
                reference.metadata =
                    Some(serde_json::from_value(payload).map_err(|e| e.to_string())?);
                reference.metadata_error = None;
            }
        }
    }
    Ok(())
}

/// Only failed/interrupted jobs are scanned, not the entire document library.
/// Deadlines live in SQLite, so restarting the host never resets provider backoff.
pub(super) fn start_retry_worker(library: Library) {
    std::thread::Builder::new()
        .name("scholarly-retries".into())
        .spawn(move || {
            loop {
                match library.scholarly_due(now(), 16) {
                    Ok(entries) => {
                        for entry in entries {
                            let Some((_, resource)) = entry.key.split_once(':') else {
                                continue;
                            };
                            let resource = resource.to_owned();
                            let library = library.clone();
                            enrichment_scheduler().submit(
                                format!("scholarly:{}", entry.key),
                                "retry",
                                0,
                                move || {
                                    let _ = resolve_with(&library, &resource, || {
                                        fetch(&resource, false)
                                    });
                                },
                            );
                        }
                    }
                    Err(error) => eprintln!("Scholarly retry queue unavailable: {error}"),
                }
                std::thread::sleep(Duration::from_secs(30));
            }
        })
        .expect("scholarly retry worker");
}
