//! One model process shared by query and indexing clients. Bounded RPCs and
//! query-first scheduling prevent a document from monopolizing inference.
use crate::embedder::{ArcticEmbedder, DIMENSION, MODEL_ID, QUERY_PREFIX};
use frankensearch_core::{
    Cx, Embedder, EmbeddingIdentityBundleV1, ModelCategory, SearchError, SearchFuture, SearchResult,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
const MAX_BYTES: usize = 1024 * 1024;
const IDLE: Duration = Duration::from_secs(30);
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Endpoint {
    address: String,
    token: String,
}
struct Host {
    endpoint: Endpoint,
    child: Mutex<Child>,
}
impl Drop for Host {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
pub(crate) fn endpoint(model: &Path) -> Result<Endpoint, String> {
    let mut host = HOST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Embedding host poisoned")?;
    if host.as_mut().is_some_and(|h| {
        h.child
            .get_mut()
            .ok()
            .and_then(|c| c.try_wait().ok())
            .flatten()
            .is_some()
    }) {
        *host = None;
    }
    if host.is_none() {
        let token = tempfile::Builder::new()
            .prefix("key-model-")
            .tempfile()
            .map_err(|e| e.to_string())?;
        let token = token
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .arg("--key-embedding-service")
            .arg(model)
            .arg(&token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        let address = match bootstrap_address(&mut child, Duration::from_secs(10)) {
            Ok(address) => address,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        *host = Some(Host {
            endpoint: Endpoint {
                address: address.trim().into(),
                token,
            },
            child: Mutex::new(child),
        });
    }
    Ok(host.as_ref().unwrap().endpoint.clone())
}
fn bootstrap_address(child: &mut Child, timeout: Duration) -> Result<String, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or("Missing embedding bootstrap pipe")?;
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("key-model-bootstrap".into())
        .spawn(move || {
            let mut address = String::new();
            let result = BufReader::new(stdout)
                .take(256)
                .read_line(&mut address)
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    address
                        .trim()
                        .parse::<std::net::SocketAddr>()
                        .map_err(|_| "Invalid embedding bootstrap address".to_owned())?;
                    Ok(address)
                });
            let _ = sent.send(result);
        })
        .map_err(|e| e.to_string())?;
    received
        .recv_timeout(timeout)
        .map_err(|_| "Embedding service startup timed out".to_owned())?
}

#[cfg(all(test, unix))]
mod bootstrap_tests {
    use super::*;
    #[test]
    fn an_unresponsive_model_bootstrap_has_a_deadline() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let result = bootstrap_address(&mut child, Duration::from_millis(100));
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

impl Endpoint {
    pub(crate) fn encoded(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }
}
#[derive(Serialize, Deserialize)]
enum Operation {
    Identity,
    Query(String),
    Batch(Vec<String>),
}
#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    operation: Operation,
}
#[derive(Serialize, Deserialize)]
enum Reply {
    Identity(EmbeddingIdentityBundleV1),
    Vectors(Vec<Vec<f32>>),
}
fn frame_write(out: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Embedding request exceeds byte budget".into());
    }
    out.write_all(&(bytes.len() as u32).to_le_bytes())
        .and_then(|_| out.write_all(&bytes))
        .map_err(|e| e.to_string())
}
fn frame_read<T: serde::de::DeserializeOwned>(input: &mut impl Read) -> Result<T, String> {
    let mut size = [0; 4];
    input.read_exact(&mut size).map_err(|e| e.to_string())?;
    let size = u32::from_le_bytes(size) as usize;
    if size > MAX_BYTES {
        return Err("Embedding response exceeds byte budget".into());
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
impl Endpoint {
    fn call(&self, operation: Operation) -> Result<Reply, String> {
        let address = self
            .address
            .parse()
            .map_err(|_| "Invalid embedding endpoint")?;
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(
                if matches!(&operation, Operation::Query(_)) {
                    5
                } else {
                    60
                },
            )))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        frame_write(
            &mut stream,
            &Request {
                token: self.token.clone(),
                operation,
            },
        )?;
        frame_read::<Result<Reply, String>>(&mut stream)?
    }
}
pub(crate) struct RemoteEmbedder {
    endpoint: Mutex<Endpoint>,
    model_dir: PathBuf,
    identity: EmbeddingIdentityBundleV1,
    query_cache: Mutex<Option<(String, Vec<f32>)>>,
}
impl RemoteEmbedder {
    pub(crate) fn load(model: &Path) -> Result<Self, String> {
        let endpoint = match std::env::var("KEY_EMBEDDING_ENDPOINT") {
            Ok(value) => serde_json::from_str(&value).map_err(|e| e.to_string())?,
            Err(_) => endpoint(model)?,
        };
        let Reply::Identity(identity) = endpoint.call(Operation::Identity)? else {
            return Err("Invalid model identity response".into());
        };
        identity.validate().map_err(|e| e.to_string())?;
        Ok(Self {
            endpoint: Mutex::new(endpoint),
            model_dir: model.to_owned(),
            identity,
            query_cache: Mutex::new(None),
        })
    }
    pub(crate) fn identity_bundle(&self) -> &EmbeddingIdentityBundleV1 {
        &self.identity
    }
    pub(crate) fn embed_texts(&self, texts: &[&str]) -> SearchResult<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        self.vectors(
            Operation::Batch(texts.iter().map(|s| (*s).into()).collect()),
            texts.len(),
        )
    }
    fn call(&self, operation: Operation) -> Result<Reply, String> {
        let inherited = std::env::var_os("KEY_EMBEDDING_ENDPOINT").is_some();
        let mut saved = self
            .endpoint
            .lock()
            .map_err(|_| "Embedding endpoint poisoned")?;
        if !inherited {
            let current = endpoint(&self.model_dir)?;
            if current.address != saved.address {
                let Reply::Identity(identity) = current.call(Operation::Identity)? else {
                    return Err("Invalid restarted model identity".into());
                };
                if serde_json::to_vec(&identity).map_err(|e| e.to_string())?
                    != serde_json::to_vec(&self.identity).map_err(|e| e.to_string())?
                {
                    return Err("Embedding model identity changed; reopen search".into());
                }
                *saved = current;
            }
        }
        let result = saved.call(operation);
        if result.is_err() && !inherited {
            if let Some(host) = HOST.get() {
                let mut host = host.lock().map_err(|_| "Embedding host poisoned")?;
                if host
                    .as_ref()
                    .is_some_and(|host| host.endpoint.address == saved.address)
                {
                    *host = None;
                }
            }
        }
        result
    }
    fn vectors(&self, operation: Operation, count: usize) -> SearchResult<Vec<Vec<f32>>> {
        let result = self.call(operation).and_then(|reply| match reply {
            Reply::Vectors(v)
                if v.len() == count
                    && v.iter()
                        .all(|v| v.len() == DIMENSION && v.iter().all(|x| x.is_finite())) =>
            {
                Ok(v)
            }
            _ => Err("Invalid embedding response shape".into()),
        });
        result.map_err(|e| SearchError::EmbeddingFailed {
            model: MODEL_ID.into(),
            source: e.into(),
        })
    }
}
impl Embedder for RemoteEmbedder {
    fn embed<'a>(&'a self, _: &'a Cx, text: &'a str) -> SearchFuture<'a, Vec<f32>> {
        Box::pin(async move {
            if let Some((query, vector)) = self
                .query_cache
                .lock()
                .map_err(|_| SearchError::EmbeddingFailed {
                    model: MODEL_ID.into(),
                    source: "Query cache poisoned".into(),
                })?
                .as_ref()
            {
                if query == text {
                    return Ok(vector.clone());
                }
            }
            let vector = self.vectors(Operation::Query(text.into()), 1)?.remove(0);
            if let Ok(mut cache) = self.query_cache.lock() {
                *cache = Some((text.into(), vector.clone()));
            }
            Ok(vector)
        })
    }
    fn embed_batch<'a>(
        &'a self,
        _: &'a Cx,
        texts: &'a [&'a str],
    ) -> SearchFuture<'a, Vec<Vec<f32>>> {
        Box::pin(async move { self.embed_texts(texts) })
    }
    fn identity(&self) -> SearchResult<&EmbeddingIdentityBundleV1> {
        Ok(&self.identity)
    }
    fn dimension(&self) -> usize {
        DIMENSION
    }
    fn id(&self) -> &str {
        MODEL_ID
    }
    fn model_name(&self) -> &str {
        "Snowflake Arctic Embed XS (shared process)"
    }
    fn is_semantic(&self) -> bool {
        true
    }
    fn category(&self) -> ModelCategory {
        ModelCategory::TransformerEmbedder
    }
}
struct Work {
    operation: Operation,
    reply: std::sync::mpsc::Sender<Result<Reply, String>>,
}
#[derive(Default)]
struct Queue {
    queries: VecDeque<Work>,
    batches: VecDeque<Work>,
}
pub(crate) fn serve(arguments: Vec<std::ffi::OsString>) -> Result<(), String> {
    let model_path = arguments
        .first()
        .map(std::path::PathBuf::from)
        .ok_or("Missing model directory")?;
    let token = arguments
        .get(1)
        .ok_or("Missing service token")?
        .to_string_lossy()
        .into_owned();
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    println!("{}", listener.local_addr().map_err(|e| e.to_string())?);
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    // Pipe closure also covers abrupt app death, including when no RPC is active.
    thread::spawn(|| {
        let mut byte = [0];
        let _ = std::io::stdin().read(&mut byte);
        std::process::exit(0);
    });
    let queue = Arc::new((Mutex::new(Queue::default()), Condvar::new()));
    let worker_queue = queue.clone();
    thread::spawn(move || {
        let mut model: Option<ArcticEmbedder> = None;
        let mut query_cache: Option<(String, Vec<Vec<f32>>)> = None;
        loop {
            let work = {
                let (lock, wake) = &*worker_queue;
                let mut queue = lock.lock().unwrap();
                loop {
                    if let Some(work) = queue
                        .queries
                        .pop_front()
                        .or_else(|| queue.batches.pop_front())
                    {
                        break work;
                    }
                    let (next, timeout) = wake.wait_timeout(queue, IDLE).unwrap();
                    queue = next;
                    if timeout.timed_out() {
                        model = None;
                        query_cache = None;
                    }
                }
            };
            let result = (|| {
                if model.is_none() {
                    model = Some(ArcticEmbedder::load(&model_path)?);
                }
                let model = model.as_ref().unwrap();
                match work.operation {
                    Operation::Identity => Ok(Reply::Identity(model.identity_bundle().clone())),
                    Operation::Query(text) => {
                        if let Some((cached, vectors)) = &query_cache {
                            if cached == &text {
                                return Ok(Reply::Vectors(vectors.clone()));
                            }
                        }
                        let input = format!("{QUERY_PREFIX}{text}");
                        let vectors = model.embed_texts(&[&input]).map_err(|e| e.to_string())?;
                        query_cache = Some((text, vectors.clone()));
                        Ok(Reply::Vectors(vectors))
                    }
                    Operation::Batch(texts) => {
                        key_processing::check_batch_memory()?;
                        let texts: Vec<_> = texts.iter().map(String::as_str).collect();
                        model
                            .embed_texts(&texts)
                            .map(Reply::Vectors)
                            .map_err(|e| e.to_string())
                    }
                }
            })();
            let _ = work.reply.send(result);
        }
    });
    let connections = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let mut stream = stream.map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        if connections.fetch_add(1, Ordering::SeqCst) >= 8 {
            connections.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let connections = connections.clone();
        let queue = queue.clone();
        let token = token.clone();
        thread::spawn(move || {
            let result = (|| {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .map_err(|e| e.to_string())?;
                let request: Request = frame_read(&mut stream)?;
                if request.token != token {
                    return Err("Invalid embedding service token".into());
                }
                if let Operation::Batch(texts) = &request.operation {
                    if texts.len() > 8 {
                        return Err("Embedding batches are limited to eight inputs".into());
                    }
                }
                let (reply, response) = std::sync::mpsc::channel();
                let (lock, wake) = &*queue;
                let mut queue = lock.lock().unwrap();
                let work = Work {
                    operation: request.operation,
                    reply,
                };
                if matches!(work.operation, Operation::Batch(_)) {
                    queue.batches.push_back(work);
                } else {
                    queue.queries.push_back(work);
                }
                wake.notify_one();
                drop(queue);
                response.recv().map_err(|e| e.to_string())?
            })();
            let _ = frame_write(&mut stream, &result);
            connections.fetch_sub(1, Ordering::SeqCst);
        });
    }
    Ok(())
}

// Direct core tests can still use in-process inference. App helpers always get
// an endpoint, so the normal application path has only one model owner.
pub(crate) enum IndexEmbedder {
    Local(ArcticEmbedder),
    Remote(RemoteEmbedder),
}
impl IndexEmbedder {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        if std::env::var_os("KEY_EMBEDDING_ENDPOINT").is_some() {
            RemoteEmbedder::load(path).map(Self::Remote)
        } else {
            ArcticEmbedder::load(path).map(Self::Local)
        }
    }
    pub(crate) fn identity_bundle(&self) -> &EmbeddingIdentityBundleV1 {
        match self {
            Self::Local(m) => m.identity_bundle(),
            Self::Remote(m) => m.identity_bundle(),
        }
    }
    pub(crate) fn embed_texts(&self, texts: &[&str]) -> SearchResult<Vec<Vec<f32>>> {
        match self {
            Self::Local(m) => m.embed_texts(texts),
            Self::Remote(m) => m.embed_texts(texts),
        }
    }
}
