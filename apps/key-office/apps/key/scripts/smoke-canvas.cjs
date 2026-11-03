// Run serially: native windows and focus are shared with other GUI checks.
// A canvas: created from the sidebar, a note and a source placed as cards, a card moved,
// the two connected with the connector tool, a delete undone, then the app reloaded: the
// scene comes back, and the note lists the canvas and the source under "Linked from".
// Then drag and drop: the canvas from the sidebar into the note becomes a link, a note
// from the sidebar onto the canvas becomes a card, and a web link dropped on it a source.
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
    const note = await call("store_note_save", { id: null, sourceId: null, title: "Canvas idea", body: "Interaction effects matter.\n\n## Why\n\n- **Moderators** change the slope\n- Plots help" });

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
      await page.locator(".kx-palette input").fill(query);
      await page.locator(".kx-palette .kx-found-row", { hasText: title }).first().click();
      await page.locator(".key-global-drawer-scrim").waitFor({ state: "detached" });
    };
    await add("Canvas idea", "Canvas idea");
    await add("Interaction", "Interaction study");
    const cards = page.locator(".kx-canvas-node[data-type=item]");
    await until(async () => (await cards.count()) === 2, "two cards");
    const noteCard = cards.filter({ hasText: "Canvas idea" });
    const sourceCard = cards.filter({ hasText: "Interaction study" });
    // The note card shows the note rendered: its heading, list and bold text.
    const prose = noteCard.locator(".kx-canvas-card-body .ne-prose");
    await prose.locator("p", { hasText: "Interaction effects matter." }).waitFor();
    await prose.locator("h2", { hasText: "Why" }).waitFor();
    assert.equal(await prose.locator("li").count(), 2);
    await prose.locator("strong", { hasText: "Moderators" }).waitFor();
    assert.equal(await prose.getAttribute("contenteditable"), "false");

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
    // New cards take their content's height: the short note shrinks from the default 300.
    const noteNode = saved.doc.nodes.find((n) => n.ref.kind === "note");
    assert(noteNode.h < 300, `note card fitted to ${noteNode.h}`);
    await shot(page, "canvas");

    // Reload the app: the canvas comes back as it was.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(({ id, canvasId }) => window.key.tabAction("open-content", { section: "canvas", workspaceId: id, canvasId, title: "Research board" }), { id: ws.id, canvasId });
    await canvas.waitFor();
    await until(async () => (await cards.count()) === 2, "the cards after reload");
    await page.locator(".kx-canvas-edge").waitFor();
    assert.equal(await page.getByLabel("Canvas title").inputValue(), "Research board");

    // Double-click writes in the note card itself; what is typed saves to the note.
    await noteCard.dblclick();
    await noteCard.locator(".ne-prose[contenteditable=true]").waitFor();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.type(" Written on the canvas.");
    await until(async () => (await call("store_note", { id: note.id }))?.body.includes("Written on the canvas."), "the card edit to save");
    await page.keyboard.press("Escape");
    await noteCard.locator(".ne-prose[contenteditable=false]").waitFor();

    // ⌘-double-click opens the note, linked from the canvas and from the source on it.
    await noteCard.dblclick({ modifiers: ["Meta"] });
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

    // Drag the canvas from the sidebar into the note: a link to it lands in the text.
    const sidebarItem = (title) => page.locator(".kx-sidebar-scroll .kx-nav-item", { hasText: title }).first();
    await page.evaluate(() => window.dispatchEvent(new Event("key:canvases-changed")));
    const editor = page.locator(".kx-note-page .ProseMirror");
    const paragraph = editor.locator("p").first();
    await sidebarItem("Thesis board").dragTo(paragraph, { targetPosition: { x: 4, y: 4 } });
    await editor.locator(`a[href="key://canvas/${canvasId}"]`).waitFor();
    await until(async () => (await call("store_note", { id: note.id }))?.body.includes(`key://canvas/${canvasId}`), "the note to save the link");
    // Dropped inside a word, the link goes after it rather than splitting it.
    assert((await paragraph.textContent()).includes("Interaction"), await paragraph.textContent());

    // Drag a note from the sidebar onto the canvas: it becomes a card where it was dropped.
    const dragged = await call("store_note_save", { id: null, sourceId: null, title: "Dragged note", body: "Dropped *here*." });
    await page.evaluate(() => window.dispatchEvent(new Event("key:notes-changed")));
    await page.evaluate(({ id, canvasId }) => window.key.tabAction("open-content", { section: "canvas", workspaceId: id, canvasId, title: "Thesis board" }), { id: ws.id, canvasId });
    await until(async () => (await cards.count()) === 2, "the canvas again");
    const box = await canvas.boundingBox();
    await sidebarItem("Dragged note").dragTo(canvas, { targetPosition: { x: box.width - 260, y: box.height - 200 } });
    const droppedCard = cards.filter({ hasText: "Dragged note" });
    await droppedCard.locator(".ne-prose em", { hasText: "here" }).waitFor();
    const placed = await droppedCard.boundingBox();
    assert(placed.x > box.x + box.width / 2, "the card lands where it was dropped");

    // A web link dropped from outside joins the library as a web source, and lands as a card.
    await canvas.evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/uri-list", "https://example.org/moderation-study");
      const at = { clientX: el.getBoundingClientRect().left + 200, clientY: el.getBoundingClientRect().top + 200, bubbles: true, cancelable: true, dataTransfer: data };
      el.dispatchEvent(new DragEvent("dragover", at));
      el.dispatchEvent(new DragEvent("drop", at));
    });
    await until(async () => (await cards.count()) === 4, "the web source card");
    const web = await call("store_sources", { text: null, limit: 10, offset: 0, sort: "added", descending: true });
    assert(web.items.some((s) => s.kind === "web" && s.url === "https://example.org/moderation-study"), "the web link is a source");
    const stored = await until(async () => {
      const doc = (await call("store_canvas", { id: canvasId }))?.doc;
      return doc?.nodes.length === 4 ? doc : null;
    }, "the dropped cards to save");
    assert(stored.nodes.some((n) => n.ref?.kind === "note" && n.ref.id === dragged.id));
    await shot(page, "canvas-drops");
    assert.deepEqual(errors, []);
    console.log(`canvas smoke ok (${temp})`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
