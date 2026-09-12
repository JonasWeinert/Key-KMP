# Properties, search previews, and tab drops

Implemented September 13, 2026 on the Electron workspace branch.

## Property editing

The sources table has a property manager for visibility, ordering, pinning, editing,
and deletion. Headers and cells open the same typed property editor. Text, number,
checkbox, select, and formula definitions are shared by the workspace. Creating or
changing a definition does not overwrite item values: applying to selected sources
is a separate explicit control. Select options are editable chips. Formulas have
reference insertion, immediate example previews, and explicit materialization.

Notes and pages expose typed property rows instead of raw JSON. Their values stay
in the revision-checked item draft until Save. Unsupported existing structured
values are retained, rather than converted into strings.

Renaming is one SQLite transaction across definitions, PDF properties, record JSON,
recipes, and provenance. Formula references and saved database property filters
are rewritten; FTS projections follow the existing triggers. Record revisions
increment. Name collisions, ambiguous aliases, and unsupported formula rewrites
abort the transaction. The active record editor preserves unsaved body and property
edits, rebasing only the expected rename revision. Unrelated concurrent changes
remain a conflict rather than being overwritten. Other open drafts retain the
ordinary revision conflict protection.

Agent properties persist their recipe in the canonical attribute configuration.
Users choose permitted context inputs and instructions, generate suggestions, then
review and apply them. Saving a recipe or enabling it never starts inference.
Existing limits remain: at most 25 PDFs per fill, two concurrent requests, bounded
text context. Live generation requires a configured provider. Non-PDF generation,
relations/rollups, and automatic formula dependency propagation remain future work;
formula values update only when explicitly calculated/applied.

## Search previews

A click opens the matched PDF beside the originating sources view. Source metadata
replaces the old passage preview. A yellow navigation bar spans both panes and
moves between passages/documents; the current temporary preview is replaced instead
of accumulating tabs. Existing user-owned documents displaced by a preview remain
available as tabs. The source pane retains its search state.

Dismissal removes the navigation/highlight but preserves both panes and the query.
Each sources view owns its own bounded preview session. Sequence checks ignore stale
asynchronous resolutions, and switching away does not let a late response steal
focus. Native PDF/Office bounds and DOM pane bounds use the same navigation offset.
At narrow split widths, source metadata becomes a compact expandable summary above
the list instead of squeezing the result text into a small column.

## Tab gestures

- Drag past a tab quickly or along its edges to reorder.
- Hold over the centre of a single tab to arm a split.
- Hold over a specific half of a split tab to arm a swap.
- Drag a split half out of the bar to separate it.
- Drag the split group badge to move the whole group.
- Escape cancels; Alt+Shift+Down separates the focused half.

The target is outlined and a chrome-level message names the pending drop operation.
The dwell delay avoids accidental splits during normal reordering. Target geometry
stays stationary while armed, and feedback sits above native web contents. All
operations preserve the single-owner invariant for views and their drafts.

## Verification

Meaningful unit coverage includes ownership-preserving split/swap/detach operations,
preview replacement, property drafts/column migration, formula evaluation, and
bounded recipe inputs. SQLite tests cover atomic rename, collision rollback, FTS,
formula literals/references, record revisions, and Unicode names.

Electron smoke scripts exercise real pointer gestures, native PDF bounds, search
preview replacement/dismissal, typed property persistence, rename with unsaved
edits, recipe persistence without provider requests, and stable reorder release
frames. Run GUI scripts serially with isolated profiles; rebuild the shell before
running, and rebuild/package the Rust host when its code changes.
