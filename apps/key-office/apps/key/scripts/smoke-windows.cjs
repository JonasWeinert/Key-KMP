// Run serially: native windows and focus are shared with other GUI checks.
// Several windows share one core: a tab pops out with its live view (no reload), library
// events reach every window, a tab moves back and the emptied window closes, and
// File › New Window opens a window that can close without quitting the app.
// Each window shows one workspace: switching replaces it in place and brings its
// arrangement (nested splits and ratios) back on return; Cmd-click opens another
// workspace in a window of its own; a window already showing a workspace comes forward
// instead of opening it twice; a tab dragged out of the window tears off; and after a
// relaunch every window returns on its workspace, frame and layout.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-windows-"));
  const fixture = path.join(temp, "Window study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const launch = () =>
    electron.launch({
      executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
      args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
      env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
    });
  let app = await launch();
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

    // The window is bound to its workspace and named after it.
    const tabs = () => page.evaluate(() => window.key.tabs());
    // Polls in Node: waitForFunction does not await an async predicate.
    const until = async (check, label) => {
      for (let i = 0; i < 200; i++) {
        if (await check().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(`Timed out: ${label}`);
    };
    const titles = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort());
    assert.equal((await tabs()).workspaceId, ws.id);
    assert.deepEqual(await titles(), [ws.name]);

    // Arrange: PDF | (Sources over Home), with ratios that must survive.
    let state = await tabs();
    const sourcesView = state.tabs.flatMap((t) => t.views).find((v) => v.kind === "library");
    assert(sourcesView, JSON.stringify(state.tabs));
    await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), pdfTab);
    await page.evaluate((viewId) => window.key.tabAction("split", { viewId }), sourcesView.id);
    await page.evaluate((viewId) => window.key.tabAction("focus", { viewId }), sourcesView.id);
    await page.evaluate(() => window.key.tabAction("split-pane", { edge: "bottom" }));
    await page.evaluate(() => window.key.tabAction("resize-split", { ratio: 0.35 }));
    await page.evaluate(() => window.key.tabAction("resize-split", { ratio: 0.6, path: "b" }));
    state = await tabs();
    const arranged = state.tabs.find((t) => t.id === state.activeTabId);
    const shape = (layout, kinds) =>
      "view" in layout ? kinds[layout.view] : { split: layout.split, ratio: layout.ratio, a: shape(layout.a, kinds), b: shape(layout.b, kinds) };
    const kindsOf = (s) => Object.fromEntries(s.tabs.flatMap((t) => t.views).map((v) => [v.id, v.kind]));
    const arrangement = shape(arranged.layout, kindsOf(state));
    assert.deepEqual(arrangement, {
      split: "row",
      ratio: 0.35,
      a: "pdf",
      b: { split: "column", ratio: 0.6, a: "library", b: "home" },
    });
    await page.locator(".key-split-divider-column").waitFor();
    await page.screenshot({ path: path.join(temp, "arranged.png") });

    // Add a workspace from the switcher: this window switches to it in place.
    const fieldwork = path.join(temp, "Fieldwork");
    await mkdir(fieldwork);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, fieldwork);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add workspace…", exact: true }).click();
    // Picking a workspace asks whether it replaces this window's.
    await page.getByRole("menu", { name: "Open Fieldwork" }).getByRole("menuitem", { name: /^Replace/ }).click();
    await until(async () => (await tabs()).workspaceId !== ws.id, "switched to the added workspace");
    state = await tabs();
    const added = (await page.evaluate(() => window.key.workspaces())).find((w) => w.id === state.workspaceId);
    assert.equal(added.name, "Fieldwork");
    assert.deepEqual(await titles(), ["Fieldwork"]);
    assert.deepEqual(state.tabs.map((t) => t.views.map((v) => v.kind)), [["library"]], "a new workspace opens on its library");
    assert.equal(await windowCount(), 1);
    // The first workspace's reader closed with it.
    for (let i = 0; i < 50 && app.windows().some((p) => p.url().endsWith("/pdf.html")); i++) await page.waitForTimeout(100);
    assert(!app.windows().some((p) => p.url().endsWith("/pdf.html")));
    await page.locator(".key-workspace-home strong").filter({ hasText: "Fieldwork" }).waitFor();

    // Back again: the arrangement returns, ratios included, reader and all.
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    await page.getByRole("menuitem", { name: /^Replace/ }).click();
    await until(async () => (await tabs()).workspaceId === ws.id && (await tabs()).tabs.length > 1, "switched back");
    state = await tabs();
    const back = state.tabs.find((t) => t.id === state.activeTabId);
    assert.deepEqual(shape(back.layout, kindsOf(state)), arrangement);
    assert.deepEqual(state.tabs.map((t) => t.views.length).sort(), [1, 3]);
    for (let i = 0; i < 100 && !app.windows().some((p) => p.url().endsWith("/pdf.html")); i++) await page.waitForTimeout(100);
    assert(app.windows().some((p) => p.url().endsWith("/pdf.html")), "the reader reopens");

    // Cmd-click opens the other workspace beside this one.
    const besideOpened = app.waitForEvent("window", (p) => !p.url().endsWith("/pdf.html"));
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${added.id}"]`).click({ modifiers: ["Meta"] });
    const beside = await besideOpened;
    beside.setDefaultTimeout(20000);
    await until(async () => (await beside.evaluate(() => window.key.tabs())).workspaceId === added.id, "opened beside");
    assert.equal(await windowCount(), 2);
    assert.deepEqual(await titles(), ["Fieldwork", ws.name].sort());
    assert.equal((await tabs()).workspaceId, ws.id, "the first window keeps its workspace");
    // Choosing it again from the first window brings that window forward rather than opening it twice.
    await page.bringToFront();
    await page.evaluate((id) => window.key.tabAction("switch-workspace", { workspaceId: id }), added.id);
    assert.equal(await windowCount(), 2);
    assert.equal((await tabs()).workspaceId, ws.id);
    const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle());
    assert.equal(focused, "Fieldwork");
    // The switcher marks a workspace another window shows.
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${added.id}"] .key-workspace-open-dot`).waitFor();
    await page.keyboard.press("Escape");

    // Tear-off: a tab dragged out of the window opens in a window of its own.
    await page.bringToFront();
    state = await tabs();
    const loose = state.tabs.find((t) => t.views.length === 1 && t.id !== state.activeTabId) ?? state.tabs.find((t) => t.views.length === 1);
    const looseBox = await page.locator(`[data-tab-id="${loose.id}"]`).boundingBox();
    const tornOpened = app.waitForEvent("window", (p) => !p.url().endsWith("/pdf.html"));
    await page.mouse.move(looseBox.x + looseBox.width / 2, looseBox.y + looseBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(looseBox.x + 40, looseBox.y + 120, { steps: 6 });
    await page.mouse.move(-60, 300, { steps: 10 });
    await page.getByRole("status").filter({ hasText: "Release to open in a new window" }).waitFor();
    await page.mouse.up();
    const torn = await tornOpened;
    await until(async () => (await torn.evaluate(() => window.key.tabs())).tabs.some((tab) => tab.id === loose.id), "torn-off tab arrives");
    assert.equal((await torn.evaluate(() => window.key.tabs())).workspaceId, ws.id, "a torn-off tab keeps its workspace");
    assert(!(await tabs()).tabs.some((t) => t.id === loose.id));
    assert.equal(await windowCount(), 3);
    await torn.evaluate(() => window.close()).catch(() => {});
    for (let i = 0; i < 50 && (await windowCount()) !== 2; i++) await page.waitForTimeout(100);
    assert.equal(await windowCount(), 2);

    // Relaunch: both windows return on their workspaces, the first at its frame with its arrangement.
    const frame = { x: 90, y: 70, width: 1180, height: 820 };
    await app.evaluate(({ BrowserWindow }, { frame, title }) => {
      BrowserWindow.getAllWindows().find((w) => w.getTitle() === title).setBounds(frame);
    }, { frame, title: ws.name });
    assert.deepEqual(errors, []);
    const closed = app.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit());
    await closed;
    app = await launch();
    const relaunched = await app.firstWindow();
    relaunched.setDefaultTimeout(20000);
    for (let i = 0; i < 100 && (await windowCount()) !== 2; i++) await relaunched.waitForTimeout(100);
    assert.equal(await windowCount(), 2);
    assert.deepEqual(await titles(), ["Fieldwork", ws.name].sort());
    const shellsNow = () => app.windows().filter((p) => !p.url().endsWith("/pdf.html"));
    let restoredPage;
    for (let i = 0; i < 100 && !restoredPage; i++) {
      for (const p of shellsNow()) {
        const t = await p.evaluate(() => window.key && window.key.tabs()).catch(() => null);
        if (t?.workspaceId === ws.id) restoredPage = p;
      }
      if (!restoredPage) await relaunched.waitForTimeout(100);
    }
    assert(restoredPage, "the first workspace's window returns");
    const restored = await restoredPage.evaluate(() => window.key.tabs());
    const again = restored.tabs.find((t) => t.views.length === 3);
    assert(again, JSON.stringify(restored.tabs));
    assert.deepEqual(shape(again.layout, kindsOf(restored)), arrangement);
    assert.equal(restored.activeTabId, again.id, "the active tab is restored");
    const restoredFrame = await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title).getBounds(), ws.name);
    assert.deepEqual(restoredFrame, frame);
    // Its native reader is placed by the restored layout.
    await restoredPage.locator(".key-split-divider-column").waitFor();
    for (let i = 0; i < 100 && !app.windows().some((p) => p.url().endsWith("/pdf.html")); i++) await relaunched.waitForTimeout(100);
    const readerBounds = await app.evaluate(({ BrowserWindow }, title) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.getTitle() === title);
      return w.contentView.children.filter((v) => v.webContents?.getURL().endsWith("/pdf.html")).map((v) => v.getBounds());
    }, ws.name);
    const divider = await restoredPage.locator('.key-split-divider[data-split-path=""]').boundingBox();
    assert.equal(readerBounds.length, 1);
    assert(Math.abs(readerBounds[0].x + readerBounds[0].width - divider.x) <= 1, JSON.stringify({ readerBounds, divider }));
    await restoredPage.screenshot({ path: path.join(temp, "restored.png") });

    console.log(JSON.stringify({ ok: true, temp, poppedOut: true, sameView: true, sharedCore: true, movedBack: true, newWindow: true, boundWorkspace: true, switchedAndRestored: true, openedBeside: true, focusedExisting: true, toreOff: true, relaunchRestored: true }));
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
