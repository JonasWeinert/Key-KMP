// A Zotero library read into memory from a private copy of zotero.sqlite. Zotero holds an
// exclusive lock on the original while it runs, and Key never writes to it, so the file
// (and its rollback journal, if a transaction is open) is copied and the copy is read.
use crate::{Result, depth};
use key_store::Creator;
use rusqlite::{Connection, OpenFlags, params};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct ZCollection {
    pub id: i64,
    pub key: String,
    pub name: String,
    pub parent: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct ZItem {
    pub id: i64,
    pub key: String,
    pub type_name: String,
    pub added: String,
}

#[derive(Clone, Debug)]
pub struct ZAttachment {
    pub id: i64,
    pub parent: Option<i64>,
    pub content_type: String,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct ZNote {
    pub id: i64,
    pub key: String,
    pub parent: Option<i64>,
    pub title: String,
    pub html: String,
}

#[derive(Clone, Debug)]
pub struct ZAnnotation {
    pub attachment: i64,
    /// 1 highlight, 2 note, 3 image, 4 ink, 5 underline, 6 text.
    pub kind: i64,
    pub text: String,
    pub comment: String,
    pub color: String,
    pub page_index: Option<i64>,
}

/// When the file last changed, so a sync can tell whether there is anything new.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stamp {
    pub modified_ms: i64,
    pub size: u64,
}

impl Stamp {
    pub fn of(data_dir: &Path) -> Result<Stamp> {
        let metadata = std::fs::metadata(data_dir.join("zotero.sqlite")).map_err(|e| format!("Could not read zotero.sqlite: {e}"))?;
        let modified = metadata.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
        Ok(Stamp { modified_ms: modified, size: metadata.len() })
    }
    /// Milliseconds since the file was last written.
    pub fn age_ms(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64) - self.modified_ms
    }
}

pub struct Snapshot {
    pub data_dir: PathBuf,
    pub stamp: Stamp,
    pub collections: Vec<ZCollection>,
    /// Regular items (not notes, attachments or annotations) outside Zotero's trash.
    pub items: Vec<ZItem>,
    pub fields: HashMap<i64, Vec<(String, String)>>,
    pub creators: HashMap<i64, Vec<Creator>>,
    pub tags: HashMap<i64, Vec<String>>,
    /// Item id → the Zotero collections it is filed in.
    pub collections_of: HashMap<i64, Vec<i64>>,
    pub attachments: Vec<ZAttachment>,
    pub notes: Vec<ZNote>,
    pub annotations: Vec<ZAnnotation>,
    /// Every item's key, including attachments and items in the trash.
    pub key_of: HashMap<i64, String>,
    pub added_of: HashMap<i64, String>,
    /// Items in Zotero's trash.
    pub trashed: HashSet<i64>,
}

static CACHE: Mutex<Option<Arc<Snapshot>>> = Mutex::new(None);

impl Snapshot {
    /// The library as it is now, reusing the last copy while the file is unchanged.
    pub fn load(data_dir: &Path) -> Result<Arc<Snapshot>> {
        let stamp = Stamp::of(data_dir)?;
        let mut cache = CACHE.lock().map_err(|_| "Zotero cache lock poisoned")?;
        if let Some(cached) = cache.as_ref().filter(|c| c.data_dir == data_dir && c.stamp == stamp) {
            return Ok(cached.clone());
        }
        let snapshot = Arc::new(Self::read(data_dir)?);
        *cache = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub fn forget() {
        if let Ok(mut cache) = CACHE.lock() {
            *cache = None;
        }
    }

    fn read(data_dir: &Path) -> Result<Snapshot> {
        let copy = tempfile::tempdir().map_err(|e| e.to_string())?;
        let target = copy.path().join("zotero.sqlite");
        // Zotero may commit while the file is copied; copy again until it holds still.
        let mut stamp = Stamp::of(data_dir)?;
        for attempt in 0.. {
            std::fs::copy(data_dir.join("zotero.sqlite"), &target).map_err(|e| format!("Could not read zotero.sqlite: {e}"))?;
            let journal = data_dir.join("zotero.sqlite-journal");
            let _ = std::fs::remove_file(copy.path().join("zotero.sqlite-journal"));
            if journal.is_file() {
                let _ = std::fs::copy(&journal, copy.path().join("zotero.sqlite-journal"));
            }
            let after = Stamp::of(data_dir)?;
            if after == stamp || attempt >= 4 {
                stamp = after;
                break;
            }
            stamp = after;
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        // Read-write on the copy, so SQLite can roll back a transaction that was half written.
        let db = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
        let base = attachment_base_dir();
        let mut snapshot = Snapshot {
            data_dir: data_dir.to_path_buf(),
            stamp,
            collections: Vec::new(),
            items: Vec::new(),
            fields: HashMap::new(),
            creators: HashMap::new(),
            tags: HashMap::new(),
            collections_of: HashMap::new(),
            attachments: Vec::new(),
            notes: Vec::new(),
            annotations: Vec::new(),
            key_of: HashMap::new(),
            added_of: HashMap::new(),
            trashed: HashSet::new(),
        };
        let has_deleted_collections = exists(&db, "deletedCollections");
        snapshot.collections = query(
            &db,
            &format!(
                "SELECT collectionID, collectionName, parentCollectionID, key FROM collections {}",
                if has_deleted_collections { "WHERE collectionID NOT IN (SELECT collectionID FROM deletedCollections)" } else { "" }
            ),
            |r| Ok(ZCollection { id: r.get(0)?, name: r.get(1)?, parent: r.get(2)?, key: r.get(3)? }),
        )?;
        // Parents before children, so a mirror can create them in order.
        let shape: Vec<(i64, String, Option<i64>, String)> = snapshot.collections.iter().map(|c| (c.id, c.name.clone(), c.parent, c.key.clone())).collect();
        let depths: HashMap<i64, usize> = shape.iter().map(|c| (c.0, depth(&shape, c.0))).collect();
        snapshot.collections.sort_by(|a, b| depths[&a.id].cmp(&depths[&b.id]).then(a.name.cmp(&b.name)));
        let live: HashSet<i64> = snapshot.collections.iter().map(|c| c.id).collect();
        for c in &mut snapshot.collections {
            // A sub-collection of a trashed collection keeps its place at the top.
            c.parent = c.parent.filter(|p| live.contains(p));
        }

        snapshot.trashed = query(&db, "SELECT itemID FROM deletedItems", |r| r.get(0))?.into_iter().collect();
        for (id, key, added) in query(&db, "SELECT itemID, key, dateAdded FROM items", |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
            snapshot.key_of.insert(id, key);
            snapshot.added_of.insert(id, added);
        }
        for (item, collection) in query(&db, "SELECT itemID, collectionID FROM collectionItems ORDER BY orderIndex", |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            if live.contains(&collection) {
                snapshot.collections_of.entry(item).or_default().push(collection);
            }
        }
        for (id, name, value) in query(
            &db,
            "SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID) ORDER BY d.itemID, d.fieldID",
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )? {
            snapshot.fields.entry(id).or_default().push((name, value));
        }
        let creators: Vec<(i64, Option<String>, Option<String>, i64, String)> = query(
            &db,
            "SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, ct.creatorType
             FROM itemCreators ic JOIN creators c USING(creatorID) JOIN creatorTypes ct USING(creatorTypeID)
             ORDER BY ic.itemID, ic.orderIndex",
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0), r.get(4)?)),
        )?;
        for (item, first, last, mode, role) in creators {
            let role = match role.as_str() {
                "bookAuthor" => "container-author".to_string(),
                "contributor" | "programmer" | "artist" | "director" | "podcaster" | "presenter" | "performer" => "author".to_string(),
                other => other.to_string(),
            };
            let creator = if mode == 1 || first.as_deref().unwrap_or("").is_empty() {
                Creator { literal: last.filter(|s| !s.is_empty()), role, ..Default::default() }
            } else {
                Creator { family: last, given: first, role, ..Default::default() }
            };
            snapshot.creators.entry(item).or_default().push(creator);
        }
        for (item, tag) in query(&db, "SELECT it.itemID, t.name FROM itemTags it JOIN tags t USING(tagID) ORDER BY it.itemID, t.name", |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })? {
            snapshot.tags.entry(item).or_default().push(tag);
        }

        let attachments: Vec<(i64, Option<i64>, i64, Option<String>, Option<String>)> = query(
            &db,
            "SELECT itemID, parentItemID, coalesce(linkMode, 0), contentType, path FROM itemAttachments ORDER BY itemID",
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        for (id, parent, mode, content_type, path) in attachments {
            if snapshot.trashed.contains(&id) {
                continue;
            }
            let key = snapshot.key_of.get(&id).cloned().unwrap_or_default();
            let path = path.and_then(|p| resolve(data_dir, base.as_deref(), &key, mode, &p));
            snapshot.attachments.push(ZAttachment { id, parent, content_type: content_type.unwrap_or_default(), path });
        }

        snapshot.items = query(
            &db,
            "SELECT i.itemID, i.key, t.typeName, i.dateAdded FROM items i JOIN itemTypes t USING(itemTypeID)
             WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
               AND t.typeName NOT IN ('note', 'attachment', 'annotation')
             ORDER BY i.itemID",
            |r| Ok(ZItem { id: r.get(0)?, key: r.get(1)?, type_name: r.get(2)?, added: r.get(3)? }),
        )?;
        snapshot.notes = query(
            &db,
            "SELECT n.itemID, i.key, n.parentItemID, n.title, n.note FROM itemNotes n JOIN items i USING(itemID)
             WHERE n.itemID NOT IN (SELECT itemID FROM deletedItems) ORDER BY n.itemID",
            |r| {
                Ok(ZNote {
                    id: r.get(0)?,
                    key: r.get(1)?,
                    parent: r.get(2)?,
                    title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    html: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                })
            },
        )?;
        if exists(&db, "itemAnnotations") {
            snapshot.annotations = query(
                &db,
                "SELECT a.parentItemID, a.type, a.text, a.comment, a.color, a.position FROM itemAnnotations a
                 WHERE a.itemID NOT IN (SELECT itemID FROM deletedItems) ORDER BY a.parentItemID, a.sortIndex",
                |r| {
                    let position: Option<String> = r.get(5)?;
                    let page_index = position
                        .and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok())
                        .and_then(|p| p.get("pageIndex").and_then(serde_json::Value::as_i64));
                    Ok(ZAnnotation {
                        attachment: r.get(0)?,
                        kind: r.get(1)?,
                        text: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        comment: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        color: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        page_index,
                    })
                },
            )?;
        }
        Ok(snapshot)
    }

    pub fn collection(&self, id: i64) -> Option<&ZCollection> {
        self.collections.iter().find(|c| c.id == id)
    }

    /// Ids of these collections and every collection inside them.
    pub fn with_descendants(&self, roots: &[i64]) -> Vec<i64> {
        let mut ids = roots.to_vec();
        let mut index = 0;
        while index < ids.len() {
            let parent = ids[index];
            for child in self.collections.iter().filter(|c| c.parent == Some(parent)) {
                if !ids.contains(&child.id) {
                    ids.push(child.id);
                }
            }
            index += 1;
        }
        ids
    }
}

/// Zotero's base directory for linked files stored as "attachments:relative/path".
fn attachment_base_dir() -> Option<PathBuf> {
    crate::pref("extensions.zotero.baseAttachmentPath").map(PathBuf::from)
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

fn query<T>(db: &Connection, sql: &str, map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Result<Vec<T>> {
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    statement
        .query_map(params![], map)
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn exists(db: &Connection, table: &str) -> bool {
    db.query_row("SELECT 1 FROM sqlite_master WHERE name = ?", [table], |_| Ok(())).is_ok()
}
