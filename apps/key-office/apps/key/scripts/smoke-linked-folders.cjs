// Run serially: native windows and focus are shared with other GUI checks.
// Linked folders: a folder outside the workspace is linked from the sidebar (the folder
// picker answered by the test), its files show as a tree, a Markdown file opens editable and
// saves to disk, an edit made on disk shows up through the watcher, a note links the file
// with [[, the link survives a rename on disk, and once the folder is indexed its text is
// found by search.
const { _electron: electron } = require("playwright-core");
const { mkdir, mkdtemp, readFile, rename, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

async function until(what, check, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check().catch((e) => e);
    if (last && !(last instanceof Error)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-linked-"));
  const outside = path.join(temp, "Field notes");
  await mkdir(path.join(outside, "data"), { recursive: true });
  await mkdir(path.join(outside, ".hidden"), { recursive: true });
  await writeFile(path.join(outside, "plan.md"), "# Plan\n\nVisit the clinic on Tuesday.\n");
  await writeFile(path.join(outside, "data", "survey.csv"), "village,nets\nA,12\n");
  await writeFile(path.join(outside, ".hidden", "secret.md"), "never listed");
  await writeFile(path.join(outside, "Interaction study.pdf"), await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // Link the folder from the sidebar; the open panel answers with the folder.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, outside);
    const sidebar = page.locator(".key-sidebar");
    // Linked like anything else: from the workspace's + menu, listed among its items.
    await sidebar.getByRole("button", { name: "Create item" }).click();
    await sidebar.getByRole("button", { name: "Link a folder…" }).click();
    const tree = sidebar.getByRole("tree", { name: "Workspace" });
    const folderRow = tree.locator(".kx-tree-label", { hasText: "Field notes" });
    await folderRow.waitFor();
    const [folder] = await call("store_linked_folders");
    assert.equal(folder.tracked, true);
    assert.equal(folder.indexed, false, "tracked but not indexed by default");
    assert.equal(folder.files, 3, "hidden files are skipped");
    // Expanded on linking: the subfolder and the files, no hidden ones.
    await tree.locator(".kx-tree-label", { hasText: "data" }).waitFor();
    await tree.locator(".kx-linked-file-row", { hasText: "plan.md" }).waitFor();
    assert.equal(await tree.locator(".kx-linked-file-row", { hasText: "secret.md" }).count(), 0);
    await tree.locator(".kx-tree-label", { hasText: "data" }).click();
    await tree.locator(".kx-linked-file-row", { hasText: "survey.csv" }).waitFor();
    await shot(page, "1-linked-tree");

    // Markdown opens in the editor and writes back to the file.
    await tree.locator(".kx-linked-file-row", { hasText: "plan.md" }).click();
    const view = page.locator(".kx-linked-file:visible");
    await view.locator(".ProseMirror", { hasText: "Visit the clinic on Tuesday." }).waitFor();
    await view.locator(".ProseMirror p", { hasText: "Visit the clinic" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Bring bed nets.");
    await until("the edit on disk", async () => (await readFile(path.join(outside, "plan.md"), "utf8")).includes("Bring bed nets."));
    await until("the save to finish", async () => (await view.locator(".kx-note-saved").textContent()).startsWith("Saved"));
    await view.locator(".ProseMirror").blur();
    await page.waitForTimeout(600);

    // An edit made in another app shows up through the watcher.
    await writeFile(path.join(outside, "plan.md"), "# Plan\n\nVisit the clinic on Wednesday instead.\n");
    await view.locator(".ProseMirror", { hasText: "Wednesday instead" }).waitFor();
    await shot(page, "2-markdown-file");

    // Other files: a preview and Open in default app; text files show read-only.
    await tree.locator(".kx-linked-file-row", { hasText: "survey.csv" }).click();
    await page.locator(".kx-linked-file:visible .kx-linked-file-text", { hasText: "village,nets" }).waitFor();

    // A note links the file with [[ ; the file shows the backlink.
    const plan = (await call("store_linked_entries", { folderId: folder.id, dir: "" })).files.find((f) => f.name === "plan.md");
    await sidebar.getByRole("button", { name: "Create item" }).click();
    await sidebar.getByRole("button", { name: "New note", exact: true }).click();
    await page.locator(".kx-note-title:visible").fill("Trip");
    await page.locator(".kx-note-page .ProseMirror:visible").click();
    await page.waitForFunction(() => document.activeElement?.closest(".kx-note-page"));
    await page.keyboard.type("See [[plan");
    await page.locator(".ne-menu-item", { hasText: "plan.md" }).first().waitFor();
    await page.keyboard.press("Enter");
    await page.locator(`.kx-note-page:visible a[href^='key://file/${plan.id}']`).waitFor();
    const backlinks = await until("the backlink", async () => {
      const links = await call("store_links", { kind: "file", id: plan.id });
      return links.backlinks.length ? links.backlinks : null;
    });
    assert.equal(backlinks[0].from.title, "Trip");

    // Renamed on disk: same id, the link follows and is not broken.
    await rename(path.join(outside, "plan.md"), path.join(outside, "data", "trip plan.md"));
    await until("the rename to be seen", async () => (await call("store_linked_file", { id: plan.id }))?.path === "data/trip plan.md");
    const outgoing = await until("the note's link", async () => {
      const links = await call("store_links", { kind: "note", id: backlinks[0].from.id });
      return links.outgoing.find((l) => l.to.id === plan.id);
    });
    assert.equal(outgoing.broken, false);
    assert.equal(outgoing.to.title, "trip plan.md");

    // Index the folder from its menu; its text is then found by search.
    await folderRow.click({ button: "right" });
    await page.locator("[role=menuitem]", { hasText: "Index for search" }).click();
    await until("the folder to be indexed", async () => (await call("store_linked_folders"))[0].indexedFiles >= 2, 30000);
    const found = await until("a search hit in the file", async () => {
      const result = await call("store_search", { text: "Wednesday", mode: "keyword" });
      return result.files?.find((f) => f.fileId === plan.id);
    });
    assert.match(found.passages[0].snippet, /\[\[Wednesday\]\]/);
    await shot(page, "3-indexed");

    assert.deepEqual(errors, []);
    console.log(`Linked folders smoke passed (${temp})`);
  } finally {
    await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
