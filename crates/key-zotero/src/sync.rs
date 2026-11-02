// Import and sync share one pass: Zotero now, Key now and what Key last took from Zotero
// (the base, in zotero-sync.sqlite) are compared value by value. A value changed only in
// Zotero is applied, one changed only in Key is kept, and one changed in both keeps Key's
// version and is reported. Items deleted in Zotero go to Key's trash; notes are deleted
// only when they were not edited in Key; nothing deleted in Key is brought back.
use crate::{
    Conflict, ImportOptions, ImportReport, ORIGIN, Progress, Result, html,
    snapshot::{Snapshot, Stamp, ZItem},
    state::{State, Tracked},
};
use key_store::{Source, SourceInput, Store};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// A one-time import: adds and updates, never trashes or deletes.
    Import,
    /// Also follows deletions in Zotero.
    Sync,
}

const FILE_FIELDS: [&str; 3] = ["f:filePath", "f:mime", "f:fileSize"];
const MAX_REPORTED_CONFLICTS: usize = 200;

pub fn run(store: &Store, options: &ImportOptions, mode: Mode, progress: &dyn Fn(Progress)) -> Result<ImportReport> {
    let data_dir = options.data_dir.clone().or_else(crate::default_data_dir).ok_or("No Zotero library found. Choose its data folder (it contains zotero.sqlite).")?;
    progress(Progress::new("reading", 0, 0));
    let snapshot = Snapshot::load(&data_dir)?;
    let mut state = State::open(store.root())?;
    let mut run = Run {
        store,
        options,
        mode,
        snapshot: &snapshot,
        report: ImportReport { data_dir: data_dir.clone(), ..Default::default() },
        collection_ids: HashMap::new(),
        collection_keys: HashMap::new(),
        source_of: HashMap::new(),
        item_changes: HashMap::new(),
        note_changes: HashMap::new(),
        collection_changes: HashMap::new(),
    };
    let tracked_items = state.all("item")?;
    let tracked_notes = state.all("note")?;
    let tracked_collections = state.all("collection")?;
    let scope = run.scope();
    run.known_collections(&tracked_collections)?;
    if options.mirror_collections {
        run.collections(&scope, &tracked_collections)?;
    }
    run.items(&scope, &tracked_items, &state, progress)?;
    if options.notes {
        run.notes(&scope, &tracked_notes, progress)?;
    }
    if options.annotations {
        run.annotations(&tracked_notes)?;
    }
    if mode == Mode::Sync {
        run.deleted_notes(&tracked_notes)?;
        if options.mirror_collections {
            run.deleted_collections(&tracked_collections)?;
        }
    }
    progress(Progress::new("saving", 0, 0));
    state.save("item", &run.item_changes)?;
    state.save("note", &run.note_changes)?;
    state.save("collection", &run.collection_changes)?;
    let mut saved = options.clone();
    saved.data_dir = Some(data_dir);
    state.set_meta("options", &serde_json::to_string(&saved).map_err(|e| e.to_string())?)?;
    state.set_meta("stamp", &serde_json::to_string(&snapshot.stamp).map_err(|e| e.to_string())?)?;
    state.set_meta("lastRun", &key_store::now_ms().to_string())?;
    run.report.conflict_count = run.report.conflict_count.max(run.report.conflicts.len());
    let report = run.report;
    drop(snapshot);
    // The copy is only needed while the import dialog or a run is open.
    Snapshot::forget();
    Ok(report)
}

/// The options of the last import or sync, and the file stamp it read.
pub fn last_run(store: &Store) -> Result<(Option<ImportOptions>, Option<Stamp>, Option<i64>)> {
    let state = State::open(store.root())?;
    Ok((
        state.meta("options").and_then(|o| serde_json::from_str(&o).ok()),
        state.meta("stamp").and_then(|s| serde_json::from_str(&s).ok()),
        state.meta("lastRun").and_then(|t| t.parse().ok()),
    ))
}

/// Which Zotero items and collections an import covers.
struct Scope {
    /// None for the whole library.
    collections: Option<HashSet<i64>>,
}

impl Scope {
    fn covers(&self, snapshot: &Snapshot, item: i64) -> bool {
        match &self.collections {
            None => true,
            Some(allowed) => snapshot.collections_of.get(&item).is_some_and(|c| c.iter().any(|c| allowed.contains(c))),
        }
    }
    fn mirrors(&self, collection: i64) -> bool {
        self.collections.as_ref().is_none_or(|c| c.contains(&collection))
    }
}

struct Run<'a> {
    store: &'a Store,
    options: &'a ImportOptions,
    mode: Mode,
    snapshot: &'a Snapshot,
    report: ImportReport,
    /// Zotero collection id → Key collection id, for mirrored collections.
    collection_ids: HashMap<i64, String>,
    /// Key collection id → Zotero collection key, for every collection that came from
    /// Zotero (this run or before), so items keep their filing outside the chosen scope.
    collection_keys: HashMap<String, String>,
    /// Zotero item id → Key source id, for every item that is in Key after this run.
    source_of: HashMap<i64, String>,
    item_changes: HashMap<String, Option<Tracked>>,
    note_changes: HashMap<String, Option<Tracked>>,
    collection_changes: HashMap<String, Option<Tracked>>,
}

impl Run<'_> {
    fn scope(&self) -> Scope {
        let snapshot = self.snapshot;
        let collections = if let Some(keys) = &self.options.collection_keys {
            Some(snapshot.collections.iter().filter(|c| keys.contains(&c.key)).map(|c| c.id).collect())
        } else {
            self.options.collections.as_ref().map(|names| {
                let roots: Vec<i64> = snapshot.collections.iter().filter(|c| names.contains(&c.name)).map(|c| c.id).collect();
                snapshot.with_descendants(&roots).into_iter().collect()
            })
        };
        Scope { collections }
    }

    fn conflict(&mut self, title: &str, what: &str, detail: String) {
        self.report.conflict_count += 1;
        if self.report.conflicts.len() < MAX_REPORTED_CONFLICTS {
            self.report.conflicts.push(Conflict { title: title.to_string(), what: what.to_string(), detail });
        }
    }

    // ── Collections ─────────────────────────────────────

    fn known_collections(&mut self, tracked: &HashMap<String, Tracked>) -> Result<()> {
        for collection in self.store.collections()? {
            let key = tracked
                .iter()
                .find(|(_, t)| t.id.as_deref() == Some(collection.id.as_str()))
                .map(|(key, _)| key.clone())
                .or_else(|| collection.origin_key.as_deref().and_then(|o| o.strip_prefix("zotero:")).map(String::from));
            if let Some(key) = key {
                self.collection_keys.insert(collection.id, key);
            }
        }
        Ok(())
    }

    fn collection_id(&self, key: &str) -> Option<String> {
        self.collection_keys.iter().find(|(_, k)| *k == key).map(|(id, _)| id.clone())
    }

    fn collections(&mut self, scope: &Scope, tracked: &HashMap<String, Tracked>) -> Result<()> {
        let existing: HashMap<String, key_store::Collection> = self.store.collections()?.into_iter().map(|c| (c.id.clone(), c)).collect();
        let by_origin: HashMap<String, String> = existing.values().filter_map(|c| Some((c.origin_key.clone()?, c.id.clone()))).collect();
        for zc in &self.snapshot.collections {
            if !scope.mirrors(zc.id) {
                continue;
            }
            let parent_key = zc.parent.filter(|p| scope.mirrors(*p)).and_then(|p| self.snapshot.collection(p)).map(|p| p.key.clone());
            let parent_id = zc.parent.and_then(|p| self.collection_ids.get(&p).cloned());
            let z = json!({"name": zc.name, "parent": parent_key});
            let origin = format!("zotero:{}", zc.key);
            let known = tracked.get(&zc.key);
            if known.is_some_and(|t| t.id.is_none()) {
                continue;
            }
            let id = known.and_then(|t| t.id.clone()).or_else(|| by_origin.get(&origin).cloned());
            let Some(id) = id else {
                let created = self.store.create_collection(&zc.name, parent_id.as_deref(), Some(&origin))?;
                self.report.collections += 1;
                self.track_collection(zc.id, &zc.key, created.id, z);
                continue;
            };
            let Some(current) = existing.get(&id) else {
                // Deleted in Key: it stays deleted.
                self.collection_changes.insert(zc.key.clone(), Some(Tracked { id: None, base: z, ..Default::default() }));
                continue;
            };
            let base = known.map(|t| &t.base);
            let current_parent = current.parent_id.as_ref().and_then(|p| self.collection_keys.get(p).cloned().or_else(|| Some(format!("key:{p}"))));
            let name = decide(base.map(|b| &b["name"]), &z["name"], &json!(current.name), base.is_none());
            let parent = decide(base.map(|b| &b["parent"]), &z["parent"], &json!(current_parent), base.is_none());
            if name == Decision::Take {
                self.store.update_collection(&id, Some(&zc.name), None)?;
            } else if name == Decision::Conflict {
                self.conflict(&current.name, "collection name", format!("Kept the name in Key; Zotero calls it “{}”.", zc.name));
            }
            if parent == Decision::Take {
                self.store.update_collection(&id, None, Some(parent_id.as_deref()))?;
            } else if parent == Decision::Conflict {
                self.conflict(&current.name, "collection place", "Kept where it is in Key; it moved in Zotero.".into());
            }
            self.track_collection(zc.id, &zc.key, id, z);
        }
        Ok(())
    }

    fn track_collection(&mut self, zotero_id: i64, key: &str, id: String, base: Json) {
        self.collection_ids.insert(zotero_id, id.clone());
        self.collection_keys.insert(id.clone(), key.to_string());
        self.collection_changes.insert(key.to_string(), Some(Tracked { id: Some(id), base, ..Default::default() }));
    }

    fn deleted_collections(&mut self, tracked: &HashMap<String, Tracked>) -> Result<()> {
        let alive: HashSet<&str> = self.snapshot.collections.iter().map(|c| c.key.as_str()).collect();
        let mut gone: Vec<(String, String)> =
            tracked.iter().filter(|(key, t)| t.id.is_some() && !alive.contains(key.as_str())).map(|(k, t)| (k.clone(), t.id.clone().unwrap())).collect();
        // Children first: a collection is removed only once it is empty.
        loop {
            let collections = self.store.collections()?;
            let mut progressed = false;
            gone.retain(|(key, id)| {
                let Some(current) = collections.iter().find(|c| &c.id == id) else {
                    self.collection_changes.insert(key.clone(), None);
                    progressed = true;
                    return false;
                };
                let has_children = collections.iter().any(|c| c.parent_id.as_deref() == Some(id));
                if current.source_count == 0 && !has_children {
                    if self.store.delete_collection(id).is_ok() {
                        self.report.collections_deleted += 1;
                        self.collection_changes.insert(key.clone(), None);
                        progressed = true;
                        return false;
                    }
                }
                true
            });
            if !progressed || gone.is_empty() {
                break;
            }
        }
        for (key, id) in gone {
            let name = self.store.collections()?.into_iter().find(|c| c.id == id).map(|c| c.name).unwrap_or_default();
            self.conflict(&name, "collection", "Deleted in Zotero; kept in Key because it holds sources added in Key.".into());
            self.collection_changes.insert(key, Some(Tracked { id: None, base: Json::Null, ..Default::default() }));
        }
        Ok(())
    }

    // ── Items ───────────────────────────────────────────

    fn items(&mut self, scope: &Scope, tracked: &HashMap<String, Tracked>, state: &State, progress: &dyn Fn(Progress)) -> Result<()> {
        let snapshot = self.snapshot;
        let index = self.store.origin_index(ORIGIN)?;
        // Sources from the first importer have no base. It wrote every source in one
        // transaction with the same timestamp; a different one means it was edited in Key.
        let legacy_time = if tracked.is_empty() && state.meta("lastRun").is_none() { most_common(index.values().map(|(_, t)| *t)) } else { None };
        // Standalone files (a PDF dropped into Zotero without a parent item) are items too.
        let standalone: Vec<ZItem> = snapshot
            .attachments
            .iter()
            .filter(|a| a.parent.is_none() && a.path.is_some())
            .filter_map(|a| Some(ZItem { id: a.id, key: snapshot.key_of.get(&a.id)?.clone(), type_name: "document".into(), added: snapshot.added_of.get(&a.id).cloned().unwrap_or_default() }))
            .collect();
        let files = self.files();
        let candidates: Vec<&ZItem> = snapshot
            .items
            .iter()
            .chain(&standalone)
            .filter(|item| scope.covers(snapshot, item.id) || tracked.get(&item.key).is_some_and(|t| t.id.is_some()))
            .collect();
        let total = candidates.len();
        let mut new: Vec<(SourceInput, &ZItem, Map<String, Json>)> = Vec::new();
        for (done, item) in candidates.into_iter().enumerate() {
            if done % 250 == 0 {
                progress(Progress::new("items", done, total));
            }
            let known = tracked.get(&item.key);
            if known.is_some_and(|t| t.id.is_none()) {
                self.report.kept_deleted += 1;
                continue;
            }
            let input = self.input(item, files.get(&item.id).cloned());
            let mut z = view_of_input(&input, &self.zotero_collections(item.id));
            let base = known.map(|t| &t.base);
            if !self.options.attachments {
                // Leaving files out of this import keeps the ones Key already has.
                for name in FILE_FIELDS.iter().chain(&["kind"]) {
                    match base.and_then(|b| b["z"].get(*name)) {
                        Some(value) => z.insert(name.to_string(), value.clone()),
                        None => z.remove(*name),
                    };
                }
            }
            let id = known.and_then(|t| t.id.clone()).or_else(|| index.get(&item.key).map(|(id, _)| id.clone()));
            let Some(id) = id else {
                new.push((input, item, z));
                continue;
            };
            let restore = known.is_some_and(|t| t.trashed_by_sync);
            // Unchanged in Zotero since the last run: nothing to do.
            if !restore && base.is_some_and(|b| b["z"] == Json::Object(z.clone())) {
                self.report.unchanged += 1;
                self.source_of.insert(item.id, id);
                continue;
            }
            let Some(current) = self.store.source(&id)? else {
                self.report.kept_deleted += 1;
                self.item_changes.insert(item.key.clone(), Some(Tracked { id: None, base: Json::Null, ..Default::default() }));
                continue;
            };
            let legacy_edited = base.is_none() && legacy_time.is_some_and(|t| current.updated_at != t);
            let updated = self.merge(&current, &z, base, legacy_edited)?;
            if restore && updated.trashed_at.is_some() {
                self.store.trash(std::slice::from_ref(&id), false)?;
                self.report.restored += 1;
            }
            self.count_file(&input);
            let k = view_of_source(&updated, &z, base, &self.collection_keys);
            self.source_of.insert(item.id, id.clone());
            self.item_changes.insert(item.key.clone(), Some(Tracked { id: Some(id), base: json!({"z": z, "k": k}), trashed_by_sync: false }));
        }
        progress(Progress::new("items", total, total));
        if !new.is_empty() {
            for (input, _, _) in &new {
                self.count_file(input);
            }
            let ids = self.store.insert_sources(new.iter().map(|(input, _, _)| input.clone()).collect())?;
            self.report.added += ids.len();
            for (id, (_, item, z)) in ids.into_iter().zip(new) {
                let current = self.store.source(&id)?.ok_or("Imported source is missing")?;
                let k = view_of_source(&current, &z, None, &self.collection_keys);
                self.source_of.insert(item.id, id.clone());
                self.item_changes.insert(item.key.clone(), Some(Tracked { id: Some(id), base: json!({"z": z, "k": k}), trashed_by_sync: false }));
            }
        }
        self.report.items = self.report.added + self.report.updated + self.report.unchanged;
        self.report.skipped = snapshot.items.len() + standalone.len() - total;

        if self.mode == Mode::Sync {
            // Tracked items that are no longer in Zotero (deleted, or in Zotero's trash).
            let alive: HashSet<&str> = snapshot.items.iter().chain(&standalone).map(|i| i.key.as_str()).collect();
            for (key, t) in tracked {
                let Some(id) = t.id.as_ref().filter(|_| !alive.contains(key.as_str()) && !t.trashed_by_sync) else { continue };
                if let Some(current) = self.store.source(id)? {
                    if current.trashed_at.is_none() {
                        self.store.trash(std::slice::from_ref(id), true)?;
                        self.report.trashed += 1;
                        self.item_changes.insert(key.clone(), Some(Tracked { trashed_by_sync: true, ..t.clone() }));
                    }
                }
            }
        }
        Ok(())
    }

    /// The best file of each item: a PDF, then a web snapshot or media, then anything.
    fn files(&self) -> HashMap<i64, (std::path::PathBuf, String)> {
        let mut best: HashMap<i64, (std::path::PathBuf, String, i32)> = HashMap::new();
        for attachment in &self.snapshot.attachments {
            let Some(path) = attachment.path.clone() else { continue };
            let rank = match attachment.content_type.as_str() {
                "application/pdf" => 3,
                "text/html" => 2,
                t if t.starts_with("video/") || t.starts_with("audio/") || t.starts_with("image/") => 2,
                _ => 1,
            };
            let owner = attachment.parent.unwrap_or(attachment.id);
            if best.get(&owner).is_none_or(|(_, _, r)| rank > *r) {
                best.insert(owner, (path, attachment.content_type.clone(), rank));
            }
        }
        best.into_iter().map(|(k, (p, t, _))| (k, (p, t))).collect()
    }

    fn input(&self, item: &ZItem, file: Option<(std::path::PathBuf, String)>) -> SourceInput {
        let snapshot = self.snapshot;
        let mut input = crate::map_item(&item.type_name, snapshot.fields.get(&item.id));
        input.creators = snapshot.creators.get(&item.id).cloned().unwrap_or_default();
        input.tags = snapshot.tags.get(&item.id).cloned().unwrap_or_default();
        input.collections = self.zotero_collections(item.id).iter().filter_map(|key| self.collection_id(key)).collect();
        input.origin = Some(ORIGIN.into());
        input.origin_key = Some(item.key.clone());
        input.added_at = crate::parse_zotero_date(&item.added);
        if self.options.attachments {
            crate::attach(&mut input, file);
            if input.fields.get("title").is_none_or(|t| t.as_str().unwrap_or("").is_empty()) {
                if let Some(name) = input.fields.get("filePath").and_then(Json::as_str).and_then(|p| std::path::Path::new(p).file_stem()) {
                    input.fields.insert("title".into(), Json::from(name.to_string_lossy().to_string()));
                }
            }
        } else {
            crate::attach(&mut input, None);
        }
        input
    }

    fn count_file(&mut self, input: &SourceInput) {
        if let Some(path) = input.fields.get("filePath").and_then(Json::as_str) {
            if std::path::Path::new(path).is_file() {
                self.report.linked_files += 1;
            } else {
                self.report.missing_files += 1;
            }
        }
    }

    fn zotero_collections(&self, item: i64) -> Vec<String> {
        let mut keys: Vec<String> = self
            .snapshot
            .collections_of
            .get(&item)
            .into_iter()
            .flatten()
            .filter_map(|c| self.snapshot.collection(*c).map(|c| c.key.clone()))
            .filter(|key| self.collection_keys.values().any(|k| k == key))
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    /// Applies Zotero's changes to a source, keeping Key's own edits.
    fn merge(&mut self, current: &Source, z: &Map<String, Json>, base: Option<&Json>, legacy_edited: bool) -> Result<Source> {
        let k = view_of_source(current, z, base, &self.collection_keys);
        let bz = base.and_then(|b| b.get("z")).and_then(Json::as_object);
        let bk = base.and_then(|b| b.get("k")).and_then(Json::as_object);
        let mut patch = Map::new();
        let mut properties = Map::new();
        let names: std::collections::BTreeSet<&String> = z.keys().chain(bz.into_iter().flat_map(|b| b.keys())).collect();
        let title = current.title().to_string();
        for name in names {
            let zv = z.get(name).unwrap_or(&Json::Null);
            let kv = k.get(name).unwrap_or(&Json::Null);
            if name == "tags" || name == "collections" {
                let merged = merge_sets(bz.and_then(|b| b.get(name)), zv, kv);
                if !same(&merged, kv) {
                    if name == "tags" {
                        patch.insert("tags".into(), merged);
                    } else {
                        self.apply_membership(&current.id, kv, &merged)?;
                    }
                }
                continue;
            }
            // Did Zotero change it since the last run, and did Key?
            let decision = match (bz, bk) {
                (Some(bz), Some(bk)) => {
                    let zotero_changed = !same(bz.get(name).unwrap_or(&Json::Null), zv);
                    let key_changed = !same(bk.get(name).unwrap_or(&Json::Null), kv);
                    match (zotero_changed, key_changed) {
                        _ if same(zv, kv) => Decision::Keep,
                        (false, _) => Decision::Keep,
                        (true, false) => Decision::Take,
                        (true, true) => Decision::Conflict,
                    }
                }
                _ if same(zv, kv) => Decision::Keep,
                _ if legacy_edited => Decision::Conflict,
                _ => Decision::Take,
            };
            match decision {
                Decision::Keep => {}
                Decision::Take => {
                    if let Some(field) = name.strip_prefix("f:") {
                        patch.insert(field.to_string(), zv.clone());
                    } else if let Some(property) = name.strip_prefix("p:") {
                        properties.insert(property.to_string(), zv.clone());
                    } else {
                        patch.insert(name.clone(), zv.clone());
                    }
                }
                Decision::Conflict => {
                    let label = name.trim_start_matches("f:").trim_start_matches("p:");
                    self.conflict(&title, label, format!("Kept Key’s value; Zotero now has {}.", short(zv)));
                }
            }
        }
        if !properties.is_empty() {
            patch.insert("properties".into(), Json::Object(properties));
        }
        if patch.is_empty() {
            self.report.unchanged += 1;
            return Ok(self.store.source(&current.id)?.unwrap_or_else(|| current.clone()));
        }
        self.report.updated += 1;
        self.store.update_source(&current.id, &patch)
    }

    fn apply_membership(&mut self, id: &str, current: &Json, merged: &Json) -> Result<()> {
        let as_set = |v: &Json| -> HashSet<String> { v.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect() };
        let (before, after) = (as_set(current), as_set(merged));
        for key in after.difference(&before) {
            if let Some(collection) = self.collection_id(key) {
                self.store.set_membership(&collection, &[id.to_string()], true)?;
            }
        }
        for key in before.difference(&after) {
            if let Some(collection) = self.collection_id(key) {
                self.store.set_membership(&collection, &[id.to_string()], false)?;
            }
        }
        Ok(())
    }

    // ── Notes and annotations ───────────────────────────

    fn resolver(&self) -> impl Fn(Option<&str>, Option<&str>) -> Option<String> + '_ {
        let id_of: HashMap<&str, i64> = self.snapshot.key_of.iter().map(|(id, key)| (key.as_str(), *id)).collect();
        let parent_of: HashMap<i64, i64> = self.snapshot.attachments.iter().filter_map(|a| Some((a.id, a.parent?))).collect();
        move |attachment: Option<&str>, item: Option<&str>| {
            let via_attachment = attachment.and_then(|k| id_of.get(k)).map(|id| parent_of.get(id).copied().unwrap_or(*id));
            via_attachment
                .and_then(|id| self.source_of.get(&id))
                .or_else(|| item.and_then(|k| id_of.get(k)).and_then(|id| self.source_of.get(id)))
                .cloned()
        }
    }

    fn notes(&mut self, scope: &Scope, tracked: &HashMap<String, Tracked>, progress: &dyn Fn(Progress)) -> Result<()> {
        let snapshot = self.snapshot;
        let total = snapshot.notes.len();
        let mut converted = Vec::new();
        {
            let resolve = self.resolver();
            for (done, note) in snapshot.notes.iter().enumerate() {
                if done % 250 == 0 {
                    progress(Progress::new("notes", done, total));
                }
                let source = match note.parent {
                    Some(parent) => match self.source_of.get(&parent) {
                        Some(source) => Some(source.clone()),
                        None => continue,
                    },
                    // A standalone note follows the import's collections.
                    None if scope.covers(snapshot, note.id) || tracked.get(&note.key).is_some_and(|t| t.id.is_some()) => None,
                    None => continue,
                };
                let body = html::html_to_markdown(&note.html, &resolve);
                converted.push((note.key.clone(), source, note.title.clone(), body, html::html_to_text(&note.html)));
            }
        }
        progress(Progress::new("notes", total, total));
        for (key, source, title, body, legacy) in converted {
            self.note(&key, &format!("zotero:{key}"), source.as_deref(), &title, &body, Some(&legacy), tracked)?;
        }
        Ok(())
    }

    /// Each PDF's Zotero annotations, in page order, as one note of quote blocks on its source.
    fn annotations(&mut self, tracked: &HashMap<String, Tracked>) -> Result<()> {
        let snapshot = self.snapshot;
        let mut groups: BTreeMap<i64, Vec<&crate::snapshot::ZAnnotation>> = BTreeMap::new();
        for annotation in &snapshot.annotations {
            groups.entry(annotation.attachment).or_default().push(annotation);
        }
        let parent_of: HashMap<i64, Option<i64>> = snapshot.attachments.iter().map(|a| (a.id, a.parent)).collect();
        for (attachment, annotations) in groups {
            let Some(owner) = parent_of.get(&attachment).map(|p| p.unwrap_or(attachment)) else { continue };
            let Some(source) = self.source_of.get(&owner).cloned() else { continue };
            let Some(key) = snapshot.key_of.get(&attachment) else { continue };
            let body = annotations_markdown(&source, &annotations);
            self.report.annotations += annotations.len();
            self.note(&format!("annotations:{key}"), &format!("zotero:annotations:{key}"), Some(&source), "Zotero annotations", &body, None, tracked)?;
        }
        Ok(())
    }

    /// Brings one Zotero note into Key, keeping edits made to it in Key.
    #[allow(clippy::too_many_arguments)]
    fn note(&mut self, key: &str, origin: &str, source: Option<&str>, title: &str, body: &str, legacy: Option<&str>, tracked: &HashMap<String, Tracked>) -> Result<()> {
        let known = tracked.get(key);
        if known.is_some_and(|t| t.id.is_none()) {
            self.note_changes.insert(key.to_string(), known.cloned());
            return Ok(());
        }
        let base_body = known.and_then(|t| t.base.get("body")).and_then(Json::as_str);
        let base = json!({"body": body});
        let current = match known.and_then(|t| t.id.as_deref()) {
            Some(id) => match self.store.note(id)? {
                Some(note) => Some(note),
                None => {
                    // Deleted in Key: it stays deleted.
                    self.note_changes.insert(key.to_string(), Some(Tracked { id: None, base, ..Default::default() }));
                    return Ok(());
                }
            },
            None => self.store.note_by_origin(origin)?,
        };
        let Some(current) = current else {
            if body.trim().is_empty() {
                return Ok(());
            }
            let note = self.store.save_note(None, source, title, body, Some(origin))?;
            self.report.notes += 1;
            self.note_changes.insert(key.to_string(), Some(Tracked { id: Some(note.id), base, ..Default::default() }));
            return Ok(());
        };
        if current.source_id.as_deref() != source {
            self.store.set_note_source(&current.id, source)?;
        }
        let edited_in_key = match base_body {
            Some(b) => current.body != b,
            // Imported before bases were kept: unedited if it still reads as the importer wrote it.
            None => current.body != body && legacy.is_none_or(|l| current.body != l),
        };
        if current.body == body {
        } else if !edited_in_key {
            self.store.save_note(Some(&current.id), source, title, body, Some(origin))?;
            self.report.notes_updated += 1;
        } else if base_body != Some(body) {
            // Changed in both: Key's text stays, Zotero's arrives beside it.
            let label = if title.is_empty() { "Zotero note".to_string() } else { title.to_string() };
            self.store.save_note(None, source, &format!("{label} (Zotero version)"), body, Some(&format!("{origin}:zotero-version")))?;
            self.conflict(&label, "note", "Edited in Key and in Zotero; Zotero’s version was saved as a separate note.".into());
        }
        self.note_changes.insert(key.to_string(), Some(Tracked { id: Some(current.id), base, ..Default::default() }));
        Ok(())
    }

    /// Notes deleted in Zotero go in Key too, unless they were edited in Key.
    fn deleted_notes(&mut self, tracked: &HashMap<String, Tracked>) -> Result<()> {
        let snapshot = self.snapshot;
        let mut alive: HashSet<String> = snapshot.notes.iter().map(|n| n.key.clone()).collect();
        if self.options.annotations {
            for annotation in &snapshot.annotations {
                if let Some(key) = snapshot.key_of.get(&annotation.attachment) {
                    alive.insert(format!("annotations:{key}"));
                }
            }
        } else {
            alive.extend(tracked.keys().filter(|k| k.starts_with("annotations:")).cloned());
        }
        for (key, t) in tracked {
            let Some(id) = t.id.as_deref().filter(|_| !alive.contains(key)) else { continue };
            let Some(current) = self.store.note(id)? else {
                self.note_changes.insert(key.clone(), None);
                continue;
            };
            if t.base.get("body").and_then(Json::as_str) == Some(current.body.as_str()) {
                self.store.delete_note(id)?;
                self.report.notes_deleted += 1;
                self.note_changes.insert(key.clone(), None);
            } else {
                let title = if current.title.is_empty() { "Note".to_string() } else { current.title.clone() };
                self.conflict(&title, "note", "Deleted in Zotero; kept in Key because it was edited here.".into());
                self.note_changes.insert(key.clone(), Some(Tracked { id: None, base: Json::Null, ..Default::default() }));
            }
        }
        Ok(())
    }
}

fn annotations_markdown(source: &str, annotations: &[&crate::snapshot::ZAnnotation]) -> String {
    let mut blocks = Vec::new();
    for a in annotations {
        let page = a.page_index.map(|p| format!("p. {}", p + 1));
        match a.kind {
            1 | 5 if !a.text.trim().is_empty() => {
                blocks.push(html::quote_block(Some(source), a.page_index, html::color_name(&a.color), &html::paragraph(a.text.trim())));
            }
            3 | 4 => blocks.push(format!("*{} annotation{}*", if a.kind == 3 { "Image" } else { "Drawing" }, page.as_ref().map(|p| format!(" on {p}")).unwrap_or_default())),
            _ => {}
        }
        if !a.comment.trim().is_empty() {
            let comment = html::paragraph(a.comment.trim());
            // A note or text annotation has only its comment; say where it is.
            blocks.push(match (a.kind, &page) {
                (2 | 6, Some(page)) => format!("**{page}:** {comment}"),
                _ => comment,
            });
        }
    }
    blocks.join("\n\n")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
    Keep,
    Take,
    Conflict,
}

/// A three-way decision for one value; without a base, Zotero's value is taken unless
/// Key's differs and was edited.
fn decide(base: Option<&Json>, zotero: &Json, key: &Json, legacy: bool) -> Decision {
    if same(zotero, key) {
        return Decision::Keep;
    }
    match base {
        Some(base) if same(base, key) => Decision::Take,
        Some(base) if same(base, zotero) => Decision::Keep,
        Some(_) => Decision::Conflict,
        None if legacy => Decision::Conflict,
        None => Decision::Take,
    }
}

/// Zotero's additions and removals since the base, applied to Key's set.
fn merge_sets(base: Option<&Json>, zotero: &Json, key: &Json) -> Json {
    let list = |v: Option<&Json>| -> Vec<String> { v.and_then(Json::as_array).into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect() };
    let (base, zotero, mut merged) = (list(base), list(Some(zotero)), list(Some(key)));
    let lower = |s: &String| s.to_lowercase();
    for added in zotero.iter().filter(|z| !base.iter().any(|b| lower(b) == lower(z))) {
        if !merged.iter().any(|m| lower(m) == lower(added)) {
            merged.push(added.clone());
        }
    }
    for removed in base.iter().filter(|b| !zotero.iter().any(|z| lower(z) == lower(b))) {
        merged.retain(|m| lower(m) != lower(removed));
    }
    Json::from(merged)
}

/// Equal as stored values: missing, null and empty text are the same; numbers by value.
fn same(a: &Json, b: &Json) -> bool {
    let empty = |v: &Json| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()) || v.as_array().is_some_and(Vec::is_empty);
    match (a, b) {
        _ if empty(a) && empty(b) => true,
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::String(x), Json::String(y)) => x.trim() == y.trim(),
        (Json::Array(x), Json::Array(y)) if x.iter().all(Json::is_string) && y.iter().all(Json::is_string) => {
            // Tags and collection keys are sets.
            let mut x: Vec<String> = x.iter().filter_map(|v| v.as_str().map(str::to_lowercase)).collect();
            let mut y: Vec<String> = y.iter().filter_map(|v| v.as_str().map(str::to_lowercase)).collect();
            x.sort();
            y.sort();
            x == y
        }
        _ => a == b,
    }
}

fn short(value: &Json) -> String {
    let text = match value {
        Json::String(s) => s.clone(),
        Json::Null => return "no value".into(),
        other => other.to_string(),
    };
    let clipped: String = text.chars().take(80).collect();
    format!("“{}{}”", clipped, if clipped.len() < text.len() { "…" } else { "" })
}

fn most_common(values: impl Iterator<Item = i64>) -> Option<i64> {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for v in values {
        *counts.entry(v).or_default() += 1;
    }
    counts.into_iter().max_by_key(|(v, c)| (*c, *v)).map(|(v, _)| v)
}

/// The values Zotero gives a source, flattened: "kind", "creators", "tags", "collections"
/// (Zotero collection keys), "f:<field>" and "p:<property>".
fn view_of_input(input: &SourceInput, collections: &[String]) -> Map<String, Json> {
    let mut view = Map::new();
    view.insert("kind".into(), Json::from(input.kind.clone()));
    view.insert("creators".into(), serde_json::to_value(&input.creators).unwrap_or_default());
    view.insert("tags".into(), Json::from(input.tags.clone()));
    view.insert("collections".into(), Json::from(collections.to_vec()));
    for (name, value) in &input.fields {
        view.insert(format!("f:{name}"), value.clone());
    }
    for (name, value) in &input.properties {
        view.insert(format!("p:{name}"), value.clone());
    }
    view
}

/// The same values as Key has them now, for the names Zotero gives (or gave).
fn view_of_source(source: &Source, z: &Map<String, Json>, base: Option<&Json>, collection_keys: &HashMap<String, String>) -> Map<String, Json> {
    let mut view = Map::new();
    let names = z.keys().chain(base.and_then(|b| b.get("z")).and_then(Json::as_object).into_iter().flat_map(|b| b.keys()));
    for name in names {
        let value = match name.as_str() {
            "kind" => Json::from(source.kind.clone()),
            "creators" => serde_json::to_value(&source.creators).unwrap_or_default(),
            "tags" => Json::from(source.tags.clone()),
            "collections" => {
                let mut keys: Vec<String> = source.collections.iter().filter_map(|c| collection_keys.get(c).cloned()).collect();
                keys.sort();
                Json::from(keys)
            }
            other => match (other.strip_prefix("f:"), other.strip_prefix("p:")) {
                (Some(field), _) => source.fields.get(field).cloned().unwrap_or(Json::Null),
                (_, Some(property)) => source.properties.get(property).cloned().unwrap_or(Json::Null),
                _ => Json::Null,
            },
        };
        view.insert(name.clone(), value);
    }
    view
}
