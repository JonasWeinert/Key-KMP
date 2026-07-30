# Key desktop application

This directory contains the active Key desktop application: a Tauri 2 shell
with a TypeScript/React workspace, PDF.js rasterization, and the repository's
native Rust/PDFium services.

AFFiNE's pinned source is retained in the `upstream-affine` submodule as a
workbench reference, but Key does not boot AFFiNE or its Electron shell.
Likewise, the embedPDF/PDFium-WASM path remains available only for older
comparison experiments; the packaged application opens the PDF.js workspace
by default.

## Runtime boundary

- **PDF.js** parses the visible document and paints bounded
  512-physical-pixel Canvas2D tiles.
- **PDFium** supplies the canonical character sequence and normalized geometry
  used by selection, annotations, search, links, references, and citations.
- **Rust preprocessing** starts alongside PDF.js. Initial document/text data is
  made available first; scientific analysis and metadata enrichment continue
  in the background.
- **OpenAlex and Semantic Scholar** results are merged by the native reference
  layer. Semantic Scholar requests are throttled and prioritized where they
  are most useful, including references without a DOI.
- **React/Tauri chrome** owns tabs, split views, per-document control state,
  floating panels, comment editing, citation cards, and native-menu routing.

Annotations are app-owned and never mutate the PDF. Their persistent anchors
use PDFium character ranges. The PDF.js view resolves normalized bounds from
the native character geometry and converts them into the current viewport when
painting.

Highlights and comments currently persist in versioned browser `localStorage`.
The storage call site is intentionally isolated so it can later be replaced by
a sidecar or SQLite implementation without changing overlay identity.

## Setup

From the repository root:

```sh
./scripts/fetch-pdfium.sh
cd apps/key
npm install
npm run tauri -- dev
```

The checked-in PDFium library is currently arm64 macOS. Set
`PDFIUM_DYNAMIC_LIB_PATH` to use another matching library.

The `upstream-affine` submodule is not required to build or run the current
reader. Initialize it only when comparing the retained AFFiNE source:

```sh
git submodule update --init --depth 1 apps/key/upstream-affine
```

## Frontend-only mode

```sh
npm run dev
```

Open `http://localhost:1420/?renderer=pdfjs-workspace`.

This mode is useful for visual and browser-interaction work, but it cannot call
the Tauri PDFium companion or scholarly lookup commands. Selection, PDF.js text
fallbacks, local annotations, and the workspace UI still run.

## Tests

```sh
npm test
npm run build
npm run test:pdfjs-workspace-ux
cargo check --manifest-path src-tauri/Cargo.toml
```

`test:pdfjs-workspace-ux` launches the production frontend in a real browser
and exercises the deterministic `tests/fixtures/interaction.pdf` document. It
checks:

- orange default notes and all five visible color controls;
- matching underlines for commented annotations;
- color changes that retain the existing comment;
- plain highlights without comment underlines;
- rich Markdown formatting without visible syntax;
- quote/comment/page layout in the comments overview;
- dynamically derived comment-card backgrounds.

The original feature test can be pointed at any suitable PDF:

```sh
npm run test:pdfjs-features -- /absolute/path/to/document.pdf
```

## Release build

```sh
npm run tauri -- build
```

Artifacts:

- `src-tauri/target/release/bundle/macos/Key.app`
- `src-tauri/target/release/bundle/dmg/Key_0.1.0_aarch64.dmg`

The current configuration ad-hoc signs local artifacts and does not notarize
them.

## Benchmarks

```sh
npm run benchmark:pdfjs-tauri -- /absolute/path/to/document.pdf
npm run benchmark:pdfjs-multi-tauri -- /absolute/path/to/pdf-directory
npm run benchmark:pdfjs-workspace-tauri -- /absolute/path/to/pdf-directory
npm run benchmark:resources -- <tauri-pid>
```

Older browser comparison paths remain available:

```sh
npm run benchmark:pdfjs -- /absolute/path/to/document.pdf
npm run benchmark:hepr -- /absolute/path/to/document.pdf
npm run benchmark -- /absolute/path/to/document.pdf
```

See [`docs/benchmark-method.md`](docs/benchmark-method.md) for interpretation
and [`docs/engine-contract.md`](docs/engine-contract.md) for the retained
embedPDF/native-adapter boundary.

## Renderer entry points

| Query | Purpose |
|---|---|
| `?renderer=pdfjs-workspace` | Current multi-document workspace |
| `?renderer=pdfjs` | Single-reader/native benchmark entry |
| `?renderer=pdfjs-isolated-pane` | Isolated pane benchmark |
| `?renderer=pdfjs-isolated-stress` | Repeated isolated PDF.js stress test |
| `?renderer=pdfjs-multi-stress` | Multi-document stress test |
| `?renderer=hepr` | Historical HEPR/WebGL comparison |
| no renderer in a browser | Historical embedPDF comparison shell |

Inside Tauri, the default route resolves to the PDF.js application. Benchmark
environment variables may select a specialized PDF.js harness.

## Current implementation notes

- The tab strip is only shown when required by the resolved design-system
  configuration; the current profile hides it for one document.
- Search/comments mode persists across tab changes, while each document keeps
  its own query and result/comment state.
- Floating document panels remain overlays. The controller adds horizontal
  reach so page content can be scrolled fully clear of an open panel.
- Citation hover cards are anchored to the citation geometry and stay mounted
  until a click elsewhere in the reader.
- External DOI and Crossref-style scholarly links use the same native lookup
  and details presentation as in-text references.
- The native backend owns provider throttling and rate-limit handling. The
  frontend only displays loading, ready, and failure states.

## Known limitations

- macOS Apple silicon is the only validated platform.
- Highlights and comments use browser storage rather than the GPUI sidecar or
  a database.
- Password-protected PDFs, interactive form filling, thumbnails, and
  PDF-embedded annotation editing are not implemented.
- The legacy embedPDF dependencies remain installed for benchmark entry points;
  they are not on the current PDF.js workspace runtime path.
