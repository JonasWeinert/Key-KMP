// Run serially: native windows and focus are shared with other GUI checks.
// Covers the reference library end to end: linked import, inspector edits, collections,
// sidebar collection management (add, nest, rename, reorder, delete), typed properties
// (definition, bulk apply, table column, inspector editor), the database view (grid, list
// and table; column show/hide/reorder/resize/pin; multi-level sort), full-text search into
// the reader preview, trash with undo, and the tag manager.
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
    // Let start-up open its Home tab first, so it doesn't take focus from Sources later.
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
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
    await page.locator(".kx-library-section .kx-section-title").click();
    await page.locator(".kx-row").nth(0).click();
    await page.locator(".kx-row").nth(1).click({ modifiers: ["Shift"] });
    const bulk = page.getByRole("toolbar", { name: "Selected sources" });
    const thesis = (await call("store_collections")).find((c) => c.name === "Thesis");
    await bulk.getByRole("combobox", { name: "Add selection to collection" }).selectOption(thesis.id);
    await page.waitForFunction(
      async ({ ws }) => (await window.key.invoke("store_collections", {}, ws)).find((c) => c.name === "Thesis")?.sourceCount === 2,
      { ws: ws.id },
    );
    // Collection management in the sidebar's Library section: nest, rename, reorder, delete.
    const treeRow = (name) => page.locator(".kx-tree-row", { has: page.locator(".kx-tree-label > span", { hasText: new RegExp(`^${name}$`) }) });
    await treeRow("Thesis").hover();
    await page.getByRole("button", { name: "New collection in Thesis", exact: true }).click();
    await page.getByRole("textbox", { name: "New collection name" }).fill("Chapter 1");
    await page.getByRole("textbox", { name: "New collection name" }).press("Enter");
    await treeRow("Chapter 1").waitFor();
    assert.equal((await call("store_collections")).find((c) => c.name === "Chapter 1").parentId, thesis.id);
    await treeRow("Chapter 1").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Rename Chapter 1" }).fill("Chapter One");
    await page.getByRole("textbox", { name: "Rename Chapter 1" }).press("Enter");
    await treeRow("Chapter One").waitFor();
    await page.getByRole("button", { name: "New collection", exact: true }).click();
    await page.getByRole("textbox", { name: "New collection name" }).fill("Archive");
    await page.getByRole("textbox", { name: "New collection name" }).press("Enter");
    await treeRow("Archive").waitFor();
    // Dropped on Thesis's top edge, Archive moves before it; on its middle, into it.
    const topLevel = async () => (await call("store_collections")).filter((c) => !c.parentId).sort((a, b) => a.position - b.position).map((c) => c.name);
    assert.deepEqual(await topLevel(), ["Thesis", "Archive"]);
    await treeRow("Archive").dragTo(treeRow("Thesis"), { targetPosition: { x: 60, y: 2 } });
    await page.waitForFunction(async (ws) => {
      const list = (await window.key.invoke("store_collections", {}, ws)).filter((c) => !c.parentId).sort((a, b) => a.position - b.position);
      return list[0]?.name === "Archive";
    }, ws.id);
    await treeRow("Archive").dragTo(treeRow("Thesis"), { targetPosition: { x: 60, y: 14 } });
    await page.waitForFunction(
      async ({ ws, parent }) => (await window.key.invoke("store_collections", {}, ws)).find((c) => c.name === "Archive")?.parentId === parent,
      { ws: ws.id, parent: thesis.id },
    );
    // A collection never moves into its own sub-collection.
    await treeRow("Thesis").dragTo(treeRow("Archive"), { targetPosition: { x: 60, y: 14 } });
    await page.waitForTimeout(500);
    assert.equal((await call("store_collections")).find((c) => c.name === "Thesis").parentId, null, JSON.stringify(await call("store_collections")));
    await page.screenshot({ path: path.join(temp, "sidebar-collections.png") });
    page.once("dialog", (dialog) => dialog.accept());
    await treeRow("Archive").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete collection…" }).click();
    await treeRow("Archive").waitFor({ state: "detached" });
    assert.deepEqual((await call("store_collections")).map((c) => c.name).sort(), ["Chapter One", "Thesis"]);
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
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show Status", exact: true }).check();
    await page.keyboard.press("Escape");
    await page.locator(".kx-table-head [role=columnheader]", { hasText: "Status" }).waitFor();
    assert.equal(await page.locator(".kx-table-row .kx-cell-property").first().innerText(), "To read");
    await page.locator(".kx-table-row").first().click();
    await page.locator(".kx-typed-row", { hasText: "Status" }).locator("select").selectOption("Read");
    await page.locator(".kx-table-row .kx-cell-property", { hasText: "Read" }).first().waitFor();
    report.properties = true;

    // Table columns: hide from the column menu and the header menu, reorder by dragging a
    // header, resize by its divider, pin from the header menu.
    const headers = () => page.locator(".kx-table-head [role=columnheader]").allInnerTexts();
    const header = (name) => page.locator(".kx-table-head [role=columnheader]", { hasText: new RegExp(`^${name}`) });
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show Journal / container", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await header("Journal").waitFor({ state: "detached" });
    await header("Added").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide column" }).click();
    await header("Added").waitFor({ state: "detached" });
    const drag = async (from, to, dx = 6) => {
      const a = await header(from).boundingBox();
      const b = await header(to).boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x + dx - a.x - a.width / 2) * i) / 8, a.y + a.height / 2);
      return { b };
    };
    await drag("Year", "Authors");
    assert.equal(await page.locator(".kx-db-head-cell[data-dragging]").count(), 1);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll(".kx-table-head [role=columnheader]")].map((h) => h.textContent);
      return names.findIndex((n) => n.startsWith("Year")) < names.findIndex((n) => n.startsWith("Authors"));
    });
    assert.equal(await page.locator(".kx-db-head-cell[data-dragging]").count(), 0, "the header is released after the drop");
    // A release outside the window never arrives: the next move without a button ends the drag.
    await drag("Status", "Title", 40);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, buttons: 0, bubbles: true })));
    await page.waitForFunction(() => !document.querySelector(".kx-db-head-cell[data-dragging]"));
    await page.mouse.up();
    assert.equal((await headers()).at(-1).trim(), "Status", "a release outside the window moves nothing");
    const before = (await header("Authors").boundingBox()).width;
    const divider = await page.getByRole("separator", { name: "Resize Authors column" }).boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider.x + divider.width / 2 + 60, divider.y + divider.height / 2, { steps: 6 });
    await page.mouse.up();
    const after = (await header("Authors").boundingBox()).width;
    assert(Math.abs(after - before - 60) < 4, `the column follows its divider: ${before} → ${after}`);
    await header("Authors").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin column" }).click();
    await page.locator(".kx-db-head-cell[data-pinned]", { hasText: "Authors" }).waitFor();
    report.columns = await headers();

    // Multi-level sort: Year, then Title, from header clicks (Shift adds a level) and the sort menu.
    for (const c of created) await call("store_update", { id: c.id, patch: { year: 2021 } });
    await page.locator(".kx-library-section .kx-section-title").click();
    const titles = () => page.locator(".kx-table-row .kx-cell-title > span:last-child").allInnerTexts();
    await header("Year").click();
    await header("Title").click({ modifiers: ["Shift"] });
    await page.waitForFunction(() => document.querySelectorAll(".kx-db-sort-mark small").length === 2);
    await page.waitForFunction(() => document.querySelector(".kx-table-row .kx-cell-title > span:last-child")?.textContent?.startsWith("Interaction"));
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    const sortMenu = page.getByRole("dialog", { name: "Sort" });
    assert.equal(await sortMenu.locator(".kx-sort-level").count(), 2);
    assert.equal(await sortMenu.getByRole("combobox", { name: "Sort field 2" }).inputValue(), "title");
    await sortMenu.getByRole("button", { name: /switch direction of Title/ }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".kx-table-row .kx-cell-title > span:last-child")?.textContent?.startsWith("Second"));
    report.sort = await titles();
    await page.screenshot({ path: path.join(temp, "table-view.png") });

    // Layouts: grid cards, then list rows; the choice and columns are remembered for this view.
    await page.getByRole("button", { name: "Grid", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".kx-db-card").length === 2);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(temp, "grid-view.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(temp, "table-view-dark.png") });
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".kx-row").length === 2);
    const saved = await page.evaluate((id) => JSON.parse(localStorage.getItem(`key.view:library:${id}`)), ws.id);
    assert.equal(saved.layout, "list");
    assert.deepEqual(saved.sorts, [{ field: "year", descending: false }, { field: "title", descending: true }]);
    assert.equal(saved.columns.find((c) => c.id === "added").hidden, true);
    report.views = true;

    // Full-text search: wait for keyword indexing, then open a passage beside the results.
    for (let i = 0; i < 120; i++) {
      const status = await call("store_status");
      if (status.counts.ready === 2) break;
      if (i === 119) throw Error(`Indexing did not finish: ${JSON.stringify({ counts: status.counts, busy: status.busy, activity: status.activity })}`);
      await page.waitForTimeout(500);
    }
    const search = page.getByRole("combobox", { name: "Search the library", exact: true });
    await search.fill("Select this sentence");
    await search.press("Enter");
    await page.locator(".kx-passage").first().waitFor();
    assert((await page.locator(".kx-passage mark").count()) > 0, "Matches are highlighted");
    const libraryTab = (await page.evaluate(() => window.key.tabs())).activeTabId;
    await page.locator(".kx-passage").first().click();
    // The result opens in its own tab right after the results, not as a split.
    const opened = await page.evaluate(() => window.key.tabs());
    const resultTab = opened.tabs.find((t) => t.id === opened.activeTabId);
    assert.notEqual(opened.activeTabId, libraryTab);
    assert.equal(resultTab.views.length, 1);
    assert.equal(opened.tabs[opened.tabs.findIndex((t) => t.id === libraryTab) + 1].id, opened.activeTabId);
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
    // The result bar floats inside the reader, with the query and the result count.
    let bar = pdf.getByRole("toolbar", { name: "Search result" });
    await bar.getByText("“Select this sentence”").waitFor();
    const count = await bar.locator(".key-pdf-result-count").innerText();
    if (/\/ [2-9]/.test(count)) {
      await bar.getByRole("button", { name: "Next result" }).click();
      await page.waitForFunction(async () => (await window.key.tabs()).searchPreview?.index === 1);
      // The next result may be in the other PDF: the tab is reused with a new reader.
      for (let i = 0; i < 50; i++) {
        const live = app.windows().filter((w) => w.url().endsWith("/pdf.html") && !w.isClosed());
        if (live.length && !live.includes(pdf)) pdf = live.at(-1);
        if (!pdf.isClosed()) break;
        await page.waitForTimeout(100);
      }
      bar = pdf.getByRole("toolbar", { name: "Search result" });
      await bar.getByRole("button", { name: "Previous result" }).waitFor({ state: "visible" });
      assert(await bar.getByRole("button", { name: "Previous result" }).isEnabled());
    }
    await pdf.waitForFunction(() => window.__PDFJS_FEATURES_READY__);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => window.key.setAppSettings({ theme }), theme);
      await pdf.waitForTimeout(600);
      const image = await app.evaluate(async ({ webContents }, url) => {
        const reader = webContents.getAllWebContents().find((w) => w.getURL() === url && !w.isDestroyed());
        return (await reader.capturePage()).toPNG().toString("base64");
      }, pdf.url());
      await writeFile(path.join(temp, `result-bar-${theme}.png`), Buffer.from(image, "base64"));
    }
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    // Back to search returns to the results as they were; the result tab keeps its bar.
    await bar.getByRole("button", { name: "Back to search" }).click();
    await page.waitForFunction((id) => window.key.tabs().then((t) => t.activeTabId === id), libraryTab);
    await page.locator(".kx-passage").first().waitFor();
    await page.evaluate((id) => window.key.tabAction("activate", { tabId: id }), resultTab.id);
    await bar.waitFor();
    await page.evaluate((id) => window.key.tabAction("close", { tabId: id }), resultTab.id);
    await page.waitForFunction((id) => window.key.tabs().then((t) => t.activeTabId === id), libraryTab);
    // Results follow typing: a partial word finds the title, highlighted, without Enter.
    await search.fill("interac");
    await page.locator(".kx-hit .kx-hit-title mark", { hasText: /^Interaction$/ }).first().waitFor();
    await page.locator(".kx-results-head", { hasText: /in titles and details/ }).waitFor();
    await search.fill("");
    await search.press("Escape");
    // Inside a collection the filter adds bound values next to the query vector.
    await page.locator(".kx-tree-label", { hasText: "Thesis" }).click();
    await search.fill("Select this sentence");
    await page.locator(".kx-passage").first().waitFor();
    assert.equal(await page.locator(".kx-results [role=alert]").count(), 0);
    await search.fill("");
    await search.press("Escape");
    await page.locator(".kx-library-section .kx-section-title").click();
    report.search = true;

    // Suggestions turn into filter tokens: an author, picked with the keyboard, narrows the list;
    // Backspace in the empty field removes it again.
    await call("store_update", { id: created[0].id, patch: { creators: [{ given: "Marco", family: "Palma" }] } });
    await search.click();
    await search.pressSequentially("pal", { delay: 40 });
    await page.locator(".kx-suggest-item", { hasText: "Marco Palma" }).waitFor();
    assert.equal(await page.locator(".kx-suggest-item", { hasText: "Marco Palma" }).locator("mark").innerText(), "Pal", "only the typed part is highlighted");
    await search.press("ArrowDown");
    await search.press("Enter");
    await page.locator(".kx-token", { hasText: "Author" }).filter({ hasText: "Marco Palma" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".kx-row").length === 1);
    await search.press("Backspace");
    assert.equal(await page.locator(".kx-token").count(), 0);
    await page.waitForFunction(() => document.querySelectorAll(".kx-row").length === 2);
    report.tokens = true;

    // Trash with undo.
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
