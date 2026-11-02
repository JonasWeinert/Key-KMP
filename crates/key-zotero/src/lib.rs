// Zotero import and sync. Reads a private copy of zotero.sqlite (Zotero may hold a lock on
// the original, and Key never writes to it), maps items onto key-store sources, links
// attachments in place, converts notes to Markdown and mirrors collections.
pub mod html;
mod snapshot;
mod state;
mod sync;

use key_store::{SourceInput, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

pub use snapshot::Stamp;
pub use sync::Mode;

pub type Result<T> = std::result::Result<T, String>;
pub const ORIGIN: &str = "zotero";

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Zotero data directory (contains zotero.sqlite and storage/). Defaults to the
    /// directory configured in Zotero's prefs, then ~/Zotero.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
    /// Restrict to these collection names (and their sub-collections).
    #[serde(default)]
    pub collections: Option<Vec<String>>,
    /// Restrict to these Zotero collections, by key. Sub-collections are listed explicitly.
    #[serde(default)]
    pub collection_keys: Option<Vec<String>>,
    /// Link each item's PDF (or other file) where Zotero keeps it.
    #[serde(default = "yes")]
    pub attachments: bool,
    /// Bring notes across as Markdown.
    #[serde(default = "yes")]
    pub notes: bool,
    /// Bring each PDF's Zotero highlights across as a note of quotes.
    #[serde(default = "yes")]
    pub annotations: bool,
    /// Create Key collections for Zotero's collections and keep items filed in them.
    #[serde(default = "yes")]
    pub mirror_collections: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions { data_dir: None, collections: None, collection_keys: None, attachments: true, notes: true, annotations: true, mirror_collections: true }
    }
}

/// A value kept in Key although Zotero changed it too.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// The source, note or collection it concerns.
    pub title: String,
    /// The field, or "note" / "collection".
    pub what: String,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub data_dir: PathBuf,
    /// Items in Key after the run that came from Zotero (added, updated or unchanged).
    pub items: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    /// Moved to Key's trash because they were deleted in Zotero.
    pub trashed: usize,
    /// Taken out of Key's trash because they are back in Zotero.
    pub restored: usize,
    /// Deleted in Key earlier, so not brought back.
    pub kept_deleted: usize,
    pub collections: usize,
    pub collections_deleted: usize,
    pub notes: usize,
    pub notes_updated: usize,
    pub notes_deleted: usize,
    pub annotations: usize,
    pub linked_files: usize,
    pub missing_files: usize,
    /// Items outside the chosen collections.
    pub skipped: usize,
    pub conflict_count: usize,
    pub conflicts: Vec<Conflict>,
}

/// How far an import has got: reading the library, then items, notes, saving.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub done: usize,
    pub total: usize,
}
impl Progress {
    pub fn new(stage: &str, done: usize, total: usize) -> Self {
        Progress { stage: stage.into(), done, total }
    }
}

/// The Zotero data directory: Zotero's `extensions.zotero.dataDir` pref, else ~/Zotero.
pub fn default_data_dir() -> Option<PathBuf> {
    if let Some(dir) = pref("extensions.zotero.dataDir").map(PathBuf::from).filter(|d| d.join("zotero.sqlite").is_file()) {
        return Some(dir);
    }
    let fallback = PathBuf::from(std::env::var_os("HOME")?).join("Zotero");
    fallback.join("zotero.sqlite").is_file().then_some(fallback)
}

/// A string pref from Zotero's profile (prefs.js).
pub(crate) fn pref(name: &str) -> Option<String> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let profiles = home.join("Library/Application Support/Zotero/Profiles");
    let prefix = format!("user_pref(\"{name}\", \"");
    for entry in std::fs::read_dir(&profiles).ok()?.flatten() {
        let Ok(prefs) = std::fs::read_to_string(entry.path().join("prefs.js")) else { continue };
        for line in prefs.lines() {
            if let Some(rest) = line.strip_prefix(&prefix) {
                return Some(rest.trim_end_matches("\");").replace("\\\\", "\\"));
            }
        }
    }
    None
}

/// Imports (or re-imports) a Zotero library. Edits made in Key since the last import are
/// kept; nothing is trashed or deleted.
pub fn import(store: &Store, options: &ImportOptions) -> Result<ImportReport> {
    sync::run(store, options, Mode::Import, &|_| {})
}

/// Imports with progress reports, in either mode.
pub fn run(store: &Store, options: &ImportOptions, mode: Mode, progress: &dyn Fn(Progress)) -> Result<ImportReport> {
    sync::run(store, options, mode, progress)
}

/// What the last import or sync used, so a sync can repeat it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub options: Option<ImportOptions>,
    pub stamp: Option<Stamp>,
    pub at: Option<i64>,
}

pub fn last_run(store: &Store) -> Result<LastRun> {
    let (options, stamp, at) = sync::last_run(store)?;
    Ok(LastRun { options, stamp, at })
}

/// Whether zotero.sqlite changed since the last run and has been still for `settle_ms`,
/// so a sync is worth running (Zotero writes in bursts).
pub fn changed_since_last_run(store: &Store, data_dir: &Path, settle_ms: i64) -> Result<bool> {
    let now = Stamp::of(data_dir)?;
    let last = sync::last_run(store)?.1;
    Ok(last != Some(now) && now.age_ms() >= settle_ms)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub items: usize,
    /// Items with a linked file (PDF, snapshot or media).
    pub files: usize,
    pub notes: usize,
    pub annotations: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCollection {
    pub key: String,
    pub name: String,
    pub parent_key: Option<String>,
    /// Items filed directly in it.
    pub items: usize,
    /// Items in it or any collection inside it, each counted once.
    pub total: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub data_dir: PathBuf,
    pub collections: Vec<PreviewCollection>,
    /// The whole library.
    pub library: Counts,
    /// What the given options would bring across.
    pub selected: Counts,
    /// Items in no collection.
    pub unfiled: usize,
}

/// The library's collections with item counts, and what an import with `options` covers.
pub fn preview(options: &ImportOptions) -> Result<Preview> {
    let data_dir = options.data_dir.clone().or_else(default_data_dir).ok_or("No Zotero library found. Choose its data folder (it contains zotero.sqlite).")?;
    let snapshot = snapshot::Snapshot::load(&data_dir)?;
    let top: Vec<i64> = snapshot
        .items
        .iter()
        .map(|i| i.id)
        .chain(snapshot.attachments.iter().filter(|a| a.parent.is_none() && a.path.is_some()).map(|a| a.id))
        .collect();
    let mut members: HashMap<i64, Vec<i64>> = HashMap::new();
    for item in &top {
        for collection in snapshot.collections_of.get(item).into_iter().flatten() {
            members.entry(*collection).or_default().push(*item);
        }
    }
    let collections = snapshot
        .collections
        .iter()
        .map(|c| {
            let all: HashSet<i64> = snapshot.with_descendants(&[c.id]).iter().flat_map(|id| members.get(id).into_iter().flatten().copied()).collect();
            PreviewCollection {
                key: c.key.clone(),
                name: c.name.clone(),
                parent_key: c.parent.and_then(|p| snapshot.collection(p)).map(|p| p.key.clone()),
                items: members.get(&c.id).map_or(0, Vec::len),
                total: all.len(),
            }
        })
        .collect();
    let count = |items: &HashSet<i64>, options: &ImportOptions| {
        let attachments_of: HashMap<i64, i64> = snapshot.attachments.iter().map(|a| (a.id, a.parent.unwrap_or(a.id))).collect();
        Counts {
            items: items.len(),
            files: if options.attachments {
                snapshot.attachments.iter().filter(|a| a.path.is_some() && items.contains(&a.parent.unwrap_or(a.id))).map(|a| a.parent.unwrap_or(a.id)).collect::<HashSet<_>>().len()
            } else {
                0
            },
            notes: if options.notes { snapshot.notes.iter().filter(|n| n.parent.is_some_and(|p| items.contains(&p))).count() } else { 0 },
            annotations: if options.annotations {
                snapshot.annotations.iter().filter(|a| attachments_of.get(&a.attachment).is_some_and(|owner| items.contains(owner))).count()
            } else {
                0
            },
        }
    };
    let everything: HashSet<i64> = top.iter().copied().collect();
    let selected: HashSet<i64> = match &options.collection_keys {
        None => everything.clone(),
        Some(keys) => {
            let ids: HashSet<i64> = snapshot.collections.iter().filter(|c| keys.contains(&c.key)).map(|c| c.id).collect();
            top.iter().copied().filter(|item| snapshot.collections_of.get(item).is_some_and(|c| c.iter().any(|c| ids.contains(c)))).collect()
        }
    };
    let mut selected_counts = count(&selected, options);
    if options.notes && options.collection_keys.is_none() {
        selected_counts.notes += snapshot.notes.iter().filter(|n| n.parent.is_none()).count();
    }
    Ok(Preview {
        data_dir,
        collections,
        library: count(&everything, &ImportOptions::default()),
        selected: selected_counts,
        unfiled: top.iter().filter(|i| !snapshot.collections_of.contains_key(i)).count(),
    })
}

/// Sets a source's file fields (or, without a file, whether its abstract can be indexed).
fn attach(input: &mut SourceInput, file: Option<(PathBuf, String)>) {
    let Some((path, content_type)) = file else {
        // Without a file only the abstract is indexed; with neither there is nothing to embed.
        let has_abstract = input.fields.get("abstract").and_then(Json::as_str).is_some_and(|a| !a.trim().is_empty());
        input.index_status = Some(if has_abstract { "pending" } else { "skipped" }.into());
        return;
    };
    let kind = match content_type.as_str() {
        "application/pdf" => "pdf",
        "text/html" => "web",
        t if t.starts_with("video/") => "video",
        t if t.starts_with("audio/") => "audio",
        t if t.starts_with("image/") => "image",
        _ => "file",
    };
    if input.kind == "reference" || input.kind == "web" && kind == "pdf" {
        input.kind = kind.into();
    }
    if path.is_file() {
        input.fields.insert("fileSize".into(), Json::from(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)));
    } else {
        input.index_status = Some("missing".into());
    }
    input.fields.insert("filePath".into(), Json::from(path.to_string_lossy().to_string()));
    input.fields.insert("mime".into(), Json::from(content_type));
}

/// Maps a Zotero item type and its fields onto key-store's columns. Fields without a
/// column are kept as readable user properties so nothing is lost.
pub fn map_item(zotero_type: &str, fields: Option<&Vec<(String, String)>>) -> SourceInput {
    let (item_type, kind) = match zotero_type {
        "journalArticle" => ("article", "reference"),
        "magazineArticle" => ("magazine-article", "reference"),
        "newspaperArticle" => ("newspaper-article", "reference"),
        "bookSection" => ("chapter", "reference"),
        "conferencePaper" => ("conference-paper", "reference"),
        "computerProgram" => ("software", "reference"),
        "webpage" => ("webpage", "web"),
        "blogPost" => ("blog-post", "web"),
        "forumPost" => ("forum-post", "web"),
        "videoRecording" | "film" | "tvBroadcast" => ("video", "video"),
        "audioRecording" | "podcast" | "radioBroadcast" => ("audio", "audio"),
        "artwork" => ("image", "image"),
        "book" | "report" | "thesis" | "dataset" | "preprint" | "document" | "manuscript" | "presentation" | "patent"
        | "map" | "letter" | "interview" | "standard" | "statute" | "case" | "hearing" | "bill" | "email" => (zotero_type, "reference"),
        "encyclopediaArticle" | "dictionaryEntry" => ("entry", "reference"),
        _ => ("document", "reference"),
    };
    let mut input = SourceInput { kind: kind.into(), ..Default::default() };
    input.fields.insert("itemType".into(), Json::from(item_type));
    let mut properties = Map::new();
    for (field, value) in fields.into_iter().flatten() {
        let value = value.as_str();
        match field.as_str() {
            "title" => put(&mut input.fields, "title", value),
            "shortTitle" => put(&mut input.fields, "shortTitle", value),
            "date" => {
                put(&mut input.fields, "date", value);
                if let Some(year) = year_of(value) {
                    input.fields.insert("year".into(), Json::from(year));
                }
            }
            "publicationTitle" | "bookTitle" | "proceedingsTitle" | "websiteTitle" | "blogTitle" | "forumTitle"
            | "programTitle" | "encyclopediaTitle" | "dictionaryTitle" | "seriesTitle" => put(&mut input.fields, "containerTitle", value),
            "journalAbbreviation" => put(&mut input.fields, "containerShort", value),
            "volume" => put(&mut input.fields, "volume", value),
            "issue" => put(&mut input.fields, "issue", value),
            "pages" => put(&mut input.fields, "pages", value),
            "edition" => put(&mut input.fields, "edition", value),
            "series" => put(&mut input.fields, "series", value),
            "publisher" | "company" | "label" | "distributor" | "network" | "studio" => put(&mut input.fields, "publisher", value),
            "place" => put(&mut input.fields, "place", value),
            "institution" | "university" => put(&mut input.fields, "institution", value),
            "genre" | "websiteType" | "reportType" | "thesisType" | "videoRecordingFormat" | "audioRecordingFormat" | "artworkMedium" => {
                put(&mut input.fields, "genre", value)
            }
            "DOI" => put(&mut input.fields, "doi", value),
            "ISBN" => put(&mut input.fields, "isbn", value),
            "ISSN" => put(&mut input.fields, "issn", value),
            "PMID" => put(&mut input.fields, "pmid", value),
            "PMCID" => put(&mut input.fields, "pmcid", value),
            "url" => put(&mut input.fields, "url", value),
            "accessDate" => put(&mut input.fields, "accessed", value),
            "abstractNote" => put(&mut input.fields, "abstract", value),
            "language" => put(&mut input.fields, "language", value),
            "rights" => put(&mut input.fields, "rights", value),
            "citationKey" => put(&mut input.fields, "citationKey", value),
            "extra" => {
                put(&mut input.fields, "extra", value);
                for line in value.lines() {
                    if let Some(id) = line.strip_prefix("arXiv:").or_else(|| line.strip_prefix("arXiv ID:")) {
                        put(&mut input.fields, "arxivId", id.trim());
                    }
                }
            }
            "archiveID" if value.starts_with("arXiv:") => put(&mut input.fields, "arxivId", value.trim_start_matches("arXiv:")),
            "runningTime" => {
                if let Some(seconds) = duration_seconds(value) {
                    input.fields.insert("durationSeconds".into(), Json::from(seconds));
                }
            }
            "conferenceName" => {
                properties.insert("Conference".into(), Json::from(value));
            }
            "numPages" => {
                properties.insert("Pages (total)".into(), Json::from(value));
            }
            other => {
                properties.insert(label(other), Json::from(value));
            }
        }
    }
    input.properties = properties;
    input
}

fn put(fields: &mut Map<String, Json>, name: &str, value: &str) {
    fields.entry(name.to_string()).or_insert_with(|| Json::from(decode_entities(value.trim())));
}

/// Zotero keeps some imported fields HTML-escaped ("Social &amp; Personality").
fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn label(field: &str) -> String {
    let mut out = String::new();
    for (index, c) in field.chars().enumerate() {
        if index == 0 {
            out.extend(c.to_uppercase());
        } else if c.is_uppercase() {
            out.push(' ');
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn year_of(date: &str) -> Option<i64> {
    date.as_bytes()
        .windows(4)
        .find(|w| w.iter().all(u8::is_ascii_digit) && (w[0] == b'1' || w[0] == b'2'))
        .and_then(|w| std::str::from_utf8(w).ok()?.parse().ok())
}

fn duration_seconds(value: &str) -> Option<f64> {
    let parts: Vec<f64> = value.split(':').map(|p| p.trim().parse::<f64>()).collect::<std::result::Result<_, _>>().ok()?;
    Some(parts.iter().fold(0.0, |total, p| total * 60.0 + p))
}

fn parse_zotero_date(value: &str) -> Option<i64> {
    // "YYYY-MM-DD HH:MM:SS" in UTC -> epoch milliseconds.
    let (date, time) = value.split_once(' ')?;
    let d: Vec<i64> = date.split('-').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let t: Vec<i64> = time.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let (y, m, day) = (d[0], d[1], d[2]);
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400) + t[0] * 3600 + t[1] * 60 + t[2]) * 1000)
}

pub(crate) fn depth(collections: &[(i64, String, Option<i64>, String)], id: i64) -> usize {
    let mut depth = 0;
    let mut current = collections.iter().find(|c| c.0 == id).and_then(|c| c.2);
    while let Some(parent) = current {
        depth += 1;
        current = collections.iter().find(|c| c.0 == parent).and_then(|c| c.2);
        if depth > 64 {
            break;
        }
    }
    depth
}


#[cfg(test)]
mod sync_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_fields_dates_and_html() {
        let fields = vec![
            ("title".to_string(), "Health versus income".to_string()),
            ("date".to_string(), "2022-03-01 March 1, 2022".to_string()),
            ("publicationTitle".to_string(), "Social Science & Medicine".to_string()),
            ("DOI".to_string(), "10.1016/j.socscimed.2022.114".to_string()),
            ("libraryCatalog".to_string(), "ScienceDirect".to_string()),
        ];
        let input = map_item("journalArticle", Some(&fields));
        assert_eq!(input.fields["itemType"], "article");
        assert_eq!(input.fields["year"], 2022);
        assert_eq!(input.fields["containerTitle"], "Social Science & Medicine");
        assert_eq!(input.properties["Library catalog"], "ScienceDirect");
        assert_eq!(parse_zotero_date("1970-01-02 00:00:01"), Some(86_401_000));
        assert_eq!(duration_seconds("1:02:03"), Some(3723.0));
        let escaped = vec![("publicationTitle".to_string(), "Social &amp; Personality Psych".to_string())];
        assert_eq!(map_item("journalArticle", Some(&escaped)).fields["containerTitle"], "Social & Personality Psych");
    }
}
