import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixtureDirectory = path.resolve(process.argv[2] ?? '../../tests/fixtures');
const resultPath = path.resolve(
  process.argv[3] ?? 'benchmark-results/pdfjs-workspace-tiered-tauri.json',
);
const requestedCount = Number(process.argv[4] ?? 12);
const repetitions = Number(process.argv[5] ?? 3);
const binary = path.resolve(
  'src-tauri/target/release/bundle/macos/Key.app/Contents/MacOS/key',
);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const fixtureNames = (await readdir(fixtureDirectory))
  .filter(name => /^PUBMED_.*\.pdf$/i.test(name))
  .sort((left, right) => {
    if (left.includes('16226083')) return -1;
    if (right.includes('16226083')) return 1;
    return left.localeCompare(right);
  })
  .slice(0, requestedCount);
if (fixtureNames.length < 3) {
  throw new Error(`Need at least 3 PDF fixtures; found ${fixtureNames.length}`);
}
const fixtures = fixtureNames.map(name => path.join(fixtureDirectory, name));

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};
const median = values => percentile(values, 0.5);

function processRows() {
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

function processTree(rows, seeds) {
  const included = new Set(seeds);
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

function summarize(samples) {
  const rss = samples.map(sample => sample.rssMiB);
  const cpu = samples.map(sample => sample.cpuPercent);
  return {
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
  };
}

const runs = [];
for (let run = 1; run <= repetitions; run += 1) {
  const before = new Set(processRows().map(row => row.pid));
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      KEY_BENCHMARK_PDFS: fixtures.join(path.delimiter),
      KEY_WORKSPACE_BENCHMARK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seeds = new Set([child.pid]);
  const samples = [];
  let phase = 'startup';
  let result;
  let buffer = '';
  let diagnosticOutput = '';
  let sampling = true;
  let reportResolve;
  let reportReject;
  const report = new Promise((resolve, reject) => {
    reportResolve = resolve;
    reportReject = reject;
  });
  const parse = chunk => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const phaseMatch = line.match(/^\[key-benchmark-phase\] (.+)$/);
      if (phaseMatch) {
        phase = phaseMatch[1];
        continue;
      }
      const resultMatch = line.match(/^\[key-benchmark-result\] (.+)$/);
      if (resultMatch) {
        try {
          result = JSON.parse(resultMatch[1]);
          if (result.error) throw new Error(result.error);
          reportResolve(result);
        } catch (error) {
          reportReject(error);
        }
      } else if (line.trim()) {
        diagnosticOutput += `${line}\n`;
      }
    }
  };
  child.stdout.on('data', parse);
  child.stderr.on('data', parse);
  child.on('exit', code => {
    if (!result) {
      reportReject(new Error(`Tauri workspace benchmark exited with ${code}\n${diagnosticOutput}`));
    }
  });

  const sampler = (async () => {
    while (sampling) {
      const rows = processRows();
      for (const row of rows) {
        if (
          !before.has(row.pid) &&
          (row.command.includes('/Key.app/') ||
            row.command.endsWith('/key') ||
            row.command.includes('WebKit.WebContent') ||
            row.command.includes('WebKit.Networking') ||
            row.command.includes('WebKit.GPU'))
        ) {
          seeds.add(row.pid);
        }
      }
      const tree = processTree(rows, seeds);
      samples.push({
        phase,
        rssMiB: tree.reduce((sum, process) => sum + process.rssKiB, 0) / 1024,
        cpuPercent: tree.reduce((sum, process) => sum + process.cpuPercent, 0),
        processCount: tree.length,
        processes: tree.map(process => ({
          command: process.command,
          rssMiB: process.rssKiB / 1024,
          cpuPercent: process.cpuPercent,
        })),
      });
      await sleep(50);
    }
  })();

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Tauri workspace benchmark timed out\n${diagnosticOutput}`)),
      180_000,
    );
  });
  await Promise.race([report, timeout]).finally(() => clearTimeout(timeoutId));
  await sleep(1_000);
  sampling = false;
  await sampler;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));

  const phaseNames = [...new Set(samples.map(sample => sample.phase))];
  const peakSample = samples.reduce(
    (peak, sample) => (sample.rssMiB > peak.rssMiB ? sample : peak),
    samples[0],
  );
  runs.push({
    run,
    benchmark: result,
    peak: summarize(samples),
    phases: Object.fromEntries(
      phaseNames.map(name => [
        name,
        summarize(samples.filter(sample => sample.phase === name)),
      ]),
    ),
    peakProcessCount: Math.max(...samples.map(sample => sample.processCount)),
    peakProcesses: peakSample.processes,
  });
}

const output = {
  schemaVersion: 1,
  fixtureDirectory,
  fixtures,
  repetitions,
  environment: 'Tauri 2 release bundle, macOS WebKit, PDF.js workspace tier policy',
  medians: {
    peakRssMiB: median(runs.map(run => run.peak.rssMiB.maximum)),
    twoFullRssMiB: median(
      runs.map(run => run.phases['two-full-ready']?.rssMiB.median ?? 0),
    ),
    tieredSettlingRssMiB: median(
      runs.map(run => run.phases['tiered-settling']?.rssMiB.median ?? 0),
    ),
    settledRssMiB: median(
      runs.map(run => run.phases.settled?.rssMiB.median ?? 0),
    ),
  },
  runs,
};
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
