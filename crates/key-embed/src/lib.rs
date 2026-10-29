// EmbeddingGemma 2 (text backbone) for search. The model is downloaded once into a
// shared models directory on first use and run with ONNX Runtime on the CPU.
use ndarray::Array2;
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tokenizers::{PaddingParams, Tokenizer, TruncationParams};

pub type Result<T> = std::result::Result<T, String>;

pub const MODEL_REPO: &str = "onnx-community/embeddinggemma-2-ONNX";
pub const MODEL_NAME: &str = "embeddinggemma-2-q4";
pub const DIMENSIONS: usize = 768;
const MAX_TOKENS: usize = 2048;
const BATCH: usize = 8;
/// Remote path, local file name. The graph references its weights by file name,
/// so both ONNX files keep their published names side by side.
const FILES: &[(&str, &str)] = &[
    ("tokenizer.json", "tokenizer.json"),
    ("config.json", "config.json"),
    ("onnx/model_q4.onnx", "model_q4.onnx"),
    ("onnx/model_q4.onnx_data", "model_q4.onnx_data"),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    /// missing | downloading | ready | failed
    pub state: String,
    pub model: String,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}

/// Where the model lives. One directory is shared by every workspace host.
#[derive(Clone, Debug)]
pub struct ModelDir(PathBuf);

impl ModelDir {
    pub fn new(models_root: impl AsRef<Path>) -> Self {
        Self(models_root.as_ref().join(MODEL_NAME))
    }
    /// `KEY_MODEL_DIR` if the shell set it, otherwise the user's application support folder.
    pub fn from_env() -> Self {
        let root = std::env::var_os("KEY_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            home.join("Library/Application Support/Key/models")
        });
        Self::new(root)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn is_ready(&self) -> bool {
        FILES.iter().all(|(_, name)| self.0.join(name).is_file())
    }
    fn lock(&self) -> PathBuf {
        self.0.join(".download.lock")
    }
    fn progress_file(&self) -> PathBuf {
        self.0.join(".download.json")
    }

    pub fn status(&self) -> ModelStatus {
        if self.is_ready() {
            return ModelStatus { state: "ready".into(), model: MODEL_REPO.into(), ..Default::default() };
        }
        let progress: Option<ModelStatus> = fs::read(self.progress_file()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
        match progress {
            Some(status) if status.state == "downloading" && !self.lock_is_live() => {
                ModelStatus { state: "missing".into(), model: MODEL_REPO.into(), ..status }
            }
            Some(status) => status,
            None => ModelStatus { state: "missing".into(), model: MODEL_REPO.into(), ..Default::default() },
        }
    }

    fn lock_is_live(&self) -> bool {
        // A lock untouched for two minutes belongs to a host that went away mid-download.
        fs::metadata(self.lock())
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age < Duration::from_secs(120))
    }

    fn write_progress(&self, status: &ModelStatus) {
        if let Ok(bytes) = serde_json::to_vec(status) {
            let _ = fs::write(self.progress_file(), bytes);
        }
        let _ = fs::write(self.lock(), b"");
    }

    /// Downloads any missing files. Returns Ok(false) when another process already holds
    /// the download, so callers can poll `status()` and try again later.
    pub fn download(&self) -> Result<bool> {
        if self.is_ready() {
            return Ok(true);
        }
        fs::create_dir_all(&self.0).map_err(|e| e.to_string())?;
        if self.lock_is_live() {
            return Ok(false);
        }
        let mut status = ModelStatus { state: "downloading".into(), model: MODEL_REPO.into(), ..Default::default() };
        self.write_progress(&status);
        let result = self.fetch_all(&mut status);
        match &result {
            Ok(()) => {
                let _ = fs::remove_file(self.progress_file());
            }
            Err(error) => {
                status.state = "failed".into();
                status.error = Some(error.clone());
                self.write_progress(&status);
            }
        }
        let _ = fs::remove_file(self.lock());
        result.map(|()| true)
    }

    fn fetch_all(&self, status: &mut ModelStatus) -> Result<()> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Key/0.1 (+desktop research workspace)")
            .connect_timeout(Duration::from_secs(20))
            .timeout(None)
            .build()
            .map_err(|e| e.to_string())?;
        let url = |remote: &str| format!("https://huggingface.co/{MODEL_REPO}/resolve/main/{remote}");
        // Sizes first, so progress covers the whole download.
        let mut sizes = Vec::new();
        for (remote, name) in FILES {
            let done = self.0.join(name).is_file();
            let size = if done {
                fs::metadata(self.0.join(name)).map(|m| m.len()).unwrap_or(0)
            } else {
                client
                    .head(url(remote))
                    .send()
                    .ok()
                    .and_then(|r| r.headers().get("x-linked-size").or(r.headers().get("content-length")).cloned())
                    .and_then(|v| v.to_str().ok()?.parse().ok())
                    .unwrap_or(0)
            };
            sizes.push((done, size));
        }
        status.total = sizes.iter().map(|(_, s)| s).sum();
        status.received = sizes.iter().filter(|(done, _)| *done).map(|(_, s)| s).sum();
        self.write_progress(status);
        for ((remote, name), (done, _)) in FILES.iter().zip(sizes) {
            if done {
                continue;
            }
            let target = self.0.join(name);
            let partial = self.0.join(format!("{name}.part"));
            let mut response = client.get(url(remote)).send().map_err(|e| format!("{remote}: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("{remote}: HTTP {}", response.status()));
            }
            let mut out = fs::File::create(&partial).map_err(|e| e.to_string())?;
            let mut buffer = vec![0u8; 1 << 20];
            let mut last_report = std::time::Instant::now();
            loop {
                let read = response.read(&mut buffer).map_err(|e| format!("{remote}: {e}"))?;
                if read == 0 {
                    break;
                }
                out.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
                status.received += read as u64;
                if last_report.elapsed() > Duration::from_millis(400) {
                    self.write_progress(status);
                    last_report = std::time::Instant::now();
                }
            }
            out.sync_all().map_err(|e| e.to_string())?;
            fs::rename(&partial, &target).map_err(|e| e.to_string())?;
            self.write_progress(status);
        }
        Ok(())
    }
}

pub struct Embedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

impl Embedder {
    pub fn load(dir: &ModelDir) -> Result<Self> {
        if !dir.is_ready() {
            return Err("The search model has not been downloaded yet".into());
        }
        let mut tokenizer = Tokenizer::from_file(dir.path().join("tokenizer.json")).map_err(|e| e.to_string())?;
        tokenizer
            .with_truncation(Some(TruncationParams { max_length: MAX_TOKENS, ..Default::default() }))
            .map_err(|e| e.to_string())?;
        let pad_id = tokenizer.token_to_id("<pad>").unwrap_or(0);
        tokenizer.with_padding(Some(PaddingParams { pad_id, pad_token: "<pad>".into(), ..Default::default() }));
        // Inference scales to about the number of performance cores.
        let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4);
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_intra_threads(threads)
            .map_err(|e| e.to_string())?
            .commit_from_file(dir.path().join("model_q4.onnx"))
            .map_err(|e| e.to_string())?;
        Ok(Self { session: Mutex::new(session), tokenizer })
    }

    /// Document embeddings with the model's corpus prefix (`title: … | text: …`).
    pub fn embed_documents(&self, items: &[(&str, &str)]) -> Result<Vec<Vec<f32>>> {
        let inputs: Vec<String> = items
            .iter()
            .map(|(title, text)| {
                let title = title.trim();
                format!("title: {} | text: {}", if title.is_empty() { "none" } else { title }, text.trim())
            })
            .collect();
        let mut out = Vec::with_capacity(inputs.len());
        for batch in inputs.chunks(BATCH) {
            out.extend(self.run(batch)?);
        }
        Ok(out)
    }

    /// A search query embedding with the retrieval task prefix.
    pub fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let input = format!("task: search result | query: {}", query.trim());
        self.run(std::slice::from_ref(&input))?.pop().ok_or_else(|| "No embedding returned".into())
    }

    fn run(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let encodings = self
            .tokenizer
            .encode_batch(texts.iter().map(String::as_str).collect::<Vec<_>>(), true)
            .map_err(|e| e.to_string())?;
        let rows = encodings.len();
        let columns = encodings.iter().map(|e| e.get_ids().len()).max().unwrap_or(0).max(1);
        let mut ids = Array2::<i64>::zeros((rows, columns));
        let mut mask = Array2::<i64>::zeros((rows, columns));
        for (row, encoding) in encodings.iter().enumerate() {
            for (column, (id, m)) in encoding.get_ids().iter().zip(encoding.get_attention_mask()).enumerate() {
                ids[[row, column]] = *id as i64;
                mask[[row, column]] = *m as i64;
            }
        }
        // Text-only calls pass empty media features; the graph requires the inputs.
        let empty = || Tensor::from_array(Array2::<f32>::zeros((0, 512))).map_err(|e| e.to_string());
        let mut session = self.session.lock().map_err(|_| "Embedding session poisoned")?;
        let outputs = session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(ids).map_err(|e| e.to_string())?,
                "attention_mask" => Tensor::from_array(mask).map_err(|e| e.to_string())?,
                "image_features" => empty()?,
                "video_features" => empty()?,
                "audio_features" => empty()?,
            ])
            .map_err(|e| e.to_string())?;
        let (shape, data) = outputs["sentence_embedding"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let width = shape.get(1).copied().unwrap_or(0) as usize;
        if width != DIMENSIONS {
            return Err(format!("Unexpected embedding width {width}"));
        }
        Ok(data.chunks(width).map(normalize).collect())
    }
}

fn normalize(vector: &[f32]) -> Vec<f32> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
    vector.iter().map(|v| v / norm).collect()
}
