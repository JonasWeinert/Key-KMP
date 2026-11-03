// Panes of a split close one at a time, from their header or their chip in the tab strip,
// with middle-click or Delete; the last pane closes the tab. Panes move by their header:
// to another pane's edge, into the tab bar as a tab of their own, or past a neighbour from
// the keyboard. Pinned tabs sit first and survive Close Other Tabs.
const {_electron:electron}=require('playwright-core');
const {mkdtemp,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const PANE_HEADER=26;
(async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'key-tab-panes-'));
 const app=await electron.launch({executablePath:process.env.KEY_ELECTRON_EXECUTABLE,args:process.env.KEY_ELECTRON_EXECUTABLE?[]:[path.resolve(__dirname,'..')],env:{...process.env,KEY_SKIP_ONBOARDING:'1',KEY_USER_DATA:path.join(temp,'profile'),KEY_WORKSPACE_PARENT:path.join(temp,'workspaces')}});
 try {
  const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.waitForFunction(()=>window.key);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.evaluate(async file=>{
   const [w]=await window.key.workspaces();
   const pdf=await window.key.invoke('library_import_file',{path:file},w.id);
   await window.key.openSource({...pdf,documentHash:pdf.hash,workspaceId:w.id});
   for(const title of ['Pane One','Pane Two','Pane Three','Pane Four']){
    const record=await window.key.invoke('workspace_save_record',{id:null,kind:'note',title,properties:{},body:'Body of '+title,expectedRevision:null},w.id);
    await window.key.tabAction('open-content',{section:'record',workspaceId:w.id,record});
   }
  },path.resolve(__dirname,'../../../../../tests/fixtures/interaction.pdf'));
  const tabs=()=>page.evaluate(()=>window.key.tabs());
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const until=async(check,label)=>{for(let i=0;i<100;i++){if(await check(await tabs()))return tabs();await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+label+' '+JSON.stringify((await tabs()).tabs.map(t=>t.views.map(v=>v.title))));};
  const viewOf=(state,title)=>state.tabs.flatMap(t=>t.views).find(v=>v.title===title||(title==='pdf'&&v.kind==='pdf')).id;
  const tabOf=(state,id)=>state.tabs.find(t=>t.views.some(v=>v.id===id));
  let state=await tabs();
  const [one,two,three,four,pdf]=['Pane One','Pane Two','Pane Three','Pane Four','pdf'].map(t=>viewOf(state,t));
  const drop=d=>page.evaluate(d=>window.key.tabAction('drop-view',d),d);
  // pdf | one | two, one tab.
  await drop({kind:'split',viewId:one,targetTabId:tabOf(state,pdf).id,targetViewId:pdf,edge:'right'});
  state=await tabs();
  await drop({kind:'split',viewId:two,targetTabId:tabOf(state,pdf).id,targetViewId:one,edge:'right'});
  state=await until(s=>tabOf(s,pdf).views.length===3,'three panes');
  const group=tabOf(state,pdf).id;
  await page.evaluate(tabId=>window.key.tabAction('activate',{tabId}),group);await settle();
  // Every pane has a header with a close button; content starts below it, native views too.
  await page.locator('.key-pane-header').nth(2).waitFor();
  assert.equal(await page.locator('.key-pane-header').count(),3);
  assert.equal(await page.locator('.key-pane-header .key-pane-close').count(),3);
  const header=id=>page.locator(`[data-pane-header="${id}"]`);
  const oneHeader=await header(one).boundingBox(),oneBody=await page.locator(`[data-content-view="${one}"]`).boundingBox();
  assert(Math.abs(oneBody.y-(oneHeader.y+oneHeader.height))<=1,`note below its header: ${JSON.stringify({oneHeader,oneBody})}`);
  const readerBounds=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL().endsWith('/pdf.html')).getBounds());
  const pdfHeader=await header(pdf).boundingBox();
  assert.equal((await readerBounds()).y,Math.round(pdfHeader.y)+PANE_HEADER,'native reader below its header');
  await page.screenshot({path:path.join(temp,'pane-headers.png')});
  // Close the middle pane from its header: the others stay, in order, in the same tab.
  await header(one).hover();await header(one).locator('.key-pane-close').click();
  state=await until(s=>tabOf(s,pdf).views.length===2,'header close');
  assert.equal(tabOf(state,pdf).id,group);
  assert.deepEqual(tabOf(state,pdf).views.map(v=>v.id),[pdf,two]);
  assert(!state.tabs.some(t=>t.views.some(v=>v.id===one)),'the closed pane is gone');
  // Close a pane from its chip in the tab strip: the group becomes a single tab.
  const chip=id=>page.locator(`[data-tab-id="${group}"] [data-view-id="${id}"]`);
  await chip(two).hover();await chip(two).locator('.tab-pane-close').click();
  state=await until(s=>tabOf(s,pdf).views.length===1,'chip close');
  assert.equal(tabOf(state,pdf).id,group);
  assert.equal(await page.locator('.key-pane-header').count(),0,'no headers without a split');
  const full=await readerBounds();
  assert.equal(full.y,40,'a single pane fills the content again');
  // Delete on a focused chip and middle-click on a chip close that pane.
  await drop({kind:'split',viewId:three,targetTabId:group,targetViewId:pdf,edge:'right'});
  state=await until(s=>tabOf(s,pdf).views.length===2,'re-split');
  await chip(three).focus();await page.keyboard.press('Delete');
  state=await until(s=>tabOf(s,pdf).views.length===1,'Delete on chip');
  assert(!state.tabs.some(t=>t.views.some(v=>v.id===three)));
  // Header drags: pdf | four, then four's header onto the reader's left edge swaps sides.
  await drop({kind:'split',viewId:four,targetTabId:group,targetViewId:pdf,edge:'right'});
  state=await until(s=>tabOf(s,pdf).views.length===2,'pdf | four');
  await page.evaluate(tabId=>window.key.tabAction('activate',{tabId}),group);
  await header(four).waitFor();
  let box=await header(four).boundingBox();let reader=await readerBounds();
  await page.mouse.move(box.x+40,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(reader.x+20,reader.y+reader.height/2,{steps:14});
  await page.getByRole('status').filter({hasText:'Release to split left of'}).waitFor();
  await page.locator('.key-pane-drop-preview').waitFor();
  await page.locator('.key-native-overlay-frame').first().waitFor();
  await page.screenshot({path:path.join(temp,'header-drag.png')});
  await page.mouse.up();
  state=await until(s=>tabOf(s,pdf).views[0].id===four,'header drag to edge');
  assert.deepEqual(tabOf(state,pdf).layout,{split:'row',ratio:.5,a:{view:four},b:{view:pdf}});
  assert.equal(await page.locator('.key-native-overlay-frame').count(),0,'frames go when the drag ends');
  // Escape cancels a header drag.
  box=await header(four).boundingBox();reader=await readerBounds();
  await page.mouse.move(box.x+40,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(reader.x+reader.width-20,reader.y+reader.height/2,{steps:10});
  await page.getByRole('status').filter({hasText:'Release to split'}).waitFor();
  await page.keyboard.press('Escape');await page.mouse.up();await settle();
  assert.deepEqual(tabOf(await tabs(),pdf).layout,{split:'row',ratio:.5,a:{view:four},b:{view:pdf}});
  // Keyboard: move the focused pane past its neighbour (View › Move Pane).
  await page.evaluate(viewId=>window.key.tabAction('move-pane',{viewId,direction:'right'}),four);
  state=await until(s=>tabOf(s,pdf).views[1].id===four,'move pane right');
  assert.equal(state.activeViewId,four,'focus follows the moved pane');
  // A header dragged up into the tab bar becomes a tab of its own at the marker.
  box=await header(four).boundingBox();
  const first=await page.locator('.tab-strip .tab-item').first().boundingBox();
  await page.mouse.move(box.x+40,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(first.x+4,first.y+first.height/2,{steps:12});
  await page.getByRole('status').filter({hasText:'tab of its own'}).waitFor();
  await page.locator('.key-tab-insert-marker').waitFor();
  await page.mouse.up();
  state=await until(s=>s.tabs[0].views.length===1&&s.tabs[0].views[0].id===four,'header into tab bar');
  assert.equal(tabOf(state,pdf).views.length,1);
  // Pinned tabs sit first, show no close button, and survive Close Other Tabs.
  const reading=tabOf(state,pdf).id;
  await page.evaluate(tabId=>window.key.tabAction('pin',{tabId,pinned:true}),reading);
  state=await until(s=>s.tabs[0].id===reading&&s.tabs[0].pinned,'pinned first');
  await page.locator(`[data-tab-id="${reading}"].tab-pinned`).waitFor();
  assert.equal(await page.locator(`[data-tab-id="${reading}"] .tab-close`).count(),0);
  // Middle-click closes a tab.
  const fourTab=tabOf(state,four).id;
  await page.locator(`[data-tab-id="${fourTab}"]`).click({button:'middle'});
  state=await until(s=>!s.tabs.some(t=>t.id===fourTab),'middle-click close');
  const before=state.tabs.length;
  assert(before>=2,'more tabs to close');
  const keep=state.tabs.find(t=>!t.pinned).id;
  await page.evaluate(tabId=>window.key.tabAction('close-tabs',{tabId,which:'others'}),keep);
  state=await until(s=>s.tabs.length===2,'close others');
  assert.deepEqual(state.tabs.map(t=>t.id),[reading,keep]);
  assert.deepEqual(errors,[]);
  const report={ok:true,temp,verified:['pane headers with close','content and native views below headers','close a pane from its header','close a pane from its strip chip','Delete on a chip','header drag to a pane edge','Escape cancels a header drag','move pane from the keyboard','header dragged into the tab bar','pinned tab first without close','middle-click closes a tab','close other tabs keeps pinned']};
  await writeFile(path.join(temp,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await app.evaluate(({app})=>app.exit(0));}
})().catch(error=>{console.error(error);process.exitCode=1});
