use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PDFIUM_RELEASE_TAG: &str = "chromium/7834";

fn main() {
    println!("cargo:rerun-if-env-changed=PDFIUM_SKIP_DOWNLOAD");
    println!("cargo:rerun-if-env-changed=PDFIUM_LIB_PATH");
    println!("cargo:rerun-if-changed=build.rs");

    if let Ok(path) = env::var("PDFIUM_LIB_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            println!("cargo:rustc-env=PDFIUM_BUNDLE_PATH={}", path.display());
            return;
        }
    }

    if env::var("PDFIUM_SKIP_DOWNLOAD").ok().as_deref() == Some("1") {
        println!("cargo:warning=PDFium download disabled; set PDFIUM_LIB_PATH at runtime");
        return;
    }

    let target = env::var("TARGET").expect("target");
    let Some(asset) = asset_name(&target) else {
        println!("cargo:warning=no bundled PDFium for {target}; set PDFIUM_LIB_PATH");
        return;
    };
    let out = PathBuf::from(env::var("OUT_DIR").expect("out dir"));
    let archive = out.join("pdfium.tgz");
    let extracted = out.join("pdfium");
    let _ = fs::remove_dir_all(&extracted);
    fs::create_dir_all(&extracted).expect("create PDFium extraction directory");
    let tag = PDFIUM_RELEASE_TAG.replace('/', "%2F");
    let url =
        format!("https://github.com/bblanchon/pdfium-binaries/releases/download/{tag}/{asset}");
    let downloaded = Command::new("curl")
        .args(["-fL", "--retry", "3", "--connect-timeout", "30", "-o"])
        .arg(&archive)
        .arg(&url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !downloaded {
        println!("cargo:warning=PDFium download failed; set PDFIUM_LIB_PATH");
        return;
    }
    let unpacked = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&extracted)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if unpacked {
        if let Some(lib) = find_library(&extracted) {
            println!("cargo:rustc-env=PDFIUM_BUNDLE_PATH={}", lib.display());
        }
    }
}

fn asset_name(target: &str) -> Option<&'static str> {
    Some(match target {
        "aarch64-apple-darwin" => "pdfium-mac-arm64.tgz",
        "x86_64-apple-darwin" => "pdfium-mac-x64.tgz",
        "x86_64-unknown-linux-gnu" => "pdfium-linux-x64.tgz",
        "aarch64-unknown-linux-gnu" => "pdfium-linux-arm64.tgz",
        "x86_64-pc-windows-msvc" => "pdfium-win-x64.tgz",
        "aarch64-pc-windows-msvc" => "pdfium-win-arm64.tgz",
        _ => return None,
    })
}

fn find_library(root: &Path) -> Option<PathBuf> {
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if matches!(
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .as_str(),
                "libpdfium.dylib" | "libpdfium.so" | "pdfium.dll"
            ) {
                return Some(path);
            }
        }
    }
    None
}
