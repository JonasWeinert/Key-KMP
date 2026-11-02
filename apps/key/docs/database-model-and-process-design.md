# Database model and process boundaries

2026-09-11. Current implementation facts are distinguished from proposals below.

## Current canonical database (schema 9)

`<app data>/semantic-search/library.sqlite3` is ordinary SQLite, with WAL, foreign keys and numbered transactional migrations. Before upgrading an existing version, Key retains a consistent SQLite backup. SQLite is embedded; there is no database server process.

| Tables | Purpose and representation |
| --- | --- |
| `documents` | Public SHA-256 identity; title, page count, year, ordered author display JSON, managed-source availability, processing stage/count/error, keyword readiness, update and soft-removal timestamps. The public hash remains text in this low-volume compatibility table. |
| `content_keys` | Integer internal content ID and unique 32-byte SHA-256 digest. Document insertion/deletion triggers synchronize this registry. |
| `artifact_namespaces`, `artifact_data` | Interned producer kind/version; checksummed, versioned compressed artifact payloads (binary native geometry/embeddings; JSON for dynamic structure) keyed by integer content ID, namespace ID and artifact key. Native geometry, semantic page structure, extraction checkpoints and cached embeddings live here. The primary data table uses `WITHOUT ROWID`. |
| `block_data` | Integer block ID, integer content ID, block key and one canonical copy of block text. |
| `passage_data` | Integer passage ID, stable external search ID, integer block link, page number, context/target UTF-8 byte ranges, packed u16 rectangles. Full passage text is reconstructed from the block. |
| `artifacts`, `text_blocks`, `chunks` | Read compatibility views over the compact content tables, not additional copies. |
| `annotations` | Stable annotation ID, document identity, complete annotation JSON and extracted comment text. Anchors include geometry, character ranges and quote. |
| `document_authors` | Ordered author rows scoped to one document. An optional authority ID exists, but full person identity resolution is not implemented. |
| `metadata_observations` | Field/value JSON, producer and timestamp. User edits are recorded; provider-vs-user precedence is not yet a complete resolution system. |
| `document_labels` | Case-insensitive tag/collection memberships. These collections are labels, not user-created database schemas. |
| `property_definitions`, `document_properties` | Named text/number/boolean definitions and JSON scalar values per document. Equality filters are indexed. Properties are currently identified by mutable human-facing names, not stable property IDs. |
| `document_relations` | Ordered extracted-reference/citation JSON, with an indexed page expression. This is **not** a general relation-edge table. |
| `index_generations` | Published lexical/vector generation paths, format versions and publication timestamps. Tantivy and Frankensearch files are derived data; publication swaps SQLite pointers. A shared cross-process query pin prevents old-generation collection while readers are active. |
| `index_publications` | Durable intents for completed index generations, their checksum and the previous pointer. Restart validates and replays only if that pointer has not been superseded; paused work waits. |
| `jobs`, `processing_leases` | Pause/retry state and renewable stage ownership. |
| `legacy_imports`, `maintenance_events` | Import receipts and recovery history. |
| `purge_tombstones`, `purge_files` | Fence stale workers after permanent deletion; durable, restartable managed-file cleanup. Explicit verified reimport clears the tombstone. |
| `metadata_fts`, `comment_fts`, `extra_metadata_fts` | FTS5 for metadata, comments, labels and properties. Triggers update these transactionally. PDF body text stays in Tantivy. |

The schema-7 migration compacts the high-volume content tables. It does not claim that every low-volume metadata foreign key has already migrated away from text hashes. Public search IDs deliberately remain stable to keep existing generations and navigation targets valid.

## Recommended user-defined database model (proposal)

Keep PDF content identity separate from user records. A source PDF and its extraction/index artifacts can be shared by multiple research records without duplicating embeddings or changing annotations when a table is reorganized.

Use a small, controlled physical SQLite schema to represent user-created *logical* tables:

- `record_types`: stable ID, display name, schema revision and optional built-in role. “Papers”, “Projects” and “Experiments” are examples.
- `records`: stable integer ID, record type, optional canonical content link and lifecycle timestamps. Built-in document records bind to the existing canonical library.
- `property_definitions`: stable ID, owning record type, display name, type, settings, constraints, archived state and schema revision. Renaming changes a label, not the identity used in queries/history.
- Small authoritative property JSON keyed by stable IDs, with transactional typed projections for text, numbers, booleans, dates, option IDs and multi-values. Use `(property_id, value, record_id)` filter indexes and `(record_id, property_id)` hydration indexes. Missing means no value row; do not conflate missing, false, zero and empty text.
- `relation_definitions`: source/target record types, names for both directions, cardinality and deletion policy.
- `relation_edges`: relation ID, source record, target record and optional order. Index both directions; validate types/cardinality in the write service and database constraints/triggers.
- `property_options`: stable IDs for select/multi-select choices, labels and ordering.
- `schema_changes`, `record_observations`: durable evolution/history, with provenance and explicit user overrides.
- `saved_views`: selected properties, filters, sorts and display settings. Different views share records and values.

Avoid creating physical SQL tables/columns for every user table or property. A logical schema makes rename, relation validation, migrations, saved views and cross-table search tractable. SQLite still uses real typed columns and B-tree indexes underneath; this is not an unindexed JSON bucket.

Built-in fields should have stable property definitions bound to their existing canonical storage. There must not be two competing writable copies of title/year/author. Extracted reference evidence stays immutable/versioned; a curated relation to another paper is a separate explicit edge with provenance.

The metadata query service should compile a bounded, typed expression tree into parameterized SQL. Validate field IDs, operations, relation hops, sort limits and result limits. SQL computes eligible content IDs first, then Tantivy/vector retrieval operates over that eligibility set. Renaming a property must not invalidate a saved query. Metadata-only edits do not trigger embedding work.

For extension, start with text, number, boolean, date, select, multi-select and relation. Add URL/email formatting without a separate storage type. Formula/rollup fields need dependency tracking, cycle detection and bounded incremental recomputation; they should follow the base schema, not be bolted into the initial write path. Arbitrary raw provider JSON can be retained as evidence; expose typed indexed properties for fields users actually filter.

A type change should validate existing values and report conversion failures before committing. Preserve old values and history; do not silently drop them. Archive properties/record types by default. Built-in content/index tables remain app-owned, even when presented as editable database views.

Example: an Experiment record links to multiple Paper records; Papers expose title/year/authors, plus user-defined “Evidence strength” and “Reviewed”. A saved view filters `Experiment.project = X AND Paper.year >= 2020 AND Reviewed = false`. Those relationships resolve in SQLite to content IDs before passage retrieval. One PDF can participate in many experiments without repeated preprocessing.

Open design decisions for discussion: whether one source may back multiple independently curated Paper records; relation targets beyond records (passages/annotations); formula/rollup scope; and undo/history retention. This proposal is not an implemented Notion-style table editor.

## Process ownership

- Main app coordinates commands, metadata operations, queues and index readers.
- A supervised interactive helper owns PDFium and native document handles. It retains up to four open native documents; inactive handles are closed and reopened lazily from paths. A bounded parent request channel limits queued IPC work. Cancellation travels separately from render responses.
- A bounded preprocessing pool runs disposable extraction/index helpers. Available system memory gates new worker admission. A newer selected reader can preempt another semantic helper, which resumes from durable checkpoints. Raw semantic pages are consumed as they are extracted and can be checkpointed in SQLite.
- One lazily started embedding service owns the ONNX model. Index helpers receive its loopback endpoint/token; query work uses the same endpoint. Requests contain at most eight batch inputs with a one-MiB serialized budget. Query work precedes queued background batches. Idle model state is released after 30 seconds. Parent pipe closure terminates the service.
- WebKit owns viewer/GPU/network process lifetimes. PDF.js Web Workers are not a contractual one-worker/one-OS-process mapping.

## Responsiveness is a measured contract

Process separation protects the main process from native crashes and large model allocations, but does not guarantee frame timing or cap operating-system/GPU memory.

The viewer uses stale-render cancellation, gesture coalescing, tiled canvases, bounded render concurrency, lazy page proxies, inactive-reader cleanup and a small native text working set. The follow-up adds logarithmic visible-page selection, shared active-pane tile budgets, offscreen zoom-fallback eviction and generation-safe pending-render cleanup.

Tile limits are soft at the minimum visible-viewport working set. Decoded images, fonts, PDF.js operator lists and WebKit GPU allocations are outside the canvas-byte counter. A hard whole-app memory guarantee is therefore not justified. Qualification must compare indexing on/off, multiple open and split documents, large/scanned/malformed fixtures, rapid navigation, and RSS/frame percentiles after repeated warm cycles.

## Still needed for the complete PRD

Raw-page streaming is not full semantic streaming: reconstructed pages are retained for document-wide reconciliation. Frankensearch's builder and low-level vector writer retain their input, so Key now caps each immutable vector segment at 2,048 passages. The app reads canonical pages incrementally and the outer chunk input is a rewindable disk spool. Document-wide reconciliation inside the disposable helper still retains reconstructed pages; it needs separate global-summary passes before a strict size-independent memory claim.

Memory/CPU admission is adaptive, with short interaction deferral and starvation protection. Helpers yield for a newer selected reader and rotate checkpointable work after a 15-second quantum when competitors wait. Reconstructed-document reconciliation and final segment publication are not time-sliced. Crash/timeout recovery, permanent purge and large-fixture tests have targeted coverage; complete provider override resolution, the generic user database/query/formula subsystem and full release/WebKit qualification remain separate acceptance gates.

## Records, JSON and formulas: refined design (2026-09-11)

Notion's published model describes typed blocks with IDs, flexible properties and references; records also include users and workspaces. Its native record cache uses SQLite/IndexedDB. Its public API defines typed property schemas, relations, formulas and rollups. This supports the user-facing record model, but does not establish that Notion implements every query or formula by scanning arbitrary JSON.

Sources: [Notion's block/record model](https://www.notion.com/blog/data-model-behind-notion), [property schemas](https://developers.notion.com/reference/property-schema-object). These describe a model and public contract, not a complete specification of Notion's current production storage internals.

For Key, adopt a hybrid record model for user-created data:

| Layer | Authority and implementation |
| --- | --- |
| User database | A record type with stable ID, property schema and lifecycle. Creates logical rows, not a separate SQLite file. Separate files should mean a separate library/workspace, with explicit cross-workspace restrictions. |
| User record | Stable ID, type/database ID, optional content ID, revision, timestamps and versioned JSON properties keyed by stable property ID. This JSON is authoritative for flexible user values. Bound built-in PDF fields stay authoritative in their existing canonical columns. |
| Property schema | Stable property ID, display name, type, configuration JSON, constraints, schema revision and archive state. JSON flexibility does not bypass validation. |
| Query projections | Typed text/number/date/boolean/option rows and bidirectional relation edges, rebuilt from canonical record values. Maintain them in the same SQLite transaction as changes, so queries never observe half-updated JSON/index state. Index by property/value/record and record/property. |
| Formula definition | User-facing expression plus a validated/versioned AST whose references are property IDs. Store dependency edges and inferred result type. Never execute user formulas as JavaScript, SQL or native code. |
| Formula result | Derived typed value or explicit error, definition revision and input revision/dependency fingerprint. Indexed results support filtering/sorting. Formula output is read-only. |
| Views | Saved typed filters, sorts, visible columns and grouping referring to IDs. Multiple views share the same records. |

This refines the earlier typed-value proposal: JSON can be the single flexible value authority and typed tables can be transactional projections. Do not maintain two independently writable copies. This is a proposed user database subsystem, not a claim that the existing name-keyed document-property API already implements it.

Example expression: `if(Reviewed, CitationCount / max(PageCount, 1), null)`. The editor shows labels, but the compiled AST binds each attribute to its stable ID. A rename changes display text without breaking formulas or saved views. Missing, explicit null, false, zero and errors retain distinct semantics. Dates use a declared timezone policy; numbers reject NaN and infinities. A property type change validates all existing values and dependent formulas before an atomic schema revision; conversion failures preserve the old schema/data.

Formula execution and invalidation:

1. Parse into a restricted expression grammar; validate argument/result types and property scope. Begin with scalar arithmetic, comparisons, booleans, conditional/coalesce, strings and date operations.
2. Maintain dependency edges and reject direct/indirect cycles at definition changes, including relation/rollup dependencies. Report the cycle in the editor.
3. On a record write, commit the changed JSON, typed projections and durable dirty entries together. Recompute cheap local dependents in topological order; process expensive relation aggregates on a bounded worker.
4. Relation edits invalidate both affected records and reverse dependents. Aggregate over indexed relation edges; do not load entire related tables into RAM. Apply evaluation budgets and return an explicit limit error for an oversized computation.
5. Commit a result only if the definition and input revisions still match. Stale results are discarded/requeued. A filtered view must resolve required dirty values for its snapshot or expose a computing state; it must never silently filter against known-stale values.
6. Deterministic formulas cache by AST/version plus input revisions or input-content fingerprints. PDF-derived inputs additionally include PDF content hash and producer identity. **The PDF hash alone cannot invalidate a formula when a user edits metadata.** Time-dependent functions require an explicit clock dependency and scheduled invalidation; avoid volatile functions initially.

Set finite evaluation limits (AST depth, operation count, string/result size, relation traversal and deadline), prohibit I/O, and preserve durable dirty work across restarts. Support aggregate `count`, `sum`, `min`, `max` and `average` before arbitrary list pipelines. Formula preview should show type/error and sample output before saving; schema edits, formula edits and value edits should have undo/history entries.

I recommend one shared Paper record per PDF by default, referenced by Projects/Experiments and shown in multiple views. The schema may permit additional independently curated records linked to the same content later; extraction, passage IDs and embeddings remain shared. Extracted PDF structure stays in compact app-owned tables/artifacts rather than turning every glyph or rectangle into a user-editable JSON record.

Keep small flexible property values in record JSON; put large rich content and PDF geometry in separately addressed content blocks. A record should not become a multi-megabyte object merely because it has a long note or many attachments. Property changes update only the affected typed projections and formula dependencies. The JSON representation is an application contract, not permission for plugins or formulas to issue arbitrary SQL against canonical tables.
