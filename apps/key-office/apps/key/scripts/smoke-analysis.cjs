// Run serially: native windows and focus are shared with other GUI checks.
// Importing a paper analyses it in the background: layout analysis (with the layout model)
// becomes its searchable text and Markdown, then its references are found and looked up.
// The reader's References panel shows how far that got and can run it again; Settings
// turns the layout model off; "Show in PDF" on a highlight goes there without a search bar.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-analysis-"));
  const fixture = path.join(temp, "Paper.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/PUBMED_16226083.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    const until = async (what, test, seconds = 180) => {
      for (let i = 0; i < seconds * 4; i++) {
        const value = await test();
        if (value) return value;
        await page.waitForTimeout(250);
      }
      throw Error(`Timed out waiting for ${what}`);
    };

    // Layout analysis with the model, Markdown, then references.
    const report = await until("layout analysis", async () => {
      const r = await call("store_analysis", { id: created.id });
      return r.analysis && r.indexStatus === "ready" && r;
    });
    assert.equal(report.analysis.engine, "layout-onnx");
    const markdown = await call("store_markdown", { id: created.id });
    assert.match(markdown, /^#{1,6} /m, "Markdown has headings");
    const word = markdown.split(/\n+/).filter((l) => !l.startsWith("#")).join(" ").match(/\b[a-z]{8,}\b/)[0];
    const search = await call("store_search", { text: word, mode: "keyword", limit: 3 });
    assert.ok(search.hits.length > 0, `layout passages are searchable (${word})`);
    const done = await until("references", async () => {
      const r = await call("store_analysis", { id: created.id });
      return ["done", "none", "failed"].includes(r.analysis?.referencesStatus) && r;
    }, 300);
    console.log("references", done.analysis.referencesStatus, done.analysis.referencesTotal, done.analysis.referencesMatched);
    if (done.analysis.referencesStatus === "done") assert.equal(done.references.length, done.analysis.referencesTotal);

    // The reader's References panel says what happened and can run it again.
    await call("library_save_annotations", {
      hash: created.id,
      annotations: [{ id: "h1", text: "A highlight far down the paper", comment: "", color: "green", range: { start: { page: 3, index: 0 }, end: { page: 3, index: 20 } }, anchor: { version: 1, pages: [{ page: 3, bounds: [{ left: 0.1, top: 0.6, right: 0.5, bottom: 0.62 }] }] } }],
    });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.locator(".kx-row").first().dblclick({ position: { x: 24, y: 20 } });
    let reader;
    await until("reader", async () => (reader = app.windows().find((w) => w.url().endsWith("/pdf.html"))));
    await reader.waitForFunction(() => window.__PDFJS_READY__ === true);
    await reader.getByRole("button", { name: "References" }).click();
    const status = reader.locator(".key-pdf-analysis");
    await status.waitFor();
    assert.match(await status.innerText(), /Layout analysis with the layout model/);
    await shot(reader, "references-panel");
    await status.getByRole("button", { name: "Re-run" }).click();
    await until("re-run to start", async () => !(await call("store_analysis", { id: created.id })).analysis);
    await reader.locator(".key-pdf-analysis[data-working]").waitFor();
    await until("re-run to finish", async () => (await call("store_analysis", { id: created.id })).analysis?.engine === "layout-onnx");

    // "Show in PDF" on a highlight: scrolls there and lights it up, without a search bar.
    await page.locator(".kx-page-highlights li").first().hover();
    await page.locator(".kx-page-highlights li").first().getByRole("button", { name: "Show in PDF" }).click();
    await reader.locator(".pdfjs-highlight.flash").first().waitFor();
    assert.equal(await reader.locator(".key-pdf-result").count(), 0, "no search result bar");
    const onScreen = await reader.locator(".pdfjs-highlight.flash").first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top > 0 && r.bottom < innerHeight;
    });
    assert.ok(onScreen, "the highlight is scrolled into view");
    await shot(reader, "show-in-pdf");

    // Settings: the layout model can be switched off for the running library.
    await page.evaluate(() => window.key.setAppSettings({ layoutModel: false }));
    await until("layout model off", async () => (await call("store_analysis_options", {})).layoutModel === false);
    const options = await call("store_analysis_options", {});
    assert.equal(options.outdated, 1, "the paper read with the model is now outdated");
    await page.evaluate(() => window.key.setAppSettings({ layoutModel: true }));

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, engine: report.analysis.engine, references: done.analysis.referencesStatus, rerun: true, showInPdf: true, setting: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
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
