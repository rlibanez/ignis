import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {openDatabase}=require('../platform/persistence/database');
const {createVaults}=require('../features/vaults/application/vaults');
const {createVaultStore}=require('../features/vaults/adapters/vault-store');
const {createVaultAccessService}=require('../features/vaults/adapters/vault-access');
const {createVaultView}=require('../features/vaults/adapters/vault-view');
const {createVaultExport}=require('../features/vaults/adapters/vault-export');
const {readZip,zipFile}=require('../features/vaults/adapters/import-zip');
const {limits}=require('../features/vaults/application/import-policy');
let temp,db,root,vaults,service,active,flush,sessions;
const signal=()=>new AbortController().signal;
beforeEach(()=>{
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-export-'));root=path.join(temp,'vaults');fs.mkdirSync(root);db=openDatabase(path.join(temp,'data'));
 for(const [id,role] of [['alice','user'],['bob','user'],['admin','admin']])db.prepare('INSERT INTO users(id,login,role,created_at) VALUES (?,?,?,0)').run(id,id,role);
 for(const name of ['Own','Other']){fs.mkdirSync(path.join(root,name));db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'active',0)").run(name,name,name);}
 db.prepare("INSERT INTO memberships VALUES ('Own','alice','owner'),('Own','bob','reader'),('Other','bob','owner')").run();
 fs.writeFileSync(path.join(root,'Own','Note.md'),'owned');fs.writeFileSync(path.join(root,'Other','Secret.md'),'foreign');
 active=true;sessions={resolve:token=>active&&['alice','bob','admin'].includes(token)?{id:token+'-session',user:{id:token,role:token==='admin'?'admin':'user',authVersion:1}}:null};
 vaults=createVaults({store:createVaultStore(db,root,sessions),sessions,access:createVaultAccessService(db,root,sessions),createView:createVaultView});
 flush=vi.fn(async()=>{});service=createVaultExport({vaults,dataRoot:path.join(temp,'data'),flush});
});
afterEach(()=>{vi.restoreAllMocks();db.close();fs.rmSync(temp,{recursive:true,force:true});});
async function contents(result){const bytes=fs.readFileSync(result.file);const entries=readZip(bytes);return Object.fromEntries(await Promise.all(entries.filter(e=>e.kind==='file').map(async e=>[e.path,(await zipFile(bytes,e)).toString()])));}
it('exports only physical owner content, optional configuration and no foreign vault bytes',async()=>{
 fs.mkdirSync(path.join(root,'Own','.obsidian','plugins','example'),{recursive:true});fs.writeFileSync(path.join(root,'Own','.obsidian','app.json'),'{}');fs.writeFileSync(path.join(root,'Own','.obsidian','plugins','example','main.js'),'plugin');
 fs.mkdirSync(path.join(root,'Own','Empty'));fs.mkdirSync(path.join(root,'Own','.trash'));fs.writeFileSync(path.join(root,'Own','.trash','Deleted.md'),'trash');fs.writeFileSync(path.join(root,'Own','.ignis-copy-private'),'temporary');
 const plain=await service.prepare('alice','Own',false,signal());
 expect(await contents(plain)).toEqual({'Note.md':'owned'});expect(plain.name).toBe('Own.zip');expect(flush).toHaveBeenCalledWith(path.join(root,'Own'));await plain.dispose();
 const full=await service.prepare('alice','Own',true,signal());
 expect(await contents(full)).toEqual({'Note.md':'owned','.obsidian/app.json':'{}','.obsidian/plugins/example/main.js':'plugin'});
 expect(fs.readFileSync(path.join(root,'Other','Secret.md'),'utf8')).toBe('foreign');await full.dispose();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it.each(['bob','admin',null])('rejects non-owner %s, including an administrator without ownership',async token=>{
 await expect(service.prepare(token,'Own',false,signal())).rejects.toBeTruthy();
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);expect(flush).not.toHaveBeenCalled();
});
it('rejects traversal and ambiguous or missing vault references',async()=>{
 for(const reference of ['../Other','missing','/etc'])await expect(service.prepare('alice',reference,false,signal())).rejects.toBeTruthy();
});
it('skips symlinks, linked directories and hardlinks to files outside the vault',async()=>{
 fs.symlinkSync(path.join(root,'Other'),path.join(root,'Own','Link'));fs.symlinkSync(path.join(root,'Other','Secret.md'),path.join(root,'Own','Link.md'));fs.linkSync(path.join(root,'Other','Secret.md'),path.join(root,'Own','Hard.md'));
 const result=await service.prepare('alice','Own',false,signal());expect(await contents(result)).toEqual({'Note.md':'owned'});await result.dispose();
});
it('rejects an oversized sparse file before archive creation',async()=>{
 const file=path.join(root,'Own','large');fs.writeFileSync(file,'');fs.truncateSync(file,limits.fileBytes+1);
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_LIMIT'});expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('revalidates ownership after flushing pending edits and does not grant a durable export permit',async()=>{
 flush.mockImplementation(async()=>{db.prepare("UPDATE memberships SET role='reader' WHERE user_id='alice'").run();});
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'VAULT_UNAVAILABLE'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('rechecks authorization during archive reads and removes partial output',async()=>{
 const open=fs.promises.open;vi.spyOn(fs.promises,'open').mockImplementation(async(...args)=>{const result=await open(...args);if(args[0]===path.join(root,'Own','Note.md'))active=false;return result;});
 await expect(service.prepare('alice','Own',false,signal())).rejects.toBeTruthy();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('pins the root directory inode across asynchronous work',async()=>{
 flush.mockImplementation(async()=>{fs.renameSync(path.join(root,'Own'),path.join(root,'Old'));fs.mkdirSync(path.join(root,'Own'));fs.writeFileSync(path.join(root,'Own','Injected.md'),'changed');});
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_CHANGED'});
});
it('cancels safely, releases capacity and retains no archive',async()=>{
 const abort=new AbortController();flush.mockImplementationOnce(async()=>abort.abort());
 await expect(service.prepare('alice','Own',false,abort.signal)).rejects.toBeTruthy();
 const result=await service.prepare('alice','Own',false,signal());await result.dispose();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('holds the per-actor lease until the finished archive is disposed',async()=>{
 const result=await service.prepare('alice','Own',false,signal());await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_BUSY'});
 active=false;expect(()=>result.validate()).toThrow();await result.dispose();
});
it('startup removes orphan exports without touching vault content',async()=>{
 fs.mkdirSync(path.join(temp,'data','vault-exports','export-orphan'));await service.cleanup();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);expect(fs.readFileSync(path.join(root,'Own','Note.md'),'utf8')).toBe('owned');
});

it('excludes a real incoming virtual mount even when it is located inside the exported vault',async()=>{
 const st=fs.statSync(path.join(root,'Other','Secret.md'));
 db.prepare("INSERT INTO shared_resources(id,vault_id,path,kind,device,inode) VALUES ('received','Other','Secret.md','file',?,?)").run(String(st.dev),`${st.ino}:${st.birthtimeMs}`);
 db.prepare("INSERT INTO resource_grants VALUES ('received','alice','reader')").run();
 db.prepare("INSERT INTO resource_destinations VALUES ('received','alice','Own','From Bob.md')").run();
 const sessions={resolve:()=>({user:{id:'alice',authVersion:1}})};
 const sharing=require('../features/sharing/adapters/resource-shares').createResourceSharesService(db,root,sessions);
 expect(sharing.mounts('alice',{vault:'Own'}).mounts.some(item=>item.localPath==='From Bob.md')).toBe(true);
 const result=await service.prepare('alice','Own',false,signal());expect(await contents(result)).toEqual({'Note.md':'owned'});await result.dispose();
});
it('bounds incompressible ZIP output and releases the failed export lease',async()=>{
 const bytes=randomBytes(24*1024*1024);
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(root,'Own',`random-${i}`),bytes);
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_LIMIT'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
 for(let i=0;i<3;i++)fs.unlinkSync(path.join(root,'Own',`random-${i}`));
 const result=await service.prepare('alice','Own',false,signal());await result.dispose();
},15000);

it.each(['C:','bad\\name','con','Note.MD'])('rejects unsafe portable names or case collisions: %s',async name=>{
 fs.writeFileSync(path.join(root,'Own',name),'bad');
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_PATH'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});

it('round-trips a vault containing only one top-level folder without flattening that folder',async()=>{
 fs.mkdirSync(path.join(root,'Own','Folder'));fs.mkdirSync(path.join(root,'Own','Folder','Empty'));fs.renameSync(path.join(root,'Own','Note.md'),path.join(root,'Own','Folder','Note.md'));
 const result=await service.prepare('alice','Own',false,signal());
 const importer=require('../features/vaults/adapters/vault-import').createVaultImport({db,root,dataRoot:path.join(temp,'data'),sessions});
 try{
  const scope=importer.scope('alice'),job=await scope.zip({name:'Restored',configuration:false},fs.readFileSync(result.file));await scope.commit(job.id);
  expect(fs.existsSync(path.join(root,'Restored','Folder','Note.md'))).toBe(true);
  expect(fs.readFileSync(path.join(root,'Restored','Folder','Note.md'),'utf8')).toBe('owned');
  expect(fs.existsSync(path.join(root,'Restored','Note.md'))).toBe(false);expect(fs.statSync(path.join(root,'Restored','Folder','Empty')).isDirectory()).toBe(true);expect(fs.readdirSync(path.join(root,'Restored','Folder','Empty'))).toEqual([]);
 }finally{importer.close();await result.dispose();}
});
