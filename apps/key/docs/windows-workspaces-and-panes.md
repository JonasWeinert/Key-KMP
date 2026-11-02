# Windows, workspaces and panes

Design note for how the Electron app (`apps/key-office/apps/key`) arranges workspaces, windows, tabs and splits. It records the options we considered, the model we chose and how it is implemented.

## Where we started

- Several `BrowserWindow`s share one main process, one workspace registry and one set of owned views (`views` in `src/main/index.ts`). A document is open at most once. Its native `WebContentsView` moves between windows without reloading.
- Each window has a strip of tabs. A tab holds one view, or two views side by side (`viewIds: [a] | [a, b]` with one `splitRatio`). Tabs can be reordered, split by dropping one onto another, swapped and separated. They can also be moved to another window from the context menu.
- Windows were not tied to a workspace. The sidebar followed whichever view had focus, so a window could show records from several libraries and the sidebar jumped between them.
- Nothing was restored on relaunch.

## Questions

1. **Workspaces and windows.** Should a window show one workspace, or work like VS Code, where a window opens a workspace and switching replaces it?
2. **Tiling.** Should splits be freely nested, or work like VS Code editor groups?

## What matters for Key

- **Research sessions are arrangements.** A typical working set is a reader with its source page and a note, or two papers side by side with notes below. People switch between whole arrangements more often than they swap one document inside a fixed frame.
- **Libraries are separate.** Every workspace has its own `key.db`, collections and notes. Mixing them in one window, with a sidebar that changes under the user, causes mistakes such as filing a note into the wrong library.
- **macOS conventions.** The title bar holds a single tab strip next to the traffic lights, as in Safari, Finder and Ghostty. Each window represents one document or place, and its title says which one. Cmd-click and Option-click open things in a new window. Shortcuts follow Safari and iTerm2 or Ghostty: Cmd-1…9, Cmd-Shift-[ and ], Cmd-D style splits, and Cmd-Option-arrows to move between panes.
- **Native views.** PDFs and Office editors are native `WebContentsView`s stacked above the shell DOM. Each additional visible tab strip has to be laid out around them, and any DOM drawn over them, such as a drop preview, needs the captured-frame overlay that modals already use.

## Options

### A. A window may hold any workspace (the old behaviour)

The fewest rules. But the sidebar has no stable subject, "new note" goes wherever the last focus was, and the window title cannot name a library. Rejected.

### B. One workspace per window, VS Code style

A window shows one workspace. The switcher in the sidebar replaces the window's contents. The arrangement you leave is saved and returns when you switch back. Cmd-click or "Open in New Window" opens the workspace beside the current one. If another window already shows that workspace, the switcher brings that window forward instead of opening the workspace twice.

- **Benefits:** the sidebar, new items and the window title always refer to one library. Several libraries can stay on screen in separate windows, each with its own arrangement. The Window menu lists them by name.
- **Costs:** switching closes the views it leaves. Their arrangement is restored on return, but PDFs reload and unsaved record drafts trigger the usual discard prompt.

Views that belong to another workspace, such as results from a search across all workspaces, can still open in a window. They keep their own `workspaceId` and do not change the sidebar.

### C. VS Code editor groups

The window body is a grid of groups, and each group has its own tab strip. Tabs move between groups, and a group can split in any direction.

- **Benefits:** very flexible for one-document-at-a-time editing.
- **Costs for Key:**
  - It breaks the single title-bar tab strip that the shell and its smoke tests are built around.
  - Every group needs its own strip laid out around the native views.
  - Switching what you are working on means changing each group separately, which works against arrangements.
  - Each group's strip spends vertical space that PDFs need.

### D. Tabs that hold split layouts (Ghostty, iTerm2, Arc)

Keep the single title-bar strip. Each tab owns a layout tree: panes split left/right or top/bottom, nested to any depth, and each split has its own draggable divider. Drag a tab or pane onto an edge of a pane to split there, onto its centre to swap, or out of its group to separate it. Panes move between tabs and windows. A tab is an arrangement, so Cmd-1…9 switches whole arrangements.

This extends the existing two-pane split tabs instead of replacing them. All existing gestures still work, and the two-pane case behaves exactly as before.

## Decision

**B + D: each window is bound to one workspace and switches in place, and each tab holds a freely nested split layout.**

VS Code's model is good for code, where one file is edited at a time. Key's unit of work is a reader beside its notes, which is an arrangement, so tabs should hold arrangements. Option D gives arbitrary nested splits, drag-to-split from any edge, and moving panes between tabs and windows. It keeps the macOS title-bar strip and the native view geometry we already verify, and it does not add a tab strip to every pane.

The one thing D lacks is a stack of tabs inside a single pane, as VS Code groups have. In practice that is covered by opening into a Home pane (below) and by Cmd-1…9. If people ask for it, it can be added later as "pane history".

## Behaviour

### Windows and workspaces

- A window always has a workspace. Its sidebar, new notes and pages, imports, and the window title use that workspace.
- The workspace switcher, and **File › Switch Workspace** (Cmd-Shift-O), replace the window's workspace. The tabs being left are checked for unsaved changes, saved as that workspace's arrangement and closed. The target workspace's saved arrangement is then restored, or its Sources library opens if it has none.
- If another window already shows the target workspace, that window comes forward instead.
- Cmd-click or Option-click a workspace in the switcher, use its "open in new window" button, or use **File › Open Workspace in New Window** to open it in a separate window.
- **File › New Window** (Cmd-Shift-N) opens a window on the current workspace. Popping a tab out keeps its workspace, so several windows can share one workspace. Each window still shows only one.

### Panes

- **Split.** Drop a tab or pane on the left, right, top or bottom edge of a pane. The edge band is a quarter of the pane, at most 80 px. A translucent preview shows the half the pane will take. Pressing a tab shows it, so a tab dragged below the strip brings back the tab it was dragged from, which is the one you are dropping into. While a drag is over the content, native views are swapped for still frames so the preview can be drawn over them. **View › Split Right** (Cmd-\\) and **Split Down** (Cmd-Shift-\\) add a Home pane beside the focused one.
- **Home panes are launchers.** Anything opened while a Home pane in a split has focus replaces that Home pane in place, like a browser's new-tab page. Otherwise it opens in a new tab.
- **Swap.** Drop a tab onto the centre of a pane, or onto a pane chip in the strip.
- **Separate.** Drag a pane out of its group, use Alt-Shift-Down on its chip, use **View › Move Pane to New Tab**, or use the Separate button, which separates every pane.
- **Resize.** Each divider can be dragged. Arrow keys move a focused divider and double-click resets it to half. **View › Reset Pane Sizes** resets every divider in the tab.
- **Focus.** Use Cmd-Option-arrows to move to a neighbouring pane, chosen by position. Clicking a pane also focuses it.
- **Close.** Cmd-W closes the focused pane, or the tab if it has a single pane. **File › Close Tab** (Cmd-Option-W) closes the whole tab, and **Close Window** is Cmd-Shift-W.
- **Tabs.** Cmd-1…8 selects a tab, Cmd-9 selects the last tab, and Cmd-Shift-[ and ] select the previous and next tabs.
- **Office editors.** While a Docs, Sheets or Slides editor has focus, it installs its own menu bar, so these View shortcuts are not available until focus leaves it.
- **Windows.** Moving a tab to another window works from the tab context menu and **Move Tab to New Window**. Dragging a tab or pane out of the window tears it off into a new window.
- A tab holds at most 8 panes. Each split ratio is kept between 10 % and 90 %.

### Persistence

`window-state.json` in the user-data folder stores:

- each window's workspace, frame, sidebar width and tabs;
- the arrangement last left behind in each workspace;
- a list of recently used workspaces, shown in the File menu.

Each tab is saved as a layout tree of descriptors: Home; a content view (section, workspace, project, note, source or record id, and title); a PDF (workspace and content hash); or an Office file (kind and path). Unsaved new records and untitled Office documents are not saved.

The file is written shortly after every change and once more when quitting, before any window starts closing its tabs. At launch every saved window is restored on its workspace. A saved frame that no longer fits a connected display keeps its size, and the window opens at the default position. Views that can no longer be resolved, such as deleted notes, are dropped. A window that ends up empty gets Home. `KEY_NO_WINDOW_RESTORE=1` starts without restoring, for tests that reuse a profile.

## Implementation map

- `src/shared/tab-model.ts`:
  - The `PaneLayout` binary tree on each `WorkspaceTab`. `viewIds` lists its leaves in reading order, and `splitRatio` mirrors the root split.
  - Pure operations: split at an edge, remove, swap, set a ratio by path, find a neighbour, and compute pane and divider rectangles.
  - The main process (for native bounds) and the renderer (for DOM panes, dividers and drop zones) use the same `layoutPanes()`, so the two always agree to the pixel.
- `src/main/window-state.ts`: reads, validates and atomically writes the saved state, and clamps frames to displays.
- `src/main/index.ts`:
  - `ShellWindow.workspaceId`, `switchWorkspace()`, and serialising and restoring tabs.
  - Pane actions, plus the File and View menus with their shortcuts.
  - The window title, and recently used workspaces.
- `src/renderer/App.tsx`:
  - The sidebar's workspace comes from the window.
  - DOM panes and dividers are placed from the layout.
  - Drag targets in the content area are worked out here, with captured frames over native views while dragging.
- `src/renderer/TabBar.tsx`: pane chips for any number of panes, dragging into the content area, and tearing a tab off into a new window.
- `src/renderer/WorkspaceSwitcher.tsx`: open in a new window, and marks workspaces already open in another window.

## Verification

- `smoke-tabs.cjs`:
  - nested splits: three panes, horizontal and vertical;
  - native bounds against every divider;
  - resizing a nested divider, with the mouse and the keyboard;
  - moving focus between panes by direction;
  - a Home pane replaced by what it opens;
  - Cmd-W closing one pane;
  - the menu shortcuts.
- `smoke-tab-drops.cjs`:
  - dropping a tab on a reader's right edge splits beside it;
  - the preview is drawn over a still frame while the native view is hidden;
  - dragging a pane to a bottom edge re-arranges its own group.
- `smoke-windows.cjs`:
  - windows bound to a workspace;
  - switching in place and back restores the arrangement;
  - opening in a new window, and focusing a window that already shows the workspace;
  - tearing a tab off into a new window;
  - restoring windows, frames, layouts and ratios after relaunch.
