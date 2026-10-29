const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-library-tools-"));
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
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on("pageerror", e => console.error("RENDERER", String(e)));
    await page.getByRole("button", { name: "Browse all sources", exact: true }).click();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const source = await page.evaluate(
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
        return { hash: s.hash, workspaceId: w.id };
      },
      path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"),
    );
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator(`[data-workspace-id="${source.workspaceId}"]`).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));
    // Title defaults to pinned, but both its scroll behavior and saved preference are user-controlled.
    const grid=page.locator('.key-source-grid:visible');
    await grid.getByRole('button',{name:'Unpin Title column',exact:true}).waitFor();
    const scroll=page.locator('.key-library-scroll:visible');
    const titleCell=grid.locator('tbody tr td').nth(1);
    await titleCell.waitFor();
    const pinnedX=(await titleCell.boundingBox()).x;
    await scroll.evaluate(el=>el.scrollLeft=120);
    assert(Math.abs((await titleCell.boundingBox()).x-pinnedX)<2);
    await scroll.evaluate(el=>el.scrollLeft=0);
    await grid.getByRole('button',{name:'Unpin Title column',exact:true}).click();
    const unpinnedX=(await titleCell.boundingBox()).x;
    await scroll.evaluate(el=>el.scrollLeft=120);
    assert((await titleCell.boundingBox()).x<unpinnedX-80,'Unpinned Title scrolls with other columns');
    await page.reload();
    await grid.getByRole('button',{name:'Pin Title column',exact:true}).waitFor();
    await grid.getByRole('button',{name:'Pin Title column',exact:true}).click();
    await grid.getByRole('button',{name:'Unpin Title column',exact:true}).waitFor();
    assert.equal(await titleCell.evaluate(el=>getComputedStyle(el).borderRightWidth),'1px');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900));
    await page
      .getByRole("checkbox", { name: "Select all sources on this page" })
      .check();
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page.getByRole("button", { name: "Add property", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "New property", exact: true });
    await dialog.getByRole("textbox", { name: "Property name", exact: true }).fill("Review");
    await dialog.getByRole("button", { name: /Select$/, exact: false }).click();
    await dialog.getByPlaceholder("Add an option…").fill("To read");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByPlaceholder("Add an option…").fill("Reviewed");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("checkbox", { name: /Set a value/ }).check();
    await dialog.getByRole("combobox", { name: "Value", exact: true }).selectOption("Reviewed");
    await dialog.getByRole("button", { name: "Create property", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // Editing the definition must preserve previously saved source values.
    await page.getByRole("button", { name: "Configure Review property", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Edit property", exact: true });
    await dialog.getByRole("textbox", {name:"Property name",exact:true}).fill("Reading status");
    assert.equal(await dialog.getByRole("checkbox", { name: /Set a value/ }).isChecked(), false);
    await dialog.getByPlaceholder("Add an option…").fill("Archived");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await page.screenshot({path:path.join(temp,"property-editor.png")});
    await dialog.getByRole("button", {name:"Save property",exact:true}).click();
    await dialog.waitFor({state:"hidden"});
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page.getByRole("button", { name: "Add property", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "New property", exact: true });
    await dialog.getByRole("textbox", { name: "Property name", exact: true }).fill("Rating");
    await dialog.getByRole("button", {name:/Number$/,exact:false}).click();
    await dialog.getByRole("button", {name:"Create property",exact:true}).click();
    await dialog.waitFor({state:"hidden"});
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page.getByRole("button", { name: "Add property", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "New property", exact: true });
    await dialog.getByRole("textbox", { name: "Property name", exact: true }).fill("Next page");
    await dialog.getByRole("button", {name:/Formula$/,exact:false}).click();
    await dialog.getByRole("textbox", {name:"Formula",exact:true}).fill("{Pages} + 1");
    await dialog.getByRole("checkbox", {name:/Recompute stored results/}).check();
    await dialog.getByRole("button", { name: "Create property", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const meta = await page.evaluate(s=>window.key.invoke("library_metadata_details",{hash:s.hash},s.workspaceId),source);
    assert.equal(meta.properties["Reading status"],"Reviewed");
    assert.equal(Object.hasOwn(meta.properties,"Review"),false);
    assert.equal(meta.properties["Next page"],4);
    assert.equal(Object.hasOwn(meta.properties,"Rating"),false);
    const definitions=await page.evaluate(s=>window.key.invoke("workspace_attributes",{},s.workspaceId),source);
    assert.deepEqual(definitions.find(d=>d.name==='Reading status').options,['To read','Reviewed','Archived']);
    assert.equal(definitions.find(d=>d.name==='Rating').type,'number');
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page.getByRole("button", { name: "Properties", exact: true }).click();
    await page.getByRole("region",{name:"Manage properties"}).getByRole("checkbox",{name:"Show Authors",exact:true}).uncheck();
    await page.screenshot({path:path.join(temp,"property-manager.png")});
    await page.locator(".key-library-tools-menu:visible > summary").click();
    await page.getByRole("button", { name: "Properties", exact: true }).click();
    await page.screenshot({ path: path.join(temp, "attributes.png") });
    if(process.env.KEY_PROPERTY_ONLY==='1'){
      const result={passed:true,propertyDefinitionPreservedValues:true,renamePreservedValues:true,emptyNumberDefinition:true,properties:meta.properties,screenshots:['property-editor.png','property-manager.png','attributes.png'].map(name=>path.join(temp,name))};
      await writeFile(path.join(temp,'result.json'),JSON.stringify(result,null,2));
      console.log(JSON.stringify(result,null,2));return;
    }
    await page
      .getByRole("textbox", { name: "Search passages", exact: true })
      .fill("Select this sentence");
    await page.locator(".key-library-hit").first().waitFor({ timeout: 90000 });
    assert((await page.locator(".key-library-hit mark").count()) > 0);
    await page.locator(".key-library-hit").first().click();
    await page.getByRole("complementary", {name:"Source metadata"}).waitFor();
    await page.locator(".key-search-session").waitFor();
    await page.screenshot({path:path.join(temp,"live-search-preview.png")});
    let pdf;
    for (let i = 0; i < 100; i++) {
      pdf = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (pdf) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(pdf);
    await pdf.waitForFunction(() => window.__PDFJS_FEATURES_READY__, {
      timeout: 60000,
    });
    const next=page.getByRole("button", {name:"Next result",exact:true});
    await page.waitForFunction(async()=>!(await window.key.tabs()).searchPreview.busy);
    if(await next.isEnabled()) {
      await next.click();
      await page.waitForFunction(async()=>!(await window.key.tabs()).searchPreview.busy);
      await page.getByRole("button", {name:"Previous result",exact:true}).click();
      await page.waitForFunction(async()=>!(await window.key.tabs()).searchPreview.busy);
    }
    await page.getByRole("button", {name:"Dismiss search navigation",exact:true}).click();
    await page
      .getByRole("textbox", { name: "Search passages", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Search passages", exact: true })
        .inputValue(),
      "Select this sentence",
    );
    const result = {
      passed: true,
      readerNavigation: true,
      properties: meta.properties,
      screenshots: [
        path.join(temp, "attributes.png"),
        path.join(temp, "live-search-preview.png"),
      ],
    };
    await writeFile(
      path.join(temp, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e, temp);
    const page = app.windows()[0];
    if (page) {
      await page
        .screenshot({ path: path.join(temp, "failure.png") })
        .catch(() => {});
      console.error(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
    }
    throw e;
  } finally {
    await app.evaluate(({app}) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(() => {
  process.exitCode = 1;
});
