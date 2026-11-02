# Key: beUI design system and migration plan

Status: implemented 2026-09-13; validation and intentional adaptations below. Audited 2026-09-13 against Key commit ed8afe4 and the public beUI catalog, registry, theme source, and representative component implementations. Scope: every application interface below the native/tab chrome.

## Recommendation

Adopt beUI as the visual and interaction foundation, exposed through a Key-owned shared component package. Use one vocabulary for spacing, typography, surfaces, shapes, states and motion, including custom components and any headless accessibility primitives we bring in. Preserve the established library information architecture and all working behavior.

beUI is a copy-and-adapt component collection, not a complete application design system. Its public registry currently contains 117 entries including variants and compound blocks; the site groups these into 42 motion component pages, 23 block pages and 17 agent pages. The catalog is broader than buttons and cards. However, some demos are deliberately expressive, some specialized controls are absent, and Electron overlay ownership needs application-specific integration.

This audit inspected the whole registry's inventory, source for button/input/combobox/context menu/sidebar/upload/modal/tooltip/badge and theme definitions, and the rendered input preview. It does not claim that every upstream component has been interaction-tested. Our existing adapted table/drawer have separate packaged-app validation.

## Scope and boundaries

Included: Home, workspace/project navigation and appearance, PDF/reference libraries, all-items/database views, search results and filters, metadata/property management, notes/pages, agent fill/settings/proposals, imports/indexing/activity, errors/empty states, PDF toolbars/find/outline/thumbnails/comments/annotation controls, and Office editor toolbars, dialogs, panels and settings.

Excluded: the 40px app tab strip, traffic lights, tab/split drag geometry and chrome controls. Native system dialogs remain native. PDF pages, authored document content, spreadsheet cells and slide artwork retain their document typography/colors; only their surrounding application controls adopt the system.

The sidebar remains transparent against the view background, disappears completely when collapsed, and keeps the workspace selector/add action in its dropdown. Do not inherit beUI's collapsed icon rail or bouncing sidebar behavior, since those conflict with established Key interactions.

## Component decisions

| Key need | beUI starting point | Adaptation / decision |
|---|---|---|
| Primary, secondary, quiet and icon actions | Button; Stateful Button | Shared sizes and async states; keep button footprint stable during Save/Retry. No magnetic movement or metallic effects. |
| Search, names, URLs, provider settings | Input | Label, help, error and optional prefix/suffix; compact variant. Validation after blur/submit; avoid error shaking on every edit. |
| Small fixed choices | Select | Stable anchored dropdown; restrained entrance. Keep native select fallback where it performs better. |
| Workspaces, projects, property/relation targets | Combobox | Searchable grouped choices with icon/color; async and virtualized option adapter for large sets. Workspace creation and appearance actions remain explicit. |
| Tags, authors, collections, multi-value fields | Multi Select | Removable tokens, keyboard deletion, overflow count, lazy option loading. |
| Boolean values and preferences | Checkbox, Switch, Radio | Checkbox for record values; switch for immediate settings; radio for mutually exclusive configuration. |
| In-view navigation | Tabs (segment/pill), Shared Layout Background | Table/list and source-category views. Never replace application tabs. |
| Workspace/project hierarchy and PDF outline | File Tree; selected Animated Sidebar/AI Sidebar primitives | Keep Key scope model, complete collapse, transparent surface and existing ownership. Use tree semantics only for real hierarchies. |
| Row actions, menus, hints | Context Menu, Tooltip, Morph Popover | Shared keyboard/escape/typeahead behavior. Add a menu-button trigger for overflow menus. Prefer simple surface reveal over goo/SVG filters. |
| Global properties and settings | Drawer | Continue current global host, section layout and nested agent slide. Promote overlay ownership into a general service. |
| Short confirmations and multi-step tasks | Morphing Modal / Center Morph Modal | One common Dialog API with focus restoration, busy behavior and nested-overlay rules. Verify focus trapping rather than assuming demo code is sufficient. |
| Source, project, recent-item, metadata and comment cards | Custom Surface/Card composition | Plain beUI-colored surfaces, borders and radii; shared header/body/footer, selected, clickable and quiet variants. Tilt Card/Card Folder/Wallet Card are not suitable general content-card bases. |
| Tables and database views | Table, Editable Table, Async Table | Extend current adapter to references/all-items; retain server sorting, canonical properties, selection, resizing, pinning and search semantics. No replacement of backend paging by a demo array. |
| Search passages and metadata previews | Custom ResultRow + Card + Badge + Disclosure | Stable title/metadata/snippet hierarchy; real exact-match marks, shared yellow navigation and existing split preview. Avoid morphing the whole results pane for each keystroke. |
| Section expansion | Bouncy Accordion mechanics | Damped Disclosure variant; independent sections where useful. No repeated bounce while indexing updates. |
| Status, counts, notifications | Animated Badge, Loader, Toast Stack | Quiet text/icon for steady state; small active-work animation; actionable persistent errors. Real progress data, not animated fictional percentages. |
| File import and attachment queues | File Upload / Attachment Upload | Map local managed-copy/hash/extraction/indexing states to Key events. Never treat local indexing as a network upload or use demo timers. |
| Agent proposals and activity | Approval Card, Todo List, Agent Activity, Tool Result, Citations | Property-diff review, evidence links, per-item acceptance, batch application, cancellation and actual backend state. Preserve explicit provider/input choices. |
| Future conversational agent panel | Prompt Input, Message, Message Scroller, Streaming Response | Adopt when wired to real functionality; prevent streaming from pulling a reader away from history. Do not add mock chat just to use a component. |
| PDF zoom/page controls | Button + Input; optional restrained Stepper/Slider | Keep fit-width/page, numeric input and precise keyboard navigation. No wheel-picker interaction for routine page selection. |
| Comments and annotation editing | Custom CommentThread, CommentComposer, AnnotationTools | Use shared Field, Textarea, Button, Menu, Badge, Surface; preserve selection anchors, drafts, resolve/reply and focus. Chat bubbles alone do not implement anchored comments. |
| Date, color/emoji, formulas and relations | Custom controls plus existing engine/headless behavior | No suitable general calendar, formula editor or complete property system found in audited registry. Use shared field/popover/menu surfaces; adopt additional behavior primitives only where needed. |
| Empty/loading/error layouts, breadcrumbs, pagination, separators | Small custom semantic compositions | Same typography, spacing and actions. Skeletons preserve geometry; pagination preserves query/cursor and selection semantics. |
| Office editing interfaces | Shared tokens and primitives through adapters | Migrate ribbons, toolbars, side panels and dialogs by editor. Preserve complex editing engines and native document formatting. |

Other catalog components—shader/parallax backgrounds, marquees, text scrambling, cylinder carousels, prediction markets, wallet/tournament blocks, decorative folders, mobile swipe/pull-to-refresh and elaborate CTA gestures—have no current Key use case. Do not include their code or dependencies. Command Palette is a good future shell-independent content action surface; Morphing Search should be optional for quick-open, not the persistent library search field.

## Shared design language

Upstream facts: beUI uses Geist Sans/Mono, neutral semantic color tokens, subtle borders, rounded/pill controls and shared spring presets. Its base button sizes are 32/40/48px; Input is 44px with a pill shape. The following is our proposed desktop normalization, not a claim that upstream specifies every value.

| Token family | Proposed Key standard |
|---|---|
| Fonts | Bundle Geist Sans for application UI and Geist Mono for formulas/code. System fallback; no runtime Google Fonts requests. Keep document fonts separate. |
| Type scale | 12px metadata; 13px dense table/navigation; 14px controls/body; 16px section titles; 20px drawer titles; 24px page titles. Weights 400/500/600. Tabular numerals for counts/progress. |
| Spacing | 4px base; 4/8/12/16/24/32 steps. Label-to-field 8px, form groups 16px, section gaps/padding 24px. Dense rows may use 6px micro-spacing. |
| Sizes | 32px compact controls, 40px default buttons, 44px default fields. 32px icon targets with 16px icons. 40/48px table density modes; 64–72px two-line list rows. Change current 56px table default only after visual/scroll verification. |
| Shape | Pill radius for standalone buttons, search and one-line inputs; 8px compact cells/icon buttons; 12px grouped fields/textareas; 16px cards/popovers; 24px floating dialogs. Edge-attached drawers stay flush at the viewport edge. |
| Light surfaces | Start from upstream background oklch(99% 0 0), foreground 15%, card 97%, muted text 50%; border foreground at 6%, strong border 12%. |
| Dark surfaces | Start from upstream #151515 background, #1c1c1c card, 96% foreground, 62% muted foreground, white borders at 5%/10%. |
| Interaction colors | Neutral selection/hover and monochrome primary action. Dedicated focus token with verified contrast. Green/amber/red for meaning; strengthen text contrast where upstream example colors are too faint. |
| Context colors | Preserve user workspace colors and annotation colors. Keep temporary search yellow distinct from persisted highlights. Never infer status solely from color. |
| Elevation | Borders for embedded sections; one restrained shadow for floating popovers/cards; backdrop only for modal overlays. Avoid nested raised cards. |
| Motion | Upstream ease-out (.16,1,.3,1); panel spring 420/40/.5; shared-layout spring 360/32/.6. Hover/fade roughly 120–180ms; content transition roughly 180–240ms. Restrained press feedback; reduced-motion equivalent. |

The design should feel calm and tactile. Use beUI's continuity when a user opens, closes or changes a view; keep data updates and high-frequency reading interactions visually stable. Tooltip text must remain legible; inactive/disabled, error and focus states need explicit definitions.

## Component architecture

Create `apps/key-office/packages/design-system` (`@key/design-system`) as the public contract. Keep the existing GenOffice-derived `@key/ui` while migrating its callers; do not change global tokens underneath the chrome.

Layers:
1. **Foundations:** scoped `--key-ui-*` semantic tokens, fonts, icons, density and motion presets. One source produces CSS exports for every renderer.
2. **Primitives:** Button, Field/Input/Textarea, Select/Combobox/MultiSelect, Checkbox/Switch/Radio, Surface, Badge, Tooltip/Menu/Popover, Dialog/Drawer, Disclosure, Table and feedback components.
3. **Key compositions:** WorkspacePicker, ScopeBreadcrumbs, FilterBuilder, PropertyField/Editor, SourceCard/ResultRow, ProcessingRow, CommentThread, ProposalReview and editor toolbars.
4. **Adapters:** controlled data and events from existing workspace, search, reader and Office services. Primitives neither call IPC nor own document/workspace state.

Components import from the Key package, never directly from copied beUI files. Pin upstream source revision, retain MIT notices, record intentional changes. Support disabled/loading/error/empty/read-only states, refs, keyboard behavior, labels, density and portal container consistently. Prefer CSS for small transitions; tree-shake Motion and lazy-load heavy agent/code surfaces.

For missing behavior, first compose existing primitives/native elements. If a behavior requires a proven headless foundation, Radix is a candidate; use its unstyled behavior behind our API and beUI tokens. This is not permission to import another visual theme. A date picker requires a separate fit/accessibility assessment rather than an arbitrary new dependency.

Scope styling to `.key-ui-root` and themed portal roots. Each PDF/Office WebContentsView must load its own token/font bundle and receive theme/density updates; DOM inheritance does not cross process/view boundaries. Avoid global element selectors or Tailwind preflight leaking into tab chrome, PDF text layers, or editor canvases.

Overlay service distinguishes local popovers (inside one view) from global modal surfaces (over sidebar/all panes, below tabs). Reuse the existing native snapshot/hide lease for global modals. Anchor ordinary PDF menus in the PDF renderer; do not freeze both panes merely to show a tooltip. Verify clipping, stacking, escape order and focus across mixed splits.

## Migration sequence and completion gates

1. **Foundation and specimen screen.** Extract tokens; bundle fonts; create light/dark and compact/default examples covering every control state. Include representative source card, search hit, property form, comment and processing row. Compare with beUI and existing library layout. Freeze chrome screenshots as regression references.
2. **Shared controls and overlays.** Replace bare inputs/buttons/selects, normalize existing table/drawer, then property/agent settings, tags, workspace picker, menus and tooltips. Verify keyboard, draft preservation, rename, provider selection and nested overlays.
3. **Library, Home and navigation.** Apply surfaces/type/spacing; unify PDF/reference/all-items table styles, filtering and metadata panels. Keep the library layout and scope model. Verify rapid search, selection, paging, pin/resize/reorder, split result navigation and full sidebar collapse.
4. **Notes, properties and agent workflows.** Migrate page properties, formula/relation/value controls, proposal review, imports and activity. Distinguish reusable property definitions from per-item values; preserve canonical storage and actual job progress.
5. **Reader and comments.** Apply primitives to PDF tools, find, outline, thumbnails, annotation menu, inline composer and comments panel. Inspect typing, selection retention, anchored positioning, scrolling, rapid zoom and two-PDF splits. Never animate the PDF raster/text-layer layout.
6. **Office modules and cleanup.** Migrate shared ribbon/menu/dialog components, then docs/sheets/slides/markdown/HTML interfaces. Check editing shortcuts, clipboard, undo, IME, drafts and cross-view focus. Remove superseded CSS only after its final caller moves; document exceptions with owners.

Ship coherent screen groups rather than leaving two styles on the same page. A phase is complete only after visual inspection plus behavior checks in the packaged app. No backend rewrites are required for the design migration; backend feature additions remain separate work.

Performance gates: retain table virtualization and bounded renderer caches; no entrance animation per result/row on scrolling, no whole-tree layout animation, no Lenis replacement for native PDF/table scrolling. Suspend hidden-view animations, bound retained overlay/notification data, and coalesce progress UI updates. Measure typing-to-paint, scroll/zoom frame times, CPU at idle and memory after repeated open/close against the current build on the same machine. Treat >10% regression in repeatable p95 latency or retained memory as a blocker pending investigation; do not claim speed from component choice alone.

Accessibility/UX gates: complete keyboard use, focus return, correctly nested overlays, screen-reader names and error associations, reduced motion, verified contrast, long titles, empty/error/loading data, and 200% text scaling. Test narrow mixed splits as well as full width. Preserve existing backend/search tests; add interaction tests for migration risks rather than snapshots of implementation details.

## Sources

- [Public component registry](https://beui.dev/r/registry.json)
- [Motion catalog](https://beui.dev/components/motion), [Blocks](https://beui.dev/components/blocks), [Agent components](https://beui.dev/components/agents)
- [Theme tokens](https://github.com/starc007/ui-components/blob/main/app/globals.css), [font setup](https://github.com/starc007/ui-components/blob/main/app/layout.tsx)
- [Button](https://beui.dev/components/motion/button), [Input](https://beui.dev/components/motion/input), [Combobox](https://beui.dev/components/motion/combobox), [Context menu](https://beui.dev/components/motion/context-menu)
- [File upload](https://beui.dev/components/blocks/file-upload), [Approval card](https://beui.dev/components/agents/approval-card)
- [Radix unstyled primitives](https://www.radix-ui.com/primitives/docs/overview/introduction)

This proposal supersedes the older audit's recommendation to use GenOffice visual tokens throughout content. GenOffice chrome remains unchanged.


## Implementation and validation — 2026-09-13

The shared `@key/design-system` package now supplies bundled Geist fonts, scoped light/dark semantic tokens, density, motion, native control wrappers, fields with error associations, surfaces, badges, progress, empty/loading states, disclosure and checkbox. Library, workspace navigation, source/record properties, agent workflows and PDF controls consume those primitives and scoped adapters. Global dialogs use the existing native-view overlay lease beneath the tab chrome. All five Office renderers import the same foundation and explicit interface adapters.

Intentional adaptations: native Select remains the desktop choice; complex Office controls retain their existing editing implementations with scoped visual adapters. Table and drawer remain app-owned integrations because of virtualization and native view ownership. No decorative cursor/scroll effects, new calendar engine or backend feature changes were introduced. User document content and tab chrome retain their existing styling. This migration covers current interface surfaces, not every component in beUI's catalog.

Validation: Key and all five Office typechecks/builds, 46 unit tests, table virtualization/reorder/resize, global and nested drawers, comment save/reload/narrow/dark states, typed properties/formulas/agent recipes, source entries and search highlighting, all Office views in mixed splits, packaged light/dark specimens, and a 24-cycle PDF stress run. Search preview regression also checks shared navigation bounds, document replacement, retained query and split retention on dismissal. The validation JSON records results and stress scope.

The stress sample retained at most two PDF views and released all of them after close. It measures Electron processes and excludes Rust workers; it is not a universal latency or memory guarantee. A paired performance baseline, exhaustive screen-reader audit and 200% text-scaling audit were not performed in this migration; the broader gates above remain release-quality targets rather than claims of completed measurements.


## Typography/density correction — 2026-09-13

The initial migration left compact defaults and duplicated content rules in place. This follow-up removes generic content overrides, changes defaults to 40px actions/44px fields, centralizes the12/13/14/16/20/24 typography scale, and makes compact reader tools explicit. Reader citation/comment panels, property/agent forms, library navigation and Office panel/native controls now use the shared scale. Office ribbons allocate space for 32px controls; AI composers reserve enough height for multiline text. Document text and chrome remain outside the scale.

Added computed-style assertions for actual dialog fields, comment editor text/action height, and all five Office composers, alongside the existing rendered screenshots and functional table/search/drawer checks. This corrects the earlier claim that token/font integration alone completed the typography migration.
