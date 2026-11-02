# opendataloader-pdf

A standalone Rust library and CLI for reconstructing academic PDFs as JSON or
Markdown. It uses PDFium for text and page access, `lopdf` for raw tagged-PDF
structure and vector evidence, and optionally PP-DocLayoutV3 through ONNX. No
Java process, Java library, or server is required.

The 63 MB ONNX model is included at `models/model_fp16.onnx`. ONNX and
scientific-XML support are both compiled by default, but neither is used unless
you explicitly enable it for a conversion.

## Copy into another project

Copy this whole directory, including `models/`, then use it as a path dependency:

```toml
[dependencies]
opendataloader-pdf = { path = "vendor/opendataloader-pdf-rs" }
```

To omit optional code and dependencies:

```toml
# Geometry + tagged-PDF structure only
opendataloader-pdf = { path = "vendor/opendataloader-pdf-rs", default-features = false }

# Add only one optional engine
opendataloader-pdf = { path = "vendor/opendataloader-pdf-rs", default-features = false, features = ["onnx"] }
opendataloader-pdf = { path = "vendor/opendataloader-pdf-rs", default-features = false, features = ["xml"] }
```

The build script downloads the pinned PDFium native library for macOS, Linux,
or Windows. Set `PDFIUM_LIB_PATH` to use your own library. Set
`PDFIUM_SKIP_DOWNLOAD=1` when PDFium is discoverable as a system library.

## Library API

```rust,no_run
use std::path::Path;
use opendataloader_pdf::{convert, to_markdown, ConvertOptions};

fn main() -> anyhow::Result<()> {
    // Geometry and tagged-PDF structure are always available. ONNX and XML
    // remain off because their option fields are None.
    let options = ConvertOptions::default();
    let document = convert(Path::new("paper.pdf"), &options)?;
    println!("{}", to_markdown(&document));
    Ok(())
}
```

Enable the bundled ONNX model at runtime:

```rust,no_run
# use opendataloader_pdf::{convert, ConvertOptions};
# use std::path::Path;
# fn run() -> anyhow::Result<()> {
let options = ConvertOptions::default().with_bundled_onnx()?;
let document = convert(Path::new("paper.pdf"), &options)?;
# Ok(()) }
```

Fuse an already downloaded publisher JATS or normalized TEI document:

```rust,no_run
# use opendataloader_pdf::{convert, ConvertOptions};
# use std::path::Path;
# fn run() -> anyhow::Result<()> {
let options = ConvertOptions::default().with_xml("article.xml")?;
let document = convert(Path::new("paper.pdf"), &options)?;
# Ok(()) }
```

With the `xml` feature, `external_xml::fetch_for_pdf()` provides opt-in DOI,
arXiv, PubMed, and PMC lookup. It writes fetched artifacts and a manifest to a
directory chosen by the caller. It never runs during ordinary `convert()`.

## CLI

```bash
# Geometry + semantic tags; no network lookup and no ONNX inference
cargo run --release -- paper.pdf --format md --output paper.md

# Add the bundled ONNX model
cargo run --release -- paper.pdf --mode final-onnx --format json --output paper.json

# Fuse local XML
cargo run --release -- paper.pdf --xml-input article.xml --output paper.json

# Opt-in external XML discovery/fetch (network access)
cargo run --release -- paper.pdf --fetch-xml fetched-xml --ncbi-email you@example.org
```

`--onnx-model /path/model.onnx` overrides the included model. `--fetch-xml` only
retrieves XML; pass a retrieved full-text XML file back through `--xml-input` to
use it as conversion evidence.

## Feature and runtime matrix

| Capability | Cargo feature | Runtime switch | Default runtime |
|---|---|---|---|
| Geometry + tagged tree | always | none | on |
| ONNX layout | `onnx` | `--mode final-onnx` or `with_bundled_onnx()` | off |
| Local XML fusion | `xml` | `--xml-input` or `with_xml()` | off |
| XML network lookup | `xml` | `--fetch-xml` / `external_xml::fetch_for_pdf()` | off |

## Outputs

The serializable `Document` contains pages, reading-ordered blocks, table rows,
columns, cells and spans, figures, captions, headings, paragraphs, lists,
references, citations, notes, equations, sentence coordinates, source geometry,
and tagged-PDF diagnostics. `to_markdown()` produces pure Markdown.

Licensed under Apache-2.0. The bundled model and downloaded PDFium binary retain
their upstream licenses; review them for your distribution context.
