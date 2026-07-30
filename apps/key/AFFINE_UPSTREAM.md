# Preserved AFFiNE upstream

- Repository: `https://github.com/toeverything/AFFiNE`
- Branch: `canary`
- Integration: git submodule at `upstream-affine`
- Active surface: tab/workbench interaction and visual language only

AFFiNE remains unmodified and all of its routes, editors, collaboration
services, AI features, backend, and Electron host remain present in the
submodule. They are inactive because Key's Tauri entry point is its own
`src/main.tsx`.

This separation is deliberate. AFFiNE's current desktop tab implementation is
coupled to Electron `WebContentsView`; importing it directly would retain
Electron as a second desktop runtime and undermine Key's Tauri architecture.
