// OpenAlex enrichment for the key-store library (see key-store's openalex.rs for what is
// stored, cached and fetched on demand). A background worker looks up sources imported with
// a DOI, PMID or OpenAlex id (unless Settings turned that off) and any the user asks to
// enrich, one at a time: requests are paced, carry the `mailto` of the polite pool, retry
// with backoff when OpenAlex is busy, and a failed source is tried again later.
//
// With KEY_OPENALEX_FIXTURES set to a folder of recorded responses (W….json, A….json,
// S….json and works-batch.json), nothing goes to the network; tests and smokes use it.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_store::{EnrichJob, Store, name_key};
use serde_json::{Value as Json, json};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_MAILTO: &str = "key-app@users.noreply.github.com";
/// Pause between any two requests (OpenAlex allows ten a second; we stay well under).
const PACE: Duration = Duration::from_millis(250);
/// Cached counts older than this are fetched again when they are viewed.
const STALE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const ATTEMPTS: i64 = 6;
const WORK_FIELDS: &str = "id,doi,display_name,title,publication_year,publication_date,ids,language,primary_location,best_oa_location,type,open_access,authorships,biblio,is_retracted,cited_by_count,fwci,primary_topic,topics,keywords,funders,awards,referenced_works,abstract_inverted_index";
const CITED_FIELDS: &str = "id,doi,display_name,publication_year,authorships,primary_location";

#[derive(Clone, Debug)]
pub struct Options {
    /// Look up sources on import (Settings → Library).
    pub auto: bool,
    pub mailto: String,
    pub api_key: Option<String>,
}

impl Options {
    fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Self {
            auto: var("KEY_OPENALEX_ENABLED").is_none_or(|v| v != "0"),
            mailto: var("KEY_OPENALEX_MAILTO").filter(|m| m.contains('@')).unwrap_or_else(|| DEFAULT_MAILTO.into()),
            api_key: var("KEY_OPENALEX_API_KEY"),
        }
    }
}

/// Why a request did not give a record.
#[derive(Debug)]
pub enum Fail {
    NotFound,
    /// Worth trying again later (rate limited, server or network trouble).
    Busy(String),
    Error(String),
}
impl Fail {
    fn message(&self) -> String {
        match self {
            Fail::NotFound => "OpenAlex has no record of this work".into(),
            Fail::Busy(m) | Fail::Error(m) => m.clone(),
        }
    }
}

#[derive(Clone)]
pub struct OpenAlex {
    options: Arc<Mutex<Options>>,
    signal: Arc<(Mutex<bool>, Condvar)>,
    focus: Arc<Mutex<Vec<String>>>,
}

impl OpenAlex {
    pub fn start(store: Store) -> Self {
        let worker = Self { options: Arc::new(Mutex::new(Options::from_env())), signal: Default::default(), focus: Default::default() };
        let run = worker.clone();
        thread::Builder::new().name("key-openalex".into()).spawn(move || run.run(store)).expect("spawn OpenAlex worker");
        worker
    }

    pub fn options(&self) -> Options {
        self.options.lock().map(|o| o.clone()).unwrap_or_else(|_| Options::from_env())
    }

    pub fn wake(&self) {
        let (lock, condvar) = &*self.signal;
        if let Ok(mut woken) = lock.lock() {
            *woken = true;
            condvar.notify_all();
        }
    }

    /// Sources open in a view are looked up first.
    pub fn focus(&self, id: &str) {
        if let Ok(mut focus) = self.focus.lock() {
            focus.retain(|f| f != id);
            focus.insert(0, id.to_string());
            focus.truncate(8);
        }
    }

    fn run(self, store: Store) {
        loop {
            let options = self.options();
            let focus = self.focus.lock().map(|f| f.clone()).unwrap_or_default();
            match store.next_enrichment(options.auto, &focus) {
                Ok(Some(job)) => {
                    if let Err(fail) = enrich(&store, &job, &options) {
                        let (status, retry) = match &fail {
                            Fail::NotFound => ("not_found", None),
                            // Busy: back off 1, 2, 4 … minutes, then give up until asked again.
                            _ if job.attempts + 1 < ATTEMPTS => ("failed", Some(key_store::now_ms() + 60_000 * (1 << job.attempts.clamp(0, 10)))),
                            _ => ("failed", None),
                        };
                        let _ = store.enrichment_failed(&job.id, status, &fail.message(), retry);
                    }
                }
                Ok(None) | Err(_) => {
                    let (lock, condvar) = &*self.signal;
                    if let Ok(guard) = lock.lock() {
                        if let Ok((mut guard, _)) = condvar.wait_timeout_while(guard, Duration::from_secs(30), |woken| !*woken) {
                            *guard = false;
                        }
                    }
                }
            }
        }
    }
}

// ── Requests ────────────────────────────────────────────────

fn fixtures() -> Option<PathBuf> {
    std::env::var_os("KEY_OPENALEX_FIXTURES").map(PathBuf::from).filter(|p| p.is_dir())
}

/// One request: paced against every other, retried with backoff while OpenAlex is busy.
pub fn get(path: &str, query: &[(&str, &str)], options: &Options) -> Result<Json, Fail> {
    fetch(path, query, options, 3)
}

/// One attempt, for something the user is waiting on: no backoff sleeps.
fn get_now(path: &str, query: &[(&str, &str)], options: &Options) -> Result<Json, Fail> {
    fetch(path, query, options, 1)
}

fn fetch(path: &str, query: &[(&str, &str)], options: &Options, attempts: usize) -> Result<Json, Fail> {
    if let Some(dir) = fixtures() {
        return fixture(&dir, path, query);
    }
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut delay = Duration::from_secs(1);
    for attempt in 0..attempts {
        {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(wait) = last.and_then(|l| PACE.checked_sub(l.elapsed())) {
                thread::sleep(wait);
            }
            *last = Some(Instant::now());
        }
        let busy = match key_reference::openalex_get(path, query, Some(&options.mailto), options.api_key.as_deref()) {
            Ok(response) => match response.status {
                200..=299 => return serde_json::from_slice(&response.body).map_err(|e| Fail::Error(format!("OpenAlex sent an unreadable answer: {e}"))),
                404 => return Err(Fail::NotFound),
                429 | 500..=599 => {
                    delay = response.retry_after.map_or(delay, |d| d.min(Duration::from_secs(60)));
                    format!("OpenAlex is busy (HTTP {})", response.status)
                }
                status => return Err(Fail::Error(format!("OpenAlex returned HTTP {status}"))),
            },
            Err(error) => error,
        };
        if attempt + 1 == attempts {
            return Err(Fail::Busy(busy));
        }
        thread::sleep(delay);
        delay *= 2;
    }
    Err(Fail::Busy("OpenAlex did not answer".into()))
}

/// Recorded responses: `works/W1` reads W1.json; `works/doi:…`, `works/pmid:…` and
/// `authors/orcid:…` search the records; a `works` list filtered by `openalex:` ids
/// collects them from works-batch.json and the W files.
fn fixture(dir: &std::path::Path, path: &str, query: &[(&str, &str)]) -> Result<Json, Fail> {
    let read = |name: &str| -> Option<Json> { std::fs::read_to_string(dir.join(name)).ok().and_then(|t| serde_json::from_str(&t).ok()) };
    let records = || -> Vec<Json> {
        let mut all: Vec<Json> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .filter_map(|t| serde_json::from_str::<Json>(&t).ok())
            .filter(|v| v.get("id").is_some())
            .collect();
        if let Some(batch) = read("works-batch.json") {
            all.extend(batch["results"].as_array().cloned().unwrap_or_default());
        }
        all
    };
    let short = |v: &Json| v.get("id").and_then(Json::as_str).map(|id| id.rsplit('/').next().unwrap_or("").to_string()).unwrap_or_default();
    let (collection, key) = path.trim_matches('/').split_once('/').unwrap_or((path.trim_matches('/'), ""));
    if collection == "works" && key.is_empty() {
        let filter = query.iter().find(|(k, _)| *k == "filter").map(|(_, v)| *v).unwrap_or("");
        let results: Vec<Json> = if let Some(ids) = filter.strip_prefix("openalex:") {
            let ids: Vec<&str> = ids.split('|').collect();
            let mut seen = std::collections::HashSet::new();
            records().into_iter().filter(|r| ids.contains(&short(r).as_str()) && seen.insert(short(r))).collect()
        } else if let Some(title) = filter.strip_prefix("title.search:") {
            records().into_iter().filter(|r| r.get("display_name").and_then(Json::as_str).is_some_and(|t| name_key(t) == name_key(title))).take(1).collect()
        } else {
            Vec::new()
        };
        return Ok(json!({ "results": results }));
    }
    if let Some(found) = read(&format!("{key}.json")) {
        return Ok(found);
    }
    let (scheme, value) = key.split_once(':').ok_or(Fail::NotFound)?;
    let value = value.to_ascii_lowercase();
    records()
        .into_iter()
        .find(|r| {
            let field = match scheme {
                "doi" => r.get("doi"),
                "pmid" => r.get("ids").and_then(|i| i.get("pmid")),
                "orcid" => r.get("orcid"),
                _ => None,
            };
            field.and_then(Json::as_str).is_some_and(|f| f.to_ascii_lowercase().ends_with(&value))
        })
        .ok_or(Fail::NotFound)
}

fn bare_doi(doi: &str) -> String {
    let doi = doi.trim().to_ascii_lowercase();
    ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"].iter().find_map(|p| doi.strip_prefix(p).map(String::from)).unwrap_or(doi)
}

/// The work for a source: by OpenAlex id, DOI or PMID, else by an exact title match.
fn find_work(job: &EnrichJob, options: &Options) -> Result<Json, Fail> {
    let fields = [("select", WORK_FIELDS)];
    let ids = [
        job.openalex_id.as_deref().filter(|w| w.starts_with('W')).map(String::from),
        job.doi.as_deref().map(bare_doi).filter(|d| d.starts_with("10.")).map(|d| format!("doi:{d}")),
        job.pmid.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(|p| format!("pmid:{p}")),
    ];
    let mut last = Fail::NotFound;
    for id in ids.into_iter().flatten() {
        match get(&format!("works/{id}"), &fields, options) {
            Err(Fail::NotFound) => continue,
            Err(fail) => last = fail,
            found => return found,
        }
    }
    if !matches!(last, Fail::NotFound) {
        return Err(last);
    }
    // No identifier worked: an exact title (and, when known, the year) is accepted.
    let title = job.title.as_deref().map(str::trim).filter(|t| t.chars().count() >= 12).ok_or(Fail::NotFound)?;
    let filter = format!("title.search:{}", title.replace([',', '|', ':'], " "));
    let page = get("works", &[("filter", &filter), ("per-page", "5"), ("select", WORK_FIELDS)], options)?;
    page["results"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|w| {
            let same_title = w.get("display_name").and_then(Json::as_str).is_some_and(|t| name_key(t) == name_key(title));
            let year = w.get("publication_year").and_then(Json::as_i64);
            same_title && (job.year.is_none() || year.is_none() || job.year.zip(year).is_some_and(|(a, b)| (a - b).abs() <= 1))
        })
        .cloned()
        .ok_or(Fail::NotFound)
}

/// Looks one source up and stores what OpenAlex knows, then the details of what it cites.
pub fn enrich(store: &Store, job: &EnrichJob, options: &Options) -> Result<(), Fail> {
    let work = find_work(job, options)?;
    store.apply_openalex_work(&job.id, &work).map_err(Fail::Error)?;
    for _ in 0..4 {
        let ids = store.cites_without_details(&job.id, 50).map_err(Fail::Error)?;
        if ids.is_empty() {
            break;
        }
        let filter = format!("openalex:{}", ids.join("|"));
        let page = match get("works", &[("filter", &filter), ("per-page", "50"), ("select", CITED_FIELDS)], options) {
            Ok(page) => page,
            // The work itself is stored; the titles of what it cites can come another time.
            Err(_) => break,
        };
        let works = page["results"].as_array().cloned().unwrap_or_default();
        store.apply_openalex_cited(&job.id, &works).map_err(Fail::Error)?;
        if works.is_empty() {
            break;
        }
    }
    Ok(())
}

fn stale(fetched: Option<i64>) -> bool {
    fetched.is_none_or(|at| key_store::now_ms() - at > STALE_MS)
}

/// Works as OpenAlex lists them, each with the library source it is (if any).
fn described(store: &Store, ids: &[String], options: &Options) -> Result<Vec<Json>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let filter = format!("openalex:{}", ids.iter().take(50).cloned().collect::<Vec<_>>().join("|"));
    let page = get_now("works", &[("filter", &filter), ("per-page", "50"), ("select", CITED_FIELDS)], options).map_err(|f| f.message())?;
    let mut out = Vec::new();
    for work in page["results"].as_array().into_iter().flatten() {
        let id = work["id"].as_str().map(|i| i.rsplit('/').next().unwrap_or("").to_string()).unwrap_or_default();
        let doi = work["doi"].as_str().map(bare_doi);
        let names: Vec<&str> = work["authorships"].as_array().into_iter().flatten().filter_map(|a| a["author"]["display_name"].as_str()).collect();
        out.push(json!({
            "openalexId": id,
            "title": work["display_name"],
            "byline": match names.len() { 0 => String::new(), 1 | 2 => names.join(", "), _ => format!("{} et al.", names[0]) },
            "year": work["publication_year"],
            "doi": doi,
            "container": work["primary_location"]["source"]["display_name"],
            "matchedSourceId": store.source_for_work(Some(&id), doi.as_deref())?,
        }));
    }
    Ok(out)
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let store = &library.store;
    let openalex = &library.openalex;
    let result = match command {
        // The graph around one source, and the pages of a person, venue and topic.
        "store_source_graph" => arg::<String>(args, "id").and_then(|id| {
            openalex.focus(&id);
            json_output(store.source_graph(&id)?)
        }),
        "store_person" => arg::<String>(args, "id").and_then(|id| json_output(store.person_page(&id)?)),
        "store_venue" => arg::<String>(args, "id").and_then(|id| json_output(store.venue_page(&id)?)),
        "store_topic" => arg::<String>(args, "id").and_then(|id| json_output(store.topic_page(&id)?)),
        "store_merge_suggestions" => store.merge_suggestions().and_then(json_output),
        "store_merge_people" => (|| json_output(store.merge_people(&arg::<String>(args, "keep")?, &arg::<String>(args, "other")?)?))(),
        "store_merge_dismiss" => (|| json_output(store.dismiss_merge(&arg::<String>(args, "personId")?, &arg::<String>(args, "otherId")?)?))(),
        "store_property_options" => arg::<String>(args, "name").and_then(|name| json_output(store.property_options(&name)?)),
        "store_rename_property_option" => (|| {
            json_output(store.rename_property_option(&arg::<String>(args, "name")?, &arg::<String>(args, "from")?, &arg::<String>(args, "to")?)?)
        })(),
        // "Enrich" on a source or a selection.
        "store_enrich" => arg::<Vec<String>>(args, "ids").and_then(|ids| {
            let count = store.request_enrichment(&ids)?;
            openalex.wake();
            json_output(count)
        }),
        "store_enrich_options" => (|| {
            if let Ok(mut options) = openalex.options.lock() {
                if let Some(auto) = arg::<Option<bool>>(args, "auto")? {
                    options.auto = auto;
                }
                if let Some(mailto) = arg::<Option<String>>(args, "mailto")? {
                    options.mailto = Some(mailto.trim().to_string()).filter(|m| m.contains('@')).unwrap_or_else(|| DEFAULT_MAILTO.into());
                }
                if let Some(key) = arg::<Option<String>>(args, "apiKey")? {
                    options.api_key = Some(key.trim().to_string()).filter(|k| !k.is_empty());
                }
            }
            openalex.wake();
            let options = openalex.options();
            json_output(json!({ "auto": options.auto, "mailto": options.mailto, "queue": store.enrichment_queue(options.auto)? }))
        })(),
        // Cached counts (tier b), fetched again when stale and viewed. Without automatic
        // lookups only `force` (the user's Refresh) goes to the network.
        // Cached counts (tier b): answered at once with what is stored; when they are old (or
        // on the user's Refresh) they are fetched in the background and the page reads them
        // again. Without automatic lookups only `force` goes to the network.
        "store_refresh" => (|| {
            let kind: String = arg(args, "kind")?;
            let id: String = arg(args, "id")?;
            let force = arg::<Option<bool>>(args, "force")?.unwrap_or(false);
            let options = openalex.options();
            let allowed = force || options.auto;
            let (path, query): (Option<String>, &[(&str, &str)]) = match kind.as_str() {
                "person" => {
                    let person = store.person(&id)?.ok_or("Person not found")?;
                    let key = person.openalex_id.clone().or_else(|| person.orcid.as_ref().map(|o| format!("orcid:{o}")));
                    ((force || stale(person.metrics_at)).then_some(key).flatten().map(|k| format!("authors/{k}")), &[])
                }
                "venue" => {
                    let venue = store.venue(&id)?.ok_or("Journal not found")?;
                    ((force || stale(venue.metrics_at)).then_some(venue.openalex_id).flatten().map(|k| format!("sources/{k}")), &[])
                }
                _ => {
                    let source = store.source(&id)?.ok_or("Source not found")?;
                    let fetched = source.fields.get("metricsAt").and_then(Json::as_i64);
                    let work = source.field("openalexId").map(String::from);
                    ((force || stale(fetched)).then_some(work).flatten().map(|w| format!("works/{w}")), &[("select", "id,cited_by_count,fwci,is_retracted")])
                }
            };
            let refreshing = match path.filter(|_| allowed) {
                Some(path) => refresh_later(store.clone(), kind.clone(), id.clone(), path, query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), options),
                None => false,
            };
            let mut value = match kind.as_str() {
                "person" => serde_json::to_value(store.person_page(&id)?),
                "venue" => serde_json::to_value(store.venue_page(&id)?),
                _ => serde_json::to_value(store.source(&id)?),
            }
            .map_err(|e| e.to_string())?;
            if let Some(object) = value.as_object_mut() {
                object.insert("refreshing".into(), json!(refreshing));
            }
            json_output(value)
        })(),
        // Not stored (tier c): citations by year and related works, when the user asks.
        "store_openalex_extra" => (|| {
            let kind: String = arg(args, "kind")?;
            let id: String = arg(args, "id")?;
            let options = openalex.options();
            let path = match kind.as_str() {
                "person" => {
                    let person = store.person(&id)?.ok_or("Person not found")?;
                    format!("authors/{}", person.openalex_id.or(person.orcid.map(|o| format!("orcid:{o}"))).ok_or("Not in OpenAlex yet")?)
                }
                "venue" => format!("sources/{}", store.venue(&id)?.ok_or("Journal not found")?.openalex_id.ok_or("Not in OpenAlex yet")?),
                _ => format!("works/{}", store.source(&id)?.ok_or("Source not found")?.field("openalexId").ok_or("Not in OpenAlex yet")?),
            };
            let select = if kind == "source" { "id,counts_by_year,related_works" } else { "id,counts_by_year" };
            let record = get_now(&path, &[("select", select)], &options).map_err(|f| f.message())?;
            let related: Vec<String> = record["related_works"].as_array().into_iter().flatten().filter_map(Json::as_str).map(|w| w.rsplit('/').next().unwrap_or("").to_string()).collect();
            json_output(json!({ "countsByYear": record["counts_by_year"], "related": described(store, &related, &options)? }))
        })(),
        // "Add to library" for a cited work that is not in it yet: a reference, looked up next.
        "store_add_work" => (|| {
            let work: String = arg(args, "openalexId")?;
            if let Some(existing) = store.source_for_work(Some(&work), arg::<Option<String>>(args, "doi")?.as_deref())? {
                return json_output(store.source(&existing)?);
            }
            let mut fields = serde_json::Map::new();
            fields.insert("openalexId".into(), json!(work));
            fields.insert("itemType".into(), json!("article"));
            for (key, name) in [("title", "title"), ("doi", "doi"), ("year", "year")] {
                if let Some(value) = args.get(name).filter(|v| !v.is_null()) {
                    fields.insert(key.into(), value.clone());
                }
            }
            let collection: Option<String> = arg(args, "collectionId")?;
            let source = store.insert_source(key_store::SourceInput { kind: "reference".into(), fields, collections: collection.into_iter().collect(), index_status: Some("skipped".into()), ..Default::default() })?;
            store.request_enrichment(std::slice::from_ref(&source.id))?;
            openalex.focus(&source.id);
            openalex.wake();
            json_output(store.source(&source.id)?)
        })(),
        _ => return None,
    };
    Some(result)
}

/// Fetches cached counts on a thread of their own, once per item at a time. Answers whether
/// a fetch is running for it.
fn refresh_later(store: Store, kind: String, id: String, path: String, query: Vec<(String, String)>, options: Options) -> bool {
    static RUNNING: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let key = format!("{kind}:{id}");
    {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if running.contains(&key) {
            return true;
        }
        running.push(key.clone());
    }
    let spawned = thread::Builder::new().name("key-openalex-refresh".into()).spawn(move || {
        let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        if let Ok(record) = get(&path, &query, &options) {
            let _ = match kind.as_str() {
                "person" => store.apply_openalex_author(&id, &record),
                "venue" => store.apply_openalex_venue(&id, &record),
                _ => store.apply_openalex_metrics(&id, &record),
            };
        }
        RUNNING.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| *k != key);
    });
    spawned.is_ok()
}
