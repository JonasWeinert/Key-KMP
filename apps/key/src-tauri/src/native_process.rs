//! Supervised interactive PDFium process. Only this child owns native handles.
use super::*;
use std::io::{BufReader, Read, Write};
use std::process::{ChildStdin, Stdio};

pub(super) type ProcessInput = Arc<Mutex<Option<ChildStdin>>>;
const MAX_FRAME: usize = 128 * 1024 * 1024;

pub(super) fn discard_reply() -> Sender<Result<Reply, String>> {
    mpsc::channel().0
}
impl Request {
    fn reply_mut(&mut self) -> &mut Sender<Result<Reply, String>> {
        match self {
            Self::Preprocess { reply, .. }
            | Self::OpenFile { reply, .. }
            | Self::OpenBytes { reply, .. }
            | Self::Render { reply, .. }
            | Self::Text { reply, .. }
            | Self::Search { reply, .. }
            | Self::Hibernate { reply, .. }
            | Self::Close { reply, .. } => reply,
        }
    }
}
#[derive(Serialize, Deserialize)]
enum Message {
    Request(Request),
    Cancel(u64),
}

fn write_frame(out: &mut impl Write, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_FRAME {
        return Err("Interactive PDF response exceeds IPC budget".into());
    }
    out.write_all(&(bytes.len() as u32).to_le_bytes())
        .and_then(|_| out.write_all(bytes))
        .and_then(|_| out.flush())
        .map_err(|e| e.to_string())
}
fn read_frame(input: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut header = [0; 4];
    input.read_exact(&mut header).map_err(|e| e.to_string())?;
    let size = u32::from_le_bytes(header) as usize;
    if size > MAX_FRAME {
        return Err("Interactive PDF request exceeds IPC budget".into());
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
fn send(input: &ProcessInput, message: &Message) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    let mut input = input.lock().map_err(|_| "PDF process input poisoned")?;
    write_frame(input.as_mut().ok_or("PDF process unavailable")?, &bytes)
}
pub(super) fn cancel(input: &ProcessInput, id: u64) {
    let _ = send(input, &Message::Cancel(id));
}
fn response(input: &mut impl Read) -> Result<Result<Reply, String>, String> {
    let bytes = read_frame(input)?;
    match bytes.split_first() {
        Some((1, pixels)) => Ok(Ok(Reply::Pixels(pixels.to_vec()))),
        Some((0, json)) => serde_json::from_slice(json).map_err(|e| e.to_string()),
        _ => Err("Invalid interactive PDF response".into()),
    }
}

fn receive(
    input: &Receiver<Result<Result<Reply, String>, String>>,
) -> Result<Result<Reply, String>, String> {
    input
        .recv_timeout(Duration::from_secs(30))
        .map_err(|e| format!("Interactive PDF response timed out or disconnected: {e}"))?
}

pub(super) fn run_bridge(receiver: Receiver<Request>, input: ProcessInput) {
    let mut child = None;
    let mut output = None;
    // File paths are sufficient to recover handles after a native crash.
    let mut sources: HashMap<String, PathBuf> = HashMap::new();
    let mut temporary = HashMap::new();
    let mut resident = VecDeque::<String>::new();
    for mut request in receiver {
        let reply = request.reply_mut().clone();
        if let Request::Render { cancellation, .. } = &request {
            if cancellation.is_cancelled() {
                let _ = reply.send(Err("Render cancelled".into()));
                continue;
            }
        }
        // Legacy byte opens are spooled once; neither the bridge nor recovery retains PDF buffers.
        if let Request::OpenBytes { id, bytes, .. } = &request {
            let result = tempfile::NamedTempFile::new().and_then(|mut file| {
                file.write_all(bytes)?;
                Ok(file)
            });
            match result {
                Ok(file) => {
                    let id = id.clone();
                    request = Request::OpenFile {
                        id: id.clone(),
                        path: file.path().into(),
                        reply: reply.clone(),
                    };
                    temporary.insert(id, file);
                }
                Err(error) => {
                    let _ = reply.send(Err(error.to_string()));
                    continue;
                }
            }
        }
        let result: Result<Result<Reply, String>, String> = (|| {
            if child.is_none() {
                let mut process = Command::new(env::current_exe().map_err(|e| e.to_string())?)
                    .arg("--key-interactive-pdf-helper")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                *input.lock().map_err(|_| "PDF process input poisoned")? = process.stdin.take();
                let stdout = process.stdout.take().ok_or("Missing PDF process stdout")?;
                let (responses, received) = mpsc::sync_channel(1);
                thread::spawn(move || {
                    let mut reader = BufReader::new(stdout);
                    loop {
                        let reply = response(&mut reader);
                        let failed = reply.is_err();
                        if responses.send(reply).is_err() || failed {
                            break;
                        }
                    }
                });
                output = Some(received);
                child = Some(process);
                resident.clear();
            }
            // Restore only the requested handle after eviction/crash. Keeping
            // paths for background tabs does not keep their PDFium heaps alive.
            let requested_id = match &request {
                Request::Render { id, .. }
                | Request::Text { id, .. }
                | Request::Search { id, .. } => Some(id.clone()),
                _ => None,
            };
            if let Some(id) = requested_id {
                if !resident.contains(&id) {
                    if let Some(path) = sources.get(&id) {
                        send(
                            &input,
                            &Message::Request(Request::OpenFile {
                                id: id.clone(),
                                path: path.clone(),
                                reply: discard_reply(),
                            }),
                        )?;
                        receive(output.as_ref().ok_or("PDF process output missing")?)??;
                        resident.push_back(id.clone());
                    }
                }
                resident.retain(|key| key != &id);
                resident.push_back(id);
            }
            // Serialization skips the local reply channel and cancellation object.
            let message = Message::Request(request);
            send(&input, &message)?;
            let result = receive(output.as_ref().ok_or("PDF process output missing")?)?;
            if result.is_ok() {
                if let Message::Request(request) = message {
                    match request {
                        Request::OpenFile { id, path, .. } => {
                            resident.retain(|key| key != &id);
                            resident.push_back(id.clone());
                            sources.insert(id, path);
                        }
                        Request::Close { id, .. } | Request::Hibernate { id, .. } => {
                            sources.remove(&id);
                            temporary.remove(&id);
                            resident.retain(|key| key != &id);
                        }
                        _ => {}
                    }
                }
            }
            while resident.len() > 4 {
                if let Some(id) = resident.pop_front() {
                    send(
                        &input,
                        &Message::Request(Request::Close {
                            id,
                            reply: discard_reply(),
                        }),
                    )?;
                    receive(output.as_ref().ok_or("PDF process output missing")?)??;
                }
            }
            Ok(result)
        })();
        match result {
            Ok(result) => {
                let _ = reply.send(result);
            }
            Err(error) => {
                input.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(mut process) = child.take() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                output = None;
                let _ = reply.send(Err(format!(
                    "Interactive PDF process failed; next request will reopen documents: {error}"
                )));
            }
        }
    }
    input.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut process) = child {
        let _ = process.kill();
        let _ = process.wait();
    }
}

pub fn maybe_run_interactive_helper() -> Option<i32> {
    if env::args().nth(1).as_deref() != Some("--key-interactive-pdf-helper") {
        return None;
    }
    Some(match serve() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    })
}
fn serve() -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    let (results, responses) = mpsc::channel::<(Option<u64>, Receiver<Result<Reply, String>>)>();
    let cancellations = Arc::new(Mutex::new(HashMap::<u64, CancellationSource>::new()));
    thread::spawn(move || run_pdfium_owner(receiver));
    let completed = cancellations.clone();
    thread::spawn(move || {
        let mut out = std::io::stdout().lock();
        for (id, receiver) in responses {
            let result = receiver
                .recv()
                .unwrap_or_else(|_| Err("PDFium owner stopped".into()));
            if let Some(id) = id {
                completed.lock().unwrap().remove(&id);
            }
            let bytes = match result {
                Ok(Reply::Pixels(mut bytes)) => {
                    bytes.insert(0, 1);
                    bytes
                }
                result => {
                    let mut bytes = vec![0];
                    if serde_json::to_writer(&mut bytes, &result).is_err() {
                        break;
                    }
                    bytes
                }
            };
            if write_frame(&mut out, &bytes).is_err() {
                break;
            }
        }
    });
    let mut input = std::io::stdin().lock();
    loop {
        let bytes = read_frame(&mut input)?;
        match serde_json::from_slice::<Message>(&bytes).map_err(|e| e.to_string())? {
            Message::Cancel(id) => {
                let mut entries = cancellations.lock().unwrap();
                entries.entry(id).or_default().cancel();
                if entries.len() > 256 {
                    if let Some(oldest) = entries.keys().min().copied() {
                        entries.remove(&oldest);
                    }
                }
            }
            Message::Request(mut request) => {
                let (reply, response) = mpsc::channel();
                *request.reply_mut() = reply;
                let id = if let Request::Render {
                    request_id,
                    cancellation,
                    ..
                } = &mut request
                {
                    *cancellation = cancellations
                        .lock()
                        .unwrap()
                        .entry(*request_id)
                        .or_default()
                        .clone();
                    Some(*request_id)
                } else {
                    None
                };
                results.send((id, response)).map_err(|e| e.to_string())?;
                sender.send(request).map_err(|e| e.to_string())?;
            }
        }
    }
}
