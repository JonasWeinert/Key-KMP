const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-search-smoke-"));
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
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const source = await shell.evaluate(
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
        return { ...s, documentHash: s.hash, workspaceId: w.id };
      },
      path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"),
    );
    let hit;
    for (let i = 0; i < 90; i++) {
      const result = await shell.evaluate(
        async (wid) =>
          window.key.invoke(
            "global_search_page",
            { query: "Select this sentence", filter: {}, cursor: null },
            wid,
          ),
        source.workspaceId,
      );
      if (result.hits.length) {
        hit = result.hits[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!hit) throw Error("Indexed search returned no hit");
    await shell.evaluate(
      ({ source, hit }) => window.key.openSource(source, hit),
      { source, hit },
    );
    let pdf;
    for (let i = 0; i < 100; i++) {
      pdf = app.windows().find((p) => p.url().endsWith("/pdf.html"));
      if (pdf) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await pdf.waitForFunction(() => window.__PDFJS_FEATURES_READY__);
    await pdf.getByRole("button", { name: "Back to results" }).waitFor();
    await pdf.waitForFunction(() =>
      document.querySelector("[class*=result-target]"),
    );
    await pdf.screenshot({ path: path.join(temp, "search.png") });
    await pdf.getByRole("button", { name: "Back to results" }).click();
    const tabs = await shell.evaluate(() => window.key.tabs());
    if (
      tabs.tabs.find((t) => t.id === tabs.activeTabId).views[0].kind !== "home"
    )
      throw Error("Back did not activate Home");
    console.log(JSON.stringify({ ok: true, hit, temp }));
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
