# Canonical storage evaluation

Scope: Key's current Frankensearch revision `b559c92e03242336614b995c562a13dfd1269eed`, specifically `frankensearch-storage` 0.2.0. This is an evaluation, not a storage migration.

## Recommendation

Do not adopt this evaluated storage stack as Key's canonical database yet. Its extension surface is usable, and the same-engine functional probe passes, but a controlled persistent-FTS interoperability probe fails with conventional SQLite. Keep Frankensearch/Tantivy/vector retrieval; use a Key-owned conventional SQLite database with persistent metadata FTS5, or resolve and validate the FrankenSQLite issue before selecting its storage stack. This is a finding about the selected dependency graph, not a claim that every FrankenSQLite release has the same behavior.

The cost of adopting the storage crate is greater than adding Key tables: it also requires a full-text loader for chunks, a durable metadata FTS integration, filtering coordination, and database compatibility/durability validation. Its existing job/schema design remains a useful reference.

## Proposed responsibility split

- Canonical SQL: PDF byte hashes, source locations, bibliographic metadata and provenance, structure, annotations, reference relationships, processing identities, chunk mappings and index publication state.
- Tantivy: PDF full-text retrieval, retaining the existing lexical index.
- Frankensearch vector index: passage embeddings and vector retrieval.
- Persistent SQL FTS5: textual metadata such as titles, author names and annotation comments, when text matching is desired.
- Ordinary SQL indexes: exact/range/set predicates such as year, DOI, author identity, collection membership and annotation presence. FTS does not replace these indexes.

All search IDs must resolve through canonical records. Document filters must constrain retrieval before top-k selection. With the current per-PDF shards, document filters can select shards; passage-level filters still require retrieval support. A metadata FTS result at document level cannot simply be fused with passage hits as though their IDs and scores had identical meaning.

## What the existing storage crate provides

`Storage` exposes its `fsqlite::Connection`, ordinary and immediate transaction helpers, schema bootstrap and metrics. Its schema includes documents, embedding jobs/status, text-hash bookkeeping, index metadata/build history, search history and bookmarks. Metadata-only ingestion updates are explicitly handled without requeueing unchanged embeddings.

Extending the same database with namespaced `key_*` tables is technically possible. Keep Key migrations in a separate migration table: the library owns its generic `schema_version` table and rejects future versions. Do not edit its schema version or assume its document rows are PDF records: for Key search, those rows would naturally represent chunks.

Sources in the pinned repository:

- `crates/frankensearch-storage/src/connection.rs`: `Storage::connection`, transaction helpers, bootstrap and defaults.
- `crates/frankensearch-storage/src/schema.rs`: document schema and library-owned migrations.
- `crates/frankensearch-storage/src/pipeline.rs`: ingestion, metadata refresh and embedding source handling.

## Gaps that prevent treating this as a ready-made Key database

### The provided FTS5 adapter is in memory

`Fts5LexicalSearch` constructs `Fts5Table::with_columns`, owns an in-memory document/row-ID map, takes neither a database connection nor a path, and implements `commit()` as a no-op. Its introductory single-database description is not evidence of durable integration. The adapter's constructor also does not apply the configured tokenizer or title boost to the table.

This finding applies to the adapter, not to all FrankenSQLite SQL FTS5 support. A persistent SQL virtual table through the underlying connection is a separate integration path to evaluate.

Source: `crates/frankensearch-storage/src/fts5_adapter.rs`, constructor and `LexicalWrite::commit`.

### The ingestion pipeline does not retain full chunk text

It stores a preview limited to 400 characters. The worker rereads a text source path for longer input, or falls back to that preview. Supplying a PDF path cannot substitute for extracted chunk text. Key would need its own SQL text loader/worker or an upstream extension; otherwise long passages can be embedded from truncated text.

Source: `pipeline.rs`, `MAX_CONTENT_PREVIEW_CHARS`, `ingest`, `process_batch`.

### SQL backend is concrete

The crate depends on FrankenSQLite, not a generic database interface. `Storage`, document helpers and job helpers use concrete `fsqlite` connections/values. Using conventional SQLite through `rusqlite` would require adapting or porting these primitives, rather than selecting another backend feature.

The manifest's `fsqlite = "0.1.2"` is a compatible-version range, not an exact pin. The isolated evaluation resolves 0.1.19. Pin and test the complete selected graph before adopting it for canonical user data.

### Filtering is still application work

The lexical trait's search entry accepts a query and limit, not an arbitrary SQL predicate or eligible-ID set. Key must implement a filter-aware query coordinator and, where necessary, lower-level reader integration. Storing metadata in the library's `metadata_json` does not automatically create indexed filters or connect them to vector retrieval.

### Hash domains must remain distinct

The storage pipeline hashes canonicalized text for deduplication. Key must separately retain the PDF-byte SHA-256 that identifies geometry and annotations. Cache identities must include extraction/chunking settings and versions; vector identities must include model/tokenizer/preprocessing identity. Changing bibliographic metadata alone should not re-embed unchanged text.

## Structure representation

Use typed rows for identities, page/block relationships, ordering and frequently queried attributes. Store text once with sentence/context offsets; store dense geometry in packed binary arrays, optionally compressed per page. Keep annotation anchors tied to a known extraction representation/version. Normalize common bibliographic fields and relationships, and provide typed extensible properties plus raw provider JSON for provenance.

## Validation

An isolated Rust probe lives in `/tmp/key-storage-evaluation-20260910`. It uses the pinned storage source without modifying Key's dependency graph and exercises custom schema creation, packed geometry, SQL FTS, joins, rollback and reopening. `cargo run` completed successfully. The resolved engine/FTS crates were 0.1.19; Asupersync was 0.3.10. Standard transactions were selected (`concurrent_transactions = false`); concurrent-writer behavior was not tested.

Observed output:

```text
custom row: Attention mechanisms, 2024, geometry length 8
CREATE VIRTUAL TABLE ... USING fts5(title, authors): success
MATCH 'Smith': rowid 1
FTS JOIN year >= 2023: Attention mechanisms
UPDATE year=1900 followed by ROLLBACK: year remains 2024
drop/reopen Storage: row retained; MATCH 'Smith' still returns rowid 1
separate Rust process: integrity_check = ok; FTS match retained
```

### Controlled cross-engine result

After the FrankenSQLite process exited, opened the database with Python's conventional SQLite 3.49.0 in **read-only** mode:

```text
PRAGMA integrity_check: database disk image is malformed
ordinary document/geometry SELECT: correct values
MATCH 'Smith': no rows
```

Then isolated the change on a second database:

1. Create `Storage` and one ordinary Key table/row, exit: conventional SQLite `integrity_check` returns `ok`.
2. Reopen with FrankenSQLite; add only `CREATE VIRTUAL TABLE key_fts USING fts5(title)` and one `Hello` row, exit. FrankenSQLite matches that row.
3. Reopen read-only with conventional SQLite: `integrity_check` reports malformed, and `MATCH 'Hello'` returns no rows.

This reproduces a mismatch introduced by the FTS addition in this engine graph. It is not evidence of lost data when accessed solely through FrankenSQLite, and does not establish the underlying engine bug or affected release range. It blocks assuming conventional SQLite tooling/FTS interoperability for the proposed canonical store. No mixed-engine concurrent access occurred.

The probe binaries are `key-storage-evaluation`, `inspect`, `plain`, and `add_fts`; the last two must be run in order against a fresh `plain.db` to repeat the controlled before/after check. The primary database is `probe.db` in the same temporary directory. These files contain synthetic data only.

A conventional SQLite 3.49.0 baseline passed a metadata FTS plus year-filter join, eight-byte packed geometry round trip and FTS query after closing/reopening. This is a functional baseline, not a performance or durability benchmark.

Reference: [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html).

Not tested: crash/power-loss recovery, sustained concurrency, large-library throughput, migration across engine releases, and all upstream tests. Successful basic tests are not a durability qualification.
