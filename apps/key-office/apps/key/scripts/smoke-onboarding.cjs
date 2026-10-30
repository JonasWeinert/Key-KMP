// Run serially: native windows and focus are shared with other GUI checks.
// First run shows the welcome; its appearance choice applies app-wide and persists;
// finishing opens the library; Settings opens from the sidebar and controls indexing.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-onboarding-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    // Playwright pins a light colour scheme by default; follow the app's own setting instead.
    await page.emulateMedia({ colorScheme: null });

    const welcome = page.getByRole("dialog", { name: "Welcome to Key", exact: true });
    await welcome.getByRole("heading", { name: "Welcome to Key" }).waitFor();
    await page.waitForTimeout(400);
    await shot(page, "1-welcome");
    await welcome.getByRole("button", { name: "Get started" }).click();
    await welcome.getByRole("heading", { name: "Where your library lives" }).waitFor();
    await welcome.getByText("Personal", { exact: true }).waitFor();
    await shot(page, "2-library");
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("heading", { name: "Bring in your sources" }).waitFor();
    await shot(page, "3-import");
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("heading", { name: "Search that understands your sources" }).waitFor();
    await shot(page, "4-search");
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("radio", { name: /Dark/ }).click();
    // The choice reaches every view through prefers-color-scheme.
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await page.waitForTimeout(300);
    await shot(page, "5-appearance-dark");
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("heading", { name: "You’re all set" }).waitFor();
    await welcome.getByRole("button", { name: "Open my library" }).click();
    await page.getByRole("heading", { name: /^(All sources|Sources)$/ }).waitFor();
    await welcome.waitFor({ state: "detached" });
    const stored = JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8"));
    assert.deepEqual(stored, { theme: "dark", onboarded: true, layoutModel: true });

    // Settings: sidebar button, sections, pause indexing, appearance back to automatic.
    await page.locator(".key-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("heading", { name: "General" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, "6-settings-general-dark");
    await settings.getByRole("radio", { name: /Automatic/ }).click();
    await settings.getByRole("button", { name: "Libraries" }).click();
    await settings.getByText(/sources ·/).first().waitFor();
    await shot(page, "7-settings-libraries");
    await settings.getByRole("button", { name: "Search & indexing" }).click();
    await settings.getByRole("checkbox", { name: "Pause indexing" }).check();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.waitForFunction(async (id) => (await window.key.invoke("store_status", {}, id)).activity.paused, ws.id);
    await shot(page, "8-settings-search");
    await settings.getByRole("checkbox", { name: "Pause indexing" }).uncheck();
    await settings.getByRole("button", { name: "AI assistant" }).click();
    await settings.getByRole("textbox", { name: "Model" }).waitFor();
    await shot(page, "9-settings-ai");
    await settings.getByRole("button", { name: "About Key" }).click();
    await settings.getByText(/^Version /).waitFor();
    await shot(page, "10-settings-about");
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    assert.equal(JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8")).theme, "system");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, welcome: true, darkApplied: true, persisted: true, settings: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
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
