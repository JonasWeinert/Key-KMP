// Isolated workspace; run serially with other Electron GUI checks.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-motion-table-"));
  const fixture = await readFile(
    path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"),
  );
  const files = [];
  for (let i = 0; i < 80; i++) {
    const file = path.join(temp, `Paper ${String(i).padStart(3, "0")}.pdf`);
    await writeFile(
      file,
      Buffer.concat([fixture, Buffer.from(`\n% table fixture ${i}\n`)]),
    );
    files.push(file);
  }
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
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.evaluate(
      async ({ files, id }) => {
        for (const path of files)
          await window.key.invoke("library_import_file", { path }, id);
      },
      { files, id: ws.id },
    );
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    const table = page.locator(".key-beui-table:visible");
    await table.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".key-beui-table")
          ?.getAttribute("aria-rowcount") === "81",
    );
    const count = await table.locator("tbody tr[data-index]").count();
    assert(count > 5 && count < 40, `Only viewport rows mounted: ${count}`);
    await table
      .getByRole("checkbox", { name: "Select all sources on this page" })
      .check();
    await page.getByText("80 selected", { exact: true }).waitFor();
    const scroll = page.locator(".key-library-scroll:visible");
    await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await table.locator('tr[data-index="79"]').waitFor();
    assert((await table.locator("tbody tr[data-index]").count()) < 40);
    await scroll.evaluate((el) => (el.scrollTop = 0));
    await table.locator('tr[data-index="0"]').waitFor();
    await table
      .getByRole("checkbox", { name: "Select all sources on this page" })
      .uncheck();
    const authors = table.getByRole("button", {
      name: "Reorder Authors column",
      exact: true,
    });
    const year = table.getByRole("button", {
      name: "Reorder Year column",
      exact: true,
    });
    const from = await authors.boundingBox(),
      to = await year.locator("..").boundingBox();
    await page.mouse.move(from.x + 6, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 10, to.y + 20, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const keys = Array.from(
        document.querySelectorAll(".key-beui-table .key-table-column-grip"),
      ).map((el) => el.getAttribute("aria-label"));
      return (
        keys.indexOf("Reorder Authors column") >
        keys.indexOf("Reorder Year column")
      );
    });
    const order = () =>
      table
        .locator(".key-table-column-grip")
        .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    assert(
      (await order()).indexOf("Reorder Authors column") >
        (await order()).indexOf("Reorder Year column"),
    );
    // Exercise successive quick releases in both directions, with no hold delay.
    for (let cycle = 0; cycle < 6; cycle++) {
      const beforeYear = cycle % 2 === 0;
      const a = await authors.boundingBox(),
        y = await year.locator("..").boundingBox();
      await page.mouse.move(a.x + 6, a.y + 20);
      await page.mouse.down();
      await page.mouse.move(
        beforeYear ? y.x + 10 : y.x + y.width - 10,
        y.y + 20,
        { steps: 3 },
      );
      await page.mouse.up();
      await page.waitForFunction((before) => {
        const labels = Array.from(
          document.querySelectorAll(".key-beui-table .key-table-column-grip"),
        ).map((el) => el.getAttribute("aria-label"));
        return (
          labels.indexOf("Reorder Authors column") <
            labels.indexOf("Reorder Year column") ===
            before &&
          !document.querySelector('.key-beui-table th[data-drag="true"]')
        );
      }, beforeYear);
    }
    const resize = table.getByRole("separator", {
      name: "Resize Authors column",
    });
    const width = await resize
      .locator("..")
      .evaluate((el) => el.getBoundingClientRect().width);
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    assert(
      Math.abs(
        (await resize
          .locator("..")
          .evaluate((el) => el.getBoundingClientRect().width)) -
          width -
          20,
      ) < 2,
    );
    await page.screenshot({ path: path.join(temp, "table.png") });
    await page.reload();
    await table.waitFor();
    assert(
      (await order()).indexOf("Reorder Authors column") >
        (await order()).indexOf("Reorder Year column"),
    );
    assert(
      Math.abs(
        (await resize
          .locator("..")
          .evaluate((el) => el.getBoundingClientRect().width)) -
          width -
          20,
      ) < 2,
    );
    assert.deepEqual(errors, []);
    const report = {
      ok: true,
      temp,
      totalRows: 80,
      mountedRows: count,
      selectAll: true,
      scrollToEnd: true,
      columnReorder: true,
      successiveQuickDrags: 6,
      resizePersisted: true,
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (e) {
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") })
      .catch(() => {});
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
