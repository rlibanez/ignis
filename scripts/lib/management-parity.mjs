import {uiComponents} from "./ui-components.mjs";
// Real native Modal versus the zero-vault host. Only the presentation API replies
// below are synthetic: no production account, share or OIDC mutation is sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
function fixtures(realSession){
 const original=window.fetch.bind(window);
 window.parity={recent:true,empty:false,noVaults:false,fail:false,local:true,pending:false,ready:false,emailReauth:false,linked:!new URL(location.href).searchParams.has('parityLink')};
 window.fetch=async(url,options={})=>{
  const requestUrl=new URL(typeof url==='string'?url:url.url,location.href),name=requestUrl.pathname;
  // Never replace the running Obsidian workspace's real filesystem projection.
  if(name==='/api/fs/tree'&&requestUrl.searchParams.get('vault')!=='v')return original(url,options);
  if(!['/api/auth/session','/api/auth/status','/api/auth/csrf','/api/shares','/api/fs/tree'].includes(name)&&!name.startsWith('/api/auth/users')&&!['/api/auth/password','/api/auth/email','/api/auth/reauth','/api/auth/oidc/unlink','/api/auth/oidc/link'].includes(name))return original(url,options);
  if(!window.parity.ready&&!['/api/auth/session','/api/auth/status'].includes(name))return original(url,options);
  const state=window.parity,post=options.method==='POST',body=options.body?JSON.parse(options.body):{};
  if(state.pending===name && (!state.pendingMethod||state.pendingMethod===(options.method||'GET'))){await new Promise((resolve,reject)=>{const done=()=>{options.signal?.removeEventListener('abort',abort);resolve();};const abort=()=>reject(options.signal.reason);state.release=done;options.signal?.addEventListener('abort',abort,{once:true});});}
  const reply=(value,status=200)=>Promise.resolve(new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}}));
  if(name==='/api/auth/session')return reply({...realSession,email:null,emailTrust:'unverified',hasLocalPassword:state.local,oidcLinked:state.linked,recentAuthentication:state.recent,passwordPolicy:{minLength:8,minSpecialChars:0}});
  if(name==='/api/auth/status')return reply({initialized:true,oidcAvailable:true,oidcButtonText:'Provider'});
  if(name==='/api/auth/csrf')return reply({csrfToken:'synthetic'});
  if(state.failOperation===name)return reply({error:'Request failed'},400);
  if(name==='/api/auth/reauth')return reply({error:'Incorrect password'},400);
  if(name==='/api/auth/password')return reply({code:state.passwordFailure||'INVALID_PASSWORD',error:'Incorrect password'},400);
  if(name==='/api/auth/email'&&state.emailReauth)return reply({code:'REAUTH_REQUIRED'},403);
  if(name==='/api/auth/email'||name==='/api/auth/oidc/unlink'||name==='/api/auth/oidc/link')return reply({error:'Request failed'},400);
  const user={id:'b',login:'bob',role:'user',status:'active',email:null,email_trust:'unverified',hasLocalPassword:true,canSetLocalPassword:true,oidcLinked:true};
  if(name==='/api/auth/users'&&!post){if(state.fail)return reply({error:'Request failed'},503);return reply({users:state.empty?[]:[user],passwordPolicy:{minLength:8,minSpecialChars:0},oidcAvailable:true,oidcButtonText:'Provider'});}
  if(name==='/api/auth/users/delete')return reply({userId:'b',login:'bob',revision:1,vaults:['v'],progress:[{name:'Main',state:state.deletionStarted?'removed':'not-started'}],started:!!state.deletionStarted});
  if(name==='/api/auth/users/reset-password')return reply({secret:'synthetic temporary password!',expiresAt:1893456000000,signedOut:false});
  if(name.startsWith('/api/auth/users'))return reply({code:'INVALID_EMAIL',error:'Request failed'},400);
  if(name==='/api/fs/tree')return reply({'folder':{type:'directory'},'folder/deep':{type:'directory'},'Note.md':{type:'file'}});
  if(post){
   if(body.operation==='browse')return reply({entries:body.input.path?[]:[{name:'folder',kind:'directory'},{name:'Note.md',kind:'file'}]});
   return reply({error:'Invalid shared resource or recipient.'},400);
  }
  if(state.fail)return reply({error:'Request failed'},503);
  const owned={id:'r',name:'Note.md',owned:true,available:true,kind:'file',vault:'v',path:'Note.md',revision:1,grants:[{login:'bob',role:'reader'}]};
  const received={id:'s',name:'Received.md',owned:false,available:true,kind:'file',owner:'bob',role:'reader',localPath:'Received.md',destination:null};
  return reply({resources:state.empty?[]:[...(state.noVaults?[]:[owned]),received],ownedVaults:state.noVaults?[]:[{id:'v',name:'Main'}],destinationVaults:state.noVaults?[]:[{id:'v',name:'Main'}]});
 };
}
export async function managementParity({native,shell,origin,vault,mobile,noticesOnly=false}){
 let errorStarts;
 const report={mobile,viewport:process.argv.includes('--landscape')?'844x390':process.argv.includes('--compact')?'360x800':process.argv.includes('--wide')?'2560x1440':mobile?'390x844':'780x437',states:[],differences:[]},output=process.env.IGNIS_PARITY_OUTPUT;
 const snapshot=async(client,label,selector)=>{
  await client.wait(`!!document.querySelector(${JSON.stringify(selector)})`,'matrix '+label);
  await client.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
  // Native click delegation leaves a transient mobile-tap highlight; compare resting styles.
  await client.run(`document.querySelectorAll('.mobile-tap').forEach(el=>el.classList.remove('mobile-tap'))`);
  await new Promise(r=>setTimeout(r,650));
  const data=await client.run(`(()=>{const root=document.querySelector(${JSON.stringify(selector)}),rect=root.getBoundingClientRect();const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';const metric=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {class:el.className,hover:el.matches(':hover'),focused:el.matches(':focus-visible'),tag:el.tagName,type:el.type||'',text:el.tagName==='INPUT'?'':el.textContent.trim(),width:r.width,height:r.height,x:r.x-rect.x,y:r.y-rect.y,font:s.fontSize,color:s.color,background:s.backgroundColor,fontWeight:s.fontWeight,lineHeight:s.lineHeight,padding:s.padding,borderRadius:s.borderRadius};};return {modalTop:root.closest('.modal')?.getBoundingClientRect().top ?? null,width:rect.width,height:rect.height,top:rect.top,left:rect.left,overflow:root.scrollWidth>root.clientWidth+1,controls:[...root.querySelectorAll('input:not([type=hidden]),select,button')].filter(el=>visible(el)&&!el.matches('[data-ignis-close],.modal-header-button,.modal-close-button')).map(metric),heading:[...root.querySelectorAll('h2,.modal-title')].filter(visible).map(metric)};})()`);
  if(output){fs.mkdirSync(output,{recursive:true});const {data:png}=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,`${report.viewport}-${client===native?'native':'shell'}-${label}.png`),Buffer.from(png,'base64'));}
  return data;
 };
 const checkHelp=async selector=>{
  await click(selector);
  for(const client of [native,shell]){
   await client.wait(`Array.from(document.querySelectorAll('.tooltip')).some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`,'help visible',5000);
   assert.equal(await client.run(`Array.from(document.querySelectorAll('.tooltip')).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').every(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.left>=0&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1})`),true,'help remains within viewport');
   await client.run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('pointerout',{bubbles:true}));document.querySelector(${JSON.stringify(selector)}).closest('form')?.querySelector('input')?.focus()`);
  }
 };
 const compare=async(label,selector)=>{
  if(label==='edit-user')for(const client of [native,shell])assert.equal(await client.run(`(()=>{const catalog=document.querySelector('#users'),parent=catalog.closest('.modal-container'),child=document.querySelector('#edit-dialog').closest('.modal-container');return !parent.hidden && getComputedStyle(parent).display!=='none' && parent!==child && catalog.getClientRects().length>0;})()`),true,'Editing preserves the visible parent catalog');
  if(selector.includes('-dialog') || selector==='.ignis-password-modal') {
   const nativeControls=await native.run(`(()=>{const root=document.querySelector(${JSON.stringify(selector)}),runtime=window.__ignisUiRuntime;if(!runtime)return ['runtime unavailable'];return [...root.querySelectorAll('input,select,textarea,button')].filter(el=>!['checkbox','file','hidden'].includes(el.type)&&!el.matches('.modal-close-button,.modal-header-button')).filter(el=>{const component=runtime.componentFor(el);return !component || !(component instanceof runtime[el.dataset.uiComponent]);}).map(el=>el.id||el.className||el.tagName);})()`);
   assert.deepEqual(nativeControls,[],label+': controls must be real Obsidian component instances');
  }

  const [a,b]=await Promise.all([snapshot(native,label,selector),snapshot(shell,label,selector)]);report.states.push({label,native:a,shell:b});console.log('Compared '+label);
  if(!mobile && selector==='.modal:has(.ignis-management-root)' && (a.width>1102||b.width>1102))report.differences.push(label+': exceeds native settings width cap');
  if(a.overflow||b.overflow)report.differences.push(label+': horizontal overflow');
  if(mobile && ((a.modalTop!==null && a.modalTop>2) || (b.modalTop!==null && b.modalTop>2)))report.differences.push(label+': mobile modal must start at the safe-area top');
  if(mobile)for(const client of [native,shell]){
   const footer=await client.run(`(()=>{const root=document.querySelector(${JSON.stringify(selector)}),footer=root.querySelector('.dialog-actions,.password-actions,.modal-button-container');if(!footer)return null;const buttons=[...footer.querySelectorAll('button')].filter(el=>el.getClientRects().length);return {width:footer.clientWidth,buttons:buttons.map(el=>({text:el.textContent.trim(),width:el.getBoundingClientRect().width,top:el.getBoundingClientRect().top}))};})()`);
   if(footer){if(footer.buttons.some(b=>b.width<footer.width-2))report.differences.push(label+': mobile footer button not full width');const cancel=footer.buttons.find(b=>b.text==='Cancel');if(cancel&&footer.buttons.some(b=>b.top>cancel.top+1))report.differences.push(label+': mobile Cancel is not last');}
  }
  for(const key of ['width','height','top'])if(Math.abs(a[key]-b[key])>2)report.differences.push(`${label}: ${key} ${a[key]} / ${b[key]}`);
  if(a.heading.length!==b.heading.length)report.differences.push(label+': heading count');
  for(let i=0;i<Math.min(a.heading.length,b.heading.length);i++)for(const key of ['width','height','x','y','font','lineHeight','padding','fontWeight','color']){
   const av=a.heading[i][key],bv=b.heading[i][key];if(typeof av==='number'?Math.abs(av-bv)>2:av!==bv)report.differences.push(`${label}: heading ${i} ${key} ${av} / ${bv}`);
  }
  if(a.controls.length!==b.controls.length)report.differences.push(label+': control count');
  for(let i=0;i<Math.min(a.controls.length,b.controls.length);i++)for(const key of ['width','height','x','y','font','lineHeight','padding','type','color','background','fontWeight']){
   if(key==='type'&&selector.includes('.vertical-tab-content'))continue;
   const av=a.controls[i][key],bv=b.controls[i][key];if(typeof av==='number'?Math.abs(av-bv)>2:av!==bv)report.differences.push(`${label}: control ${i} ${key} ${av} / ${bv}`);
  }
 };
 const both=async expression=>{for(const client of [native,shell])await client.run(expression);};
 const click=selector=>both(`(()=>{const selector=${JSON.stringify(selector)};const el=selector.endsWith(" .native-management-close")?document.querySelector(selector.split(" ")[0])?.closest(".modal")?.querySelector(".modal-close-button,.modal-header-button:not(.mod-start)"):document.querySelector(selector);if(!el)throw Error('Missing '+${JSON.stringify(selector)});el.click();})()`);
 const tap=async selector=>{
  for(const client of [native,shell]){
   const point=await client.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,disabled:el.disabled};})()`);
   assert.equal(point.disabled,false,'footer action is enabled');
   assert.equal(await client.run(`!!document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)})`),true,'footer action is reachable without an overlay');
   await client.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
   await client.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  }
 };
 const wait=async expression=>{try{await Promise.all([native,shell].map(client=>client.wait(expression,expression)));}catch(error){for(const [name,client] of [["native",native],["shell",shell]])console.error(name,client.errors,await client.run(`({status:[...document.querySelectorAll("#status")].map(el=>el.textContent),modals:[...document.querySelectorAll(".modal-title")].map(el=>el.textContent)})`));throw error;}};
 const close=async()=>{await both(`(()=>{const all=[...document.querySelectorAll('.ui-dialog[open]')];for(const d of all.reverse())d.close();const containers=[...document.querySelectorAll('.modal-container')];for(const c of containers.reverse()){const b=c.querySelector('[data-ignis-close],.modal-close-button,.modal-header-button:not(.mod-start)');b?.click();}})()`);await new Promise(r=>setTimeout(r,100));};
 const open=async kind=>{await close();await both(`(window.__ignisOpenManagement || window.IgnisUI.openAccount)(${JSON.stringify(kind)})`);};
 const row=async name=>both(`(()=>{const row=[...document.querySelectorAll('.setting-item')].find(el=>el.querySelector('.setting-item-name')?.textContent===${JSON.stringify(name)});if(!row)throw Error('Missing account row '+${JSON.stringify(name)});row.querySelector('button').click();})()`);
 for(const client of [native,shell]){const session=await client.run(`fetch('/api/auth/session').then(r=>r.json())`);await client.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${fixtures.toString()})(${JSON.stringify(session)})`});}
 await native.call('Page.navigate',{url:origin+'/?vault='+vault});try{await native.wait(`!!window.__ignisOpenManagement`,'native parity host');}catch(error){console.error(await native.run(`({url:location.href,body:document.body.innerText.slice(0,2000),app:!!window.app,errors:window.parity})`));console.error(native.errors);throw error;}
 await shell.call('Page.navigate',{url:origin+'/'});await shell.wait(`!!window.IgnisUI && !window.app?.workspace`,'zero-vault parity host');
 errorStarts=new Map([native,shell].map(client=>[client,client.errors.length]));
 await both(`parity.ready=true;document.body.classList.remove('theme-light');document.body.classList.add('theme-dark')`);
 await open('account');
 const dimensions=process.argv.includes('--landscape')?[844,390]:process.argv.includes('--compact')?[360,800]:process.argv.includes('--wide')?[2560,1440]:null;
 if(dimensions)for(const client of [native,shell])await client.call('Emulation.setDeviceMetricsOverride',{width:dimensions[0],height:dimensions[1],deviceScaleFactor:1,mobile});
 await wait(`document.querySelectorAll('.setting-item-name').length>=6`);
 // Native Account retains its fetched session while mounted, just as production.
 if(!noticesOnly){
 await compare('account-panel','.modal.mod-settings .vertical-tab-content');
 await row('Email');await wait(`!!document.querySelector('.ignis-password-modal')`);await compare('email','.ignis-password-modal');
 await checkHelp('.ignis-password-modal .ignis-password-help');
 await both(`parity.emailReauth=true;{const f=document.querySelector('.ignis-password-modal form');f.querySelector('input[type=email]').value='next@example.com';f.requestSubmit();}`);
 await wait(`!document.querySelector('.ignis-password-modal input[autocomplete="current-password"]').closest('label').hidden`);await compare('email-reauth','.ignis-password-modal');
 await both(`{const f=document.querySelector('.ignis-password-modal form');f.querySelector('input[autocomplete="current-password"]').value='incorrect';f.requestSubmit();}`);await wait(`!!document.querySelector('.ignis-password-modal input[autocomplete="current-password"]').validationMessage`);await compare('email-password-error','.ignis-password-modal');
 // Close children only, retaining the account tab/session.
 const closeForm=async()=>{await both(`document.querySelector('.ignis-password-modal').parentElement.querySelector('[data-ignis-close],.modal-close-button,.modal-header-button:not(.mod-start)').click()`);await wait(`!document.querySelector('.ignis-password-modal')`);};
 await closeForm();await row('Change password');await compare('password','.ignis-password-modal');
 await both(`{const form=document.querySelector('.ignis-password-modal form');window.parity.submits=0;form.addEventListener('submit',()=>parity.submits++);form.querySelector('.ignis-password-toggle').click();form.querySelector('.ignis-password-help').click();}`);
 for(const client of [native,shell])assert.equal(await client.run(`parity.submits`),0,'auxiliary password buttons must never submit');await compare('password-visible','.ignis-password-modal');
 const passwordLayout=()=>Promise.all([native,shell].map(client=>client.run(`JSON.stringify([document.querySelector('.ignis-password-modal'),...document.querySelectorAll('.ignis-password-modal .modal-button-container button')].map(el=>el.getBoundingClientRect().toJSON()))`)));
 const originalPasswordLayout=await passwordLayout();
 await both(`{const form=document.querySelector('.ignis-password-modal form'),fields=form.querySelectorAll('input');fields[0].value='incorrect';fields[1].value='new password!';fields[2].value='different';form.requestSubmit();}`);await wait(`!!document.querySelector('.ignis-password-modal input[autocomplete="new-password"]:last-of-type')`);await compare('password-mismatch','.ignis-password-modal');
 for(const client of [native,shell])assert.equal(await client.run(`document.querySelectorAll('.ignis-password-modal input')[2].validationMessage`),'New passwords do not match.');
 assert.deepEqual(await passwordLayout(),originalPasswordLayout,'mismatch must not resize or move the dialog or its buttons');
 await both(`{const form=document.querySelector('.ignis-password-modal form'),fields=form.querySelectorAll('input');fields[0].value='incorrect';fields[1].value=fields[2].value='new password!';fields[2].dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();}`);await wait(`document.querySelector('.ignis-password-modal input').validationMessage==='Current password incorrect.'`);await compare('password-error','.ignis-password-modal');
 assert.deepEqual(await passwordLayout(),originalPasswordLayout,'incorrect password must not resize or move the dialog or its buttons');
 await both(`parity.passwordFailure='PASSWORD_POLICY';{const form=document.querySelector('.ignis-password-modal form'),fields=form.querySelectorAll('input');fields[0].value='incorrect';fields[0].dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();}`);await wait(`document.querySelectorAll('.ignis-password-modal input')[1].validationMessage==='The new password does not meet the password policy.'`);await compare('password-policy-error','.ignis-password-modal');assert.deepEqual(await passwordLayout(),originalPasswordLayout,'policy error must not move the dialog');
 await closeForm();await row('OpenID Connect');await compare('unlink-provider','.ignis-password-modal');
 await both(`{const form=document.querySelector('.ignis-password-modal form');form.querySelector('input').value='incorrect';form.requestSubmit();}`);await wait(`!!document.querySelector('.ignis-password-modal [role=alert]').textContent`);await compare('unlink-error','.ignis-password-modal');
 await both(`parity.pending='/api/auth/users';parity.pendingMethod='GET'`);await open('users');await wait(`typeof parity.release==='function'`);await compare('users-loading','.modal:has(.ignis-management-root)');
 await both(`parity.pending=false;parity.release();delete parity.release`);await wait(`!!document.querySelector('#users button')`);await compare('users','.modal:has(.ignis-management-root)');
 await click('#add-user');await wait(`document.querySelector('#create-dialog').open`);await compare('create-user','#create-dialog');await checkHelp('#create-dialog .help-toggle[aria-controls="create-password-change-help"]');
 await both(`{const f=document.querySelector('#create-user');f.elements.login.value='missing';f.elements.password.value=f.elements.confirmation.value='new password!';f.requestSubmit();}`);
 await wait(`!!document.querySelector('#new-login').validationMessage`);await compare('create-user-error','#create-dialog');
 await both(`parity.pending='/api/auth/users';parity.pendingMethod='POST';{const f=document.querySelector('#create-user');f.elements.login.dispatchEvent(new Event('input',{bubbles:true}));f.elements.password.value=f.elements.confirmation.value='new password!';f.requestSubmit();}`);await wait(`typeof parity.release==='function'`);await compare('create-user-busy','#create-dialog');
 await click('#create-dialog .native-management-close');await wait(`document.querySelector('#create-dialog').open`);
 await both(`parity.pending=false;parity.release();delete parity.release`);await wait(`!document.querySelector('#cancel-create').disabled`);await tap('#cancel-create');
 await click('#users button[aria-label="Edit bob"]');await wait(`document.querySelector('#edit-dialog').open`);await compare('edit-user','#edit-dialog');await both(`document.querySelector('#edit-user').requestSubmit()`);await wait(`!!document.querySelector('#edit-status').textContent`);await compare('edit-user-error','#edit-dialog');
 await click('#revoke-sessions');await compare('close-sessions','#revoke-confirmation');await click('#cancel-revoke');
 await click('#unlink-oidc');await compare('admin-unlink-confirmation','#edit-dialog');await click('#confirm-unlink');await wait(`!!document.querySelector('#edit-status').textContent`);await compare('admin-unlink-error','#edit-dialog');await click('#cancel-unlink');
 await click('#reset-password');await compare('reset-prompt','#reset-dialog');await both(`parity.failOperation='/api/auth/users/reset-password'`);await click('#generate-reset');await wait(`!!document.querySelector('#reset-status').textContent`);await compare('reset-error','#reset-dialog');await both(`parity.failOperation=false`);await click('#generate-reset');await wait(`!document.querySelector('#reset-result').hidden`);await compare('reset-secret','#reset-dialog');
 await both(`document.querySelector('#copy-feedback').textContent='Copied!'`);await compare('reset-copied','#reset-dialog');await click('#close-reset');
 await click('#set-password');await compare('admin-set-password','#password-dialog');await click('#cancel-password');await click('#cancel-edit');
 await both(`parity.failOperation='/api/auth/users/delete'`);await click('#users button[aria-label="Delete bob"]');await wait(`!!document.querySelector('#delete-status').textContent&&!document.querySelector('#delete-status').textContent.includes('Loading')`);await compare('delete-preview-error','#delete-dialog');await tap('#cancel-delete');await both(`parity.failOperation=false;parity.deletionStarted=true`);await click('#users button[aria-label="Delete bob"]');await wait(`document.querySelector('#delete-vaults').children.length>0`);await compare('delete-in-progress','#delete-dialog');await tap('#cancel-delete');await both(`parity.deletionStarted=false`);await click('#users button[aria-label="Delete bob"]');await wait(`document.querySelector('#delete-vaults').children.length>0`);await compare('delete-user','#delete-dialog');await tap('#cancel-delete');
 await both(`parity.recent=false`);await click('#add-user');await wait(`document.querySelector('#reauth-dialog').open`);await compare('reauth','#reauth-dialog');
 const reauthLayout=()=>Promise.all([native,shell].map(client=>client.run(`JSON.stringify([document.querySelector('#reauth-dialog'),document.querySelector('#cancel-reauth'),document.querySelector('#reauth-form button[type=submit]')].map(el=>el.getBoundingClientRect().toJSON()))`)));
 const beforeReauthError=await reauthLayout();
 await both(`{const f=document.querySelector('#reauth-form');f.elements.password.value='incorrect';f.requestSubmit();}`);await wait(`document.querySelector('#reauth-password').validationMessage==='Incorrect password'`);await compare('reauth-error','#reauth-dialog');
 assert.deepEqual(await reauthLayout(),beforeReauthError,'reauth error must not move the window or its buttons');
 await both(`document.querySelector('#reauth-password').dispatchEvent(new Event('input',{bubbles:true}))`);
 for(const client of [native,shell])assert.equal(await client.run(`document.querySelector('#reauth-password').validity.customError`),false,'typing clears the reauth error');
 await tap('#cancel-reauth');await both(`parity.recent=true`);
 await open('shares');await wait(`!!document.querySelector('#owned button')`);await compare('shares','.modal:has(.ignis-management-root)');
 await click('#new-share');await wait(`!!document.querySelector('#picker .resource-tree-select')`);await compare('share-create','#create-dialog');
 await click('#picker .resource-tree-select[data-path="Note.md"]');await both(`{document.querySelector('#recipient').value='missing';document.querySelector('#create-form').requestSubmit();}`);await wait(`!!document.querySelector('#recipient').validationMessage`);await compare('share-error','#create-dialog');await click('[data-close="create-dialog"]');
 await click('#owned button[aria-label="Edit"]');await compare('manage-resource','#manage-dialog');await both(`{const s=document.querySelector('#grants select');s.value='editor';s.dispatchEvent(new Event('change'));}`);await click('#save-resource');await wait(`!!document.querySelector('#manage-dialog .error').textContent`);await compare('manage-resource-error','#manage-dialog');await click('#add-access');await compare('grant','#grant-dialog');
 await both(`{document.querySelector('#grant-login').value='missing';document.querySelector('#grant-form').requestSubmit();}`);await wait(`!!document.querySelector('#grant-login').validationMessage`);await compare('grant-error','#grant-dialog');await tap('[data-close="grant-dialog"]');await click('[data-close="manage-dialog"]');
 await click('#owned button[aria-label="Delete"]');await compare('stop-sharing','.ui-dialog.ignis-confirm[open]');await click('.ui-dialog.ignis-confirm[open] .danger');await wait(`!document.querySelector('.ui-dialog.ignis-confirm[open]')&&!!document.querySelector('#status').textContent`);await compare('stop-sharing-error','.modal:has(.ignis-management-root)');
 await click('#share-tab-1');await click('#received button');await wait(`!!document.querySelector('#location-tree button')`);await compare('location','#location-dialog');await both(`document.querySelector('#location-form').requestSubmit()`);await wait(`!!document.querySelector('#location-dialog .error').textContent`);await compare('location-error','#location-dialog');
 await both(`{const s=document.querySelector('#destination-vault');s.value='';s.dispatchEvent(new Event('change'));}`);await compare('location-unassigned','#location-dialog');await click('[data-close="location-dialog"]');
 await both(`parity.noVaults=true`);await open('shares');await wait(`!!document.querySelector('#workspace')&&!document.querySelector('#workspace').hidden`);await compare('shares-no-vaults','.modal:has(.ignis-management-root)');
 await click('#share-tab-1');await click('#received button');await compare('location-no-vaults','#location-dialog');await click('[data-close="location-dialog"]');
 await both(`parity.empty=true`);await open('users');await wait(`!!document.querySelector('#administration')&&!document.querySelector('#administration').hidden`);await compare('users-empty','.modal:has(.ignis-management-root)');
 await open('shares');await wait(`!!document.querySelector('#workspace')&&!document.querySelector('#workspace').hidden`);await compare('shares-empty','.modal:has(.ignis-management-root)');
 await both(`parity.fail=true`);await open('users');await wait(`!!document.querySelector('#status').textContent`);await compare('users-load-error','.modal:has(.ignis-management-root)');
 await open('shares');await wait(`!!document.querySelector('#status').textContent`);await compare('shares-load-error','.modal:has(.ignis-management-root)');
 await both(`parity.fail=false;parity.local=false`);await open('password');await wait(`document.querySelector('#password-dialog').open`);await compare('own-set-password','#password-dialog');
 await both(`{const f=document.querySelector('#password-form');f.elements.newPassword.value='new password!';f.elements.confirmation.value='different';f.requestSubmit();}`);await compare('own-set-password-error','#password-dialog');await both(`{const f=document.querySelector('#password-form');f.elements.confirmation.value=f.elements.newPassword.value='new password!';f.elements.confirmation.dispatchEvent(new Event('input',{bubbles:true}));f.requestSubmit();}`);await wait(`!!document.querySelector('#new-password').validationMessage`);await compare('own-set-password-server-error','#password-dialog');
 await close();
 for(const client of [native,shell])assert.deepEqual(client.errors.slice(errorStarts.get(client)).filter(error=>typeof error==='string'),[],'no uncaught browser exceptions in management states');
 }
 // A failed provider link uses a Notice, not a field error. It must be above Settings.
 if(mobile)for(const client of [native,shell])await client.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await native.call('Page.navigate',{url:origin+'/?vault='+vault+'&parityLink=1'});await native.wait(`!!window.__ignisOpenManagement`,'native provider-link host');
 await shell.call('Page.navigate',{url:origin+'/?parityLink=1'});await shell.wait(`!!window.IgnisUI&&!window.app?.workspace`,'shell provider-link host');
 errorStarts=new Map([native,shell].map(client=>[client,client.errors.length]));
 await both(`parity.ready=true;document.body.classList.remove('theme-light');document.body.classList.add('theme-dark')`);
 await open('account');if(dimensions)for(const client of [native,shell])await client.call('Emulation.setDeviceMetricsOverride',{width:dimensions[0],height:dimensions[1],deviceScaleFactor:1,mobile});
 await wait(`!!Array.from(document.querySelectorAll('.setting-item')).find(el=>el.querySelector('.setting-item-name')?.textContent==='OpenID Connect')`);
 await compare('account-link-provider','.modal.mod-settings .vertical-tab-content');await row('OpenID Connect');
 await wait(`Array.from(document.querySelectorAll('.notice')).some(el=>el.textContent.trim()==='Request failed')`);await both(`Array.from(document.querySelectorAll('.notice')).find(el=>el.textContent.trim()==='Request failed').dataset.parityLinkError='true'`);await compare('provider-link-error','.notice[data-parity-link-error]');
 for(const client of [native,shell])assert.equal(await client.run(`(()=>{const notice=document.querySelector('.notice[data-parity-link-error]'),r=notice.getBoundingClientRect();return !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.notice')})()`),true,'Notice is above the settings layer');
 await both(`document.querySelector('.notice[data-parity-link-error]').click()`);for(const client of [native,shell])await client.wait(`!document.querySelector('.notice[data-parity-link-error]')`,'notice dismissed by click',2000);await close();
 for(const client of [native,shell])assert.deepEqual(client.errors.slice(errorStarts.get(client)).filter(error=>typeof error==='string'),[],'no uncaught browser exceptions');
 if(output)fs.writeFileSync(path.join(output,`parity-${report.viewport}${noticesOnly?'-notices':''}.json`),JSON.stringify(report,null,2));
 console.log(JSON.stringify({managementParity:mobile?'mobile':'desktop',viewport:report.viewport,states:report.states.length,differences:report.differences}));
 await uiComponents([native,shell]);
 assert.deepEqual(report.differences,[],'Native / zero-vault presentation differs');
 return report;
}
