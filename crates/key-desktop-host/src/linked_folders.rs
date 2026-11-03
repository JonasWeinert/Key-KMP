// Host side of linked folders (see key-store's linked.rs for the design). The app's main
// process watches tracked folders and calls `store_linked_sync` with what changed; these
// commands list, read and write the files and turn tracking and indexing on and off.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_index::Priority;
use serde_json::{Value as Json, json};
use std::path::{Path, PathBuf};

pub fn dispatch(library: &Library, command: &str, args: &Json, root: &Path) -> Option<Result<Output, String>> {
    let store = &library.store;
    let result = match command {
        "store_linked_folders" => store.linked_folders().and_then(json_output),
        "store_linked_link" => (|| {
            let path: PathBuf = arg(args, "path")?;
            let folder = store.link_folder(&path)?;
            store.sync_linked_folder(&folder.id, &[])?;
            json_output(store.linked_folder(&folder.id)?)
        })(),
        "store_linked_set" => (|| {
            let id: String = arg(args, "id")?;
            let tracked: Option<bool> = arg(args, "tracked")?;
            let indexed: Option<bool> = arg(args, "indexed")?;
            let folder = store.set_linked_folder(&id, tracked, indexed)?;
            // Turning tracking on lists the folder now; indexing starts in the background.
            if folder.tracked && (tracked == Some(true) || indexed == Some(true)) {
                store.sync_linked_folder(&id, &[])?;
            }
            library.indexer.wake();
            json_output(store.linked_folder(&id)?)
        })(),
        "store_linked_unlink" => arg::<String>(args, "id").and_then(|id| json_output(store.unlink_folder(&id)?)),
        // From the watcher: the relative paths that changed (none: the whole folder).
        "store_linked_sync" => (|| {
            let id: String = arg(args, "id")?;
            let paths: Option<Vec<String>> = arg(args, "paths")?;
            let report = store.sync_linked_folder(&id, &paths.unwrap_or_default())?;
            if report.any() {
                library.indexer.wake();
            }
            json_output(report)
        })(),
        "store_linked_entries" => (|| {
            let folder: String = arg(args, "folderId")?;
            let dir: Option<String> = arg(args, "dir")?;
            json_output(store.linked_entries(&folder, &dir.unwrap_or_default())?)
        })(),
        "store_linked_file" => arg::<String>(args, "id").and_then(|id| json_output(store.linked_file(&id)?)),
        "store_linked_file_at" => (|| json_output(store.linked_file_at(&arg::<String>(args, "folderId")?, &arg::<String>(args, "path")?)?))(),
        "store_linked_read" => arg::<String>(args, "id").and_then(|id| {
            let (file, text) = store.read_linked_text(&id)?;
            json_output(json!({ "file": file, "text": text }))
        }),
        "store_linked_write" => (|| {
            let id: String = arg(args, "id")?;
            let text: String = arg(args, "text")?;
            let expected: Option<i64> = arg(args, "expectedMtime")?;
            let file = store.write_linked_text(&id, &text, expected)?;
            library.indexer.prioritize(&[format!("file:{id}")], Priority::Opened);
            json_output(file)
        })(),
        // What the user has open is indexed first.
        "store_linked_priority" => arg::<String>(args, "id").and_then(|id| {
            library.indexer.prioritize(&[format!("file:{id}")], Priority::Opened);
            json_output(true)
        }),
        // A PDF opens in the reader as a library source that points at the file in place.
        "store_linked_open_pdf" => arg::<String>(args, "id").and_then(|id| {
            let file = store.linked_file(&id)?.ok_or("Linked file not found")?;
            if file.kind != "pdf" {
                return Err("Not a PDF".into());
            }
            let imported = library.import_file(Path::new(&file.abs_path), None, root, None)?;
            if let Some(source) = imported.get("id").and_then(Json::as_str) {
                store.set_linked_source(&id, source)?;
            }
            library.indexer.wake();
            json_output(imported)
        }),
        _ => return None,
    };
    Some(result)
}
