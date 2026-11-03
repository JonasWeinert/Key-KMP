// Linked folders: folders elsewhere on the computer shown inside the workspace, read in
// place and never copied.
//
// Design
// - A folder is *tracked* (default) or not. A tracked folder has a manifest here (one row per
//   file: relative path, size, mtime, inode, and a sha256 computed lazily) that the app keeps
//   current: Electron's main process watches the folder recursively (FSEvents), debounces
//   the changes and calls `sync_linked_folder` with the paths that changed; a full sync runs
//   when the folder is linked, when tracking is turned on and when a missing folder returns.
//   An untracked folder is listed live from disk when expanded; files get manifest rows only
//   when they are opened or linked, so they have ids.
// - A folder can also be *indexed* (off by default): its text files and PDFs are cut into
//   passages (`chunks.file_id`) by the background indexer, between sources and notes, so
//   they show up in search. Turning indexing off drops the passages.
// - Files keep their id across renames and moves inside the folder: a new path is matched to
//   a vanished row by inode (same size or mtime), then by content hash, so `key://file/<id>`
//   links survive. A file that disappears keeps its row with `missing_at` set; links to it
//   show as broken until it returns. Unlinking the folder breaks them for good.
// - Hidden files and folders, package bundles, `node_modules` and symlinks are skipped;
//   huge and binary files are listed but never indexed. A folder that cannot be read (an
//   unmounted drive) is marked missing without touching its manifest, so nothing is lost
//   when it comes back.
use super::{ChunkInput, Result, Store, e, links, new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const FILE: &str = "file";
/// Most files a folder's manifest holds; a larger folder is listed in part.
const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 32;
/// Text larger than this is listed but not indexed (or opened as text).
pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_PDF_BYTES: u64 = 300 * 1024 * 1024;
const SKIPPED_DIRS: [&str; 3] = ["node_modules", "__pycache__", "$RECYCLE.BIN"];
const PACKAGES: [&str; 6] = ["app", "bundle", "framework", "photoslibrary", "musiclibrary", "rtfd"];
const MARKDOWN: [&str; 3] = ["md", "markdown", "mdown"];
const TEXT: [&str; 42] = [
    "txt", "text", "rst", "org", "tex", "bib", "ris", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "html", "htm", "css", "js", "mjs", "ts",
    "tsx", "jsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "swift", "kt", "rb", "php", "sh", "sql", "r", "log", "ini", "cfg", "conf", "lua",
];

/// markdown | text | pdf | other, from the extension.
pub fn file_kind(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    if MARKDOWN.contains(&ext.as_str()) {
        "markdown"
    } else if TEXT.contains(&ext.as_str()) {
        "text"
    } else if ext == "pdf" {
        "pdf"
    } else {
        "other"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFolder {
    pub id: String,
    pub path: String,
    pub name: String,
    pub tracked: bool,
    pub indexed: bool,
    /// The folder could not be read at the last sync.
    pub missing: bool,
    pub scanned_at: Option<i64>,
    pub files: i64,
    /// Files whose passages are current.
    pub indexed_files: i64,
    /// Files waiting to be indexed.
    pub pending_files: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFile {
    pub id: String,
    pub folder_id: String,
    /// Relative to the folder, '/'-separated.
    pub path: String,
    pub name: String,
    /// Absolute path on disk.
    pub abs_path: String,
    pub size: i64,
    pub mtime: i64,
    /// markdown | text | pdf | other
    pub kind: String,
    pub missing: bool,
    pub indexed: bool,
    pub index_error: Option<String>,
    pub source_id: Option<String>,
    pub hash: Option<String>,
}

/// A folder's immediate contents: subfolders, then files.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedEntries {
    pub dirs: Vec<LinkedDir>,
    pub files: Vec<LinkedFile>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedDir {
    pub path: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub added: usize,
    pub changed: usize,
    pub moved: usize,
    pub removed: usize,
    /// The folder could not be read.
    pub missing: bool,
    pub truncated: bool,
}
impl SyncReport {
    pub fn any(&self) -> bool {
        self.added + self.changed + self.moved + self.removed > 0
    }
}

/// What a file looks like on disk.
#[derive(Clone, Debug, PartialEq)]
struct Stat {
    size: i64,
    mtime: i64,
    inode: Option<i64>,
}
fn stat(meta: &fs::Metadata) -> Stat {
    #[cfg(unix)]
    let inode = Some(std::os::unix::fs::MetadataExt::ino(meta) as i64);
    #[cfg(not(unix))]
    let inode = None;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    Stat { size: meta.len() as i64, mtime, inode }
}

fn skipped(name: &str, dir: bool) -> bool {
    name.starts_with('.')
        || (dir && SKIPPED_DIRS.contains(&name))
        || (dir && name.rsplit_once('.').is_some_and(|(_, ext)| PACKAGES.contains(&ext.to_ascii_lowercase().as_str())))
        || name == "Icon\r"
}

/// Files under `rel` (a file or a folder) as relative paths. Symlinks are never followed.
fn walk(root: &Path, rel: &str, out: &mut HashMap<String, Stat>, truncated: &mut bool) {
    let start = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let Ok(meta) = fs::symlink_metadata(&start) else { return };
    if meta.is_file() {
        out.insert(rel.to_string(), stat(&meta));
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let mut stack = vec![(start, rel.to_string(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(ty) = entry.file_type() else { continue };
            if ty.is_symlink() || skipped(&name, ty.is_dir()) {
                continue;
            }
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if ty.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((entry.path(), path, depth + 1));
                } else {
                    *truncated = true;
                }
            } else if ty.is_file() {
                if out.len() >= MAX_FILES {
                    *truncated = true;
                    return;
                }
                if let Ok(meta) = entry.metadata() {
                    out.insert(path, stat(&meta));
                }
            }
        }
    }
}

pub fn hash_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(e)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(e)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Relative paths from the watcher, cleaned: no absolute paths, no `..`, no hidden parts.
fn clean_rel(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.iter().any(|p| *p == ".." || p.starts_with('.')) {
        return None;
    }
    Some(parts.join("/"))
}

fn under(path: &str, scope: &str) -> bool {
    scope.is_empty() || path == scope || path.strip_prefix(scope).is_some_and(|rest| rest.starts_with('/'))
}

fn name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

const FILE_COLUMNS: &str = "f.id, f.folder_id, f.path, f.name, d.path, f.size, f.mtime, f.missing_at, f.indexed_mtime, f.index_error, f.source_id, f.hash";
fn read_file(r: &rusqlite::Row) -> rusqlite::Result<LinkedFile> {
    let rel: String = r.get(2)?;
    let root: String = r.get(4)?;
    let name: String = r.get(3)?;
    let mtime: i64 = r.get(6)?;
    let indexed_mtime: Option<i64> = r.get(8)?;
    let index_error: Option<String> = r.get(9)?;
    Ok(LinkedFile {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        abs_path: Path::new(&root).join(&rel).to_string_lossy().into_owned(),
        kind: file_kind(&name).into(),
        path: rel,
        name,
        size: r.get(5)?,
        mtime,
        missing: r.get::<_, Option<i64>>(7)?.is_some(),
        indexed: indexed_mtime == Some(mtime) && index_error.is_none(),
        index_error,
        source_id: r.get(10)?,
        hash: r.get(11)?,
    })
}

const FOLDER_COLUMNS: &str = "d.id, d.path, d.name, d.tracked, d.indexed, d.missing_at, d.scanned_at,
     (SELECT count(*) FROM linked_files f WHERE f.folder_id = d.id AND f.missing_at IS NULL),
     (SELECT count(*) FROM linked_files f WHERE f.folder_id = d.id AND f.missing_at IS NULL AND f.indexed_mtime = f.mtime AND f.index_error IS NULL)";
fn read_folder(r: &rusqlite::Row) -> rusqlite::Result<LinkedFolder> {
    Ok(LinkedFolder {
        id: r.get(0)?,
        path: r.get(1)?,
        name: r.get(2)?,
        tracked: r.get(3)?,
        indexed: r.get(4)?,
        missing: r.get::<_, Option<i64>>(5)?.is_some(),
        scanned_at: r.get(6)?,
        files: r.get(7)?,
        indexed_files: r.get(8)?,
        pending_files: 0,
    })
}

/// The SQL condition for files the indexer should (re)read: in an indexed, tracked, present
/// folder, present themselves, of an indexable kind and size, and changed since last read.
fn stale() -> &'static str {
    static SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SQL.get_or_init(|| {
        let text = MARKDOWN.iter().chain(TEXT.iter()).map(|ext| format!("lower(f.name) LIKE '%.{ext}'")).collect::<Vec<_>>().join(" OR ");
        format!(
            "f.missing_at IS NULL AND d.indexed = 1 AND d.tracked = 1 AND d.missing_at IS NULL
             AND (f.indexed_mtime IS NULL OR f.indexed_mtime <> f.mtime)
             AND ((lower(f.name) LIKE '%.pdf' AND f.size <= {MAX_PDF_BYTES}) OR (f.size <= {MAX_TEXT_BYTES} AND ({text})))"
        )
    })
}

impl Store {
    pub fn link_folder(&self, path: &Path) -> Result<LinkedFolder> {
        let path = fs::canonicalize(path).map_err(|error| format!("{}: {error}", path.display()))?;
        if !path.is_dir() {
            return Err("Choose a folder to link".into());
        }
        let store = fs::canonicalize(self.root()).map_err(e)?;
        let workspace = store.parent().unwrap_or(&store);
        if path.starts_with(workspace) || workspace.starts_with(&path) {
            return Err("This folder is part of the workspace already; link a folder outside it".into());
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned());
        let path = path.to_string_lossy().into_owned();
        self.db()?
            .execute(
                "INSERT INTO linked_folders(id, path, name, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(path) DO NOTHING",
                params![new_id(), path, name, now_ms()],
            )
            .map_err(e)?;
        let id: String = self.db()?.query_row("SELECT id FROM linked_folders WHERE path = ?", [&path], |r| r.get(0)).map_err(e)?;
        self.linked_folder(&id)?.ok_or_else(|| "Linked folder not found".into())
    }

    pub fn linked_folders(&self) -> Result<Vec<LinkedFolder>> {
        let db = self.read()?;
        let mut statement = db.prepare(&format!("SELECT {FOLDER_COLUMNS} FROM linked_folders d ORDER BY d.name COLLATE NOCASE")).map_err(e)?;
        let mut folders = statement.query_map([], read_folder).map_err(e)?.collect::<std::result::Result<Vec<_>, _>>().map_err(e)?;
        let mut pending = db.prepare(&format!("SELECT count(*) FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id WHERE f.folder_id = ? AND {}", stale())).map_err(e)?;
        for folder in &mut folders {
            folder.pending_files = pending.query_row([&folder.id], |r| r.get(0)).map_err(e)?;
        }
        Ok(folders)
    }

    pub fn linked_folder(&self, id: &str) -> Result<Option<LinkedFolder>> {
        Ok(self.linked_folders()?.into_iter().find(|f| f.id == id))
    }

    /// Turns tracking or indexing on or off. Indexing needs tracking; turning either off
    /// drops the folder's passages.
    pub fn set_linked_folder(&self, id: &str, tracked: Option<bool>, indexed: Option<bool>) -> Result<LinkedFolder> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        if let Some(tracked) = tracked {
            tx.execute("UPDATE linked_folders SET tracked = ?2 WHERE id = ?1", params![id, tracked]).map_err(e)?;
            if !tracked {
                tx.execute("UPDATE linked_folders SET indexed = 0 WHERE id = ?1", [id]).map_err(e)?;
            }
        }
        if let Some(indexed) = indexed {
            tx.execute("UPDATE linked_folders SET indexed = ?2, tracked = CASE WHEN ?2 THEN 1 ELSE tracked END WHERE id = ?1", params![id, indexed]).map_err(e)?;
        }
        let indexed: bool = tx.query_row("SELECT indexed FROM linked_folders WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?.ok_or("Linked folder not found")?;
        if !indexed {
            tx.execute("DELETE FROM chunks WHERE file_id IN (SELECT id FROM linked_files WHERE folder_id = ?1)", [id]).map_err(e)?;
            tx.execute("UPDATE linked_files SET indexed_mtime = NULL, index_error = NULL WHERE folder_id = ?1", [id]).map_err(e)?;
        }
        tx.commit().map_err(e)?;
        drop(db);
        self.linked_folder(id)?.ok_or_else(|| "Linked folder not found".into())
    }

    /// Forgets a folder: its manifest and passages go, and links to its files break.
    pub fn unlink_folder(&self, id: &str) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let ids: Vec<String> = {
            let mut statement = tx.prepare("SELECT id FROM linked_files WHERE folder_id = ?").map_err(e)?;
            let rows = statement.query_map([id], |r| r.get(0)).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        for file in ids {
            links::forget_item(&tx, FILE, &file)?;
        }
        tx.execute("DELETE FROM linked_folders WHERE id = ?", [id]).map_err(e)?;
        tx.commit().map_err(e)
    }

    /// Brings the manifest in line with the disk under `scope` (relative paths of files or
    /// folders that changed; empty for the whole folder). Answers what changed.
    pub fn sync_linked_folder(&self, id: &str, scope: &[String]) -> Result<SyncReport> {
        let (root, tracked): (String, bool) = self
            .read()?
            .query_row("SELECT path, tracked FROM linked_folders WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)?
            .ok_or("Linked folder not found")?;
        let root = PathBuf::from(root);
        let mut report = SyncReport::default();
        // An unreadable folder (unmounted drive, removed) keeps its manifest untouched.
        if fs::read_dir(&root).is_err() {
            self.db()?.execute("UPDATE linked_folders SET missing_at = coalesce(missing_at, ?2) WHERE id = ?1", params![id, now_ms()]).map_err(e)?;
            report.missing = true;
            return Ok(report);
        }
        let was_missing: bool = self.read()?.query_row("SELECT missing_at IS NOT NULL FROM linked_folders WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
        if !tracked {
            self.db()?.execute("UPDATE linked_folders SET missing_at = NULL WHERE id = ?1", [id]).map_err(e)?;
            return Ok(report);
        }
        let mut scopes: Vec<String> = scope.iter().filter_map(|s| clean_rel(s)).collect();
        if scopes.is_empty() || scopes.iter().any(String::is_empty) || was_missing {
            scopes = vec![String::new()];
        }
        scopes.sort();
        scopes.dedup();
        // Drop scopes inside other scopes.
        let scopes: Vec<String> = scopes.iter().filter(|s| !scopes.iter().any(|o| o != *s && under(s, o))).cloned().collect();

        let mut seen: HashMap<String, Stat> = HashMap::new();
        for scope in &scopes {
            walk(&root, scope, &mut seen, &mut report.truncated);
        }

        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        // Rows under the scopes, by path.
        struct Row {
            id: String,
            stat: Stat,
            missing: bool,
        }
        let mut rows: HashMap<String, Row> = HashMap::new();
        {
            let mut statement = tx.prepare("SELECT id, path, size, mtime, inode, missing_at FROM linked_files WHERE folder_id = ?").map_err(e)?;
            let all = statement
                .query_map([id], |r| {
                    Ok((r.get::<_, String>(1)?, Row { id: r.get(0)?, stat: Stat { size: r.get(2)?, mtime: r.get(3)?, inode: r.get(4)? }, missing: r.get::<_, Option<i64>>(5)?.is_some() }))
                })
                .map_err(e)?;
            for row in all {
                let (path, row) = row.map_err(e)?;
                if scopes.iter().any(|s| under(&path, s)) {
                    rows.insert(path, row);
                }
            }
        }
        let now = now_ms();
        // Present at the same path: update if it changed, bring back if it was missing.
        let mut new: Vec<(&String, &Stat)> = Vec::new();
        for (path, stat) in &seen {
            match rows.get(path) {
                Some(row) if row.stat == *stat && !row.missing => {}
                Some(row) => {
                    let same_bytes = row.stat.size == stat.size && row.stat.mtime == stat.mtime;
                    tx.execute(
                        "UPDATE linked_files SET size = ?2, mtime = ?3, inode = ?4, missing_at = NULL, hash = CASE WHEN ?5 THEN hash END WHERE id = ?1",
                        params![row.id, stat.size, stat.mtime, stat.inode, same_bytes],
                    )
                    .map_err(e)?;
                    if row.missing {
                        links::mend_links_to(&tx, FILE, &row.id)?;
                    }
                    report.changed += 1;
                }
                None => new.push((path, stat)),
            }
        }
        // Rows whose path is gone are missing, unless a new path turns out to be them moved.
        for (_, row) in rows.iter().filter(|(path, row)| !row.missing && !seen.contains_key(*path)) {
            tx.execute("UPDATE linked_files SET missing_at = ?2 WHERE id = ?1", params![row.id, now]).map_err(e)?;
            links::break_links_to(&tx, FILE, &row.id)?;
            report.removed += 1;
        }
        new.sort_by(|a, b| a.0.cmp(b.0));
        for (path, stat) in new {
            match self.moved_from(&tx, id, &root, path, stat, &seen)? {
                Some(file_id) => {
                    let was_gone: bool = tx.query_row("SELECT missing_at = ?2 FROM linked_files WHERE id = ?1", params![file_id, now], |r| r.get(0)).map_err(e)?;
                    tx.execute(
                        "UPDATE linked_files SET path = ?2, name = ?3, size = ?4, mtime = ?5, inode = ?6, missing_at = NULL WHERE id = ?1",
                        params![file_id, path, name_of(path), stat.size, stat.mtime, stat.inode],
                    )
                    .map_err(e)?;
                    links::mend_links_to(&tx, FILE, &file_id)?;
                    if was_gone {
                        report.removed -= 1;
                    }
                    report.moved += 1;
                }
                None => {
                    tx.execute(
                        "INSERT INTO linked_files(id, folder_id, path, name, size, mtime, inode) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT(folder_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, inode = excluded.inode, missing_at = NULL, hash = NULL",
                        params![new_id(), id, path, name_of(path), stat.size, stat.mtime, stat.inode],
                    )
                    .map_err(e)?;
                    report.added += 1;
                }
            }
        }
        tx.execute("UPDATE linked_folders SET missing_at = NULL, scanned_at = ?2 WHERE id = ?1", params![id, now]).map_err(e)?;
        tx.commit().map_err(e)?;
        Ok(report)
    }

    /// The row a new path was moved from: the same inode (with the same size or mtime) on a
    /// row whose path is gone, else a missing row with the same size and content hash.
    fn moved_from(&self, tx: &Connection, folder: &str, root: &Path, new_path: &str, stat: &Stat, seen: &HashMap<String, Stat>) -> Result<Option<String>> {
        if let Some(inode) = stat.inode {
            let mut statement = tx.prepare("SELECT id, path, size, mtime FROM linked_files WHERE folder_id = ?1 AND inode = ?2").map_err(e)?;
            let candidates = statement
                .query_map(params![folder, inode], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))
                .map_err(e)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(e)?;
            for (file_id, path, size, mtime) in candidates {
                // Its old path must really be gone (outside the scope, check the disk).
                let still_there = seen.contains_key(&path) || fs::symlink_metadata(root.join(&path)).is_ok_and(|m| m.is_file());
                if !still_there && (size == stat.size || mtime == stat.mtime) {
                    return Ok(Some(file_id));
                }
            }
        }
        self.match_by_hash(tx, folder, &root.join(new_path), stat)
    }

    fn match_by_hash(&self, tx: &Connection, folder: &str, path: &Path, stat: &Stat) -> Result<Option<String>> {
        let candidates: Vec<(String, String)> = {
            let mut statement = tx
                .prepare("SELECT id, hash FROM linked_files WHERE folder_id = ?1 AND size = ?2 AND hash IS NOT NULL AND missing_at IS NOT NULL")
                .map_err(e)?;
            let rows = statement.query_map(params![folder, stat.size], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        if candidates.is_empty() {
            return Ok(None);
        }
        // Only now is the new file's content read.
        let Ok(hash) = hash_file(path) else { return Ok(None) };
        Ok(candidates.into_iter().find(|(_, h)| *h == hash).map(|(id, _)| id))
    }

    /// A folder's immediate contents under `dir`: from the manifest when tracked, else read
    /// from disk (files there have ids only once opened or linked).
    pub fn linked_entries(&self, folder_id: &str, dir: &str) -> Result<LinkedEntries> {
        let dir = clean_rel(dir).ok_or("Invalid folder path")?;
        let (root, tracked): (String, bool) = self
            .read()?
            .query_row("SELECT path, tracked FROM linked_folders WHERE id = ?", [folder_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)?
            .ok_or("Linked folder not found")?;
        let mut out = LinkedEntries::default();
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        if tracked {
            let db = self.read()?;
            let mut statement = db
                .prepare(&format!(
                    "SELECT {FILE_COLUMNS} FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id
                     WHERE f.folder_id = ?1 AND f.missing_at IS NULL AND substr(f.path, 1, length(?2)) = ?2 ORDER BY f.path COLLATE NOCASE"
                ))
                .map_err(e)?;
            let rows = statement.query_map(params![folder_id, prefix], read_file).map_err(e)?;
            let mut dirs: Vec<String> = Vec::new();
            for row in rows {
                let file = row.map_err(e)?;
                let rest = &file.path[prefix.len()..];
                match rest.split_once('/') {
                    Some((sub, _)) => {
                        if dirs.last().map(String::as_str) != Some(sub) && !dirs.iter().any(|d| d == sub) {
                            dirs.push(sub.to_string());
                        }
                    }
                    None => out.files.push(file),
                }
            }
            dirs.sort_by_key(|d| d.to_lowercase());
            out.dirs = dirs.into_iter().map(|name| LinkedDir { path: format!("{prefix}{name}"), name }).collect();
        } else {
            let known: HashMap<String, LinkedFile> = {
                let db = self.read()?;
                let mut statement = db
                    .prepare(&format!("SELECT {FILE_COLUMNS} FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id WHERE f.folder_id = ?1"))
                    .map_err(e)?;
                let rows = statement.query_map([folder_id], read_file).map_err(e)?;
                rows.filter_map(|r| r.ok()).map(|f| (f.path.clone(), f)).collect()
            };
            let entries = fs::read_dir(Path::new(&root).join(&dir)).map_err(|error| format!("The folder cannot be read: {error}"))?;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(ty) = entry.file_type() else { continue };
                if ty.is_symlink() || skipped(&name, ty.is_dir()) {
                    continue;
                }
                let path = format!("{prefix}{name}");
                if ty.is_dir() {
                    out.dirs.push(LinkedDir { path, name });
                } else if ty.is_file() {
                    let Ok(meta) = entry.metadata() else { continue };
                    let s = stat(&meta);
                    out.files.push(known.get(&path).cloned().unwrap_or(LinkedFile {
                        id: String::new(),
                        folder_id: folder_id.into(),
                        abs_path: entry.path().to_string_lossy().into_owned(),
                        kind: file_kind(&name).into(),
                        path,
                        name,
                        size: s.size,
                        mtime: s.mtime,
                        missing: false,
                        indexed: false,
                        index_error: None,
                        source_id: None,
                        hash: None,
                    }));
                }
            }
            out.dirs.sort_by_key(|d| d.name.to_lowercase());
            out.files.sort_by_key(|f| f.name.to_lowercase());
        }
        if out.files.len() > 5000 {
            out.files.truncate(5000);
            out.truncated = true;
        }
        Ok(out)
    }

    pub fn linked_file(&self, id: &str) -> Result<Option<LinkedFile>> {
        self.read()?
            .query_row(&format!("SELECT {FILE_COLUMNS} FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id WHERE f.id = ?"), [id], read_file)
            .optional()
            .map_err(e)
    }

    /// The file at `path` in a folder, given an id if it has none yet (untracked folders).
    pub fn linked_file_at(&self, folder_id: &str, path: &str) -> Result<LinkedFile> {
        let path = clean_rel(path).filter(|p| !p.is_empty()).ok_or("Invalid file path")?;
        let root: String = self.read()?.query_row("SELECT path FROM linked_folders WHERE id = ?", [folder_id], |r| r.get(0)).map_err(e)?;
        let meta = fs::symlink_metadata(Path::new(&root).join(&path)).map_err(e)?;
        if !meta.is_file() {
            return Err("Not a file".into());
        }
        let s = stat(&meta);
        self.db()?
            .execute(
                "INSERT INTO linked_files(id, folder_id, path, name, size, mtime, inode) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(folder_id, path) DO NOTHING",
                params![new_id(), folder_id, path, name_of(&path), s.size, s.mtime, s.inode],
            )
            .map_err(e)?;
        let id: String = self.read()?.query_row("SELECT id FROM linked_files WHERE folder_id = ?1 AND path = ?2", params![folder_id, path], |r| r.get(0)).map_err(e)?;
        self.linked_file(&id)?.ok_or_else(|| "Linked file not found".into())
    }

    /// Stores a file's content hash (computed lazily: on opening, linking and indexing) so a
    /// later move to a place the inode does not follow can still be recognised.
    pub fn remember_linked_hash(&self, id: &str, mtime: i64, hash: &str) -> Result<()> {
        self.db()?.execute("UPDATE linked_files SET hash = ?3 WHERE id = ?1 AND mtime = ?2", params![id, mtime, hash]).map(|_| ()).map_err(e)
    }

    /// The text of a Markdown or text file, with the mtime it was read at.
    pub fn read_linked_text(&self, id: &str) -> Result<(LinkedFile, String)> {
        let file = self.linked_file(id)?.ok_or("Linked file not found")?;
        let meta = fs::metadata(&file.abs_path).map_err(|_| "The file is not there; its folder may be offline")?;
        if meta.len() > MAX_TEXT_BYTES {
            return Err("The file is too large to open as text".into());
        }
        let bytes = fs::read(&file.abs_path).map_err(e)?;
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return Err("The file is not text".into());
        }
        let s = stat(&meta);
        if file.hash.is_none() || s.mtime != file.mtime {
            use sha2::{Digest, Sha256};
            let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
            let _ = self.db()?.execute(
                "UPDATE linked_files SET hash = ?2, size = ?3, mtime = ?4, inode = ?5 WHERE id = ?1",
                params![id, hash, s.size, s.mtime, s.inode],
            );
        }
        let file = self.linked_file(id)?.ok_or("Linked file not found")?;
        Ok((file, String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Writes a Markdown file. `expected_mtime` guards against overwriting changes made in
    /// another app since it was read. Written through a hidden temporary file and a rename,
    /// so a crash never leaves half a file.
    pub fn write_linked_text(&self, id: &str, text: &str, expected_mtime: Option<i64>) -> Result<LinkedFile> {
        let file = self.linked_file(id)?.ok_or("Linked file not found")?;
        if file.kind != "markdown" {
            return Err("Only Markdown files can be edited".into());
        }
        let path = PathBuf::from(&file.abs_path);
        let meta = fs::metadata(&path).map_err(|_| "The file is not there; its folder may be offline")?;
        if let Some(expected) = expected_mtime {
            if stat(&meta).mtime != expected {
                return Err("The file was changed in another app. Reload it before saving.".into());
            }
        }
        let temp = path.with_file_name(format!(".{}.key-saving", file.name));
        fs::write(&temp, text.as_bytes()).map_err(e)?;
        if let Err(error) = fs::set_permissions(&temp, meta.permissions()).and_then(|_| fs::rename(&temp, &path)) {
            let _ = fs::remove_file(&temp);
            return Err(error.to_string());
        }
        let s = stat(&fs::metadata(&path).map_err(e)?);
        use sha2::{Digest, Sha256};
        let hash: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        self.db()?
            .execute("UPDATE linked_files SET size = ?2, mtime = ?3, inode = ?4, hash = ?5, missing_at = NULL WHERE id = ?1", params![id, s.size, s.mtime, s.inode, hash])
            .map_err(e)?;
        self.linked_file(id)?.ok_or_else(|| "Linked file not found".into())
    }

    /// Remembers the library source a linked PDF was opened as.
    pub fn set_linked_source(&self, id: &str, source_id: &str) -> Result<()> {
        self.db()?.execute("UPDATE linked_files SET source_id = ?2 WHERE id = ?1", params![id, source_id]).map(|_| ()).map_err(e)
    }

    /// Files the indexer should read next: `first` (opened ones) ahead of the rest, then the
    /// most recently changed.
    pub fn stale_linked_files(&self, limit: usize, first: &[String]) -> Result<Vec<LinkedFile>> {
        let db = self.read()?;
        let mut out = Vec::new();
        {
            let mut one = db
                .prepare(&format!("SELECT {FILE_COLUMNS} FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id WHERE f.id = ?1 AND {}", stale()))
                .map_err(e)?;
            for id in first {
                if let Some(file) = one.query_row([id], read_file).optional().map_err(e)? {
                    out.push(file);
                }
            }
        }
        let mut statement = db
            .prepare(&format!("SELECT {FILE_COLUMNS} FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id WHERE {} ORDER BY f.mtime DESC LIMIT ?1", stale()))
            .map_err(e)?;
        for file in statement.query_map([limit as i64], read_file).map_err(e)? {
            let file = file.map_err(e)?;
            if out.len() >= limit {
                break;
            }
            if !out.iter().any(|f| f.id == file.id) {
                out.push(file);
            }
        }
        out.truncate(limit);
        Ok(out)
    }

    pub fn linked_index_queue_len(&self) -> Result<i64> {
        let db = self.read()?;
        db.query_row(&format!("SELECT count(*) FROM linked_files f JOIN linked_folders d ON d.id = f.folder_id WHERE {}", stale()), [], |r| r.get(0)).map_err(e)
    }

    /// Replaces a file's passages with those read from the version at `mtime`, or records
    /// why it could not be read. Unchanged passages keep their vectors.
    pub fn replace_file_chunks(&self, file_id: &str, mtime: i64, chunks: &[ChunkInput], error: Option<&str>) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let current: Option<i64> = tx.query_row("SELECT mtime FROM linked_files WHERE id = ?", [file_id], |r| r.get(0)).optional().map_err(e)?;
        if current != Some(mtime) {
            // Changed again while it was read (or gone); the next round reads the new version.
            return Ok(());
        }
        let mut kept: HashMap<String, Vec<i64>> = HashMap::new();
        {
            let mut rows = tx.prepare("SELECT id, text FROM chunks WHERE file_id = ? ORDER BY seq DESC").map_err(e)?;
            for row in rows.query_map([file_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(e)? {
                let (id, text) = row.map_err(e)?;
                kept.entry(text).or_default().push(id);
            }
            let mut insert = tx.prepare("INSERT INTO chunks(file_id, seq, page, text, rects, kind, section, embedded) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").map_err(e)?;
            let mut vector = tx.prepare("INSERT INTO chunk_vectors(rowid, embedding) VALUES (?1, ?2)").map_err(e)?;
            let mut reuse = tx.prepare("UPDATE chunks SET seq = ?2, page = ?3, kind = ?4, section = ?5 WHERE id = ?1").map_err(e)?;
            for (seq, chunk) in chunks.iter().enumerate() {
                match kept.get_mut(&chunk.text).and_then(Vec::pop) {
                    Some(id) => reuse.execute(params![id, seq as i64, chunk.page, chunk.kind, chunk.section]).map_err(e)?,
                    None => {
                        let rects = (!chunk.rects.is_empty()).then(|| serde_json::to_string(&chunk.rects).unwrap_or_default());
                        insert.execute(params![file_id, seq as i64, chunk.page, chunk.text, rects, chunk.kind, chunk.section, chunk.embedding.is_some()]).map_err(e)?;
                        if let Some(embedding) = &chunk.embedding {
                            vector.execute(params![tx.last_insert_rowid(), super::vector_blob(embedding)?]).map_err(e)?;
                        }
                        1
                    }
                };
            }
        }
        for id in kept.into_values().flatten() {
            tx.execute("DELETE FROM chunks WHERE id = ?", [id]).map_err(e)?;
        }
        tx.execute("UPDATE linked_files SET indexed_mtime = ?2, index_error = ?3 WHERE id = ?1", params![file_id, mtime, error]).map_err(e)?;
        tx.commit().map_err(e)
    }
}
