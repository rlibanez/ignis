// Opt-in real Obsidian E2E. Never writes to or distributes the supplied assets.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';import {browser} from './lib/chrome.mjs';
import {waitForServerStarted} from './lib/server-readiness.mjs';
import {vaultBatchUi} from './lib/vault-batch-ui.mjs';
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
 if((process.argv.includes('--management-parity')||process.argv.includes('--management-notices')||process.argv.includes('--vault-transfers'))){db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('empty','empty',?,0)").run(process.argv.includes('--vault-transfers')?'user':'admin');db.prepare('INSERT INTO local_credentials VALUES (?,?,0)').run('empty',hash);}
 const ownerId=db.prepare("SELECT id FROM users WHERE login='owner'").get().id;
 const owner=createRegisteredVault(db,vaultRoot,ownerId,'Owner',{isCurrent:()=>true}),receiver=createRegisteredVault(db,vaultRoot,'receiver','Receiver',{isCurrent:()=>true});
 fs.writeFileSync(path.join(vaultRoot,'Owner','Shared.md'),'# Shared\ninitial\n');
 const service=require('../apps/ignis-server/server/features/sharing/adapters/resource-shares').createResourceSharesService(db,vaultRoot,{resolve:login=>{const user=db.prepare('SELECT id,auth_version FROM users WHERE login=?').get(login);return {user:{id:user.id,authVersion:user.auth_version}};}});
 const resource=service.create('owner',{vault:owner.id,path:'Shared.md',login:'receiver',role:'editor'});service.destination('receiver',{id:resource.id,vault:receiver.id,localPath:'Shared.md'});db.close();db=null;
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const origin='http://localhost:'+port;
 child=spawn(process.execPath,['apps/ignis-server/server/index.js'],{cwd:repo,env:{PATH:process.env.PATH,HOME:root,PORT:String(port),DATA_ROOT:path.join(root,'data'),VAULT_ROOT:vaultRoot,OBSIDIAN_ASSETS_PATH:path.resolve(assets),IGNIS_PUBLIC_ORIGIN:origin,IGNIS_ALLOW_HTTP_LOOPBACK:'true',IGNIS_TRUSTED_PROXIES:'[]',IGNIS_OIDC_ENABLED:'false',IGNIS_LOG_FILE_ENABLED:'false',IGNIS_LOG_FORMAT:'json'},stdio:['ignore','pipe','pipe']});
 let startupLog="";child.stderr.on("data",chunk=>{startupLog=(startupLog+chunk).slice(-16000);});child.stdout.on("data",chunk=>{startupLog=(startupLog+chunk).slice(-16000);});
 try{await waitForServerStarted(child);}catch(error){console.error(startupLog);throw error;}
 async function login(user,vault){
  const client=await browser({mobile:process.argv.includes('--mobile')});clients.push(client);await client.call('Page.navigate',{url:origin+'/login'});await client.wait(`!!document.querySelector('#login-form') && !document.querySelector('#login-form').hidden`,'visible login form');
  await client.run(`(()=>{const form=document.querySelector('#login-form');form.elements.login.value=${JSON.stringify(user)};form.elements.password.value=${JSON.stringify(password)};form.requestSubmit();})()`);
  await client.wait(`location.pathname!=='/login'`,'login form submission');
  if(!vault){await client.wait(`!!window.IgnisUI && !window.app?.workspace`,'zero-vault shell');return client;}
  await client.call('Page.navigate',{url:origin+'/?vault='+encodeURIComponent(vault.id)});
  try{await client.wait(`!!window.app?.workspace && !!window.app?.vault`,'real Obsidian workspace',30000);}catch(error){console.error(JSON.stringify({user,errors:client.errors,page:await client.run(`({url:location.href,body:document.body.innerText.slice(0,3000),hasApp:!!window.app})`)}));throw error;}return client;
 }
 const alice=await login('owner',owner),bob=await login('receiver',receiver);
 for(const client of clients)await client.run(`(async()=>{const file=app.vault.getAbstractFileByPath('Shared.md');if(!file)throw Error('Shared file absent');await app.workspace.getLeaf().openFile(file);})()`);
 await bob.wait(`!!app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view?.editor`,'recipient editor');
 await bob.run(`(async()=>{const view=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view;view.editor.setValue(${JSON.stringify('# Shared\nconfirmed from recipient\n')});await view.save();})()`);
 const until=Date.now()+10000;while(Date.now()<until&&!fs.readFileSync(path.join(vaultRoot,'Owner','Shared.md'),'utf8').includes('confirmed from recipient'))await new Promise(r=>setTimeout(r,100));
 assert.match(fs.readFileSync(path.join(vaultRoot,'Owner','Shared.md'),'utf8'),/confirmed from recipient/);
 async function grant(role){
  const ok=await alice.run(`(async()=>{const session=await(await fetch('/api/auth/session')).json(),csrf=await(await fetch('/api/auth/csrf')).json(),catalog=await(await fetch('/api/shares')).json();const resource=catalog.resources.find(r=>r.name==='Shared.md');const response=await fetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json','X-Ignis-Context':session.sessionId,'X-Ignis-Csrf':csrf.csrfToken},body:JSON.stringify({operation:'grants',input:{id:resource.id,revision:resource.revision,changes:[{login:'receiver',role:${JSON.stringify(role)}}]}})});return response.ok;})()`);assert.equal(ok,true);
 }
 await bob.run(`{window.e2eView=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view;true}`);
 await grant('reader');
 await bob.wait(`require('fs')._sharedFiles.describe('Shared.md')?.role==='reader'`,'live downgrade');
 assert.equal(await bob.run(`document.body.innerText.includes('Download recovery copy')`),false,'clean reader must not receive recovery warning');
 const confirmed=fs.readFileSync(path.join(vaultRoot,'Owner','Shared.md'),'utf8');
 await bob.run(`(async()=>{e2eView.editor.setValue('read-only attempt');try{await e2eView.save();}catch{} })()`);
 assert.equal(fs.readFileSync(path.join(vaultRoot,'Owner','Shared.md'),'utf8'),confirmed);
 await grant('editor');
 await bob.wait(`require('fs')._sharedFiles.describe('Shared.md')?.role==='editor'`,'live upgrade');
 assert.equal(await bob.run(`e2eView===app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path==='Shared.md')?.view`),true,'same editor must survive permission changes');
 await bob.run(`(async()=>{e2eView.editor.setValue('confirmed after restoring write');await e2eView.save();})()`);
 const restoredUntil=Date.now()+10000;while(Date.now()<restoredUntil&&!fs.readFileSync(path.join(vaultRoot,'Owner','Shared.md'),'utf8').includes('confirmed after restoring write'))await new Promise(r=>setTimeout(r,100));
 assert.equal(fs.readFileSync(path.join(vaultRoot,'Owner','Shared.md'),'utf8'),'confirmed after restoring write');
 await grant(null);await bob.wait(`require('fs')._sharedFiles.describe('Shared.md')===null`,'live revocation');
 const denied=await bob.run(`(async()=>{const session=await(await fetch('/api/auth/session')).json(),csrf=await(await fetch('/api/auth/csrf')).json();return (await fetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json','X-Ignis-Context':session.sessionId,'X-Ignis-Csrf':csrf.csrfToken},body:JSON.stringify({operation:'read',input:{id:${JSON.stringify(resource.id)},path:''}})})).status;})()`);assert.equal(denied,404);

 if(process.argv.includes('--vault-transfers')){const shell=await login('empty');await vaultBatchUi({native:alice,shell});await vaultImportUi({native:alice,shell});}
 // Exercise the real bridge host, not the vaultless fallback or synthetic CSS.
 await alice.run(`window.__ignisOpenManagement('users')`);await alice.wait(`!!document.querySelector('#administration') && !document.querySelector('#administration').hidden`,'native users host');
 await alice.run(`document.querySelector('#administration').closest('.modal-container').querySelector('.modal-header-button:not(.mod-start),.modal-close-button').click()`);await alice.wait(`!document.querySelector('#administration')`,'native management close');
 if((process.argv.includes('--management-parity')||process.argv.includes('--management-notices')))await managementParity({native:alice,shell:await login('empty'),origin,vault:owner.id,mobile:process.argv.includes('--mobile'),noticesOnly:process.argv.includes('--management-notices')});
 console.log(JSON.stringify({status:'passed',runtime:'1.14.4',mobile:process.argv.includes('--mobile'),checks:['two isolated accounts','real workspace and editor','recipient save reaches original bytes','native management host','read-only edit denied','live read/write restoration in same editor','live revocation']}));
}finally{
 for(const client of clients)await client.close();db?.close();if(child){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}fs.rmSync(root,{recursive:true,force:true});
}
