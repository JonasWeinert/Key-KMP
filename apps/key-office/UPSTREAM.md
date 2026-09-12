# Upstream provenance

Apache-2.0 source cloned from https://github.com/genspark-ai/genoffice at de139a061537bea40f0cc81ef8f09a95f77ac52a.

Key modifies product branding and shell integration. Copyright and license notices are retained. The separately licensed `ee/` directory and upstream PDF application/converter package are excluded. Key uses its original PDF reader and Rust services. The replacement desktop entry point is `../key-electron`.

Key's `apps/key/src/renderer/TabBar.tsx` and `tabbar.css` also retain the upstream shell's tab-strip implementation and icon artwork. Its pointer-capture drag algorithm, live neighbour transforms, overflow controls and appearance are connected to Key's owned tab groups. Unlike upstream's fixed Home slot, Key's Home tabs are movable; split groups reorder as indivisible units.
