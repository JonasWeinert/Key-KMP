const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-office-smoke-"));
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
    const [w] = await shell.evaluate(() => window.key.workspaces());
    const library = (await shell.evaluate(() => window.key.tabs()))
      .activeViewId;
    for (const kind of ["docs", "sheets", "slides", "markdown", "html"]) {
      await shell.evaluate(
        async ({ kind, id }) =>
          window.key.tabAction("create-office", { kind, workspaceId: id }),
        { kind, id: w.id },
      );
      let editor;
      for (let i = 0; i < 100; i++) {
        editor = app
          .windows()
          .find(
            (p) =>
              p.url().includes(`/${kind}/out/renderer`) ||
              p.url().includes(`/modules/${kind}/renderer`),
          );
        if (editor) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!editor) throw Error(`${kind} renderer did not open`);
      await editor.waitForFunction(() => document.body.innerText.length > 30);
      const content = await editor.locator("body").innerText();
      await shell.evaluate(
        (viewId) => window.key.tabAction("split", { viewId }),
        library,
      );
      await shell
        .getByRole("heading", { name: "All sources", exact: true })
        .waitFor();
      const geometry = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((v) => v.getVisible?.())
          .map((v) => v.getBounds()),
      );
      if (geometry.length !== 1 || geometry[0].width < 300)
        throw Error(JSON.stringify(geometry));
      console.log(
        kind,
        "library split",
        JSON.stringify(geometry),
        content.slice(0, 100),
      );
      await shell.evaluate(() => window.key.tabAction("separate"));
      await editor.screenshot({ path: path.join(temp, kind + ".png") });
      const errors = await editor.locator("body").innerText();
      if (/ERR_FILE_NOT_FOUND|Failed to load resource/i.test(errors))
        throw Error(errors);
    }
    console.log("OFFICE_SCREENSHOTS", temp);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      dialog.showMessageBoxSync = () => 1;
    });
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
