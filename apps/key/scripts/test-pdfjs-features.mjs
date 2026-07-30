import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const pdfPath = path.resolve(
  process.argv[2] ?? '../../tests/fixtures/PUBMED_16226083.pdf',
);
const port = 4174;
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const preview = spawn(
  'npm',
  ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite preview did not start')), 20_000);
    preview.stdout.on('data', chunk => {
      if (String(chunk).includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    });
    preview.on('exit', code => reject(new Error(`Vite preview exited with ${code}`)));
  });

  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${port}/?renderer=pdfjs`);
  await page.evaluate(() => localStorage.clear());
  await page.locator('input[type=file]').setInputFiles(pdfPath);
  await page.waitForFunction(() => window.__PDFJS_READY__ === true, null, {
    timeout: 30_000,
  });

  const search = page.getByLabel('Search this PDF');
  await search.fill('telemedicine');
  await page.waitForFunction(
    () => document.querySelector('.pdfjs-search-count')?.textContent === '1/3',
  );
  const searchCount = await page.locator('.pdfjs-search-count').textContent();

  const line = page.locator('.pdfjs-text-run', { hasText: 'telemedicine project' });
  const box = await line.boundingBox();
  if (!box) throw new Error('Selectable title line has no bounds');
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.getByRole('toolbar', { name: 'Text selection actions' }).waitFor();
  const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  if (!selectedText.trim()) throw new Error('Native browser selection remained empty');

  await page.getByRole('button', { name: 'orange highlight' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.pdfjs-highlight.color-orange').length > 0,
  );

  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Add note|Edit note/ }).click();
  await page.locator('.markdown-editor-surface').fill('Feature smoke-test note');
  await page.getByRole('button', { name: 'Save comment' }).click();
  await page.getByText('Feature smoke-test note').waitFor();

  await page.reload();
  await page.locator('input[type=file]').setInputFiles(pdfPath);
  await page.waitForFunction(() => window.__PDFJS_READY__ === true, null, {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: /Comments/ }).click();
  await page.getByText('Feature smoke-test note').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.pdfjs-page-fallback') instanceof HTMLCanvasElement,
  );
  const fallback = await page.evaluate(() => {
    const canvas = document.querySelector('.pdfjs-page-fallback');
    const host = canvas?.closest('.pdfjs-page');
    if (!(canvas instanceof HTMLCanvasElement) || !host) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      rasterWidth: canvas.width,
      coversWidth: Math.abs(canvasRect.width - hostRect.width) < 1,
      coversHeight: Math.abs(canvasRect.height - hostRect.height) < 1,
    };
  });
  if (!fallback?.coversWidth || !fallback?.coversHeight) {
    throw new Error('Blur fallback does not cover the entire visible page');
  }

  const touchZoomBefore = await page.locator('.pdfjs-zoom-value').textContent();
  await page.evaluate(() => {
    const target = document.querySelector('.pdfjs-scroll');
    if (!target || typeof Touch !== 'function') throw new Error('Touch events are unavailable');
    const touch = (identifier, clientX, clientY) =>
      new Touch({ identifier, target, clientX, clientY });
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [touch(1, 600, 420), touch(2, 800, 420)],
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [touch(1, 560, 420), touch(2, 840, 420)],
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
      }),
    );
  });
  await page.waitForFunction(
    before => document.querySelector('.pdfjs-zoom-value')?.textContent !== before,
    touchZoomBefore,
  );
  const touchZoom = await page.locator('.pdfjs-zoom-value').textContent();

  await page.keyboard.down('Control');
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await page.waitForFunction(
    () => document.querySelector('.pdfjs-zoom-value')?.textContent !== '100%',
  );

  const result = await page.evaluate(() => ({
    highlights: document.querySelectorAll('.pdfjs-highlight').length,
    comments: document.querySelectorAll('.pdfjs-comment-list > button').length,
    zoom: document.querySelector('.pdfjs-zoom-value')?.textContent ?? '',
    textRuns: document.querySelectorAll('.pdfjs-text-run').length,
  }));
  result.selectedText = selectedText;
  result.searchCount = searchCount;
  result.touchZoom = touchZoom;
  result.fallback = fallback;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
}
