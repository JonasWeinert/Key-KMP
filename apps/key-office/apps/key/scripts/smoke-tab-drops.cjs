const {_electron:electron}=require('playwright-core');
const {mkdtemp,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'key-tab-drops-'));
 const app=await electron.launch({executablePath:process.env.KEY_ELECTRON_EXECUTABLE,args:process.env.KEY_ELECTRON_EXECUTABLE?[]:[path.resolve(__dirname,'..')],env:{...process.env,KEY_USER_DATA:path.join(temp,'profile'),KEY_WORKSPACE_PARENT:path.join(temp,'workspaces')}});
 try {
  const page=await app.firstWindow();await page.waitForFunction(()=>window.key);
  await page.evaluate(async file=>{
   const [w]=await window.key.workspaces();
   const pdf=await window.key.invoke('library_import_file',{path:file},w.id);
   await window.key.openSource({...pdf,documentHash:pdf.hash,workspaceId:w.id});
   for(const title of ['Drag note Alpha','Drag note Beta']){
    const record=await window.key.invoke('workspace_save_record',{id:null,kind:'note',title,properties:{},body:'Distinct note body: '+title,expectedRevision:null},w.id);
    await window.key.tabAction('open-content',{section:'record',workspaceId:w.id,record});
   }
  },path.resolve(__dirname,'../../../../../tests/fixtures/interaction.pdf'));
  const initial=await page.evaluate(()=>window.key.tabs());
  const allIds=initial.tabs.flatMap(t=>t.views.map(v=>v.id)).sort();
  const alpha=initial.tabs.find(t=>t.views.some(v=>v.title==='Drag note Alpha'));
  const beta=initial.tabs.find(t=>t.views.some(v=>v.title==='Drag note Beta'));
  const pdf=initial.tabs.find(t=>t.views.some(v=>v.kind==='pdf'));
  assert(alpha&&beta&&pdf);
  const a=alpha.views[0].id,b=beta.views[0].id,pdfId=pdf.views[0].id;
  const evidence=[];
  const tab=id=>page.locator(`[data-tab-id="${id}"]`);
  const pane=id=>page.locator(`[data-view-id="${id}"]`);
  async function settle(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function ownership(){const state=await page.evaluate(()=>window.key.tabs());assert.deepEqual(state.tabs.flatMap(t=>t.views.map(v=>v.id)).sort(),allIds);assert.equal(new Set(state.tabs.flatMap(t=>t.views.map(v=>v.id))).size,allIds.length);assert(state.tabs.every(t=>t.views.length>=1&&t.views.length<=2));return state;}
  async function drag(from,to,expected){
   await from.focus();await settle();const start=await from.boundingBox(),end=await to.boundingBox();assert(start&&end);
   await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
   await page.mouse.move(end.x+end.width/2,end.y+end.height/2,{steps:14});
   await page.getByRole('status').filter({hasText:expected}).waitFor();
   if(expected.includes('swap')) {
     const outlined=page.locator('.pane-drop-swap');
     assert.equal(await outlined.getAttribute('data-view-id'),await to.getAttribute('data-view-id'));
     const rect=await outlined.boundingBox();
     assert(end.x+end.width/2>=rect.x && end.x+end.width/2<=rect.x+rect.width,`Swap target moved away from pointer: pointer=${end.x+end.width/2}, rect=${JSON.stringify(rect)}`);
   }
   if(evidence.length===0) {
     const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
     await writeFile(path.join(temp,'drop-feedback.png'),Buffer.from(png,'base64'));
     assert.equal(await page.locator('.tab-drop-feedback').count(),1,'Native capture must not cancel pointer capture');
   }
   evidence.push({action:expected,feedback:await page.locator('.tab-drop-feedback').innerText(),splitTargets:await page.locator('.tab-drop-split').count(),swapTargets:await page.locator('.pane-drop-swap').count()});
  }
  // Fast pass through a centre remains a reorder; grouping needs a deliberate hold.
  await tab(alpha.id).focus();await settle();
  const quickFrom=await tab(alpha.id).boundingBox(),quickTo=await tab(beta.id).boundingBox();
  await page.mouse.move(quickFrom.x+quickFrom.width/2,quickFrom.y+quickFrom.height/2);await page.mouse.down();
  await page.mouse.move(quickTo.x+quickTo.width/2,quickTo.y+quickTo.height/2,{steps:2});await page.mouse.up();await settle();
  assert.equal(await page.locator('.tab-split-pane').count(),0);await ownership();
  await drag(tab(alpha.id),tab(beta.id),'Release to split');
  assert.equal(await page.locator('.tab-drop-split').count(),1);
  await page.mouse.up();await page.waitForFunction(id=>document.querySelectorAll(`[data-tab-id="${id}"] .tab-split-pane`).length===2,beta.id);
  let state=await ownership();assert.deepEqual(state.tabs.find(t=>t.id===beta.id).views.map(v=>v.id),[b,a]);
  // Cancel an armed swap; no ownership or active split order may change.
  await drag(tab(pdf.id),pane(a),'Release to swap');
  assert.equal(await page.locator('.pane-drop-swap').count(),1);
  await page.keyboard.press('Escape');await page.mouse.up();await settle();
  state=await ownership();assert.deepEqual(state.tabs.find(t=>t.id===beta.id).views.map(v=>v.id),[b,a]);
  assert.equal(await page.locator('.tab-drop-feedback').count(),0);
  // Swap the PDF singleton into the selected right half. The displaced note
  // inherits the PDF's former singleton slot instead of disappearing.
  await drag(tab(pdf.id),pane(a),'Release to swap');await page.mouse.up();
  await page.waitForFunction(id=>!!document.querySelector(`[data-view-id="${id}"]`),pdfId);
  state=await ownership();assert.deepEqual(state.tabs.find(t=>t.id===beta.id).views.map(v=>v.id),[b,pdfId]);assert.equal(state.tabs.find(t=>t.id===pdf.id).views[0].id,a);
  // Pull the note across the native PDF WebContentsView, not merely a DOM note.
  const pdfPage=app.windows().find(p=>p.url().endsWith('/pdf.html'));
  await pdfPage.waitForFunction(()=>window.__PDFJS_READY__===true);
  const pdfBounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL().endsWith('/pdf.html')).getBounds());
  await pane(b).focus();const start=await pane(b).boundingBox();
  await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();await page.mouse.move(pdfBounds.x+pdfBounds.width/2,pdfBounds.y+Math.min(100,pdfBounds.height/2),{steps:12});
  await page.getByRole('status').filter({hasText:'Release to separate'}).waitFor();await page.mouse.up();
  await page.waitForFunction(()=>document.querySelectorAll('.tab-split-pane').length===0);
  state=await ownership();assert.equal(state.tabs.find(t=>t.id===beta.id).views[0].id,pdfId);assert(state.tabs.some(t=>t.views.length===1&&t.views[0].id===b));
  await page.screenshot({path:path.join(temp,'detached.png')});
  // Keyboard fallback: create one split, focus its pane, then detach it.
  const noteOwner=state.tabs.find(t=>t.views[0].id===b);
  await drag(tab(noteOwner.id),tab(beta.id),'Release to split');await page.mouse.up();await pane(b).waitFor();await pane(b).focus();await page.keyboard.press('Alt+Shift+ArrowDown');
  await page.waitForFunction(()=>document.querySelectorAll('.tab-split-pane').length===0);await ownership();
  const report={ok:true,temp,evidence,ownedViews:allIds.length,verified:['quick centre pass reorders','singleton split','armed swap cancellation','selected-half swap','vertical pane detach','keyboard detach']};
  await writeFile(path.join(temp,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await app.evaluate(({app})=>app.exit(0));}
})().catch(error=>{console.error(error);process.exitCode=1});
