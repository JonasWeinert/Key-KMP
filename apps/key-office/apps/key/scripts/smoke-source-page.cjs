// Run serially: native windows and focus are shared with other GUI checks.
// A source opens as one page beside its PDF: properties, the note right under them,
// highlights that quote into the note, live updates from elsewhere, and the reader's
// Notes button to hide and show the page.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-source-page-"));
  const fixture = path.join(temp, "Health versus income.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("store_update", {
      id: created.id,
      patch: { creators: [{ given: "Marco", family: "Palma" }], year: 2022, containerTitle: "PLoS ONE", abstract: "People value health and income." },
    });
    const highlight = (id, text, page) => ({ id, text, comment: "", color: "yellow", range: { start: { page, index: 0 }, end: { page, index: 10 } }, anchor: { pages: [{ page, bounds: [] }] } });
    await call("library_save_annotations", { hash: created.id, annotations: [highlight("h1", "Select this sentence, copy it, and compare exactly.", 0)] });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);

    // Double-click: the reader and the page open side by side in one tab.
    await page.locator(".kx-row").first().dblclick({ position: { x: 24, y: 20 } });
    await page.locator(".kx-source-page-title").waitFor();
    const tabs = await page.evaluate(() => window.key.tabs());
    const tab = tabs.tabs.find((t) => t.id === tabs.activeTabId);
    assert.deepEqual(tab.views.map((v) => v.kind), ["pdf", "page"]);
    assert.equal(await page.locator(".kx-source-page-title").inputValue(), "Health versus income");
    await page.locator(".kx-page-properties .kx-field-row", { hasText: "Published in" }).waitFor();

    // Writing on the page is the source's note.
    await page.locator(".kx-page-note .ProseMirror").click();
    await page.keyboard.type("My take: the trade-off is framed well.");
    const noteBody = async () => (await call("store_notes", { sourceId: created.id }))[0]?.body ?? "";
    for (let i = 0; i < 40 && !(await noteBody()).includes("My take"); i++) await page.waitForTimeout(150);
    assert.match(await noteBody(), /My take: the trade-off is framed well\./);
    assert.equal((await call("store_notes", { sourceId: created.id })).length, 1, "one page note, not one per save");

    // A highlight quotes into the note, with its page.
    const card = page.locator(".kx-page-highlights li").first();
    await card.hover();
    await card.getByRole("button", { name: "Quote in note" }).click();
    for (let i = 0; i < 40 && !(await noteBody()).includes("```quote"); i++) await page.waitForTimeout(150);
    assert.match(await noteBody(), new RegExp(`\`\`\`quote source="${created.id}" page="0"\\nSelect this sentence, copy it, and compare exactly\\.\\n\`\`\``));
    assert.match(await noteBody(), /My take/, "quoting keeps what was written");
    await page.locator(".kx-page-note .ne-quote, .kx-page-note blockquote").first().waitFor();

    // Highlights made elsewhere (the reader) appear without reopening.
    await call("library_save_annotations", {
      hash: created.id,
      annotations: [highlight("h1", "Select this sentence, copy it, and compare exactly.", 0), highlight("h2", "Horizontal scrolling appears after zooming in.", 0)],
    });
    await page.waitForFunction(() => document.querySelectorAll(".kx-page-highlights li").length === 2);
    await page.locator(".kx-source-page").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(300);
    await shot(page, "page-light");
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot(page, "page-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));

    // The reader's Notes button hides the page, and brings it back.
    let reader;
    for (let i = 0; i < 100 && !reader; i++) {
      reader = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (!reader) await page.waitForTimeout(100);
    }
    await reader.waitForFunction(() => window.__PDFJS_READY__ === true);
    await reader.getByRole("button", { name: "Notes" }).click();
    await page.waitForFunction(async () => {
      const t = await window.key.tabs();
      return t.tabs.find((x) => x.id === t.activeTabId).views.length === 1;
    });
    await reader.getByRole("button", { name: "Notes" }).click();
    await page.waitForFunction(async () => {
      const t = await window.key.tabs();
      return t.tabs.find((x) => x.id === t.activeTabId).views.map((v) => v.kind).join() === "pdf,page";
    });

    // Folding the properties leaves a one-line summary.
    await page.getByRole("button", { name: "Hide properties" }).click();
    await page.locator(".kx-page-properties-summary", { hasText: "PLoS ONE · 2022" }).waitFor();
    await page.locator(".kx-page-properties-summary").click();
    await page.locator(".kx-page-properties").waitFor();

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, sideBySide: true, pageNote: true, quote: true, liveHighlights: true, notesToggle: true, properties: true }));
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
