const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
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
    const checks=[];
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
      const appearance=await editor.evaluate(async()=>{await document.fonts.ready;const control=document.querySelector('.ribbon,.ribbon-tabs,.ai-panel,.status-bar');return {scope:document.body.classList.contains('key-office-ui'),font:control?getComputedStyle(control).fontFamily:'',tokens:getComputedStyle(document.body).getPropertyValue('--key-ui-bg'),fontLoaded:document.fonts.check('13px "Geist Variable"')};});
      const composer = await editor.locator('.ai-input-box textarea').evaluate(el => {
        const s = getComputedStyle(el);
        return {font:s.fontFamily, size:s.fontSize, line:s.lineHeight, height:el.getBoundingClientRect().height, border:s.borderWidth};
      });
      assert(composer.font.includes('Geist'), `${kind} composer uses shared font`);
      assert.equal(composer.size, '14px');
      assert.equal(composer.line, '21px');
      assert(composer.height >= 88, `${kind} composer fits multiline text`);
      assert.equal(composer.border, '0px', `${kind} composer has only one outer frame`);
      appearance.composer = composer;
      assert(appearance.scope,`${kind} renderer is themed`);assert(appearance.tokens.trim(),`${kind} has shared tokens`);assert(appearance.fontLoaded,`${kind} loads bundled font`);checks.push({kind,...appearance});
      await shell.evaluate(
        (viewId) => window.key.tabAction("split", { viewId }),
        library,
      );
      await shell
        .getByRole("heading", { name: /^(All sources|Sources)$/ })
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
    await writeFile(path.join(temp,"report.json"),JSON.stringify({ok:true,temp,checks},null,2));
    console.log(JSON.stringify({ok:true,temp,checks}));
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      dialog.showMessageBoxSync = () => 1;
    });
  } finally {
    await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
    await app.close().catch(()=>{});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
