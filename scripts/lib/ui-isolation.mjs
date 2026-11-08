import assert from 'node:assert/strict';
// Compare the original windows with our layout sheets enabled and disabled.
// Same DOM, theme and viewport: this detects cascade leaks, not screenshot noise.
export async function uiIsolation(clients) {
 for(const client of clients){
  await client.run(`{window.isolationSheets=()=>[document.getElementById('ignis-ui-layout'),document.getElementById('ignis-account-form-styles'),document.getElementById('ignis-recovery-notice-style'),document.querySelector('link[href="/auth/entry.css"]')].filter(Boolean);window.isolationMetric=(root,shallow=false)=>(shallow?[root]:[root,...root.querySelectorAll('*')]).filter(el=>el.getClientRects().length).map(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return [el.tagName,el.getAttribute('class'),r.x,r.y,r.width,r.height,...['display','position','zIndex','fontSize','fontFamily','lineHeight','color','backgroundColor','padding','margin','border','borderRadius','boxShadow','overflow','overflowX','overflowY','contain','boxSizing','minHeight','maxHeight','userSelect'].map(key=>s[key])];});}`);
  await client.run(`new Promise((resolve,reject)=>{if(document.querySelector('link[href="/auth/entry.css"]'))return resolve();const link=document.createElement('link');link.rel='stylesheet';link.href='/auth/entry.css';link.onload=resolve;link.onerror=reject;document.head.append(link);})`);
  await client.run(`IgnisUI.showVaultManager()`);
  await client.wait(`!!document.querySelector('.vault-manager-overlay .modal-shell')`,'original manager');
  const roots=[
   {name:'Vault manager',selector:'.vault-manager-overlay .modal-shell'},
   {name:'Prompt',type:'PromptDialog',selector:'.prompt-body',props:{title:'Original prompt',value:'Name'}},
   {name:'Confirmation',type:'ConfirmDialog',selector:'.confirm-body',props:{title:'Original confirmation',message:'Confirm?'}},
   {name:'Message',type:'MessageDialog',selector:'.message-body',props:{message:'Original message'}},
   {name:'Rules',type:'RecordEditor',selector:'.backdrop',props:{record:{name:'Original rules',patterns:['one/*']}}},
   {name:'Ignore rules',type:'IgnoreRulesEditor',selector:'.backdrop',props:{rules:[],suggestions:[]}},
   {name:'Excluded folders',type:'ExcludedFoldersEditor',selector:'.backdrop',props:{folders:['one'],excluded:[]}},
  ];
  for(const entry of roots){
   if(entry.type){await client.run(`window.isolationCase=new IgnisUI[${JSON.stringify(entry.type)}]({target:document.body,props:${JSON.stringify(entry.props||{})}});void 0`);}
   await client.wait(`!!document.querySelector(${JSON.stringify(entry.selector)})`,'original '+entry.name);
   const expression=`isolationMetric((()=>{const el=document.querySelector(${JSON.stringify(entry.selector)});return el.closest('.modal-shell,.backdrop') || el;})())`;
   const frameExpression=expression;
   const completeExpression=`({frame:${frameExpression},page:[isolationMetric(document.documentElement,true),isolationMetric(document.body,true)]})`;
   const measured=await client.run(`(()=>{isolationSheets().forEach(style=>style.sheet.disabled=true);const baseline=${completeExpression};isolationSheets().forEach(style=>style.sheet.disabled=false);return {baseline,current:${completeExpression}};})()`);
   assert.deepEqual(measured.current,measured.baseline,entry.name+': our styles must not alter upstream geometry or presentation');
   if(entry.type)await client.run(`isolationCase.$destroy();void 0`);
  }
  if(await client.run(`!!window.__ignisUiRuntime`)){
   await client.run(`{const runtime=__ignisUiRuntime;window.isolationNativeModal=new runtime.Modal(runtime.app);isolationNativeModal.onOpen=()=>{isolationNativeModal.setTitle('Original native modal');new runtime.TextComponent(isolationNativeModal.contentEl).setValue('Text');new runtime.DropdownComponent(isolationNativeModal.contentEl).addOption('one','One');new runtime.ButtonComponent(isolationNativeModal.contentEl).setButtonText('Original action');};isolationNativeModal.open();window.isolationNativeNotice=new runtime.Notice('Original upstream notice',0);void 0;}`);
   await client.run(`Promise.allSettled(document.getAnimations().map(animation=>animation.finished))`);
   const expression=`({modal:isolationMetric(isolationNativeModal.modalEl),notice:isolationMetric(isolationNativeNotice.noticeEl.closest('.notice-container'))})`;
   const measured=await client.run(`(()=>{isolationSheets().forEach(style=>style.sheet.disabled=true);const baseline=${expression};isolationSheets().forEach(style=>style.sheet.disabled=false);return {baseline,current:${expression}};})()`);
   assert.deepEqual(measured.current,measured.baseline,'our styles must not alter native Obsidian modals, controls or notice layers');
   const nativeLayer=await client.run(`(()=>{const container=isolationNativeNotice.noticeEl.closest('.notice-container');return {className:container.className,zIndex:getComputedStyle(container).zIndex};})()`);
   await client.run(`[...document.querySelectorAll('.vault-manager-overlay .footer-right button')].find(button=>button.textContent.trim()==='Import vault').click()`);
   await client.wait(`!!document.querySelector('.ignis-import-wizard')`,'our import form');
   await client.run(`{const root=document.querySelector('.ignis-import-wizard'),source=root.querySelector('select');source.value='folder';source.dispatchEvent(new Event('change'));root.querySelector('input[type=file]').dispatchEvent(new Event('change'));}`);
   try{await client.wait(`!!document.querySelector('.ignis-management-notices .notice')`,'our isolated native notice',2000);}catch(error){console.error(await client.run(`({notices:[...document.querySelectorAll('.notice')].map(el=>el.outerHTML),wizard:!!document.querySelector('.ignis-import-wizard'),blocked:__ignisAuth.blocked,noticeClass:String(__ignisUiRuntime.Notice).slice(0,120)})`));throw error;}
   assert.deepEqual(await client.run(`(()=>{const container=isolationNativeNotice.noticeEl.closest('.notice-container');return {className:container.className,zIndex:getComputedStyle(container).zIndex};})()`),nativeLayer,'our notices do not restyle or move upstream notices');
   await client.run(`Promise.allSettled(document.getAnimations().map(animation=>animation.finished))`);
   assert.equal(await client.run(`(()=>{const notice=document.querySelector('.ignis-management-notices .notice'),r=notice.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.ignis-management-notices');})()`),true,'our notice stays visible above the unchanged manager');
   await client.run(`document.querySelector('.ignis-management-notices .notice').click()`);
   await client.wait(`!document.querySelector('.ignis-management-notices')`,'our empty notice layer is disposed');
   await client.run(`document.querySelector('.ignis-import-wizard').querySelector('.modal-close-button,.modal-header-button:not(.mod-start)').click()`);
   await client.run(`isolationNativeNotice.hide();isolationNativeModal.close();void 0`);
  }
  await client.run(`document.querySelector('.vault-manager-overlay .close-btn').click()`);
 }
 console.log(JSON.stringify({uiIsolation:'passed',hosts:clients.length,checks:['original manager','original dialogs and rule editors','native Obsidian controls and notices when available','no inherited style changes']}));
}
