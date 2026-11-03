import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {readZip,zipFile}=require('../../apps/ignis-server/server/features/vaults/adapters/import-zip');
export async function vaultExportUi(client,vault,{native,file=native?'Note.md':'Zip.md',content=native?'from folder':'from zip',emptyFolders=true}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-export-download-'));
 const existed=await client.run(`!!document.querySelector('.vault-manager-overlay')`);
 try{
  await client.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory});
  if(!existed)await client.run(`IgnisUI.showVaultManager()`);
  await client.wait(`Array.from(document.querySelectorAll('.vault-manager-overlay .list-item')).some(el=>el.innerText.includes(${JSON.stringify(vault.name)}))`,'export vault listed');
  await client.run(`Array.from(document.querySelectorAll('.vault-manager-overlay .list-item')).find(el=>el.innerText.includes(${JSON.stringify(vault.name)})).querySelector('.popover-trigger').click()`);
  await client.run(`Array.from(document.querySelectorAll('.popover-item')).find(el=>el.textContent.trim()==='Export vault').click()`);
  await client.wait(`!!document.querySelector('.ignis-export-options')`,'export dialog');
  const layout=await client.run(`(()=>{const root=document.querySelector('.ignis-export-options').closest('.modal'),r=root.getBoundingClientRect(),buttons=[...root.querySelectorAll('.modal-button-container button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,y:r.y,width:r.width};});return {width:r.width,left:r.left,top:r.top,overflow:root.scrollWidth>root.clientWidth+1,buttons};})()`);
  assert.equal(layout.overflow,false);assert.ok(layout.left>=0&&layout.top>=0);
  if(process.argv.includes('--mobile')){assert.ok(layout.buttons[1].y<layout.buttons[0].y,'mobile action precedes cancel');assert.ok(layout.buttons.every(b=>b.width>300),'mobile full width');}
  else assert.ok(layout.width<=500,'native form width');
  const {data}=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/ignis-export-'+(native?'native':'shell')+'-'+(process.argv.includes('--mobile')?'mobile':'desktop')+'.png',Buffer.from(data,'base64'));
  await client.run(`{const root=document.querySelector('.ignis-export-options').closest('.modal');root.querySelector('input[type=checkbox]').checked=true;root.querySelector('.mod-cta').click();}`);
  await client.wait(`!document.querySelector('.ignis-export-options')`,'export download finished');
  const filename=path.join(directory,vault.name+'.zip');
  for(let i=0;i<100&&!fs.existsSync(filename);i++)await new Promise(r=>setTimeout(r,100));
  assert.ok(fs.existsSync(filename),'browser saved ZIP');
  const bytes=fs.readFileSync(filename),entries=readZip(bytes);const files=Object.fromEntries(await Promise.all(entries.filter(e=>e.kind==='file').map(async e=>[e.path,(await zipFile(bytes,e)).toString()])));
  assert.equal(files[file],content);
  assert.equal(files['.obsidian/community-plugins.json'],'[]');
  if(emptyFolders)assert.ok(entries.some(e=>e.kind==='directory'&&e.path==='Empty'),'empty folder is exported');
  assert.equal(Object.keys(files).some(name=>name.includes('evil')),false);
  console.log(JSON.stringify({vaultExport:'passed',native,mobile:process.argv.includes('--mobile'),checks:['owner menu','native form geometry','real browser download','own bytes','optional configuration']}));
  return files;
 }finally{
  if(!existed)await client.run(`document.querySelector('.vault-manager-overlay .close-btn')?.click()`);
  fs.rmSync(directory,{recursive:true,force:true});
 }
}
