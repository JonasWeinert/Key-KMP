import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pdfPath = path.resolve(process.argv[2] ?? '../../tests/fixtures/interaction.pdf');
const resultPath = path.resolve(process.argv[3] ?? 'benchmark-results/wasm.json');
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

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').setInputFiles(pdfPath);
  await page.locator('.pdf-pane').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: 'Benchmark' }).first().click();
  await page.waitForFunction(() => Boolean(window.__KEY_LAST_BENCHMARK__), null, {
    timeout: 120_000,
  });
  const result = await page.evaluate(() => window.__KEY_LAST_BENCHMARK__);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${resultPath}`);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
}
