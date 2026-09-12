const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-library-tools-"));
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
    page.setDefaultTimeout(20000);
    page.on("pageerror", e => console.error("RENDERER", String(e)));
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const source = await page.evaluate(
      async (file) => {
        const [w] = await window.key.workspaces();
        const s = await window.key.invoke(
          "library_import_file",
          { path: file },
          w.id,
        );
        await window.key.invoke(
          "begin_pdfjs_companion_managed",
          { hash: s.hash },
          w.id,
        );
        return { hash: s.hash, workspaceId: w.id };
      },
      path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"),
    );
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${source.workspaceId}"]`).click();
    await page
      .getByRole("checkbox", { name: "Select all sources on this page" })
      .check();
    await page
      .getByRole("button", { name: "＋ Attribute", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "Add attribute",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Review");
    await dialog.getByRole("combobox", { name: /Type/ }).selectOption("select");
    await dialog
      .getByRole("textbox", { name: /Options/ })
      .fill("To read; Reviewed");
    await dialog
      .getByRole("combobox", { name: /Value/ })
      .selectOption("Reviewed");
    await dialog
      .getByRole("button", { name: "Save attribute", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "＋ Attribute", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Add attribute", exact: true });
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Next page");
    await dialog
      .getByRole("combobox", { name: /Type/ })
      .selectOption("formula");
    await dialog.getByRole("textbox", { name: /Formula/ }).fill("{Pages} + 1");
    await dialog
      .getByRole("button", { name: "Save attribute", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const meta = await page.evaluate(
      (s) =>
        window.key.invoke(
          "library_metadata_details",
          { hash: s.hash },
          s.workspaceId,
        ),
      source,
    );
    assert.equal(meta.properties.Review, "Reviewed");
    assert.equal(meta.properties["Next page"], 4);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page
      .locator(".key-column-controls")
      .getByLabel("Authors", { exact: true })
      .uncheck();
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.screenshot({ path: path.join(temp, "attributes.png") });
    await page
      .getByRole("textbox", { name: "Search passages", exact: true })
      .fill("Select this sentence");
    await page.locator(".key-library-hit").first().waitFor({ timeout: 90000 });
    assert((await page.locator(".key-library-hit mark").count()) > 0);
    await page.locator(".key-library-hit").first().click();
    await page
      .getByRole("button", {
        name: "Open and highlight in reader ↗",
        exact: true,
      })
      .waitFor();
    await page.screenshot({ path: path.join(temp, "live-search-preview.png") });
    await page
      .getByRole("button", {
        name: "Open and highlight in reader ↗",
        exact: true,
      })
      .click();
    let pdf;
    for (let i = 0; i < 100; i++) {
      pdf = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (pdf) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(pdf);
    await pdf.waitForFunction(() => window.__PDFJS_FEATURES_READY__, {
      timeout: 60000,
    });
    await pdf.getByRole("button", { name: "Next result", exact: true }).click();
    await pdf
      .getByRole("button", { name: "Previous result", exact: true })
      .click();
    await pdf
      .getByRole("button", { name: "Back to results", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search passages", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Search passages", exact: true })
        .inputValue(),
      "Select this sentence",
    );
    const result = {
      passed: true,
      readerNavigation: true,
      properties: meta.properties,
      screenshots: [
        path.join(temp, "attributes.png"),
        path.join(temp, "live-search-preview.png"),
      ],
    };
    await writeFile(
      path.join(temp, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e, temp);
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
    await app.evaluate(({app}) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(() => {
  process.exitCode = 1;
});
