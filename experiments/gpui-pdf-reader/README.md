# GPUI PDF Reader experiment

This is the preserved native GPUI implementation that preceded Key's Tauri
application. It is a working experiment, not the active product.

The implementation established several important parts of the architecture:

- native PDFium rendering and text geometry;
- bounded tile scheduling and responsive zoom;
- sidecar-owned annotations;
- a capability-based extension host;
- typed, data-driven UI configuration;
- native macOS menus, windows, and accessibility integration.

Development moved to [`../../apps/key`](../../apps/key/) after the experiment
proved those ideas. Planned features benefit from the much broader TypeScript
component ecosystem, Tauri provides a more mature desktop lifecycle and
packaging foundation, and its supported webview targets make future
cross-platform work more practical. Building the same product in both GPUI and
Tauri would also require every interaction and feature component to be
maintained twice.

The experiment is therefore frozen:

- do not add new product-facing features here;
- keep it buildable for regression comparison and architectural reference;
- put renderer-neutral Rust improvements in the shared `key-*` crates;
- implement active product UI and integrations in `apps/key`.

## Run

From the repository root:

```sh
./scripts/fetch-pdfium.sh
cargo run --locked -p gpui-pdf-reader -- /absolute/path/to/document.pdf
```

For an optimized build:

```sh
cargo build --release --locked -p gpui-pdf-reader
./target/release/gpui-pdf-reader /absolute/path/to/document.pdf
```

The historical macOS packaging helpers remain available for validating the
experiment. They do not package or release Key.
