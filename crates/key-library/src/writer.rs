//! One bounded writer actor per library per process. SQLite serializes commits
//! across helper processes; transactions never contain extraction or inference.
use crate::{Result, err};
use rusqlite::Connection;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, Weak, mpsc},
    time::Duration,
};
type Work = Box<dyn FnOnce(&mut Connection) + Send>;
struct Queue {
    urgent: VecDeque<Work>,
    background: VecDeque<Work>,
    stopped: bool,
}
struct State {
    queue: Mutex<Queue>,
    wake: Condvar,
}
pub(crate) struct Writer {
    state: Arc<State>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Drop for Writer {
    fn drop(&mut self) {
        self.state
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stopped = true;
        self.state.wake.notify_all();
        if let Some(thread) = self
            .thread
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}
impl Writer {
    pub(crate) fn for_root(root: &Path) -> Result<Arc<Self>> {
        static WRITERS: OnceLock<Mutex<HashMap<PathBuf, Weak<Writer>>>> = OnceLock::new();
        let mut registry = WRITERS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(err)?;
        registry.retain(|_, v| v.strong_count() > 0);
        if let Some(writer) = registry.get(root).and_then(Weak::upgrade) {
            return Ok(writer);
        }
        let mut conn = Connection::open(root.join("library.sqlite3")).map_err(err)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
            .map_err(err)?;
        let state = Arc::new(State {
            queue: Mutex::new(Queue {
                urgent: VecDeque::new(),
                background: VecDeque::new(),
                stopped: false,
            }),
            wake: Condvar::new(),
        });
        let worker = state.clone();
        let thread = std::thread::Builder::new()
            .name("key-library-writer".into())
            .spawn(move || {
                let mut urgent_streak = 0;
                loop {
                    let task = {
                        let mut queue = worker.queue.lock().unwrap_or_else(|e| e.into_inner());
                        while queue.urgent.is_empty()
                            && queue.background.is_empty()
                            && !queue.stopped
                        {
                            queue = worker.wake.wait(queue).unwrap_or_else(|e| e.into_inner());
                        }
                        if queue.stopped && queue.urgent.is_empty() && queue.background.is_empty() {
                            return;
                        }
                        let task = if !queue.urgent.is_empty()
                            && (urgent_streak < 8 || queue.background.is_empty())
                        {
                            urgent_streak += 1;
                            queue.urgent.pop_front()
                        } else {
                            urgent_streak = 0;
                            queue.background.pop_front()
                        };
                        worker.wake.notify_all();
                        task
                    };
                    if let Some(task) = task {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            task(&mut conn)
                        }));
                    }
                }
            })
            .map_err(err)?;
        let writer = Arc::new(Self {
            state,
            thread: Mutex::new(Some(thread)),
        });
        registry.insert(root.to_owned(), Arc::downgrade(&writer));
        Ok(writer)
    }
    pub(crate) fn run<T: Send + 'static>(
        &self,
        urgent: bool,
        operation: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (reply, result) = mpsc::sync_channel(1);
        let mut queue = self.state.queue.lock().map_err(err)?;
        // Leave eight queue slots available to interactive saves.
        let limit = if urgent { 64 } else { 56 };
        while queue.urgent.len() + queue.background.len() >= limit && !queue.stopped {
            queue = self.state.wake.wait(queue).map_err(err)?;
        }
        if queue.stopped {
            return Err("Library writer stopped".into());
        }
        let task: Work = Box::new(move |conn| {
            let _ = reply.send(operation(conn));
        });
        if urgent {
            queue.urgent.push_back(task);
        } else {
            queue.background.push_back(task);
        }
        self.state.wake.notify_all();
        drop(queue);
        result
            .recv()
            .map_err(|_| "Library write failed before commit".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_interactive_save_precedes_background_and_connection_is_reused() {
        let root = tempfile::tempdir().unwrap();
        let writer = Writer::for_root(root.path()).unwrap();
        assert!(Arc::ptr_eq(
            &writer,
            &Writer::for_root(root.path()).unwrap()
        ));
        writer
            .run(true, |c| {
                c.execute_batch("CREATE TABLE ordering(n INTEGER);")
                    .map_err(err)
            })
            .unwrap();
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let first = writer.clone();
        let busy = std::thread::spawn(move || {
            first.run(false, move |_| {
                started.send(()).unwrap();
                wait.recv().unwrap();
                Ok(())
            })
        });
        ready.recv().unwrap();
        let background = writer.clone();
        let low = std::thread::spawn(move || {
            background.run(false, |c| {
                c.execute("INSERT INTO ordering VALUES(2)", [])
                    .map_err(err)?;
                Ok(())
            })
        });
        while writer.state.queue.lock().unwrap().background.is_empty() {
            std::thread::yield_now();
        }
        let interactive = writer.clone();
        let high = std::thread::spawn(move || {
            interactive.run(true, |c| {
                c.execute("INSERT INTO ordering VALUES(1)", [])
                    .map_err(err)?;
                Ok(())
            })
        });
        while writer.state.queue.lock().unwrap().urgent.is_empty() {
            std::thread::yield_now();
        }
        release.send(()).unwrap();
        busy.join().unwrap().unwrap();
        high.join().unwrap().unwrap();
        low.join().unwrap().unwrap();
        assert_eq!(
            writer
                .run(true, |c| {
                    let mut q = c
                        .prepare("SELECT n FROM ordering ORDER BY rowid")
                        .map_err(err)?;
                    let rows = q
                        .query_map([], |r| r.get::<_, i64>(0))
                        .map_err(err)?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(err)?;
                    Ok(rows)
                })
                .unwrap(),
            [1, 2]
        );
    }
}
