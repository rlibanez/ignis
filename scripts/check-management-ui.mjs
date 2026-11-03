// Run after node build.js. Uses a fresh Chrome profile and synthetic API data.
// node scripts/check-management-ui.mjs [--mobile]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {build} from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
const repo=fileURLToPath(new URL('../',import.meta.url));
const chrome=process.env.IGNIS_CHROME_PATH || '/opt/google/chrome/chrome';
const mobile=process.argv.includes('--mobile');
const viewport=process.argv.includes('--landscape')?[844,390]:process.argv.includes('--compact')?[360,800]:[390,844];
const screenshotDirectory=process.env.IGNIS_UI_SCREENSHOTS;
const nativeCss=process.env.IGNIS_OBSIDIAN_CSS;
(async()=>{
 const harness=await build({stdin:{contents:`import {BrowserModal} from './packages/ui/src/management.js';import {createManagementModal} from './packages/management/src/management-modal.js';const ResourceModal=createManagementModal(BrowserModal,(target)=>{target.textContent='×';});window.testIndividualResource=()=>new ResourceModal(null,'shares',{initialResource:{id:'r',session:'s'}}).open();`,resolveDir:repo},bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'text'},mainFields:['svelte','browser','module','main'],conditions:['svelte','browser'],plugins:[sveltePlugin({compilerOptions:{}})],logLevel:'silent'});
 const requests=[],errors=[];let hasLocalPassword=true;
 const server=http.createServer((req,res)=>{
  requests.push(req.url);res.setHeader('Content-Type','application/json');
  const json=value=>res.end(JSON.stringify(value));
  if(req.url==='/native.css' && nativeCss){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(nativeCss));}
  if(req.url==='/overrides.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(repo+'/apps/ignis-server/server/assets/overrides.css'));}
  if(req.url==='/test-harness.js'){res.setHeader('Content-Type','text/javascript');return res.end(harness.outputFiles[0].text);}
  if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(repo+'/packages/ui/dist/ignis-ui.js'));}
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<!doctype html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${nativeCss?'<link rel="stylesheet" href="/native.css">':''}<link rel="stylesheet" href="/overrides.css"></head><body class="theme-dark"><script>${mobile?"document.body.classList.add('is-mobile','is-phone');":''}window.__ignisAuth={role:'admin',logout(){}};window.__ignis_registerUI=()=>{};</script><script src="/bundle.js"></script><script src="/test-harness.js"></script></body>`);}
  if(req.url==='/api/auth/session')return json({sessionId:'s',user:{id:'a',login:'alice',role:'admin'},email:'a@example.com',emailTrust:'unverified',hasLocalPassword,oidcLinked:true,passwordPolicy:{minLength:8,minSpecialChars:0},recentAuthentication:true});
  if(req.url==='/api/auth/status')return json({initialized:true,oidcAvailable:true,oidcButtonText:'Provider',passwordPolicy:{minLength:8,minSpecialChars:0}});
  if(req.url==='/api/auth/users' && req.method==='POST'){res.statusCode=400;return json({error:'Invalid user'});}
  if(req.url==='/api/auth/users')return json({users:[{id:'b',login:'bob',role:'user',status:'active',hasLocalPassword:true,email:null,email_trust:'unverified'}],hasLocalPassword,oidcAvailable:true,passwordPolicy:{minLength:8,minSpecialChars:0}});
  if(req.url==='/api/shares' && req.method==='POST'){res.statusCode=400;return json({error:'Invalid shared resource or recipient.'});}
  if(req.url==='/api/shares')return json({resources:[{id:'r',name:'Note.md',owned:true,available:true,kind:'file',vault:'v',path:'Note.md',revision:1,grants:[{login:'bob',role:'reader'}]}],ownedVaults:[{id:'v',name:'Main'}],destinationVaults:[{id:'v',name:'Main'}]});
  if(req.url==='/api/auth/csrf')return json({csrfToken:'csrf'});
  res.statusCode=404;json({error:'missing'});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-management-chrome-'));
 const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+dir,'about:blank'],{stdio:'ignore'});
 let ws;
 try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(dir,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await new Promise(r=>setTimeout(r,100));}
  if(!port)throw Error('Chrome did not start');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));
  let id=0;const waiting=new Map();ws.on('message',raw=>{const data=JSON.parse(raw);if(data.id){waiting.get(data.id)?.(data);waiting.delete(data.id);}if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const i=++id;waiting.set(i,result=>result.error?reject(Error(JSON.stringify(result.error))):resolve(result.result));ws.send(JSON.stringify({id:i,method,params}));});
  const run=async expression=>{const data=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(data.exceptionDetails)throw Error(data.exceptionDetails.exception?.description||data.exceptionDetails.text);return data.result.value;};
  await call('Runtime.enable');if(mobile)await call('Emulation.setDeviceMetricsOverride',{width:viewport[0],height:viewport[1],deviceScaleFactor:1,mobile:true});await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  for(let i=0;i<100;i++){if(await run('typeof window.IgnisUI?.openAccount === "function"'))break;await new Promise(r=>setTimeout(r,100));}
  if(errors.length)throw Error(errors.join('\n'));await run(`IgnisUI.openAccount();`);await new Promise(r=>setTimeout(r,250));
  const screenshot=async name=>{
    if(!screenshotDirectory)return;
    fs.mkdirSync(screenshotDirectory,{recursive:true});
    const {data}=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(screenshotDirectory,`${mobile?'mobile':'desktop'}-${name}.png`),Buffer.from(data,'base64'));
  };
  await screenshot('account');
  const rows=await run(`Array.from(document.querySelectorAll('.setting-item-name'),e=>e.textContent)`);
  if(rows.join('|')!=='Username|Email|Change password|OpenID Connect|Manage users|Shared resources')throw Error('Account rows: '+rows);
  const accountTabs=await run(`Array.from(document.querySelectorAll('.ignis-shell-settings [role=tab]'),el=>el.textContent)`);
  if(accountTabs.join('|')!=='Account')throw Error('Only the Account settings entry should exist: '+accountTabs);
  await run(`{const search=document.querySelector('.ignis-shell-settings input[type=search]');search.value='email';search.dispatchEvent(new Event('input'));}`);
  if(await run(`document.querySelectorAll('.ignis-shell-settings .setting-item:not([hidden])').length`)!==1)throw Error('Settings search did not filter account rows');
  await run(`{const search=document.querySelector('.ignis-shell-settings input[type=search]');search.value='';search.dispatchEvent(new Event('input'));}`);
  if(mobile){
    await run(`document.querySelector('.ignis-shell-settings .mod-start').click()`);
    if(!await run(`getComputedStyle(document.querySelector('.vertical-tab-header')).display!=='none'`))throw Error('Mobile settings navigation did not open');
    await screenshot('settings-navigation');
    if(!await run(`document.querySelector('.setting-search-container').getBoundingClientRect().top>=document.querySelector('.ignis-shell-settings>.modal-header').getBoundingClientRect().bottom-1`))throw Error('Mobile search overlaps the settings header: '+await run(`JSON.stringify(Array.from(document.querySelectorAll('.ignis-shell-settings>.modal-header,.ignis-shell-settings>.modal-content,.setting-search-container'),el=>({cls:el.className,rect:el.getBoundingClientRect().toJSON(),position:getComputedStyle(el).position,margin:getComputedStyle(el).margin,flex:getComputedStyle(el).flex})))`));
    await run(`document.querySelector('.ignis-shell-settings [role=tab]').click()`);
  }

  await run(`document.querySelectorAll('.setting-item-control button')[1].click()`);
  await screenshot('email');
  if(!await run(`getComputedStyle(document.querySelector('.ignis-shell-modal:last-of-type input[type=password]').closest('label')).display==='none'`))throw Error('Recent-session password field must remain hidden');
  if(await run(`document.querySelectorAll('.ignis-shell-modal').length`)!==2)throw Error('Email form did not open');
  await run(`document.querySelectorAll('.ignis-shell-modal [data-ignis-close]')[1].click();document.querySelector('[data-ignis-close]').click();IgnisUI.openAccount('users');`);await new Promise(r=>setTimeout(r,250));
  await screenshot('users');
  if(!await run(`!document.querySelector('#administration').hidden`))throw Error('Users failed: '+await run('document.body.innerText'));
  await run(`document.querySelector('#add-user').click()`);await new Promise(r=>setTimeout(r,150));
  if(!await run(`document.querySelector('#create-dialog').open`))throw Error('Create user failed');
  await screenshot('create-user');
  await run(`[...document.querySelectorAll('#create-dialog .help-toggle')].at(-1).click()`);
  if(!await run(`!!document.querySelector('#create-dialog .tooltip')`))throw Error('Help was rendered behind the dialog top layer: '+await run(`JSON.stringify({active:document.activeElement?.outerHTML,tips:[...document.querySelectorAll('.tooltip')].map(el=>el.outerHTML),helps:[...document.querySelectorAll('#create-dialog .help-toggle')].map(el=>el.outerHTML)})`));
  if(!await run(`{const rect=document.querySelector('#create-dialog .tooltip').getBoundingClientRect();rect.top>=0 && rect.bottom<=innerHeight}`))throw Error('Help falls outside the viewport');
  await run(`document.querySelector('#cancel-create').click();document.querySelector('#users button[aria-label="Edit bob"]').click()`);await new Promise(r=>setTimeout(r,150));
  if(!await run(`document.querySelector('#edit-dialog').open`))throw Error('Edit user failed');
  await run(`document.querySelector('#revoke-sessions').click()`);
  if(await run(`document.querySelector('#revoke-warning').textContent`)!=='Close all sessions for bob?')throw Error('Session confirmation lost its target');
  await screenshot('confirm-sessions');
  await run(`document.querySelector('#cancel-revoke').click();document.querySelector('#edit-dialog .native-management-close').click()`);
  if(await run(`document.querySelector('#edit-dialog').open`))throw Error('Edit close button failed');
  await run(`document.querySelector('[data-ignis-close]').click();sessionStorage.setItem('ignis-admin-reauth',JSON.stringify({userId:'a',target:'b',deleting:false}));history.replaceState(null,'','/?manage=users&reauth=success');IgnisUI.openRequestedManagement()`);await new Promise(r=>setTimeout(r,250));
  if(!await run(`document.querySelector('#edit-dialog').open && document.querySelector('#edit-user-name').textContent==='bob'`))throw Error('Reauthentication return intent was lost while cleaning the URL');
  await run(`document.querySelector('[data-ignis-close]').click();IgnisUI.openAccount('shares');`);await new Promise(r=>setTimeout(r,250));
  await screenshot('shares');
  if(!await run(`!document.querySelector('#workspace').hidden`))throw Error('Shares failed: '+await run('document.body.innerText'));
  await run(`document.querySelector('#owned button[aria-label="Edit"]').click();document.querySelector('#add-access').click()`);
  const before=await run(`JSON.stringify(document.querySelector('#grant-dialog').getBoundingClientRect().toJSON())`);
  await run(`document.querySelector('#grant-login').value='missing';document.querySelector('#grant-form').requestSubmit()`);await new Promise(r=>setTimeout(r,150));
  if(!await run(`!!document.querySelector('#grant-login').validationMessage`))throw Error('Grant validation was not anchored to the field');
  if(before!==await run(`JSON.stringify(document.querySelector('#grant-dialog').getBoundingClientRect().toJSON())`))throw Error('Field error displaced the form');
  await screenshot('grant-error');
  await run(`document.querySelector('[data-close="grant-dialog"]').click();document.querySelector('[data-close="manage-dialog"]').click()`);
  await run(`document.querySelector('[data-ignis-close]').click()`);hasLocalPassword=false;
  await run(`IgnisUI.openAccount('password');`);await new Promise(r=>setTimeout(r,250));
  if(!await run(`document.querySelector('#password-dialog').open`))throw Error('Password return failed: '+await run('document.body.innerText'));
  await run(`document.querySelector('#cancel-password').click();document.querySelector('[data-ignis-close]').click();testIndividualResource()`);await new Promise(r=>setTimeout(r,200));
  if(!await run(`document.querySelector('#manage-dialog').open && getComputedStyle(document.querySelector('#workspace')).display==='none'`))throw Error('Individual resource exposed a catalog behind it');
  await screenshot('individual-resource');
  await run(`document.querySelector('[data-close="manage-dialog"]').click()`);await new Promise(r=>setTimeout(r,50));
  if(await run(`document.querySelectorAll('.ignis-shell-modal').length`))throw Error('Individual resource did not dispose its host');
  const retained=await run(`(async()=>{const Native=BroadcastChannel,active=new Set();window.BroadcastChannel=class extends Native{constructor(name){super(name);active.add(this);}close(){active.delete(this);super.close();}};try{for(let i=0;i<100;i++){const modal=testIndividualResource();await new Promise(r=>setTimeout(r,0));modal.close();}await new Promise(r=>setTimeout(r,50));return {channels:active.size,modals:document.querySelectorAll('.ignis-shell-modal').length};}finally{window.BroadcastChannel=Native;}})()`);
  if(retained.channels || retained.modals)throw Error('Closing 100 components retained resources: '+JSON.stringify(retained));
  if(requests.some(url=>['/account','/shares','/admin/users'].includes(url)))throw Error('Standalone page requested');
  if(errors.length)throw Error('Runtime errors: '+errors);
  console.log(`PASS (${mobile?'mobile':'desktop'}): zero-vault account, email, users, sharing and OIDC password setup; no standalone HTML fetches or runtime errors`);
 }finally{ws?.close();child.kill('SIGTERM');server.closeAllConnections();server.close();setTimeout(()=>fs.rmSync(dir,{recursive:true,force:true}),1000).unref();}
})().catch(error=>{console.error(error);process.exitCode=1;});
