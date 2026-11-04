import {vaultExportUi} from './vault-export-ui.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
async function zip(){const archive=require('archiver')('zip',{zlib:{level:6}}),chunks=[];archive.on('data',b=>chunks.push(b));const done=new Promise((resolve,reject)=>{archive.on('end',resolve);archive.on('error',reject);});archive.append('',{name:'Original/'});archive.append('',{name:'Original/Empty/'});archive.append('from zip',{name:'Original/Zip.md'});archive.append('{}',{name:'Original/.obsidian/workspace.json'});archive.append('evil code',{name:'Original/.obsidian/plugins/evil/main.js'});await archive.finalize();await done;return Buffer.concat(chunks).toString('base64');}
export async function vaultImportUi({native,shell}){
 const temporary=[];try{
 for(const [client,kind,name] of [[native,'folder','Folder import'],[shell,'legacy','Dropped folder'],[shell,'traditional','Folder picker import'],[shell,'zip','ZIP import']]){
  await client.run(`{window.importReplies=[];window.loseImportReview=true;window.loseImportSelection=true;window.lostImportSelection=false;window.loseImportFile=true;window.loseImportCommit=true;const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/vault/import/')){const path=String(args[0]).split('?')[0];importReplies.push({path,status:response.status,body:await response.clone().json()});if(response.ok&&(path.endsWith('/start')||path.endsWith('/zip'))&&window.loseImportReview){window.loseImportReview=false;window.lostImportReview=true;throw Error('Synthetic lost review response');}if(response.ok&&path.endsWith('/select')&&window.loseImportSelection){window.loseImportSelection=false;window.lostImportSelection=true;throw Error('Synthetic lost selection response');}if(response.ok&&path.endsWith('/file')&&window.loseImportFile){window.loseImportFile=false;window.lostImportFile=true;throw Error('Synthetic lost upload response');}if(response.ok&&path.endsWith('/commit')&&window.loseImportCommit){window.loseImportCommit=false;window.lostImportCommit=true;throw Error('Synthetic lost commit response');}}return response;};}`);
  if(kind==='folder')await client.run(`{const folder=(name,children)=>({kind:'directory',name,async *values(){yield* children;}}),file=(name,text)=>({kind:'file',name,getFile:async()=>new File([text],name)});window.showDirectoryPicker=async()=>folder('Original',[folder('Empty',[]),file('Note.md','from folder'),file('Empty.md',''),folder('.obsidian',[file('app.json','{"vimMode":true}'),file('appearance.json','{}'),file('core-plugins.json','{"file-explorer":true,"workspaces":false}'),file('workspace.json','{"main":{"type":"split","children":[]}}'),folder('plugins',[folder('evil',[file('main.js','evil code')])])])]);}`);
  else await client.run(`window.showDirectoryPicker=undefined`);
  if(client===native){
   await client.run(`window.__ignisOpenManagement('account')`);
   await client.wait(`Array.from(document.querySelectorAll('.setting-item-name')).some(el=>el.textContent==='Import vault')`,'import account entry');
   await client.run(`Array.from(document.querySelectorAll('.setting-item')).find(el=>el.querySelector('.setting-item-name')?.textContent==='Import vault').querySelector('button').click()`);
  }else{
   await client.wait(`Array.from(document.querySelectorAll('.vault-manager-overlay .footer-right button')).some(el=>el.textContent.trim()==='Import vault')`,'manager import entry');
   await client.run(`Array.from(document.querySelectorAll('.vault-manager-overlay .footer-right button')).find(el=>el.textContent.trim()==='Import vault').click()`);
  }
  await client.wait(`!!document.querySelector('.ignis-import-wizard')`,'import wizard');
  const picture=async step=>{const {data}=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/ignis-import-'+(client===native?'native':kind==='legacy'?'shell-folder':'shell')+'-'+(process.argv.includes('--mobile')?'mobile':'desktop')+'-'+step+'.png',Buffer.from(data,'base64'));};
  await picture('source');
  assert.equal(await client.run(`document.querySelector('[data-import-next]').disabled`),true,'Next is disabled without a selection');
  assert.deepEqual(await client.run(`Array.from(document.querySelector('.ignis-import-wizard select').options).map(option=>option.value)`),['zip','folder'],'ZIP is the first source option');
  assert.equal(await client.run(`document.querySelector('.ignis-import-wizard select').value`),'zip','ZIP is selected by default');
  if(kind!=='zip')await client.run(`{const source=document.querySelector('.ignis-import-wizard select');source.value='folder';source.dispatchEvent(new Event('change'));}`);
  if(kind==='folder'){
   await client.run(`document.querySelector('[data-import-drop]').click()`);
   await client.wait(`!document.querySelector('[data-import-next]').disabled`,'folder metadata collected');
   await client.run(`{const source=document.querySelector('.ignis-import-wizard select');source.value='zip';source.dispatchEvent(new Event('change'));}`);
   assert.equal(await client.run(`document.querySelector('[data-import-next]').disabled`),true,'changing source clears selection');
   await client.run(`{const source=document.querySelector('.ignis-import-wizard select');source.value='folder';source.dispatchEvent(new Event('change'));document.querySelector('[data-import-drop]').click();}`);
   await client.wait(`!document.querySelector('[data-import-next]').disabled`,'folder reselected');
  }else if(kind==='legacy'||kind==='traditional'){
   assert.equal(await client.run(`document.querySelector('.ignis-import-wizard option[value=folder]').disabled`),false,'folder remains enabled without showDirectoryPicker');
   const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-folder-drop-'));temporary.push(directory);const root=path.join(directory,'Original');
   fs.mkdirSync(path.join(root,'.obsidian','plugins','evil'),{recursive:true});fs.mkdirSync(path.join(root,'Empty'));fs.mkdirSync(path.join(root,'Batch'));fs.mkdirSync(path.join(root,'ZEmpty'));
   fs.writeFileSync(path.join(root,'Note.md'),'from drop');fs.writeFileSync(path.join(root,'Empty.md'),'');fs.writeFileSync(path.join(root,'.obsidian','app.json'),'{}');fs.writeFileSync(path.join(root,'.obsidian','plugins','evil','main.js'),'evil code');
   for(let i=0;i<105;i++)fs.writeFileSync(path.join(root,'Batch',`Note-${i}.md`),'batch note');
   const point=await client.run(`{const r=document.querySelector('.ignis-import-drop').getBoundingClientRect();({x:r.x+r.width/2,y:r.y+r.height/2})}`);
   if(kind==='legacy'){
    for(const type of ['dragEnter','dragOver','drop'])await client.call('Input.dispatchDragEvent',{type,...point,data:{items:[],files:[root],dragOperationsMask:1}});
   }else{
    assert.equal(await client.run(`document.querySelector('[data-import-drop]').hidden`),false,'folder drop area remains visible');
    assert.ok(await client.run(`document.querySelector('.ignis-import-wizard').innerText.includes('This folder picker does not report empty folders.')`),'traditional picker explains empty-folder limitation');
    assert.equal(await client.run(`document.querySelector('[data-import-drop]').textContent`),'Click here or drop a folder');
    await client.run(`{window.folderPickerClicks=0;document.querySelector('.ignis-import-wizard input[type=file]').addEventListener('click',event=>{window.folderPickerClicks++;event.preventDefault();});document.querySelector('[data-import-drop]').click();document.querySelector('[data-import-drop]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}`);
    assert.equal(await client.run(`window.folderPickerClicks`),2,'folder area opens the picker by click and keyboard');
    assert.equal(await client.run(`Array.from(document.querySelectorAll('.ignis-import-wizard button')).some(el=>el.textContent==='Select source')`),false,'no separate source button');
    const document=await client.call('DOM.getDocument'),input=await client.call('DOM.querySelector',{nodeId:document.root.nodeId,selector:'.ignis-import-wizard input[type=file]'});
    await client.call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[root]});
   }
   await client.wait(`!document.querySelector('[data-import-next]').disabled`,'real local directory metadata collected');
  }else{
   await client.run(`{const source=document.querySelector('.ignis-import-wizard select');source.value='zip';source.dispatchEvent(new Event('change'));}`);
   assert.equal(await client.run(`document.querySelector('[data-import-drop]').textContent`),'Click here or drop a ZIP file.');
   await client.run(`{window.zipPickerClicks=0;document.querySelector('.ignis-import-wizard input[type=file]').addEventListener('click',event=>{window.zipPickerClicks++;event.preventDefault();});document.querySelector('[data-import-drop]').click();}`);
   assert.equal(await client.run(`window.zipPickerClicks`),1,'ZIP drop area opens the file picker');
   const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-zip-drop-'));temporary.push(directory);const archive=path.join(directory,'Original.zip');fs.writeFileSync(archive,Buffer.from(await zip(),'base64'));
   // Synthetic lost-response notices from earlier scenarios cover the mobile
   // drop target. Dismiss them just as a user would before a coordinate drag.
   await client.run(`document.querySelectorAll('.notice').forEach(el=>el.click())`);
   const point=await client.run(`{const r=document.querySelector('[data-import-drop]').getBoundingClientRect();({x:r.x+r.width/2,y:r.y+r.height/2})}`);
   assert.equal(await client.run(`document.elementFromPoint(${point.x},${point.y})?.closest('[data-import-drop]')===document.querySelector('[data-import-drop]')`),true,'ZIP drop target is not covered');
   await client.run(`{window.zipDragEvents=[];const zone=document.querySelector('[data-import-drop]');for(const type of ['dragenter','dragover','drop'])zone.addEventListener(type,event=>zipDragEvents.push({type,x:event.clientX,y:event.clientY,files:[...(event.dataTransfer?.files||[])].map(f=>f.name)}));}`);
   for(const type of ['dragEnter','dragOver','drop'])await client.call('Input.dispatchDragEvent',{type,...point,data:{items:[],files:[archive],dragOperationsMask:1}});
   try{await client.wait(`!document.querySelector('[data-import-next]').disabled`,'real ZIP drop selected');}catch(error){console.error(await client.run(`({text:document.querySelector('.ignis-import-wizard')?.innerText,mode:document.querySelector('.ignis-import-wizard select')?.value,events:window.zipDragEvents,notices:[...document.querySelectorAll('.notice')].map(el=>el.textContent),rect:document.querySelector('[data-import-drop]')?.getBoundingClientRect().toJSON(),size:[innerWidth,innerHeight],atPoint:document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,300)})`));await picture('zip-drop-failure');throw error;}

  }
  assert.equal(await client.run(`document.querySelector('.ignis-import-selection strong').textContent`),kind==='zip'?'Original.zip':'Original');
  assert.equal(await client.run(`{const el=document.querySelector('.ignis-import-selection strong');parseInt(getComputedStyle(el).fontWeight)>parseInt(getComputedStyle(el.parentElement).fontWeight)}`),true,'selected source stands out');
  await picture('selection');
  await client.run(`{const root=document.querySelector('.ignis-import-wizard');root.querySelector('[data-import-next]').click();root.querySelector('input[type=text]').value='Owner';}`);
  const nameLayout=await client.run(`{const root=document.querySelector('.ignis-import-wizard'),button=root.querySelector('[data-import-next]');({height:root.offsetHeight,width:root.offsetWidth,buttonTop:button.offsetTop})}`);
  await client.run(`document.querySelector('[data-import-next]').click()`);
  await client.wait(`document.querySelector('.ignis-import-wizard input[type=text]').validationMessage==='A vault with this name already exists.'&&!document.querySelector('[data-import-next]').disabled`,'name collision is reported on the name field before review');
  assert.equal(await client.run(`document.querySelector('[data-import-next]').textContent`),'Review import','collision keeps the name step open');
  assert.deepEqual(await client.run(`{const root=document.querySelector('.ignis-import-wizard'),button=root.querySelector('[data-import-next]');({height:root.offsetHeight,width:root.offsetWidth,buttonTop:button.offsetTop})}`),nameLayout,'name warning does not resize the dialog or move buttons');
  await picture('name-collision');
  await client.run(`{const root=document.querySelector('.ignis-import-wizard'),input=root.querySelector('input[type=text]');input.value=${JSON.stringify(name)};input.dispatchEvent(new Event('input',{bubbles:true}));root.querySelector('input[type=checkbox]').checked=${kind==='folder'||kind==='zip'};root.querySelector('[data-import-next]').click();}`);
  await client.wait(`window.lostImportReview && !document.querySelector('[data-import-next]')?.disabled`,'lost review response returns control');
  await client.run(`document.querySelector('[data-import-next]').click()`);
  await client.wait(`document.querySelector('[data-import-next]')?.textContent==='Import'`,'import review');
  await picture('review');
  const excluded=kind==='folder'?6:kind==='zip'?2:5;
  assert.equal(await client.run(`document.querySelector('[data-import-exclusions]').textContent`),'Excluded: '+excluded);
  const before=await client.run(`{const el=document.querySelector('.ignis-import-wizard');({height:el.offsetHeight,width:el.offsetWidth})}`);
  await client.run(`document.querySelectorAll('.notice').forEach(el=>el.click());document.querySelector('[data-import-exclusions]').click()`);
  await client.wait(`!!document.querySelector('.ignis-import-exclusions')`,'excluded items open in separate modal');
  assert.equal(await client.run(`{const wizard=document.querySelector('.ignis-import-wizard'),list=document.querySelector('.ignis-import-exclusions');!wizard.contains(list)&&wizard.closest('.modal-container')!==list.closest('.modal-container')}`),true);
  assert.equal(await client.run(`document.querySelectorAll('.ignis-import-exclusion-list li').length`),excluded);
  await picture('exclusions');
  assert.ok(await client.run(`document.querySelector('.ignis-import-exclusion-list').innerText.includes('main.js')`));
  assert.deepEqual(await client.run(`{const el=document.querySelector('.ignis-import-wizard');({height:el.offsetHeight,width:el.offsetWidth})}`),before,'opening exclusions does not resize the import view');
  assert.equal(await client.run(`document.querySelectorAll('.ignis-import-exclusions input[type=search]').length`),0,'exclusions viewer has no search field');
  assert.equal(await client.run(`Array.from(document.querySelectorAll('.ignis-import-exclusion-list li')).find(el=>el.textContent.includes('main.js')).querySelector('input').disabled`),true,'executable plugins remain protected');
  assert.deepEqual(await client.run(`{const row=Array.from(document.querySelectorAll('.ignis-import-exclusion-list li')).find(el=>el.textContent.includes('main.js')),input=row.querySelector('input'),label=row.querySelector('label');input.click();label.click();({checked:input.checked,muted:Number(getComputedStyle(input).opacity)<0.5,cursor:getComputedStyle(label).cursor,explained:row.textContent.includes('Not selectable')})}`),{checked:false,muted:true,cursor:'not-allowed',explained:true},'protected checkboxes are visibly disabled and cannot be toggled');
  assert.equal(await client.run(`document.querySelector('[data-import-select-all]').textContent`),'Select all');
  await client.run(`document.querySelector('[data-import-select-all]').click()`);
  assert.equal(await client.run(`Array.from(document.querySelectorAll('.ignis-import-exclusions input')).every(input=>input.checked===!input.disabled)`),true,'select all only checks permitted entries');
  assert.equal(await client.run(`document.querySelector('[data-import-select-all]').textContent`),'Deselect all');
  await client.run(`document.querySelector('[data-import-select-all]').click()`);
  assert.equal(await client.run(`document.querySelectorAll('.ignis-import-exclusions input:checked').length`),0,'deselect all clears the selection');
  if(kind==='folder'){
   await client.run(`document.querySelector('[data-import-select-all]').click();document.querySelector('.ignis-import-exclusions .mod-cta').click()`);
   await client.wait(`window.lostImportSelection&&!document.querySelector('.ignis-import-exclusions .mod-cta').disabled`,'lost native preference selection can be retried');
   await client.run(`document.querySelector('.ignis-import-exclusions .mod-cta').click()`);
   await client.wait(`!document.querySelector('.ignis-import-exclusions')&&!document.querySelector('[data-import-next]').disabled`,'native appearance, core and workspace preferences apply together');
   assert.equal(await client.run(`document.querySelector('[data-import-exclusions]').textContent`),'Excluded: 3');
   await client.run(`document.querySelector('[data-import-exclusions]').click()`);
   assert.equal(await client.run(`document.querySelectorAll('.ignis-import-exclusions input:checked').length`),3,'all three native preferences stay selected');
  }
  if(kind==='traditional'||kind==='legacy'||kind==='zip'){
   await client.run(`document.querySelector('.ignis-import-exclusions input:not(:disabled)').click();document.querySelector('.ignis-import-exclusions .mod-cta').click()`);
   await client.wait(`window.lostImportSelection&&!document.querySelector('.ignis-import-exclusions .mod-cta').disabled`,'lost selection response can be retried');
   assert.equal(await client.run(`document.querySelector('.ignis-import-exclusions input:not(:disabled)').checked`),true);
   await client.run(`document.querySelector('.ignis-import-exclusions .mod-cta').click()`);
   try{await client.wait(`!document.querySelector('.ignis-import-exclusions')&&!document.querySelector('[data-import-next]').disabled`,'excluded preference selection applies');}catch(error){console.error(await client.run(`({replies:importReplies,text:document.querySelector('.ignis-import-exclusions')?.innerText})`));throw error;}
   assert.equal(await client.run(`document.querySelector('[data-import-exclusions]').textContent`),'Excluded: '+(excluded-1));
   await client.run(`document.querySelector('[data-import-exclusions]').click()`);
   assert.equal(await client.run(`document.querySelector('.ignis-import-exclusions input:not(:disabled)').checked`),true,'applied choice persists');
   await client.run(`document.querySelector('.ignis-import-exclusions input:not(:disabled)').click();document.querySelector('.ignis-import-exclusions .mod-cta').click()`);
   await client.wait(`!document.querySelector('.ignis-import-exclusions')&&!document.querySelector('[data-import-next]').disabled`,'preference deselection applies');
   assert.equal(await client.run(`document.querySelector('[data-import-exclusions]').textContent`),'Excluded: '+excluded);
   await client.run(`document.querySelector('[data-import-exclusions]').click();document.querySelector('.ignis-import-exclusions input:not(:disabled)').click();document.querySelector('.ignis-import-exclusions .mod-cta').click()`);
   await client.wait(`!document.querySelector('.ignis-import-exclusions')&&!document.querySelector('[data-import-next]').disabled`,'keep optional preference for final import');
   await client.run(`document.querySelector('[data-import-exclusions]').click()`);
  }
  await client.run(`document.querySelector('.ignis-import-exclusions .modal-button-container button').click()`);
  await client.wait(`!document.querySelector('.ignis-import-exclusions')`,'excluded list closes without closing import');
  await client.run(`document.querySelector('[data-import-next]').click()`);
  if(kind!=='zip'){
   await client.wait(`window.lostImportFile && !document.querySelector('[data-import-next]')?.disabled`,'lost upload response returns control');
   await client.run(`document.querySelector('[data-import-next]').click()`);
  }
  await client.wait(`window.lostImportCommit && !document.querySelector('[data-import-next]')?.disabled`,'lost commit response returns control');
  await client.run(`document.querySelector('[data-import-next]').click()`);
  try{await client.wait(`!!document.querySelector('.ignis-import-wizard').innerText.includes('Vault imported successfully.')`,'import publication');}catch(error){console.error(await client.run(`({replies:importReplies,text:document.querySelector('.ignis-import-wizard')?.innerText})`));throw error;}
  await picture('complete');
  const result=await client.run(`(async()=>{const list=await(await fetch('/api/vault/list')).json();return list.find(item=>item.name===${JSON.stringify(name)});})()`);
  assert.ok(result,'new vault appears in current user catalog');
  if(client===shell)await client.wait(`document.querySelector('.vault-manager-overlay')?.innerText.includes(${JSON.stringify(name)})`,'zero-vault manager refreshes after import');
  const file=kind==='zip'?'Zip.md':'Note.md',content=kind==='zip'?'from zip':kind==='folder'?'from folder':'from drop';
  const restored=await vaultExportUi(client,result,{native:client===native,file,content,emptyFolders:kind!=='traditional'});
  if(kind==='folder'){
   assert.equal(restored['.obsidian/appearance.json'],'{}');
   assert.deepEqual(JSON.parse(restored['.obsidian/core-plugins.json']),{'file-explorer':true,workspaces:false});
   assert.deepEqual(JSON.parse(restored['.obsidian/workspace.json']),{main:{type:'split',children:[]}});
  }
  if(['legacy','traditional','zip'].includes(kind))assert.ok(Object.hasOwn(restored,kind==='zip'?'.obsidian/workspace.json':'.obsidian/app.json'),'checked preference is present in the completed vault');
  if(kind==='legacy'||kind==='traditional'){
   await client.run(`Array.from(document.querySelectorAll('.ignis-import-wizard button')).find(el=>el.textContent==='Close').click()`);
   await client.wait(`!document.querySelector('.ignis-import-wizard')`,'close import without opening vault');
   assert.equal(await client.run(`!!window.app?.workspace`),false,'manager import also works without an open vault');
   const buttons=await client.run(`Array.from(document.querySelectorAll('.vault-manager-overlay .footer-right button')).map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent.trim(),x:r.x,y:r.y,width:r.width};})`);
   const importing=buttons.find(b=>b.text==='Import vault'),creating=buttons.find(b=>b.text==='Create New Vault');assert.ok(importing&&creating,'manager offers import beside create');
   if(process.argv.includes('--mobile')){assert.ok(importing.width>300&&creating.width>300,'manager actions use full mobile width');assert.ok(creating.y<importing.y,'mobile manager actions use separate rows');}
   else assert.ok(importing.x<creating.x&&Math.abs(importing.y-creating.y)<2,'desktop import sits beside create');

   continue;
  }
  await client.run(`Array.from(document.querySelectorAll('.ignis-import-wizard button')).find(el=>el.textContent==='Open vault').click()`);
  await client.wait(`!!window.app?.workspace && !!app.vault?.getAbstractFileByPath(${JSON.stringify(file)})`,'open imported vault');
  assert.equal(await client.run(`!!app.vault.getAbstractFileByPath('Empty') && app.vault.getAbstractFileByPath('Empty').children.length===0`),true,'empty folder survives opening Obsidian');
  assert.equal(await client.run(`app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(file)}))`),content);
 }
 console.log(JSON.stringify({vaultImport:'passed',checks:['native folder selection','zero-vault ZIP selection','review exclusions','real upload and publication','visible owner catalog','lost review response retry','lost upload response retry','lost commit response retry','empty folders','selection gating and emphasis','real legacy folder drag and drop','separate exclusions without search','apply and undo excluded preferences for folders and ZIP','protected plugin checkboxes','select and deselect all permitted entries','lost selection acknowledgment retry','selected preferences in completed vault','native appearance/core/workspace imported together','name collision field warning before review without layout changes','traditional folder picker with warning','ZIP click and real drop','manager import entry']}));
 }finally{for(const directory of temporary)fs.rmSync(directory,{recursive:true,force:true});}
}
