mod backend;
mod ipc;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
fn main() {
    if let Some(code) = backend::maybe_run_interactive_helper()
        .or_else(backend::maybe_run_semantic_helper)
        .or_else(backend::maybe_run_preprocess_helper)
    {
        std::process::exit(code)
    }
    if let Err(error) = run() {
        eprintln!("Key backend: {error}");
        std::process::exit(1)
    }
}
fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--library")) {
        return Err("Usage: key-desktop-host --library WORKSPACE_DATABASE_DIRECTORY".into());
    }
    let root = PathBuf::from(arguments.next().ok_or("Missing library directory")?);
    if !root.is_absolute() {
        return Err("Library directory must be absolute".into());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .max_blocking_threads(8)
        .build()
        .map_err(|e| e.to_string())?;
    let host = Arc::new(backend::Host::new(root)?);
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let admission = Arc::new(tokio::sync::Semaphore::new(8));
    let mut input = std::io::stdin().lock();
    while let Some((envelope, binary)) = ipc::read_request(&mut input)? {
        if envelope.command == "host_can_suspend" {
            let idle = admission.available_permits() == 8 && host.can_suspend();
            ipc::write_response(
                &mut *out.lock().unwrap(),
                envelope.id,
                ipc::json_output(idle),
            )?;
            continue;
        }
        if let Some(result) = host.immediate(&envelope.command, &envelope.args) {
            ipc::write_response(&mut *out.lock().unwrap(), envelope.id, result)?;
            continue;
        }
        let permit = admission.clone().try_acquire_owned();
        let permit = match permit {
            Ok(p) => p,
            Err(_) => {
                ipc::write_response(
                    &mut *out.lock().unwrap(),
                    envelope.id,
                    Err("Backend busy; retry request".into()),
                )?;
                continue;
            }
        };
        let host = host.clone();
        let out = out.clone();
        runtime.spawn(async move {
            let _permit = permit;
            let mut headers = http::HeaderMap::new();
            for (name, value) in envelope.headers {
                let parsed = name
                    .parse::<http::header::HeaderName>()
                    .map_err(|_| ())
                    .and_then(|name| {
                        value
                            .parse::<http::HeaderValue>()
                            .map(|value| (name, value))
                            .map_err(|_| ())
                    });
                // Header parsing failures are returned without invoking a backend command.
                match parsed {
                    Ok((name, value)) => {
                        headers.insert(name, value);
                    }
                    Err(_) => {
                        let _ = ipc::write_response(
                            &mut *out.lock().unwrap(),
                            envelope.id,
                            Err("Invalid IPC header".into()),
                        );
                        return;
                    }
                }
            }
            let result = host
                .dispatch(&envelope.command, &envelope.args, &binary, &headers)
                .await;
            if let Err(error) = ipc::write_response(&mut *out.lock().unwrap(), envelope.id, result)
            {
                eprintln!("Key IPC output: {error}");
            }
        });
    }
    // Electron owns this process. EOF must also end helper ownership promptly.
    std::process::exit(0)
}
