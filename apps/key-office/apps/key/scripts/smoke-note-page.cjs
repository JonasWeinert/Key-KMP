// Run serially: native windows and focus are shared with other GUI checks.
// A note is a page: it gets an Author and a workspace property from its property block,
// an icon and a cover from its header, and all of them are still there after a reload.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-note-page-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    // Page details start folded; these checks work with the properties, so open them once.
    await page.evaluate(() => localStorage.setItem("key.page.details.open", "1"));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    await call("workspace_save_attribute", { name: "Stage", config: { type: "text" } });
    const note = await call("store_note_save", { id: null, sourceId: null, title: "Field plan", body: "Visit the three sites." });
    const open = () => page.evaluate(({ id, noteId }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId, title: "Field plan" }), { id: ws.id, noteId: note.id });
    await open();
    const notePage = page.locator(".kx-note-page:visible").filter({ has: page.locator("input[value='Field plan']") });
    await notePage.locator(".kx-page-author").waitFor();

    // Author, the one default property.
    await notePage.getByRole("button", { name: "Add authors" }).click();
    await notePage.getByRole("textbox", { name: "Family name" }).fill("Okafor");
    await notePage.getByRole("textbox", { name: "Given name" }).fill("Ada");
    await notePage.getByRole("button", { name: "Done" }).click();
    // A workspace property and a standard field from "Add a property".
    await notePage.getByRole("button", { name: "Add a property" }).click();
    await notePage.getByRole("menuitem", { name: "Stage", exact: true }).click();
    const stage = notePage.getByRole("textbox", { name: "Stage", exact: true });
    await stage.fill("Pilot");
    await stage.press("Enter");
    await notePage.getByRole("button", { name: "Add a property" }).click();
    await notePage.getByRole("menuitem", { name: "Year", exact: true }).click();
    const year = notePage.locator(".kx-field-row", { hasText: "Year" }).locator("input");
    await year.fill("2024");
    await year.press("Enter");

    // The header: an icon, then a gradient cover.
    await notePage.locator(".kx-item-page-body").hover();
    await notePage.getByRole("button", { name: "Add icon" }).click();
    await notePage.getByRole("button", { name: "Icon 🌿" }).click();
    await notePage.locator(".kx-page-icon", { hasText: "🌿" }).waitFor();
    await notePage.locator(".kx-item-page-body").hover();
    await notePage.getByRole("button", { name: "Add cover" }).click();
    await notePage.getByRole("button", { name: "Dawn cover" }).click();
    await notePage.locator(".kx-page-cover").waitFor();

    let saved;
    for (let i = 0; i < 40; i++) {
      saved = await call("store_note", { id: note.id });
      if (saved.appearance?.cover && saved.properties?.Stage === "Pilot" && saved.fields?.year === 2024) break;
      await page.waitForTimeout(150);
    }
    assert.deepEqual(saved.fields.creators, [{ family: "Okafor", given: "Ada", role: "author" }]);
    assert.equal(saved.fields.year, 2024);
    assert.equal(saved.properties.Stage, "Pilot");
    assert.equal(saved.appearance.icon, "🌿");
    assert.equal(saved.appearance.cover.kind, "gradient");
    assert.equal(saved.body, "Visit the three sites.", "metadata edits leave the text alone");
    await shot(page, "1-note-page");

    // After a reload the page shows the same header and properties.
    await page.reload();
    await page.waitForFunction(() => !!window.key);
    await open();
    await notePage.locator(".kx-page-cover").waitFor();
    await notePage.locator(".kx-page-icon", { hasText: "🌿" }).waitFor();
    await notePage.locator(".kx-page-author", { hasText: "Ada Okafor" }).waitFor();
    assert.equal(await notePage.getByRole("textbox", { name: "Stage", exact: true }).inputValue(), "Pilot");
    assert.equal(await notePage.locator(".kx-field-row", { hasText: "Year" }).locator("input").inputValue(), "2024");
    await shot(page, "2-after-reload");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, author: true, property: true, field: true, icon: true, cover: true, reload: true }));
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
