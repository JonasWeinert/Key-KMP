use opendataloader_pdf::ConvertOptions;

#[test]
fn optional_engines_are_disabled_by_default() {
    let options = ConvertOptions::default();
    assert!(options.onnx_model.is_none());
    assert!(options.xml_input.is_none());
}

#[cfg(feature = "onnx")]
#[test]
fn bundled_model_is_present() {
    let model = opendataloader_pdf::bundled_onnx_model_path();
    assert!(
        model.is_file(),
        "missing bundled model at {}",
        model.display()
    );
    assert!(std::fs::metadata(model).unwrap().len() > 60_000_000);
}
