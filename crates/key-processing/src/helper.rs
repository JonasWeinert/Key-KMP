use key_library::{Library, ProcessingLease};
use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
pub fn acquire_lease(
    library: &Library,
    hash: &str,
    stage: &str,
) -> Result<ProcessingLease, String> {
    loop {
        if library.is_paused(hash)? {
            return Err("Processing paused".into());
        }
        if let Some(lease) = library.try_lease(hash, stage)? {
            return Ok(lease);
        }
        thread::sleep(Duration::from_millis(200));
    }
}
/// Supervise disposable extraction workers without retaining their output in RAM.
pub fn run_helper(
    command: Command,
    library: &Library,
    hash: &str,
    stage: &str,
) -> Result<(), String> {
    supervise(command, library, hash, stage, Duration::from_secs(300))
}
fn supervise(
    mut command: Command,
    library: &Library,
    hash: &str,
    stage: &str,
    stall_timeout: Duration,
) -> Result<(), String> {
    let lease = acquire_lease(library, hash, stage)?;
    let stderr = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut checkpoint = library.extraction_progress(hash)?;
    let initial_pages = library.artifact_count(hash, "semantic-raw-page")?;
    let quantum = Instant::now();
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr.reopen().map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut renewed = Instant::now();
    let mut checked = Instant::now();
    let mut changed = Instant::now();
    let result = (|| loop {
        if changed.elapsed() >= stall_timeout {
            return Err(format!(
                "{stage} helper stalled; completed checkpoints were retained for retry"
            ));
        }
        if checked.elapsed() >= Duration::from_secs(1) {
            let current = library.extraction_progress(hash)?;
            if current != checkpoint {
                checkpoint = current;
                changed = Instant::now();
            }
            if stage == "semantic-extraction"
                && current.is_some_and(|(done, total)| done < total)
                && crate::should_yield_checkpoint(hash, quantum.elapsed())
                && library.artifact_count(hash, "semantic-raw-page")? > initial_pages
            {
                return Err(crate::YIELDED_TO_READER.into());
            }
            checked = Instant::now();
        }
        if library.is_paused(hash)? {
            return Err("Processing paused".into());
        }
        if stage == "semantic-extraction" && crate::should_yield_to_reader(hash) {
            return Err(crate::YIELDED_TO_READER.into());
        }
        if renewed.elapsed() > Duration::from_secs(5) {
            lease.renew()?;
            renewed = Instant::now();
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            let mut detail = String::new();
            stderr
                .reopen()
                .map_err(|e| e.to_string())?
                .take(64 * 1024)
                .read_to_string(&mut detail)
                .map_err(|e| e.to_string())?;
            return Err(format!("{stage} helper exited with {status}: {detail}"));
        }
        thread::sleep(Duration::from_millis(100));
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn stalled_helper_is_reaped_and_lease_released() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"stall", "Stall", 1).unwrap();
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        let started = Instant::now();
        assert!(
            supervise(command, &lib, &hash, "test", Duration::from_millis(100))
                .unwrap_err()
                .contains("stalled")
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(lib.try_lease(&hash, "test").unwrap().is_some());
    }
    #[test]
    fn pause_terminates_helper_and_releases_lease() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = lib.store_source(b"pause", "Pause", 1).unwrap();
        let worker_lib = lib.clone();
        let worker_hash = hash.clone();
        let started = Instant::now();
        let worker = thread::spawn(move || {
            let mut cmd = Command::new("/bin/sleep");
            cmd.arg("30");
            run_helper(cmd, &worker_lib, &worker_hash, "test")
        });
        thread::sleep(Duration::from_millis(150));
        lib.pause(&hash, true).unwrap();
        assert!(worker.join().unwrap().unwrap_err().contains("paused"));
        assert!(started.elapsed() < Duration::from_secs(3));
        lib.pause(&hash, false).unwrap();
        assert!(lib.try_lease(&hash, "test").unwrap().is_some());
    }
}
