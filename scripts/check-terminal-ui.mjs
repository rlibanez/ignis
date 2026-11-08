// Security-terminal and persistent recovery views, with installed native CSS.
import assert from 'node:assert/strict';
import fs from 'node:fs';import http from 'node:http';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {build} from 'esbuild';
import {browser} from './lib/chrome.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),web=path.join(repo,'apps/ignis-server/server/auth/web');
const assets=process.env.IGNIS_E2E_OBSIDIAN_ASSETS;
if(!assets)throw Error('Set IGNIS_E2E_OBSIDIAN_ASSETS to privately obtained Obsidian assets');
const harness=await build({stdin:{contents:`import {createSharedNotice} from './packages/shim/src/fs/shared-notice.js';window.makeRecovery=()=>createSharedNotice(()=>({sessionId:'session',vault:'vault'}),window);`,resolveDir:repo},bundle:true,write:false,format:'iife',platform:'browser',logLevel:'silent'});
const requests=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');requests.push(url.pathname);
 const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 if(url.pathname==='/api/auth/session')return json({user:{id:'user',role:'user'},sessionId:'session'});
 if(url.pathname==='/api/auth/csrf')return json({csrfToken:'synthetic'});
 if(url.pathname==='/api/vault/list')return json([]);
 if(url.pathname==='/api/auth/logout'){res.statusCode=503;return json({error:'Unavailable'});}
 if(url.pathname==='/harness.js'){res.setHeader('Content-Type','text/javascript');return res.end(harness.outputFiles[0].text);}
 if(['/auth/native.css','/auth/entry.css','/auth/client.js'].includes(url.pathname)){
  res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(url.pathname==='/auth/native.css'?path.join(assets,'app.css'):path.join(web,path.basename(url.pathname))));
 }
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${url.searchParams.get('native')==='0'?'':'<link id="existing-native-css" rel="stylesheet" href="/auth/native.css">'}</head><body class="theme-${url.searchParams.get('theme')||'dark'}"><div id="editor-marker">Original editor</div><div class="status-bar"></div><script src="/auth/client.js"></script><script src="/harness.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let terminalStates=0,recoveryStates=0;
try{
 for(const [mobile,width,height] of [[false,1280,900],[true,390,844],[true,360,800],[true,844,390]]){
  const client=await browser({mobile});
  try{
   await client.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
   await client.call('Browser.setDownloadBehavior',{behavior:'deny'});
   for(const theme of ['light','dark']){
    await client.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme==='dark'?'light':'dark'}]});
    for(const pending of [false,true]){
     await client.call('Page.navigate',{url:origin+`/?theme=${theme}`});await client.wait(`!!window.__ignisAuth?.sessionId`,'logout fallback host');
     const before=requests.filter(url=>url==='/api/auth/logout').length;
     await client.run(`{window.alert=()=>{throw Error('Browser alert must not be used');};window.__ignis={writes:{snapshotPending:()=>${pending?"[{path:'draft.md',data:'draft'}]":"[]"}}};void 0;}`);
     await client.run(`__ignisAuth.logout()`);await client.wait(`!!document.querySelector('.ignis-boundary-notices .notice')`,'styled logout notice');
     assert.equal(await client.run(`__ignisAuth.blocked`),false);assert.equal(await client.run(`!!document.querySelector('#editor-marker')`),true);
     assert.equal(requests.filter(url=>url==='/api/auth/logout').length,before+(pending?0:1));
     await client.run(`document.querySelector('.ignis-boundary-notices button').click()`);assert.equal(await client.run(`!!document.querySelector('.ignis-boundary-notices')`),false);
    }
    for(const mode of ['session','vault','startup'])for(const pending of [false,true]){
     await client.call('Page.navigate',{url:origin+`/?theme=${theme}&native=${mode==='startup'?0:1}`});
     await client.wait(`!!window.__ignisAuth?.sessionId && !!window.makeRecovery`,'verified client');
     const before=await client.run(`({theme:document.body.className,hasNative:!!document.querySelector('#existing-native-css')})`);
     await client.run(`{window.recoveryBlob=null;const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.recoveryBlob=blob;return create(blob);};window.__ignis={writes:{snapshotPending:()=>${pending?"[{path:'queued.md',data:'queued draft'}]":"[]"}}};window.app={workspace:{iterateAllLeaves:fn=>${pending?"fn({view:{file:{path:'open.md'},editor:{getValue:()=> 'open draft'}}})":"undefined"}}};void 0;}`);
     await client.run(mode==='vault'?`__ignisAuth.vaultUnavailable()`:mode==='startup'?`__ignisAuth.lock('Unable to start Ignis. Sign in again to continue.')`:`__ignisAuth.lock()`);
     await client.wait(`!!document.querySelector('.ignis-lock-panel') && !!getComputedStyle(document.body).getPropertyValue('--font-interface').trim() && getComputedStyle(document.querySelector('.ignis-lock-panel')).width!=='auto'`,'terminal native styles');
     await client.run(`Promise.all([...document.querySelectorAll('link[rel=stylesheet]')].map(link=>link.sheet?Promise.resolve():new Promise(resolve=>{link.onload=resolve;link.onerror=resolve;})))`);
     const layout=await client.run(`(()=>{const panel=document.querySelector('.ignis-lock-panel'),box=panel.getBoundingClientRect(),actions=[...panel.querySelectorAll('.lock-actions > *')],nativeFont=token=>{const probe=document.createElement('span');probe.style.cssText='position:absolute;font-size:var('+token+')';document.body.append(probe);const value=getComputedStyle(probe).fontSize;probe.remove();return value;};return {theme:document.body.classList.contains('theme-${theme}'),font:getComputedStyle(panel.querySelector('h1')).fontSize,nativeTitleFont:nativeFont('--font-ui-large'),nativeControlFont:nativeFont('--font-ui-small'),width:box.width,left:box.left,overflow:document.documentElement.scrollWidth>innerWidth,focused:document.activeElement===panel,buttons:actions.map(el=>({width:el.getBoundingClientRect().width,font:getComputedStyle(el).fontSize})),styles:[...document.querySelectorAll('#ignis-lock-native-css')].length};})()`);
     assert.equal(layout.theme,true,'locking preserves the selected theme over the system theme');assert.equal(layout.focused,true);assert.ok(layout.width<=400&&layout.left>=0);assert.equal(layout.overflow,false);assert.equal(layout.font,layout.nativeTitleFont);assert.ok(layout.buttons.every(button=>button.font===layout.nativeControlFont&&Math.abs(button.width-layout.buttons[0].width)<1));
     assert.equal(layout.styles,before.hasNative?0:1,'installed base CSS is only loaded when missing');
     assert.equal(await client.run(`!!document.querySelector('#editor-marker')`),false,'locked editor DOM is removed');
     assert.equal(await client.run(`__ignisAuth.blocked`),true);
     assert.equal(await client.run(`document.querySelector('.lock-actions a').getAttribute('href')`),mode==='vault'?'/?manager=1':'/login');
     const count=requests.filter(url=>url==='/api/fs/writeFile').length;
     assert.equal(await client.run(`fetch('/api/fs/writeFile',{method:'POST'}).then(()=>false,()=>true)`),true);
     assert.equal(requests.filter(url=>url==='/api/fs/writeFile').length,count,'blocked mutation never reaches the server');
     assert.equal(await client.run(`!!document.querySelector('.lock-actions button')`),pending);
     if(pending){await client.run(`document.querySelector('.lock-actions button').click()`);const data=await client.run(`recoveryBlob.text().then(JSON.parse)`);assert.deepEqual(data.map(file=>file.data),mode==='vault'?['queued draft','open draft']:['queued draft']);}
     if(process.env.IGNIS_UI_SCREENSHOTS&&pending){fs.mkdirSync(process.env.IGNIS_UI_SCREENSHOTS,{recursive:true});const {data}=await client.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(process.env.IGNIS_UI_SCREENSHOTS,`${width}-${theme}-${mode}.png`),Buffer.from(data,'base64'));}
     terminalStates++;
    }
    for(const denied of [false,true]){
     await client.call('Page.navigate',{url:origin+`/?theme=${theme}`});await client.wait(`!!window.makeRecovery && !!__ignisAuth.sessionId`,'recovery host');
     if(mobile)await client.run(`document.body.classList.add('is-mobile','is-phone')`);
     await client.run(`{const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.recoveryBlob=blob;return create(blob);};window.recoveryCase=makeRecovery();recoveryCase.failure({sessionId:'session',vault:'vault',path:'Note.md',content:'pending draft',code:${JSON.stringify(denied?'EACCES':'EIO')},restoreOriginal:()=>{window.didRestore=true;},saveCopy:done=>{window.didCopy=true;done();}});void 0;}`);
     const layout=await client.run(`(()=>{const panel=document.querySelector('.ignis-recovery-notice'),r=panel.getBoundingClientRect(),buttons=[...panel.querySelectorAll('.ignis-recovery-actions button')],ref=document.createElement('button');document.body.append(ref);const native=getComputedStyle(ref),result={width:r.width,left:r.left,top:r.top,bottom:r.bottom,font:getComputedStyle(panel).fontFamily,overflow:panel.scrollWidth>panel.clientWidth+1,nativeRadius:native.borderRadius,nativeShadow:native.boxShadow,buttons:buttons.map(el=>({radius:getComputedStyle(el).borderRadius,shadow:getComputedStyle(el).boxShadow}))};ref.remove();return result;})()`);
     assert.ok(layout.left>=0&&layout.top>=0&&layout.bottom<=height+1);assert.equal(layout.overflow,false);assert.ok(layout.buttons.every(button=>button.radius===layout.nativeRadius&&button.shadow===layout.nativeShadow),'recovery buttons keep native appearance');
     if(process.env.IGNIS_UI_SCREENSHOTS){fs.mkdirSync(process.env.IGNIS_UI_SCREENSHOTS,{recursive:true});const {data}=await client.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(process.env.IGNIS_UI_SCREENSHOTS,`${width}-${theme}-recovery-${denied?'readonly':'failed'}.png`),Buffer.from(data,'base64'));}
     const download=denied?'Download note':'Download recovery copy';await client.run(`[...document.querySelectorAll('.ignis-recovery-actions button')].find(button=>button.textContent===${JSON.stringify(download)}).click()`);
     const downloaded=await client.run(`recoveryBlob.text()`);if(denied)assert.equal(downloaded,'pending draft');else assert.deepEqual(JSON.parse(downloaded),{files:{'Note.md':{content:'pending draft',encoding:'utf8'}}});
     await client.run(`document.querySelector('.ignis-recovery-close').click()`);assert.equal(await client.run(`!!document.querySelector('.ignis-recovery-notice')`),false);
     await client.run(`document.querySelector('.ignis-recovery-toggle').click()`);assert.equal(await client.run(`!!document.querySelector('.ignis-recovery-notice')`),true);
     await client.run(`window.dispatchEvent(new Event('ignis:auth-lost'))`);assert.equal(await client.run(`!!document.querySelector('.ignis-recovery-notice,.ignis-recovery-toggle')`),false);
     recoveryStates++;
    }
   }
   assert.deepEqual(client.errors.filter(error=>typeof error==='string'),[],'no uncaught browser errors');
   console.log(JSON.stringify({terminalUI:'passed',mobile,width,height}));
  }finally{await client.close();}
 }
 console.log(JSON.stringify({terminalStates,recoveryStates,checks:['selected theme','native CSS and controls','responsive geometry','pending writes download','blocked mutations','recovery actions and cleanup']}));
}finally{await new Promise(resolve=>server.close(resolve));}
