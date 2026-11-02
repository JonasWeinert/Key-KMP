// Run serially: native windows and focus are shared with other GUI checks.
// A canvas: created from the sidebar, a note and a source placed as cards, a card moved,
// the two connected with the connector tool, a delete undone, then the app reloaded: the
// scene comes back, and the note lists the canvas and the source under "Linked from".
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-canvas-"));
  const fixture = path.join(temp, "Interaction study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  const until = async (check, what) => {
    for (let i = 0; i < 60; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error(`Timed out waiting for ${what}`);
  };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const [source] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    const note = await call("store_note_save", { id: null, sourceId: null, title: "Canvas idea", body: "Interaction effects matter." });

    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.locator(".kx-row").first().waitFor();

    // A new canvas from the sidebar's create menu opens in its own tab.
    await page.getByRole("button", { name: "Create item" }).click();
    await page.locator(".key-create-menu button", { hasText: "New canvas" }).click();
    const canvas = page.locator(".kx-canvas");
    await canvas.waitFor();
    await page.getByLabel("Canvas title").fill("Research board");
    const tabs = await page.evaluate(() => window.key.tabs());
    const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
    assert.equal(active.views[0].kind, "canvas");
    const canvasId = active.views[0].content.canvasId;
    await until(async () => (await call("store_canvas", { id: canvasId }))?.title === "Research board", "the title to save");
    await until(async () => (await page.evaluate(() => window.key.tabs())).tabs.some((t) => t.title === "Research board"), "the tab to follow the title");

    // Place the note and the source as cards.
    const add = async (query, title) => {
      await page.getByRole("button", { name: "Add item" }).click();
      await page.getByLabel("Search items").fill(query);
      await page.locator(".kx-canvas-add [role=option]", { hasText: title }).first().click();
    };
    await add("Canvas idea", "Canvas idea");
    await add("Interaction", "Interaction study");
    const cards = page.locator(".kx-canvas-node[data-type=item]");
    await until(async () => (await cards.count()) === 2, "two cards");
    const noteCard = cards.filter({ hasText: "Canvas idea" });
    const sourceCard = cards.filter({ hasText: "Interaction study" });
    await noteCard.locator(".kx-canvas-card-excerpt", { hasText: "Interaction effects matter." }).waitFor();

    // Drag the source card well to the right of the note.
    const from = await sourceCard.boundingBox();
    await page.mouse.move(from.x + 40, from.y + 30);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + 40 + i * 40, from.y + 30 + i * 12);
    await page.mouse.up();
    const moved = await sourceCard.boundingBox();
    assert(moved.x - from.x > 300, `card moved by ${moved.x - from.x}`);

    // Connect source → note with the connector tool.
    await page.getByRole("button", { name: "Connector", exact: true }).click();
    const a = await sourceCard.boundingBox();
    const b = await noteCard.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 8, a.y + a.height / 2 + ((b.y + b.height / 2 - a.y - a.height / 2) * i) / 8);
    await page.mouse.up();
    await page.locator(".kx-canvas-edge").waitFor();

    // The connector is selected: delete it, then undo brings it back.
    await canvas.press("Delete");
    await until(async () => (await page.locator(".kx-canvas-edge").count()) === 0, "the connector to go");
    await canvas.press("Meta+z");
    await page.locator(".kx-canvas-edge").waitFor();
    const saved = await until(async () => {
      const stored = await call("store_canvas", { id: canvasId });
      return stored?.doc?.edges?.length === 1 && stored.doc.nodes.length === 2 ? stored : null;
    }, "the scene to save");
    const edge = saved.doc.edges[0];
    const byId = Object.fromEntries(saved.doc.nodes.map((n) => [n.id, n.ref]));
    assert.deepEqual([byId[edge.from.node], byId[edge.to.node]], [{ kind: "source", id: source.id }, { kind: "note", id: note.id }]);
    await shot(page, "canvas");

    // Reload the app: the canvas comes back as it was.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(({ id, canvasId }) => window.key.tabAction("open-content", { section: "canvas", workspaceId: id, canvasId, title: "Research board" }), { id: ws.id, canvasId });
    await canvas.waitFor();
    await until(async () => (await cards.count()) === 2, "the cards after reload");
    await page.locator(".kx-canvas-edge").waitFor();
    assert.equal(await page.getByLabel("Canvas title").inputValue(), "Research board");

    // Double-click the note card: the note opens, linked from the canvas and from the source on it.
    await noteCard.dblclick();
    const linked = page.locator(".kx-linked-from");
    await linked.waitFor();
    await linked.locator(".kx-linked-from-row", { hasText: "Research board" }).first().waitFor();
    await linked.locator(".kx-linked-from-row", { hasText: "Interaction study" }).filter({ hasText: "on Research board" }).waitFor();
    const links = await call("store_links", { kind: "note", id: note.id });
    assert.equal(links.backlinks.length, 2);

    // Renaming the canvas shows in the backlink at once: titles follow by id.
    await call("store_canvas_save", { id: canvasId, title: "Thesis board" });
    await linked.locator(".kx-linked-from-row", { hasText: "Thesis board" }).first().waitFor();
    await shot(page, "note-backlinks");
    assert.deepEqual(errors, []);
    console.log(`canvas smoke ok (${temp})`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
