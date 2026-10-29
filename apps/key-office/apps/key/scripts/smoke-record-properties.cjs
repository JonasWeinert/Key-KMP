// Run only with exclusive GUI ownership, against a freshly built Key shell.
// Every mutation is confined to an isolated test profile/workspace.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { createServer } = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-record-properties-"));
  await mkdir(path.join(temp, "profile"));
  let providerRequests = 0;
  const server = createServer((_request, response) => {
    providerRequests++;
    response.writeHead(500);
    response.end("No inference should be requested by this test");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
      .waitFor({ timeout: 60000 });
    const [workspace] = await page.evaluate(() => window.key.workspaces());
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${workspace.id}"]`).click();
    await page
      .getByRole("button", { name: "Create item", exact: true })
      .click();
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .fill("Typed properties research note");
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .fill("Canonical note body, retained while editing properties.");
    const record = page.locator(".key-record-editor:visible");
    const rows = record.locator(".key-record-properties");
    const propertyRow = (name) =>
      rows
        .locator(".key-record-property-row")
        .filter({ has: page.getByRole("button", { name, exact: true }) });
    async function define(name, type, value, options) {
      await rows
        .getByRole("button", { name: "＋ Add property", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "New property",
        exact: true,
      });
      await dialog
        .getByRole("textbox", { name: "Property name", exact: true })
        .fill(name);
      await dialog
        .locator(".key-property-types button")
        .filter({ hasText: type })
        .click();
      if (options)
        for (const option of options) {
          await dialog.getByPlaceholder("Add an option…").fill(option);
          await dialog
            .getByRole("button", { name: "Add", exact: true })
            .click();
        }
      if (type === "Formula")
        await dialog
          .getByRole("textbox", { name: "Formula", exact: true })
          .fill(value);
      else {
        await dialog
          .locator(".key-property-apply input[type=checkbox]")
          .check();
        if (type === "Checkbox" || type === "Select")
          await dialog.getByLabel("Value", { exact: true }).selectOption(value);
        else await dialog.getByLabel("Value", { exact: true }).fill(value);
      }
      await dialog
        .getByRole("button", { name: "Create property", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
    }
    await define("Topic", "Text", "Neuroscience");
    await define("Importance", "Number", "3");
    await define("Reviewed", "Checkbox", "true");
    await define("Reading status", "Select", "To read", ["To read", "Read"]);
    await define("Priority score", "Formula", "[Importance] * 2");
    const formulaRow = rows.locator(".key-record-property-row").filter({
      has: page.getByRole("button", { name: "Priority score", exact: true }),
    });
    assert.equal(await formulaRow.locator("output").innerText(), "6");
    await formulaRow
      .getByRole("button", { name: "Use result", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await record.getByText("Saved", { exact: true }).waitFor();
    const records = await page.evaluate(
      (id) =>
        window.key.invoke("workspace_records", { limit: 100, offset: 0 }, id),
      workspace.id,
    );
    const note = records.find(
      (r) => r.title === "Typed properties research note",
    );
    assert(note?.id);
    assert.deepEqual(note.properties, {
      Topic: "Neuroscience",
      Importance: 3,
      Reviewed: true,
      "Reading status": "To read",
      "Priority score": 6,
    });
    // Editing an input previews a fresh formula but leaves its materialized value unchanged until Use result.
    await propertyRow("Importance").getByRole("spinbutton").fill("4");
    assert.equal(await formulaRow.locator("output").innerText(), "8");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await record.getByText("Saved", { exact: true }).waitFor();
    const changed = await page.evaluate(
      ({ id, recordId }) =>
        window.key
          .invoke("workspace_records", { limit: 100, offset: 0 }, id)
          .then((rows) => rows.find((r) => r.id === recordId)),
      { id: workspace.id, recordId: note.id },
    );
    assert.equal(changed.properties.Importance, 4);
    assert.equal(changed.properties["Priority score"], 6);
    assert(changed.revision > note.revision);
    await page.reload();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Page title", exact: true })
        .inputValue(),
      "Typed properties research note",
    );
    assert.equal(
      await propertyRow("Importance").getByRole("spinbutton").inputValue(),
      "4",
    );
    assert.equal(
      await rows
        .getByRole("checkbox", { name: "Reviewed", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await propertyRow("Reading status").getByRole("combobox").inputValue(),
      "To read",
    );
    await formulaRow
      .getByRole("button", { name: "Use result", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await record.getByText("Saved", { exact: true }).waitFor();
    await propertyRow("Importance").getByRole("spinbutton").fill("7");
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .fill("Unsaved body retained through atomic property rename.");
    await rows.getByRole("button", { name: "Importance", exact: true }).click();
    const renameDialog = page.getByRole("dialog", {
      name: "Edit property",
      exact: true,
    });
    await renameDialog
      .getByRole("textbox", { name: "Property name", exact: true })
      .fill("Impact");
    await renameDialog
      .getByRole("button", { name: "Save property", exact: true })
      .click();
    await renameDialog.waitFor({ state: "hidden" });
    assert.equal(
      await propertyRow("Impact").getByRole("spinbutton").inputValue(),
      "7",
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: "Page content", exact: true })
        .inputValue(),
      "Unsaved body retained through atomic property rename.",
    );
    const afterRename = await page.evaluate(
      ({ id, recordId }) =>
        window.key
          .invoke("workspace_records", { limit: 100, offset: 0 }, id)
          .then((rows) => rows.find((row) => row.id === recordId)),
      { id: workspace.id, recordId: note.id },
    );
    assert.equal(afterRename.properties.Impact, 4);
    assert.equal(Object.hasOwn(afterRename.properties, "Importance"), false);
    assert.notEqual(
      afterRename.body,
      "Unsaved body retained through atomic property rename.",
    );
    assert.equal(await formulaRow.locator("output").innerText(), "14");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await record.getByText("Saved", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(temp, "typed-record.png") });
    await page
      .locator(".key-sidebar .kx-nav-item")
      .filter({ hasText: "Sources" })
      .click();
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page
      .getByRole("button", { name: "Agentic fill", exact: true })
      .click();
    let dialog = page.getByRole("region", {
      name: "Fill a property",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Property name", exact: true })
      .fill("Impact");
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Fill a property"] select')
          ?.value === "number",
    );
    assert.equal(
      await dialog
        .getByRole("combobox", { name: "Value type", exact: true })
        .isDisabled(),
      true,
    );
    await dialog
      .getByLabel("PDF text (up to 32 KiB from first extracted blocks)", {
        exact: true,
      })
      .uncheck();
    await dialog.getByLabel("authors", { exact: true }).check();
    await dialog
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill(
        "Score importance from the title and author metadata only. Return null if unsupported.",
      );
    await dialog
      .getByRole("button", { name: "Save instructions", exact: true })
      .click();
    await dialog
      .getByText("Recipe saved for this property. No inputs have been sent.", {
        exact: true,
      })
      .waitFor();
    await dialog
      .getByText("Configure an OpenAI-compatible provider", { exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: "Endpoint", exact: true })
      .fill(`http://127.0.0.1:${server.address().port}/v1`);
    await dialog
      .getByRole("textbox", { name: "Model", exact: true })
      .fill("test-no-inference");
    await dialog
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await dialog
      .getByText("Provider: custom · test-no-inference", { exact: true })
      .waitFor();
    await dialog.getByRole("button", { name: "Close agent settings", exact: true }).click();
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page
      .getByRole("button", { name: "Agentic fill", exact: true })
      .click();
    dialog = page.getByRole("region", { name: "Fill a property", exact: true });
    await dialog
      .getByRole("textbox", { name: "Property name", exact: true })
      .fill("Impact");
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Fill a property"] textarea')
        ?.value.startsWith("Score importance"),
    );
    assert.equal(
      await dialog.getByLabel("authors", { exact: true }).isChecked(),
      true,
    );
    assert.equal(
      await dialog
        .getByLabel("PDF text (up to 32 KiB from first extracted blocks)", {
          exact: true,
        })
        .isChecked(),
      false,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Generate proposals", exact: true })
        .isDisabled(),
      true,
    );
    const attributes = await page.evaluate(
      (id) => window.key.invoke("workspace_attributes", {}, id),
      workspace.id,
    );
    const importance = attributes.find((a) => a.name === "Impact");
    assert.equal(importance.type, "number");
    assert.deepEqual(importance.agentic.inputs, ["title", "authors"]);
    assert.equal(importance.agentic.enabled, true);
    assert.match(importance.agentic.instruction, /metadata only/);
    await dialog.screenshot({
      path: path.join(temp, "saved-agent-recipe.png"),
    });
    const final = await page.evaluate(
      ({ id, recordId }) =>
        window.key
          .invoke("workspace_records", { limit: 100, offset: 0 }, id)
          .then((rows) => rows.find((r) => r.id === recordId)),
      { id: workspace.id, recordId: note.id },
    );
    assert.equal(final.properties["Priority score"], 8);
    assert.equal(final.properties.Impact, 7);
    assert.equal(
      final.body,
      "Unsaved body retained through atomic property rename.",
    );
    assert.equal(providerRequests, 0);
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      temp,
      noteId: note.id,
      typedProperties: true,
      canonicalReopen: true,
      renamePreservesUnsavedDraft: true,
      formulaExplicitMaterialization: true,
      agentRecipeRestored: true,
      providerRequests,
      errors,
      screenshots: ["typed-record.png", "saved-agent-recipe.png"].map((n) =>
        path.join(temp, n),
      ),
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (error) {
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
    console.error(temp);
    throw error;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
