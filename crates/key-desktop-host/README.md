# Key desktop Rust host

Standalone backend for the Electron shell. It reuses the canonical library,
PDFium interactive child, disposable extraction workers and embedding service.
The orchestration in `src/backend.rs` was migrated from the Tauri shell; the
existing Tauri build remains available for comparison. Future orchestration
changes should move into shared crates rather than diverging between shells.

Build from the repository root:

```sh
CARGO_TARGET_DIR=apps/key/src-tauri/target cargo build --manifest-path crates/key-desktop-host/Cargo.toml
```

Launch `key-desktop-host --library /absolute/workspace/.key`. Each workspace has
its own process and SQLite/source directory. Electron owns process lifetime;
closing stdin exits the host. Set `PDFIUM_DYNAMIC_LIB_PATH` to the packaged
PDFium library directory. Development also finds the repository vendor copy.

## Transport version 1

Both directions: little-endian u32 JSON-header length, UTF-8 JSON header, then
raw `binaryLength` bytes. Headers are limited to 1 MiB, binary payloads to 32 MiB.
Requests: `{id, command, args, headers?, binaryLength?}`. IDs are integer request
IDs. Responses: `{id, ok, result?, error?, binaryLength}`. Binary responses carry
no JSON result. Eight requests may execute concurrently; additional requests
receive a retryable busy error. Cancellation and interaction signals bypass
this admission limit. Responses may arrive out of order. The shell should
bound its queue, prioritize reader interaction and retry busy work with backoff.

Command names and camelCase argument names preserve the existing Key frontend
contract. `library_import_chunk` uses `x-key-import` and `x-key-offset` headers.
`library_import_file {path}` streams a selected local PDF into managed storage;
call `begin_pdfjs_companion_managed {hash}` to open it and queue processing.
Use `library_source_info`/`library_source_range` for large PDFs. JSON byte arrays
are supported only for compatibility; normal PDF imports/renders use binary.

Workspace commands: `workspace_initialize`, `workspace_info`,
`workspace_projects`, `workspace_create_project`, `workspace_records`,
`workspace_save_record`, `workspace_set_project_membership`,
`workspace_link_folder`, `workspace_linked_folders`,
`workspace_scan_linked_folder`. Scanning queues discovered PDFs through the
existing processing pipeline. Workspace properties/notes are canonical SQLite
data; formula execution, folder watching and richer editor UI are separate work.

Electron must expose an allowlisted bridge to trusted local renderer content,
not this raw host interface to arbitrary pages. The host accepts filesystem
paths from its owning main process; file selection authorization belongs there.

Verification:

```sh
CARGO_TARGET_DIR=apps/key/src-tauri/target cargo test --manifest-path crates/key-desktop-host/Cargo.toml
python3 crates/key-desktop-host/tests/smoke.py apps/key/src-tauri/target/debug/key-desktop-host
```
