const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-electron-stress-"));
  await mkdir(path.join(temp, "profile"));
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  const samples = [];
  const errors = [];
  const cycles = [];
  let timer;
  async function sample() {
    const value = await app.evaluate(({ app, webContents }) => ({
      time: Date.now(),
      resident: webContents
        .getAllWebContents()
        .filter((w) => w.getURL().endsWith("/pdf.html")).length,
      processes: app
        .getAppMetrics()
        .map((p) => ({
          pid: p.pid,
          type: p.type,
          workingSetKiB: p.memory.workingSetSize,
          peakWorkingSetKiB: p.memory.peakWorkingSetSize,
        })),
    }));
    value.totalMiB =
      value.processes.reduce((sum, p) => sum + p.workingSetKiB, 0) / 1024;
    samples.push(value);
    return value;
  }
  async function activeReader(hash) {
    for (let attempt = 0; attempt < 150; attempt++) {
      for (const page of app
        .windows()
        .filter((p) => p.url().endsWith("/pdf.html"))) {
        try {
          if (
            (await page.evaluate(() => window.key.readerReady())).source
              .hash === hash
          )
            return page;
        } catch {}
      }
      await delay(100);
    }
    throw Error("Reader did not attach");
  }
  async function ready(page) {
    await page
      .getByRole("button", { name: "Zoom in", exact: true })
      .waitFor({ timeout: 30000 });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".key-pdf-page")
          ?.textContent?.match(/\/\s*\d+/) &&
        [...document.querySelectorAll("canvas")].some(
          (c) => c.width > 0 && c.height > 0,
        ),
      { timeout: 30000 },
    );
  }
  try {
    const shell = await app.firstWindow();
    shell.on("pageerror", (e) => errors.push(String(e)));
    await shell.waitForFunction(() => window.key);
    const inputs = [
      "interaction.pdf",
      "scientific-unlinked.pdf",
      "PUBMED_33599681.pdf",
    ].map((n) => path.resolve(__dirname, "../../../../../tests/fixtures", n));
    const opened = await shell.evaluate(async (inputs) => {
      const [w] = await window.key.workspaces();
      const results = [];
      for (const input of inputs) {
        const info = await window.key.invoke(
          "library_import_file",
          { path: input },
          w.id,
        );
        results.push({ ...info, documentHash: info.hash, workspaceId: w.id });
      }
      return results;
    }, inputs);
    await sample();
    timer = setInterval(() => {
      sample().catch((e) => errors.push(String(e)));
    }, 1000);
    for (let i = 0; i < 24; i++) {
      const source = opened[i % 3];
      const start = performance.now();
      await shell.evaluate((source) => window.key.openSource(source), source);
      const page = await activeReader(source.hash);
      await ready(page);
      const readyMs = performance.now() - start;
      page.on("pageerror", (e) => errors.push(String(e)));
      await page
        .getByRole("button", {
          name: i % 2 ? "Zoom out" : "Zoom in",
          exact: true,
        })
        .click();
      const interaction = await page.evaluate(async () => {
        const scroll = document.querySelector(".pdfjs-scroll");
        const frames = [];
        let last = performance.now();
        for (let j = 0; j < 24; j++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          frames.push(now - last);
          last = now;
          scroll.scrollTop =
            (j % 2
              ? 0
              : Math.max(1, scroll.scrollHeight - scroll.clientHeight)) *
            (((j % 5) + 1) / 5);
        }
        return {
          maxFrameMs: Math.max(...frames),
          framesOver33Ms: frames.filter((x) => x > 33).length,
          scrollHeight: scroll.scrollHeight,
          viewportHeight: scroll.clientHeight,
          canvases: document.querySelectorAll("canvas").length,
        };
      });
      if (i % 4 === 0) {
        await shell.evaluate(async () => {
          const state = await window.key.tabs();
          await window.key.tabAction("split", { viewId: state.activeViewId });
        });
        await delay(200);
        const split = await shell.evaluate(() => window.key.tabs());
        const count = split.tabs.find((t) => t.id === split.activeTabId).views
          .length;
        if (i > 0) assert.equal(count, 2, "Split should contain two views");
        if (i === 8) {
          await page.screenshot({ path: path.join(temp, "split-reader.png") });
          await shell.screenshot({ path: path.join(temp, "split-shell.png") });
        }
        await shell.evaluate(() => window.key.tabAction("separate"));
      }
      await ready(page);
      const state = await shell.evaluate(() => window.key.tabs());
      const ids = state.tabs.flatMap((t) => t.views.map((v) => v.id));
      assert.equal(
        new Set(ids).size,
        ids.length,
        "Each view has exactly one owner",
      );
      const metric = await sample();
      assert.ok(
        metric.resident <= 2,
        `Resident budget exceeded after readiness: ${metric.resident}`,
      );
      const zoom = await page.locator(".key-pdf-zoom").innerText();
      assert.match(zoom, /\d+%/);
      cycles.push({
        cycle: i + 1,
        document: source.title,
        readyMs,
        totalMs: performance.now() - start,
        resident: metric.resident,
        totalMiB: metric.totalMiB,
        zoom,
        ...interaction,
      });
      if (i === 0)
        await page.screenshot({ path: path.join(temp, "start-reader.png") });
      if (i === 23)
        await page.screenshot({ path: path.join(temp, "end-reader.png") });
      console.log(JSON.stringify(cycles.at(-1)));
    }
    await delay(5000);
    const activeEnd = await sample();
    await shell.evaluate(async () => {
      const state = await window.key.tabs();
      for (const tab of state.tabs)
        if (tab.views.some((v) => v.kind === "pdf"))
          await window.key.tabAction("close", { tabId: tab.id });
    });
    let canSuspend = false;
    let finalDocuments = [];
    const closingStarted = Date.now();
    while (Date.now() - closingStarted < 180000) {
      canSuspend = await shell.evaluate(
        (id) => window.key.invoke("host_can_suspend", {}, id),
        opened[0].workspaceId,
      );
      if (canSuspend) break;
      finalDocuments = await shell.evaluate(
        (id) => window.key.invoke("semantic_library", {}, id),
        opened[0].workspaceId,
      );
      await delay(1000);
    }
    assert.equal(
      canSuspend,
      true,
      "Closing every PDF must release readers and allow suspension after indexing",
    );
    const closed = await sample();
    assert.equal(
      closed.resident,
      0,
      "PDF renderers must be released after closing all tabs",
    );
    assert.deepEqual(errors, [], "Renderer or sampling errors occurred");
    const report = {
      ok: true,
      temp,
      cycles,
      samples,
      errors,
      cleanup: {
        canSuspend,
        waitMs: Date.now() - closingStarted,
        closedResident: closed.resident,
        finalDocuments,
      },
      activeEndMiB: activeEnd.totalMiB,
      startMiB: samples[0].totalMiB,
      endMiB: samples.at(-1).totalMiB,
      peakMiB: Math.max(...samples.map((s) => s.totalMiB)),
      scope:
        "Electron app.getAppMetrics workingSetSize: main/renderers/GPU/utility processes; Rust workers excluded. Synthetic foreground switching/zoom/scroll and split/separate; local debug build, not a latency guarantee.",
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        ok: true,
        temp,
        startMiB: report.startMiB,
        endMiB: report.endMiB,
        peakMiB: report.peakMiB,
        errors,
      }),
    );
  } finally {
    clearInterval(timer);
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
