import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pdfPath = path.resolve(process.argv[2] ?? '../../tests/fixtures/PUBMED_16226083.pdf');
const resultPath = path.resolve(process.argv[3] ?? 'benchmark-results/pdfjs-stress.json');
const interactionCycleCount = Number(process.argv[4] ?? 10);
const replacementCycleCount = Number(process.argv[5] ?? 6);
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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

  const server = await chromium.launchServer({
    headless: true,
    ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
  });
  const rootPid = server.process().pid;
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4173/?renderer=pdfjs', { waitUntil: 'networkidle' });
  await sleep(500);
  const baseline = treeTotals(rootPid);
  const input = page.locator('input[type=file]');

  const loadDocument = async () => {
    await page.evaluate(() => {
      window.__PDFJS_READY__ = false;
      window.__PDFJS_ERROR__ = undefined;
    });
    await input.setInputFiles(pdfPath);
    await page.waitForFunction(
      () => window.__PDFJS_READY__ === true || Boolean(window.__PDFJS_ERROR__),
      null,
      { timeout: 120_000 },
    );
    const error = await page.evaluate(() => window.__PDFJS_ERROR__);
    if (error) throw new Error(error);
  };

  await loadDocument();
  await sleep(300);
  const afterInitialLoad = treeTotals(rootPid);
  const interactionCycles = [];
  for (let cycle = 1; cycle <= interactionCycleCount; cycle += 1) {
    await page.evaluate(() => {
      window.__PDFJS_BENCHMARK_RESULT__ = undefined;
    });
    await page.getByRole('button', { name: 'Benchmark' }).click();
    await page.waitForFunction(() => Boolean(window.__PDFJS_BENCHMARK_RESULT__), null, {
      timeout: 120_000,
    });
    await sleep(100);
    interactionCycles.push({
      cycle,
      resources: treeTotals(rootPid),
      cache: await page.evaluate(() => window.__PDFJS_BENCHMARK_RESULT__?.cache),
    });
  }

  const replacementCycles = [];
  for (let cycle = 1; cycle <= replacementCycleCount; cycle += 1) {
    await input.setInputFiles([]);
    await loadDocument();
    await sleep(250);
    replacementCycles.push({ cycle, resources: treeTotals(rootPid) });
  }

  const output = {
    schemaVersion: 1,
    fixture: pdfPath,
    environment: 'Playwright Chromium headless, 1440x900, DPR 2',
    baseline,
    afterInitialLoad,
    interactionCycles,
    replacementCycles,
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  await browser.close();
  await server.close();
} finally {
  preview.kill('SIGTERM');
}
