// Zotero import. Reads a private copy of zotero.sqlite (Zotero may hold a lock on the
// original), maps items onto key-store sources and links attachments in place.
use key_store::{Creator, SourceInput, Store};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
pub const ORIGIN: &str = "zotero";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Zotero data directory (contains zotero.sqlite and storage/). Defaults to the
    /// directory configured in Zotero's prefs, then ~/Zotero.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
    /// Restrict to these collection names (and their sub-collections).
    #[serde(default)]
    pub collections: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub data_dir: PathBuf,
    pub items: usize,
    pub collections: usize,
    pub notes: usize,
    pub linked_files: usize,
    pub missing_files: usize,
    pub skipped: usize,
}

/// The Zotero data directory: Zotero's `extensions.zotero.dataDir` pref, else ~/Zotero.
pub fn default_data_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let profiles = home.join("Library/Application Support/Zotero/Profiles");
    if let Ok(entries) = std::fs::read_dir(&profiles) {
        for entry in entries.flatten() {
            if let Ok(prefs) = std::fs::read_to_string(entry.path().join("prefs.js")) {
                for line in prefs.lines() {
                    if let Some(rest) = line.strip_prefix("user_pref(\"extensions.zotero.dataDir\", \"") {
                        let dir = PathBuf::from(rest.trim_end_matches("\");"));
                        if dir.join("zotero.sqlite").is_file() {
                            return Some(dir);
                        }
                    }
                }
            }
        }
    }
    let fallback = home.join("Zotero");
    fallback.join("zotero.sqlite").is_file().then_some(fallback)
}

pub fn import(store: &Store, options: &ImportOptions) -> Result<ImportReport> {
    let data_dir = options
        .data_dir
        .clone()
        .or_else(default_data_dir)
        .ok_or("No Zotero library found. Choose its data folder (it contains zotero.sqlite).")?;
    let copy = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    std::fs::copy(data_dir.join("zotero.sqlite"), copy.path()).map_err(|e| format!("Could not read zotero.sqlite: {e}"))?;
    let db = Connection::open_with_flags(copy.path(), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let mut report = ImportReport { data_dir: data_dir.clone(), ..Default::default() };

    // Collections first, parents before children.
    let mut zotero_collections: Vec<(i64, String, Option<i64>, String)> = query(
        &db,
        "SELECT collectionID, collectionName, parentCollectionID, key FROM collections",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let allowed_collections = options.collections.as_ref().map(|names| {
        let mut ids: Vec<i64> = zotero_collections.iter().filter(|c| names.contains(&c.1)).map(|c| c.0).collect();
        let mut index = 0;
        while index < ids.len() {
            let parent = ids[index];
            ids.extend(zotero_collections.iter().filter(|c| c.2 == Some(parent)).map(|c| c.0));
            index += 1;
        }
        ids
    });
    let depths: HashMap<i64, usize> = zotero_collections.iter().map(|c| (c.0, depth(&zotero_collections, c.0))).collect();
    zotero_collections.sort_by_key(|c| depths[&c.0]);
    let mut collection_map: HashMap<i64, String> = HashMap::new();
    for (id, name, parent, key) in &zotero_collections {
        if allowed_collections.as_ref().is_some_and(|allowed| !allowed.contains(id)) {
            continue;
        }
        let parent_id = parent.and_then(|p| collection_map.get(&p).cloned());
        let created = store.create_collection(name, parent_id.as_deref(), Some(&format!("zotero:{key}")))?;
        collection_map.insert(*id, created.id);
        report.collections += 1;
    }

    let item_collections: Vec<(i64, i64)> = query(&db, "SELECT itemID, collectionID FROM collectionItems", |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut collections_of: HashMap<i64, Vec<String>> = HashMap::new();
    for (item, collection) in item_collections {
        if let Some(mapped) = collection_map.get(&collection) {
            collections_of.entry(item).or_default().push(mapped.clone());
        }
    }

    let fields = grouped(&db, "SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID)")?;
    let creators: Vec<(i64, Option<String>, Option<String>, i64, String)> = query(
        &db,
        "SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, ct.creatorType
         FROM itemCreators ic JOIN creators c USING(creatorID) JOIN creatorTypes ct USING(creatorTypeID)
         ORDER BY ic.itemID, ic.orderIndex",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0), r.get(4)?)),
    )?;
    let mut creators_of: HashMap<i64, Vec<Creator>> = HashMap::new();
    for (item, first, last, mode, role) in creators {
        let role = match role.as_str() {
            "bookAuthor" | "contributor" | "programmer" | "artist" | "director" | "podcaster" | "presenter" | "performer" => {
                if role == "bookAuthor" { "container-author".to_string() } else { "author".to_string() }
            }
            other => other.to_string(),
        };
        let creator = if mode == 1 || first.as_deref().unwrap_or("").is_empty() {
            Creator { literal: last.filter(|s| !s.is_empty()), role, ..Default::default() }
        } else {
            Creator { family: last, given: first, role, ..Default::default() }
        };
        creators_of.entry(item).or_default().push(creator);
    }
    let tags = grouped(&db, "SELECT it.itemID, 'tag', t.name FROM itemTags it JOIN tags t USING(tagID)")?;

    // Attachments: prefer a PDF, then an HTML snapshot, then any file.
    let attachments: Vec<(i64, Option<i64>, i64, Option<String>, Option<String>, String)> = query(
        &db,
        "SELECT a.itemID, a.parentItemID, coalesce(a.linkMode, 0), a.contentType, a.path, i.key
         FROM itemAttachments a JOIN items i USING(itemID)
         WHERE a.itemID NOT IN (SELECT itemID FROM deletedItems)",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    )?;
    let base_attachment_dir: Option<PathBuf> = None;
    let mut file_of: HashMap<i64, (PathBuf, String, i32)> = HashMap::new();
    let mut standalone: Vec<(i64, PathBuf, String)> = Vec::new();
    for (item, parent, mode, content_type, path, key) in attachments {
        let content_type = content_type.unwrap_or_default();
        let Some(path) = path.and_then(|p| resolve(&data_dir, base_attachment_dir.as_deref(), &key, mode, &p)) else { continue };
        let rank = match content_type.as_str() {
            "application/pdf" => 3,
            "text/html" => 2,
            t if t.starts_with("video/") || t.starts_with("audio/") || t.starts_with("image/") => 2,
            _ => 1,
        };
        match parent {
            Some(parent) => {
                if file_of.get(&parent).is_none_or(|(_, _, best)| rank > *best) {
                    file_of.insert(parent, (path, content_type, rank));
                }
            }
            None => standalone.push((item, path, content_type)),
        }
    }

    let items: Vec<(i64, String, String, String, String)> = query(
        &db,
        "SELECT i.itemID, i.key, t.typeName, i.dateAdded, i.dateModified FROM items i JOIN itemTypes t USING(itemTypeID)
         WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
           AND t.typeName NOT IN ('note', 'attachment', 'annotation')",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let in_scope = |item: i64| allowed_collections.is_none() || collections_of.contains_key(&item);
    let mut inputs = Vec::new();
    let mut item_ids = Vec::new();
    for (item, key, zotero_type, added, _) in &items {
        if !in_scope(*item) {
            report.skipped += 1;
            continue;
        }
        let mut input = map_item(zotero_type, fields.get(item));
        input.creators = creators_of.remove(item).unwrap_or_default();
        input.tags = tags.get(item).map(|t| t.iter().map(|(_, v)| v.clone()).collect()).unwrap_or_default();
        input.collections = collections_of.get(item).cloned().unwrap_or_default();
        input.origin = Some(ORIGIN.into());
        input.origin_key = Some(key.clone());
        input.added_at = parse_zotero_date(added);
        attach(&mut input, file_of.remove(item), &mut report);
        inputs.push(input);
        item_ids.push(*item);
    }
    // Standalone files (a PDF dropped into Zotero without a parent item).
    let keys: HashMap<i64, (String, String)> = query(&db, "SELECT itemID, key, dateAdded FROM items", |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .into_iter()
        .collect();
    for (item, path, content_type) in standalone {
        if !in_scope(item) {
            continue;
        }
        let mut input = map_item("document", fields.get(&item));
        if input.fields.get("title").is_none_or(|t| t.as_str().unwrap_or("").is_empty()) {
            let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            input.fields.insert("title".into(), Json::from(name));
        }
        input.collections = collections_of.get(&item).cloned().unwrap_or_default();
        input.origin = Some(ORIGIN.into());
        input.origin_key = keys.get(&item).map(|(k, _)| k.clone());
        input.added_at = keys.get(&item).and_then(|(_, added)| parse_zotero_date(added));
        attach(&mut input, Some((path, content_type, 3)), &mut report);
        inputs.push(input);
        item_ids.push(item);
    }
    let ids = store.insert_sources(inputs)?;
    report.items = ids.len();
    let source_of: HashMap<i64, String> = item_ids.into_iter().zip(ids).collect();

    let notes: Vec<(i64, Option<i64>, Option<String>, Option<String>, String)> = query(
        &db,
        "SELECT n.itemID, n.parentItemID, n.title, n.note, i.key FROM itemNotes n JOIN items i USING(itemID)
         WHERE n.itemID NOT IN (SELECT itemID FROM deletedItems)",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    for (_, parent, title, body, key) in notes {
        let Some(source) = parent.and_then(|p| source_of.get(&p)) else { continue };
        let text = html_to_text(&body.unwrap_or_default());
        if text.trim().is_empty() {
            continue;
        }
        store.save_note(None, Some(source), title.as_deref().unwrap_or(""), &text, Some(&format!("zotero:{key}")))?;
        report.notes += 1;
    }
    Ok(report)
}

fn attach(input: &mut SourceInput, file: Option<(PathBuf, String, i32)>, report: &mut ImportReport) {
    let Some((path, content_type, _)) = file else {
        input.index_status = Some("skipped".into());
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
        report.linked_files += 1;
        input.fields.insert("fileSize".into(), Json::from(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)));
    } else {
        report.missing_files += 1;
        input.index_status = Some("missing".into());
    }
    input.fields.insert("filePath".into(), Json::from(path.to_string_lossy().to_string()));
    input.fields.insert("mime".into(), Json::from(content_type));
}

fn resolve(data_dir: &Path, base: Option<&Path>, key: &str, mode: i64, path: &str) -> Option<PathBuf> {
    if let Some(name) = path.strip_prefix("storage:") {
        return Some(data_dir.join("storage").join(key).join(name));
    }
    if let Some(relative) = path.strip_prefix("attachments:") {
        return base.map(|b| b.join(relative));
    }
    // linkMode 2 is a linked file with an absolute path; 3 is a link to a URL.
    (mode == 2 && Path::new(path).is_absolute()).then(|| PathBuf::from(path))
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
    fields.entry(name.to_string()).or_insert_with(|| Json::from(value.trim()));
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

/// Zotero notes are HTML. Keep paragraphs and line breaks, drop markup and decode entities.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag.trim_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_ascii_lowercase();
                if matches!(name.as_str(), "p" | "br" | "div" | "li" | "h1" | "h2" | "h3" | "h4" | "tr" | "blockquote") && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(c),
            _ => out.push(c),
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    decoded.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

fn depth(collections: &[(i64, String, Option<i64>, String)], id: i64) -> usize {
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

fn query<T>(db: &Connection, sql: &str, map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Result<Vec<T>> {
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    statement
        .query_map(params![], map)
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn grouped(db: &Connection, sql: &str) -> Result<HashMap<i64, Vec<(String, String)>>> {
    let mut out: HashMap<i64, Vec<(String, String)>> = HashMap::new();
    for (id, name, value) in query(db, sql, |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
        out.entry(id).or_default().push((name, value));
    }
    Ok(out)
}

#[allow(dead_code)]
fn exists(db: &Connection, table: &str) -> bool {
    db.query_row("SELECT 1 FROM sqlite_master WHERE name = ?", [table], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

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
        assert_eq!(html_to_text("<p>One &amp; two</p><p>Three<br/>four</p>"), "One & two\nThree\nfour");
        assert_eq!(duration_seconds("1:02:03"), Some(3723.0));
    }
}
