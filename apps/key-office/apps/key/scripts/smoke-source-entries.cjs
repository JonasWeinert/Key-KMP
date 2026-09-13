const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-entry-ui-"));
  await mkdir(path.join(temp, "profile"));
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
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const [workspace] = await page.evaluate(() => window.key.workspaces());
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${workspace.id}"]`).click();
    await page
      .getByRole("button", { name: "References, web & media", exact: true })
      .click();
    async function add(type, title, content) {
      await page
        .getByRole("button", { name: "Add source", exact: true })
        .click();
      const d = page.getByRole("dialog", { name: "Add source", exact: true });
      await d
        .getByRole("combobox", { name: "Source type", exact: true })
        .selectOption(type);
      await d.getByRole("textbox", { name: "Title", exact: true }).fill(title);
      await d
        .getByRole("textbox", {
          name: type === "note" ? "Note" : "Supplied text or description",
          exact: true,
        })
        .fill(content);
      return d;
    }
    let d = await add(
      "note",
      "Notebook synapse",
      "Durable source text about hippocampal memory.",
    );
    await d.getByText("Custom properties", { exact: true }).click();
    await d
      .getByRole("textbox", { name: "Property name", exact: true })
      .fill("Reviewed");
    await d
      .getByRole("combobox", { name: "Type", exact: true })
      .selectOption("boolean");
    await d.getByRole("textbox", { name: "Value", exact: true }).fill("true");
    await d
      .getByRole("button", { name: "Add or update property", exact: true })
      .click();
    await d.screenshot({ path: path.join(temp, "note-editor.png") });
    await d.getByRole("button", { name: "Save source", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    d = await add(
      "dataset",
      "Brain imaging dataset",
      "Metadata only; no remote download.",
    );
    await d
      .getByRole("textbox", { name: "Source URL", exact: true })
      .fill("https://example.com/dataset");
    await d.getByRole("button", { name: "Save source", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    await page
      .getByRole("textbox", { name: "Search other sources", exact: true })
      .fill("synapse");
    await page
      .locator('section[aria-label="Other sources"] tbody tr')
      .first()
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          'section[aria-label="Other sources"] tbody tr',
        ).length === 1 &&
        document.querySelector('section[aria-label="Other sources"] mark')
          ?.textContent === "synapse",
    );
    await page.screenshot({ path: path.join(temp, "entry-search.png") });
    const entries = await page.evaluate(
      (id) => window.key.invoke("workspace_entries", {}, id),
      workspace.id,
    );
    assert.equal(entries.total, 2);
    const note = entries.entries.find((e) => e.title === "Notebook synapse");
    assert.equal(note.properties.Reviewed, true);
    await page.reload();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${workspace.id}"]`).click();
    await page
      .getByRole("button", { name: "References, web & media", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Notebook synapse", exact: true })
      .click();
    d = page.locator(".key-entry-pane:visible");
    await d.getByRole("textbox", { name: "Note", exact: true }).waitFor();
    assert.match(
      await d.getByRole("textbox", { name: "Note", exact: true }).inputValue(),
      /hippocampal/,
    );
    await d.getByText("Custom properties", { exact: true }).click();
    await d.getByText("Reviewed: true", { exact: true }).waitFor();
    await page
      .locator(".key-sidebar > button")
      .filter({ hasText: "Sources" })
      .click();
    await page.getByRole("button", { name: "PDFs", exact: true }).click();
    await page
      .getByRole("button", { name: "Agentic fill", exact: true })
      .click();
    d = page.getByRole("region", { name: "Fill a property", exact: true });
    await d
      .getByText("Configure an OpenAI-compatible provider", { exact: true })
      .click();
    await d
      .getByRole("textbox", { name: "Endpoint", exact: true })
      .fill("http://localhost:12345/v1");
    await d
      .getByRole("textbox", { name: "Model", exact: true })
      .fill("mock-not-running");
    await d.getByRole("button", { name: "Save provider", exact: true }).click();
    await d
      .getByText("Provider: custom · mock-not-running", { exact: true })
      .waitFor();
    assert.equal(
      await d
        .getByRole("button", { name: "Generate proposals", exact: true })
        .isDisabled(),
      true,
    );
    const checkboxWidths = await d
      .locator("input[type=checkbox]")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().width),
      );
    assert(
      checkboxWidths.every((width) => width < 30),
      "Checkboxes must not stretch across form rows",
    );
    await d.screenshot({ path: path.join(temp, "provider-config.png") });
    const status = await page.evaluate(
      (id) => window.key.invoke("agent_fill_status", {}, id),
      workspace.id,
    );
    assert.equal(status.available, true);
    const report = {
      passed: true,
      temp,
      sourceTypes: entries.entries.map((e) => e.properties.sourceType),
      customPropertyPersisted: true,
      searchHighlight: true,
      providerConfiguredWithoutNetworkCall: true,
      screenshots: [
        "note-editor.png",
        "entry-search.png",
        "provider-config.png",
      ].map((n) => path.join(temp, n)),
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (e) {
    console.error(e);
    const page = app.windows()[0];
    if (page) {
      await page
        .screenshot({ path: path.join(temp, "failure.png") })
        .catch(() => {});
      console.error(await page.locator("body").innerText());
      console.error(temp);
    }
    throw e;
  } finally {
    await app.evaluate(() => require("electron").app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(() => (process.exitCode = 1));
