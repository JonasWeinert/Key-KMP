import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const pdfPath = path.resolve(
  process.argv[2] ?? '../../tests/fixtures/interaction.pdf',
);
const port = 4175;
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const preview = spawn(
  'npm',
  ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

async function dragAcross(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Selectable text has no bounds');
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, {
    steps: 14,
  });
  await page.mouse.up();
}

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
    viewport: { width: 1440, height: 920 },
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${port}/?renderer=pdfjs-workspace`);
  await page.evaluate(() => localStorage.clear());
  await page.locator('input[type=file]').setInputFiles(pdfPath);
  await page.waitForFunction(() => window.__PDFJS_READY__ === true, null, {
    timeout: 30_000,
  });

  const firstLine = page.locator('.pdfjs-text-run', {
    hasText: 'Select this sentence',
  });
  await dragAcross(page, firstLine);
  await page.getByRole('button', { name: 'Add note' }).click();

  const editor = page.locator('.markdown-editor-surface');
  await editor.fill('Feature smoke-test note');
  await editor.press('Meta+A');
  await page.getByRole('button', { name: 'Bold' }).click();
  if ((await editor.locator('strong, b').count()) !== 1) {
    throw new Error(
      `The reusable editor did not render bold formatting immediately: ${await editor.innerHTML()}`,
    );
  }
  if ((await editor.innerText()).includes('**')) {
    throw new Error('The editor exposed Markdown syntax');
  }
  await page.getByRole('button', { name: 'Save comment' }).click();

  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.pdfjs-highlight.color-orange.has-comment',
      ).length > 0,
  );
  const commentCard = page.locator('.key-control-cards > .comment-card').first();
  await commentCard.waitFor();
  if ((await commentCard.locator('.key-control-card-quote').count()) !== 1) {
    throw new Error('Comment card quote preview is missing');
  }
  if ((await commentCard.locator('.key-control-card-detail strong').count()) !== 1) {
    throw new Error('Comment card did not render Markdown formatting');
  }
  if ((await commentCard.locator('.key-control-card-footer').innerText()) !== 'Page 1') {
    throw new Error('Comment card page number is not in its footer');
  }

  await commentCard.click();
  await editor.waitFor();
  if (
    (await editor.locator('strong, b').count()) !== 1 ||
    (await editor.innerText()).includes('**')
  ) {
    throw new Error('Existing comment did not reopen as formatted rich text');
  }
  await page.getByRole('button', { name: 'Cancel' }).click();
  await firstLine.click();
  await page.getByRole('button', { name: 'blue highlight' }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.pdfjs-highlight.color-blue.has-comment').length >
      0,
  );

  const secondLine = page.locator('.pdfjs-text-run', {
    hasText: 'Horizontal scrolling',
  });
  await dragAcross(page, secondLine);
  const swatchBackgrounds = await page
    .locator('.pdfjs-color-button')
    .evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).backgroundColor),
    );
  if (new Set(swatchBackgrounds).size !== 5 || swatchBackgrounds.includes('rgba(0, 0, 0, 0)')) {
    throw new Error(`Annotation color swatches are not distinct: ${swatchBackgrounds.join(', ')}`);
  }
  await page.getByRole('button', { name: 'pink highlight' }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.pdfjs-highlight.color-pink:not(.has-comment)',
      ).length > 0,
  );

  const cardBackground = await commentCard.evaluate(
    element => getComputedStyle(element).backgroundColor,
  );
  await page.screenshot({
    path: '/tmp/key-comment-workspace-ux.png',
    fullPage: true,
  });
  console.log(
    JSON.stringify(
      {
        orangeDefault: true,
        commentUnderline: true,
        colorChangePreservedComment: true,
        plainHighlightHasNoUnderline: true,
        markdownHidden: true,
        commentCardBackground: cardBackground,
        screenshot: '/tmp/key-comment-workspace-ux.png',
      },
      null,
      2,
    ),
  );
  await browser.close();
} finally {
  preview.kill('SIGTERM');
}
