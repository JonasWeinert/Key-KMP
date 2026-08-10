# Third-party notices

## PP-DocLayoutV3 ONNX model

`models/model_fp16.onnx` is an ONNX export of PaddlePaddle PP-DocLayoutV3.

- Included file SHA-256: `e549a04370b88c3f26fe8a975d7f15d76cb15876b54588270c977426793445ad`
- Included-file source: <https://huggingface.co/datasets/embedpdf/embed-pdf-viewer/resolve/main/models/PP-DocLayoutV3-ONNX/model_fp16.onnx>
- Upstream model: <https://huggingface.co/PaddlePaddle/PP-DocLayoutV3>
- License: Apache License 2.0

## PDFium

The crate uses PDFium through `pdfium-render`. PDFium is not stored in this
crate; the build script downloads a pinned prebuilt binary from
`bblanchon/pdfium-binaries` unless the caller provides `PDFIUM_LIB_PATH` or
sets `PDFIUM_SKIP_DOWNLOAD=1`.

- Binary distribution: <https://github.com/bblanchon/pdfium-binaries>
- PDFium source: <https://pdfium.googlesource.com/pdfium/>
- License and notices: <https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE>

The remaining Rust dependencies and their versions are recorded in
`Cargo.lock`; their own license terms apply.
