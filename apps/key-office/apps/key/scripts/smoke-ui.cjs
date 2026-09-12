// Real renderer actions against an isolated workspace/profile; never personal data.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-electron-ui-"));
  await mkdir(path.join(temp, "profile"));
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
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor({ timeout: 60000 });
    const widths = await page.evaluate(() => ({
      library: document.querySelector(".key-library").getBoundingClientRect()
        .width,
      content: document
        .querySelector(".key-shell-content")
        .getBoundingClientRect().width,
    }));
    assert(
      Math.abs(widths.library - widths.content) < 3,
      JSON.stringify(widths),
    );
    await page.screenshot({ path: path.join(temp, "full-width-home.png") });
    const workspaces = await page.evaluate(() => window.key.workspaces());
    assert(workspaces.length > 0);
    await page
      .getByRole("combobox", { name: "Workspace", exact: true })
      .selectOption(workspaces[0].id);
    await page
      .getByRole("button", { name: "Create item", exact: true })
      .click();
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .fill("Qualifying research note");
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .fill("Canonical database UI validation.");
    await page.getByText("Custom properties", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "Custom properties JSON", exact: true })
      .fill('{"reviewed":true,"year":2026}');
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Create item", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New database", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .fill("Reviewed notes");
    await page
      .getByRole("combobox", { name: /Item type/ })
      .selectOption("note");
    await page.getByLabel("Property name", { exact: true }).fill("reviewed");
    await page.getByLabel("Equals", { exact: true }).fill("true");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page
      .locator(".key-record-browser")
      .getByRole("button", { name: "Qualifying research note", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(temp, "saved-database.png") });
    const persisted = await page.evaluate(
      (id) =>
        window.key.invoke("workspace_records", { limit: 100, offset: 0 }, id),
      workspaces[0].id,
    );
    const db = persisted.find((r) => r.title === "Reviewed notes");
    assert.equal(db.kind, "database");
    assert.deepEqual(db.properties.view, {
      kind: "note",
      property: "reviewed",
      value: "true",
    });
    const note = persisted.find((r) => r.title === "Qualifying research note");
    assert.equal(note.properties.reviewed, true);
    await page.reload();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    await page
      .getByRole("combobox", { name: "Workspace", exact: true })
      .selectOption(workspaces[0].id);
    await page
      .locator(".key-sidebar")
      .getByRole("button", { name: "Reviewed notes", exact: false })
      .click();
    await page
      .locator(".key-record-browser")
      .getByRole("button", { name: "Qualifying research note", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    const result = {
      passed: true,
      widths,
      noteId: note.id,
      databaseId: db.id,
      screenshots: [
        path.join(temp, "full-width-home.png"),
        path.join(temp, "saved-database.png"),
      ],
      errors,
    };
    await writeFile(
      path.join(temp, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error("UI FAILURE", e);
    const page = app.windows()[0];
    if (page) {
      await page
        .screenshot({ path: path.join(temp, "failure.png") })
        .catch(() => {});
      console.error(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
    }
    throw e;
  } finally {
    await app
      .evaluate(() => {
        require("electron").app.exit(0);
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
