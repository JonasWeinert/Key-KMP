import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pdfPath = path.resolve(process.argv[2] ?? '../../tests/fixtures/PUBMED_16226083.pdf');
const resultPath = path.resolve(process.argv[3] ?? 'benchmark-results/hepr.json');
const repetitions = Number(process.argv[4] ?? 3);
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = {
  headless: true,
  ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const percentile = (values, fraction) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    return match
      ? { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpu: Number(match[4]) }
      : null;
  }).filter(Boolean);
}

function treeTotals(rootPid) {
  const rows = processRows();
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  const tree = rows.filter(row => pids.has(row.pid));
  return {
    rssMiB: tree.reduce((sum, row) => sum + row.rssKiB, 0) / 1024,
    cpuPercent: tree.reduce((sum, row) => sum + row.cpu, 0),
    processCount: tree.length,
  };
}

const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite preview did not start')), 20_000);
    preview.stdout.on('data', chunk => {
      if (String(chunk).includes('4173')) {
        clearTimeout(timer);
        resolve();
      }
    });
    preview.on('exit', code => reject(new Error(`Vite preview exited with ${code}`)));
  });

  const runs = [];
  for (let run = 0; run < repetitions; run += 1) {
    const server = await chromium.launchServer(launchOptions);
    const rootPid = server.process().pid;
    const browser = await chromium.connect(server.wsEndpoint());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const samples = [];
    let phase = 'baseline';
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        samples.push({ at: performance.now(), phase, ...treeTotals(rootPid) });
        await sleep(50);
      }
    })();

    await page.goto('http://127.0.0.1:4173/?renderer=hepr', { waitUntil: 'networkidle' });
    await sleep(500);
    phase = 'load';
    await page.locator('input[type=file]').setInputFiles(pdfPath);
    await page.waitForFunction(
      () => window.__HEPR_READY__ === true || Boolean(window.__HEPR_ERROR__),
      null,
      { timeout: 120_000 },
    );
    const error = await page.evaluate(() => window.__HEPR_ERROR__);
    if (error) throw new Error(error);
    if (run === 0) {
      await page.screenshot({
        path: resultPath.replace(/\.json$/i, '.png'),
        fullPage: true,
      });
    }
    phase = 'idle';
    await sleep(750);
    phase = 'interaction';
    await page.getByRole('button', { name: 'Benchmark' }).click();
    await page.waitForFunction(() => Boolean(window.__HEPR_BENCHMARK_RESULT__), null, {
      timeout: 120_000,
    });
    phase = 'settled';
    await sleep(500);
    sampling = false;
    await sampler;
    const benchmark = await page.evaluate(() => window.__HEPR_BENCHMARK_RESULT__);

    const summarizePhase = wanted => {
      const phaseSamples = samples.filter(sample => sample.phase === wanted);
      const rss = phaseSamples.map(sample => sample.rssMiB);
      const cpu = phaseSamples.map(sample => sample.cpuPercent);
      return {
        samples: phaseSamples.length,
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
        maximumProcessCount: Math.max(0, ...phaseSamples.map(sample => sample.processCount)),
      };
    };
    runs.push({
      run: run + 1,
      benchmark,
      resources: {
        baseline: summarizePhase('baseline'),
        load: summarizePhase('load'),
        idle: summarizePhase('idle'),
        interaction: summarizePhase('interaction'),
        settled: summarizePhase('settled'),
      },
    });
    await browser.close();
    await server.close();
  }

  const median = values => percentile(values, 0.5);
  const result = {
    schemaVersion: 1,
    fixture: pdfPath,
    repetitions,
    environment: 'Playwright Chromium headless, 1440x900, DPR 2',
    medians: {
      loadTotalMs: median(runs.map(run => run.benchmark.loadMs.total)),
      interactionMs: median(runs.map(run => run.benchmark.interactionMs)),
      p95FrameIntervalMs: median(runs.map(run => run.benchmark.frameIntervals.p95)),
      maximumFrameIntervalMs: median(runs.map(run => run.benchmark.frameIntervals.maximum)),
      idleRssMiB: median(runs.map(run => run.resources.idle.rssMiB.median)),
      interactionPeakRssMiB: median(runs.map(run => run.resources.interaction.rssMiB.maximum)),
      loadPeakRssMiB: median(runs.map(run => run.resources.load.rssMiB.maximum)),
      baselineRssMiB: median(runs.map(run => run.resources.baseline.rssMiB.median)),
    },
    runs,
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  preview.kill('SIGTERM');
}
