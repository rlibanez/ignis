import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {openDatabase}=require('./database');
const {registerVault}=require('./store');
const {createResourceSharesService}=require('./resource-shares');
const sessions={resolve:id=>({user:{id,authVersion:1}})};
function fixture(base=os.tmpdir()){
 const root=fs.mkdtempSync(path.join(base,'ignis-recovery-'));
 fs.mkdirSync(path.join(root,'Notes/Project'),{recursive:true});
 fs.writeFileSync(path.join(root,'Notes/Project/note.md'),'original bytes');
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-recovery-db-'));
 const db=openDatabase(data);
 for(const id of ['owner','recipient'])db.prepare('INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)').run(id,id,'user');
 const vault=registerVault(db,root,'Notes','owner');
 const service=createResourceSharesService(db,root,sessions);
 const folder=service.create('owner',{vault:vault.id,path:'Project',login:'recipient',role:'editor'}).id;
 const file=service.create('owner',{vault:vault.id,path:'Project/note.md',login:'recipient',role:'reader'}).id;
 return {root,data,db,vault,service,folder,file};
}
// Stop a separate process exactly at publication, without adding production fault hooks.
async function crash(f,operation,phase){
 const script=`
 const fs=require('node:fs'),path=require('node:path');
 const {openDatabase}=require('./apps/ignis-server/server/auth/database');
 const {createResourceSharesService}=require('./apps/ignis-server/server/auth/resource-shares');
 const f=JSON.parse(process.env.RECOVERY_FIXTURE),db=openDatabase(f.data);
 const s=createResourceSharesService(db,f.root,{resolve:id=>({user:{id,authVersion:1}})});
 const rename=fs.renameSync;
 function halt(){fs.writeSync(1,'publication\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
 fs.renameSync=function(a,b){if(f.phase==='before')halt();const result=rename(a,b);halt();return result;};
 (async()=>{
 if(f.operation==='copy')await s.copy('recipient',{from:{id:f.folder,vault:null,path:'note.md'},to:{id:f.folder,vault:null,path:'Copy.md'}});
 if(f.operation==='rename'){const r=await s.read('recipient',{id:f.folder,path:'note.md'});await s.rename('recipient',{id:f.folder,path:'note.md',to:'Renamed.md',etag:r.etag});}
 if(f.operation==='delete'){const input={id:f.folder,path:'note.md'},p=await s.previewRemoval('recipient',input);await s.removeConfirmed('recipient',{...input,revision:p.revision,confirm:true});}
 })().catch(e=>{console.error(e);process.exit(1)});
 `;
 const child=spawn(process.execPath,['-e',script],{cwd:process.cwd(),env:{...process.env,RECOVERY_FIXTURE:JSON.stringify({root:f.root,data:f.data,folder:f.folder,operation,phase})},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',x=>stderr+=x);
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No publication checkpoint: '+stderr)),8000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Unexpected exit: '+stderr));});});}
 finally{await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill('SIGKILL');});}
}
it.each(['rename','delete'])('fails closed after SIGKILL during %s publication',async operation=>{
 const f=fixture();f.db.close();let reopened;
 try{
 await crash(f,operation,'after');reopened=openDatabase(f.data);
 const s=createResourceSharesService(reopened,f.root,sessions);
 expect(fs.existsSync(path.join(f.root,'Notes/Project/note.md'))).toBe(false);
 await expect(s.read('recipient',{id:f.file,path:''})).rejects.toThrow();
 fs.writeFileSync(path.join(f.root,'Notes/Project/note.md'),'unrelated replacement');
 await expect(s.read('recipient',{id:f.file,path:''})).rejects.toThrow();
 const surviving=fs.readdirSync(path.join(f.root,'Notes/Project')).find(n=>operation==='rename'?n==='Renamed.md':n.startsWith('.ignis-delete-'));
 expect(fs.readFileSync(path.join(f.root,'Notes/Project',surviving),'utf8')).toBe('original bytes');
 if(operation==='delete')await expect(s.read('recipient',{id:f.folder,path:surviving})).rejects.toThrow();
 }finally{reopened?.close();fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(f.data,{recursive:true,force:true});}
},15000);
it.each(['rename','delete'])('preserves bytes and grants before interrupted %s publication',async operation=>{
 const f=fixture();f.db.close();let reopened;
 try{await crash(f,operation,'before');reopened=openDatabase(f.data);const s=createResourceSharesService(reopened,f.root,sessions);
 expect(Buffer.from((await s.read('recipient',{id:f.file,path:''})).content,'base64').toString()).toBe('original bytes');
 }finally{reopened?.close();fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(f.data,{recursive:true,force:true});}
},15000);
it.skipIf(process.getuid?.()===0)('preserves the original and publishes no copy after real filesystem EACCES',async()=>{
 expect(process.getuid()).not.toBe(0);
 const f=fixture(),directory=path.join(f.root,'Notes/Project');
 try{const old=await f.service.read('recipient',{id:f.folder,path:'note.md'});fs.chmodSync(directory,0o500);
 await expect(f.service.mutate('recipient',{id:f.folder,path:'note.md',action:'write',etag:old.etag,content:Buffer.from('changed').toString('base64')})).rejects.toThrow();
 await expect(f.service.copy('recipient',{from:{id:f.file,vault:null,path:''},to:{id:f.folder,vault:null,path:'Copy.md'}})).rejects.toMatchObject({code:'EACCES'});
 expect(fs.readdirSync(directory)).toEqual(['note.md']);expect(fs.readFileSync(path.join(directory,'note.md'),'utf8')).toBe('original bytes');
 }finally{fs.chmodSync(directory,0o700);f.db.close();fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(f.data,{recursive:true,force:true});}
});

it.each(['before','after'])('keeps copies complete or unpublished after SIGKILL %s publication',async phase=>{
 const f=fixture();f.db.close();let reopened;
 try{await crash(f,'copy',phase);reopened=openDatabase(f.data);const s=createResourceSharesService(reopened,f.root,sessions);
 expect(fs.readFileSync(path.join(f.root,'Notes/Project/note.md'),'utf8')).toBe('original bytes');
 const destination=path.join(f.root,'Notes/Project/Copy.md');
 expect(fs.existsSync(destination)).toBe(phase==='after');
 if(phase==='after'){
 expect(fs.readFileSync(destination,'utf8')).toBe('original bytes');
 await expect(s.copy('recipient',{from:{id:f.folder,vault:null,path:'note.md'},to:{id:f.folder,vault:null,path:'Copy.md'}})).rejects.toThrow();
 }
 for(const name of fs.readdirSync(path.join(f.root,'Notes/Project')).filter(n=>n.startsWith('.ignis-copy-')))
 await expect(s.read('recipient',{id:f.folder,path:name})).rejects.toThrow();
 }finally{reopened?.close();fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(f.data,{recursive:true,force:true});}
},15000);

it.skipIf(!process.env.IGNIS_TEST_FAULT_ROOT)('preserves originals and removes staging on real tmpfs ENOSPC',async()=>{
 const base=process.env.IGNIS_TEST_FAULT_ROOT,stat=fs.statfsSync(base);
 // Never fill a host filesystem: require a dedicated small Linux tmpfs.
 expect(stat.type).toBe(0x01021994);expect(stat.blocks*stat.bsize).toBeLessThanOrEqual(4*1024*1024);
 const f=fixture(base);let fd;
 try{
 const old=await f.service.read('recipient',{id:f.folder,path:'note.md'});
 fd=fs.openSync(path.join(f.root,'filler'),'wx');let error;
 try{while(true)fs.writeSync(fd,Buffer.alloc(4096,1));}catch(e){error=e;}
 expect(error.code).toBe('ENOSPC');fs.closeSync(fd);fd=undefined;
 await expect(f.service.mutate('recipient',{id:f.folder,path:'note.md',action:'write',etag:old.etag,content:Buffer.alloc(8192,2).toString('base64')})).rejects.toMatchObject({code:'ENOSPC'});
 await expect(f.service.copy('recipient',{from:{id:f.file,vault:null,path:''},to:{id:f.folder,vault:null,path:'Copy.md'}})).rejects.toMatchObject({code:'ENOSPC'});
 expect(fs.readdirSync(path.join(f.root,'Notes/Project'))).toEqual(['note.md']);
 expect(fs.readFileSync(path.join(f.root,'Notes/Project/note.md'),'utf8')).toBe('original bytes');
 fs.unlinkSync(path.join(f.root,'filler'));
 await f.service.mutate('recipient',{id:f.folder,path:'note.md',action:'write',etag:old.etag,content:Buffer.from('recovered').toString('base64')});
 expect(fs.readFileSync(path.join(f.root,'Notes/Project/note.md'),'utf8')).toBe('recovered');
 }finally{if(fd!==undefined)fs.closeSync(fd);f.db.close();fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(f.data,{recursive:true,force:true});}
});
