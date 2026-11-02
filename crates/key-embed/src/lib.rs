// EmbeddingGemma 2 for search, served by llama.cpp's `llama-server`, which uses Metal
// on macOS and CUDA, Vulkan or the CPU elsewhere. The GGUF model is downloaded once
// into a shared models directory; one server per machine is shared by all workspace
// hosts and is restarted on demand if it goes away.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

pub type Result<T> = std::result::Result<T, String>;

pub const MODEL_REPO: &str = "ggml-org/embeddinggemma-2-GGUF";
pub const MODEL_NAME: &str = "embeddinggemma-2";
pub const DIMENSIONS: usize = 768;
const MODEL_FILE: &str = "model.gguf";
const REMOTE_FILE: &str = "embeddinggemma-2-Q8_0.gguf";
const BATCH: usize = 32;
/// Each of the server's 8 slots holds 4,096 tokens; longer inputs are rejected. Text past
/// this many characters (roughly 2,000–2,700 tokens) adds little to one passage's meaning.
const MAX_INPUT_CHARS: usize = 8000;

fn clip(text: &str) -> &str {
    text.char_indices().nth(MAX_INPUT_CHARS).map_or(text, |(at, _)| &text[..at])
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    /// missing | downloading | ready | failed | unavailable (no llama-server)
    pub state: String,
    pub model: String,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
    /// metal | cuda | vulkan | cpu, once the server reports it
    pub accelerator: Option<String>,
}

/// Where the model lives. One directory is shared by every workspace host.
#[derive(Clone, Debug)]
pub struct ModelDir(PathBuf);

impl ModelDir {
    pub fn new(models_root: impl AsRef<Path>) -> Self {
        Self(models_root.as_ref().join(MODEL_NAME))
    }
    /// `KEY_MODEL_DIR` if the shell set it, otherwise the user's application data folder.
    pub fn from_env() -> Self {
        let root = std::env::var_os("KEY_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            if cfg!(target_os = "macos") {
                home.join("Library/Application Support/Key/models")
            } else if cfg!(windows) {
                std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or(home).join("Key/models")
            } else {
                home.join(".local/share/key/models")
            }
        });
        Self::new(root)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn model(&self) -> PathBuf {
        self.0.join(MODEL_FILE)
    }
    pub fn is_ready(&self) -> bool {
        self.model().is_file()
    }
    fn lock(&self) -> PathBuf {
        self.0.join(".download.lock")
    }
    fn progress_file(&self) -> PathBuf {
        self.0.join(".download.json")
    }
    fn server_file(&self) -> PathBuf {
        self.0.join(".server.json")
    }

    pub fn status(&self) -> ModelStatus {
        let model = MODEL_REPO.to_string();
        if self.is_ready() {
            if server_binary().is_none() {
                return ModelStatus {
                    state: "unavailable".into(),
                    model,
                    error: Some("llama-server is not bundled with this build".into()),
                    ..Default::default()
                };
            }
            let accelerator = fs::read(self.server_file())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ServerInfo>(&bytes).ok())
                .and_then(|info| info.accelerator);
            return ModelStatus { state: "ready".into(), model, accelerator, ..Default::default() };
        }
        let progress: Option<ModelStatus> = fs::read(self.progress_file()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
        match progress {
            Some(status) if status.state == "downloading" && !self.lock_is_live() => ModelStatus { state: "missing".into(), model, ..status },
            Some(status) => status,
            None => ModelStatus { state: "missing".into(), model, ..Default::default() },
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

    /// Downloads the model if missing. Returns Ok(false) when another process already
    /// holds the download, so callers can poll `status()` and try again later.
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
        let result = self.fetch(&mut status);
        if let Err(error) = &result {
            status.state = "failed".into();
            status.error = Some(error.clone());
            self.write_progress(&status);
        } else {
            let _ = fs::remove_file(self.progress_file());
        }
        let _ = fs::remove_file(self.lock());
        result.map(|()| true)
    }

    fn fetch(&self, status: &mut ModelStatus) -> Result<()> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Key/0.1 (+desktop research workspace)")
            .connect_timeout(Duration::from_secs(20))
            .timeout(None)
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("https://huggingface.co/{MODEL_REPO}/resolve/main/{REMOTE_FILE}");
        let mut response = client.get(&url).send().map_err(|e| format!("{REMOTE_FILE}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("{REMOTE_FILE}: HTTP {}", response.status()));
        }
        status.total = response.content_length().unwrap_or(0);
        let partial = self.0.join(format!("{MODEL_FILE}.part"));
        let mut out = fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; 1 << 20];
        let mut last_report = Instant::now();
        loop {
            let read = response.read(&mut buffer).map_err(|e| format!("{REMOTE_FILE}: {e}"))?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
            status.received += read as u64;
            if last_report.elapsed() > Duration::from_millis(400) {
                self.write_progress(status);
                last_report = Instant::now();
            }
        }
        out.sync_all().map_err(|e| e.to_string())?;
        if status.total > 0 && status.received != status.total {
            return Err("The model download was incomplete".into());
        }
        fs::rename(&partial, self.model()).map_err(|e| e.to_string())
    }
}

/// Servers this process started; `shutdown` stops them because the host exits without
/// running destructors.
static SPAWNED: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Stops any llama-server this process started. Call before the process exits.
pub fn shutdown() {
    let pids = SPAWNED.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
    for pid in pids {
        let _ = if cfg!(windows) {
            Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status()
        } else {
            Command::new("kill").arg(pid.to_string()).status()
        };
    }
}

#[derive(Serialize, Deserialize)]
struct ServerInfo {
    port: u16,
    pid: u32,
    accelerator: Option<String>,
}

/// `llama-server` next to the host binary (`llama/llama-server`), or `KEY_LLAMA_SERVER`.
pub fn server_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KEY_LLAMA_SERVER").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("llama").join(name);
    path.is_file().then_some(path)
}

pub struct Embedder {
    dir: ModelDir,
    client: reqwest::blocking::Client,
    port: Mutex<Option<u16>>,
    child: Mutex<Option<Child>>,
}

impl Embedder {
    pub fn load(dir: &ModelDir) -> Result<Self> {
        if !dir.is_ready() {
            return Err("The search model has not been downloaded yet".into());
        }
        if server_binary().is_none() {
            return Err("llama-server is not bundled with this build".into());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let embedder = Self { dir: dir.clone(), client, port: Mutex::new(None), child: Mutex::new(None) };
        embedder.port()?;
        Ok(embedder)
    }

    /// Document embeddings with the model's corpus prefix (`title: … | text: …`).
    pub fn embed_documents(&self, items: &[(&str, &str)]) -> Result<Vec<Vec<f32>>> {
        let inputs: Vec<String> = items
            .iter()
            .map(|(title, text)| {
                let title = title.trim();
                format!("title: {} | text: {}", if title.is_empty() { "none" } else { clip(title) }, clip(text.trim()))
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
        let input = format!("task: search result | query: {}", clip(query.trim()));
        self.run(std::slice::from_ref(&input))?.pop().ok_or_else(|| "No embedding returned".into())
    }

    fn run(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        match self.request(inputs) {
            Ok(vectors) => Ok(vectors),
            // The shared server may have exited with the host that started it; start our own.
            Err(_) => {
                *self.port.lock().map_err(|_| "Embedding server lock poisoned")? = None;
                self.request(inputs)
            }
        }
    }

    fn request(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        #[derive(Deserialize)]
        struct Item {
            embedding: Vec<f32>,
            index: usize,
        }
        #[derive(Deserialize)]
        struct Response {
            data: Vec<Item>,
        }
        let port = self.port()?;
        let body = serde_json::to_vec(&serde_json::json!({ "input": inputs })).map_err(|e| e.to_string())?;
        let response = self
            .client
            .post(format!("http://127.0.0.1:{port}/v1/embeddings"))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(format!("Embedding server: HTTP {status} {}", response.text().unwrap_or_default()));
        }
        let mut parsed: Response = serde_json::from_str(&response.text().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        parsed.data.sort_by_key(|item| item.index);
        parsed
            .data
            .into_iter()
            .map(|item| {
                if item.embedding.len() != DIMENSIONS {
                    return Err(format!("Unexpected embedding width {}", item.embedding.len()));
                }
                Ok(normalize(&item.embedding))
            })
            .collect()
    }

    /// The port of a healthy server: the shared one if it answers, otherwise our own.
    fn port(&self) -> Result<u16> {
        let mut slot = self.port.lock().map_err(|_| "Embedding server lock poisoned")?;
        if let Some(port) = *slot {
            return Ok(port);
        }
        if let Some(info) = fs::read(self.dir.server_file()).ok().and_then(|b| serde_json::from_slice::<ServerInfo>(&b).ok()) {
            if self.healthy(info.port) {
                *slot = Some(info.port);
                return Ok(info.port);
            }
        }
        // One host starts the server; others wait for it instead of starting their own.
        let lock = self.dir.path().join(".server.lock");
        // A lock counts only while it is recent and the process that took it is still running,
        // so a host that quit mid-start never leaves the others waiting.
        let fresh = |path: &Path| {
            let recent = fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age < Duration::from_secs(90));
            recent && fs::read_to_string(path).ok().and_then(|pid| pid.trim().parse::<u32>().ok()).is_none_or(process_alive)
        };
        if fresh(&lock) || fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_err() && fresh(&lock) {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(90) {
                std::thread::sleep(Duration::from_millis(300));
                if let Some(info) = fs::read(self.dir.server_file()).ok().and_then(|b| serde_json::from_slice::<ServerInfo>(&b).ok()) {
                    if self.healthy(info.port) {
                        *slot = Some(info.port);
                        return Ok(info.port);
                    }
                }
                if !fresh(&lock) {
                    break;
                }
            }
        }
        let _ = fs::write(&lock, std::process::id().to_string());
        let result = self.spawn();
        let _ = fs::remove_file(&lock);
        let port = result?;
        *slot = Some(port);
        Ok(port)
    }

    fn healthy(&self, port: u16) -> bool {
        self.client
            .get(format!("http://127.0.0.1:{port}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .is_ok_and(|r| r.status().is_success())
    }

    fn spawn(&self) -> Result<u16> {
        let binary = server_binary().ok_or("llama-server is not bundled with this build")?;
        let port = TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
        let log_path = self.dir.path().join("server.log");
        let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
        let mut arguments: Vec<String> = vec!["--model".into(), self.dir.model().to_string_lossy().into_owned()];
        arguments.extend(
            ["--embedding", "--pooling", "mean", "--host", "127.0.0.1", "--port", &port.to_string()]
                .into_iter()
                .chain(["--n-gpu-layers", "999", "--ctx-size", "32768", "--batch-size", "8192", "--ubatch-size", "8192", "--parallel", "8"])
                .map(String::from),
        );
        let mut command = if cfg!(unix) {
            // A watchdog shell stops the server as soon as the host process is gone, however
            // the host exits (Electron may kill it without running any cleanup).
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(r#"server="$1"; shift; "$server" "$@" & child=$!; trap 'kill $child 2>/dev/null' EXIT TERM INT; while kill -0 "$KEY_HOST_PID" 2>/dev/null && kill -0 $child 2>/dev/null; do sleep 2; done"#)
                .arg("key-llama-watchdog")
                .arg(&binary)
                .args(&arguments)
                .env("KEY_HOST_PID", std::process::id().to_string());
            command
        } else {
            let mut command = Command::new(&binary);
            command.args(&arguments);
            command
        };
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
        if let Some(dir) = binary.parent() {
            command.current_dir(dir);
        }
        let mut child = command.spawn().map_err(|e| format!("Could not start llama-server: {e}"))?;
        if let Ok(mut pids) = SPAWNED.lock() {
            pids.push(child.id());
        }
        let started = Instant::now();
        while !self.healthy(port) {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("llama-server exited ({status}); see {}", log_path.display()));
            }
            if started.elapsed() > Duration::from_secs(90) {
                let _ = child.kill();
                return Err("llama-server did not become ready".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let accelerator = Some(accelerator(&binary));
        let info = ServerInfo { port, pid: child.id(), accelerator };
        let _ = fs::write(self.dir.server_file(), serde_json::to_vec(&info).unwrap_or_default());
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut old) = slot.replace(child) {
                let _ = old.kill();
            }
        }
        Ok(port)
    }
}

impl Drop for Embedder {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// The first compute device llama.cpp reports, e.g. "Metal · Apple M2 Max".
fn accelerator(binary: &Path) -> String {
    let output = Command::new(binary)
        .arg("--list-devices")
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .output()
        .map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
        .unwrap_or_default();
    for line in output.lines().map(str::trim) {
        let Some((device, name)) = line.split_once(": ") else { continue };
        let name = name.split(" (").next().unwrap_or(name);
        let kind = match device.trim_end_matches(char::is_numeric) {
            "MTL" | "Metal" => "Metal",
            "CUDA" => "CUDA",
            "Vulkan" => "Vulkan",
            "ROCm" => "ROCm",
            _ => continue,
        };
        return format!("{kind} · {name}");
    }
    "CPU".into()
}

fn normalize(vector: &[f32]) -> Vec<f32> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
    vector.iter().map(|v| v / norm).collect()
}

/// Whether a process is still running (Unix); elsewhere assume it is.
fn process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    if cfg!(unix) {
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
    } else {
        true
    }
}

#[cfg(test)]
mod clip_tests {
    #[test]
    fn clips_long_inputs_on_character_boundaries() {
        let long = "ä".repeat(super::MAX_INPUT_CHARS + 10);
        assert_eq!(super::clip(&long).chars().count(), super::MAX_INPUT_CHARS);
        assert_eq!(super::clip("short"), "short");
    }

    #[test]
    fn a_lock_from_a_finished_process_is_not_alive() {
        assert!(super::process_alive(std::process::id()));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!super::process_alive(pid));
    }
}
