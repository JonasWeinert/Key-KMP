// Host side of the workspace library (key-store). Serves the `store_*` commands,
// gives the indexer page text through the PDFium owner, and lets the PDF reader
// open, highlight and annotate sources that live in key-store.
use super::{
    CompanionStore, NativePdfService, Reply, Request, TextPageDto, json_output,
};
use crate::ipc::{Output, arg};
use key_index::{Indexer, PageText, PdfText, TextChar};
use key_store::{ListQuery, SearchQuery, Source, SourceInput, Store};
use serde_json::{Map, Value as Json, json};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub struct Library {
    pub store: Store,
    pub indexer: Indexer,
}

struct HostPdfText(NativePdfService);

impl PdfText for HostPdfText {
    fn pages(&self, path: &Path, _hash: &str) -> Result<Vec<PageText>, String> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = format!("index:{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let Reply::Document(document) = self.0.request(|reply| Request::OpenFile { id: id.clone(), path: path.to_path_buf(), reply })? else {
            return Err("Unexpected PDF open reply".into());
        };
        let mut pages = Vec::with_capacity(document.pages.len());
        let mut result = Ok(());
        for page in 0..document.pages.len() {
            match self.0.request(|reply| Request::Text { id: id.clone(), page, reply }) {
                Ok(Reply::Text(text)) => pages.push(page_text(page, text)),
                Ok(_) => {}
                Err(error) => {
                    result = Err(error);
                    break;
                }
            }
        }
        let _ = self.0.request(|reply| Request::Close { id, reply });
        result.map(|()| pages)
    }
}

fn page_text(page: usize, text: TextPageDto) -> PageText {
    PageText {
        page: Some(page as i64),
        chars: text
            .characters
            .into_iter()
            .map(|c| TextChar { bounds: c.bounds.map(|b| [b.left, b.top, b.right, b.bottom]), value: c.value })
            .collect(),
    }
}

impl Library {
    pub fn open(root: &Path, native: NativePdfService) -> Result<Self, String> {
        let store = Store::open(root)?;
        let indexer = Indexer::start(store.clone(), key_embed::ModelDir::from_env(), std::sync::Arc::new(HostPdfText(native)));
        Ok(Self { store, indexer })
    }

    /// A key-store source the reader knows by content hash (or id, before hashing).
    pub fn reader_source(&self, hash: &str) -> Option<(Source, PathBuf)> {
        let source = self.store.source_by_hash(hash).ok()??;
        let path = source.file_path()?;
        Some((source, path))
    }

    pub fn dispatch(&self, command: &str, args: &Json, root: &Path) -> Option<Result<Output, String>> {
        let result = match command {
            "store_sources" => self.parse::<ListQuery>(args).and_then(|q| json_output(self.store.list_sources(&q)?)),
            "store_facets" => self.parse::<ListQuery>(args).and_then(|q| json_output(self.store.facets(&q)?)),
            "store_source" => arg::<String>(args, "id").and_then(|id| json_output(self.store.source(&id)?)),
            "store_create" => arg::<SourceInput>(args, "source").and_then(|input| {
                let source = self.store.insert_source(input)?;
                self.indexer.wake();
                json_output(source)
            }),
            "store_update" => (|| {
                let id: String = arg(args, "id")?;
                let patch: Map<String, Json> = arg(args, "patch")?;
                let source = self.store.update_source(&id, &patch)?;
                self.indexer.wake();
                json_output(source)
            })(),
            "store_trash" => (|| json_output(self.store.trash(&arg::<Vec<String>>(args, "ids")?, arg::<Option<bool>>(args, "trashed")?.unwrap_or(true))?))(),
            "store_delete" => arg::<Vec<String>>(args, "ids").and_then(|ids| json_output(self.store.delete(&ids)?)),
            "store_bulk_tag" => (|| {
                let ids: Vec<String> = arg(args, "ids")?;
                let add: Option<Vec<String>> = arg(args, "add")?;
                let remove: Option<Vec<String>> = arg(args, "remove")?;
                json_output(self.store.bulk_tag(&ids, &add.unwrap_or_default(), &remove.unwrap_or_default())?)
            })(),
            "store_retag" => (|| json_output(self.store.retag(&arg::<Vec<String>>(args, "from")?, &arg::<String>(args, "to")?)?))(),
            "store_collections" => json_output(self.store.collections().unwrap_or_default()),
            "store_collection_create" => (|| {
                let name: String = arg(args, "name")?;
                let parent: Option<String> = arg(args, "parentId")?;
                json_output(self.store.create_collection(&name, parent.as_deref(), None)?)
            })(),
            "store_collection_update" => (|| {
                let id: String = arg(args, "id")?;
                let name: Option<String> = arg(args, "name")?;
                let parent: Option<Option<String>> = args.get("parentId").map(|v| v.as_str().map(String::from));
                self.store.update_collection(&id, name.as_deref(), parent.as_ref().map(|p| p.as_deref()))?;
                json_output(true)
            })(),
            "store_collection_delete" => arg::<String>(args, "id").and_then(|id| json_output(self.store.delete_collection(&id)?)),
            "store_membership" => (|| {
                json_output(self.store.set_membership(
                    &arg::<String>(args, "collectionId")?,
                    &arg::<Vec<String>>(args, "ids")?,
                    arg::<Option<bool>>(args, "present")?.unwrap_or(true),
                )?)
            })(),
            "store_notes" => arg::<String>(args, "sourceId").and_then(|id| json_output(self.store.notes(&id)?)),
            "store_note_save" => (|| {
                let id: Option<String> = arg(args, "id")?;
                let source: Option<String> = arg(args, "sourceId")?;
                let title: Option<String> = arg(args, "title")?;
                let body: String = arg(args, "body")?;
                json_output(self.store.save_note(id.as_deref(), source.as_deref(), &title.unwrap_or_default(), &body, None)?)
            })(),
            "store_note_delete" => arg::<String>(args, "id").and_then(|id| json_output(self.store.delete_note(&id)?)),
            "store_search" => self.parse::<SearchQuery>(args).and_then(|query| {
                let wants_vector = query.mode.as_deref() != Some("keyword");
                let vector = if wants_vector { self.indexer.embed_query(&query.text) } else { None };
                json_output(self.store.search(&query, vector.as_deref())?)
            }),
            "store_status" => (|| {
                let counts = self.store.list_sources(&ListQuery { limit: Some(0), ..Default::default() })?.counts;
                json_output(json!({
                    "model": self.indexer.model_status(),
                    "busy": self.indexer.is_busy(),
                    "vectors": self.store.vector_count()?,
                    "counts": counts,
                }))
            })(),
            "store_index_control" => (|| {
                let action: String = arg(args, "action")?;
                let ids: Option<Vec<String>> = arg(args, "ids")?;
                match action.as_str() {
                    "pause" => self.indexer.set_paused(true),
                    "resume" => self.indexer.set_paused(false),
                    "retry" | "reindex" => {
                        for id in ids.unwrap_or_default() {
                            self.store.set_index_status(&id, "pending", None, 0, 0)?;
                        }
                        self.indexer.wake();
                    }
                    other => return Err(format!("Unknown indexing action {other}")),
                }
                json_output(true)
            })(),
            "store_import_files" => (|| {
                let paths: Vec<PathBuf> = arg(args, "paths")?;
                let collection: Option<String> = arg(args, "collectionId")?;
                let mut created = Vec::new();
                for path in paths {
                    created.push(self.import_file(&path, None, root, collection.as_deref())?);
                }
                self.indexer.wake();
                json_output(created)
            })(),
            "store_import_zotero" => (|| {
                let options: key_zotero::ImportOptions = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                let report = key_zotero::import(&self.store, &options)?;
                self.indexer.wake();
                json_output(report)
            })(),
            "store_zotero_location" => json_output(key_zotero::default_data_dir()),
            _ => return None,
        };
        Some(result)
    }

    fn parse<T: serde::de::DeserializeOwned>(&self, args: &Json) -> Result<T, String> {
        serde_json::from_value(args.clone()).map_err(|e| e.to_string())
    }

    /// Links a file in place. Files in the system temp folder (downloads) are copied
    /// into the workspace so they outlive the download.
    pub fn import_file(&self, path: &Path, expected_hash: Option<&str>, root: &Path, collection: Option<&str>) -> Result<Json, String> {
        if !path.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        let hash = key_index::file_hash(path)?;
        if let Some(expected) = expected_hash {
            if expected != hash {
                return Err("That file's content differs from the original".into());
            }
            if let Some(mut source) = self.store.source_by_hash(expected)? {
                let mut patch = Map::new();
                patch.insert("filePath".into(), Json::from(path.to_string_lossy().to_string()));
                source = self.store.update_source(&source.id, &patch)?;
                self.indexer.wake();
                return Ok(json!({"hash": hash, "id": source.id, "title": source.title()}));
            }
        }
        if let Some(existing) = self.store.source_by_hash(&hash)? {
            if existing.trashed_at.is_some() {
                self.store.trash(std::slice::from_ref(&existing.id), false)?;
            }
            return Ok(json!({"hash": hash, "id": existing.id, "title": existing.title(), "existing": true}));
        }
        let temporary = path.starts_with(std::env::temp_dir()) || path.to_string_lossy().contains("/T/");
        let stored = if temporary {
            let directory = root.join("files");
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let target = directory.join(format!("{hash}.{extension}"));
            std::fs::copy(path, &target).map_err(|e| e.to_string())?;
            target
        } else {
            path.to_path_buf()
        };
        let (kind, item_type, mime) = classify(&stored);
        let title = path.file_stem().map(|s| s.to_string_lossy().replace(['_', '-'], " ")).unwrap_or_default();
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from(title));
        fields.insert("itemType".into(), Json::from(item_type));
        fields.insert("filePath".into(), Json::from(stored.to_string_lossy().to_string()));
        fields.insert("fileHash".into(), Json::from(hash.clone()));
        fields.insert("mime".into(), Json::from(mime));
        fields.insert("fileSize".into(), Json::from(std::fs::metadata(&stored).map(|m| m.len()).unwrap_or(0)));
        let source = self.store.insert_source(SourceInput {
            kind: kind.into(),
            collections: collection.map(|c| vec![c.to_string()]).unwrap_or_default(),
            fields,
            ..Default::default()
        })?;
        Ok(json!({"hash": hash, "id": source.id, "title": source.title()}))
    }

    // ── Reader support ─────────────────────────────────────

    pub fn source_info(&self, hash: &str) -> Option<Result<Output, String>> {
        let (source, path) = self.reader_source(hash)?;
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Some(json_output(json!({"hash": hash, "size": size, "title": source.title()})))
    }

    pub fn source_range(&self, hash: &str, offset: u64, length: usize) -> Option<Result<Vec<u8>, String>> {
        let (_, path) = self.reader_source(hash)?;
        Some((|| {
            let mut file = std::fs::File::open(&path).map_err(|e| format!("The linked file is unavailable: {e}"))?;
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let mut buffer = vec![0; length.min(32 * 1024 * 1024)];
            let mut filled = 0;
            while filled < buffer.len() {
                let read = file.read(&mut buffer[filled..]).map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                filled += read;
            }
            buffer.truncate(filled);
            Ok(buffer)
        })())
    }

    /// Opens a key-store PDF in the reader companion without the legacy analysis pipeline.
    pub fn begin_companion(&self, hash: &str, native: &NativePdfService, companions: &CompanionStore) -> Option<Result<super::CompanionSnapshotDto, String>> {
        let (source, path) = self.reader_source(hash)?;
        Some((|| {
            if let Ok(snapshot) = companions.storage.snapshot(hash) {
                companions.reader_ids.lock().map_err(|_| "Reader registry poisoned")?.insert(hash.to_string());
                return Ok(snapshot);
            }
            let Reply::Document(mut document) = native.request(|reply| Request::OpenFile { id: hash.to_string(), path, reply })? else {
                return Err("Unexpected open reply".into());
            };
            if document.title.as_deref().unwrap_or("").is_empty() {
                document.title = Some(source.title().to_string());
            }
            let pages = document.pages.len();
            let generation = companions.storage.begin(hash.to_string(), document);
            companions.storage.set_document_hash(hash, generation, hash.to_string());
            let chunks = source.indexed_chunks.max(0) as usize;
            companions.storage.set_semantic_progress(hash, generation, "indexed", chunks, chunks.max(pages));
            companions.storage.finish(hash, generation);
            companions.reader_ids.lock().map_err(|_| "Reader registry poisoned")?.insert(hash.to_string());
            companions.storage.snapshot(hash)
        })())
    }

    pub fn page_path(&self, hash: &str) -> Option<PathBuf> {
        self.reader_source(hash).map(|(_, path)| path)
    }

    pub fn annotations(&self, command: &str, args: &Json) -> Option<Result<Output, String>> {
        let hash: String = arg(args, "hash").ok()?;
        let source = self.store.source_by_hash(&hash).ok()??;
        Some(match command {
            "library_annotations" => self.store.annotations(&source.id).and_then(json_output),
            "library_apply_annotations" => (|| {
                let upserts: Vec<Json> = arg(args, "upserts")?;
                let deleted: Vec<String> = arg(args, "deleted")?;
                self.store.apply_annotations(&source.id, &upserts, &deleted)?;
                json_output(())
            })(),
            "library_save_annotations" | "library_import_annotations" => (|| {
                let annotations: Vec<Json> = arg(args, "annotations")?;
                self.store.replace_annotations(&source.id, &annotations)?;
                json_output(())
            })(),
            _ => return None,
        })
    }

    pub fn search_target(&self, id: &str) -> Option<Result<Output, String>> {
        let chunk: i64 = id.parse().ok()?;
        Some(match self.store.passage(chunk) {
            Ok(Some(passage)) => json_output(passage),
            Ok(None) => Err("This search passage is no longer available. Search again.".into()),
            Err(error) => Err(error),
        })
    }
}

fn classify(path: &Path) -> (&'static str, &'static str, String) {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "pdf" => ("pdf", "document", "application/pdf".into()),
        "html" | "htm" => ("web", "webpage", "text/html".into()),
        "mp4" | "mov" | "m4v" | "webm" | "mkv" => ("video", "video", format!("video/{extension}")),
        "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg" => ("audio", "audio", format!("audio/{extension}")),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "tif" | "tiff" => ("image", "image", format!("image/{extension}")),
        "txt" | "md" => ("file", "document", "text/plain".into()),
        _ => ("file", "document", "application/octet-stream".into()),
    }
}
