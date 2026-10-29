const {_electron:electron}=require('playwright-core');
const {mkdtemp,readFile,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'key-search-preview-'));
 const bytes=await readFile(path.resolve(__dirname,'../../../../../tests/fixtures/interaction.pdf'));
 const files=[path.join(temp,'First results.pdf'),path.join(temp,'Second results.pdf')];
 await writeFile(files[0],bytes);await writeFile(files[1],Buffer.concat([bytes,Buffer.from('\n% second valid fixture\n')]));
 const app=await electron.launch({executablePath:process.env.KEY_ELECTRON_EXECUTABLE,args:process.env.KEY_ELECTRON_EXECUTABLE?[]:[path.resolve(__dirname,'..')],env:{...process.env,KEY_USER_DATA:path.join(temp,'profile'),KEY_WORKSPACE_PARENT:path.join(temp,'workspaces')}});
 try{
  const page=await app.firstWindow();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.getByRole('button',{name:'Browse all sources',exact:true}).click();
  await page.getByRole('heading',{name:'All sources',exact:true}).waitFor({timeout:60000});
  const ws=(await page.evaluate(()=>window.key.workspaces()))[0];
  const sources=await page.evaluate(async({files,id})=>{const output=[];for(const path of files){const s=await window.key.invoke('library_import_file',{path},id);await window.key.invoke('begin_pdfjs_companion_managed',{hash:s.hash},id);output.push(s);}return output;},{files,id:ws.id});
  for(let i=0;i<90;i++){const hits=await page.evaluate(id=>window.key.invoke('global_search_page',{query:'Select this sentence',filter:{},cursor:null},id),ws.id);if(new Set(hits.hits.map(h=>h.documentHash)).size===2)break;if(i===89)throw Error('Both fixtures must finish keyword indexing');await new Promise(r=>setTimeout(r,500));}
  await page.getByRole('button',{name:'Workspace',exact:true}).click();await page.locator(`[data-workspace-id="${ws.id}"]`).click();
  await page.getByRole('textbox',{name:'Search passages',exact:true}).fill('Select this sentence');
  await page.locator('.key-library-hit').first().waitFor();await page.locator('.key-library-hit').first().click();
  await page.locator('.key-search-session').waitFor();
  await page.waitForFunction(async()=>{const s=(await window.key.tabs()).searchPreview;return !!s?.previewViewId && !s.busy;});
  let state=await page.evaluate(()=>window.key.tabs());const group=state.tabs.find(t=>t.id===state.activeTabId);assert.equal(group.views.length,2);
  const first=state.searchPreview;const tabCount=state.tabs.length;
  await page.getByRole('complementary',{name:'Source metadata'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Search passages',exact:true}).inputValue(),'Select this sentence');
  const nav=await page.locator('.key-search-session').boundingBox();const sourcePane=await page.locator(`[data-content-view="${first.sourceViewId}"]`).boundingBox();
  const native=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.getVisible?.()).map(v=>v.getBounds()));
  assert.equal(nav.y,40);assert.equal(nav.height,40);assert.equal(sourcePane.y,80);assert.equal(native[0].y,80);assert(nav.width>sourcePane.width*1.8);
  const initialHash=first.hit.documentHash;
  for(let i=0;i<first.total;i++){
    await page.getByRole('button',{name:'Next result',exact:true}).click();
    await page.waitForFunction(async()=>!(await window.key.tabs()).searchPreview.busy);
    state=await page.evaluate(()=>window.key.tabs());if(state.searchPreview.hit.documentHash!==initialHash)break;
  }
  assert.notEqual(state.searchPreview.hit.documentHash,initialHash);assert.equal(state.tabs.length,tabCount);
  const after=state.tabs.find(t=>t.id===group.id);assert.equal(after.views.length,2);assert(after.views.some(v=>v.id===first.sourceViewId));assert(!state.tabs.flatMap(t=>t.views).some(v=>v.id===first.previewViewId));
  let pdf;for(let i=0;i<100;i++){pdf=app.windows().find(w=>w.url().endsWith('/pdf.html'));if(pdf)break;await new Promise(r=>setTimeout(r,100));}
  assert(pdf);await pdf.waitForFunction(()=>window.__PDFJS_FEATURES_READY__);assert.equal(await pdf.locator('.key-pdf-target').count(),0);
  await page.waitForFunction(()=>{const hit=document.querySelector('.key-library-hit[aria-current=true]');const scroll=hit?.closest('.key-library-scroll');if(!hit||!scroll)return false;const a=hit.getBoundingClientRect(),b=scroll.getBoundingClientRect();return a.top>=b.top-2 && a.bottom<=b.bottom+2;});
  const queryBox=await page.getByRole('textbox',{name:'Search passages',exact:true}).boundingBox();
  const metadataBox=await page.getByRole('complementary',{name:'Source metadata'}).boundingBox();
  assert(queryBox && queryBox.y>=80 && queryBox.y+queryBox.height<sourcePane.y+sourcePane.height, 'Query remains visible after navigating');
  assert(metadataBox && metadataBox.y>=80 && metadataBox.width>sourcePane.width-10, 'Compact metadata stays above results');
  const editBox=await page.getByRole('complementary',{name:'Source metadata'}).getByRole('button',{name:'Edit source properties',exact:true}).boundingBox();
  assert(editBox && editBox.y+editBox.height<=metadataBox.y+metadataBox.height+1, 'Compact metadata actions are not clipped');
  assert(await page.locator('.key-library-scroll:visible').evaluate(el=>el.scrollHeight>el.clientHeight), 'Results have their own scroll boundary');
  await page.screenshot({path:path.join(temp,'shared-navigation.png')});await pdf.screenshot({path:path.join(temp,'preview-document.png')});
  const currentIds=after.views.map(v=>v.id);
  await page.getByRole('button',{name:'Dismiss search navigation',exact:true}).click();await page.locator('.key-search-session').waitFor({state:'hidden'});
  state=await page.evaluate(()=>window.key.tabs());assert.deepEqual(state.tabs.find(t=>t.id===group.id).views.map(v=>v.id),currentIds);
  assert.equal(await page.getByRole('textbox',{name:'Search passages',exact:true}).inputValue(),'Select this sentence');assert(await page.locator('.key-library-hit').count()>0);
  const bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.getVisible?.()).map(v=>v.getBounds()));assert.equal(bounds[0].y,40);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,temp,tabCount,native,queryRetained:true,previewReplaced:true}));
 }catch(e){console.error('Artifacts',temp);for(const w of app.windows())if(w.url().endsWith('/index.html'))await w.screenshot({path:path.join(temp,'failure.png')}).catch(()=>{});throw e;}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1});
