# PRD: Canonical library and responsive PDF processing

Status: proposed implementation plan. Date: 2026-09-10.

Companion: [technical implementation plan](canonical-library-implementation-plan.md).
Evidence: [storage evaluation](storage-evaluation-2026-09-10.md).

## Product outcome

Opening a PDF should make it readable and interactive quickly. Key should then process it in the background, show accurate progress for that PDF, and retain its annotations, structure, metadata and searchability across restarts. Multiple open PDFs must not make the active reader wait behind background indexing.

One Key-owned SQLite database is authoritative. PDF content hashes identify documents. Tantivy and Frankensearch vector indexes are rebuildable derivatives. SQLite FTS5 supports textual metadata and comments; ordinary SQL indexes support structured filters.

## Problem and current state

The active Tauri app already has PDF.js rendering, PDFium character geometry, annotations, reference enrichment, sentence-context embeddings and a library screen. Its persistence is fragmented across browser localStorage, temporary sidecars, a JSON manifest and index files. Annotation identity is based on filename/size/modification time while semantic indexing uses PDF-byte hashes.

Opening currently copies PDF bytes into a JSON number array for native IPC and requests all PDF.js pages before reader setup finishes. Native and semantic analysis are separate whole-document pipelines. Search and embedding/index operations share a serialization lock. Progress conflates work completed with an index being searchable. These are implementation findings, not benchmarked estimates of their individual costs.

## Users and primary journeys

1. A researcher opens a paper and immediately starts reading, selecting text and taking notes while indexing continues.
2. They open several papers or a large PDF. The active document stays responsive; every document shows its own processing state.
3. They reopen or rename an unchanged file. Existing annotations and reusable analysis return without redundant embeddings.
4. They search the library, filter by author/year/tags or annotation properties, and open the exact matching passage, including in a closed PDF.
5. They restart after interrupted processing. Saved annotations remain intact and indexing resumes from durable work.

## Scope

### Canonical documents and durable sources

- Store one canonical document per SHA-256 of exact PDF bytes. Multiple paths and tabs may reference it.
- Default to an app-managed, content-addressed PDF copy so closed documents can reopen and interrupted jobs have a stable source. Copy and hash as one streaming import; deduplicate identical bytes. This is a proposed product default, not an existing behavior.
- Retain original source locations as provenance. A changed source produces a new document identity; do not silently move annotations to changed bytes.
- Show missing-source/import failures and allow relinking by verified hash. Never delete the original source when removing an item from Key.
- Separate closing a tab, pausing processing and removing a library document. Closing continues background processing at lower priority. Removal cancels work and removes Key-owned data according to explicit user intent.

### Metadata and structure

- Persist title, authors, year, DOI, venue, tags, collections, provider provenance, reference relationships and future typed document properties.
- Preserve user edits independently from provider values; later enrichment must not overwrite a user's chosen value.
- Store canonical text once per extraction representation, with structural and sentence offsets. Store dense geometry compactly and load it by page.
- Preserve the distinction between PDFium character anchors and semantic UTF-8 offsets. Annotations retain the representation/version needed to resolve them; ambiguous anchors are surfaced, never guessed.
- Store highlights and comments transactionally in SQLite. Show pending/saved/failed state and retry failures. A saved indicator means the database commit succeeded.

### Search and filtering

- Tantivy provides PDF full-text retrieval; Frankensearch provides passage-vector retrieval. Wire both into hybrid search.
- SQLite FTS5 searches textual metadata and comments. It is not used as a second PDF-body index.
- Apply author/year/tag/custom-property/annotation filters before top-k selection in both retrieval arms. Filters support typed equality, ranges, membership, AND/OR and explicit missing-value semantics.
- All modeled metadata is available to the filter service. The first UI exposes author, year, tags, collection and annotation presence; advanced properties are added through the same typed contract. Raw provider JSON is preserved as evidence, not promised as a performant arbitrary JSON-query UI.
- Metadata-only changes take effect without re-embedding unchanged passages.
- Return exact source identity and passage anchors; reopen managed PDFs and navigate/highlight the hit.
- A document can be keyword-searchable before vectors are ready. Show keyword-only/partial semantic coverage honestly. An embedding failure must not disable keyword search.
- Define metadata search as a separate result type or explicit filter input initially. Do not mix document-level metadata scores directly with passage scores without a specified aggregation/ranking policy.

### Search-result navigation UX

Results show document title, page label, section heading when known, and a short snippet with the matching words or target passage emphasized. Group multiple passages from the same PDF without hiding their individual page targets. Clearly distinguish passage, metadata and comment matches. Do not invent an exact word match for a semantic result.

- One click or Enter opens the target in its existing tab, or creates a tab for a closed document, and moves to the precise page/section. Reuse an already visible split pane when it owns the document; do not replace the other pane unexpectedly.
- Position the target near the upper third of the unobscured reading area. Show a temporary theme-aware search highlight: exact word/range for lexical hits, target sentence(s) for semantic hits, and the anchored quote/comment for comment hits. Nearby context is visible but not falsely marked as matched.
- The highlight is separate from saved annotations, remains until dismissed or replaced by another result, and has an accessible “Search result” label/outline. Respect reduced-motion preferences; avoid repeated pulsing.
- Preserve query, filters, expanded result groups, scroll position and selected hit. “Back to results” restores that state. Offer previous/next result navigation in a small reader control with result position and a dismiss action; keyboard operation must work without hijacking text editing.
- Start page rendering and anchor retrieval concurrently. If opening takes more than 150 ms, show a lightweight “Opening page …” state. The target becomes usable without waiting for the rest of the PDF to process.
- Rapidly clicking another result cancels obsolete navigation. Late responses cannot scroll the newly chosen document or replace its highlight.
- If exact geometry is unavailable, show the correct page and a short “Locating passage…” state while resolving only that page. If the anchor remains unresolved, say so and show the snippet; never highlight guessed text. Source/version mismatches require revalidation.
- Metadata-only hits open document details, emphasizing the matching field; they do not pretend to identify a body passage. Unanchored comments open their comment details. Missing sources offer verified relinking while retaining search state.

### Speed and memory throughout

Keep only visible/nearby page tiles and geometry resident. Share source/document resources across tabs and split views where supported, use byte-budgeted caches with eviction, and load structure, annotations and result details by page/range. Large imports must not materialize every file as multiple complete byte arrays. Results are fetched in bounded pages; opening a result must not load its whole structure or the complete library into JavaScript.

Background work must yield capacity to foreground navigation and user actions. Memory measurements include the WebView, native process, PDF.js workers, helper processes and embedding model—not just Rust heap allocations. Performance changes must retain extraction quality, exact anchors and filter correctness.

### Processing and visible progress

The reader must not wait for hashing, whole-document analysis, reference network requests or embeddings before displaying available pages. Initial drawing may use a temporary session identity; canonical cached state is attached only after hash verification.

Every PDF has separate readiness dimensions:

| Dimension | User-visible meaning |
|---|---|
| Reader | Opening / readable / text available on current page |
| Text search | Preparing / available |
| Semantic search | Queued / extracting / embedding / publishing / indexed |
| Metadata | Looking up details / enriched / unavailable offline |

The tab or document header shows a compact status; the library row shows stage, work units and a details view. Examples: “Reading order: 12 of 40 pages”, “Embedding: 320 of 910 passages”, “Saving search index…”, “Keyword search ready; semantic indexing queued”.

- Use stage-local progress, not an invented overall percentage. Unknown totals are indeterminate. Counters may reset on stage changes, which must be labeled.
- Count only durable completed units. Embedding 100% is not “Indexed”: index publication must finish first.
- Expose pause/resume/retry per PDF. A failure names the affected stage and preserves working reader/search capabilities.
- Progress survives restarts. Interrupted work is shown as resuming/queued, not permanently “processing”.
- Updates remain active until all subscribed dimensions are terminal; completion of reference enrichment must not stop semantic progress updates.

## Proposed performance targets

These are targets to validate, not current measurements. Fix an Apple-silicon reference machine, production Tauri/WebKit build, display settings and corpus before committing performance claims. Use ordinary text PDFs up to 50 pages/25 MB for absolute opening targets; report large, scanned and malformed documents separately.

| Measure | Initial target |
|---|---|
| Open action to readable first viewport, cold | p95 ≤ 1.5 seconds |
| Visible-page native text ready | p95 ≤ 500 ms after first readable viewport |
| Warm library reopen to saved overlays | p95 ≤ 500 ms after hash/source verification and visible-page readiness |
| Progress event to visible update | ≤ 250 ms, coalesced rather than one update per chunk |
| Reader responsiveness while indexing 10 PDFs | p95 frame interval degradation ≤ 20% versus the same indexing-off scenario |
| Warm search while indexing | p95 ≤ 500 ms on a defined 100-PDF/100k-passage corpus; cold model startup reported separately |
| Click to target viewport and highlight, already-open PDF | p95 ≤ 500 ms on the reference corpus |
| Click to target viewport and highlight, closed managed PDF | p95 ≤ 1.5 seconds on the reference opening corpus; source verification and cold parse included |

Report per-stage CPU time, queue wait, IPC bytes, parent+worker peak RSS, disk bytes and cache hits. No fixed total-indexing SLA until representative extraction and embedding baselines exist. Large-document memory must be bounded by configured caches/batches rather than retaining all character geometry or all PDF copies in memory.

## Acceptance criteria

1. Same bytes under different names/paths resolve to one document, annotations and reusable artifacts. Different bytes with identical filename/size/mtime do not collide.
2. Cold opening a PDF makes its viewport readable without waiting for whole-document completion; selecting a new tab promotes its visible-page work.
3. Ten imports show ten independent progress states; a small/active PDF does not sit behind an entire large PDF's non-preemptible analysis job.
4. A saved annotation survives restart. Existing localStorage annotations migrate idempotently; unresolved legacy identities remain recoverable.
5. Query filters constrain both keyword and vector results. A selective filter still returns eligible matches that were outside the unfiltered top-k.
6. Search works during index builds; only published generations are read. Keyword search remains available after embedding/network failures.
7. Clicking a hit reopens the managed PDF and highlights the actual passage, not merely the document tab.
8. Closing/reopening and process interruption resume durable work without re-embedding completed compatible chunks. Retry does not duplicate annotations, chunks or library rows.
9. Changing extraction settings invalidates dependent artifacts; changing author/year alone does not invalidate passage vectors.
10. Corrupt/missing derived indexes rebuild from canonical data. A failed canonical write is surfaced and never acknowledged as saved.
11. Removing a document cannot let an in-flight worker recreate it. Managed-source cleanup respects active readers and shared references.
12. Performance results include cold/warm runs, indexing-on/off comparisons and manual inspection of progress, reader interaction and search navigation.
13. Navigation preserves search state and supports keyboard/back/previous/next actions. Rapid result selection cannot install stale scroll/highlight state. Lexical, semantic, comment and metadata hits use the correct target behavior.
14. Memory plateaus under repeated open/close, scrolling and result navigation after cache warmup. Configured caches stay within byte budgets; idle documents release heavyweight resources while annotations remain durable.

## Non-goals for this delivery

Cloud sync, multi-user collaboration, OCR, PDF-content editing, new embedding models, reranking, a generic metadata query language and cross-version annotation relocation onto changed PDF bytes. Existing provider enrichment remains supported; broad bibliographic editing UI can follow the storage/filter foundation.

## Delivery and product defaults

Follow the seven phases in the implementation plan: contracts/baselines; database; source identity/migration; responsive processing/progress; search publication/filtering; recovery/navigation; performance qualification.

Initial defaults are managed copies, continued indexing after tab close, manual pause/resume, ONNX layout detection off, and existing embedding model retained. Any change to these defaults must update this PRD and its acceptance tests. This document requests no migration or implementation merely by existing.
