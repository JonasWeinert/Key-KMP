const { _electron: electron } = require("playwright-core");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-mixed-tabs-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE
      ? []
      : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor({ timeout: 60000 });
    const ws = (await page.evaluate(() => window.key.workspaces()))[0];
    const rendererIds = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .map((w) => w.id)
        .sort(),
    );
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    await page.getByRole("heading", { name: "Sources", exact: true }).waitFor();
    const sourceState = await page.evaluate(() => window.key.tabs());
    const library = sourceState.activeViewId;
    await page
      .getByRole("button", { name: "Create item", exact: true })
      .click();
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .fill("Retained draft");
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .fill("Keep this unsaved text through splits and switches.");
    const note = (await page.evaluate(() => window.key.tabs())).activeViewId;
    await page
      .locator(".key-sidebar > button")
      .filter({ hasText: "Sources" })
      .click();
    assert.equal(
      (await page.evaluate(() => window.key.tabs())).activeViewId,
      library,
    );
    await page.evaluate(
      (id) => window.key.tabAction("split", { viewId: id }),
      note,
    );
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Page content", exact: true })
        .inputValue(),
      "Keep this unsaved text through splits and switches.",
    );
    assert.equal(await page.locator("[data-content-view]:visible").count(), 2);
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .click();
    assert.equal(
      (await page.evaluate(() => window.key.tabs())).activeViewId,
      note,
    );
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+s" : "Control+s",
    );
    await page.getByText("Saved", { exact: true }).waitFor();
    const saved = (
      await page.evaluate(
        (id) =>
          window.key.invoke("workspace_records", { limit: 100, offset: 0 }, id),
        ws.id,
      )
    ).find((r) => r.title === "Retained draft");
    assert(saved);
    const count = (await page.evaluate(() => window.key.tabs())).tabs.length;
    assert.deepEqual(
      await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .map((w) => w.id)
          .sort(),
      ),
      rendererIds,
      "Library and notes share one renderer",
    );
    await page
      .locator(".key-sidebar")
      .getByRole("button", { name: "Retained draft", exact: false })
      .click();
    assert.equal(
      (await page.evaluate(() => window.key.tabs())).tabs.length,
      count,
      "saved draft has a single owner",
    );
    await page
      .getByRole("button", { name: "Separate panes", exact: true })
      .click();
    const pdf = path.resolve(
      __dirname,
      "../../../../../tests/fixtures/interaction.pdf",
    );
    await page.evaluate(
      async ({ pdf, id }) => {
        const s = await window.key.invoke(
          "library_import_file",
          { path: pdf },
          id,
        );
        await window.key.openSource({
          ...s,
          documentHash: s.hash,
          workspaceId: id,
        });
      },
      { pdf, id: ws.id },
    );
    let reader;
    for (let i = 0; i < 100; i++) {
      reader = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (reader) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(reader);
    await reader.waitForFunction(() => window.__PDFJS_READY__ === true);
    await page.evaluate(
      (id) => window.key.tabAction("split", { viewId: id }),
      note,
    );
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .waitFor();
    const getGeometry = async () => ({
      dom: await page.locator(`[data-content-view="${note}"]`).boundingBox(),
      native: await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((v) => v.getVisible?.())
          .map((v) => v.getBounds()),
      ),
    });
    let geometry = await getGeometry();
    assert(geometry.native.length >= 1, JSON.stringify(geometry));
    assert(geometry.dom.width > 300);
    assert.equal(Math.round(geometry.dom.y), 40);
    await page.getByRole("button", { name: "Swap panes", exact: true }).click();
    await page.evaluate(() =>
      window.key.tabAction("resize-split", { ratio: 0.4 }),
    );
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".key-sidebar-slot").getBoundingClientRect()
          .width === 0,
    );
    geometry = await getGeometry();
    assert.equal(Math.round(geometry.dom.x), 0);
    const pdfBounds = geometry.native.find((b) => b.x > 0);
    assert(pdfBounds, JSON.stringify(geometry));
    assert(
      Math.abs(pdfBounds.x - (geometry.dom.width + 6)) < 2,
      JSON.stringify(geometry),
    );
    await page.screenshot({ path: path.join(temp, "note-pdf-split.png") });
    await reader.waitForFunction(
      () => document.querySelectorAll("canvas").length > 0,
    );
    await reader.screenshot({ path: path.join(temp, "split-pdf-pane.png") });
    const capture = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      path.join(temp, "window-split.png"),
      Buffer.from(capture, "base64"),
    );
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .fill("Unsaved close guard");
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    const group = (await page.evaluate(() => window.key.tabs())).activeTabId;
    await page.evaluate(
      (tabId) => window.key.tabAction("close", { tabId }),
      group,
    );
    assert(
      (await page.evaluate(() => window.key.tabs())).tabs.some(
        (t) => t.id === group,
      ),
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: "Page content", exact: true })
        .inputValue(),
      "Unsaved close guard",
    );
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await page.evaluate(
      (tabId) => window.key.tabAction("close", { tabId }),
      group,
    );
    assert(
      !(await page.evaluate(() => window.key.tabs())).tabs.some(
        (t) => t.id === group,
      ),
    );
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, geometry }));
  } catch (e) {
    for (const w of app.windows())
      if (w.url().endsWith("index.html"))
        await w
          .screenshot({ path: path.join(temp, "failure.png") })
          .catch(() => {});
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
