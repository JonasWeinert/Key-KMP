// Run serially: native windows and focus are shared with other GUI checks.
// Several windows share one core: a tab pops out with its live view (no reload), library
// events reach every window, a tab moves back and the emptied window closes, and
// File › New Window opens a window that can close without quitting the app.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-windows-"));
  const fixture = path.join(temp, "Window study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  // The native views each window hosts, by webContents id.
  const hosted = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ id: w.id, views: w.contentView.children.map((v) => v.webContents.id) })),
    );
  const shellPages = () => app.windows().filter((p) => /index\.html$|^http:\/\/localhost:\d+\/?$/.test(p.url()));
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const [source] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.evaluate(
      ({ ws, source }) =>
        window.key.openSource({ documentId: source.fileHash ?? source.hash ?? source.id, documentHash: source.fileHash ?? source.hash ?? source.id, title: "Window study", workspaceId: ws }),
      { ws: ws.id, source: await page.evaluate(({ ws, id }) => window.key.invoke("store_source", { id }, ws), { ws: ws.id, id: source.id }) },
    );
    let reader;
    for (let i = 0; i < 100 && !reader; i++) {
      reader = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (!reader) await page.waitForTimeout(100);
    }
    await reader.waitForFunction(() => window.__PDFJS_READY__ === true);
    const pdfTab = (await page.evaluate(() => window.key.tabs())).activeTabId;
    const before = (await hosted())[0].views;
    assert.equal(before.length, 1);
    await reader.evaluate(() => (window.__keptAlive = "same renderer"));

    // Pop the PDF tab out: a second window hosts the very same view.
    const opened = app.waitForEvent("window", (p) => !p.url().endsWith("/pdf.html"));
    await page.evaluate((tabId) => window.key.tabAction("pop-out", { tabId }), pdfTab);
    const second = await opened;
    second.setDefaultTimeout(20000);
    await second.waitForFunction(() => document.querySelector(".tab-bar"));
    await page.waitForFunction(async () => (await window.key.tabs()).windowCount === 2);
    const views = await hosted();
    assert.equal(views.length, 2);
    const moved = views.find((w) => w.views.includes(before[0]));
    assert(moved && moved.views.length === 1, `the reader view moved intact: ${JSON.stringify(views)}`);
    assert.equal(await reader.evaluate(() => window.__keptAlive), "same renderer", "no reload when moving windows");
    const secondTabs = await second.evaluate(() => window.key.tabs());
    assert.deepEqual(secondTabs.tabs.map((t) => t.id), [pdfTab]);
    assert(!(await page.evaluate(() => window.key.tabs())).tabs.some((t) => t.id === pdfTab));
    await second.waitForTimeout(400);
    await second.screenshot({ path: path.join(temp, "second-window.png") });
    // The moved reader is visible and sized inside its new window.
    const placed = await app.evaluate(({ BrowserWindow }, id) => {
      for (const w of BrowserWindow.getAllWindows())
        for (const v of w.contentView.children)
          if (v.webContents.id === id) return { visible: v.getVisible(), bounds: v.getBounds(), content: w.getContentSize() };
    }, before[0]);
    assert(placed.visible && placed.bounds.width > 400 && placed.bounds.height > 300, JSON.stringify(placed));
    const image = await app.evaluate(async ({ BrowserWindow }, id) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents.id === id));
      const view = w.contentView.children.find((v) => v.webContents.id === id);
      return (await view.webContents.capturePage()).toPNG().toString("base64");
    }, before[0]);
    await writeFile(path.join(temp, "second-window-reader.png"), Buffer.from(image, "base64"));

    // One core: the new window reads the same store, and library events reach it too.
    assert.equal((await second.evaluate((id) => window.key.invoke("store_sources", { limit: 5 }, id), ws.id)).total, 1);
    await second.evaluate(() => {
      window.__heard = 0;
      window.key.on("library-changed", () => (window.__heard += 1));
    });
    // Any import, even an empty one, announces a library change to every window.
    await page.evaluate((id) => window.key.importPaths(id, []), ws.id);
    await second.waitForFunction(() => window.__heard > 0);

    // Move it back: the emptied window closes, the view returns, still the same renderer.
    const firstWindowId = (await page.evaluate(() => window.key.tabs())).windowId;
    // The second window closes while answering, so its side of the call may not return.
    await second
      .evaluate(({ tabId, windowId }) => window.key.tabAction("move-to-window", { tabId, windowId }), { tabId: pdfTab, windowId: firstWindowId })
      .catch(() => {});
    for (let i = 0; i < 50 && (await windowCount()) !== 1; i++) await page.waitForTimeout(100);
    assert.equal(await windowCount(), 1);
    assert((await hosted())[0].views.includes(before[0]));
    assert.equal(await reader.evaluate(() => window.__keptAlive), "same renderer");
    assert.equal((await page.evaluate(() => window.key.tabs())).activeTabId, pdfTab);

    // File › New Window, then close it: the app and the first window carry on.
    const third = app.waitForEvent("window", (p) => !p.url().endsWith("/pdf.html"));
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find((i) => i.label === "File");
      file.submenu.items.find((i) => i.label === "New Window").click();
    });
    const fresh = await third;
    await fresh.getByRole("region", { name: "Home", exact: true }).waitFor();
    assert.equal(await windowCount(), 2);
    await fresh.evaluate(() => window.close()).catch(() => {});
    for (let i = 0; i < 50 && (await windowCount()) !== 1; i++) await page.waitForTimeout(100);
    assert.equal(await windowCount(), 1);
    assert.equal((await page.evaluate(() => window.key.tabs())).windowCount, 1);
    await page.screenshot({ path: path.join(temp, "first-window.png") });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, poppedOut: true, sameView: true, sharedCore: true, movedBack: true, newWindow: true }));
  } catch (e) {
    for (const [i, p] of shellPages().entries()) await p.screenshot({ path: path.join(temp, `failure-${i}.png`) }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
