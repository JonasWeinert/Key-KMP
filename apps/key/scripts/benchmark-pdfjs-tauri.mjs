import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pdfPath = path.resolve(
  process.argv[2] ?? '../../tests/fixtures/PUBMED_16226083.pdf',
);
const resultPath = path.resolve(
  process.argv[3] ?? 'benchmark-results/pdfjs-tauri-features.json',
);
const repetitions = Number(process.argv[4] ?? 3);
const binary = path.resolve(
  'src-tauri/target/release/bundle/macos/Key.app/Contents/MacOS/key',
);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

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

function summarize(samples, phase) {
  const values = samples.filter(sample => sample.phase === phase);
  const rss = values.map(sample => sample.rssMiB);
  const cpu = values.map(sample => sample.cpuPercent);
  return {
    samples: values.length,
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
      KEY_BENCHMARK_PDF: pdfPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const samples = [];
  const helperSeeds = new Set([child.pid]);
  let phase = 'startup';
  let benchmark;
  let errorOutput = '';
  let sampling = true;
  let buffer = '';
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
          benchmark = JSON.parse(resultMatch[1]);
          phase = 'settled';
          reportResolve(benchmark);
        } catch (error) {
          reportReject(error);
        }
      } else if (line.trim()) {
        errorOutput += `${line}\n`;
      }
    }
  };
  child.stdout.on('data', parse);
  child.stderr.on('data', parse);
  child.on('exit', code => {
    if (!benchmark) reportReject(new Error(`Tauri benchmark exited with ${code}\n${errorOutput}`));
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
          helperSeeds.add(row.pid);
        }
      }
      const tree = processTree(rows, helperSeeds);
      samples.push({
        phase,
        rssMiB: tree.reduce((sum, process) => sum + process.rssKiB, 0) / 1024,
        cpuPercent: tree.reduce((sum, process) => sum + process.cpuPercent, 0),
        processCount: tree.length,
        processes: tree.map(({ pid, ppid, command }) => ({ pid, ppid, command })),
      });
      await sleep(50);
    }
  })();

  await sleep(200);
  spawnSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first process whose unix id is ${child.pid} to true`,
  ]);
  await Promise.race([
    report,
    sleep(60_000).then(() => {
      throw new Error(`Tauri benchmark timed out\n${errorOutput}`);
    }),
  ]);
  await sleep(600);
  sampling = false;
  await sampler;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  child.stdout.destroy();
  child.stderr.destroy();

  runs.push({
    run,
    benchmark,
    resources: Object.fromEntries(
      [
        'baseline-ready',
        'load-start',
        'load-ready',
        'feature-start',
        'feature-ready',
        'interaction-start',
        'settled',
      ].map(name => [name, summarize(samples, name)]),
    ),
    peakProcessCount: Math.max(...samples.map(sample => sample.processCount)),
    processNames: [
      ...new Set(samples.flatMap(sample => sample.processes.map(process => process.command))),
    ],
  });
}

const median = values => percentile(values, 0.5);
const output = {
  schemaVersion: 1,
  fixture: pdfPath,
  repetitions,
  environment: 'Tauri 2 release bundle, macOS WebKit, PDF.js frontend + disposable PDFium preprocessing sidecar',
  medians: {
    loadTotalMs: median(runs.map(run => run.benchmark.loadMs)),
    featureSetupMs: median(runs.map(run => run.benchmark.featureSetupMs)),
    interactionMs: median(runs.map(run => run.benchmark.interactionMs)),
    p95FrameIntervalMs: median(runs.map(run => run.benchmark.frameIntervals.p95)),
    maximumFrameIntervalMs: median(
      runs.map(run => run.benchmark.frameIntervals.maximum),
    ),
    exactSettleP95Ms: median(
      runs.map(run => run.benchmark.exactRenderSettleMs.p95),
    ),
    baselineRssMiB: median(
      runs.map(run => run.resources['baseline-ready'].rssMiB.median),
    ),
    loadedRssMiB: median(
      runs.map(run => run.resources['load-ready'].rssMiB.maximum),
    ),
    featureRssMiB: median(
      runs.map(run => run.resources['feature-ready'].rssMiB.maximum),
    ),
    interactionPeakRssMiB: median(
      runs.map(run => run.resources['interaction-start'].rssMiB.maximum),
    ),
    settledRssMiB: median(
      runs.map(run => run.resources.settled.rssMiB.median),
    ),
  },
  runs,
};
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
process.exit(0);
