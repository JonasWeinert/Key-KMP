# Key design system

Adapted from the MIT beUI public component registry and theme source, reviewed 2026-09-13: https://github.com/starc007/ui-components and https://beui.dev/r/registry.json.

Key owns the component API. Button, Input and surface compositions translate beUI shape, size, semantic colors and press behavior to native controls/CSS, avoiding a Motion instance per frequently rendered cell. Checkbox retains the upstream-inspired Motion implementation. Key's drawer/table adaptations remain in the Electron renderer because they integrate native view ownership and server paging. Existing Office/reader controls use explicit scoped adapters to preserve complex editing behavior. Native Select remains the desktop fallback; workspace search is a controlled searchable composition.

No runtime remote fonts or stylesheet requests. Geist font files are bundled through Fontsource and retain their SIL Open Font License in third-party notices. Upstream MIT notice is adjacent in BEUI-LICENSE.txt.

Import controls from @key/design-system. Import styles.css into each renderer, scoped by key-ui-root for app-owned content or key-office-ui for Office interface adapters. Document content and application tab chrome must not receive global resets. Use semantic --key-ui-* variables; UI adapters may alias older variables only inside interface containers. Density belongs to controls and view preferences, not document font sizes.

Every control supports native props/ref semantics; Button intentionally retains native form submit default. Use explicit type=button on auxiliary form actions. Inputs use density=compact/default while the native numeric size attribute remains available. Application code owns errors, async state, documents, permissions and IPC.

## Typography and density contract

Body/form text uses `--key-ui-text-base` (14px) with 1.5 line height; supporting text uses `--key-ui-text-xs` (12px), compact tools/table content `--key-ui-text-sm` (13px), panel headings `--key-ui-text-lg` (16px), dialog titles20px and page headings24px. Authored document text is not part of this scale.

Button defaults to 40px and Input/Select to 44px. Opt into 32px compact density in toolbars; icon actions use square32px targets. Inline table fields retain tighter geometry under the table's explicit adapter. All dimensions are border-box. Use the existing 4/8/12/16/24/32px spacing tokens; don't re-declare generic primitive fonts/sizing inside a view stylesheet. Legacy controls require scoped adapters at their actual element, because native controls and font shorthands can break inheritance.

The design smoke checks measure real dialog fields and specimen controls; comments and Office smoke checks measure real editor/composer fonts and dimensions. These are separate from functional persistence and navigation checks.
