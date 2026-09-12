const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-comments-"));
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
    const source = await shell.evaluate(
      async (file) => {
        const [w] = await window.key.workspaces();
        const info = await window.key.invoke(
          "library_import_file",
          { path: file },
          w.id,
        );
        await window.key.openSource({
          ...info,
          documentHash: info.hash,
          workspaceId: w.id,
        });
        return { ...info, workspaceId: w.id };
      },
      path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"),
    );
    let pdf;
    for (let i = 0; i < 100; i++) {
      pdf = app.windows().find((p) => p.url().endsWith("/pdf.html"));
      if (pdf) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await pdf.waitForFunction(() => window.__PDFJS_READY__ === true);
    const line = pdf
      .locator(".pdfjs-text-run", { hasText: "Select this sentence" })
      .first();
    await line.waitFor();
    const b = await line.boundingBox();
    await pdf.mouse.move(b.x + 2, b.y + b.height / 2);
    await pdf.mouse.down();
    await pdf.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 15 });
    await pdf.mouse.up();
    await pdf.getByRole("button", { name: /Add note|Edit note/ }).click();
    await pdf
      .locator(".markdown-editor-surface")
      .fill("A persistent **comment** about this passage.");
    await pdf.screenshot({ path: path.join(temp, "editor.png") });
    console.log(
      "EDITOR",
      await pdf.locator(".pdfjs-comment-anchor-card").evaluate((e) => ({
        rect: e.getBoundingClientRect().toJSON(),
        background: getComputedStyle(e).backgroundColor,
      })),
      temp,
    );
    await pdf
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await pdf.getByRole("button", { name: /^Comments/ }).click();
    await pdf.locator(".key-panel-shell").evaluate(async (e) => {
      await Promise.all(e.getAnimations().map((a) => a.finished));
    });
    await pdf.screenshot({ path: path.join(temp, "comments.png") });
    console.log("BODY", await pdf.locator("body").innerText());
    const list = pdf.getByLabel("Document comments");
    await list.getByText("A persistent", { exact: false }).waitFor();
    await list.getByRole("button").click();
    await pdf.getByRole("dialog", { name: "Comment editor" }).waitFor();
    await pdf
      .locator(".markdown-editor-surface")
      .fill("Updated comment survives renderer reload.");
    await pdf
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    for (let i = 0; i < 50; i++) {
      const saved = await shell.evaluate(
        (s) =>
          window.key.invoke(
            "library_annotations",
            { hash: s.hash },
            s.workspaceId,
          ),
        source,
      );
      if (
        saved.length === 1 &&
        saved[0].comment === "Updated comment survives renderer reload."
      )
        break;
      if (i === 49)
        throw Error("Canonical annotation edit failed or duplicated comment");
      await new Promise((r) => setTimeout(r, 100));
    }
    await pdf.reload();
    await pdf.waitForFunction(() => window.__PDFJS_READY__ === true);
    await pdf.getByRole("button", { name: /^Comments/ }).click();
    await pdf
      .getByLabel("Document comments")
      .getByText("Updated comment survives renderer reload.")
      .waitFor();
    await pdf.getByLabel("Document comments").getByRole("button").click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(640, 480),
    );
    await pdf.waitForFunction(() => {
      const e = document.querySelector(".pdfjs-comment-anchor-card");
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return (
        r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
      );
    });
    const bounds = await pdf.getByRole("dialog").evaluate((e) => ({
      rect: e.getBoundingClientRect().toJSON(),
      width: innerWidth,
      height: innerHeight,
      background: getComputedStyle(e).backgroundColor,
    }));
    if (bounds.background === "rgba(0, 0, 0, 0)")
      throw Error("Transparent editor");
    await pdf.screenshot({ path: path.join(temp, "narrow-editor.png") });
    await pdf.getByRole("dialog").press("Escape");
    await pdf.getByRole("dialog").waitFor({ state: "detached" });
    await pdf.emulateMedia({ colorScheme: "dark" });
    await pdf.screenshot({ path: path.join(temp, "dark-comments.png") });
    console.log(
      JSON.stringify({
        ok: true,
        canonicalEditAndReload: true,
        narrowBounds: bounds,
        temp,
      }),
    );
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
