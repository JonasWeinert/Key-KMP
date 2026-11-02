//! Bounded document work queue. Waiting documents retain closures and paths,
//! not a thread stack or PDF buffer. Aging prevents background starvation.
mod helper;
mod pressure;
pub use helper::{acquire_lease, run_helper};
pub use pressure::{
    MemorySample, adaptive_worker_limit, background_admitted, check_batch_memory, mark_interaction,
    memory_sample,
};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    thread,
    time::Instant,
};
type Task = Box<dyn FnOnce() + Send + 'static>;
struct Job {
    key: String,
    document: String,
    priority: i64,
    queued: Instant,
    task: Task,
}
struct Queue {
    jobs: Vec<Job>,
    boosts: HashMap<String, Instant>,
    background: usize,
    active: usize,
    active_documents: HashMap<String, usize>,
    stopped: bool,
    yielded: Option<String>,
}
struct Inner {
    queue: Mutex<Queue>,
    wake: Condvar,
}
pub const YIELDED_TO_READER: &str = "processing yielded to active reader";
static SCHEDULERS: OnceLock<Mutex<Vec<Weak<Inner>>>> = OnceLock::new();
/// Preempt only for a newer explicitly selected reader with pending semantic
/// work. Do not repeatedly kill long reconciliation jobs on a fixed timer.
pub fn should_yield_to_reader(document: &str) -> bool {
    let Some(registry) = SCHEDULERS.get() else {
        return false;
    };
    let mut registry = registry.lock().unwrap_or_else(|e| e.into_inner());
    registry.retain(|item| item.strong_count() > 0);
    registry.iter().filter_map(Weak::upgrade).any(|inner| {
        let queue = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
        if !queue.active_documents.contains_key(document)
            && !queue.jobs.iter().any(|job| job.document == document)
        {
            return false;
        }
        let current = queue.boosts.get(document);
        queue
            .jobs
            .iter()
            .filter(|job| job.priority <= 0 && job.document != document)
            .any(|job| {
                queue.boosts.get(&job.document).is_some_and(|time| {
                    time.elapsed().as_secs() < 60 && current.is_none_or(|old| time > old)
                })
            })
    })
}
/// Fairness only at a newly durable checkpoint. Callers exclude reconciliation
/// and final publication, whose work cannot yet be resumed halfway through.
pub fn should_yield_checkpoint(document: &str, elapsed: std::time::Duration) -> bool {
    if elapsed < std::time::Duration::from_secs(15) {
        return false;
    }
    let Some(registry) = SCHEDULERS.get() else {
        return false;
    };
    registry
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter_map(Weak::upgrade)
        .any(|inner| {
            let mut queue = inner.queue.lock().unwrap_or_else(|e| e.into_inner());
            if !queue.active_documents.contains_key(document)
                && !queue.jobs.iter().any(|job| job.document == document)
            {
                return false;
            }
            let pending = queue
                .jobs
                .iter()
                .any(|job| job.priority <= 0 && job.document != document);
            if pending {
                queue.yielded = Some(document.to_owned());
            }
            pending
        })
}
struct Owner {
    inner: Arc<Inner>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let mut queue = self.inner.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.stopped = true;
        queue.jobs.clear();
        self.inner.wake.notify_all();
    }
}
#[derive(Clone)]
pub struct Scheduler {
    owner: Arc<Owner>,
}
impl Scheduler {
    pub fn new(workers: usize) -> Self {
        assert!(workers > 0 && workers <= 8);
        let inner = Arc::new(Inner {
            queue: Mutex::new(Queue {
                jobs: Vec::new(),
                boosts: HashMap::new(),
                background: 0,
                active: 0,
                active_documents: HashMap::new(),
                stopped: false,
                yielded: None,
            }),
            wake: Condvar::new(),
        });
        SCHEDULERS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Arc::downgrade(&inner));
        for n in 0..workers {
            let state = Arc::clone(&inner);
            thread::Builder::new()
                .name(format!("key-processing-{n}"))
                .spawn(move || {
                    loop {
                        let job = {
                            let mut queue = state.queue.lock().unwrap_or_else(|e| e.into_inner());
                            loop {
                                if queue.stopped {
                                    return;
                                }
                                queue.boosts.retain(|_, time| time.elapsed().as_secs() < 60);
                                let index = queue
                                    .jobs
                                    .iter()
                                    .enumerate()
                                    .filter(|(_, job)| {
                                        (job.priority > 0 || queue.background == 0)
                                            && queue.active < adaptive_worker_limit(workers)
                                            && (job.priority > 0 || background_admitted())
                                    })
                                    .max_by_key(|(index, job)| {
                                        (
                                            queue.yielded.as_deref() != Some(job.document.as_str()),
                                            job.priority
                                                + job.queued.elapsed().as_secs() as i64 / 5
                                                + if queue.boosts.contains_key(&job.document) {
                                                    20
                                                } else {
                                                    0
                                                },
                                            std::cmp::Reverse(*index),
                                        )
                                    })
                                    .map(|(index, _)| index);
                                if let Some(index) = index {
                                    let job = queue.jobs.remove(index);
                                    if job.priority <= 0 {
                                        queue.yielded = None;
                                    }
                                    queue.active += 1;
                                    *queue
                                        .active_documents
                                        .entry(job.document.clone())
                                        .or_default() += 1;
                                    if job.priority <= 0 {
                                        queue.background += 1;
                                    }
                                    break job;
                                }
                                queue = state
                                    .wake
                                    .wait_timeout(queue, std::time::Duration::from_secs(1))
                                    .unwrap_or_else(|e| e.into_inner())
                                    .0;
                            }
                        };
                        let background = job.priority <= 0;
                        let document = job.document;
                        // A malformed PDF must not permanently remove a worker from the pool.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job.task));
                        {
                            let mut queue = state.queue.lock().unwrap_or_else(|e| e.into_inner());
                            queue.active -= 1;
                            if let Some(count) = queue.active_documents.get_mut(&document) {
                                *count -= 1;
                                if *count == 0 {
                                    queue.active_documents.remove(&document);
                                }
                            }
                            if background {
                                queue.background -= 1;
                            }
                        }
                        state.wake.notify_all();
                    }
                })
                .expect("could not start processing worker");
        }
        Self {
            owner: Arc::new(Owner { inner }),
        }
    }
    pub fn submit(
        &self,
        document: String,
        stage: &str,
        priority: i64,
        task: impl FnOnce() + Send + 'static,
    ) {
        let key = format!("{document}:{stage}");
        let mut queue = self
            .owner
            .inner
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(job) = queue.jobs.iter_mut().find(|j| j.key == key) {
            job.task = Box::new(task);
            job.priority = priority;
        } else {
            queue.jobs.push(Job {
                key,
                document,
                priority,
                queued: Instant::now(),
                task: Box::new(task),
            });
        }
        self.owner.inner.wake.notify_one();
    }
    pub fn prioritize(&self, document: &str) {
        self.owner
            .inner
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .boosts
            .insert(document.into(), Instant::now());
        self.owner.inner.wake.notify_all();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_quantum_gives_another_document_a_turn_despite_reader_boost() {
        let scheduler = Scheduler::new(1);
        let (started, wait) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let (done, results) = std::sync::mpsc::channel();
        scheduler.submit("quantum-current".into(), "semantic", 0, move || {
            started.send(()).unwrap();
            blocked.recv().unwrap();
        });
        wait.recv().unwrap();
        scheduler.prioritize("quantum-current");
        for name in ["quantum-other", "quantum-current"] {
            let done = done.clone();
            scheduler.submit(name.into(), "semantic", 0, move || {
                done.send(name).unwrap();
            });
        }
        assert!(!should_yield_checkpoint(
            "quantum-current",
            std::time::Duration::from_secs(14)
        ));
        assert!(should_yield_checkpoint(
            "quantum-current",
            std::time::Duration::from_secs(15)
        ));
        release.send(()).unwrap();
        assert_eq!(results.recv().unwrap(), "quantum-other");
        assert_eq!(results.recv().unwrap(), "quantum-current");
    }
    #[test]
    fn bounds_work_and_prioritizes_reader_without_losing_retries() {
        let scheduler = Scheduler::new(1);
        let (started, wait) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let (done, results) = std::sync::mpsc::channel();
        scheduler.submit("block".into(), "test", 0, move || {
            started.send(()).unwrap();
            blocked.recv().unwrap();
        });
        wait.recv().unwrap();
        for (name, priority) in [("background", 0), ("reader", 10)] {
            let done = done.clone();
            scheduler.submit(name.into(), "test", priority, move || {
                done.send(name).unwrap()
            });
        }
        release.send(()).unwrap();
        assert_eq!(results.recv().unwrap(), "reader");
        assert_eq!(results.recv().unwrap(), "background");
    }
}

#[cfg(test)]
mod preemption_tests {
    use super::*;
    #[test]
    fn newer_reader_can_preempt_background_but_not_itself() {
        let scheduler = Scheduler::new(1);
        let (ready, started) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        scheduler.prioritize("preempt-old");
        scheduler.submit("preempt-old".into(), "semantic", 0, move || {
            ready.send(()).unwrap();
            blocked.recv().unwrap();
        });
        started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        scheduler.submit("preempt-new".into(), "semantic", 0, || {});
        assert!(!should_yield_to_reader("preempt-old"));
        scheduler.prioritize("preempt-new");
        assert!(should_yield_to_reader("preempt-old"));
        assert!(!should_yield_to_reader("preempt-new"));
        release.send(()).unwrap();
    }
}
