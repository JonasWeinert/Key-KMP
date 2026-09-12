# Workspace storage contract

A workspace is a user-visible folder. The Electron registry remembers selected folders, but owns no document metadata. Each folder contains `.key/library.sqlite3`, `.key/sources/` and derived indexes; all canonical PDF metadata, annotations, extraction structure and general records reside in that single SQLite database. Default location is `~/Documents/Key/<workspace>`; chosen folders use the same structure. Existing Tauri libraries can continue opening directly and migrate to schema 11; moving/copying them into a workspace is a separate explicit import, not an automatic destructive relocation.

Projects are named subfolders of the workspace (a safe generated suffix avoids collisions) and durable rows. Project record membership is many-to-many: removing a project membership never removes the workspace-owned record or original source. One PDF content hash represents one source within a workspace; the same bytes may independently belong to multiple workspace databases. All-workspace queries must fan out to those databases and preserve workspace identity on every result. Cross-workspace relations are not currently implemented.

## Implemented schema 11

- `workspace_identity`: one stable workspace ID/name/root.
- `workspace_projects`: project ID/name/folder.
- `workspace_records`: source/note/document/page/database/file records, stable IDs, small JSON properties, bounded body, revision and update timestamp. Sources reference canonical `documents(hash)` and use existing document metadata commands. SQLite triggers create source records for existing/new imports and synchronize titles.
- `workspace_project_records`: indexed project memberships.
- `workspace_linked_folders` and `workspace_linked_files`: external folder registrations, observed path/hash/size and source/record association.
- `workspace_record_fts`: indexed title/body/properties for general-record metadata search. PDF full-text and vector search remain in existing Tantivy/Frankensearch indexes.

Record writes require the expected revision when updating. A stale editor cannot silently overwrite another edit. Source metadata remains canonical in the existing document tables. A `database` record is currently a named placeholder: it does not execute an arbitrary saved query or formula.

## Linked folders

Explicit rescans use bounded traversal: at most 10,000 directory entries, 64 nesting levels, and 2 GiB per file, with a 1 MiB streaming PDF copy buffer and a 64 KiB hash buffer. Symlinks are skipped. Files under Key's internal data folder are rejected. Original files are read only. Every encountered regular file is hashed from bytes, including files whose timestamps have not changed. Modified PDF contents become a new content-addressed source; previous curated sources are retained. PDF hashes are returned to the host for normal indexing. Non-PDF filenames, paths, sizes and hashes are indexed for metadata search; their full contents are not yet extracted.

A truncated scan reports that fact and never treats unseen paths as deletions. The current API restarts scans rather than maintaining a durable traversal cursor, so folders exceeding the entry limit need smaller linked subfolders. Removed external files do not automatically remove curated workspace records. Automatic filesystem watching, deletion reconciliation, resumable scanning and extraction for additional file formats are roadmap work.

## Roadmap for user databases

Build typed property definitions with stable IDs and transactional SQL projections over record JSON, relation edges, saved filter/sort views, and a bounded typed formula evaluator. Formula caches depend on input record revisions and formula versions; PDF-derived inputs additionally depend on file content hashes and producer versions. Never use PDF hashes alone to invalidate user-edited metadata/formulas. Formula results must be revision-fenced before filters consume them. Unsupported controls in the design prototype should be marked Preview/Roadmap rather than pretending to persist these behaviors.

## Integration safeguards

The Electron bridge admits six regular requests concurrently, with a bounded queue and reserved cancellation capacity. Idle workspace processes are retired after 60 seconds only when the backend confirms there are no active readers, imports, queued/running processing jobs, or requests. Paginated searches retain the host for the search snapshot lifetime. Model idle unloading remains managed by the existing embedding service.

Source browsing uses `semantic_library_page`, with SQL LIMIT/OFFSET and a separate count. Aggregate all-workspace pages remain bounded to the requested limit and label each source with its owning workspace. Workspace relevance scores are never compared to sort a shared search list.

Saved Office files use `workspace_register_file`: canonical-path lookup is indexed, repeated saves/reopens reuse a record, observed fields merge with user properties, and hashes reflect file contents. Linked-file rescans likewise preserve user properties. Historic duplicate path records are not automatically deleted.

## Source entries and assisted properties (schema 12)

Non-PDF sources now persist as canonical records with `sourceType` values web, reference, note, image, video, audio or dataset. URL, supplied text and typed custom properties are editable; FTS indexes titles, URLs, properties and supplied text. Entry lists are paged and omit full bodies until an entry is opened. Media records describe their source; no automatic transcription, OCR or remote page snapshot is implied.

BibTeX and RIS imports handle up to 100 references / 256 KiB, preserving common title, author, year, DOI and URL fields. DOI links can request scholarly metadata for explicit review. Available open-access PDF URLs use the bounded download/import pipeline and link the imported PDF hash back to the reference record.

`workspace_attributes` and `workspace_agent_properties` persist attribute configuration and fill instructions. Actual fill execution uses the existing Office AI provider configuration; the UI can also configure a custom OpenAI-compatible provider. Keys remain in the existing local settings file with mode 0600 and are not returned in provider status. Remote endpoints require HTTPS; local endpoints may use HTTP.

A fill batch accepts up to 25 PDFs and two concurrent provider calls, with a 45-second deadline each. Only selected inputs are sent; extracted text is bounded to 32 KiB from the first four stored text blocks. Strict scalar/select validation precedes proposal display. No values are written until the user confirms selected proposals. Confirmation checks the selected-input fingerprint and atomically compares the previous property value before writing both value and provider/input provenance. Mock-provider tests cover concurrency, no writes before approval, stale inputs, type validation and semantic tag suggestion validation. Configuring a provider does not trigger a model call.
