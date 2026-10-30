// Run serially: native windows and focus are shared with other GUI checks.
// Details panel: one Details list, drag-resizable and remembered. Notes: a source note
// written with the block editor (slash menu, @-link) saves as Markdown with custom fences,
// opens in its own tab, and standalone notes come from the sidebar.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-notes-"));
  const fixture = path.join(temp, "Interaction study.pdf");
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.emulateMedia({ colorScheme: null });
    // Let start-up open its Home tab first, so it doesn't take focus from Sources later.
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("workspace_save_attribute", { name: "Status", config: { type: "select", options: ["To read", "Read"] } });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.locator(".kx-row").first().click();

    // One Details list: bibliographic fields, then the user's properties.
    const details = page.locator(".kx-details");
    await details.locator(".kx-field-row", { hasText: "Year" }).waitFor();
    await details.locator(".kx-typed-row", { hasText: "Status" }).waitFor();
    assert.equal(await page.locator(".kx-inspector-section h3", { hasText: /^Properties$/ }).count(), 0);

    // Drag the panel edge 160px to the left; the width follows and is remembered.
    const inspector = page.locator(".kx-inspector");
    const before = (await inspector.boundingBox()).width;
    assert(Math.abs(before - 440) < 2, `default width ${before}`);
    const handle = await page.locator(".kx-splitter").boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 300);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(handle.x + 4 - i * 20, handle.y + 300);
    await page.mouse.up();
    const after = (await inspector.boundingBox()).width;
    assert(Math.abs(after - 600) < 3, `resized width ${after}`);
    assert.equal(await page.evaluate(() => localStorage.getItem("key.library.inspectorWidth")), "600");

    // A source note: a callout from the slash menu, then an @-link to the source.
    await page.getByRole("button", { name: "New note", exact: true }).last().click();
    const editor = page.locator(".kx-note-card .ProseMirror").first();
    await editor.click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
    await page.keyboard.type("/callout");
    await page.locator(".ne-menu-item[aria-selected=true]", { hasText: "Callout" }).waitFor();
    await page.keyboard.press("Enter");
    await page.locator(".kx-note-card .ne-callout").waitFor();
    await page.keyboard.type("Compare with ");
    await page.keyboard.type("@Interac");
    await page.locator(".ne-menu-item", { hasText: "Interaction study" }).waitFor();
    await page.keyboard.press("Enter");
    await page.locator(".kx-note-card a[href^='key://source/']").waitFor();
    let body = "";
    for (let i = 0; i < 40 && !body.includes("key://source/"); i++) {
      await page.waitForTimeout(150);
      body = (await call("store_notes", { sourceId: created.id }))[0]?.body ?? "";
    }
    assert.match(body, /^```callout tone="info"\n/m);
    assert.match(body, new RegExp(`\\]\\(key://source/${created.id}\\)`));
    // Keys typed in a note never reach the list: Backspace must not trash, Enter must not open.
    await page.keyboard.press("Enter");
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    assert.equal((await call("store_sources", { limit: 5 })).total, 1);
    assert(!app.windows().some((w) => w.url().endsWith("/pdf.html")), "Typing must not open the reader");
    await shot(page, "1-source-note");

    // Open the note in its own tab and give it a title; the tab follows.
    await page.locator(".kx-note-card").first().hover();
    await page.getByRole("button", { name: "Open note in a tab" }).click();
    const title = page.getByRole("textbox", { name: "Note title" });
    await title.fill("Reading notes");
    await page.waitForFunction(async () => (await window.key.tabs()).tabs.some((t) => t.title.includes("Reading notes")));
    await page.locator(".kx-note-page .ne-callout").waitFor();
    await page.locator(".kx-note-source", { hasText: "Interaction study" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, "2-note-tab");

    // A standalone note from the sidebar, listed there once titled.
    await page.locator(".key-sidebar").getByRole("button", { name: "New note", exact: true }).click();
    // A new, empty note focuses its title.
    await page.waitForFunction(() => document.activeElement?.classList.contains("kx-note-title") && !document.activeElement.value);
    await page.keyboard.type("Chapter plan");
    await page.locator(".key-sidebar .kx-nav-item", { hasText: "Chapter plan" }).waitFor();
    await page.locator(".kx-note-page .ProseMirror:visible").click();
    await page.waitForFunction(() => document.activeElement?.closest(".kx-note-page"));
    await page.keyboard.type("## Outline");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[ ] Draft the methods");
    for (let i = 0; i < 40 && !(await call("store_notes", {}))[0]?.body.includes("- [ ] Draft the methods"); i++) await page.waitForTimeout(150);
    const standalone = await call("store_notes", {});
    assert.equal(standalone.length, 1);
    assert.match(standalone[0].body, /^## Outline$/m);
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot(page, "3-standalone-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, details: true, resized: after, sourceNote: true, noteTab: true, standalone: true }));
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
