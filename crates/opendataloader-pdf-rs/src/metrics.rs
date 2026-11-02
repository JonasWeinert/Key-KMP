use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Copy, Debug)]
pub struct ProcessSnapshot {
    at: Instant,
    user_seconds: f64,
    system_seconds: f64,
    resident_bytes: u64,
}

impl ProcessSnapshot {
    pub fn now() -> Self {
        let (user_seconds, system_seconds, resident_bytes) = process_usage();
        Self {
            at: Instant::now(),
            user_seconds,
            system_seconds,
            resident_bytes,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StageMetric {
    pub stage: String,
    pub calls: usize,
    pub wall_ms: f64,
    pub user_cpu_ms: f64,
    pub system_cpu_ms: f64,
    pub cpu_percent: f64,
    pub rss_before_bytes: u64,
    pub rss_after_bytes: u64,
    pub rss_change_bytes: i64,
    pub max_observed_rss_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct MetricsReport {
    pub total: StageMetric,
    pub stages: Vec<StageMetric>,
}

pub struct Profiler {
    origin: ProcessSnapshot,
    stages: Vec<StageMetric>,
}

impl Profiler {
    pub fn new() -> Self {
        Self {
            origin: ProcessSnapshot::now(),
            stages: Vec::new(),
        }
    }

    pub fn start(&self) -> ProcessSnapshot {
        ProcessSnapshot::now()
    }

    pub fn record(&mut self, stage: &str, before: ProcessSnapshot) {
        let after = ProcessSnapshot::now();
        let wall_ms = (after.at - before.at).as_secs_f64() * 1000.0;
        let user_ms = (after.user_seconds - before.user_seconds).max(0.0) * 1000.0;
        let system_ms = (after.system_seconds - before.system_seconds).max(0.0) * 1000.0;
        let entry = if let Some(entry) = self.stages.iter_mut().find(|entry| entry.stage == stage) {
            entry
        } else {
            self.stages.push(StageMetric {
                stage: stage.to_owned(),
                rss_before_bytes: before.resident_bytes,
                ..StageMetric::default()
            });
            self.stages.last_mut().unwrap()
        };
        entry.calls += 1;
        entry.wall_ms += wall_ms;
        entry.user_cpu_ms += user_ms;
        entry.system_cpu_ms += system_ms;
        entry.rss_after_bytes = after.resident_bytes;
        entry.max_observed_rss_bytes = entry
            .max_observed_rss_bytes
            .max(before.resident_bytes)
            .max(after.resident_bytes);
        entry.rss_change_bytes += after.resident_bytes as i64 - before.resident_bytes as i64;
        entry.cpu_percent = if entry.wall_ms > 0.0 {
            (entry.user_cpu_ms + entry.system_cpu_ms) / entry.wall_ms * 100.0
        } else {
            0.0
        };
    }

    pub fn report(&self) -> MetricsReport {
        let after = ProcessSnapshot::now();
        let mut total = StageMetric {
            stage: "total_process".to_owned(),
            calls: 1,
            wall_ms: (after.at - self.origin.at).as_secs_f64() * 1000.0,
            user_cpu_ms: (after.user_seconds - self.origin.user_seconds).max(0.0) * 1000.0,
            system_cpu_ms: (after.system_seconds - self.origin.system_seconds).max(0.0) * 1000.0,
            rss_before_bytes: self.origin.resident_bytes,
            rss_after_bytes: after.resident_bytes,
            rss_change_bytes: after.resident_bytes as i64 - self.origin.resident_bytes as i64,
            max_observed_rss_bytes: self
                .stages
                .iter()
                .map(|stage| stage.max_observed_rss_bytes)
                .max()
                .unwrap_or(after.resident_bytes)
                .max(after.resident_bytes),
            ..StageMetric::default()
        };
        total.cpu_percent = if total.wall_ms > 0.0 {
            (total.user_cpu_ms + total.system_cpu_ms) / total.wall_ms * 100.0
        } else {
            0.0
        };
        let mut stages = self.stages.clone();
        let accounted_wall: f64 = stages.iter().map(|stage| stage.wall_ms).sum();
        let accounted_user: f64 = stages.iter().map(|stage| stage.user_cpu_ms).sum();
        let accounted_system: f64 = stages.iter().map(|stage| stage.system_cpu_ms).sum();
        let mut overhead = StageMetric {
            stage: "unattributed_profiler_overhead".to_owned(),
            calls: 1,
            wall_ms: (total.wall_ms - accounted_wall).max(0.0),
            user_cpu_ms: (total.user_cpu_ms - accounted_user).max(0.0),
            system_cpu_ms: (total.system_cpu_ms - accounted_system).max(0.0),
            rss_before_bytes: total.rss_after_bytes,
            rss_after_bytes: total.rss_after_bytes,
            max_observed_rss_bytes: total.max_observed_rss_bytes,
            ..StageMetric::default()
        };
        overhead.cpu_percent = if overhead.wall_ms > 0.0 {
            (overhead.user_cpu_ms + overhead.system_cpu_ms) / overhead.wall_ms * 100.0
        } else {
            0.0
        };
        stages.push(overhead);
        MetricsReport { total, stages }
    }
}

impl Default for Profiler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
fn process_usage() -> (f64, f64, u64) {
    #[repr(C)]
    #[derive(Default)]
    struct ProcTaskInfo {
        virtual_size: u64,
        resident_size: u64,
        total_user: u64,
        total_system: u64,
        threads_user: u64,
        threads_system: u64,
        policy: i32,
        faults: i32,
        pageins: i32,
        cow_faults: i32,
        messages_sent: i32,
        messages_received: i32,
        syscalls_mach: i32,
        syscalls_unix: i32,
        context_switches: i32,
        thread_count: i32,
        running_threads: i32,
        priority: i32,
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            size: i32,
        ) -> i32;
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
    }
    #[repr(C)]
    #[derive(Default)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }
    let mut info = ProcTaskInfo::default();
    let size = std::mem::size_of::<ProcTaskInfo>() as i32;
    // PROC_PIDTASKINFO. CPU counters are nanoseconds on Darwin.
    let written = unsafe {
        proc_pidinfo(
            std::process::id() as i32,
            4,
            0,
            (&mut info as *mut ProcTaskInfo).cast(),
            size,
        )
    };
    if written == size {
        let mut timebase = MachTimebaseInfo::default();
        let timebase_ok = unsafe { mach_timebase_info(&mut timebase) } == 0 && timebase.denom != 0;
        let seconds_per_tick = if timebase_ok {
            timebase.numer as f64 / timebase.denom as f64 / 1_000_000_000.0
        } else {
            1.0 / 1_000_000_000.0
        };
        (
            info.total_user as f64 * seconds_per_tick,
            info.total_system as f64 * seconds_per_tick,
            info.resident_size,
        )
    } else {
        (0.0, 0.0, 0)
    }
}

#[cfg(not(target_os = "macos"))]
fn process_usage() -> (f64, f64, u64) {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0;
    if !ok {
        return (0.0, 0.0, current_rss_bytes());
    }
    let usage = unsafe { usage.assume_init() };
    let timeval = |value: libc::timeval| value.tv_sec as f64 + value.tv_usec as f64 / 1_000_000.0;
    (
        timeval(usage.ru_utime),
        timeval(usage.ru_stime),
        current_rss_bytes(),
    )
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> u64 {
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|value| value.split_whitespace().nth(1)?.parse::<u64>().ok())
        .map(|pages| pages * unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64)
        .unwrap_or(0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn current_rss_bytes() -> u64 {
    0
}
