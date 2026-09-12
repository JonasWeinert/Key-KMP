const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tabs-"));
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
    // Wait for both readers to finish attaching; their initial focus/layout
    // work must not interrupt the pointer capture being measured below.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        app.windows().filter((p) => p.url().endsWith("/pdf.html")).length === 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const pdf of app
      .windows()
      .filter((p) => p.url().endsWith("/pdf.html")))
      await pdf.waitForFunction(() => window.__PDFJS_READY__ === true);
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
    // Sample from the first animation frame after release; a final snapshot
    // alone misses the old neighbour snap-back followed by a second slide.
    await page.evaluate(() => {
      window.__tabReleaseFrames = new Promise((resolve) => {
        document.addEventListener(
          "pointerup",
          () => {
            const frames = [];
            const sample = () => {
              frames.push(
                Object.fromEntries(
                  [...document.querySelectorAll(".tab-item")].map((n) => [
                    n.dataset.tabId,
                    n.getBoundingClientRect().left,
                  ]),
                ),
              );
              if (frames.length === 30) resolve(frames);
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          },
          { once: true, capture: true },
        );
      });
    });
    await page.mouse.up();
    const releaseFrames = await page.evaluate(() => window.__tabReleaseFrames);
    for (const id of Object.keys(releaseFrames.at(-1))) {
      if (id === group.id) continue;
      const xs = releaseFrames.map((f) => f[id]);
      let direction = 0;
      for (let i = 1; i < xs.length; i++) {
        const delta = xs[i] - xs[i - 1];
        if (Math.abs(delta) <= 2) continue;
        const next = Math.sign(delta);
        assert(
          !direction || direction === next,
          `Neighbour ${id} oscillated after drop: ${xs}`,
        );
        direction = next;
      }
      const settled = xs.slice(2);
      assert(
        Math.max(...settled) - Math.min(...settled) <= 2,
        `Settled neighbour ${id} moved more than 2px after drop: ${xs}`,
      );
    }
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
    async function verifyNativeBounds(label) {
      const expected = await page.evaluate(() => ({
        sidebar: document
          .querySelector(".key-sidebar-slot")
          .getBoundingClientRect().right,
        divider: document
          .querySelector(".key-split-divider")
          .getBoundingClientRect()
          .toJSON(),
        width: innerWidth,
        height: innerHeight,
      }));
      const actual = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((v) =>
            v.webContents?.getURL().endsWith("/pdf.html"),
          )
          .map((v) => v.getBounds())
          .sort((a, b) => a.x - b.x),
      );
      assert.equal(actual.length, 2, `${label}: both PDF views attached`);
      const [left, right] = actual;
      assert(
        Math.abs(left.x - expected.sidebar) <= 1,
        `${label}: PDF overlaps sidebar`,
      );
      assert(
        Math.abs(left.x + left.width - expected.divider.x) <= 1,
        `${label}: left split edge`,
      );
      assert(
        Math.abs(right.x - expected.divider.right) <= 1,
        `${label}: right split edge`,
      );
      assert.equal(
        right.x + right.width,
        expected.width,
        `${label}: right window edge`,
      );
      assert.equal(
        left.y + left.height,
        expected.height,
        `${label}: bottom edge`,
      );
      return { label, expected, actual };
    }
    const nativeBounds = [await verifyNativeBounds("expanded sidebar")];
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".key-sidebar-slot").getBoundingClientRect()
          .width === 64,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    nativeBounds.push(await verifyNativeBounds("collapsed sidebar"));
    const divider = page.getByRole("separator", { name: "Resize split panes" });
    const dividerBox = await divider.boundingBox();
    await page.mouse.move(dividerBox.x + 3, dividerBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(dividerBox.x + 130, dividerBox.y + 100, {
      steps: 12,
    });
    await page.mouse.up();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    nativeBounds.push(await verifyNativeBounds("resized split"));
    await page
      .getByRole("button", { name: "Expand sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".key-sidebar-slot").getBoundingClientRect()
          .width === 240,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    nativeBounds.push(await verifyNativeBounds("restored sidebar"));
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
        releaseFrames,
        nativeBounds,
      }),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
