import {uiIsolation} from "./lib/ui-isolation.mjs";
// Opt-in real Obsidian E2E. Never writes to or distributes the supplied assets.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';import {browser} from './lib/chrome.mjs';
import {waitForServerStarted} from './lib/server-readiness.mjs';
import {vaultBatchUi} from './lib/vault-batch-ui.mjs';
import {vaultOwnershipUi} from './lib/vault-ownership-ui.mjs';
import {vaultImportUi} from './lib/vault-import-ui.mjs';
import {managementParity} from './lib/management-parity.mjs';
const require=createRequire(import.meta.url),repo=fileURLToPath(new URL('../',import.meta.url));
const assets=process.env.IGNIS_E2E_OBSIDIAN_ASSETS;
if(!assets)throw Error('Set IGNIS_E2E_OBSIDIAN_ASSETS to privately obtained Obsidian 1.14.4 assets');
assert.equal(JSON.parse(fs.readFileSync(path.join(assets,'package.json'))).version,'1.14.4','E2E requires the pinned Obsidian runtime');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-runtime-e2e-')),clients=[];
let child,db;
try{
 const vaultRoot=path.join(root,'vaults');fs.mkdirSync(vaultRoot);
 const {openDatabase}=require('../apps/ignis-server/server/platform/persistence/database');
 const {hashPassword}=require('../apps/ignis-server/server/features/identity/adapters/password');
 const {createRegisteredVault}=require('../apps/ignis-server/server/features/vaults/adapters/vault-creation');
 db=openDatabase(path.join(root,'data'));const password='synthetic e2e password!',hash=await hashPassword(password);
 require('../apps/ignis-server/server/features/identity/adapters/store').bootstrapAdmin(db,'owner',hash);
 db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('receiver','receiver','user',0)").run();db.prepare('INSERT INTO local_credentials VALUES (?,?,0)').run('receiver',hash);
 if((process.argv.includes('--ui-isolation')||process.argv.includes('--management-parity')||process.argv.includes('--management-notices')||process.argv.includes('--vault-transfers')||process.argv.includes('--device-settings'))){db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('empty','empty',?,0)").run(process.argv.includes('--vault-transfers')?'user':'admin');db.prepare('INSERT INTO local_credentials VALUES (?,?,0)').run('empty',hash);}
 const ownerId=db.prepare("SELECT id FROM users WHERE login='owner'").get().id;
 const owner=createRegisteredVault(db,vaultRoot,ownerId,'Owner',{isCurrent:()=>true}),receiver=createRegisteredVault(db,vaultRoot,'receiver','Receiver',{isCurrent:()=>true});
 fs.writeFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'# Shared\ninitial\n');
 const service=require('../apps/ignis-server/server/features/sharing/adapters/resource-shares').createResourceSharesService(db,vaultRoot,{resolve:login=>{const user=db.prepare('SELECT id,auth_version FROM users WHERE login=?').get(login);return {user:{id:user.id,authVersion:user.auth_version}};}});
 fs.mkdirSync(path.join(vaultRoot,'owner/Owner','DownloadFolder','Empty'),{recursive:true});
 fs.writeFileSync(path.join(vaultRoot,'owner/Owner','DownloadFolder','Note.md'),'archive content');
 const folderResource=service.create('owner',{vault:owner.id,path:'DownloadFolder',login:'receiver',role:'reader'});
 service.destination('receiver',{id:folderResource.id,vault:receiver.id,localPath:'DownloadFolder'});
 const resource=service.create('owner',{vault:owner.id,path:'Shared.md',login:'receiver',role:'editor'});service.destination('receiver',{id:resource.id,vault:receiver.id,localPath:'Shared.md'});db.close();db=null;
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const origin='http://localhost:'+port;
 child=spawn(process.execPath,['apps/ignis-server/server/index.js'],{cwd:repo,env:{PATH:process.env.PATH,HOME:root,PORT:String(port),DATA_ROOT:path.join(root,'data'),VAULT_ROOT:vaultRoot,OBSIDIAN_ASSETS_PATH:path.resolve(assets),IGNIS_PUBLIC_ORIGIN:origin,IGNIS_ALLOW_HTTP_LOOPBACK:'true',IGNIS_TRUSTED_PROXIES:'[]',IGNIS_OIDC_ENABLED:'false',IGNIS_LOG_FILE_ENABLED:'false',IGNIS_LOG_FORMAT:'json'},stdio:['ignore','pipe','pipe']});
 let startupLog="";child.stderr.on("data",chunk=>{startupLog=(startupLog+chunk).slice(-16000);});child.stdout.on("data",chunk=>{startupLog=(startupLog+chunk).slice(-16000);});
 try{await waitForServerStarted(child);}catch(error){console.error(startupLog);throw error;}
 async function login(user,vault){
  const client=await browser({mobile:process.argv.includes('--mobile')});clients.push(client);
  const userAgent = process.argv.includes('--device-settings') ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' : await client.run('navigator.userAgent');
  await client.call('Emulation.setUserAgentOverride',{userAgent,acceptLanguage:'en-US,en'});
  if(process.argv.includes('--android-device-settings'))await client.call('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__ignisAndroidDeviceActions=true;
    window.__ignisAndroidInterfaceMode='phone';
    window.__ignisAndroidAppVersion='1.0.0';
    window.__ignisAndroidExternalTheme='dark';
    const originalPrompt=window.prompt.bind(window);
    window.prompt=(action,...args)=>action==='IgnisAndroid:app-update'
      ? JSON.stringify(window.ignisTestUpdate || {checking:true})
      : action==='IgnisAndroid:external-theme' ? args[0] : originalPrompt(action,...args);
  `});
  await client.call('Page.navigate',{url:origin+'/login'});await client.wait(`!!document.querySelector('#login-form') && !document.querySelector('#login-form').hidden`,'visible login form');
  await client.run(`(()=>{const form=document.querySelector('#login-form');form.elements.login.value=${JSON.stringify(user)};form.elements.password.value=${JSON.stringify(password)};form.requestSubmit();})()`);
  await client.wait(`location.pathname!=='/login'`,'login form submission');
  if(!vault){await client.wait(`!!window.IgnisUI && !window.app?.workspace`,'zero-vault shell');return client;}
  await client.call('Page.navigate',{url:origin+'/?vault='+encodeURIComponent(vault.id)});
  try{await client.wait(`!!window.app?.workspace && !!window.app?.vault`,'real Obsidian workspace',30000);}catch(error){console.error(JSON.stringify({user,errors:client.errors,page:await client.run(`({url:location.href,body:document.body.innerText.slice(0,3000),hasApp:!!window.app})`)}));throw error;}await client.run(`new Promise(resolve=>app.workspace.onLayoutReady(resolve))`);assert.equal(await client.run(`app.vault.getName()`),vault.name,'native vault name excludes the owner namespace');const labels=await client.run(`Array.from(document.querySelectorAll('.workspace-drawer-vault-name')).map(el=>el.textContent)`);for(const label of labels)assert.equal(label,vault.name,'native switcher displays only the vault name');return client;
 }
 const alice=await login('owner',owner),bob=await login('receiver',receiver);
 // Exercise upstream behavior through real Obsidian and the authenticated transport.
 for(const client of [alice,bob]) {
  assert.equal(await client.run(`(async()=>{const version=await (await fetch('/api/version')).json();return version.semver===window.__ignis.version && version.version===window.__ignis.version && !Object.hasOwn(version,"commit") && version.upstream.version===window.__ignis.upstream.version && version.obsidianVersion==='1.14.4';})()`),true,'server and compiled frontend report identical fork, upstream and Obsidian versions');
  assert.equal(await client.run(`Object.keys(app.commands.commands).some(id=>id.endsWith(':open-workspace-in-new-tab'))`),true,'workspace command available to ordinary owners');
  assert.equal(await client.run(`Object.keys(app.commands.commands).some(id=>id.endsWith(':refresh-vault-from-disk'))`),true,'refresh command available to ordinary owners');
  assert.equal(await client.run(`(async()=>{const fs=require('fs').promises;for(const name of ['My Work','Work.v2']){const file=app.vault.adapter.getBasePath()+'/.obsidian/workspace.'+name+'.json';await fs.writeFile(file,'{"main":{}}');if(await fs.readFile(file,'utf8')!=='{"main":{}}')return false;}return true;})()`),true,'workspace names with spaces and dots persist');
 }
 await alice.run(`window.__ignisOpenAccount();[...document.querySelectorAll('[data-section="ignis"] .vertical-tab-nav-item')].find(el=>el.textContent.trim()==='General').click();void 0;`);
 await alice.wait(`document.querySelector('.ignis-header-version')?.textContent.includes(window.__ignis.version)`,'fork version in native general settings');
 assert.equal(await alice.run(`(()=>{const el=document.querySelector('.ignis-header');return el.scrollWidth<=el.clientWidth+1;})()`),true,'version header fits native settings');
 assert.equal(await alice.run(`document.querySelector('a.ignis-header-version')?.href`),'https://github.com/rlibanez/ignis/releases/tag/v'+await alice.run('window.__ignis.version'),'fork version links to its release');
 await alice.run(`app.setting.openTab(app.setting.settingTabs.find(tab=>tab.id==='about'));void 0;`);
 await alice.wait(`document.querySelector('.modal.mod-settings')?.textContent.includes(IgnisI18n.t('Running in Ignis v{p0}',{p0:window.__ignis.version}))`,'fork version in native About row');
 if(process.argv.includes('--device-settings')){
  const shell=await login('empty');
  for(const client of [alice,shell]){
   const native=client===alice;
   await client.run(native ? `document.querySelector(".modal-setting-back-button")?.click();void 0;` : `window.IgnisUI.openAccount();void 0;`);
   await client.run(`Promise.allSettled(document.getAnimations().map(animation=>animation.finished))`);
   const nav=`.vertical-tab-nav-item`;
   try { await client.wait(`[...document.querySelectorAll('${nav}')].some(el=>el.textContent.trim()==='Device settings')`,'device settings entry',3000); }
   catch(error){console.error(native,client.errors,await client.run(`({body:document.querySelector('.modal.mod-settings')?.outerHTML.slice(0,1800),header:window.app?.setting?.tabHeadersEl?.outerHTML.slice(0,400),ua:navigator.userAgent,device:IgnisUiEnvironment.hasWebDeviceSettings(window),tabs:[...document.querySelectorAll('.vertical-tab-nav-item')].map(el=>el.textContent)})`));throw error;}
   assert.equal(await client.run(`[...document.querySelectorAll('${nav}')].find(el=>el.textContent.trim()==='Device settings').classList.contains('is-active')`),false,'device tab starts inactive');
   assert.equal(await client.run(`getComputedStyle([...document.querySelectorAll('${nav}')].find(el=>el.textContent.trim()==='Device settings')).backgroundColor`),'rgba(0, 0, 0, 0)','inactive device tab has a transparent background');
   await client.run(`[...document.querySelectorAll('${nav}')].find(el=>el.textContent.trim()==='Device settings').click()`);
   try { await client.wait(`!!document.querySelector('select[aria-label="Interface mode"]')`,'device mode selector',3000); }
   catch(error){console.error(native,client.errors,await client.run(`document.querySelector('.modal.mod-settings')?.innerText`));throw error;}
   assert.equal(await client.run(`(()=>{
    const before=document.body.classList.contains('theme-dark');
    const button=[...document.querySelectorAll('.setting-item')].find(row=>row.querySelector('.setting-item-name')?.textContent==='Ignis screen theme').querySelector('button');
    button.click();
    return IgnisUiEnvironment.theme(window)==='light' &&
      document.body.classList.contains('theme-dark')===(${native}?before:false) &&
      button.textContent==='Dark mode';
   })()`),true,'external theme toggles without changing the vault theme');
   assert.equal(await client.run(`document.querySelector('select[aria-label="Interface mode"]').dataset.uiComponent==='DropdownComponent'`),native);
   assert.equal(await client.run(`(()=>{
     const select=document.querySelector('select[aria-label="Interface mode"]'),style=getComputedStyle(select);
     const context=document.createElement('canvas').getContext('2d');
     context.font=style.font;
     const label=select.selectedOptions[0]?.textContent;
     return !!label && select.clientWidth>=context.measureText(label).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)-1;
   })()`),true,'interface selector leaves room for the selected label');
   if(native)assert.ok(await client.run(`parseFloat(document.querySelector('select[aria-label="Interface mode"]').style.getPropertyValue('--dropdown-fitted-width'))>48`),'Obsidian measures the selected label in the live DOM');
   if(process.argv.includes('--android-device-settings')){
    assert.deepEqual(await client.run(`[...document.querySelectorAll('.modal.mod-settings a.ignis-device-action')].map(el=>el.getAttribute('href'))`),['settings','pending','lock-settings','lock-now'].map(action=>'/__ignis_android/action/'+action));
    const release = 'https://github.com/rlibanez/ignis-android/releases/tag/v1.1.0';
    await client.wait(`document.querySelector('.modal.mod-settings').textContent.includes('Installed version 1.0.0')`,'installed Android version');
    await client.wait(`document.querySelector('.modal.mod-settings').textContent.includes('Checking for updates…')`,'automatic Android update check');
    await client.run(`window.ignisTestUpdate={available:'1.1.0',release:${JSON.stringify(release)}};window.dispatchEvent(new Event('ignis:android-update'));void 0;`);
    assert.equal(await client.run(`document.querySelector('.modal.mod-settings a[href="${release}"]')?.textContent`),'View');
    assert.equal(await client.run(`document.querySelector('select[aria-label="Interface mode"]').value`),'phone');
    assert.equal(await client.run(`document.querySelectorAll('[data-ignis-android-settings]').length`),0);
    assert.deepEqual(await client.run(`(async()=>{
      const dialogs=window.__ignisAndroidDialogs,prompt=window.prompt,calls=[];
      const select=document.querySelector('select[aria-label="Interface mode"]');
      try {
        let accepted=false;
        window.__ignisAndroidDialogs={confirm:async()=>accepted};
        window.prompt=(action,payload)=>{calls.push([action,JSON.parse(payload)]);return JSON.stringify({ok:true,mode:'tablet'});};
        const change=async()=>{select.value='tablet';await select.onchange();};
        await change();
        const cancelled=select.value==='phone'&&calls.length===0;
        accepted=true;await change();
        return {cancelled,calls,applied:select.value==='tablet'};
      } finally {window.__ignisAndroidDialogs=dialogs;window.prompt=prompt;window.__ignisAndroidInterfaceMode='phone';}
    })()`),{cancelled:true,calls:[['IgnisAndroid:interface-apply',{mode:'tablet'}]],applied:true});

    continue;
   }
   await client.run(`{const select=document.querySelector('select[aria-label="Interface mode"]');select.value='tablet';select.dispatchEvent(new Event('change'));}`);
   await client.wait(`document.querySelector('.modal.ignis-ui-form')?.textContent.includes('Apply and reload')`,'web reload confirmation');
   await client.run(`[...document.querySelectorAll('.modal.ignis-ui-form button')].find(button=>button.textContent==='Cancel').click()`);
   await client.wait(`document.querySelector('select[aria-label="Interface mode"]').value==='auto' && !document.querySelector('.modal.ignis-ui-form')`,'cancel restores the previous web mode');
   await client.run(`{
     const original=IgnisUiEnvironment.setWebPreference;
     IgnisUiEnvironment.setWebPreference=mode=>{IgnisUiEnvironment.setWebPreference=original;return false;};
     const select=document.querySelector('select[aria-label="Interface mode"]');
     select.value='tablet';select.dispatchEvent(new Event('change'));
   }`);
   await client.wait(`document.querySelector('.modal.ignis-ui-form .mod-cta')?.textContent==='Apply and reload'`,'web reload confirmation before storage failure');
   await client.run(`document.querySelector('.modal.ignis-ui-form .mod-cta').click();void 0;`);
   await client.wait(`document.querySelector('.modal.ignis-ui-form')?.textContent.includes('Request failed') && document.querySelector('select[aria-label="Interface mode"]').value==='auto'`,'web mode failure is visible and leaves the selection unchanged');
   await client.run(`[...document.querySelectorAll('.modal.ignis-ui-form button')].find(button=>button.textContent==='Close').click()`);
   await client.run(`(async()=>{for(const [id,title,owner,expiresAt] of [['own','Own pending',__ignisAuth.userId,null],['foreign','Foreign pending','another-user',null],['expired','Expired pending',__ignisAuth.userId,1]])await IgnisIncoming.change(id,()=>({id,title,owner,expiresAt,state:'pending',createdAt:Date.now()}));})()`);
   await client.run(`[...document.querySelectorAll('.setting-item')].find(el=>el.querySelector('.setting-item-name')?.textContent==='Pending shares').querySelector('button').click()`);
   await client.wait(`document.querySelector('.modal.ignis-ui-form')?.textContent.includes('Own pending')`,'owned pending share');
   assert.equal(await client.run(`/Foreign pending|Expired pending/.test(document.querySelector('.modal.ignis-ui-form').textContent)`),false);
   await client.run(`[...document.querySelectorAll('.modal.ignis-ui-form button')].find(button=>button.textContent==='Discard').click()`);
   await client.wait(`document.querySelector('.modal.ignis-ui-form')?.textContent.includes('No pending shares.')`,'pending item discarded');
   await client.run(`[...document.querySelectorAll('.modal.ignis-ui-form button')].find(button=>button.textContent==='Close').click()`);
  }
  await alice.run(`app.setting.close();void 0;`);
  if(!process.argv.includes('--android-device-settings')){
   await shell.run(`{
     window.ignisBeforeModeReload=true;
     const select=document.querySelector('select[aria-label="Interface mode"]');
     select.value='tablet';select.dispatchEvent(new Event('change'));
   }`);
   await shell.wait(`document.querySelector('.modal.ignis-ui-form .mod-cta')?.textContent==='Apply and reload'`,'web mode confirmation before reload');
   await shell.run(`document.querySelector('.modal.ignis-ui-form .mod-cta').click();void 0;`);
   await shell.wait(`!window.ignisBeforeModeReload && !!window.IgnisUI && document.body.classList.contains('is-tablet')`,'saved Tablet mode applies after reloading the zero-vault host');
  }
  await shell.call('Emulation.setDeviceMetricsOverride',{width:1024,height:1366,deviceScaleFactor:1,mobile:true});
  await shell.call('Page.addScriptToEvaluateOnNewDocument',{source:"window.__ignisAndroidInterfaceMode='phone'"});
  await shell.call('Page.navigate',{url:origin+'/?manager=1'});
  await shell.wait(`!!window.IgnisUI && !window.app?.workspace`,'Android zero-vault host after reload');
  await shell.wait(`document.querySelectorAll('.vault-manager-overlay .footer-right button').length===3`,'zero-vault manager actions');
  const managerRows=()=>shell.run(`[...document.querySelectorAll('.vault-manager-overlay .footer-right button')].map(el=>el.offsetTop-el.parentElement.offsetTop)`);
  const rowsBeforeSettings=await managerRows();
  assert.equal(new Set(rowsBeforeSettings).size,1,'manager actions fit on one row on a wide tablet in Phone mode');
  assert.equal(await shell.run(`document.body.classList.contains('is-phone')`),true,'saved Phone mode applies before opening Settings');
  await shell.run(`[...document.querySelectorAll('.vault-manager-overlay .footer-right button')].find(button=>button.textContent.trim()==='Settings').click();void 0;`);
  await shell.wait(`document.querySelector('.ignis-shell-settings')?.dataset.view==='navigation'`,'vault manager opens the Settings menu in Phone mode');
  assert.deepEqual(await shell.run(`[...document.querySelectorAll('.ignis-shell-settings [role="tab"]')].map(tab=>[tab.textContent.trim(),tab.getAttribute('aria-selected')])`),
    [['Account','false'],['Device settings','false']]);
  assert.equal(await shell.run(`document.body.classList.contains('is-phone') && !document.body.classList.contains('is-tablet')`),true,'Android Phone preference wins on a wide tablet without a vault');
  assert.deepEqual(await managerRows(),rowsBeforeSettings,'opening Settings does not reflow the manager footer');

  console.log("Device settings passed with and without a vault");
 }

 // The real file-menu path must use the same form category and mobile order.
 await alice.run(`{const menu=new (require('obsidian').Menu)();app.workspace.trigger('file-menu',menu,app.vault.getAbstractFileByPath('Shared.md'));menu.showAtPosition({x:20,y:20});void 0;}`);
 await alice.run(`[...document.querySelectorAll('.menu-item')].find(item=>item.textContent.trim()==='Copy to…').click()`);
 await alice.wait(`!!document.querySelector('.ignis-copy-actions')`,'native copy form');
 await alice.run(`Promise.allSettled(document.getAnimations().map(animation=>animation.finished))`);
 const copyLayout=await alice.run(`(()=>{const actions=document.querySelector('.ignis-copy-actions'),modal=actions.closest('.modal'),runtime=window.__ignisUiRuntime,r=modal.getBoundingClientRect(),buttons=[...actions.querySelectorAll('button')];return {width:r.width,top:r.top,height:r.height,viewport:innerHeight,native:[...modal.querySelectorAll('input,select,button')].filter(el=>!el.matches('.modal-close-button,.modal-header-button,select.is-measuring')).every(el=>runtime.componentFor(el) instanceof runtime[el.dataset.uiComponent]),primary:buttons[1].getBoundingClientRect().top,cancel:buttons[0].getBoundingClientRect().top};})()`);
 assert.equal(copyLayout.native,true,'Copy to uses actual native controls');
 if(process.argv.includes('--mobile')){assert.ok(copyLayout.top<=2,'copy modal starts at the safe-area top');assert.ok(copyLayout.height>=copyLayout.viewport-2,'phone form fills the viewport');assert.ok(copyLayout.primary<copyLayout.cancel,'Copy here precedes Cancel');}
 assert.ok(copyLayout.width<=400,'copy uses the shared native form width');
 if(process.argv.includes('--mobile')){
  const tabletLayout=await alice.run(`(()=>{const body=document.body,classes=body.className;
    try {
      body.classList.remove('is-phone');
      body.classList.add('is-tablet');
      const modal=document.querySelector('.ignis-copy-actions').closest('.modal'),r=modal.getBoundingClientRect();
      return {width:r.width,height:r.height,top:r.top,viewport:innerHeight};
    } finally {body.className=classes;}
  })()`);
  assert.ok(tabletLayout.width<=400,'tablet uses the shared native form width');
  assert.ok(tabletLayout.height<tabletLayout.viewport,'tablet form height is limited to the native dialog bounds');
  assert.ok(Math.abs(tabletLayout.top-(tabletLayout.viewport-tabletLayout.height)/2)<2,'tablet form is centered vertically');
 }

 await alice.run(`document.querySelector('.ignis-copy-actions').closest('.modal').querySelector('.modal-close-button,.modal-header-button:not(.mod-start)').click()`);
 await alice.wait(`!document.querySelector('.ignis-copy-actions')`,'copy form dismissed');
 await bob.wait(`!!window.__ignis?.sharedFiles?.downloadUrl('Shared.md')`,'shared download URL');
 assert.equal(await bob.run(`(async()=>{const response=await fetch(window.__ignis.sharedFiles.downloadUrl('Shared.md'));return response.ok && (await response.text())==='# Shared\\ninitial\\n';})()`),true,'received file downloads through its authorized sharing endpoint');
 await bob.wait(`!!window.__ignis?.sharedFiles?.downloadUrl('DownloadFolder',true)`,'shared folder download URL');
 assert.equal(await bob.run(`(async()=>{const url=window.__ignis.sharedFiles.downloadUrl('DownloadFolder',true),response=await fetch(url),bytes=new Uint8Array(await response.arrayBuffer());return response.ok && response.headers.get('content-type').includes('zip') && bytes[0]===80 && bytes[1]===75;})()`),true,'received folder downloads as an authorized ZIP');
 if(process.argv.includes('--remember-vault')) {
  const created=await alice.run(`(async()=>{const result=[];for(const name of ['A','C']){const response=await fetch('/api/vault/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});if(!response.ok)throw Error('create failed');result.push(await response.json());}return result;})()`);
  const last=created[1];assert.ok(last.uuid);
  const open=async reference=>{await alice.call('Page.navigate',{url:origin+(reference?'/?vault='+encodeURIComponent(reference):'/')});await alice.wait(`window.__currentVaultUuid===${JSON.stringify(last.uuid)} && !!window.app?.workspace?.layoutReady`,'remembered vault C workspace');};
  await open(last.uuid);
  await open(null);
  assert.equal(await alice.run(`app.vault.getName()`),'C','reopening root restores C instead of alphabetical A');
  // A UUID that no longer exists must lead to the manager, never a same-named replacement.
  assert.equal(await alice.run(`(async()=>{await window.__ignisAuth.beginVaultDelete(${JSON.stringify(last.uuid)});const response=await fetch('/api/vault/remove?vault='+${JSON.stringify(last.uuid)},{method:'DELETE'});return response.status;})()`),200);
  await alice.run(`void window.__ignisAuth.finishVaultDelete(true)`);
  await alice.wait(`!!window.IgnisUI && !window.app?.workspace`,'coordinated deletion returns to manager');
  await alice.call('Page.navigate',{url:origin+'/'});
  await alice.wait(`!!window.IgnisUI && !window.app?.workspace`,'manager for removed remembered vault');
  await alice.call('Page.navigate',{url:origin+'/?vault='+encodeURIComponent(owner.id)});
  await alice.wait(`window.__currentVaultUuid===${JSON.stringify(owner.id)} && !!window.app?.workspace?.layoutReady`,'explicit link overrides remembered vault');
  console.log(JSON.stringify({rememberedVault:'passed',mobile:process.argv.includes('--mobile'),checks:['reopen C instead of A','removed remembered UUID opens manager','explicit link overrides remembered selection']}));
 }
 const manifest=await(await fetch(origin+'/manifest.webmanifest')).json();
 assert.equal(manifest.share_target.action,'/share-target','upstream PWA integration preserves Android reception');
 for(const client of [alice,bob])assert.equal(await client.run(`document.querySelectorAll('link[rel="manifest"]').length`),1,'one authoritative PWA manifest');
 for(const directory of ['owner/Owner','receiver/Receiver']){
  const probe=path.join(vaultRoot,directory,'.OBSIDIANTEST'),deadline=Date.now()+5000;
  while(fs.existsSync(probe)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fs.existsSync(probe),false,'Obsidian probe must not remain on disk');
 }

 for(const client of [alice,bob])await client.run(`(async()=>{const file=app.vault.getAbstractFileByPath('Shared.md');if(!file)throw Error('Shared file absent');await app.workspace.getLeaf().openFile(file);})()`);
 await bob.wait(`!!app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view?.editor`,'recipient editor');
 await bob.run(`(async()=>{const view=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view;view.editor.setValue(${JSON.stringify('# Shared\nconfirmed from recipient\n')});await view.save();})()`);
 const until=Date.now()+10000;while(Date.now()<until&&!fs.readFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'utf8').includes('confirmed from recipient'))await new Promise(r=>setTimeout(r,100));
 assert.match(fs.readFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'utf8'),/confirmed from recipient/);
 async function grant(role){
  const ok=await alice.run(`(async()=>{const session=await(await fetch('/api/auth/session')).json(),csrf=await(await fetch('/api/auth/csrf')).json(),catalog=await(await fetch('/api/shares')).json();const resource=catalog.resources.find(r=>r.name==='Shared.md');const response=await fetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json','X-Ignis-Context':session.sessionId,'X-Ignis-Csrf':csrf.csrfToken},body:JSON.stringify({operation:'grants',input:{id:resource.id,revision:resource.revision,changes:[{login:'receiver',role:${JSON.stringify(role)}}]}})});return response.ok;})()`);assert.equal(ok,true);
 }
 await bob.run(`{window.e2eView=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view;true}`);
 await grant('reader');
 await bob.wait(`require('fs')._sharedFiles.describe('Shared.md')?.role==='reader'`,'live downgrade');
 assert.equal(await bob.run(`document.body.innerText.includes('Download recovery copy')`),false,'clean reader must not receive recovery warning');
 const confirmed=fs.readFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'utf8');
 await bob.run(`(async()=>{e2eView.editor.setValue('read-only attempt');try{await e2eView.save();}catch{} })()`);
 assert.equal(fs.readFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'utf8'),confirmed);
 await grant('editor');
 await bob.wait(`require('fs')._sharedFiles.describe('Shared.md')?.role==='editor'`,'live upgrade');
 assert.equal(await bob.run(`e2eView===app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view`),true,'same editor must survive permission changes');
 await bob.run(`(async()=>{e2eView.editor.setValue('confirmed after restoring write');await e2eView.save();})()`);
 const restoredUntil=Date.now()+10000;while(Date.now()<restoredUntil&&!fs.readFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'utf8').includes('confirmed after restoring write'))await new Promise(r=>setTimeout(r,100));
 assert.equal(fs.readFileSync(path.join(vaultRoot,'owner/Owner','Shared.md'),'utf8'),'confirmed after restoring write');
 await grant(null);await bob.wait(`require('fs')._sharedFiles.describe('Shared.md')===null`,'live revocation');
 // A direct sidebar confirmation must not abort its own revoke request on close.
 const directResource=await alice.run(`(async()=>{const catalog=await(await fetch('/api/shares')).json(),resource=catalog.resources.find(item=>item.name==='Shared.md'&&item.owned);window.__ignisOpenResourceSharing({initialResource:{id:resource.id,session:window.__ignisAuth.sessionId,action:'revoke'}});return resource.id;})()`);
 await alice.wait(`!!document.querySelector('.ui-dialog.ignis-confirm[open]')`,'direct stop-sharing confirmation');
 await alice.run(`document.querySelector('.ui-dialog.ignis-confirm[open] .danger').click()`);
 await alice.wait(`!document.querySelector('.ignis-management-root')`,'direct action finished and disposed');
 assert.equal(await alice.run(`(async()=>!(await(await fetch('/api/shares')).json()).resources.some(item=>item.id===${JSON.stringify(directResource)}))()`),true,'confirmed direct action reaches the real sharing API');

 const denied=await bob.run(`(async()=>{const session=await(await fetch('/api/auth/session')).json(),csrf=await(await fetch('/api/auth/csrf')).json();return (await fetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json','X-Ignis-Context':session.sessionId,'X-Ignis-Csrf':csrf.csrfToken},body:JSON.stringify({operation:'read',input:{id:${JSON.stringify(resource.id)},path:''}})})).status;})()`);assert.equal(denied,404);

 if(process.argv.includes('--vault-transfers')){
  const shell=await login('empty');
  if(process.argv.includes('--tablet'))for(const client of [alice,shell]){
   await client.call('Emulation.setDeviceMetricsOverride',{width:800,height:1024,deviceScaleFactor:1,mobile:true});
   await client.call('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('DOMContentLoaded',()=>{document.body.classList.remove('is-phone');document.body.classList.add('is-mobile','is-tablet');});`});
   await client.run("document.body.classList.remove('is-phone');document.body.classList.add('is-mobile','is-tablet')");
  }
  await vaultBatchUi({native:alice,shell});await vaultImportUi({native:alice,shell});
 }
 // Exercise the real bridge host, not the vaultless fallback or synthetic CSS.
 await alice.call('Page.bringToFront');
 const activationPoint=await alice.run(`({x:innerWidth-25,y:innerHeight-25})`);
 await alice.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...activationPoint});
 await alice.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...activationPoint});
 await alice.wait(`Object.getOwnPropertyDescriptor(History.prototype,'state').get.call(history)?.ignisVirtualEntry===true`,'browser back virtual entry');
 await alice.run(`window.__ignisOpenManagement('users')`);await alice.wait(`!!document.querySelector('#administration') && !document.querySelector('#administration').hidden`,'native users host');
 const historyEntries=await alice.call('Page.getNavigationHistory');
 assert.ok(historyEntries.currentIndex>0,'browser history has a previous entry');
 await alice.call('Page.navigateToHistoryEntry',{entryId:historyEntries.entries[historyEntries.currentIndex-1].id});
 await alice.wait(`!document.querySelector('#administration') && !!app.workspace`,'browser back closes management without leaving the vault');
 if(process.argv.includes('--terminal-ui')){
  const changed=await alice.run(`(async()=>{const session=await(await fetch('/api/auth/session')).json(),csrf=await(await fetch('/api/auth/csrf')).json(),catalog=await(await fetch('/api/shares')).json(),resource=catalog.resources.find(item=>item.name==='DownloadFolder');const result=await fetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json','X-Ignis-Context':session.sessionId,'X-Ignis-Csrf':csrf.csrfToken},body:JSON.stringify({operation:'grants',input:{id:resource.id,revision:resource.revision,changes:[{login:'receiver',role:'editor'}]}})});return result.ok;})()`);assert.equal(changed,true);
  await bob.wait(`require('fs')._sharedFiles.describe('DownloadFolder/Note.md')?.role==='editor'`,'received folder write permission');
  const begin=()=>bob.run(`{window.removalResult=null;app.vault.adapter.trashLocal('DownloadFolder/Note.md').then(()=>{removalResult='done';},error=>{removalResult=error.code;});void 0;}`);
  await begin();await bob.wait(`[...document.querySelectorAll('.modal-title')].some(el=>el.textContent==='Delete shared content')`,'native deletion confirmation');
  assert.equal(await bob.run(`(()=>{const modal=[...document.querySelectorAll('.modal')].find(el=>el.querySelector('.modal-title')?.textContent==='Delete shared content'),runtime=__ignisUiRuntime;return [...modal.querySelectorAll('.ignis-ui-actions button')].every(el=>runtime.componentFor(el) instanceof runtime.ButtonComponent);})()`),true);
  await bob.run(`document.querySelector('.ignis-ui-actions button:not(.mod-warning)').click()`);await bob.wait(`removalResult==='ECANCELED'`,'cancelled received deletion');assert.equal(fs.existsSync(path.join(vaultRoot,'owner/Owner/DownloadFolder/Note.md')),true);
  await begin();await bob.wait(`!!document.querySelector('.ignis-ui-actions .mod-warning')`,'second deletion confirmation');await bob.run(`document.querySelector('.ignis-ui-actions .mod-warning').click()`);await bob.wait(`removalResult==='done'`,'confirmed original deletion');assert.equal(fs.existsSync(path.join(vaultRoot,'owner/Owner/DownloadFolder/Note.md')),false);
  for(const client of [alice,bob]){
   await client.run(`IgnisUiEnvironment.setTheme(window,'light');document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');document.body.style.setProperty('--interactive-accent','rgb(11, 22, 33)');__ignisAuth.lock()`);
   await client.wait(`!!document.querySelector('.ignis-lock-panel') && !!document.querySelector('#ignis-entry-css')?.sheet`,'real editor terminal view');
   assert.equal(await client.run(`getComputedStyle(document.querySelector('.lock-actions a')).backgroundColor`),'rgb(11, 22, 33)','active theme survives terminal rendering');
   assert.equal(await client.run(`document.body.classList.contains('theme-light') && !document.body.classList.contains('theme-dark')`),true,'the lock uses the external theme instead of the editor mode: '+await client.run(`JSON.stringify([document.body.className,IgnisUiEnvironment.theme(window)])`));
   assert.equal(await client.run(`!!document.querySelector('#ignis-lock-native-css')`),false,'native CSS is not appended over the active theme');
   assert.equal(await client.run(`!!document.querySelector('.workspace')`),false);
   assert.equal(await client.run(`fetch('/api/fs/writeFile',{method:'POST'}).then(()=>false,()=>true)`),true);
  }
  console.log(JSON.stringify({terminalRuntime:'passed',mobile:process.argv.includes('--mobile'),checks:['native shared deletion confirmation','cancel preserves original','explicit confirmation deletes original','real editor lock','theme preserved','writes remain blocked']}));
 }
 if(process.argv.includes('--ui-isolation'))await uiIsolation([alice,await login('empty')]);
 if((process.argv.includes('--management-parity')||process.argv.includes('--management-notices')))await managementParity({native:alice,shell:await login('empty'),origin,vault:owner.id,mobile:process.argv.includes('--mobile'),noticesOnly:process.argv.includes('--management-notices')});
 if(process.argv.includes('--vault-transfers')||process.argv.includes('--vault-ownership')){await vaultOwnershipUi({owner:alice,member:bob,vault:owner,origin});assert.equal(fs.readFileSync(path.join(vaultRoot,'receiver/Owner/Shared.md'),'utf8'),'saved after ownership transfer');}
 console.log(JSON.stringify({status:'passed',runtime:'1.14.4',mobile:process.argv.includes('--mobile'),checks:['upstream commands and workspace names','authorized shared file and ZIP downloads','two isolated accounts','real workspace and editor','recipient save reaches original bytes','native management host and browser back','single PWA manifest with Android reception','no stale Obsidian probes','read-only edit denied','live read/write restoration in same editor','live revocation','direct resource confirmation reaches server']}));
}finally{
 for(const client of clients)await client.close();db?.close();if(child){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}fs.rmSync(root,{recursive:true,force:true});
}
