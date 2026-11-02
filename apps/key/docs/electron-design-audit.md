# Electron design and integration audit

Audited 2026-09-12. Upstream GenOffice commit: `de139a061537bea40f0cc81ef8f09a95f77ac52a` from https://github.com/genspark-ai/genoffice. This document describes the inspected baseline and implementation recommendations, not a declaration that every proposed feature ships.

## References and visual inspection

Both supplied mock versions are preserved under `inspo/library-mock/`: `Key Library.dc.html` and `Key Library v2.dc.html`, with their support script and original design bundles. Extraction validated every archive path against the destination. Assume v2 is primary, because it is the explicitly versioned, more complete design. The original ZIP remains intact.

The archive's embedded WebP thumbnail was visually inspected: a compact desktop tab strip, approximately 224-pixel sidebar, table/list toggles, inline search/filter/sort/Add toolbar, title and counts, and dense reference-manager rows. The local HTML browser URL was blocked by browser policy; no workaround was attempted. The interactive behaviors below were inspected in HTML/source, not exercised in a live rendered prototype. This distinction matters when treating the mock as acceptance evidence.

Keep the mock's layout and information hierarchy, but replace its Modernist/Nocturne fonts, red/blurple accents and design tokens with GenOffice chrome. The source uses a 36-pixel mock tab strip; GenOffice uses 40 pixels, and its real shell metrics should win.

## Layout to carry forward

- Top-level browser-like tabs with Home as the New Tab destination. Preserve document ownership globally across panes; switching location must not duplicate a reader instance.
- Home global navigation holds workspace selection, including All Workspaces. Sidebar represents the selected scope and project rather than an ambiguous mix of unrelated folders.
- Sidebar has Sources/Library, Open, Needs attention, Removed; projects below workspace identity; tags and collection filters are secondary. Show a clear breadcrumb for Workspace → Project → View.
- Title/count sentence above a compact table/list toolbar. Search replaces the source list with grouped passage results, preserving library context for return.
- Table rows expose title, authors, year and selected properties. Two-line list mode puts title/open marker above muted metadata, with processing in a stable separate region.
- Single-click selects; double-click/Enter/explicit open opens the source. Side peek shows details, activity, or result preview. The mock collapses its sidebar when a pane opens: treat this as a narrow-width adaptation, not mandatory on roomy windows, because losing workspace orientation is undesirable.
- Search group header identifies document; each passage retains its page target. Exact-word marks only when match evidence supports them. Semantic relevance must not invent a literal match.
- Temporary result highlight remains distinct from saved annotations. Back, Previous, Next and Dismiss preserve the query/result context.

## Functionality boundary

“Existing” means the pre-Electron Key Rust/Tauri baseline has a backing capability; transport/UI wiring still needs verification after migration.

| Mock element | Baseline support / implementation decision |
| --- | --- |
| PDF import, immediate reading, persistent library | Existing. Reuse Key import, content hashing, managed sources and reader. |
| Processing stages, per-file counts, pause/resume/retry | Existing. Bind actual progress; never replay mock timers against real sources. |
| Partial keyword readiness, no-text, missing source | Existing. Preserve accurate stage language and terminal no-text state. |
| Global passage search and pagination | Existing. SQL eligibility + Tantivy/vector search; preserve cursor and cap semantics. |
| Author/year/tag/collection/annotation/metadata/property filters | Existing. Scalar property equality, not arbitrary formula queries. |
| Metadata title/authors/year; tags/collections; scalar properties | Existing. Avoid invented publication/venue/date data when absent. |
| Remove, Undo/Restore, explicit permanent deletion | Existing backend lifecycle. Preserve open-document and processing safeguards. |
| Relink original content | Existing content identity checks; never transfer annotations to a different PDF. |
| List/table switch, grouped results, side peek, chips, scopes | Layout/UI improvements that can use real existing data. |
| Pinnable/resizable columns and bulk selection/actions | Proposed UI behaviors; mock unless explicitly implemented/tested. |
| Publication, source type, date added columns | Mock where no canonical field exists; do not manufacture realistic values for real files. |
| Library-wide property schema with select/formula types | Mock/roadmap. Current scalar custom-property API is not this schema engine. |
| Agentic property filling; per-cell/selection/column runs; editable prompts | Mock/roadmap. No actual model call, billing implication or fabricated completion. |
| Fill empty bibliographic metadata from PDF | Mock/roadmap until provider/provenance/resolution flow exists. |
| DOI/BibTeX/RIS reference import, Get PDF / open-access lookup | Mock/roadmap. Do not imply a reference without a source has indexed full text. |
| Video/podcast transcripts, website snapshots, image descriptions | Mock/roadmap. Existing PDF extraction must not be presented as supporting these. |
| Tag merge/rename/delete consolidation or AI suggestions | Mock/roadmap unless backed by canonical operations. |
| User databases, relations, formulas, rollups, saved views | Roadmap model. Workspace/project foundations are separately requested real work. |

Mock controls should visibly say “Preview” or “Planned” and open an explanatory mock view. Mock rows belong in a separate demo context; never intermingle them indistinguishably with user library data. Roadmap dialogs should identify what is missing, rather than pretending an operation succeeded.

## GenOffice integration map

| Upstream path | Role / integration guidance |
| --- | --- |
| `apps/shell/src/main/index.ts` | Electron app lifecycle, windows, native menus, IPC and editor registration. Large suite-specific coordinator; retain only relevant behavior. |
| `apps/shell/src/main/tab-manager.ts` | Owns Home plus document `WebContentsView`s. Baseline shows one active view, so replace visibility/layout assumptions for Key split panes and shared view ownership. |
| `apps/shell/src/shared/tabs-api.ts` | Typed shell tab bridge; suitable contract reference. |
| `apps/shell/src/preload/index.ts` | Narrow context-isolated bridge reference. Keep Rust service access in main process and expose typed methods only. |
| `apps/shell/src/renderer/src/TabBar.tsx` | Chrome-style tabs, drag reorder, close, overflow. Adapt product identity and events. |
| `apps/shell/src/renderer/src/tabbar.css` | 40px strip, 34px tabs, max 240px/min 104px width, 78px macOS traffic-light space, rounded active tab feet. |
| `apps/shell/src/renderer/src/AppFrame.tsx` | Shell chrome versus child-view layering. DOM overlays do not automatically paint over child WebContentsViews. |
| `packages/ui/src/tokens.css` | Canonical light/dark surface, border, text, hover and semantic tokens. Prefer direct vendored tokens over imitating colors. |
| `apps/{docs,sheets,slides,markdown,html}` | Apache office editors; preserve source for later staged integration instead of silently promising they are all live. |
| `apps/pdf`, PDF conversion helpers, `packages/pdf2docx` | Do not route Key PDF open/render/search through these; Key PDF stack replaces upstream PDF behavior. |

Recommended vendoring: a provenance-stamped Apache upstream snapshot under `vendor/genoffice`, with the active Key Electron integration under `apps/key`. Keep notices adjacent to vendored source; explicitly document modified/adapted files. Avoid a second nested Git repository. Keep editor boundaries modular rather than renaming Rust crates to suit the JavaScript monorepo.

Public-facing product title, package/application identifiers, UI strings, icons, menu labels and storage defaults should be Key. Historical copyright, attribution, repository provenance and license text must retain original names. A blind global replacement of “GenOffice” would damage those notices.

## License boundary

Root LICENSE is Apache-2.0. Root README explicitly excludes `ee/`; `ee/LICENSE` allows development/testing only and requires an enterprise agreement for distribution/production. Exclude the entire `ee/` tree from the Key integration and distribution. Preserve Apache LICENSE and NOTICE for copied source, include modification notices, and regenerate dependency/font notices for the actually bundled modules. Root NOTICE mentions Unicode mapping specifically in upstream PDF code; do not claim that discarded mapping is used by Key.

The inspected files establish this concrete source boundary; this is an engineering provenance record, not legal advice.

## Workspace and project assumptions

The user’s requested workspace/project model supersedes the mock’s simpler collections sidebar:

1. A workspace is a chosen filesystem root with its own canonical SQLite database and managed sources. Default creation parent is `~/Documents/Key`; never silently move an existing personal library.
2. A project is a workspace subfolder plus a canonical project record and membership filter. A source always belongs to its owning workspace and can join multiple projects without duplicate indexing inside that workspace.
3. Linked folders are references, not copied projects. Track imported file metadata/content hashes in the owning workspace, apply project membership, and show disconnected/missing folder states explicitly.
4. All Workspaces is a federated view over workspace databases, not a new authoritative database. Item identity must include workspace ID plus item ID/hash, since identical files can have independent workspace annotations.
5. Notes/pages/documents/databases belong in the same workspace model. Flexible records can use small property-ID-keyed JSON with typed indexes and relation edges. Formula dependencies require metadata revisions; PDF hashes alone are insufficient invalidation keys for user edits.
6. Keep project identity separate from an ordinary tag/collection label. Moving or renaming a folder should not change immutable workspace/project IDs.

## Acceptance checks after integration

Verify real import → immediate reader → indexing → search → passage highlight, context return, metadata save and restore in Electron. Verify two panes, duplicate-open reuse, tab close without library deletion, switching workspace while a PDF remains open, project membership in two projects, and cross-workspace isolation. Check long title overflow, narrow window side peek, keyboard focus, dark theme, and empty/failed/missing/no-text states. Test total process-tree memory, not renderer heap alone, and ensure hidden tabs do not accumulate unlimited active viewers.

## Integration handoff (2026-09-12)

The active implementation now lives in `apps/key-electron`. Apache office editor sources and shared packages live in `apps/key-office`, with the Electron package included by its `apps/key` link. The original GenOffice shell was removed after checking active editor imports; its one-view manager and PDF/conversion paths are not part of the new shell. Old upstream end-to-end tests are retained as reference, but are not advertised as runnable Key qualification. Root dev/build/mac distribution scripts target `@key/electron`; obsolete PDF/shell workspace commands are removed. Windows/Linux distribution shortcuts are withheld until configured and qualified.

Implemented renderer wiring: GenOffice-style 40px tabs, 56px workspace navigation, 224px scope sidebar; projects; persistent library table/list; source search and details; revision-checked note/page editing; office creation actions; linked-folder action; source and page project membership. The library stays mounted when opening a reader so query, result and scroll context survive returning. Import requires choosing a destination workspace from All Workspaces. Final packaged integration tests remain necessary; source-level implementation and a standalone strict TypeScript check are not equivalent to end-to-end qualification.

Still explicit previews: formulas, relations/rollups, full user-defined database schema/views, agentic filling, provider metadata enrichment, references without PDFs, non-PDF semantic transcript/image pipelines, column pin/resize and advanced bulk/tag consolidation. Notes/pages are plain-text editors at this stage; an item record called a database does not constitute an implemented formula engine.

Branding audit preserves upstream LICENSE/NOTICE, provenance and GitHub source links. Active office package app IDs use `dev.key.*`; root package scripts and new shell product title use Key. Some internal historical `genoffice` clipboard/debug/command identifiers remain implementation identifiers rather than visible branding; changing interoperating identifiers requires matching producer/consumer updates and is not a license-notice replacement.

### Database base and UI validation update

The previously proposed database base is now implemented: New database creates a canonical `database` record with a persisted `properties.view` filter (kind, text query, named property/value); its table reads workspace records in 100-record pages. A custom-properties JSON object editor saves values with revision conflict checks. `All items & linked files` queries canonical record text/metadata. Kind/property filters currently operate on loaded pages, and the UI states loaded/matching counts; this is not yet a global SQL filter planner or full typed property schema.

The library now reads `semantic_library_page` with 200-record pages and retains only the current page. Open/attention filtering and displayed readiness counts are explicitly page-local. Advanced formulas, relations/rollups, agentic filling, rich block editing and provider enrichment remain roadmap work.

Real Electron UI validation passed using `apps/key-electron/scripts/smoke-ui.cjs` and an isolated profile/workspace: created a note, saved boolean/number JSON properties, created and saved a database filtering notes by `reviewed=true`, verified the matching row, inspected canonical persisted records, reloaded the renderer, and reopened the saved database with its match intact. No renderer page errors were captured. The full-width library measured 1216px inside a 1216px content pane. Both the full-width Home and saved-database screenshots were personally inspected. Evidence directory: `/var/folders/1t/y4ljxp6s0cjd7r50jp5cwc7w0000gn/T/key-electron-ui-4hQMDe/`.

### Implemented mock functionality and final Library smoke

The later implementation replaces most earlier preview-only items: live debounced passage search with safely rendered literal matches; passage side peek and reader open/Previous/Next/Back context; canonical text/number/boolean/select/formula attribute definitions; inline scalar cell editing; persisted column hide/pin/resize/order preferences; page selection and bulk processing/removal/tagging; tag chips and an atomic global PDF tag manager; integrated reference/web/media entry tools and configured provider proposal/review/apply dialogs. Schema/record storage remains canonical SQLite. Formulas use a bounded deterministic interpreter, accept square or curly property references, and never execute JavaScript; live derived display is distinct from explicitly recomputed stored filter values. Automatic dependency propagation remains a stated limitation.

The final Library GUI test passed on the rebuilt Electron app: real PDF import, select attribute `Review=Reviewed`, formula `{Pages}+1` stored as 4 for a three-page PDF, column hiding, live query without pressing Search, two passage results with correct literal marks, single-click preview, open/highlight in native reader, Next/Previous result controls and Back preserving the query. `smoke-library-tools.cjs` writes evidence to `/var/folders/1t/y4ljxp6s0cjd7r50jp5cwc7w0000gn/T/key-library-tools-domt0V/`. Both preliminary screenshots and the final search-preview screenshot were personally inspected. Ten focused renderer tests cover safe exact-match rendering and the restricted formula interpreter; full Electron TypeScript checking passed.

Server-side source pagination now applies whole-workspace/project sort/status/open filters and returns whole-scope readiness counts. All Workspaces presents bounded workspace groups, with sorting explicitly labeled within each workspace. Optional Date added displays only the new nullable canonical timestamp; legacy records remain unknown rather than using last-updated dates.
