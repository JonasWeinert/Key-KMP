# Key design system

Adapted from the MIT beUI public component registry and theme source, reviewed 2026-09-13: https://github.com/starc007/ui-components and https://beui.dev/r/registry.json.

Key owns the component API. Button, Input and surface compositions translate beUI shape, size, semantic colors and press behavior to native controls/CSS, avoiding a Motion instance per frequently rendered cell. Checkbox retains the upstream-inspired Motion implementation. Key's drawer/table adaptations remain in the Electron renderer because they integrate native view ownership and server paging. Existing Office/reader controls use explicit scoped adapters to preserve complex editing behavior. Native Select remains the desktop fallback; workspace search is a controlled searchable composition.

No runtime remote fonts or stylesheet requests. Geist font files are bundled through Fontsource and retain their SIL Open Font License in third-party notices. Upstream MIT notice is adjacent in BEUI-LICENSE.txt.

Import controls from @key/design-system. Import styles.css into each renderer, scoped by key-ui-root for app-owned content or key-office-ui for Office interface adapters. Document content and application tab chrome must not receive global resets. Use semantic --key-ui-* variables; UI adapters may alias older variables only inside interface containers. Density belongs to controls and view preferences, not document font sizes.

Every control supports native props/ref semantics; Button intentionally retains native form submit default. Use explicit type=button on auxiliary form actions. Inputs use density=compact/default while the native numeric size attribute remains available. Application code owns errors, async state, documents, permissions and IPC.
