//! Conservative admission based on available system memory. This is a soft
//! budget: OS/GPU allocations cannot be given a hard limit through this API.
use std::{
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
static CPU_PERCENT: AtomicU32 = AtomicU32::new(0);
const MIB: u64 = 1024 * 1024;
#[derive(Clone, Copy, Debug)]
pub struct MemorySample {
    pub available: u64,
    pub total: u64,
}
impl MemorySample {
    pub fn worker_limit(self, configured: usize) -> usize {
        if self.total == 0 {
            return 1.min(configured);
        }
        let reserve = (self.total / 20).max(512 * MIB);
        ((self.available.saturating_sub(reserve) / (384 * MIB)) as usize).min(configured)
    }
}
pub fn memory_sample() -> MemorySample {
    static SAMPLE: OnceLock<Mutex<(sysinfo::System, Instant)>> = OnceLock::new();
    let mut state = SAMPLE
        .get_or_init(|| {
            let mut system = sysinfo::System::new();
            system.refresh_memory();
            system.refresh_cpu_usage();
            Mutex::new((system, Instant::now()))
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if state.1.elapsed() >= Duration::from_secs(1) {
        state.0.refresh_memory();
        state.0.refresh_cpu_usage();
        CPU_PERCENT.store(state.0.global_cpu_usage().round() as u32, Ordering::Relaxed);
        state.1 = Instant::now();
    }
    MemorySample {
        available: state.0.available_memory(),
        total: state.0.total_memory(),
    }
}
/// Used between bounded inference batches. Fail retryably under extreme
/// pressure rather than starting another large ONNX allocation.
pub fn check_batch_memory() -> Result<(), String> {
    let sample = memory_sample();
    if sample.total > 0 && sample.available < 128 * MIB {
        Err("Processing paused by low system memory; retry when memory is available".into())
    } else {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_preserves_headroom_and_obeys_worker_cap() {
        assert_eq!(
            MemorySample {
                total: 8 * 1024 * MIB,
                available: 256 * MIB
            }
            .worker_limit(2),
            0
        );
        assert_eq!(
            MemorySample {
                total: 8 * 1024 * MIB,
                available: 1000 * MIB
            }
            .worker_limit(2),
            1
        );
        assert_eq!(
            MemorySample {
                total: 8 * 1024 * MIB,
                available: 4096 * MIB
            }
            .worker_limit(2),
            2
        );
        assert_eq!(
            MemorySample {
                total: 0,
                available: 0
            }
            .worker_limit(2),
            1
        );
    }
}

/// CPU pressure reduces concurrent background work but always leaves one lane
/// eligible when memory permits. Interactive PDF work has a separate owner.
pub fn adaptive_worker_limit(configured: usize) -> usize {
    let memory = memory_sample().worker_limit(configured);
    if CPU_PERCENT.load(Ordering::Relaxed) >= 85 {
        memory.min(1)
    } else {
        memory
    }
}
static INTERACTION: OnceLock<Mutex<Option<(Instant, Instant)>>> = OnceLock::new();
pub fn mark_interaction() {
    let now = Instant::now();
    let mut state = INTERACTION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let first = state
        .filter(|(_, last)| last.elapsed() < Duration::from_millis(750))
        .map(|(first, _)| first)
        .unwrap_or(now);
    *state = Some((first, now));
}
pub fn background_admitted() -> bool {
    INTERACTION.get().is_none_or(|state| {
        let state = state.lock().unwrap_or_else(|e| e.into_inner());
        state.is_none_or(|(first, last)| {
            last.elapsed() >= Duration::from_millis(500)
                || first.elapsed() >= Duration::from_secs(5)
        })
    })
}
