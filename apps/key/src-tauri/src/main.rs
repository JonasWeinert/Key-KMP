fn main() {
    if let Some(code) = key_app::maybe_run_preprocess_helper() {
        std::process::exit(code);
    }
    key_app::run();
}
