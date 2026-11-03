// Run serially: native windows and focus are shared with other GUI checks.
// Moving around the workspace: hover previews, item menus, quick look, the inspector,
// Open Quickly's sections, [[ / @ / ![[ in notes (link, cite with a page, live embed),
// following a link in place and going back, Send to…, unfolding a source on a canvas,
// all highlights, and drops on the tab bar, a sidebar canvas and the window (Inbox).
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-ux-"));
  const fixture = path.join(temp, "Interaction study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  const until = async (check, what) => {
    for (let i = 0; i < 80; i++) {
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    // What the Go menu sends (menu accelerators can't be pressed from here).
    const command = (name) => app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows()[0].webContents.send("command", name), name);
    const send = (event, value) => app.evaluate(({ BrowserWindow }, [event, value]) => BrowserWindow.getAllWindows()[0].webContents.send(event, value), [event, value]);
    const tabs = () => page.evaluate(() => window.key.tabs());
    const dropOn = (selector, data, modifiers = {}) =>
      page.evaluate(
        ({ selector, data, modifiers }) => {
          const el = document.querySelector(selector);
          if (!el) throw Error(`No ${selector}`);
          const dataTransfer = new DataTransfer();
          for (const [type, value] of Object.entries(data)) dataTransfer.setData(type, value);
          const rect = el.getBoundingClientRect();
          const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ...modifiers };
          for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, init));
        },
        { selector, data, modifiers },
      );
    const items = (list) => ({ "application/x-key-items": JSON.stringify(list) });

    // A source with a highlight, three notes and a canvas.
    const [source] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("store_update", { id: source.id, patch: { creators: [{ given: "Marco", family: "Palma" }], year: 2022 } });
    await call("library_save_annotations", {
      hash: source.id,
      annotations: [{ id: "h1", text: "Interaction effects are modest.", comment: "", color: "yellow", range: { start: { page: 0, index: 0 }, end: { page: 0, index: 10 } }, anchor: { pages: [{ page: 0, bounds: [] }] } }],
    });
    const alpha = await call("store_note_save", { id: null, sourceId: null, title: "Alpha", body: "First thoughts." });
    const beta = await call("store_note_save", { id: null, sourceId: null, title: "Beta", body: "Zebrafish models predict outcomes." });
    const gamma = await call("store_note_save", { id: null, sourceId: null, title: "Gamma", body: "Third note." });
    const board = await call("store_canvas_save", { id: null, title: "Board", doc: { version: 1, nodes: [], edges: [] } });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("key:notes-changed"));
      window.dispatchEvent(new Event("key:canvases-changed"));
    });
    const sidebar = page.locator(".key-sidebar");
    const row = (title) => sidebar.locator(".kx-nav-item", { hasText: title }).first();
    await row("Gamma").waitFor();
    await row("Board").waitFor();

    // Hovering a sidebar note previews it.
    await row("Beta").hover();
    await page.locator(".kx-hover-card", { hasText: "Zebrafish" }).waitFor();
    await shot(page, "1-hover");

    // Open Beta; right-click Alpha → Open beside: one tab, two panes.
    await row("Beta").click();
    await until(async () => (await tabs()).tabs.some((t) => t.title === "Beta"), "Beta to open");
    await row("Alpha").click({ button: "right" });
    await page.locator(".kx-item-menu").getByRole("menuitem", { name: /Open beside/ }).click();
    await until(async () => {
      const t = await tabs();
      return t.tabs.find((x) => x.id === t.activeTabId)?.views.length === 2;
    }, "Alpha beside Beta");

    // Space on a hovered item: quick look.
    await row("Board").hover();
    await page.waitForTimeout(100);
    await page.keyboard.press("Space");
    await page.locator(".kx-quick-look", { hasText: "Board" }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".kx-quick-look").waitFor({ state: "detached" });

    // The inspector follows the focused pane.
    await send("toggle-inspector");
    await page.locator(".kx-inspector-panel .kx-item-title", { hasText: "Alpha" }).waitFor();

    // Open Quickly: a note found by its text, in the "In the text" section, which collapses.
    await command("quick-open");
    await page.locator(".kx-palette input").fill("Zebrafish");
    const inText = page.locator(".kx-palette .kx-found-group[data-group=text]");
    await inText.locator(".kx-found-row", { hasText: "Beta" }).waitFor();
    await inText.locator(".kx-search-head").click();
    await until(async () => (await inText.locator(".kx-found-row").count()) === 0, "the section to collapse");
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("key.search.collapsed"))), ["text"]);
    await inText.locator(".kx-search-head").click();
    await inText.locator(".kx-found-row").first().waitFor();
    await shot(page, "2-open-quickly");
    await page.keyboard.press("Escape");
    await page.locator(".key-global-drawer-scrim").waitFor({ state: "detached" });

    // In Alpha: [[ links, @ cites a page, ![[ embeds another note live.
    const alphaPage = page.locator(".kx-note-page").filter({ has: page.locator("input[value='Alpha']") });
    const editor = alphaPage.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.type(" See [[Board");
    await page.locator(".ne-menu-item", { hasText: "Board" }).first().waitFor();
    await page.keyboard.press("Enter");
    await editor.locator("a[href^='key://canvas/']").waitFor();
    await page.keyboard.type("and @Interaction p. 3");
    await page.locator(".ne-menu-item", { hasText: "Interaction study" }).first().waitFor();
    await page.keyboard.press("Enter");
    await editor.locator("a[href*='page%3A2']", { hasText: "(Palma, 2022, p. 3)" }).waitFor();
    await page.keyboard.press("Enter");
    await page.keyboard.type("![[Beta");
    await page.locator(".ne-menu-item", { hasText: "Beta" }).first().waitFor();
    await page.keyboard.press("Enter");
    await editor.locator(".ne-item-embed .kx-embed", { hasText: "Zebrafish" }).waitFor();
    const body = await until(async () => {
      const saved = (await call("store_note", { id: alpha.id }))?.body ?? "";
      return saved.includes("```embed") && saved.includes("(Palma, 2022, p. 3)") ? saved : null;
    }, "Alpha's links to save");
    assert.match(body, new RegExp(`\\[Board\\]\\(key://canvas/${board.id}\\)`));
    assert.match(body, new RegExp(`\\]\\(key://source/${source.id}#page%3A2\\)`));
    assert.match(body, new RegExp(`\`\`\`embed href="key://note/${beta.id}"`));
    await shot(page, "3-note-links");

    // Following the Board link replaces the pane; Back returns to Alpha.
    const alphaPane = await until(async () => {
      const t = await tabs();
      return t.tabs.flatMap((x) => x.views).find((v) => v.content?.noteId === alpha.id)?.id;
    }, "Alpha's pane");
    await editor.locator("a[href^='key://canvas/']").click();
    await until(async () => (await tabs()).tabs.flatMap((x) => x.views).find((v) => v.id === alphaPane)?.content?.canvasId === board.id, "the pane to show the canvas");
    const history = page.locator(`[data-content-view="${alphaPane}"] .key-pane-history`);
    await history.locator("li", { hasText: "Alpha" }).waitFor();
    await history.getByRole("button", { name: "Back" }).click();
    await until(async () => (await tabs()).tabs.flatMap((x) => x.views).find((v) => v.id === alphaPane)?.content?.noteId === alpha.id, "Back to Alpha");

    // Send the source from the library to the canvas.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.locator(".kx-row", { hasText: "Interaction study" }).first().click();
    await command("send-to");
    await page.locator(".kx-palette input").fill("Board");
    await page.locator(".kx-palette .kx-found-row", { hasText: "Board" }).first().click();
    await page.locator(".kx-toast", { hasText: "Board" }).waitFor();
    await until(async () => (await call("store_canvas", { id: board.id }))?.doc?.nodes?.some((n) => n.ref?.id === source.id), "the source card to save");

    // On the canvas, U unfolds the source into its highlight, connected to it.
    await row("Board").click();
    const canvas = page.locator(".kx-canvas").first();
    const sourceCard = canvas.locator(".kx-canvas-node[data-type=item]", { hasText: "Interaction study" });
    await sourceCard.click({ position: { x: 30, y: 12 } });
    await canvas.press("u");
    await canvas.locator(".kx-canvas-node[data-type=item]", { hasText: "Interaction effects are modest" }).waitFor();
    await until(async () => (await canvas.locator(".kx-canvas-edge").count()) === 1, "the unfold connector");
    await shot(page, "4-unfold");

    // All highlights.
    await command("highlights");
    await page.locator(".kx-highlights-row", { hasText: "Interaction effects are modest" }).waitFor();

    // Dropping a note on the tab bar opens it.
    await dropOn(".tab-strip", items([{ kind: "note", id: gamma.id, title: "Gamma" }]));
    await until(async () => (await tabs()).tabs.some((t) => t.title === "Gamma"), "Gamma to open from the tab bar");

    // Dropping it on the sidebar canvas adds a card without opening the canvas.
    await dropOn(`.key-sidebar .kx-nav-item[data-item="key://canvas/${board.id}"]`, items([{ kind: "note", id: gamma.id, title: "Gamma" }]));
    await until(async () => (await call("store_canvas", { id: board.id }))?.doc?.nodes?.some((n) => n.ref?.id === gamma.id), "Gamma on the canvas");

    // A web link dropped where nothing takes it lands in the Inbox.
    await dropOn(".key-sidebar-footer", { "text/uri-list": "https://example.org/inbox-paper" });
    const inbox = await until(async () => (await call("store_collections")).find((c) => c.name === "Inbox"), "the Inbox");
    await until(async () => (await call("store_sources", { collectionId: inbox.id, limit: 5 })).total === 1, "the link in the Inbox");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp }));
  } catch (error) {
    console.log("Artifacts", temp);
    throw error;
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
