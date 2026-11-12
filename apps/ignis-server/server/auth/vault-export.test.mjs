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
 for(const name of ['Own','Other']){const directory=(name==='Own'?'alice':'bob')+'/'+name;fs.mkdirSync(path.join(root,directory),{recursive:true});db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'active',0)").run(name,name,directory);}
 db.prepare("INSERT INTO memberships VALUES ('Own','alice','owner'),('Own','bob','reader'),('Other','bob','owner')").run();
 fs.writeFileSync(path.join(root,'alice/Own','Note.md'),'owned');fs.writeFileSync(path.join(root,'bob/Other','Secret.md'),'foreign');
 active=true;sessions={resolve:token=>active&&['alice','bob','admin'].includes(token)?{id:token+'-session',user:{id:token,role:token==='admin'?'admin':'user',authVersion:1}}:null};
 vaults=createVaults({store:createVaultStore(db,root,sessions),sessions,access:createVaultAccessService(db,root,sessions),createView:createVaultView});
 flush=vi.fn(async()=>{});service=createVaultExport({vaults,dataRoot:path.join(temp,'data'),flush});
});
afterEach(()=>{vi.restoreAllMocks();db.close();fs.rmSync(temp,{recursive:true,force:true});});
async function contents(result){const bytes=fs.readFileSync(result.file);const entries=readZip(bytes);return Object.fromEntries(await Promise.all(entries.filter(e=>e.kind==='file').map(async e=>[e.path,(await zipFile(bytes,e)).toString()])));}
it('exports only physical owner content, optional configuration and no foreign vault bytes',async()=>{
 fs.mkdirSync(path.join(root,'alice/Own','.obsidian','plugins','example'),{recursive:true});fs.writeFileSync(path.join(root,'alice/Own','.obsidian','app.json'),'{}');fs.writeFileSync(path.join(root,'alice/Own','.obsidian','plugins','example','main.js'),'plugin');
 fs.mkdirSync(path.join(root,'alice/Own','Empty'));fs.mkdirSync(path.join(root,'alice/Own','.trash'));fs.writeFileSync(path.join(root,'alice/Own','.trash','Deleted.md'),'trash');fs.writeFileSync(path.join(root,'alice/Own','.ignis-copy-private'),'temporary');
 const plain=await service.prepare('alice','Own',false,signal());
 expect(await contents(plain)).toEqual({'Note.md':'owned'});expect(plain.name).toBe('Own.zip');expect(flush).toHaveBeenCalledWith(path.join(root,'alice/Own'));await plain.dispose();
 const full=await service.prepare('alice','Own',true,signal());
 expect(await contents(full)).toEqual({'Note.md':'owned','.obsidian/app.json':'{}','.obsidian/plugins/example/main.js':'plugin'});
 expect(fs.readFileSync(path.join(root,'bob/Other','Secret.md'),'utf8')).toBe('foreign');await full.dispose();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it.each([[true,false],[false,true],[true,true],[false,false]])(
 'exports Obsidian settings (%s) and community add-ons (%s) independently',
 async (configuration,plugins)=>{
  const config=path.join(root,'alice/Own','.obsidian');
  fs.mkdirSync(path.join(config,'plugins/example'),{recursive:true});
  fs.mkdirSync(path.join(config,'themes/example'),{recursive:true});
  const preferences={'app.json':'{}','themes/example/theme.css':'body {}','core-plugins.json':'[]'};
  const addOns={'plugins/example/main.js':'plugin','plugins/example/data.json':'{"enabled":true}','community-plugins.json':'["example"]'};
  for(const [name,value] of Object.entries({...preferences,...addOns}))fs.writeFileSync(path.join(config,name),value);
  const result=await service.prepare('alice','Own',configuration,signal(),plugins);
  try{
   const expected={'Note.md':'owned'};
   for(const files of [configuration?preferences:{},plugins?addOns:{}]){
    for(const [name,value] of Object.entries(files))expected['.obsidian/'+name]=value;
   }
   expect(await contents(result)).toEqual(expected);
  }finally{await result.dispose();}
 });
it.each(['bob','admin',null])('rejects non-owner %s, including an administrator without ownership',async token=>{
 await expect(service.prepare(token,'Own',false,signal())).rejects.toBeTruthy();
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);expect(flush).not.toHaveBeenCalled();
});
it('rejects traversal and ambiguous or missing vault references',async()=>{
 for(const reference of ['../Other','missing','/etc'])await expect(service.prepare('alice',reference,false,signal())).rejects.toBeTruthy();
});
it('skips symlinks, linked directories and hardlinks to files outside the vault',async()=>{
 fs.symlinkSync(path.join(root,'bob/Other'),path.join(root,'alice/Own','Link'));fs.symlinkSync(path.join(root,'bob/Other','Secret.md'),path.join(root,'alice/Own','Link.md'));fs.linkSync(path.join(root,'bob/Other','Secret.md'),path.join(root,'alice/Own','Hard.md'));
 const result=await service.prepare('alice','Own',false,signal());expect(await contents(result)).toEqual({'Note.md':'owned'});await result.dispose();
});
it('rejects an oversized sparse file before archive creation',async()=>{
 const file=path.join(root,'alice/Own','large');fs.writeFileSync(file,'');fs.truncateSync(file,limits.fileBytes+1);
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_LIMIT'});expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('revalidates ownership after flushing pending edits and does not grant a durable export permit',async()=>{
 flush.mockImplementation(async()=>{db.prepare("UPDATE memberships SET role='reader' WHERE user_id='alice'").run();});
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'VAULT_UNAVAILABLE'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('rechecks authorization during archive reads and removes partial output',async()=>{
 const open=fs.promises.open;vi.spyOn(fs.promises,'open').mockImplementation(async(...args)=>{const result=await open(...args);if(args[0]===path.join(root,'alice/Own','Note.md'))active=false;return result;});
 await expect(service.prepare('alice','Own',false,signal())).rejects.toBeTruthy();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
it('pins the root directory inode across asynchronous work',async()=>{
 flush.mockImplementation(async()=>{fs.renameSync(path.join(root,'alice/Own'),path.join(root,'alice/Old'));fs.mkdirSync(path.join(root,'alice/Own'));fs.writeFileSync(path.join(root,'alice/Own','Injected.md'),'changed');});
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
 fs.mkdirSync(path.join(temp,'data','vault-exports','export-orphan'));await service.cleanup();expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);expect(fs.readFileSync(path.join(root,'alice/Own','Note.md'),'utf8')).toBe('owned');
});

it('excludes a real incoming virtual mount even when it is located inside the exported vault',async()=>{
 const st=fs.statSync(path.join(root,'bob/Other','Secret.md'));
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
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(root,'alice/Own',`random-${i}`),bytes);
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_LIMIT'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
 for(let i=0;i<3;i++)fs.unlinkSync(path.join(root,'alice/Own',`random-${i}`));
 const result=await service.prepare('alice','Own',false,signal());await result.dispose();
},15000);

it.each(['C:','bad\\name','con','Note.MD'])('rejects unsafe portable names or case collisions: %s',async name=>{
 fs.writeFileSync(path.join(root,'alice/Own',name),'bad');
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EXPORT_PATH'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});

it('round-trips a vault containing only one top-level folder without flattening that folder',async()=>{
 fs.mkdirSync(path.join(root,'alice/Own','Folder'));fs.mkdirSync(path.join(root,'alice/Own','Folder','Empty'));fs.renameSync(path.join(root,'alice/Own','Note.md'),path.join(root,'alice/Own','Folder','Note.md'));
 const result=await service.prepare('alice','Own',false,signal());
 const importer=require('../features/vaults/adapters/vault-import').createVaultImport({db,root,dataRoot:path.join(temp,'data'),sessions});
 try{
  const scope=importer.scope('alice'),job=await scope.zip({name:'Restored',configuration:false},fs.readFileSync(result.file));await scope.commit(job.id);
  expect(fs.existsSync(path.join(root,'alice/Restored','Folder','Note.md'))).toBe(true);
  expect(fs.readFileSync(path.join(root,'alice/Restored','Folder','Note.md'),'utf8')).toBe('owned');
  expect(fs.existsSync(path.join(root,'alice/Restored','Note.md'))).toBe(false);expect(fs.statSync(path.join(root,'alice/Restored','Folder','Empty')).isDirectory()).toBe(true);expect(fs.readdirSync(path.join(root,'alice/Restored','Folder','Empty'))).toEqual([]);
 }finally{importer.close();await result.dispose();}
});
it('retains cleanup failures for startup recovery without rejecting or blocking later exports',async()=>{
 const first=await service.prepare('alice','Own',false,signal());
 const original=fs.promises.rm;
 const remove=vi.spyOn(fs.promises,'rm').mockRejectedValue(Object.assign(Error('private path'),{code:'EIO'}));
 await expect(first.dispose()).resolves.toBeUndefined();
 await expect(service.cleanup()).rejects.toMatchObject({code:"EIO"});
 remove.mockRestore();
 expect(fs.existsSync(first.file)).toBe(true);
 const second=await service.prepare('alice','Own',false,signal());await second.dispose();
 await service.cleanup();
 expect(fs.existsSync(first.file)).toBe(false);
 expect(fs.promises.rm).toBe(original);
});
it('preserves the preparation error if removing its temporary files also fails',async()=>{
 const original=fs.promises.open;
 vi.spyOn(fs.promises,'open').mockImplementation(async(...args)=>{
   if(String(args[0]).endsWith('Note.md'))throw Object.assign(Error('read failed'),{code:'EACCES'});
   return original.apply(fs.promises,args);
 });
 vi.spyOn(fs.promises,'rm').mockRejectedValue(Object.assign(Error('cleanup failed'),{code:'EIO'}));
 await expect(service.prepare('alice','Own',false,signal())).rejects.toMatchObject({code:'EACCES'});
});

it('round-trips the full exported vault with plugins, settings, activation, themes and workspaces',async()=>{
 const configuration={
  '.obsidian/app.json':'{"vimMode":true}',
  '.obsidian/community-plugins.json':'["demo"]',
  '.obsidian/plugins/demo/main.js':'module.exports = class {};',
  '.obsidian/plugins/demo/manifest.json':'{"id":"demo","version":"1.0.0"}',
  '.obsidian/plugins/demo/data.json':'{"setting":42}',
  '.obsidian/plugins/demo/custom.bin':'custom state',
  '.obsidian/plugins/inactive/main.js':'// disabled',
  '.obsidian/themes/Example/theme.css':'body {}',
  '.obsidian/appearance.json':'{"cssTheme":"Example"}',
  '.obsidian/workspace.json':'{"main":{"type":"split","children":[]}}',
  '.obsidian/snippets/custom.css':'.custom {}',
  '.hidden-content':'vault-specific bytes',
 };
 for(const [file,bytes] of Object.entries(configuration)){
  const filename=path.join(root,'alice/Own',file);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes);
 }
 const archive=await service.prepare('alice','Own',true,signal());
 const {createVaultImport}=require('../features/vaults/adapters/vault-import');
 const importer=createVaultImport({db,root,dataRoot:path.join(temp,'data'),sessions});
 try{
  const scope=importer.scope('admin'),source=await scope.scan({attempt:crypto.randomUUID()},fs.readFileSync(archive.file));
  const input={id:source.id,root:source.vaults[0].root,name:'Restored',configuration:true,restore:'full',selected:[]};
  await scope.reviewSource(input);const stage=await scope.prepareSource(input);await scope.commit(stage.id);
  for(const [file,bytes] of Object.entries(configuration))expect(fs.readFileSync(path.join(root,'admin/Restored',file),'utf8')).toBe(bytes);
  expect(fs.readFileSync(path.join(root,'admin/Restored/Note.md'),'utf8')).toBe('owned');
  expect(fs.existsSync(path.join(root,'admin/Restored/Secret.md'))).toBe(false);
 }finally{importer.close();await archive.dispose();}
});

function addSecondOwnedVault() {
 const directory=path.join(root,'alice/Second');
 fs.mkdirSync(directory);
 fs.writeFileSync(path.join(directory,'Note.md'),'second');
 db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('Second','Second','alice/Second','active',0)").run();
 db.prepare("INSERT INTO memberships VALUES ('Second','alice','owner')").run();
 return directory;
}

const selection=(vault,configuration=false,plugins=false)=>({vault,configuration,plugins});

it('exports separate importable vault folders with independent preferences and add-ons',async()=>{
 const second=addSecondOwnedVault();
 fs.mkdirSync(path.join(root,'alice/Own','.obsidian','plugins','example'),{recursive:true});
 fs.writeFileSync(path.join(root,'alice/Own','.obsidian','app.json'),'{}');
 fs.writeFileSync(path.join(root,'alice/Own','.obsidian','plugins','example','main.js'),'plugin');
 fs.mkdirSync(path.join(second,'Empty'));
 const result=await service.prepareMany('alice',[selection('Own',false,true),selection('Second')],signal());
 try {
  expect(result.name).toBe('Ignis-vaults.zip');
  expect(await contents(result)).toEqual({
   'Own/Note.md':'owned',
   'Own/.obsidian/plugins/example/main.js':'plugin',
   'Second/Note.md':'second',
  });
  const {inspectSource}=require('../features/vaults/application/import-source');
  const source=inspectSource(readZip(fs.readFileSync(result.file)).map(({path,kind,size})=>({path,kind,size})));
  expect(source.vaults.map(vault=>vault.root)).toEqual(['Own','Second']);
  expect(source.entries).toContainEqual(expect.objectContaining({path:'Second/Empty',kind:'directory'}));
 } finally {await result.dispose();}
});

it('rejects a batch containing a foreign vault or a duplicate before flushing',async()=>{
 await expect(service.prepareMany('alice',[selection('Own'),selection('Other')],signal())).rejects.toBeTruthy();
 await expect(service.prepareMany('alice',[selection('Own'),selection('Own')],signal())).rejects.toMatchObject({code:'EXPORT_PATH'});
 expect(flush).not.toHaveBeenCalled();
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});

it('rejects the whole batch if ownership changes during preparation',async()=>{
 const second=addSecondOwnedVault();
 flush.mockImplementation(async directory=>{
  if(directory===second)db.prepare("UPDATE memberships SET role='reader' WHERE vault_id='Own'").run();
 });
 await expect(service.prepareMany('alice',[selection('Own'),selection('Second')],signal())).rejects.toMatchObject({code:'VAULT_UNAVAILABLE'});
 expect(fs.readdirSync(path.join(temp,'data','vault-exports'))).toEqual([]);
});
