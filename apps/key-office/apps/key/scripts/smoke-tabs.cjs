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
      KEY_SKIP_ONBOARDING: "1",
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
      await window.key.tabAction("split", {
        viewId: t.tabs
          .flatMap((t) => t.views)
          .find((v) => v.kind === "pdf" && v.id !== t.activeViewId).id,
      });
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
    const box = await source.locator(".tab-split-badge").boundingBox();
    const first = await page.locator(".tab-item").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(first.x - 8, box.y + 12, { steps: 18 });
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
    // Expanded: the toggle sits in the sidebar's titlebar, right of the traffic lights.
    const toggleBox = await page
      .locator(".key-sidebar .key-sidebar-toggle")
      .boundingBox();
    assert(
      toggleBox.x >= 78 && toggleBox.x + toggleBox.width <= 240 && toggleBox.y < 10,
      "Sidebar toggle belongs in the sidebar titlebar",
    );
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".key-sidebar-slot").getBoundingClientRect()
          .width === 0,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    nativeBounds.push(await verifyNativeBounds("collapsed sidebar"));
    // Collapsed: the toggle moves into the tab bar, beside the traffic lights.
    const collapsedToggle = await page
      .locator(".tab-bar .key-sidebar-toggle")
      .boundingBox();
    assert(
      collapsedToggle.x >= 78 && collapsedToggle.x < 120 && collapsedToggle.y < 10,
      "Collapsed sidebar toggle belongs beside traffic lights",
    );
    assert.equal(await page.locator(".key-sidebar-rail").count(), 0);
    await page.screenshot({ path: path.join(temp, "collapsed-sidebar.png") });
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
    // Nested panes. View › Split Down puts a Home pane below the focused (right) reader:
    // reader | (reader over Home). Native views, DOM panes and both dividers stay flush.
    const menuItem = (...labels) =>
      app.evaluate(({ Menu }, labels) => {
        let items = Menu.getApplicationMenu().items;
        let item;
        for (const label of labels) {
          item = items.find((i) => i.label === label);
          items = item?.submenu?.items ?? [];
        }
        return item ? { accelerator: item.accelerator ?? null } : null;
      }, labels);
    const clickMenu = (...labels) =>
      app.evaluate(({ Menu }, labels) => {
        let items = Menu.getApplicationMenu().items;
        let item;
        for (const label of labels) {
          item = items.find((i) => i.label === label);
          items = item?.submenu?.items ?? [];
        }
        item.click();
      }, labels);
    const tabsNow = () => page.evaluate(() => window.key.tabs());
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const shortcuts = {
      splitRight: await menuItem("View", "Split Right"),
      splitDown: await menuItem("View", "Split Down"),
      focusAbove: await menuItem("View", "Focus Pane", "Above"),
      close: await menuItem("File", "Close"),
      tab1: await menuItem("View", "Go to Tab", "Tab 1"),
      nextTab: await menuItem("View", "Show Next Tab"),
      switchWorkspace: await menuItem("File", "Switch Workspace…"),
    };
    assert.deepEqual(
      Object.fromEntries(Object.entries(shortcuts).map(([k, v]) => [k, v?.accelerator])),
      {
        splitRight: "CmdOrCtrl+\\",
        splitDown: "CmdOrCtrl+Shift+\\",
        focusAbove: "CmdOrCtrl+Alt+Up",
        close: "CmdOrCtrl+W",
        tab1: "CmdOrCtrl+1",
        nextTab: "CmdOrCtrl+Shift+]",
        switchWorkspace: "CmdOrCtrl+Shift+O",
      },
    );
    let state = await tabsNow();
    const [leftPdf, rightPdf] = state.tabs.find((t) => t.id === group.id).views.map((v) => v.id);
    await page.evaluate((viewId) => window.key.tabAction("focus", { viewId }), rightPdf);
    await clickMenu("View", "Split Down");
    await page.waitForFunction(() => document.querySelectorAll(".key-split-divider").length === 2);
    state = await tabsNow();
    const nestedTab = state.tabs.find((t) => t.id === group.id);
    assert.deepEqual(nestedTab.views.map((v) => v.kind), ["pdf", "pdf", "home"]);
    const homePane = nestedTab.views[2].id;
    assert.equal(state.activeViewId, homePane, "the new pane takes focus");
    async function verifyNested(label) {
      await settle();
      const dom = await page.evaluate((homeId) => ({
        row: document.querySelector('.key-split-divider[data-split-path=""]').getBoundingClientRect().toJSON(),
        column: document.querySelector('.key-split-divider[data-split-path="b"]').getBoundingClientRect().toJSON(),
        home: document.querySelector(`[data-content-view="${homeId}"]`).getBoundingClientRect().toJSON(),
        width: innerWidth,
        height: innerHeight,
      }), homePane);
      const [left, top] = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((v) => v.webContents?.getURL().endsWith("/pdf.html"))
          .map((v) => v.getBounds())
          .sort((a, b) => a.x - b.x),
      );
      const near = (a, b, what) => assert(Math.abs(a - b) <= 1, `${label}: ${what} (${a} vs ${b}) ${JSON.stringify({ dom, left, top })}`);
      near(left.x + left.width, dom.row.x, "left reader meets the row divider");
      near(left.y + left.height, dom.height, "left reader reaches the bottom");
      near(top.x, dom.row.right, "right reader starts after the row divider");
      near(top.x + top.width, dom.width, "right reader reaches the window edge");
      near(top.y, 40, "right reader starts below the tab bar");
      near(top.y + top.height, dom.column.y, "right reader meets the column divider");
      near(dom.column.x, top.x, "column divider spans the right half");
      near(dom.home.top, dom.column.bottom, "Home pane starts after the column divider");
      near(dom.home.left, top.x, "Home pane aligns with the reader above");
      near(dom.home.bottom, dom.height, "Home pane reaches the bottom");
      near(dom.home.right, dom.width, "Home pane reaches the window edge");
      return { label, dom, left, top };
    }
    const nested = [await verifyNested("split down")];
    await page.screenshot({ path: path.join(temp, "nested.png") });
    // Drag the nested (horizontal) divider down; only the right column changes.
    const column = page.locator('.key-split-divider[data-split-path="b"]');
    const columnBox = await column.boundingBox();
    await page.mouse.move(columnBox.x + 200, columnBox.y + 3);
    await page.mouse.down();
    await page.mouse.move(columnBox.x + 200, columnBox.y + 123, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const d = document.querySelector('.key-split-divider[data-split-path="b"]');
      return Number(d.getAttribute("aria-valuenow")) > 55;
    });
    nested.push(await verifyNested("resized nested divider"));
    assert(nested[1].top.height - nested[0].top.height >= 100, "the upper right reader grew");
    assert.equal(nested[1].left.height, nested[0].left.height, "the left reader is untouched");
    // Keyboard divider: arrows move a focused horizontal divider up and down.
    const ratioBefore = Number(await column.getAttribute("aria-valuenow"));
    await column.focus();
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction((b) => Number(document.querySelector('.key-split-divider[data-split-path="b"]').getAttribute("aria-valuenow")) < b, ratioBefore);
    // Focus moves between panes by position (Cmd-Option-arrows).
    await clickMenu("View", "Focus Pane", "Above");
    for (let i = 0; i < 50 && (await tabsNow()).activeViewId !== rightPdf; i++) await settle();
    assert.equal((await tabsNow()).activeViewId, rightPdf, "Above from Home is the right reader");
    await clickMenu("View", "Focus Pane", "Left");
    for (let i = 0; i < 50 && (await tabsNow()).activeViewId !== leftPdf; i++) await settle();
    assert.equal((await tabsNow()).activeViewId, leftPdf, "Left from the right reader is the left reader");
    await clickMenu("View", "Focus Pane", "Left");
    await settle();
    assert.equal((await tabsNow()).activeViewId, leftPdf, "nothing further left");
    // A focused Home pane is a launcher: what it opens takes its place.
    await page.evaluate((viewId) => window.key.tabAction("focus", { viewId }), homePane);
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    state = await tabsNow();
    const launched = state.tabs.find((t) => t.id === group.id);
    assert.deepEqual(launched.views.map((v) => v.kind), ["pdf", "pdf", "library"]);
    assert.equal(state.activeTabId, group.id);
    assert(!state.tabs.flatMap((t) => t.views).some((v) => v.id === homePane), "the launcher is gone");
    // Cmd-W closes the focused pane, not the whole tab.
    const tabCount = state.tabs.length;
    await clickMenu("File", "Close");
    for (let i = 0; i < 50 && (await tabsNow()).tabs.find((t) => t.id === group.id)?.views.length !== 2; i++) await settle();
    state = await tabsNow();
    assert.deepEqual(state.tabs.find((t) => t.id === group.id).views.map((v) => v.id), [leftPdf, rightPdf]);
    assert.equal(state.tabs.length, tabCount);
    await page.waitForFunction(() => document.querySelectorAll(".key-split-divider").length === 1);
    nativeBounds.push(await verifyNativeBounds("after closing the nested pane"));
    console.log(
      JSON.stringify({
        ok: true,
        temp,
        group: group.id,
        viewsPreserved: group.views.length,
        releaseFrames,
        nativeBounds,
        nested,
        shortcuts,
      }),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
