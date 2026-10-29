// Run serially: native windows and focus are shared with other GUI checks.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-mac-shell-"));
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
    await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
    await page.getByText("Your library starts here", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(temp, "home-empty.png") });
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.evaluate(
      async ({ id, file }) =>
        window.key.invoke("library_import_file", { path: file }, id),
      {
        id: ws.id,
        file: path.resolve(
          __dirname,
          "../../../../../tests/fixtures/interaction.pdf",
        ),
      },
    );
    await page
      .getByRole("button", { name: "Browse all sources", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    await page.locator('.key-beui-table:visible tbody tr[data-index="0"]').waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "＋ Property", exact: true })
        .isVisible(),
      false,
    );
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page
      .getByRole("button", { name: "＋ Property", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator(".key-library-tools-menu:visible")
        .getAttribute("open"),
      null,
    );
    await page.screenshot({ path: path.join(temp, "sources.png") });
    await page
      .locator(".key-sidebar")
      .getByRole("button", { name: "Home", exact: true })
      .click();
    await page.locator(".key-home-recents li").waitFor();
    await page.screenshot({ path: path.join(temp, "home.png") });
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".key-sidebar-slot").getBoundingClientRect()
          .width === 0,
    );
    await page.screenshot({ path: path.join(temp, "home-collapsed.png") });
    await page
      .getByRole("button", { name: "Expand sidebar", exact: true })
      .click();
    await page
      .locator(".key-sidebar")
      .getByRole("button", { name: "Home", exact: true })
      .waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(temp, "home-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(820, 700),
    );
    await page.screenshot({ path: path.join(temp, "home-narrow.png") });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ok: true,
        temp,
        home: true,
        recentSources: true,
        toolsDisclosure: true,
      }),
    );
  } catch (e) {
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") });
    console.error(temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
