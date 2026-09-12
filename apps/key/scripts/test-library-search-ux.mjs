import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
// Real PDF renderer; deterministic IPC. Rust tests exercise the actual database/index.
const bytes=readFileSync(process.argv[2] ?? '../../tests/fixtures/interaction.pdf');
const supplied=process.argv[3] ? JSON.parse(readFileSync(process.argv[3],'utf8')) : null;
const hash=createHash('sha256').update(bytes).digest('hex');
const port=4178;
const server=spawn('npm',['run','preview','--','--host','127.0.0.1','--port',String(port)],{stdio:['ignore','pipe','inherit']});
let browser;
try {
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('preview timeout')),20000);server.stdout.on('data',b=>{if(String(b).includes(String(port))){clearTimeout(t);resolve();}});});
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:920}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(({base64,hash,supplied})=>{
  const calls=[];window.__LIBRARY_CALLS__=calls;
  const doc={documentId:hash,documentHash:hash,title:'Interaction paper',pageCount:supplied?.pages.length ?? 2,status:'indexed',completed:2,total:2,keywordReady:true,authors:['Alice'],year:2024};
  const hits=supplied ? supplied.hits.map(hit=>({...hit,documentId:hash,documentHash:hash,score:1,text:hit.targetText})) : [{id:'passage-1',documentId:hash,documentHash:hash,page:0,text:'Select this sentence',targetText:'Select this sentence',score:1},{id:'passage-2',documentId:hash,documentHash:hash,page:1,text:'Second page',targetText:'Second page',score:.5}];
  const descriptor={id:hash,title:doc.title,pages:supplied?.pages ?? [{index:0,width:612,height:792},{index:1,width:612,height:792}],links:[],toc:[]};
  const snapshot={generation:1,revision:1,stage:'ready',document:descriptor,documentHash:hash,semanticStatus:'indexed',semanticCompleted:2,semanticTotal:2,hasNativeText:false,completedReferences:0,totalReferences:0};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async (cmd,args,options)=>{
    calls.push({cmd,args:args instanceof Uint8Array ? args.byteLength : args});
    if(cmd==='semantic_library')return [doc];
    if(cmd==='global_search_page')return {hits,nextCursor:null,capped:false};
    if(cmd==='resolve_search_target'){const hit=hits.find(h=>h.id===args.id);return {...hit,rects:hit.rects ?? [[5782,22258,32768,1076]]};}
    if(cmd==='library_source_info')return {hash,size:atob(base64).length,title:doc.title};
    if(cmd==='library_source_range')return Uint8Array.from(atob(base64).slice(args.offset,args.offset+args.length),c=>c.charCodeAt(0)).buffer;
    if(cmd==='begin_pdfjs_companion_managed'){if(args.hash!==hash)throw new Error('Bad hash');return snapshot;}
    if(cmd==='pdfjs_companion_snapshot')return snapshot;
    if(cmd==='library_annotations')return [];
    if(cmd==='native_text')throw new Error('Use PDF.js geometry in browser test');
    if(cmd.startsWith('plugin:event|')||cmd==='benchmark_phase'||cmd==='library_prioritize'||cmd==='processing_interaction'||cmd==='native_close'||cmd==='release_disposable_document')return 1;
    throw new Error(`Unexpected IPC: ${cmd}`);
  }};
 },{base64:bytes.toString('base64'),hash,supplied});
 await page.goto(`http://127.0.0.1:${port}/?renderer=pdfjs-workspace`);
 await page.getByRole('textbox',{name:'Search your documents'}).fill('sentence');
 await page.getByRole('textbox',{name:'Author filter'}).fill('Alice');
 await page.getByRole('spinbutton',{name:'Year from',exact:true}).fill('2020');
 await page.getByRole('button',{name:'Search',exact:true}).click();
 await page.locator('.global-search-result').first().click();
 await page.locator('.pdfjs-result-target').first().waitFor({timeout:30000});
 assert.equal(await page.locator('.pdfjs-highlight').count(),0);
 await page.waitForFunction(() => window.__PDFJS_READY__ === true);
 await page.waitForTimeout(700);
 if(supplied) {
  const checks=[];
  for(let i=0;i<supplied.hits.length;i++) {
   await page.getByText(`Page ${supplied.hits[i].page+1}`,{exact:true}).last().waitFor();
   await page.locator('.pdfjs-result-target').first().waitFor();
   await page.waitForTimeout(500);
   const overlap=await page.evaluate(targetText=>{
    const overlay=document.querySelector('.pdfjs-result-target');
    const target=overlay.getBoundingClientRect();
    const runs=[...overlay.closest('.pdfjs-page').querySelectorAll('.pdfjs-text-run')];
    const joined=runs.map(e=>e.textContent).join('');const start=joined.indexOf(targetText);
    if(start<0)return 0;
    let offset=0;const rects=[];
    for(const run of runs){const end=offset+run.textContent.length;if(end>start&&offset<start+targetText.length)rects.push(run.getBoundingClientRect());offset=end;}
    const r={left:Math.min(...rects.map(r=>r.left)),right:Math.max(...rects.map(r=>r.right)),top:Math.min(...rects.map(r=>r.top)),bottom:Math.max(...rects.map(r=>r.bottom))};
    const intersection=Math.max(0,Math.min(r.right,target.right)-Math.max(r.left,target.left))*Math.max(0,Math.min(r.bottom,target.bottom)-Math.max(r.top,target.top));
    return intersection/Math.min((r.right-r.left)*(r.bottom-r.top),target.width*target.height);
   },supplied.hits[i].targetText);
   const screenshot=`/tmp/key-canonical-target-${i+1}.png`;
   await page.screenshot({path:screenshot});
   assert(overlap>.5,`Canonical target page ${i+1} misses rendered text: ${overlap}`);
   checks.push({page:i+1,overlap,screenshot});
   if(i+1<supplied.hits.length)await page.getByRole('button',{name:'Next result',exact:true}).click();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({canonicalTargetChecks:checks},null,2));
 } else {
 await page.screenshot({path:'/tmp/key-library-result.png'});
 await page.getByRole('button',{name:'Next result',exact:true}).click();
 await page.getByText('Page 2',{exact:true}).last().waitFor();
 await page.locator('.pdfjs-result-target').first().waitFor();
 await page.getByRole('button',{name:'Back to results'}).click();
 assert.equal(await page.getByRole('textbox',{name:'Search your documents'}).inputValue(),'sentence');
 assert.equal(await page.getByRole('textbox',{name:'Author filter'}).inputValue(),'Alice');
 await page.locator('.global-search-result').first().click();
 await page.locator('.pdfjs-result-target').first().waitFor();
 const calls=await page.evaluate(()=>window.__LIBRARY_CALLS__);
 assert.equal(calls.filter(c=>c.cmd==='library_source').length,0);
 assert.equal(calls.filter(c=>c.cmd==='library_source_info').length,1);
 assert(calls.some(c=>c.cmd==='library_source_range'));
 assert(calls.filter(c=>c.cmd==='library_source_range').every(c=>c.args.length<=4*1024*1024));
 assert.equal(calls.find(c=>c.cmd==='global_search_page').args.filter.yearFrom,2020);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({boundedRangeReads:true,closedResultReopened:true,highlight:true,nextResult:true,queryAndFiltersPreserved:true,reusedTab:true,screenshot:'/tmp/key-library-result.png'},null,2));
 }
} finally {await browser?.close();server.kill('SIGTERM');}
