import {it,expect} from 'vitest';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {sharedArchive}=require('./download');
const {readZip,zipFile}=require('../../../features/vaults/adapters/import-zip');
const directory={kind:'directory',name:'Project',entries:[{name:'nested',kind:'directory'},{name:'Empty',kind:'directory'}]};
function service(){return {read:async(token,{id,path})=>{
 if(token!=='reader'||id!=='grant')throw Error('denied');
 if(path==='')return directory;
 if(path==='Empty')return {kind:'directory',entries:[]};
 if(path==='nested')return {kind:'directory',entries:[{name:'Note.md',kind:'file'}]};
 if(path==='nested/Note.md')return {kind:'file',content:Buffer.from('shared bytes').toString('base64')};
 throw Error('denied');
}};}
it('archives only authorized shared descendants and removes its private temporary files',async()=>{
 const result=await sharedArchive(service(),'reader',{id:'grant',path:''});
 try{
  expect(result.name).toBe('Project.zip');expect(fs.statSync(result.file).mode&0o777).toBe(0o600);
  const buffer=fs.readFileSync(result.file),entries=readZip(buffer);
  expect(entries.map(entry=>entry.path)).toEqual(['Empty','nested','nested/Note.md']);
  expect((await zipFile(buffer,entries.find(entry=>entry.path==='nested/Note.md'))).toString()).toBe('shared bytes');
 }finally{await result.dispose();}
 expect(fs.existsSync(result.file)).toBe(false);
});
it('does not archive an unauthorized share',async()=>{
 await expect(sharedArchive(service(),'outsider',{id:'grant',path:''})).rejects.toThrow('denied');
});
it.each(['../Secret.md','.obsidian','C:escape','x/y'])('rejects unsafe archive entry %s',async name=>{
 const source={read:async()=>({kind:'directory',entries:[{name}]})};
 await expect(sharedArchive(source,'reader',{id:'grant',path:''})).rejects.toThrow('Invalid entry');
});
it('rechecks permission after compression and refuses revoked grants',async()=>{
 const original=service();let roots=0;
 const source={read:async(token,input)=>{if(input.path==='' && ++roots===2)throw Error('revoked');return original.read(token,input);}};
 await expect(sharedArchive(source,'reader',{id:'grant',path:''})).rejects.toThrow('revoked');
});
it('bounds entry count and uncompressed bytes',async()=>{
 for(const options of [{maxEntries:1},{maxBytes:2}])await expect(sharedArchive(service(),'reader',{id:'grant',path:''},options)).rejects.toMatchObject({code:'SHARE_DOWNLOAD_LIMIT'});
});
it('bounds concurrent preparations and releases slots on disposal',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const source={read:async()=>{await gate;return {kind:'directory',entries:[]};}};
 const first=sharedArchive(source,'reader',{id:'grant',path:''}),second=sharedArchive(source,'reader',{id:'grant',path:''});
 await expect(sharedArchive(source,'reader',{id:'grant',path:''})).rejects.toMatchObject({code:'SHARE_DOWNLOAD_BUSY'});
 release();const files=await Promise.all([first,second]);await Promise.all(files.map(file=>file.dispose()));
 const next=await sharedArchive(source,'reader',{id:'grant',path:''});await next.dispose();
});
it('does not read content after a cancelled download',async()=>{
 const controller=new AbortController();controller.abort();let read=false;
 await expect(sharedArchive({read(){read=true;}},'reader',{id:'grant',path:''},{signal:controller.signal})).rejects.toThrow();
 expect(read).toBe(false);
});
