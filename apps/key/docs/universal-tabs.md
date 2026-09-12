# Universal tabs and mixed splits

Library scopes, all-item lists, notes, pages, saved database views and reference/media entries participate in the same main-process view ownership model as PDFs and Office documents. Sidebar navigation opens or focuses an owned view; it no longer replaces a global editor. A record has one owner per workspace regardless of the project used to reach it. Workspace/project library scopes have distinct owners. New, unsaved records have independent identities; saving transfers their identity to the canonical record ID.

The split picker lists other singleton tabs. Either pane can contain any supported view type. Focus, swap, separate, reorder, close and ratio changes operate on view IDs. Split groups remain limited to two panes. PDF back navigation remembers the originating content view.

## Rendering and lifetime

`WorkspaceContent.tsx` retains each lightweight content view in the shell renderer. Hidden panes keep their drafts, input state and scroll containers; library polling/search and record-list refresh are gated by visibility. These tabs do not create additional Chromium renderers. Closing a tab unmounts its component. PDFs and Office editors retain their existing native WebContentsViews and lifecycle policies, including the two-resident-PDF limit.

DOM panes and native views occupy the same content rectangle below the 40px chrome, beside the current sidebar width, with a 6px divider. DOM panes contain their dialogs so a modal does not extend under an adjacent native editor. The sidebar follows the focused view's workspace/project context.

The main process's `home` renderer category means shell-rendered content; snapshots expose the actual content type for tab icons. Content descriptors carry initial canonical record data; local drafts stay in the retained component. Saves update SQLite and the descriptor for a subsequent renderer reload. Tab/draft restoration across application restarts is not introduced by this change.

## Saving and closing

Record tabs use revision-checked canonical saves; source entries keep their specialized metadata and indexing commands. Save and Cmd/Ctrl+S act on the focused record. Dirty state is tracked per owned view. Closing a group checks every pane before disposing any, so cancellation preserves its other view. Office saves continue to use their native editor guards.

## Verification

- `smoke-mixed-tabs.cjs`: library/note split, unsaved draft retention, saved-record ownership, shared renderer count, note/PDF split, pane focus, swap/resize/sidebar bounds and cancel/discard close paths.
- `smoke-office.cjs`: all five Office editor types alongside the library.
- `smoke-ui.cjs`: canonical note/database saves and reload.
- `smoke-source-entries.cjs`: typed source metadata and entry tabs.
- `smoke-tabs.cjs`: PDF group dragging and native view geometry.
- Existing library and Office-close smoke tests cover search navigation and native save guards.

Run GUI smoke tests serially with an isolated KEY_USER_DATA and KEY_WORKSPACE_PARENT (the scripts provide these). `smoke-mixed-tabs.cjs`, `smoke-office.cjs` and `smoke-tabs.cjs` also accept KEY_ELECTRON_EXECUTABLE for the packaged app.
