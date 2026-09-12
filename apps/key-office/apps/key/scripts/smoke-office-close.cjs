const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, stat } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-office-close-"));
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
    await app.evaluate(({ app, dialog }, temp) => {
      app.setPath("documents", temp);
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: temp + "/saved.docx",
      });
      dialog.showMessageBox = async () => ({
        response: 2,
        checkboxChecked: false,
      });
    }, temp);
    const [w] = await shell.evaluate(() => window.key.workspaces());
    await shell.evaluate(
      (wid) =>
        window.key.tabAction("create-office", {
          kind: "docs",
          workspaceId: wid,
        }),
      w.id,
    );
    let editor;
    for (let i = 0; i < 100; i++) {
      editor = app
        .windows()
        .find((p) => p.url().includes("/docs/out/renderer"));
      if (editor) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await editor.locator(".doc-page").first().waitFor();
    await editor.locator(".doc-page").first().click();
    await editor.keyboard.type("Key preserves my unsaved document.", {
      delay: 30,
    });
    await editor.waitForFunction(() =>
      document
        .querySelector(".doc-page")
        ?.textContent.includes("Key preserves"),
    );
    const before = await shell.evaluate(() => window.key.tabs());
    await shell.evaluate(
      (tabId) => window.key.tabAction("close", { tabId }),
      before.activeTabId,
    );
    const after = await shell.evaluate(() => window.key.tabs());
    if (!after.tabs.some((t) => t.id === before.activeTabId))
      throw Error("Cancel lost the document");
    await editor.keyboard.press("Meta+s");
    let record;
    for (let i = 0; i < 60; i++) {
      record = await shell.evaluate(
        async (wid) =>
          (await window.key.invoke("workspace_records", {}, wid)).find(
            (r) => r.properties.editor === "docs",
          ),
        w.id,
      );
      if (record) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!record) throw Error("Saved Office document not registered");
    const info = await stat(record.properties.path);
    if (info.size < 100) throw Error("Saved document empty");
    await shell.evaluate(
      (tabId) => window.key.tabAction("close", { tabId }),
      before.activeTabId,
    );
    const closed = await shell.evaluate(() => window.key.tabs());
    if (closed.tabs.some((t) => t.id === before.activeTabId))
      throw Error("Saved tab did not close");
    await shell.evaluate(
      ({ id, wid }) =>
        window.key.tabAction("open-office-record", {
          recordId: id,
          workspaceId: wid,
        }),
      { id: record.id, wid: w.id },
    );
    console.log(JSON.stringify({ ok: true, record, temp }));
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
