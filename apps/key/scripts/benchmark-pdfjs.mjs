import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pdfPath = path.resolve(process.argv[2] ?? '../../tests/fixtures/PUBMED_16226083.pdf');
const resultPath = path.resolve(process.argv[3] ?? 'benchmark-results/pdfjs.json');
const repetitions = Number(process.argv[4] ?? 3);
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const percentile = (values, fraction) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

function treeTotals(rootPid) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], { encoding: 'utf8' });
  if (result.status !== 0) return { rssMiB: 0, cpuPercent: 0, processCount: 0 };
  const rows = result.stdout.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    return match
      ? { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpu: Number(match[4]) }
      : null;
  }).filter(Boolean);
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
    const server = await chromium.launchServer({
      headless: true,
      ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
    });
    const rootPid = server.process().pid;
    const browser = await chromium.connect(server.wsEndpoint());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const samples = [];
    let phase = 'baseline';
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        samples.push({ phase, ...treeTotals(rootPid) });
        await sleep(50);
      }
    })();

    await page.goto('http://127.0.0.1:4173/?renderer=pdfjs', { waitUntil: 'networkidle' });
    await sleep(500);
    phase = 'load';
    await page.locator('input[type=file]').setInputFiles(pdfPath);
    await page.waitForFunction(
      () => window.__PDFJS_READY__ === true || Boolean(window.__PDFJS_ERROR__),
      null,
      { timeout: 120_000 },
    );
    const error = await page.evaluate(() => window.__PDFJS_ERROR__);
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
    await page.waitForFunction(() => Boolean(window.__PDFJS_BENCHMARK_RESULT__), null, {
      timeout: 120_000,
    });
    const benchmark = await page.evaluate(() => window.__PDFJS_BENCHMARK_RESULT__);
    phase = 'settled';
    await sleep(500);
    sampling = false;
    await sampler;

    const summarize = wanted => {
      const values = samples.filter(sample => sample.phase === wanted);
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
    };
    runs.push({
      run: run + 1,
      benchmark,
      resources: {
        baseline: summarize('baseline'),
        load: summarize('load'),
        idle: summarize('idle'),
        interaction: summarize('interaction'),
        settled: summarize('settled'),
      },
    });
    await browser.close();
    await server.close();
  }

  const median = values => percentile(values, 0.5);
  const output = {
    schemaVersion: 1,
    fixture: pdfPath,
    repetitions,
    environment: 'Playwright Chromium headless, 1440x900, DPR 2',
    medians: {
      loadTotalMs: median(runs.map(run => run.benchmark.loadMs)),
      interactionMs: median(runs.map(run => run.benchmark.interactionMs)),
      p95FrameIntervalMs: median(runs.map(run => run.benchmark.frameIntervals.p95)),
      maximumFrameIntervalMs: median(runs.map(run => run.benchmark.frameIntervals.maximum)),
      exactSettleP95Ms: median(runs.map(run => run.benchmark.exactRenderSettleMs.p95)),
      baselineRssMiB: median(runs.map(run => run.resources.baseline.rssMiB.median)),
      idleRssMiB: median(runs.map(run => run.resources.idle.rssMiB.median)),
      interactionPeakRssMiB: median(runs.map(run => run.resources.interaction.rssMiB.maximum)),
      loadPeakRssMiB: median(runs.map(run => run.resources.load.rssMiB.maximum)),
    },
    runs,
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} finally {
  preview.kill('SIGTERM');
}
