// Run serially: native windows and focus are shared with other GUI checks.
// Covers the reference library end to end: linked import, inspector edits, collections,
// typed properties (definition, bulk apply, table column, inspector editor), full-text
// search into the reader preview, trash with undo, and the tag manager.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-library-"));
  const fixtures = path.resolve(__dirname, "../../../../../tests/fixtures");
  const bytes = await readFile(path.join(fixtures, "interaction.pdf"));
  const files = [path.join(temp, "Interaction study.pdf"), path.join(temp, "Second study.pdf")];
  await writeFile(files[0], bytes);
  await writeFile(files[1], Buffer.concat([bytes, Buffer.from("\n% second fixture\n")]));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // Import: files are linked in place, except temporary ones (like these fixtures and
    // downloads), which are copied into the workspace so they outlive the temp folder.
    const created = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files });
    assert.equal(created.length, 2);
    const first = await call("store_source", { id: created[0].id });
    assert.match(first.filePath, /\/\.key\/files\/[0-9a-f]{64}\.pdf$/);
    assert.equal(first.title, "Interaction study");
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    await page.locator(".kx-row").nth(1).waitFor();

    // Inspector: edit the title and star the source.
    await page.locator(".kx-row", { hasText: "Interaction study" }).click();
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await title.fill("Interaction effects in shared reading");
    await title.press("Enter");
    await page.locator(".kx-inspector").getByRole("button", { name: "Star", exact: true }).click();
    await page.waitForFunction(
      async ({ id, ws }) => {
        const s = await window.key.invoke("store_source", { id }, ws);
        return s.title === "Interaction effects in shared reading" && s.starred;
      },
      { id: created[0].id, ws: ws.id },
    );
    report.inspector = true;

    // Collections: create from the sidebar, then file both sources with the bulk bar.
    await page.getByRole("button", { name: "New collection", exact: true }).click();
    await page.getByPlaceholder("Collection name").fill("Thesis");
    await page.getByPlaceholder("Collection name").press("Enter");
    await page.locator(".kx-tree-label", { hasText: "Thesis" }).waitFor();
    await page.locator(".kx-tree-label", { hasText: "All sources" }).click();
    await page.locator(".kx-row").nth(0).click();
    await page.locator(".kx-row").nth(1).click({ modifiers: ["Shift"] });
    const bulk = page.getByRole("toolbar", { name: "Selected sources" });
    const thesis = (await call("store_collections")).find((c) => c.name === "Thesis");
    await bulk.getByRole("combobox", { name: "Add selection to collection" }).selectOption(thesis.id);
    await page.waitForFunction(
      async ({ ws }) => (await window.key.invoke("store_collections", {}, ws)).find((c) => c.name === "Thesis")?.sourceCount === 2,
      { ws: ws.id },
    );
    report.collections = true;

    // Typed property: define a select property and apply it to the selection.
    await bulk.getByRole("combobox", { name: "Set a property on the selection" }).selectOption("__new");
    const sheet = page.getByRole("dialog", { name: "New property", exact: true });
    await sheet.getByRole("textbox", { name: "Property name", exact: true }).fill("Status");
    await sheet.locator(".key-property-types button", { hasText: "Select" }).click();
    for (const option of ["To read", "Read"]) {
      await sheet.getByLabel("New option").fill(option);
      await sheet.getByLabel("New option").press("Enter");
    }
    await sheet.getByRole("combobox", { name: "Value", exact: true }).selectOption("To read");
    await sheet.getByRole("button", { name: "Create property", exact: true }).click();
    await page.waitForFunction(
      async ({ ids, ws }) => {
        for (const id of ids) if ((await window.key.invoke("store_source", { id }, ws)).properties.Status !== "To read") return false;
        return true;
      },
      { ids: created.map((c) => c.id), ws: ws.id },
    );
    assert.equal((await call("workspace_attributes"))[0].type, "select");

    // Table view shows the property as a column; the inspector edits it with its options.
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.locator(".kx-controls-end summary", { hasText: "Columns" }).click();
    await page.locator(".kx-columns-popover label", { hasText: "Status" }).locator("input").check();
    await page.keyboard.press("Escape");
    await page.locator(".kx-table-head button", { hasText: "Status" }).waitFor();
    assert.equal(await page.locator(".kx-table-row .kx-cell-property").first().innerText(), "To read");
    await page.locator(".kx-table-row").first().click();
    await page.locator(".kx-typed-row", { hasText: "Status" }).locator("select").selectOption("Read");
    await page.locator(".kx-table-row .kx-cell-property", { hasText: "Read" }).first().waitFor();
    await page.getByRole("button", { name: "List", exact: true }).click();
    report.properties = true;

    // Full-text search: wait for keyword indexing, then open a passage beside the results.
    for (let i = 0; i < 120; i++) {
      const status = await call("store_status");
      if (status.counts.ready === 2) break;
      if (i === 119) throw Error(`Indexing did not finish: ${JSON.stringify(status.counts)}`);
      await page.waitForTimeout(500);
    }
    const search = page.getByRole("textbox", { name: "Search the library", exact: true });
    await search.fill("Select this sentence");
    await search.press("Enter");
    await page.locator(".kx-passage").first().waitFor();
    assert((await page.locator(".kx-passage mark").count()) > 0, "Matches are highlighted");
    await page.locator(".kx-passage").first().click();
    await page.locator(".key-search-session").waitFor();
    await page.waitForFunction(async () => {
      const s = (await window.key.tabs()).searchPreview;
      return !!s?.previewViewId && !s.busy;
    });
    const target = (await page.evaluate(() => window.key.tabs())).searchPreview.hit;
    const passage = await call("resolve_search_target", { id: target.id });
    assert(passage.rects.length > 0, "The passage carries highlight geometry");
    let pdf;
    for (let i = 0; i < 100 && !pdf; i++) {
      pdf = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (!pdf) await new Promise((r) => setTimeout(r, 100));
    }
    assert(pdf, "The reader opened");
    await pdf.waitForFunction(() => window.__PDFJS_FEATURES_READY__);
    await page.evaluate(() => window.key.tabAction("preview-dismiss"));
    // Results follow typing: a partial word finds the title, highlighted, without Enter.
    await search.fill("interac");
    await page.locator(".kx-hit .kx-hit-title mark", { hasText: /^Interaction$/ }).first().waitFor();
    assert.match(await page.locator(".kx-results-head").innerText(), /in titles and details/);
    await search.fill("");
    await search.press("Escape");
    report.search = true;

    // Trash with undo. The reader stays split beside the list, so the inspector overlays
    // most of each row; click its leading edge.
    await page.locator(".kx-row").first().click({ position: { x: 24, y: 20 } });
    await page.locator(".kx-list").press("Backspace");
    await page.locator(".kx-toast", { hasText: "Trash" }).getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(async (ws) => (await window.key.invoke("store_sources", { limit: 10 }, ws)).total === 2, ws.id);
    report.trash = true;

    // Tags: add one in the inspector, then open the tag manager.
    await page.getByLabel("Add tag", { exact: true }).fill("methods");
    await page.getByLabel("Add tag", { exact: true }).press("Enter");
    await page.locator(".kx-tag-picker > summary").click();
    await page.getByRole("button", { name: /Manage, merge and clean up tags/ }).click();
    await page.getByRole("dialog").getByText("methods", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    report.tags = true;

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
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
