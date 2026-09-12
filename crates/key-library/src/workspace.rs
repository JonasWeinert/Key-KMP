//! Logical workspace records live beside PDF metadata in the canonical SQLite database.
use crate::{Imports, Library, Result, content_hash, err, now_ms};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub root: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub folder: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub kind: String,
    pub document_hash: Option<String>,
    pub title: String,
    pub properties: Value,
    pub body: String,
    pub revision: i64,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFolder {
    pub id: String,
    pub project_id: String,
    pub path: String,
}
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub visited: usize,
    pub indexed: usize,
    pub pdf_hashes: Vec<String>,
    pub truncated: bool,
    pub errors: Vec<String>,
}
fn label(s: &str) -> Result<String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 256 {
        Err("Name must contain 1 to 256 bytes".into())
    } else {
        Ok(s.into())
    }
}
fn fresh_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    content_hash(
        format!(
            "{}:{}:{}",
            now_ms(),
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
        .as_bytes(),
    )
}
pub(crate) fn record(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    let props: String = row.get(4)?;
    Ok(WorkspaceRecord {
        id: row.get(0)?,
        kind: row.get(1)?,
        document_hash: row.get(2)?,
        title: row.get(3)?,
        properties: serde_json::from_str(&props).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?,
        body: row.get(5)?,
        revision: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
impl Library {
    pub fn initialize_workspace(&self, name: &str, workspace_root: &Path) -> Result<WorkspaceInfo> {
        let name = label(name)?;
        let root = fs::canonicalize(workspace_root).map_err(err)?;
        if self.root() != root.join(".key") {
            return Err("Workspace library must be located in its .key folder".into());
        }
        let root = root.to_string_lossy().into_owned();
        let id = fresh_id();
        self.writer.run(true, move |c| {
            c.execute(
                "INSERT OR IGNORE INTO workspace_identity VALUES(1,?1,?2,?3,?4)",
                params![id, name, root, now_ms()],
            )
            .map_err(err)?;
            Ok(())
        })?;
        self.workspace_info()?
            .ok_or("Workspace initialization failed".into())
    }
    pub fn workspace_info(&self) -> Result<Option<WorkspaceInfo>> {
        self.connection()?
            .query_row(
                "SELECT id,name,root FROM workspace_identity WHERE singleton=1",
                [],
                |r| {
                    Ok(WorkspaceInfo {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        root: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(err)
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        self.connection()?
            .prepare("SELECT id,name,folder FROM workspace_projects ORDER BY name,id")
            .map_err(err)?
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    folder: r.get(2)?,
                })
            })
            .map_err(err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(err)
    }
    pub fn create_project(&self, name: &str) -> Result<Project> {
        let name = label(name)?;
        let info = self
            .workspace_info()?
            .ok_or("Initialize the workspace first")?;
        let id = fresh_id();
        let slug: String = name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let folder = Path::new(&info.root).join(format!("{}-{}", slug, &id[..8]));
        fs::create_dir(&folder).map_err(err)?;
        let p = Project {
            id,
            name,
            folder: folder.to_string_lossy().into_owned(),
        };
        let copy = p.clone();
        if let Err(e) = self.writer.run(true, move |c| {
            c.execute(
                "INSERT INTO workspace_projects VALUES(?1,?2,?3,?4)",
                params![copy.id, copy.name, copy.folder, now_ms()],
            )
            .map_err(err)?;
            Ok(())
        }) {
            let _ = fs::remove_dir(folder);
            return Err(e);
        }
        Ok(p)
    }
    pub fn workspace_record(&self, id: &str) -> Result<Option<WorkspaceRecord>> {
        self.connection()?.query_row("SELECT id,kind,document_hash,title,properties,body,revision,updated_at FROM workspace_records WHERE id=?1", [id], record).optional().map_err(err)
    }
    pub fn records(
        &self,
        project_id: Option<&str>,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<WorkspaceRecord>> {
        let query = query
            .filter(|q| !q.trim().is_empty())
            .map(|q| format!("\"{}\"", q.replace('"', "\"\"")));
        self.connection()?.prepare("SELECT r.id,r.kind,r.document_hash,r.title,r.properties,r.body,r.revision,r.updated_at FROM workspace_records r WHERE (?1 IS NULL OR EXISTS(SELECT 1 FROM workspace_project_records p WHERE p.record_id=r.id AND p.project_id=?1)) AND (?2 IS NULL OR r.id IN (SELECT id FROM workspace_record_fts WHERE workspace_record_fts MATCH ?2)) AND (r.document_hash IS NULL OR EXISTS(SELECT 1 FROM documents d WHERE d.hash=r.document_hash AND d.deleted_at IS NULL)) ORDER BY r.updated_at DESC,r.id LIMIT ?3 OFFSET ?4").map_err(err)?.query_map(params![project_id,query,limit.clamp(1,500) as i64,offset.min(i64::MAX as usize) as i64],record).map_err(err)?.collect::<std::result::Result<_,_>>().map_err(err)
    }
    pub fn save_record(
        &self,
        id: Option<&str>,
        kind: &str,
        title: &str,
        properties: &Value,
        body: &str,
        expected_revision: Option<i64>,
    ) -> Result<WorkspaceRecord> {
        if !matches!(kind, "note" | "document" | "page" | "database" | "file") {
            return Err("Use document metadata commands to edit sources".into());
        }
        let title = label(title)?;
        let properties = serde_json::to_string(properties).map_err(err)?;
        if !properties.starts_with('{') || properties.len() > 64 * 1024 || body.len() > 1024 * 1024
        {
            return Err(
                "Record requires object properties up to 64 KiB and body up to 1 MiB".into(),
            );
        }
        let id = id.map(str::to_owned).unwrap_or_else(fresh_id);
        let kind = kind.to_owned();
        let body = body.to_owned();
        self.writer.run(true,move|c|{let tx=c.transaction().map_err(err)?;let old:Option<(i64,String)>=tx.query_row("SELECT revision,kind FROM workspace_records WHERE id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
   if let Some((rev,old_kind))=&old {if expected_revision!=Some(*rev){return Err("Record changed; reload before saving".into())}if old_kind!=&kind{return Err("Record kind cannot be changed".into())}}
   else if expected_revision.is_some(){return Err("Record no longer exists".into())}
   tx.execute("INSERT INTO workspace_records(id,kind,title,properties,body,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET title=excluded.title,properties=excluded.properties,body=excluded.body,revision=workspace_records.revision+1,updated_at=excluded.updated_at",params![id,kind,title,properties,body,now_ms()]).map_err(err)?;
   let value=tx.query_row("SELECT id,kind,document_hash,title,properties,body,revision,updated_at FROM workspace_records WHERE id=?1",[id],record).map_err(err)?;tx.commit().map_err(err)?;Ok(value)})
    }
    /// Register a saved Office file without duplicating a record on every reopen.
    pub fn register_workspace_file(
        &self,
        path: &Path,
        editor: &str,
        title: &str,
    ) -> Result<WorkspaceRecord> {
        let path = fs::canonicalize(path).map_err(err)?;
        let metadata = path.metadata().map_err(err)?;
        if !metadata.is_file() {
            return Err("Saved document must be a regular file".into());
        }
        let hash = crate::file_hash(&path)?;
        let path = path.to_string_lossy().into_owned();
        let title = label(title)?;
        let editor = label(editor)?;
        self.writer.run(true, move |c| {
            let tx = c.transaction().map_err(err)?;
            let existing: Option<String> = tx.query_row("SELECT id FROM workspace_records WHERE kind!='source' AND json_extract(properties,'$.path')=?1 ORDER BY updated_at DESC LIMIT 1", [&path], |r| r.get(0)).optional().map_err(err)?;
            let id = existing.unwrap_or_else(|| format!("file:{}", content_hash(path.as_bytes())));
            let observed = serde_json::json!({"path":path,"editor":editor,"contentHash":hash,"size":metadata.len()}).to_string();
            tx.execute("INSERT INTO workspace_records(id,kind,title,properties,updated_at) VALUES(?1,'document',?2,?3,?4) ON CONFLICT(id) DO UPDATE SET title=excluded.title,properties=json_patch(workspace_records.properties,excluded.properties),revision=CASE WHEN workspace_records.title=excluded.title AND workspace_records.properties=json_patch(workspace_records.properties,excluded.properties) THEN workspace_records.revision ELSE workspace_records.revision+1 END,updated_at=excluded.updated_at",params![id,title,observed,now_ms()]).map_err(err)?;
            let result=tx.query_row("SELECT id,kind,document_hash,title,properties,body,revision,updated_at FROM workspace_records WHERE id=?1",[id],record).map_err(err)?;
            tx.commit().map_err(err)?; Ok(result)
        })
    }
    pub fn set_project_membership(
        &self,
        project_id: &str,
        record_id: &str,
        present: bool,
    ) -> Result<()> {
        let p = project_id.to_owned();
        let r = record_id.to_owned();
        self.writer.run(true, move |c| {
            c.execute(
                if present {
                    "INSERT OR IGNORE INTO workspace_project_records VALUES(?1,?2)"
                } else {
                    "DELETE FROM workspace_project_records WHERE project_id=?1 AND record_id=?2"
                },
                params![p, r],
            )
            .map_err(err)?;
            Ok(())
        })
    }
    pub fn link_folder(&self, project_id: &str, path: &Path) -> Result<LinkedFolder> {
        let path = fs::canonicalize(path).map_err(err)?;
        if !path.is_dir() {
            return Err("Linked folder must be a directory".into());
        }
        if path.starts_with(self.root()) || self.root().starts_with(&path) {
            return Err("Link a content folder outside Key's internal data folder".into());
        }
        let path = path.to_string_lossy().into_owned();
        let p = project_id.to_owned();
        self.writer.run(true,move|c|{c.execute("INSERT OR IGNORE INTO workspace_linked_folders VALUES(?1,?2,?3)",params![fresh_id(),p,path]).map_err(err)?;c.query_row("SELECT id,project_id,path FROM workspace_linked_folders WHERE project_id=?1 AND path=?2",params![p,path],|r|Ok(LinkedFolder{id:r.get(0)?,project_id:r.get(1)?,path:r.get(2)?})).map_err(err)})
    }
    pub fn linked_folders(&self) -> Result<Vec<LinkedFolder>> {
        self.connection()?
            .prepare("SELECT id,project_id,path FROM workspace_linked_folders ORDER BY path")
            .map_err(err)?
            .query_map([], |r| {
                Ok(LinkedFolder {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    path: r.get(2)?,
                })
            })
            .map_err(err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(err)
    }
    /// Explicit rescan hashes bytes, never trusts modification timestamps. Original files are read only.
    /// The entry budget bounds work; a truncated scan never interprets unseen files as deletions.
    pub fn scan_linked_folder(&self, id: &str, max_entries: usize) -> Result<ScanReport> {
        let folder = self
            .linked_folders()?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or("Linked folder not found")?;
        let root = fs::canonicalize(&folder.path).map_err(err)?;
        if root != Path::new(&folder.path) {
            return Err("Linked folder location changed; relink it".into());
        }
        let mut stack = vec![fs::read_dir(&root).map_err(err)?];
        let mut report = ScanReport::default();
        let budget = max_entries.clamp(1, 10_000);
        while let Some(iter) = stack.last_mut() {
            let Some(entry) = iter.next() else {
                stack.pop();
                continue;
            };
            if report.visited >= budget {
                report.truncated = true;
                break;
            }
            report.visited += 1;
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    report.errors.push(e.to_string());
                    continue;
                }
            };
            let ty = match entry.file_type() {
                Ok(t) => t,
                Err(e) => {
                    report.errors.push(e.to_string());
                    continue;
                }
            };
            if ty.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ty.is_dir() {
                if stack.len() < 64 {
                    match fs::read_dir(&path) {
                        Ok(d) => stack.push(d),
                        Err(e) => report.errors.push(e.to_string()),
                    }
                } else {
                    report.truncated = true
                }
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            match self.index_linked_file(&folder, &root, &path) {
                Ok(hash) => {
                    report.indexed += 1;
                    if let Some(hash) = hash {
                        report.pdf_hashes.push(hash)
                    }
                }
                Err(e) => report.errors.push(format!("{}: {e}", path.display())),
            }
        }
        Ok(report)
    }
    fn index_linked_file(
        &self,
        folder: &LinkedFolder,
        root: &Path,
        path: &Path,
    ) -> Result<Option<String>> {
        let canonical = fs::canonicalize(path).map_err(err)?;
        if !canonical.starts_with(root) || canonical.starts_with(self.root()) {
            return Err("File escapes the linked folder or enters Key data".into());
        }
        let before = fs::metadata(&canonical).map_err(err)?;
        if before.len() > 2 * 1024 * 1024 * 1024 {
            return Err("File exceeds the 2 GiB scan limit".into());
        }
        let title = path
            .file_name()
            .ok_or("Missing filename")?
            .to_string_lossy()
            .into_owned();
        let pdf = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        let hash = if pdf {
            let imports = Imports::default();
            let id = imports.begin(self, title.clone(), before.len())?;
            let mut input = fs::File::open(&canonical).map_err(err)?;
            let mut bytes = vec![0; 1024 * 1024];
            let mut offset = 0;
            let mut digest = Sha256::new();
            loop {
                let n = input.read(&mut bytes).map_err(err)?;
                if n == 0 {
                    break;
                }
                imports.append(&id, offset, &bytes[..n])?;
                digest.update(&bytes[..n]);
                offset += n as u64;
            }
            let hash = format!("{:x}", digest.finalize());
            if self.is_purged(&hash)? {
                imports.cancel(&id)?;
                return Err(
                    "Previously deleted source skipped; explicitly import it to restore".into(),
                );
            }
            imports.finish(self, &id)?.hash
        } else {
            crate::file_hash(&canonical)?
        };
        let after = fs::metadata(&canonical).map_err(err)?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("File changed during scanning; rescan it".into());
        }
        let path = canonical.to_string_lossy().into_owned();
        let record_id = if pdf {
            format!("source:{hash}")
        } else {
            format!("file:{}", content_hash(path.as_bytes()))
        };
        let f = folder.clone();
        let rid = record_id.clone();
        let h = hash.clone();
        self.writer.run(false,move|c|{let tx=c.transaction().map_err(err)?;
   if !pdf {let props=serde_json::json!({"path":path,"size":after.len(),"contentHash":h}).to_string();tx.execute("INSERT INTO workspace_records(id,kind,title,properties,updated_at) VALUES(?1,'file',?2,?3,?4) ON CONFLICT(id) DO UPDATE SET title=excluded.title,properties=json_patch(workspace_records.properties,excluded.properties),revision=CASE WHEN workspace_records.properties=json_patch(workspace_records.properties,excluded.properties) THEN workspace_records.revision ELSE workspace_records.revision+1 END,updated_at=excluded.updated_at",params![rid,title,props,now_ms()]).map_err(err)?;}
   tx.execute("INSERT OR IGNORE INTO workspace_project_records VALUES(?1,?2)",params![f.project_id,rid]).map_err(err)?;
   tx.execute("INSERT INTO workspace_linked_files VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(folder_id,path) DO UPDATE SET record_id=excluded.record_id,content_hash=excluded.content_hash,size=excluded.size,seen_at=excluded.seen_at",params![f.id,path,rid,h,after.len() as i64,now_ms()]).map_err(err)?;tx.commit().map_err(err)})?;
        Ok(pdf.then_some(hash))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> (tempfile::TempDir, Library) {
        let t = tempfile::tempdir().unwrap();
        let l = Library::open(t.path().join(".key")).unwrap();
        l.initialize_workspace("Test", t.path()).unwrap();
        (t, l)
    }
    #[test]
    fn source_membership_is_durable_and_workspace_owned() {
        let (t, l) = workspace();
        let hash = l.store_source(b"pdf", "Paper", 1).unwrap();
        let a = l.create_project("Alpha").unwrap();
        let b = l.create_project("Beta").unwrap();
        let id = format!("source:{hash}");
        for p in [&a, &b] {
            l.set_project_membership(&p.id, &id, true).unwrap();
            assert_eq!(l.records(Some(&p.id), None, 10, 0).unwrap().len(), 1);
        }
        assert_eq!(
            l.documents(&crate::Filter {
                project_id: Some(a.id.clone()),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
        l.set_project_membership(&a.id, &id, false).unwrap();
        assert!(
            l.documents(&crate::Filter {
                project_id: Some(a.id.clone()),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
        );
        assert_eq!(l.records(None, None, 10, 0).unwrap().len(), 1);
        drop(l);
        let l = Library::open(t.path().join(".key")).unwrap();
        assert_eq!(l.projects().unwrap().len(), 2);
        assert_eq!(
            l.records(Some(&b.id), Some("Paper"), 10, 0).unwrap().len(),
            1
        );
    }
    #[test]
    fn records_use_revision_fences_and_fts() {
        let (_t, l) = workspace();
        let r = l
            .save_record(
                None,
                "note",
                "Research",
                &serde_json::json!({"reviewed":true}),
                "neuroscience",
                None,
            )
            .unwrap();
        assert!(
            l.save_record(
                Some(&r.id),
                "note",
                "Lost edit",
                &serde_json::json!({}),
                "",
                None
            )
            .is_err()
        );
        let r = l
            .save_record(
                Some(&r.id),
                "note",
                "Saved",
                &serde_json::json!({}),
                "synapse",
                Some(r.revision),
            )
            .unwrap();
        assert_eq!(r.revision, 2);
        assert_eq!(l.records(None, Some("synapse"), 10, 0).unwrap().len(), 1);
        assert!(
            l.records(None, Some("neuroscience"), 10, 0)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn linked_scan_hashes_changed_bytes_without_touching_originals() {
        let (_t, l) = workspace();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("a.txt"), "first").unwrap();
        let p = l.create_project("Project").unwrap();
        let f = l.link_folder(&p.id, ext.path()).unwrap();
        let report = l.scan_linked_folder(&f.id, 100).unwrap();
        assert_eq!(report.indexed, 1);
        let r = l
            .records(Some(&p.id), Some("a.txt"), 10, 0)
            .unwrap()
            .remove(0);
        let hash = r.properties["contentHash"].clone();
        let mut props = r.properties.clone();
        props["userLabel"] = serde_json::json!("Keep me");
        l.save_record(
            Some(&r.id),
            "file",
            &r.title,
            &props,
            &r.body,
            Some(r.revision),
        )
        .unwrap();
        fs::write(ext.path().join("a.txt"), "other").unwrap();
        l.scan_linked_folder(&f.id, 100).unwrap();
        let r = l.records(Some(&p.id), None, 10, 0).unwrap().remove(0);
        assert_ne!(r.properties["contentHash"], hash);
        assert_eq!(
            fs::read_to_string(ext.path().join("a.txt")).unwrap(),
            "other"
        );
        assert_eq!(r.properties["userLabel"], "Keep me");
        assert_eq!(r.revision, 3);
    }
    #[test]
    fn linked_pdf_import_is_content_addressed_and_does_not_resurrect_purges() {
        let (_t, l) = workspace();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("paper.pdf"), b"%PDF-test").unwrap();
        let p = l.create_project("PDFs").unwrap();
        let f = l.link_folder(&p.id, ext.path()).unwrap();
        let report = l.scan_linked_folder(&f.id, 100).unwrap();
        let hash = &report.pdf_hashes[0];
        assert_eq!(
            fs::read(l.source_path(hash).unwrap()).unwrap(),
            b"%PDF-test"
        );
        assert_eq!(l.records(Some(&p.id), None, 10, 0).unwrap().len(), 1);
        l.set_removed(hash, true).unwrap();
        l.purge_document(hash).unwrap();
        let report = l.scan_linked_folder(&f.id, 100).unwrap();
        assert_eq!(report.indexed, 0);
        assert!(report.errors[0].contains("Previously deleted"));
        assert!(l.is_purged(hash).unwrap());
        assert_eq!(
            fs::read(ext.path().join("paper.pdf")).unwrap(),
            b"%PDF-test"
        );
    }
    #[test]
    fn office_file_registration_reuses_linked_record_and_user_properties() {
        let (_t, l) = workspace();
        let ext = tempfile::tempdir().unwrap();
        let path = ext.path().join("draft.docx");
        fs::write(&path, b"document").unwrap();
        let a = l.register_workspace_file(&path, "word", "Draft").unwrap();
        let b = l.register_workspace_file(&path, "word", "Draft").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.revision, b.revision);
        let mut props = b.properties.clone();
        props["custom"] = serde_json::json!(42);
        l.save_record(Some(&b.id), &b.kind, &b.title, &props, "", Some(b.revision))
            .unwrap();
        let c = l.register_workspace_file(&path, "word", "Renamed").unwrap();
        assert_eq!(c.properties["custom"], 42);
        assert_eq!(l.records(None, None, 10, 0).unwrap().len(), 1);
    }
    #[test]
    fn document_pages_keep_project_eligibility_and_total() {
        let (_t, l) = workspace();
        let p = l.create_project("Subset").unwrap();
        for n in 0..5 {
            let hash = l
                .store_source(format!("pdf{n}").as_bytes(), &format!("Paper {n}"), 1)
                .unwrap();
            if n < 3 {
                l.set_project_membership(&p.id, &format!("source:{hash}"), true)
                    .unwrap();
            }
        }
        let f = crate::Filter {
            project_id: Some(p.id),
            ..Default::default()
        };
        let (first, total) = l.documents_page(&f, 2, 0).unwrap();
        let (last, total2) = l.documents_page(&f, 2, 2).unwrap();
        assert_eq!((first.len(), last.len(), total, total2), (2, 1, 3, 3));
        let (empty, total) = l.documents_page(&f, 2, 10).unwrap();
        assert!(empty.is_empty());
        assert_eq!(total, 3);
    }
    #[cfg(unix)]
    #[test]
    fn linked_scan_skips_symlinks_and_bounds_entries() {
        let (_t, l) = workspace();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("a.txt"), "x").unwrap();
        fs::write(ext.path().join("b.txt"), "y").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", ext.path().join("escape")).unwrap();
        let p = l.create_project("Project").unwrap();
        let f = l.link_folder(&p.id, ext.path()).unwrap();
        let report = l.scan_linked_folder(&f.id, 1).unwrap();
        assert!(report.truncated);
        assert_eq!(report.visited, 1);
        let report = l.scan_linked_folder(&f.id, 100).unwrap();
        assert_eq!(report.indexed, 2);
        assert!(report.errors.is_empty());
    }
}
