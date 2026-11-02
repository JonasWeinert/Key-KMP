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
    pub references: super::reference_worker::ReferenceWorker,
    /// One Zotero import or sync at a time; its progress while it runs.
    zotero: std::sync::Mutex<()>,
    zotero_progress: std::sync::Arc<std::sync::Mutex<Option<key_zotero::Progress>>>,
}

struct HostPdfText(NativePdfService);

impl PdfText for HostPdfText {
    fn pages(&self, path: &Path, _hash: &str, progress: &dyn Fn(usize, usize)) -> Result<Vec<PageText>, String> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = format!("index:{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let Reply::Document(document) = self.0.request(|reply| Request::OpenFile { id: id.clone(), path: path.to_path_buf(), reply })? else {
            return Err("Unexpected PDF open reply".into());
        };
        let mut pages = Vec::with_capacity(document.pages.len());
        let mut result = Ok(());
        let total = document.pages.len();
        for page in 0..total {
            progress(page, total);
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
    fn layout(&self, path: &Path, _hash: &str, model: bool) -> Result<Option<key_index::Layout>, String> {
        crate::layout_helper::analyze(path, model).map(Some)
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
    pub fn open(root: &Path, native: NativePdfService, cache: key_library::Library) -> Result<Self, String> {
        let store = Store::open(root)?;
        let indexer = Indexer::start(store.clone(), key_embed::ModelDir::from_env(), std::sync::Arc::new(HostPdfText(native.clone())));
        // The app turns the layout model off through the environment (Settings).
        indexer.set_layout_model(std::env::var("KEY_LAYOUT_MODEL_ENABLED").map_or(true, |v| v != "0"));
        let references = super::reference_worker::ReferenceWorker::start(store.clone(), native, cache);
        Ok(Self { store, indexer, references, zotero: Default::default(), zotero_progress: Default::default() })
    }

    fn zotero_run(&self, options: &key_zotero::ImportOptions, mode: key_zotero::Mode) -> Result<key_zotero::ImportReport, String> {
        let _running = self.zotero.lock().map_err(|e| e.to_string())?;
        let progress = self.zotero_progress.clone();
        let report = key_zotero::run(&self.store, options, mode, &|p| {
            if let Ok(mut current) = progress.lock() {
                *current = Some(p);
            }
        });
        *self.zotero_progress.lock().map_err(|e| e.to_string())? = None;
        self.indexer.wake();
        report
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
            // Without a source: the workspace's standalone notes.
            "store_notes" => arg::<Option<String>>(args, "sourceId").and_then(|id| match id {
                Some(id) => json_output(self.store.notes(&id)?),
                None => json_output(self.store.standalone_notes()?),
            }),
            "store_note" => arg::<String>(args, "id").and_then(|id| json_output(self.store.note(&id)?)),
            "store_page_chunk" => (|| {
                let chunk = self.store.page_chunk(&arg::<String>(args, "sourceId")?, arg::<i64>(args, "page")?)?;
                json_output(chunk.map(|id| id.to_string()))
            })(),
            "store_note_save" => (|| {
                let id: Option<String> = arg(args, "id")?;
                let source: Option<String> = arg(args, "sourceId")?;
                let title: Option<String> = arg(args, "title")?;
                let body: String = arg(args, "body")?;
                let note = self.store.save_note(id.as_deref(), source.as_deref(), &title.unwrap_or_default(), &body, None)?;
                // Searchable as soon as it is saved; a failure leaves it for the indexer to retry.
                if let Err(error) = self.indexer.index_note(&note) {
                    eprintln!("Key note indexing for {}: {error}", note.id);
                }
                json_output(note)
            })(),
            "store_note_delete" => arg::<String>(args, "id").and_then(|id| json_output(self.store.delete_note(&id)?)),
            // Filters to offer while the user types, counted within the current view.
            "store_suggest" => (|| {
                let text: String = arg(args, "text")?;
                let per_group: Option<usize> = arg(args, "perGroup")?;
                let view: ListQuery = self.parse(args)?;
                json_output(self.store.suggest(&text, &view, per_group.unwrap_or(5))?)
            })(),
            "store_search" => self.parse::<SearchQuery>(args).and_then(|query| {
                // One or two letters are still being typed; meaning needs a real word.
                let letters = query.text.chars().filter(|c| c.is_alphanumeric()).count();
                let wants_vector = query.mode.as_deref() != Some("keyword") && letters >= 3;
                let vector = if wants_vector { self.indexer.embed_query(&query.text) } else { None };
                json_output(self.store.search(&query, vector.as_deref())?)
            }),
            "store_status" => (|| {
                let counts = self.store.list_sources(&ListQuery { limit: Some(0), ..Default::default() })?.counts;
                json_output(json!({
                    "model": self.indexer.model_status(),
                    "busy": self.indexer.is_busy(),
                    "activity": self.indexer.activity(),
                    "references": self.store.references_activity()?,
                    "vectors": self.store.vector_count()?,
                    "counts": counts,
                }))
            })(),
            // The renderer reports what the user is working with, so indexing follows them.
            "store_index_priority" => (|| {
                let ids: Vec<String> = arg(args, "ids")?;
                let reason: String = arg(args, "reason")?;
                let priority = key_index::Priority::parse(&reason).ok_or_else(|| format!("Unknown priority {reason}"))?;
                self.indexer.prioritize(&ids, priority);
                json_output(true)
            })(),
            "store_index_control" => (|| {
                let action: String = arg(args, "action")?;
                let ids: Option<Vec<String>> = arg(args, "ids")?;
                match action.as_str() {
                    "pause" => self.indexer.set_paused(true),
                    "resume" => self.indexer.set_paused(false),
                    "retry_failed" => {
                        let count = self.store.retry_failed()?;
                        self.indexer.wake();
                        return json_output(count);
                    }
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
                json_output(self.zotero_run(&options, key_zotero::Mode::Import)?)
            })(),
            "store_zotero_location" => json_output(key_zotero::default_data_dir()),
            // The import dialogue: collections with counts, and what the chosen options cover.
            "store_zotero_preview" => (|| {
                let options: key_zotero::ImportOptions = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                json_output(key_zotero::preview(&options)?)
            })(),
            "store_zotero_progress" => self.zotero_progress.lock().map_err(|e| e.to_string()).and_then(|p| json_output(p.clone())),
            "store_zotero_status" => key_zotero::last_run(&self.store).and_then(json_output),
            // Called on a timer while sync is on: cheap unless zotero.sqlite changed.
            "store_zotero_sync" => (|| {
                let force = arg::<Option<bool>>(args, "force")?.unwrap_or(false);
                let Some(options) = key_zotero::last_run(&self.store)?.options else {
                    return json_output(json!({ "ran": false, "reason": "never-imported" }));
                };
                let data_dir = options.data_dir.clone().or_else(key_zotero::default_data_dir).ok_or("No Zotero library found.")?;
                if !force && !key_zotero::changed_since_last_run(&self.store, &data_dir, 4000)? {
                    return json_output(json!({ "ran": false }));
                }
                let Ok(_running) = self.zotero.try_lock() else {
                    return json_output(json!({ "ran": false, "reason": "busy" }));
                };
                drop(_running);
                let report = self.zotero_run(&options, key_zotero::Mode::Sync)?;
                json_output(json!({ "ran": true, "report": report }))
            })(),
            "store_attach_file" => (|| {
                let id: String = arg(args, "id")?;
                let path: PathBuf = arg(args, "path")?;
                let source = self.attach_file(&id, &path, root)?;
                self.indexer.wake();
                json_output(source)
            })(),
            // Document analysis: how a source was read, its Markdown and its bibliography.
            "store_analysis" => arg::<String>(args, "id").and_then(|id| {
                json_output(json!({
                    "analysis": self.store.analysis(&id)?,
                    "references": self.store.references(&id)?,
                    "citations": self.store.citations(&id)?,
                    "layoutModel": self.indexer.layout_model(),
                    "indexStatus": self.store.source(&id)?.map(|s| s.index_status),
                }))
            }),
            "store_markdown" => arg::<String>(args, "id").and_then(|id| json_output(self.store.markdown(&id)?)),
            "store_reanalyze" => arg::<String>(args, "id").and_then(|id| {
                self.store.reanalyze(&id)?;
                self.indexer.prioritize(std::slice::from_ref(&id), key_index::Priority::Opened);
                self.references.focus(&id);
                json_output(true)
            }),
            "store_analysis_options" => (|| {
                if let Some(model) = arg::<Option<bool>>(args, "layoutModel")? {
                    self.indexer.set_layout_model(model);
                }
                let engine = if self.indexer.layout_model() { "layout-onnx" } else { "layout" };
                if arg::<Option<bool>>(args, "reanalyzeOutdated")?.unwrap_or(false) {
                    self.store.reanalyze_outdated(engine)?;
                    self.indexer.wake();
                }
                json_output(json!({ "layoutModel": self.indexer.layout_model(), "outdated": self.store.outdated_analyses(engine)? }))
            })(),
            "store_provenance" => arg::<String>(args, "id").and_then(|id| json_output(self.store.property_provenance(&id)?)),
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
        let stored = self.stored_path(path, &hash, root)?;
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

    /// Commands the existing property, agent-fill and tag UI speaks, served from key-store.
    /// Definition and tag commands always use key-store; per-source ones only when the
    /// hash resolves to a key-store source.
    pub fn compat(&self, command: &str, args: &Json) -> Option<Result<Output, String>> {
        let store = &self.store;
        let source = |key: &str| -> Option<Source> { arg::<String>(args, key).ok().and_then(|h| store.source_by_hash(&h).ok().flatten()) };
        Some(match command {
            "workspace_attributes" => store.property_definitions().and_then(json_output),
            "workspace_save_attribute" => (|| {
                store.save_property_definition(&arg::<String>(args, "name")?, &arg::<Json>(args, "config")?)?;
                json_output(())
            })(),
            "workspace_rename_attribute" => (|| json_output(store.rename_property(&arg::<String>(args, "name")?, &arg::<String>(args, "newName")?)?))(),
            "workspace_delete_attribute" => (|| {
                json_output(store.delete_property(&arg::<String>(args, "name")?, arg::<Option<bool>>(args, "deleteValues")?.unwrap_or(false))?)
            })(),
            "workspace_agent_property" => arg::<String>(args, "name").and_then(|name| json_output(store.agent_recipe(&name)?)),
            "workspace_save_agent_property" => (|| {
                store.save_agent_recipe(&arg::<String>(args, "name")?, &arg::<Json>(args, "config")?)?;
                json_output(())
            })(),
            "library_tags" => (|| {
                let offset = arg::<Option<usize>>(args, "offset")?.unwrap_or(0);
                let limit = arg::<Option<usize>>(args, "limit")?.unwrap_or(200).clamp(1, 1000);
                let mut tags = store.facets(&ListQuery::default())?.tags;
                tags.sort_by(|a, b| a.value.to_lowercase().cmp(&b.value.to_lowercase()));
                let total = tags.len();
                let page: Vec<Json> = tags.into_iter().skip(offset).take(limit).map(|t| json!({"name": t.value, "count": t.count})).collect();
                json_output(json!({"tags": page, "total": total}))
            })(),
            "library_retag" => (|| {
                let to: Option<String> = arg(args, "to")?;
                json_output(json!({"affected": store.retag(&arg::<Vec<String>>(args, "from")?, to.as_deref().unwrap_or(""))?}))
            })(),
            "library_metadata_details" => {
                let source = source("hash")?;
                let names: std::collections::HashMap<String, String> =
                    store.collections().unwrap_or_default().into_iter().map(|c| (c.id, c.name)).collect();
                let collections: Vec<String> = source.collections.iter().filter_map(|id| names.get(id).cloned()).collect();
                json_output(json!({"tags": source.tags, "collections": collections, "properties": source.properties}))
            }
            "library_set_property" => {
                let source = source("hash")?;
                (|| {
                    let mut properties = Map::new();
                    properties.insert(arg::<String>(args, "name")?, arg::<Json>(args, "value")?);
                    let mut patch = Map::new();
                    patch.insert("properties".into(), Json::Object(properties));
                    store.update_source(&source.id, &patch)?;
                    json_output(())
                })()
            }
            "workspace_agent_context" => {
                let source = source("hash")?;
                (|| {
                    let inputs: Vec<String> = arg(args, "inputs")?;
                    let mut context = Map::new();
                    for input in inputs.iter().take(16) {
                        let value = match input.as_str() {
                            "title" => json!(source.title()),
                            "authors" => json!(source.creators.iter().map(|c| c.display()).collect::<Vec<_>>()),
                            "year" => source.fields.get("year").cloned().unwrap_or(Json::Null),
                            "pageCount" => source.fields.get("pageCount").cloned().unwrap_or(Json::Null),
                            "abstract" => json!(source.field("abstract").unwrap_or("")),
                            "pdfText" => json!(store.leading_text(&source.id, 32768)?),
                            _ => return Err("Unknown input".into()),
                        };
                        context.insert(input.clone(), value);
                    }
                    json_output(Json::Object(context))
                })()
            }
            "workspace_apply_property_proposal" => {
                let source = source("hash")?;
                (|| {
                    store.apply_property_proposal(
                        &source.id,
                        &arg::<String>(args, "name")?,
                        &arg::<Json>(args, "value")?,
                        &arg::<Json>(args, "expectedValue")?,
                        &arg::<Json>(args, "provenance")?,
                    )?;
                    json_output(())
                })()
            }
            "workspace_fill_known_property" => (|| {
                // Deterministic copy of known metadata; existing values are kept.
                let name: String = arg(args, "name")?;
                let input: String = arg(args, "input")?;
                let (mut filled, mut skipped) = (0, 0);
                for hash in arg::<Vec<String>>(args, "hashes")?.iter().take(100) {
                    let Some(source) = store.source_by_hash(hash)? else {
                        skipped += 1;
                        continue;
                    };
                    let value = match input.as_str() {
                        "title" => json!(source.title()),
                        "authors" => json!(source.creators.iter().map(|c| c.display()).collect::<Vec<_>>().join("; ")),
                        "year" => source.fields.get("year").cloned().unwrap_or(Json::Null),
                        "pageCount" => source.fields.get("pageCount").cloned().unwrap_or(Json::Null),
                        _ => return Err("Only known document metadata can be copied".into()),
                    };
                    let current = source.properties.get(&name);
                    if value.is_null() || value == json!("") || current.is_some_and(|v| !v.is_null() && v != &json!("")) {
                        skipped += 1;
                        continue;
                    }
                    let mut properties = Map::new();
                    properties.insert(name.clone(), value);
                    let mut patch = Map::new();
                    patch.insert("properties".into(), Json::Object(properties));
                    store.update_source(&source.id, &patch)?;
                    filled += 1;
                }
                json_output(json!({"filled": filled, "skipped": skipped, "method": "Known metadata copied; no AI inference"}))
            })(),
            _ => return None,
        })
    }

    /// Links (or, for downloads, copies) a file to an existing source and re-indexes it.
    pub fn attach_file(&self, id: &str, path: &Path, root: &Path) -> Result<Source, String> {
        let source = self.store.source(id)?.ok_or("Source not found")?;
        let hash = key_index::file_hash(path)?;
        let stored = self.stored_path(path, &hash, root)?;
        let (kind, _, mime) = classify(&stored);
        let mut patch = Map::new();
        patch.insert("filePath".into(), Json::from(stored.to_string_lossy().to_string()));
        patch.insert("fileHash".into(), Json::from(hash));
        patch.insert("mime".into(), Json::from(mime));
        patch.insert("fileSize".into(), Json::from(std::fs::metadata(&stored).map(|m| m.len()).unwrap_or(0)));
        if matches!(source.kind.as_str(), "reference" | "web") {
            patch.insert("kind".into(), Json::from(kind));
        }
        let updated = self.store.update_source(id, &patch)?;
        self.store.set_index_status(id, "pending", None, 0, 0)?;
        Ok(updated)
    }

    /// Files from the system temp folder (downloads) are copied into the workspace.
    /// Keeps an image a note shows in the workspace's `media` folder, named by its content,
    /// and answers the path notes reference it by (relative, so the workspace can move).
    pub fn save_media(&self, args: &Json, bytes: &[u8], root: &Path) -> Result<Output, String> {
        let name: Option<String> = arg(args, "name")?;
        let mime: Option<String> = arg(args, "mime")?;
        let path: Option<PathBuf> = arg(args, "path")?;
        let data = match (&path, bytes.is_empty()) {
            (_, false) => bytes.to_vec(),
            (Some(path), true) => std::fs::read(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?,
            (None, true) => return Err("No image to save".into()),
        };
        let from_name = name.as_deref().map(Path::new).or(path.as_deref()).and_then(|p| p.extension()).and_then(|e| e.to_str());
        let extension = media_extension(from_name, mime.as_deref(), &data).ok_or("Not an image Key can show")?;
        use sha2::Digest;
        let hash: String = sha2::Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        let file = format!("{hash}.{extension}");
        let directory = root.join("media");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let target = directory.join(&file);
        if !target.is_file() {
            // Written aside first, so a half-written file is never shown.
            let partial = directory.join(format!(".{file}.partial"));
            std::fs::write(&partial, &data).map_err(|e| e.to_string())?;
            std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        }
        json_output(json!({"src": format!("media/{file}"), "size": data.len()}))
    }

    fn stored_path(&self, path: &Path, hash: &str, root: &Path) -> Result<PathBuf, String> {
        let temporary = path.starts_with(std::env::temp_dir()) || path.to_string_lossy().contains("/T/");
        if !temporary {
            return Ok(path.to_path_buf());
        }
        let directory = root.join("files");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let target = directory.join(format!("{hash}.{extension}"));
        std::fs::copy(path, &target).map_err(|e| e.to_string())?;
        Ok(target)
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
    pub fn begin_companion(
        &self,
        hash: &str,
        native: &NativePdfService,
        companions: &CompanionStore,
        legacy: key_library::Library,
    ) -> Option<Result<super::CompanionSnapshotDto, String>> {
        let (source, path) = self.reader_source(hash)?;
        // An open document's analysis goes first.
        self.indexer.prioritize(std::slice::from_ref(&source.id), key_index::Priority::Opened);
        self.references.focus(&source.id);
        Some((|| {
            if let Ok(snapshot) = companions.storage.snapshot(hash) {
                companions.reader_ids.lock().map_err(|_| "Reader registry poisoned")?.insert(hash.to_string());
                return Ok(snapshot);
            }
            let Reply::Document(mut document) = native.request(|reply| Request::OpenFile { id: hash.to_string(), path: path.clone(), reply })? else {
                return Err("Unexpected open reply".into());
            };
            if document.title.as_deref().unwrap_or("").is_empty() {
                document.title = Some(source.title().to_string());
            }
            let pages = document.pages.len();
            let stored = super::reference_worker::stored_analysis(&self.store, &source.id, &document);
            let generation = companions.storage.begin(hash.to_string(), document);
            companions.storage.set_document_hash(hash, generation, hash.to_string());
            companions.storage.keep_in_memory(hash, generation);
            let chunks = source.indexed_chunks.max(0) as usize;
            companions.storage.set_semantic_progress(hash, generation, "indexed", chunks, chunks.max(pages));
            // References and citations for the reader; very long documents skip it so the
            // shared PDF engine stays responsive.
            if let Some((analysis, lookups_pending)) = stored {
                super::install_stored_companion_analysis(companions.clone(), legacy, hash.to_string(), generation, analysis, lookups_pending);
            } else if pages <= 150 {
                super::begin_store_companion_analysis(companions.clone(), native.clone(), legacy, hash.to_string(), path, generation);
            } else {
                companions.storage.finish(hash, generation);
            }
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

/// The extension a note image is stored under: from its name or type, else its first bytes.
fn media_extension(name: Option<&str>, mime: Option<&str>, data: &[u8]) -> Option<&'static str> {
    const KNOWN: [&str; 8] = ["png", "jpg", "gif", "webp", "svg", "avif", "bmp", "heic"];
    let normal = |e: &str| match e.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => Some("jpg"),
        other => KNOWN.iter().copied().find(|k| *k == other),
    };
    if let Some(found) = name.and_then(normal) {
        return Some(found);
    }
    if let Some(found) = mime.and_then(|m| m.strip_prefix("image/")).map(|m| m.trim_end_matches("+xml")).and_then(normal) {
        return Some(found);
    }
    match data {
        [0x89, b'P', b'N', b'G', ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        _ => None,
    }
}

#[cfg(test)]
mod media_tests {
    use super::media_extension;

    #[test]
    fn picks_the_extension_from_name_type_or_bytes() {
        assert_eq!(media_extension(Some("JPEG"), None, b""), Some("jpg"));
        assert_eq!(media_extension(None, Some("image/svg+xml"), b""), Some("svg"));
        assert_eq!(media_extension(Some("exe"), Some("text/plain"), b"\x89PNG\r\n"), Some("png"));
        assert_eq!(media_extension(None, None, b"hello"), None);
    }
}
