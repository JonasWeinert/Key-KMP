// Run serially: native windows and focus are shared with other GUI checks.
// OpenAlex enrichment from recorded responses (tests/fixtures/openalex; no network): a source
// with a DOI is looked up on import, its page shows topics, citations and references, a
// name opens a person's popover and page, a suggested merge is accepted there, and the
// library filters by topic and by citation count.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-openalex-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: path.resolve(__dirname, "../../../../../tests/fixtures/openalex"),
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const tabAction = (action, payload) => page.evaluate(({ action, payload }) => window.key.tabAction(action, payload), { action, payload });
    const activeKind = async () => {
      const t = await page.evaluate(() => window.key.tabs());
      return t.tabs.find((x) => x.id === t.activeTabId)?.views.find((v) => v.active)?.kind ?? t.tabs.find((x) => x.id === t.activeTabId)?.views[0]?.kind;
    };

    const create = (source) => call("store_create", { source });
    const paper = await create({ kind: "reference", itemType: "article", title: "The state of OA", doi: "10.7717/peerj.4375", creators: [{ family: "Piwowar", given: "Heather" }, { family: "Priem", given: "J." }] });
    const older = await create({ kind: "reference", itemType: "article", title: "Altmetrics: a manifesto", year: 2010, creators: [{ family: "Priem", given: "Jason" }] });
    const cited = await create({ kind: "reference", itemType: "article", title: "How open science helps researchers succeed", doi: "10.7554/eLife.16800" });
    assert.equal(paper.enrichStatus, "pending", "a DOI queues a lookup on import");

    // The background worker looks it up (from the fixtures).
    let enriched;
    for (let i = 0; i < 80; i++) {
      enriched = await call("store_source", { id: paper.id });
      if (enriched.enrichStatus === "done") break;
      await page.waitForTimeout(250);
    }
    assert.equal(enriched.enrichStatus, "done", enriched.enrichError ?? "enriched");
    assert.equal(enriched.openalexId, "W2741809807");
    assert.equal(enriched.citedByCount, 1238);
    assert.equal(enriched.title, "The state of OA", "the user's title is kept");

    // Its page: the OpenAlex rows among the properties, references with the one in the library.
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: paper.id, title: "The state of OA", read: false });
    const sourcePage = page.locator(".kx-source-page[data-side=false]");
    // The OpenAlex rows are among the details, folded under the title at first.
    await sourcePage.locator(".kx-page-details-toggle").click();
    await sourcePage.locator('.kx-research-row[data-research="Topics"]', { hasText: "Academic Publishing and Open Access" }).waitFor();
    await sourcePage.locator('.kx-research-row[data-research="Cited by"]', { hasText: "1,238" }).waitFor();
    await sourcePage.locator('.kx-research-row[data-research="Access"]', { hasText: "Gold open access" }).waitFor();
    await sourcePage.locator(".kx-work-references h3", { hasText: "1 in your library" }).waitFor();
    await sourcePage.locator('.kx-work-list li[data-in-library="true"]', { hasText: "How open science helps researchers succeed" }).waitFor();
    assert.ok((await sourcePage.locator('.kx-work-list li[data-in-library="false"]').count()) > 5, "works not yet in the library are listed too");
    // A reference opens in place to its abstract, read from OpenAlex only when opened.
    await sourcePage.getByRole("button", { name: "Show all 47" }).click();
    const reference = sourcePage.locator(".kx-work-list li", { hasText: "The Development of Open Access Journal Publishing" });
    await reference.locator(".kx-work-head").click();
    await reference.locator(".kx-work-abstract", { hasText: "open access" }).waitFor();
    await reference.getByRole("button", { name: "Add to library" }).waitFor();
    await page.screenshot({ path: path.join(temp, "reference-open.png") });
    assert.equal(await sourcePage.locator(".kx-retracted").count(), 0);
    await page.screenshot({ path: path.join(temp, "source-page.png") });

    // A name opens the person's popover first: who they are and what the library holds.
    await sourcePage.locator(".kx-creators .kx-entity-link", { hasText: "J. Priem" }).click();
    const popover = page.locator(".kx-entity-popover");
    await popover.locator("strong", { hasText: "Jason R Priem" }).waitFor();
    await popover.locator(".kx-entity-badge", { hasText: "ORCID" }).waitFor();
    await popover.getByText("1 source in your library").waitFor();
    await popover.locator(".kx-entity-chip", { hasText: "Heather Piwowar" }).waitFor();
    await page.screenshot({ path: path.join(temp, "person-popover.png") });
    await popover.getByRole("button", { name: "Open page" }).click();
    const personPage = page.locator(".kx-entity-page:visible");
    await personPage.locator(".kx-entity-title", { hasText: "Jason R Priem" }).waitFor();
    await personPage.locator('.kx-research-row[data-research="ORCID"]', { hasText: "0000-0001-6187-6610" }).waitFor();
    // Opening the page refreshed the cached counts from the author record.
    await personPage.locator('.kx-research-row[data-research="OpenAlex"]', { hasText: "h-index 18" }).waitFor();
    await personPage.locator(".kx-work-list li", { hasText: "The state of OA" }).waitFor();

    // "Jason Priem" of the older source is suggested, not merged; merging is the user's call.
    const merge = personPage.locator(".kx-entity-merge", { hasText: "Jason Priem" });
    await merge.waitFor();
    await page.screenshot({ path: path.join(temp, "person-page.png") });
    await merge.getByRole("button", { name: "Merge" }).click();
    await personPage.locator(".kx-entity-merge").waitFor({ state: "detached" });
    await personPage.locator(".kx-work-list li", { hasText: "Altmetrics: a manifesto" }).waitFor();
    const merged = await call("store_source", { id: older.id });
    const priem = (await call("store_source", { id: paper.id })).creators[1].personId;
    assert.equal(merged.creators[0].personId, priem, "the older source now names the same person");
    assert.deepEqual(await call("store_merge_suggestions"), []);

    // A topic opens its popover; Show sources filters the library by it.
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: paper.id, title: "The state of OA", read: false });
    await sourcePage.locator('.kx-research-row[data-research="Topics"] .kx-entity-link', { hasText: "Academic Publishing and Open Access" }).click();
    await popover.getByRole("button", { name: "Show sources" }).click();
    for (let i = 0; i < 40 && (await activeKind()) !== "library"; i++) await page.waitForTimeout(150);
    const library = page.locator(".kx-library:visible");
    await library.locator('.kx-token[data-field="topic"]', { hasText: "Academic Publishing and Open Access" }).waitFor();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-library .kx-row strong")].filter((r) => r.offsetParent);
      return rows.length === 1 && rows[0].textContent.includes("The state of OA");
    });

    // Citation counts filter too: typed as "cited >100", picked from the suggestions.
    await library.locator('.kx-token[data-field="topic"] button').click();
    const search = library.getByRole("combobox", { name: "Search the library" }).or(library.getByRole("searchbox", { name: "Search the library" })).or(library.getByLabel("Search the library"));
    await search.first().fill("cited >100");
    await page.getByText("Cited more than 100 times").first().click();
    await library.locator('.kx-token[data-field="citations"]').waitFor();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-library .kx-row strong")].filter((r) => r.offsetParent);
      return rows.length === 1 && rows[0].textContent.includes("The state of OA");
    });
    const byCount = await call("store_sources", { filters: [{ field: "citations", op: "gt", value: "5000" }] });
    assert.equal(byCount.total, 0);
    await page.screenshot({ path: path.join(temp, "filtered.png") });

    // A retracted work says so first.
    await call("store_update", { id: cited.id, patch: { retracted: 1 } });
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: cited.id, title: "How open science helps researchers succeed", read: false });
    await page.locator(".kx-source-page[data-side=false] .kx-retracted", { hasText: "Retracted" }).waitFor();

    // A flood of background polls never holds up, or turns away, what the user does.
    const flood = Array.from({ length: 300 }, () => call("store_status").then(() => "ok", (e) => String(e)));
    const started = Date.now();
    assert.equal((await call("store_source", { id: paper.id })).id, paper.id);
    assert.ok(Date.now() - started < 3000, `a user request answers while polls queue (${Date.now() - started} ms)`);
    assert.deepEqual([...new Set(await Promise.all(flood))], ["ok"], "no poll is refused");
    // An answer larger than the control frame arrives whole.
    const abstract = "Long abstract. ".repeat(500);
    for (let i = 0; i < 160; i++) await create({ kind: "reference", title: `Large answer ${i}`, abstract });
    const large = await call("store_sources", { limit: 200 });
    assert.ok(large.items.length >= 160 && JSON.stringify(large).length > 1024 * 1024, "a source list over 1 MiB comes back");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, enriched: true, popover: true, personPage: true, merged: true, topicFilter: true, citationFilter: true, retracted: true }));
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
