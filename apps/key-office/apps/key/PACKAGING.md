# Key desktop packaging

From `apps/key-office`, build all office modules and the Key shell with
`npm run build:all`. Build the shared PDF/search host with
`npm run build:backend -w @key/electron`. Then run
`npm run dist:mac -w @key/electron`.

The current macOS artifact is an **unsigned development build**, using the
unoptimized Rust host and the optimized spreadsheet worker. Signing,
notarization, release Rust profiling, installer updates and cross-platform
qualification remain separate release work. Do not describe this as a signed
production release.

The package includes:

- The Key shell, shared PDF reader and the Docs, Sheets, Slides, Markdown and
  HTML renderer/preload outputs.
- `Resources/backend/key-desktop-host` and PDFium's native library.
- `Resources/native/xlsx-sidecar` for spreadsheet formulas and workbook I/O.
- The pinned quantized Arctic embedding model in `Resources/models`, keeping
  semantic indexing available offline. Key's host resolves this location when
  launched from `Resources/backend`.
- Third-party notices for imported npm packages and both native dependency
  graphs, Chromium notices, the original Apache attribution, PDFium license
  and Key's license. Original attribution is intentionally preserved.
- The upstream AI search CLI and its runtime dependencies. Account-backed
  functionality still requires the user's own configured provider access.

The preparation step checks every resource before packaging. It does not
silently download missing models or replace an existing source library.
Workspaces and their SQLite databases live outside the application bundle.

The former GenOffice PDF renderer, converters and Node PDF extraction engine
are excluded. Office PDF export remains; PDF imports and attachment extraction
use Key's Rust PDFium backend.

Dependency audit currently reports the upstream `pptxgenjs -> image-size`
parser denial-of-service advisories. At verification time the latest published
image-size version (2.0.2) is still affected; npm's suggested pptxgenjs downgrade
is not an appropriate fix. Reassess before distributing a release.
