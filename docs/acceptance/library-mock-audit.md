# Library mock acceptance audit

Audited 12 September 2026 against both `inspo/library-mock/Key Library.dc.html` and `Key Library v2.dc.html`, reading their actual event handlers and the current implementation. This is an implementation checklist, not a statement that every interaction has passed end-to-end tests. Updated after inspecting the latest source integrations; final packaged UI verification follows the final build.

## Core library and search (both mockups)

| Mock interaction | Current implementation / acceptance requirement |
| --- | --- |
| All / Open / Needs attention / Removed | SQL status/hash eligibility now runs before pagination; workspace registry scopes composite Open identities per child workspace. Wired through LibraryHome and workspace registry. |
| Table/list switch | Present; column preferences persist per workspace in localStorage. |
| Select row for details; double-click/Enter to open | Present in LibraryTable. |
| Add local PDFs; deduplicate; open | Real native import and content-hash identity. |
| Processing status and page/passage progress | Real processing status/progress; activity panel explicitly covers current page. |
| Pause/resume/retry one item | Present. |
| Pause/resume all | Selected-item bulk actions exist, with select-all explicitly scoped to current page. Whole-library controls absent. |
| Search while typing and submit | Debounced search and explicit submit present. |
| Group passages by source; load more; cap notice | Present; bounded search cursors rather than mock delays. |
| Distinguish exact vs related passages | Literal query highlighting exists. Retrieval-class labels are not exposed by LibraryHit; do not infer a semantic retrieval class merely from substring presence. |
| Result single-click preview; double-click reader | Single click selects the side preview; double click opens the real reader. |
| Open correct page with passage highlighted | Real search-target bridge and PDF highlights implemented. |
| Back / previous / next global search result inside reader | Back and previous/next global result navigation implemented through the reader bridge, distinct from in-document Find. |
| Author/year/tag/collection/annotation/custom-property filters | Present with SQL eligibility before retrieval. Year range and type validation present. |
| Filter chips and reset | Present. |
| Metadata form: title/authors/year | Present with canonical SQLite writes. |
| Publication/type fields | Item type and Publication optional columns present; Publication uses canonical custom metadata. |
| Tags/collections and custom property values | Canonical metadata controls present. |
| Remove/undo/restore/purge | Present; purge disabled for open owned PDF; original external source retained. |
| Relink missing original with matching content verification | Native relink now verifies the selected PDF hash against the expected content hash before accepting it, preserving annotation identity. |
| Loading/empty/error/retry states | Existing LibraryHome states; search-error retry available by rerunning search. |

## Additional v2 interactions

| Mock interaction | Current implementation / acceptance requirement |
| --- | --- |
| Header summaries and activity drawer | Backend returns workspace/project-wide all/removed/searchable/processing/attention counts, wired into the header. Activity details remain page-scoped. |
| Sort title/year/updated | SQL title/year/updated ordering now precedes LIMIT and has stable hash tie-breakers. All-workspace aggregation still needs merge ordering or explicit workspace grouping. |
| Column resize (pointer/keyboard), hide, pin, reorder | Present in LibraryTable/column controls. |
| Type/Publication/Tags/Collection/Added columns | Type, Publication, Tags and Collection present as optional hidden columns. Added now has canonical nullable addedAtMs: new imports record an immutable timestamp; pre-migration rows display unknown rather than a fabricated date. |
| Column-specific sort menu | Header sort controls for supported SQL fields and global sort selector implemented. |
| Text/number/boolean/select/formula property | Functional dialog + local expression evaluator. Formula results saved for selected sources; no automatic dependency refresh in SQLite. |
| Formula input aliases and live sample preview | Curly/square property references supported by safe expression parser; formula validation tests pass. Results derive locally, and stored filter values refresh on explicit save. |
| Property edit/delete | Edit and canonical attribute/value deletion wired, with explicit confirmation distinct from hiding a column. |
| Inline custom-property cell edit | Inline custom-property editing implemented, with canonical writes. |
| Bulk selection, tags, processing, removal | Present on current source page. |
| Tag stats/rename/delete/merge | TagManagerDialog + SQLite backend implements workspace-wide operations, including removed sources. Tags are paginated with real counts. |
| Agentic tag consolidation prompt/suggestions/accept | Real configured-provider suggestions implemented with tag-only disclosure, validated proposals, review before merge. Separate deterministic case/spacing suggestions remain accurately labelled. |
| Agent property prompt, input properties, fill one/selected/empty | AgentPropertyDialog, durable prompt/input configuration, real configured-provider proposals and revision-checked application with provenance implemented. Explicit known-metadata copying remains distinct from inference. |
| Automatic metadata completion with provenance | Reference metadata lookup uses real Crossref results with review before applying. AI-derived property fills require configured credentials. |
| Get PDF: provider search, choose candidate, download/attach | Get PDF uses real available full-text URL lookup/download and native PDF import, linked to the saved reference. Local attach remains available; unavailable full text produces an error rather than simulated success. |
| URL/DOI reference import | Durable URL/DOI reference entries, BibTeX/RIS parsing/import and explicit Crossref lookup implemented. |
| Web/audio/video/image sources | Source records can be stored. The mock's fabricated transcripts/descriptions are not processing implementations. Extraction/player/search-time locations need corresponding pipelines. |
| Mixed-media previews and time/image/section locations | Current full reader is PDF. Media-specific preview remains separate implementation work. |
| Split tabs and sidebar navigation | Real global view ownership, native PDF views, split resize and collapsible sidebar. Regression test compares native bounds with DOM divider/sidebar edges. |
| Annotation inline editor/comments sidebar | Repaired and verified in actual Electron; create/edit canonical save, reload, narrow window, Escape and dark-mode screenshots passed. |

## Automated acceptance evidence

`apps/key-electron/scripts/smoke-comments.cjs` exercises actual native-backed PDF selection, create/edit, verifies exactly one canonical annotation, reloads the renderer, checks narrow-window card bounds and dark mode.

`apps/key-electron/scripts/smoke-tabs.cjs` now samples 30 animation frames immediately after pointer release. It rejects neighbour direction reversal over 2 CSS pixels and movement over 2 pixels after the first two settling frames. It also verifies tab/view ownership and compares attached native PDF bounds against the sidebar and split divider before/after sidebar collapse, split resize, and sidebar restoration. Preliminary run passed: all 30 frames showed exactly 0px neighbour movement, and all four native-bound comparisons passed. Repeat against the final build after sources freeze.


Backend follow-up completed: `Filter.sort`, `Filter.statuses`, and `Filter.document_hashes` apply in the same SQL eligibility query used by `documents_page`; empty hash lists intentionally return zero documents. `semantic_library_page` returns workspace/project-wide status counts. Focused test `document_page_sorts_and_filters_before_limit_with_project_counts` passed for cross-page order, status filtering, empty/one hash filters, project isolation, and invalid sort rejection.


Added-date follow-up: migration12 adds nullable `documents.added_at`; an INSERT trigger timestamps future imports only. `Document.addedAtMs` is exposed in listings. Test `import_timestamp_is_immutable_and_historical_unknown_is_null` passed. Historical dates are intentionally unknown.

## Remaining behavioral limits

- All-workspace results are grouped by workspace rather than globally merged by the requested sort. Within each workspace SQL sorts before pagination.
- Activity details and bulk checkbox actions are explicitly scoped to the loaded page; counts cover the entire workspace/project.
- Formula display updates locally, but canonical searchable formula values need explicit refresh; dependency propagation is not automatic.
- Audio/video transcription, image recognition, web extraction and media-specific playback/locations are not implemented. Supplied text is indexed and source entries persist.
- AI fills and semantic tag proposals require a configured provider. Crossref and available open-access PDF retrieval are real network actions; coverage depends on the reference and provider response.
- Exact/semantic retrieval provenance is not currently exposed as a result class in the UI. Literal highlighting is accurate and does not pretend to identify which retrieval engine produced a hit.

Final packaged verification passed using `KEY_ELECTRON_EXECUTABLE=.../release/mac-arm64/Key.app/Contents/MacOS/Key`: `/tmp/key-packaged-tabs-final.log` records 30 frames with zero neighbour travel and four native bounds checks; `/tmp/key-packaged-comments-final.log` records canonical edit/reload, opaque editor, narrow bounds and dark mode. Screenshots were inspected directly. The tab test waits for both PDF readers to finish attaching before dragging, and avoids screenshots during pointer capture because capturing an Electron window interrupted the drag in the preliminary test.

Final entry-form polish was checked in the rebuilt packaged app: `/tmp/key-final-packaged-entry.log` confirms note/dataset creation, custom-property persistence after reload, live search highlighting, provider configuration without inference, and bounded checkbox widths. The final provider form screenshot was inspected directly.
