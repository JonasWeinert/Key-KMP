const { _electron: electron } = require("playwright-core");
const { mkdtemp, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-design-system-"));
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
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const chrome = () =>
      page.locator(".tab-bar").evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          font: s.fontFamily,
          bg: s.backgroundColor,
        };
      });
    const before = await chrome();
    await page
      .locator(".key-shell-body")
      .evaluate((el) => el.setAttribute("data-theme", "dark"));
    assert.deepEqual(
      await chrome(),
      before,
      "Theme must not change tab chrome",
    );
    await page
      .locator(".key-shell-body")
      .evaluate((el) => el.removeAttribute("data-theme"));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    await page.getByRole("heading", { name: "Sources", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "New project",
      exact: true,
    });
    await dialog.waitFor();
    const appearance = async (locator) => locator.evaluate(el => {
      const css = getComputedStyle(el);
      return {font: css.fontFamily, size: css.fontSize, height: el.getBoundingClientRect().height, padding: css.padding};
    });
    const projectField = await appearance(dialog.locator('input:not([type="checkbox"])').first());
    assert(projectField.font.includes('Geist'), 'Real dialog field uses Geist');
    assert.equal(projectField.size, '14px', 'Real dialog field uses body type');
    assert(Math.abs(projectField.height - 44) < 0.5, 'Real dialog field uses default density');
    await dialog.evaluate(async el => { await Promise.all(el.getAnimations({subtree: true}).map(a => a.finished.catch(() => {}))); });
    await page.screenshot({path: path.join(temp, 'project-dialog.png')});
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    const base = page.url().slice(0, page.url().lastIndexOf("/") + 1);
    await page.goto(base + "design-system.html");
    await page
      .getByRole("heading", { name: "Key components", exact: true })
      .waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert(
      await page.evaluate(() => document.fonts.check('14px "Geist Variable"')),
    );
    const primary = page.getByRole("button", {
      name: "Add sources",
      exact: true,
    });
    const buttonDensity = await appearance(primary);
    assert.equal(buttonDensity.size, '14px');
    assert(Math.abs(buttonDensity.height - 40) < 0.5);
    const fieldDensity = await appearance(page.getByRole('textbox', {name: 'Property name', exact: true}));
    assert(Math.abs(fieldDensity.height - 44) < 0.5);
    const normal = await primary.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await primary.hover();
    assert.equal(
      await primary.evaluate((el) => getComputedStyle(el).backgroundColor),
      normal,
      "Primary hover retains contrast",
    );
    assert(
      await page
        .getByRole("textbox", { name: "Formula", exact: true })
        .evaluate(
          (el) =>
            !!document.getElementById(el.getAttribute("aria-describedby")),
        ),
    );
    await page.getByRole("checkbox", { name: "Enable agent fill" }).check();
    await page.screenshot({ path: path.join(temp, "light.png") });
    const lightBackground = await page.locator('main').evaluate(el=>getComputedStyle(el).backgroundColor);
    await page.getByRole("button", { name: "Dark theme", exact: true }).click();
    assert.notEqual(await page.locator('main').evaluate(el=>getComputedStyle(el).backgroundColor), lightBackground, 'Dark theme changes resolved colors');
    assert.equal(await page.locator("main").getAttribute("data-theme"), "dark");
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
    await page.screenshot({ path: path.join(temp, "dark.png") });
    const report = {
      ok: true,
      temp,
      chromeUnchanged: true,
      bundledFont: true,
      globalDialogEscape: true,
      primaryHoverContrast: true,
      fieldErrorsAssociated: true,
      checkbox: true,
      density: { projectField, buttonDensity, fieldDensity },
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
