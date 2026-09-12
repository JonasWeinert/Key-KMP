const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tabs-"));
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.key);
    await page.evaluate(async () => {
      await window.key.tabAction("new");
      await window.key.tabAction("new");
    });
    const files = ["interaction.pdf", "scientific-unlinked.pdf"].map((f) =>
      path.resolve(__dirname, "../../../../../tests/fixtures", f),
    );
    await page.evaluate(async (files) => {
      const [w] = await window.key.workspaces();
      for (const path of files) {
        const source = await window.key.invoke(
          "library_import_file",
          { path },
          w.id,
        );
        await window.key.openSource({
          ...source,
          documentHash: source.hash,
          workspaceId: w.id,
        });
      }
      const t = await window.key.tabs();
      await window.key.tabAction("split", { viewId: t.activeViewId });
    }, files);
    const before = await page.evaluate(() => window.key.tabs());
    const group = before.tabs.find((t) => t.views.length === 2);
    assert(group);
    const ids = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .map((w) => w.id)
        .sort(),
    );
    const source = page.locator(`[data-tab-id="${group.id}"]`);
    await source.waitFor();
    const box = await source.boundingBox();
    const first = await page.locator(".tab-item").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(first.x + 15, box.y + 12, { steps: 18 });
    assert.equal(await page.locator(".drag-source").count(), 1);
    assert(
      await page
        .locator(".tab-item:not(.drag-source)")
        .evaluateAll((nodes) =>
          nodes.some((n) => n.style.transform.includes("translateX")),
        ),
    );
    await page.screenshot({
      path: path.join(temp, "drag.png"),
      clip: { x: 0, y: 0, width: 1440, height: 96 },
    });
    await page.mouse.up();
    await page.waitForFunction(
      (id) =>
        document.querySelector(".tab-item")?.getAttribute("data-tab-id") === id,
      group.id,
    );
    const after = await page.evaluate(() => window.key.tabs());
    assert.equal(after.tabs[0].id, group.id);
    assert.deepEqual(after.tabs[0].views, group.views);
    assert.equal(after.activeTabId, group.id);
    assert.deepEqual(
      await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .map((w) => w.id)
          .sort(),
      ),
      ids,
    );
    assert.equal(await page.locator(".tab-split-pane").count(), 2);
    await page.screenshot({
      path: path.join(temp, "settled.png"),
      clip: { x: 0, y: 0, width: 1440, height: 96 },
    });
    await page.locator(`[data-tab-id="${group.id}"]`).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await page.waitForFunction(
      (id) =>
        document
          .querySelectorAll(".tab-item")[1]
          ?.getAttribute("data-tab-id") === id,
      group.id,
    );
    console.log(
      JSON.stringify({
        ok: true,
        temp,
        group: group.id,
        viewsPreserved: group.views.length,
      }),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
