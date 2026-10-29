const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-electron-smoke-"));
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
    page.on("pageerror", (e) => console.error("RENDERER", e));
    page.on("console", (m) => {
      if (m.type() === "error") console.error(m.text());
    });
    await page.waitForFunction(() => window.key, { timeout: 30000 });
    await page.getByRole("button", { name: "Browse all sources", exact: true }).click();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor({ timeout: 30000 });
    const result = await page.evaluate(async () => {
      const w = await window.key.workspaces();
      const project = await window.key.invoke(
        "workspace_create_project",
        { name: "Smoke project" },
        w[0].id,
      );
      const note = await window.key.invoke(
        "workspace_save_record",
        {
          kind: "note",
          title: "Smoke note",
          body: "Persistence check",
          properties: {},
        },
        w[0].id,
      );
      await window.key.invoke(
        "workspace_set_project_membership",
        { projectId: project.id, recordId: note.id, present: true },
        w[0].id,
      );
      return { w, project, note, tabs: await window.key.tabs() };
    });
    console.log(JSON.stringify(result));
    await page.screenshot({ path: path.join(temp, "home.png") });
    console.log("SCREENSHOT", path.join(temp, "home.png"));
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
