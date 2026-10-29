const { _electron: electron } = require("playwright-core");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-global-property-"));
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
    await page.getByRole("button", { name: "Browse all sources", exact: true }).click();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    await page.getByRole("heading", { name: "Sources", exact: true }).waitFor();
    const owner = (await page.evaluate(() => window.key.tabs())).activeTabId;
    await page.evaluate(
      async ({ workspaceId, file, owner }) => {
        await window.key.invoke(
          "workspace_save_attribute",
          { name: "Review", config: { type: "text" } },
          workspaceId,
        );
        const source = await window.key.invoke(
          "library_import_file",
          { path: file },
          workspaceId,
        );
        await window.key.openSource({
          ...source,
          documentHash: source.hash,
          workspaceId,
        });
        const state = await window.key.tabs();
        const pdf = state.activeViewId;
        await window.key.tabAction("activate", { tabId: owner });
        await window.key.tabAction("split", { viewId: pdf });
      },
      {
        workspaceId: ws.id,
        file: path.resolve(
          __dirname,
          "../../../../../tests/fixtures/interaction.pdf",
        ),
        owner,
      },
    );
    let pdf;
    for (let i = 0; i < 100; i++) {
      pdf = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (pdf) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await pdf.waitForFunction(() => window.__PDFJS_READY__ === true);
    const before = await page.evaluate(() => window.key.tabs());
    await page
      .getByRole("button", { name: "Configure Review property", exact: true })
      .click();
    const drawer = page.getByRole("dialog", {
      name: "Property details",
      exact: true,
    });
    await drawer.waitFor();
    await page.waitForFunction(
      () =>
        Math.abs(
          document.querySelector(".key-global-drawer").getBoundingClientRect()
            .x,
        ) < 1,
    );
    const bounds = await drawer.boundingBox();
    assert.equal(bounds.y, 40);
    assert(bounds.x < 1);
    assert(bounds.width > 240);
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.filter((v) =>
            v.getVisible(),
          ).length,
      ),
      0,
      "Native PDF cannot paint over global drawer",
    );
    await page.locator(".key-native-overlay-frame").waitFor();
    assert(
      await page
        .locator(".key-native-overlay-frame")
        .evaluate((el) => el.naturalWidth > 100),
    );
    assert.equal(
      await page.locator(".key-shell-body").evaluate((el) => el.inert),
      true,
    );
    await page.screenshot({ path: path.join(temp, "property-over-split.png") });
    // Tab switching retains the globally owned property and its workspace scope.
    const home = before.tabs.find((t) => t.id !== owner);
    if (home) {
      await page.locator(`[data-tab-id="${home.id}"]`).click();
      await drawer.waitFor();
      assert.equal(
        await drawer
          .getByRole("textbox", { name: "Property name", exact: true })
          .inputValue(),
        "Review",
      );
      await page.locator(`[data-tab-id="${owner}"]`).click();
    }
    await drawer
      .getByRole("button", { name: "Configure agent fill", exact: false })
      .click();
    await drawer
      .getByRole("button", { name: "Back to property", exact: true })
      .waitFor();
    const instructions = drawer.getByRole("textbox", {
      name: "Instructions",
      exact: true,
    });
    await instructions.fill("Retain this unsaved recipe when navigating back.");
    await page.waitForFunction(
      () =>
        Math.abs(
          document
            .querySelector(".key-drawer-slide:last-child")
            .getBoundingClientRect().x,
        ) < 1,
    );
    await page.screenshot({ path: path.join(temp, "agent-detail.png") });
    await drawer
      .getByRole("button", { name: "Back to property", exact: true })
      .click();
    await drawer
      .getByRole("button", { name: "Configure agent fill", exact: false })
      .click();
    assert.equal(
      await instructions.inputValue(),
      "Retain this unsaved recipe when navigating back.",
    );
    await drawer
      .getByRole("button", { name: "Save instructions", exact: true })
      .click();
    await drawer
      .getByText("Recipe saved for this property. No inputs have been sent.", {
        exact: true,
      })
      .waitFor();
    await drawer
      .getByRole("button", { name: "Back to property", exact: true })
      .click();
    await drawer
      .getByRole("button", { name: "Close property editor", exact: true })
      .click();
    await page.locator(".key-global-drawer").waitFor({ state: "detached" });
    await page.waitForFunction(
      () => !document.querySelector(".key-shell-body").inert,
    );
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.filter((v) =>
            v.getVisible(),
          ).length,
      ),
      1,
    );
    assert.equal(await page.locator(".key-native-overlay-frame").count(), 0);
    const after = await page.evaluate(() => window.key.tabs());
    assert.deepEqual(
      after.tabs.find((t) => t.id === owner).views.map((v) => v.id),
      before.tabs.find((t) => t.id === owner).views.map((v) => v.id),
    );
    const defs = await page.evaluate(
      (id) => window.key.invoke("workspace_attributes", {}, id),
      ws.id,
    );
    assert.equal(
      defs.find((d) => d.name === "Review").agentic.instruction,
      "Retain this unsaved recipe when navigating back.",
    );
    assert.deepEqual(errors, []);
    const report = {
      ok: true,
      temp,
      globalBounds: bounds,
      nativeLayering: true,
      tabSwitchPreservesProperty: true,
      agentDraftPreserved: true,
      nativeViewsRestored: true,
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (e) {
    console.error("Artifacts", temp);
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") })
      .catch(() => {});
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
