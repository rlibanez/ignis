// Run after node build.js. Uses a fresh Chrome profile and synthetic API data.
// node scripts/check-management-ui.mjs [--mobile]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
const repo=fileURLToPath(new URL('../',import.meta.url));
const chrome=process.env.IGNIS_CHROME_PATH || '/opt/google/chrome/chrome';
const mobile=process.argv.includes('--mobile');
const screenshotDirectory=process.env.IGNIS_UI_SCREENSHOTS;
const nativeCss=process.env.IGNIS_OBSIDIAN_CSS;
(async()=>{
 const requests=[],errors=[];let hasLocalPassword=true;
 const server=http.createServer((req,res)=>{
  requests.push(req.url);res.setHeader('Content-Type','application/json');
  const json=value=>res.end(JSON.stringify(value));
  if(req.url==='/native.css' && nativeCss){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(nativeCss));}
  if(req.url==='/overrides.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(repo+'/apps/ignis-server/server/assets/overrides.css'));}
  if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(repo+'/packages/ui/dist/ignis-ui.js'));}
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<!doctype html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${nativeCss?'<link rel="stylesheet" href="/native.css">':''}<link rel="stylesheet" href="/overrides.css"></head><body class="theme-dark"><script>window.__ignisAuth={role:'admin',logout(){}};window.__ignis_registerUI=()=>{};</script><script src="/bundle.js"></script></body>`);}
  if(req.url==='/api/auth/session')return json({sessionId:'s',user:{id:'a',login:'alice',role:'admin'},email:'a@example.com',emailTrust:'unverified',hasLocalPassword,oidcLinked:true,passwordPolicy:{minLength:8,minSpecialChars:0},recentAuthentication:true});
  if(req.url==='/api/auth/status')return json({initialized:true,oidcAvailable:true,oidcButtonText:'Provider',passwordPolicy:{minLength:8,minSpecialChars:0}});
  if(req.url==='/api/auth/users')return json({users:[],hasLocalPassword,oidcAvailable:true,passwordPolicy:{minLength:8,minSpecialChars:0}});
  if(req.url==='/api/shares')return json({resources:[],ownedVaults:[],destinationVaults:[]});
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
  await call('Runtime.enable');if(mobile)await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
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
  await run(`document.querySelector('[data-ignis-close]').click();IgnisUI.openAccount('shares');`);await new Promise(r=>setTimeout(r,250));
  await screenshot('shares');
  if(!await run(`!document.querySelector('#workspace').hidden`))throw Error('Shares failed: '+await run('document.body.innerText'));
  await run(`document.querySelector('[data-ignis-close]').click()`);hasLocalPassword=false;
  await run(`IgnisUI.openAccount('password');`);await new Promise(r=>setTimeout(r,250));
  if(!await run(`document.querySelector('#password-dialog').open`))throw Error('Password return failed: '+await run('document.body.innerText'));
  if(requests.some(url=>['/account','/shares','/admin/users'].includes(url)))throw Error('Standalone page requested');
  if(errors.length)throw Error('Runtime errors: '+errors);
  console.log(`PASS (${mobile?'mobile':'desktop'}): zero-vault account, email, users, sharing and OIDC password setup; no standalone HTML fetches or runtime errors`);
 }finally{ws?.close();child.kill('SIGTERM');server.closeAllConnections();server.close();setTimeout(()=>fs.rmSync(dir,{recursive:true,force:true}),1000).unref();}
})().catch(error=>{console.error(error);process.exitCode=1;});
