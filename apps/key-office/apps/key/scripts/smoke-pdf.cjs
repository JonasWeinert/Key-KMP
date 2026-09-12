const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-pdf-smoke-"));
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
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const inputs = [
      "interaction.pdf",
      "scientific-unlinked.pdf",
      "PUBMED_33599681.pdf",
    ].map((n) => path.resolve(__dirname, "../../../../../tests/fixtures", n));
    const opened = await shell.evaluate(async (inputs) => {
      const [w] = await window.key.workspaces();
      const out = [];
      for (const input of inputs) {
        const info = await window.key.invoke(
          "library_import_file",
          { path: input },
          w.id,
        );
        out.push({ ...info, documentHash: info.hash, workspaceId: w.id });
      }
      await window.key.openSource(out[0]);
      return out;
    }, inputs);
    async function pdfPage() {
      for (let i = 0; i < 60; i++) {
        const page = app.windows().find((p) => p.url().endsWith("/pdf.html"));
        if (page) return page;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("PDF view not created");
    }
    const pdf = await pdfPage();
    pdf.on("pageerror", (e) => console.error("PDF ERROR", e));
    pdf.on("console", (m) => {
      if (m.type() === "error") console.error("PDF CONSOLE", m.text());
    });
    await pdf
      .getByRole("button", { name: "Zoom in", exact: true })
      .waitFor({ timeout: 30000 });
    await pdf.waitForFunction(
      () => document.querySelectorAll("canvas").length > 0,
      { timeout: 30000 },
    );
    await pdf.screenshot({ path: path.join(temp, "pdf.png") });
    console.log("PDF", await pdf.locator("body").innerText());
    await shell.evaluate(async (source) => {
      await window.key.openSource(source);
      const t = await window.key.tabs();
      await window.key.tabAction("split", { viewId: t.activeViewId });
    }, opened[1]);
    const split = await shell.evaluate(() => window.key.tabs());
    if (split.tabs.find((t) => t.id === split.activeTabId).views.length !== 2)
      throw Error("Split did not produce two views");
    await shell.evaluate((source) => window.key.openSource(source), opened[2]);
    const resident = await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((w) => w.getURL().endsWith("/pdf.html")).length,
    );
    if (resident > 2) throw Error("Resident PDF budget exceeded");
    await shell.evaluate((source) => window.key.openSource(source), opened[0]);
    const tabs = await shell.evaluate(() => window.key.tabs());
    const ids = tabs.tabs.flatMap((t) => t.views.map((v) => v.id));
    if (new Set(ids).size !== ids.length)
      throw Error("Duplicate view ownership");
    console.log(JSON.stringify({ ok: true, resident, tabs, temp }));
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
