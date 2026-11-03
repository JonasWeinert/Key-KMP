// Run serially: native windows and focus are shared with other GUI checks.
// The sidebar: the workspace in the title bar (name goes Home, switching asks where),
// Search, the Library's References (search, cite at the cursor of a note being written,
// add to a canvas, open), and the Workspace section arranged by dragging rows and filing
// them into folders, kept in the store across a reload. Screenshots in light and dark.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-sidebar-"));
  const fixture = path.join(temp, "Interaction study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const until = async (check, what) => {
    for (let i = 0; i < 80; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error(`Timed out waiting for ${what}`);
  };
  const report = {};
  let page;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const tabs = () => page.evaluate(() => window.key.tabs());
    const sidebar = page.locator(".key-sidebar");

    // A library with two sources, two notes and a canvas.
    const [source] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("store_update", { id: source.id, patch: { creators: [{ given: "Ann", family: "Kirkby" }, { given: "Bo", family: "Lee" }, { given: "Cy", family: "Ng" }], year: 2022 } });
    const second = await call("store_create", { source: { kind: "reference", title: "How many jobs can be done at home?", creators: [{ given: "Jon", family: "Dingel" }, { given: "Brent", family: "Neiman" }], year: 2020 } });
    const alpha = await call("store_note_save", { id: null, sourceId: null, title: "Alpha", body: "First thoughts." });
    const beta = await call("store_note_save", { id: null, sourceId: null, title: "Beta", body: "Second thoughts." });
    const board = await call("store_canvas_save", { id: null, title: "Board", doc: { version: 1, nodes: [], edges: [] } });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("key:notes-changed"));
      window.dispatchEvent(new Event("key:canvases-changed"));
      window.dispatchEvent(new Event("key:library-changed"));
    });

    // The workspace's name sits in the title bar and goes Home.
    const titlebar = page.locator(".kx-sidebar-titlebar");
    await titlebar.locator(".key-workspace-home strong", { hasText: ws.name }).waitFor();
    const nameBox = await titlebar.locator(".key-workspace-home").boundingBox();
    assert(nameBox.x >= 60, "the name leaves room for the traffic lights");
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await until(async () => (await tabs()).tabs.some((t) => t.views[0].kind === "library"), "the library");
    await titlebar.locator(".key-workspace-home").click();
    await until(async () => {
      const state = await tabs();
      return state.tabs.find((t) => t.id === state.activeTabId)?.views[0].kind === "home";
    }, "Home");
    report.home = true;

    // Search opens Open Quickly; the Library header opens the library.
    await sidebar.getByRole("button", { name: "Search" }).click();
    await page.locator(".kx-palette input").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".kx-palette").waitFor({ state: "detached" });
    await sidebar.locator(".kx-top-title", { hasText: "Library" }).click();
    await until(async () => {
      const state = await tabs();
      return state.tabs.find((t) => t.id === state.activeTabId)?.views[0].kind === "library";
    }, "the library from the header");
    assert.equal(await sidebar.locator(".kx-nav-item", { hasText: "All items" }).count(), 0, "All items is gone");
    report.search = true;

    // References: rows read title then "Author et al. (Year)"; the search narrows them.
    const refs = sidebar.getByRole("list", { name: "Reference list" });
    const ref = (title) => refs.locator(".kx-ref-row", { hasText: title });
    await ref("Interaction study").locator(".kx-ref-byline", { hasText: "Kirkby et al. (2022)" }).waitFor();
    await ref("How many jobs").locator(".kx-ref-byline", { hasText: "Dingel & Neiman (2020)" }).waitFor();
    await sidebar.locator(".kx-references .kx-section-toggle small", { hasText: "2" }).waitFor();
    await sidebar.getByLabel("Search references").fill("jobs");
    await until(async () => (await refs.locator(".kx-ref-row").count()) === 1, "the search to narrow the list");
    await sidebar.getByLabel("Search references").fill("");
    await until(async () => (await refs.locator(".kx-ref-row").count()) === 2, "both references again");
    // Outside a note or canvas a row's action opens it.
    await ref("How many jobs").hover();
    await ref("How many jobs").locator(".kx-ref-action[data-action='Open']").waitFor();
    report.references = true;

    // In a note being written, Cite puts the in-text citation at the cursor.
    await page.evaluate(({ id, note }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId: note.id, title: "Alpha" }), { id: ws.id, note: alpha });
    const prose = page.locator(".kx-note-page .ProseMirror");
    await prose.waitFor();
    await prose.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" As shown");
    await ref("Interaction study").hover();
    const cite = ref("Interaction study").locator(".kx-ref-action[data-action='Cite']");
    await cite.click();
    await prose.locator(`a[href="key://source/${source.id}"]`, { hasText: "(Kirkby et al., 2022)" }).waitFor();
    await page.keyboard.type("and more.");
    let saved = "";
    await until(async () => /As shown \[\(Kirkby et al\., 2022\)\]\(key:\/\/source\/[^)]+\) and more\./.test((saved = (await call("store_note", { id: alpha.id }))?.body ?? "")), "the citation to save where the cursor was").catch((e) => {
      throw Error(`${e.message}: ${JSON.stringify(saved)}`);
    });
    // The style selector changes what Cite writes.
    const pickOption = async (button, name) => {
      // The group's actions show on hover, in place of its count.
      await sidebar.locator(".kx-references .kx-sidebar-group").hover();
      await sidebar.getByRole("button", { name: button }).click();
      await page.getByRole("menuitemradio", { name }).click();
    };
    await pickOption("Reference options", "Chicago (author-date)");
    await ref("How many jobs").locator(".kx-ref-byline", { hasText: "Dingel and Neiman (2020)" }).waitFor();
    await ref("How many jobs").hover();
    await ref("How many jobs").locator(".kx-ref-action[data-action='Cite']").click();
    await prose.locator(`a[href="key://source/${second.id}"]`, { hasText: "(Dingel and Neiman 2020)" }).waitFor();
    await pickOption("Reference options", "APA 7th Edition");
    report.cite = true;

    // On a canvas, the action adds a card.
    await page.evaluate(({ id, board }) => window.key.tabAction("open-content", { section: "canvas", workspaceId: id, canvasId: board.id, title: "Board" }), { id: ws.id, board });
    await page.locator(".kx-canvas").waitFor();
    await ref("How many jobs").hover();
    await ref("How many jobs").locator(".kx-ref-action[data-action='Add to canvas']").click();
    await until(async () => (await page.locator(".kx-canvas-node[data-type=item]").count()) === 1, "a card on the canvas");
    report.addToCanvas = true;

    // Workspace: the section is headed by the workspace's name, rows drag into a new order.
    const tree = sidebar.getByRole("tree", { name: "Workspace" });
    const row = (title) => tree.locator(".kx-nav-item", { hasText: title }).first();
    const order = () => tree.locator(":scope > [role=treeitem]").evaluateAll((items) => items.map((i) => i.querySelector(".kx-nav-item span, .kx-tree-label span")?.textContent));
    await sidebar.locator(".kx-workspace-heading > span", { hasText: ws.name }).waitFor();
    await row("Board").waitFor();
    const first = await order();
    assert.deepEqual([...first].sort(), ["Alpha", "Beta", "Board"]);
    const target = first[0] === "Board" ? first[1] : first[0];
    await row("Board").dragTo(row(target), { targetPosition: { x: 20, y: 3 } });
    const moved = ["Board", ...first.filter((t) => t !== "Board")];
    await until(async () => JSON.stringify(await order()) === JSON.stringify(moved), "Board to move to the top");
    // A new folder, renamed, then a note dragged into it.
    await sidebar.getByRole("button", { name: "New folder" }).click();
    await sidebar.getByLabel("Folder name").fill("Drafts");
    await sidebar.getByLabel("Folder name").press("Enter");
    const folder = tree.locator(".kx-folder-row", { hasText: "Drafts" });
    await folder.waitFor();
    await row("Beta").dragTo(folder, { targetPosition: { x: 40, y: 14 } });
    await tree.locator("[role=treeitem][aria-expanded=true] [role=group] .kx-nav-item", { hasText: "Beta" }).waitFor();
    assert.deepEqual(await order(), ["Drafts", "Board", "Alpha"]);
    const stored = await call("store_ui_get", { key: "sidebar.workspace" });
    const folderKey = Object.keys(stored.folders)[0];
    assert.equal(stored.folders[folderKey].name, "Drafts");
    assert.deepEqual(stored.children[folderKey], [`note:${beta.id}`]);
    // Sorting by name shows folders first and names in order, without changing the stored order.
    const pickView = async (name) => {
      await sidebar.getByRole("button", { name: "Show and sort" }).click({ force: true });
      await page.getByRole("menuitemradio", { name, exact: true }).click();
    };
    await pickView("Name");
    assert.deepEqual(await order(), ["Drafts", "Alpha", "Board"]);
    await pickView("Canvases");
    assert.deepEqual(await order(), ["Board"]);
    await pickView("All items");
    await pickView("Manual order");
    // The arrangement is the workspace's: it comes back after a reload.
    await page.reload();
    await page.locator(".kx-workspace-tree .kx-nav-item", { hasText: "Alpha" }).waitFor();
    await until(async () => JSON.stringify(await order()) === JSON.stringify(["Drafts", "Board", "Alpha"]), "the stored order after a reload");
    report.reorder = true;

    // Screenshots, light then dark.
    await page.evaluate(() => window.key.tabAction("open-home"));
    await page.mouse.move(700, 500);
    await page.screenshot({ path: path.join(temp, "sidebar-light.png") });
    // The real switch, so the window's vibrancy follows too.
    await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = "dark"));
    await page.emulateMedia({ colorScheme: "dark" });
    await until(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "the dark theme");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "sidebar-dark.png") });
    await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = "light"));
    await page.emulateMedia({ colorScheme: "light" });

    // Picking another workspace asks whether to replace this window's or open a new window.
    const other = path.join(temp, "Fieldwork");
    await mkdir(other);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, other);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add workspace…", exact: true }).click();
    const choice = page.getByRole("menu", { name: "Open Fieldwork" });
    await choice.waitFor();
    await page.screenshot({ path: path.join(temp, "switch-choice.png") });
    assert.equal((await tabs()).workspaceId, ws.id, "nothing switches before the choice");
    await choice.getByRole("menuitem", { name: /Replace/ }).click();
    await until(async () => (await tabs()).workspaceId !== ws.id, "the window to switch");
    await titlebar.locator(".key-workspace-home strong", { hasText: "Fieldwork" }).waitFor();
    report.switchChoice = true;

    // Collections and References take at most half the sidebar; the rest waits behind Show more.
    // (In the workspace this window now shows.)
    const shownId = (await page.evaluate(() => window.key.workspaces())).find((w) => w.name === "Fieldwork").id;
    const callShown = (command, args) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: shownId });
    for (let i = 0; i < 40; i++) await callShown("store_create", { source: { kind: "reference", itemType: "article", title: `Budget study ${String(i).padStart(2, "0")}` } });
    for (let i = 0; i < 14; i++) await callShown("store_collection_create", { name: `Budget collection ${i}`, parentId: null });
    await page.reload();
    const more = page.locator(".kx-library-groups .kx-sidebar-more");
    await more.first().waitFor();
    const heights = async () =>
      page.evaluate(() => ({
        library: document.querySelector(".kx-library-groups").getBoundingClientRect().height,
        sidebar: document.querySelector(".kx-sidebar-scroll").getBoundingClientRect().height,
      }));
    const folded = await heights();
    assert.ok(folded.library <= folded.sidebar / 2 + 40, `the library lists keep to half the sidebar (${folded.library} of ${folded.sidebar})`);
    await more.last().click();
    await page.locator(".kx-library-groups .kx-sidebar-more", { hasText: "Show fewer" }).waitFor();
    assert.ok((await heights()).library > folded.library, "Show more shows the rest");
    await page.locator(".kx-library-groups .kx-sidebar-more", { hasText: "Show fewer" }).click();

    // Sidebar menus open over the content, whole, not clipped at the sidebar's edge.
    const sidebarRight = await page.locator(".key-sidebar").evaluate((el) => el.getBoundingClientRect().right);
    await page.locator(".kx-workspace-section").hover();
    await page.locator('button[aria-label="Show and sort"]').click();
    const menu = page.getByRole("menu").last();
    await menu.waitFor();
    const box = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.right - 6, r.top + r.height / 2);
      return { right: r.right, parent: el.parentElement === document.body, onTop: !!hit && el.contains(hit) };
    });
    assert.ok(box.parent && box.onTop, "the Show and sort menu is drawn above everything");
    assert.ok(box.right > sidebarRight, "and reaches past the sidebar without being cut off");
    await page.keyboard.press("Escape");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error(JSON.stringify({ ok: false, temp, report, error: String(error?.stack || error) }));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
