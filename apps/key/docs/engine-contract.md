# Engine boundary

The stock path passes embedPDF's worker-backed PDFium-WASM engine directly to
the plugin registry.

The native path implements only the operations exercised by the active reader:

| Capability | Native implementation |
|---|---|
| Open/close | bytes cross Tauri IPC; document lives on one Rust owner thread |
| Page/tile/thumbnail raster | `key_pdfium::PdfiumEngineDocument::render` |
| Text selection | `extract_text`, mapped to embedPDF glyph/geometry shapes |
| Search | `key_pdf_core::search_page` over cached native text layers |
| Metadata, page geometry, outline | existing `DocumentDescriptor` |
| PDF links | existing normalized `PdfLink` values and a trusted React overlay |
| Highlights/comments | app-owned `localStorage` state, shared by both engines |

Every other `PdfEngine` method returns an explicit `NotSupport` task, except
read-only empty collections that active plugins probe during initialization.
PDF editing, form mutation, signatures, redaction, PDF annotation mutation,
print, and export are not silently claimed.

The adapter currently serializes the input PDF as a number array during open.
Raster responses use Tauri's raw response body, avoiding JSON expansion on the
hot render path. A production adapter should add a raw upload command or open
native paths directly.

The text geometry mapping is deliberately minimal: native PDFium character
rectangles become embedPDF glyphs, and one synthetic run represents the page.
This is sufficient for selection/search comparison, but not a replacement for
embedPDF's rich font/run model.

The native link overlay supports internal page jumps, trusted external URL
opening, and a text destination preview. It does not yet implement the
existing reader's rendered citation/link preview cards. Selected-text lookup
is similarly a Semantic Scholar query, not the existing metadata-resolution
pipeline.
