// Run serially: native windows and focus are shared with other GUI checks.
// Details panel (the source's page): one property list, drag-resizable and remembered.
// Notes: a source's page note written with the block editor (slash menu, @-link) saves as Markdown with custom fences,
// opens in its own tab, and standalone notes come from the sidebar. Both are found by search.
// Media: a typed YouTube link becomes a playable preview, a pasted image is stored in the
// workspace's media folder, and both render again after the window reloads.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, readdir, writeFile } = require("node:fs/promises");
const zlib = require("node:zlib");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

/** A small solid-colour PNG (RGB, no filtering). */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-notes-"));
  const fixture = path.join(temp, "Interaction study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
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
    await page.emulateMedia({ colorScheme: null });
    // Let start-up open its Home tab first, so it doesn't take focus from Sources later.
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("workspace_save_attribute", { name: "Status", config: { type: "select", options: ["To read", "Read"] } });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.locator(".kx-row").first().click();

    // One property list: bibliographic fields, then the user's properties.
    const details = page.locator(".kx-inspector .kx-page-properties");
    await details.locator(".kx-field-row", { hasText: "Year" }).waitFor();
    await details.locator(".kx-typed-row", { hasText: "Status" }).waitFor();
    assert.equal(await page.locator(".kx-inspector-section h3", { hasText: /^Properties$/ }).count(), 0);

    // Drag the panel edge 160px to the left; the width follows and is remembered.
    const inspector = page.locator(".kx-inspector");
    const before = (await inspector.boundingBox()).width;
    assert(Math.abs(before - 440) < 2, `default width ${before}`);
    const handle = await page.locator(".kx-splitter").boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 300);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(handle.x + 4 - i * 20, handle.y + 300);
    await page.mouse.up();
    const after = (await inspector.boundingBox()).width;
    assert(Math.abs(after - 600) < 3, `resized width ${after}`);
    assert.equal(await page.evaluate(() => localStorage.getItem("key.library.inspectorWidth")), "600");

    // The page's note: a callout from the slash menu, then an @-link to the source.
    const editor = page.locator(".kx-inspector .kx-page-note .ProseMirror").first();
    await editor.click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
    await page.keyboard.type("/callout");
    await page.locator(".ne-menu-item[aria-selected=true]", { hasText: "Callout" }).waitFor();
    await page.keyboard.press("Enter");
    await page.locator(".kx-inspector .kx-page-note .ne-callout").waitFor();
    await page.keyboard.type("Compare with ");
    await page.keyboard.type("@Interac");
    await page.locator(".ne-menu-item", { hasText: "Interaction study" }).waitFor();
    await page.keyboard.press("Enter");
    await page.locator(".kx-inspector .kx-page-note a[href^='key://source/']").waitFor();
    let body = "";
    for (let i = 0; i < 40 && !body.includes("key://source/"); i++) {
      await page.waitForTimeout(150);
      body = (await call("store_notes", { sourceId: created.id }))[0]?.body ?? "";
    }
    assert.match(body, /^```callout tone="info"\n/m);
    assert.match(body, new RegExp(`\\]\\(key://source/${created.id}\\)`));
    // Keys typed in a note never reach the list: Backspace must not trash, Enter must not open.
    await page.keyboard.press("Enter");
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    assert.equal((await call("store_sources", { limit: 5 })).total, 1);
    assert(!app.windows().some((w) => w.url().endsWith("/pdf.html")), "Typing must not open the reader");
    await shot(page, "1-source-note");

    // Open the note in its own tab and give it a title; the tab follows.
    await page.locator(".kx-inspector .kx-page-note").hover();
    await page.locator(".kx-inspector").getByRole("button", { name: "Open note in a tab" }).click();
    const title = page.getByRole("textbox", { name: "Note title" });
    await title.fill("Reading notes");
    await page.waitForFunction(async () => (await window.key.tabs()).tabs.some((t) => t.title.includes("Reading notes")));
    await page.locator(".kx-note-page .ne-callout").waitFor();
    await page.locator(".kx-note-source", { hasText: "Interaction study" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, "2-note-tab");

    // A standalone note from the sidebar, listed there once titled.
    await page.locator(".key-sidebar").getByRole("button", { name: "New note", exact: true }).click();
    // A new, empty note focuses its title.
    await page.waitForFunction(() => document.activeElement?.classList.contains("kx-note-title") && !document.activeElement.value);
    await page.keyboard.type("Chapter plan");
    await page.locator(".key-sidebar .kx-nav-item", { hasText: "Chapter plan" }).waitFor();
    await page.locator(".kx-note-page .ProseMirror:visible").click();
    await page.waitForFunction(() => document.activeElement?.closest(".kx-note-page"));
    await page.keyboard.type("## Outline");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[ ] Draft the methods");
    for (let i = 0; i < 40 && !(await call("store_notes", {}))[0]?.body.includes("- [ ] Draft the methods"); i++) await page.waitForTimeout(150);
    const standalone = await call("store_notes", {});
    assert.equal(standalone.length, 1);
    assert.match(standalone[0].body, /^## Outline$/m);

    // Media: a YouTube link typed on its own line becomes an embed; a pasted image is
    // stored in the workspace, never inlined.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("https://www.youtube.com/watch?v=6GR75W2dRmU");
    await page.keyboard.press("Enter");
    await page.locator(".kx-note-page .ne-video .ne-video-poster").waitFor();
    const image = png(320, 180, [70, 120, 200]);
    await page.evaluate((bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "chart.png", { type: "image/png" }));
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...image]);
    await page.locator(".kx-note-page .ne-image img").waitFor();
    const caption = page.locator(".kx-note-page .ne-image-caption input");
    await caption.fill("Response rates by region");
    await caption.press("Enter");
    let media = "";
    for (let i = 0; i < 40 && !/```image src="media\/[0-9a-f]{64}\.png"\nResponse rates/.test(media); i++) {
      await page.waitForTimeout(150);
      media = (await call("store_notes", {}))[0]?.body ?? "";
    }
    assert.match(media, /^```video url="https:\/\/www\.youtube\.com\/watch\?v=6GR75W2dRmU"$/m);
    const stored = /```image src="media\/([0-9a-f]{64}\.png)"\nResponse rates by region\n```/.exec(media);
    assert(stored, `image fence in ${media}`);
    assert(!media.includes("base64"), "images are never inlined");
    assert((await readdir(path.join(ws.root, ".key", "media"))).includes(stored[1]), "image stored in the workspace media folder");
    const captionHits = await call("store_search", { text: "response rates", mode: "keyword", limit: 5 });
    assert.equal(captionHits.notes[0]?.noteId, standalone[0].id, "an image caption is searchable");
    // An image source in the library is served the same way, for its page's preview.
    const pictureFile = path.join(temp, "Survey map.png");
    await writeFile(pictureFile, image);
    const [picture] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [pictureFile] });
    const loads = (url) =>
      page.evaluate((src) => new Promise((done) => Object.assign(new Image(), { onload: (e) => done(e.target.naturalWidth), onerror: () => done(0), src })), url);
    assert.equal(await loads(`key-media://${ws.id.toLowerCase()}/source/${picture.id}`), 320, "an image source is served for its page");
    assert.equal(await loads(`key-media://${ws.id.toLowerCase()}/source/${created.id}`), 0, "only image sources are served");
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot(page, "3-standalone-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));

    // Notes are searchable as they are saved: a source's note under its source, a
    // standalone note beside the sources, opening in its tab.
    const methods = await call("store_search", { text: "methods", mode: "keyword", limit: 5 });
    assert.equal(methods.notes[0]?.noteId, standalone[0].id);
    const compare = await call("store_search", { text: "compare", mode: "keyword", limit: 5 });
    assert.ok(compare.hits[0]?.passages.some((p) => p.noteId), "a source's note passage");
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    const search = page.getByRole("combobox", { name: "Search the library", exact: true });
    await search.fill("methods");
    await search.press("Enter");
    const noteHit = page.locator(`.kx-hit[data-note="${standalone[0].id}"]`);
    await noteHit.waitFor();
    await page.locator(".kx-results-head", { hasText: /1 note/ }).waitFor();
    await shot(page, "4-note-in-search");
    await noteHit.locator(".kx-passage").first().click();
    await page.waitForFunction(async () => {
      const { tabs, activeTabId } = await window.key.tabs();
      return tabs.find((t) => t.id === activeTabId)?.title.includes("Chapter plan");
    });


    // After a reload the note comes back from disk with its media rendered.
    await page.reload();
    await page.locator(".kx-note-page .ne-video .ne-video-poster").waitFor();
    const shownImage = page.locator(".kx-note-page .ne-image img");
    await shownImage.waitFor();
    await page.waitForFunction(() => document.querySelector(".kx-note-page .ne-image img")?.naturalWidth === 320);
    assert.equal(await page.locator(".kx-note-page .ne-image-caption input").inputValue(), "Response rates by region");
    await page.locator(".kx-note-page .ne-video").scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await shot(page, "5-note-media");
    // The image opens in a lightbox; the video plays in place from youtube-nocookie.
    await shownImage.click();
    await page.locator(".ne-lightbox img").waitFor();
    await page.waitForTimeout(300);
    await shot(page, "6-image-lightbox");
    await page.keyboard.press("Escape");
    await page.locator(".ne-lightbox").waitFor({ state: "detached" });
    await page.locator(".kx-note-page .ne-video-poster").click();
    const player = page.locator(".kx-note-page .ne-video iframe");
    await player.waitFor();
    assert.match(await player.getAttribute("src"), /^https:\/\/www\.youtube-nocookie\.com\/embed\/6GR75W2dRmU\?/);
    await page.waitForTimeout(2500);
    await shot(page, "7-video-playing");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, details: true, resized: after, sourceNote: true, noteTab: true, standalone: true, searchable: true, media: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
