import { spawnSync } from 'node:child_process';

const rootPid = Number(process.argv[2]);
const durationMs = Number(process.argv[3] ?? 20) * 1_000;
const intervalMs = Number(process.argv[4] ?? 100);
const additionalPids = (process.argv[5] ?? '')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter(Number.isInteger);
if (!Number.isInteger(rootPid) || rootPid <= 0) {
  throw new Error('Usage: npm run benchmark:resources -- <tauri-pid> [seconds] [interval-ms]');
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const percentile = (values, fraction) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

function processes() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'ps failed');
  return result.stdout
    .trim()
    .split('\n')
    .map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKiB: Number(match[3]),
            cpuPercent: Number(match[4]),
            command: match[5],
          }
        : null;
    })
    .filter(Boolean);
}

function processTree(rows) {
  // macOS reparents WebKit XPC helpers to launchd, so callers can pass the
  // helpers created immediately after this app launch as an explicit seed.
  const included = new Set([rootPid, ...additionalPids]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.ppid) && !included.has(row.pid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => included.has(row.pid));
}

const samples = [];
const startedAt = new Date().toISOString();
const deadline = performance.now() + durationMs;
while (performance.now() < deadline) {
  const tree = processTree(processes());
  if (!tree.some(process => process.pid === rootPid)) break;
  samples.push({
    atMs: durationMs - Math.max(0, deadline - performance.now()),
    rssMiB: tree.reduce((sum, process) => sum + process.rssKiB, 0) / 1024,
    cpuPercent: tree.reduce((sum, process) => sum + process.cpuPercent, 0),
    processCount: tree.length,
    processes: tree.map(({ pid, ppid, command }) => ({ pid, ppid, command })),
  });
  await sleep(intervalMs);
}

const rss = samples.map(sample => sample.rssMiB);
const cpu = samples.map(sample => sample.cpuPercent);
const peak = samples.reduce(
  (best, sample) => (sample.rssMiB > (best?.rssMiB ?? -1) ? sample : best),
  null,
);
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      rootPid,
      additionalPids,
      startedAt,
      requestedDurationMs: durationMs,
      intervalMs,
      samples: samples.length,
      rssMiB: {
        median: percentile(rss, 0.5),
        p95: percentile(rss, 0.95),
        maximum: Math.max(0, ...rss),
      },
      cpuPercent: {
        median: percentile(cpu, 0.5),
        p95: percentile(cpu, 0.95),
        maximum: Math.max(0, ...cpu),
      },
      peakProcessCount: Math.max(0, ...samples.map(sample => sample.processCount)),
      processesAtPeakRss: peak?.processes ?? [],
    },
    null,
    2,
  ),
);
