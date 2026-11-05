import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),archiver=require('archiver');
const {openDatabase}=require('../platform/persistence/database');const {createVaultImport}=require('../features/vaults/adapters/vault-import');
const {limits}=require('../features/vaults/application/import-policy');
let temp,db,service,time,active,root;
beforeEach(()=>{temp=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-import-'));root=path.join(temp,'vaults');fs.mkdirSync(root);db=openDatabase(path.join(temp,'data'));for(const id of ['alice','bob'])db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,'user',0)").run(id,id);time=0;active=true;service=createVaultImport({db,root,dataRoot:path.join(temp,'data'),now:()=>time,sessions:{resolve:token=>active&&['alice','bob'].includes(token)?{id:token+'-session',user:{id:token,role:'user',authVersion:1}}:null}});});
afterEach(()=>{vi.restoreAllMocks();service.close();db.close();fs.rmSync(temp,{recursive:true,force:true});});
const options=(files=[{path:'Note.md',size:5}])=>({name:'Imported',configuration:true,files});
async function zip(files){const archive=archiver('zip',{zlib:{level:9}}),chunks=[];archive.on('data',chunk=>chunks.push(chunk));const done=new Promise((resolve,reject)=>{archive.on('end',resolve);archive.on('error',reject);});for(const [name,value] of files)archive.append(value,{name});await archive.finalize();await done;return Buffer.concat(chunks);}
it('publishes only complete imports, assigns a fresh identity to the caller, preserves bytes and disables plugins',async()=>{
 const scope=service.scope('alice'),start=await scope.begin(options());
 expect(db.prepare('SELECT * FROM vaults').all()).toEqual([]);
 await expect(scope.commit(start.id)).rejects.toMatchObject({code:'IMPORT_INCOMPLETE'});
 await scope.put(start.id,0,Buffer.from('hello'));const result=await scope.commit(start.id);
 expect(result.id).toMatch(/^[a-f0-9-]{36}$/);expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
 expect(JSON.parse(fs.readFileSync(path.join(root,'alice/Imported','.obsidian','community-plugins.json')))).toEqual([]);
 expect(db.prepare('SELECT user_id,role FROM memberships WHERE vault_id=?').get(result.id)).toEqual(expect.objectContaining({user_id:'alice',role:'owner'}));
 expect(db.prepare('SELECT status FROM vaults').get().status).toBe('active');
});
it.each(['/etc/passwd','../other/file','a/../../other','a\\file','C:/file','a//b','a/./b','file.','CON','a\u0000b'])('rejects dangerous paths before touching any vault: %s',async value=>{
 await expect(service.scope('alice').begin(options([{path:value,size:5}]))).rejects.toMatchObject({code:'IMPORT_PATH'});expect(fs.readdirSync(root)).toEqual([]);
});
it.each([[{path:'A.md',size:0},{path:'a.md',size:0}],[{path:'a',size:0},{path:'a/b',size:0}],[{path:'é.md',size:0},{path:'e\u0301.md',size:0}]])('rejects colliding paths',async(...files)=>{await expect(service.scope('alice').begin(options(files))).rejects.toMatchObject({code:'IMPORT_COLLISION'});});
it('never accepts a supplied owner or server directory',async()=>{
 for(const extra of [{ownerId:'bob'},{directory:'/server'}])await expect(service.scope('alice').begin({...options(),...extra})).rejects.toMatchObject({code:'IMPORT_REQUEST'});
});
it('binds stages to the original principal and live session; expiration and logout deny access',async()=>{
 const start=await service.scope('alice').begin(options());await expect(service.scope('bob').put(start.id,0,Buffer.from('hello'))).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 time=limits.ttl;await expect(service.scope('alice').commit(start.id)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 const scope=service.scope('alice');active=false;await expect(scope.begin(options())).rejects.toMatchObject({code:'SESSION_CHANGED'});
});
it('excludes executable/configuration/hidden state even for imported Obsidian vaults',async()=>{
 const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/app.json','{"vimMode":true}'],['Old/.obsidian/plugins/evil/main.js','throw 1'],['Old/.obsidian/community-plugins.json','["evil"]'],['Old/.git/config','secret'],['Old/.ignis-auth.json','secret']]);
 const scope=service.scope('alice'),start=await scope.zip({name:'Imported',configuration:true},bytes);expect(start.excluded).toBe(4);await scope.commit(start.id);
 expect(fs.readFileSync(path.join(root,'alice/Imported','.obsidian','app.json'),'utf8')).toBe('{"vimMode":true}');expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian','plugins'))).toBe(false);expect(fs.existsSync(path.join(root,'alice/Imported','.git'))).toBe(false);
});
it('does not preserve preferences unless selected and rejects malformed preference data',async()=>{
 const scope=service.scope('alice'),start=await scope.begin(options([{path:'Note.md',size:5},{path:'.obsidian/app.json',size:1}]));await expect(scope.put(start.id,1,Buffer.from('{'))).rejects.toMatchObject({code:'IMPORT_CONFIGURATION'});await scope.cancel(start.id);
 const second=await scope.begin({...options([{path:'Note.md',size:5},{path:'.obsidian/app.json',size:1}]),configuration:false});expect(second.upload).toEqual([0]);await scope.cancel(second.id);
});
it('enforces byte limits, keeps uploads immutable and does not overwrite an existing directory',async()=>{
 const scope=service.scope('alice');await expect(scope.begin(options([{path:'big',size:limits.fileBytes+1}]))).rejects.toMatchObject({code:'IMPORT_LIMIT'});
 const start=await scope.begin(options());await expect(scope.put(start.id,0,Buffer.from('xx'))).rejects.toMatchObject({code:'IMPORT_REQUEST'});await scope.put(start.id,0,Buffer.from('hello'));await expect(scope.put(start.id,0,Buffer.from('other'))).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 fs.mkdirSync(path.join(root,'alice/Imported'),{recursive:true});fs.writeFileSync(path.join(root,'alice/Imported','original'),'preserved');await expect(scope.commit(start.id)).rejects.toMatchObject({code:'VAULT_EXISTS'});expect(fs.readFileSync(path.join(root,'alice/Imported','original'),'utf8')).toBe('preserved');
});
it('cancels without publishing and bounds concurrent request memory leases',async()=>{
 const scope=service.scope('alice'),start=await scope.begin(options());const release=scope.claim('upload');expect(()=>scope.claim('upload')).toThrow();release();await scope.cancel(start.id);expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);expect(fs.readdirSync(root)).toEqual([]);
});
it('quarantines partial output on I/O failure instead of exposing it',async()=>{
 const scope=service.scope('alice'),start=await scope.begin(options());await scope.put(start.id,0,Buffer.from('hello'));
 const original=fs.promises.open;vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{if(file===path.join(root,'alice/Imported','Note.md'))throw Object.assign(Error('failure'),{code:'EACCES'});return original(file,...args);});
 await expect(scope.commit(start.id)).rejects.toMatchObject({code:'EACCES'});expect(db.prepare('SELECT status FROM vaults').get().status).toBe('quarantine');
});
it('rejects symlink ZIP entries, encryption, forged lengths and CRC corruption',async()=>{
 const original=await zip([['Note.md','hello']]);const central=original.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 for(const mutate of [b=>b.writeUInt32LE((0xa1ff<<16)>>>0,central+38),b=>b.writeUInt16LE(b.readUInt16LE(central+8)|1,central+8),b=>b.writeUInt32LE(limits.fileBytes+1,central+24),b=>b.writeUInt32LE(0,central+16)]){
  const bytes=Buffer.from(original);mutate(bytes);await expect(service.scope('alice').zip({name:'Imported',configuration:false},bytes)).rejects.toHaveProperty('code');
 }
 expect(fs.readdirSync(root)).toEqual([]);expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('cancels a lost-response attempt without allowing another user to cancel it',async()=>{
 const scope=service.scope('alice'),attempt='11111111-1111-4111-8111-111111111111';
 const job=await scope.begin({...options(),attempt});await service.scope('bob').cancelAttempt(attempt);expect(scope.inspect(job.id)).toBeTruthy();
 await scope.cancelAttempt(attempt);expect(()=>scope.inspect(job.id)).toThrow();expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('revocation during output publication cannot activate a vault',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options());await scope.put(job.id,0,Buffer.from('hello'));
 const open=fs.promises.open;vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{const fd=await open(file,...args);if(file!==path.join(root,'alice/Imported','Note.md'))return fd;return {write:(...args)=>fd.write(...args),close:()=>fd.close(),sync:async()=>{await fd.sync();active=false;}};});
 await expect(scope.commit(job.id)).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(db.prepare('SELECT status FROM vaults').get().status).toBe('quarantine');
});
it.each(['../evil','/x/evil','aa\\evil'])('rejects traversal/absolute aliases in actual ZIP headers: %s',async unsafe=>{
 const bytes=await zip([['aa/evil','hello']]),needle=Buffer.from('aa/evil');
 for(let position=bytes.indexOf(needle);position>=0;position=bytes.indexOf(needle,position+needle.length))bytes.write(unsafe,position,'utf8');
 await expect(service.scope('alice').zip({name:'Imported',configuration:false},bytes)).rejects.toMatchObject({code:'IMPORT_PATH'});
 expect(fs.readdirSync(root)).toEqual([]);
});
it('rejects imported preference prototype keys and a symlink storage root',async()=>{
 const scope=service.scope('alice'),payload=Buffer.from('{"__proto__":{"admin":true}}');
 const job=await scope.begin(options([{path:'.obsidian/app.json',size:payload.length}]));
 await expect(scope.put(job.id,0,payload)).rejects.toMatchObject({code:'IMPORT_CONFIGURATION'});await scope.cancel(job.id);
 fs.renameSync(root,root+'-old');fs.symlinkSync(root+'-old',root);
 await expect(scope.begin(options())).rejects.toMatchObject({code:'IMPORT_STORAGE'});
 expect(fs.readdirSync(root+'-old')).toEqual([]);
});
it('reclaims expired stages before taking a new upload lease',async()=>{
 const scope=service.scope('alice');await scope.begin(options());time=limits.ttl;
 await scope.prepare();const release=scope.claim('zip');release();
 expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);await scope.begin(options());
});

it.each(['id','attempt'])('cancels an in-flight file upload by %s and releases its draft after the write settles',async mode=>{
 const scope=service.scope('alice'),attempt='22222222-2222-4222-8222-222222222222';
 const job=await scope.begin({...options(),attempt});
 let resume,entered;const waiting=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const open=fs.promises.open;
 vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{const fd=await open(file,...args);if(file===path.join(temp,'data','vault-imports',job.id,'0')){const write=fd.write.bind(fd);fd.write=async(...data)=>{const result=await write(...data);entered();await waiting;return result;};}return fd;});
 const uploading=scope.put(job.id,0,Buffer.from('hello'));uploading.catch(()=>{});
 await started;
 try{
  const cancel=service.scope('alice');
  expect(await (mode==='id'?cancel.cancel(job.id):cancel.cancelAttempt(attempt))).toEqual({ok:true});
  await expect(service.scope('alice').commit(job.id)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 }finally{resume();}
 await expect(uploading).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
 const next=await service.scope('alice').begin(options());await service.scope('alice').cancel(next.id);
 expect(fs.readdirSync(root)).toEqual([]);
});

it.each([
 [{path:'Folder/a.md',size:0},{path:'folder/b.md',size:0}],
 [{path:'é/a.md',size:0},{path:'e\u0301/b.md',size:0}],
])('rejects collisions between implicit parent directories',async(...files)=>{
 await expect(service.scope('alice').begin(options(files))).rejects.toMatchObject({code:'IMPORT_COLLISION'});
});
it('acknowledges an identical retry after a lost upload response without overwriting the staged file',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options());await scope.put(job.id,0,Buffer.from('hello'));
 expect(await scope.put(job.id,0,Buffer.from('hello'))).toEqual({ok:true});
 await expect(scope.put(job.id,0,Buffer.from('other'))).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 await scope.commit(job.id);expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
});
it('does not acknowledge cancellation after final publication has started',async()=>{
 const scope=service.scope('alice'),attempt='33333333-3333-4333-8333-333333333333',job=await scope.begin({...options(),attempt});await scope.put(job.id,0,Buffer.from('hello'));
 let resume,entered;const waiting=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const open=fs.promises.open;
 vi.spyOn(fs.promises,'open').mockImplementation(async(file,...args)=>{const fd=await open(file,...args);if(file===path.join(root,'alice/Imported','Note.md')){const write=fd.write.bind(fd);fd.write=async(...data)=>{entered();await waiting;return write(...data);};}return fd;});
 const publishing=scope.commit(job.id);publishing.catch(()=>{});await started;
 try{
  await expect(service.scope('alice').cancel(job.id)).rejects.toMatchObject({code:'IMPORT_BUSY'});
  await expect(service.scope('alice').cancelAttempt(attempt)).rejects.toMatchObject({code:'IMPORT_BUSY'});
 }finally{resume();}
 const result=await publishing;expect(db.prepare('SELECT status FROM vaults WHERE id=?').get(result.id).status).toBe('active');
});
it('removes a partially failed upload before accepting its retry',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options()),file=path.join(temp,'data','vault-imports',job.id,'0');
 const open=fs.promises.open;let first=true;
 vi.spyOn(fs.promises,'open').mockImplementation(async(filename,...args)=>{const fd=await open(filename,...args);if(filename===file){const write=fd.write.bind(fd);fd.write=async(bytes,...data)=>{if(first){first=false;await write(bytes,0,2,null);throw Object.assign(Error('disk full'),{code:'ENOSPC'});}return write(bytes,...data);};}return fd;});
 await expect(scope.put(job.id,0,Buffer.from('hello'))).rejects.toMatchObject({code:'ENOSPC'});expect(fs.existsSync(file)).toBe(false);
 await scope.put(job.id,0,Buffer.from('hello'));await scope.commit(job.id);expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
});
it('does not publish a staged file whose bytes changed after its upload was acknowledged',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options());await scope.put(job.id,0,Buffer.from('hello'));
 fs.writeFileSync(path.join(temp,'data','vault-imports',job.id,'0'),'other');
 await expect(scope.commit(job.id)).rejects.toMatchObject({code:'IMPORT_STORAGE'});expect(db.prepare('SELECT status FROM vaults').get().status).toBe('quarantine');
});
it('repeats a successful commit after a lost response without creating another vault or granting receipt access to others',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options());await scope.put(job.id,0,Buffer.from('hello'));const result=await scope.commit(job.id);
 expect(await service.scope('alice').commit(job.id)).toEqual(result);expect(db.prepare('SELECT count(*) count FROM vaults').get().count).toBe(1);
 await expect(service.scope('bob').commit(job.id)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 db.prepare("UPDATE memberships SET role='reader' WHERE vault_id=? AND user_id='alice'").run(result.id);
 await expect(service.scope('alice').commit(job.id)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
});
it('expires successful import receipts without deleting the published vault',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options());await scope.put(job.id,0,Buffer.from('hello'));const result=await scope.commit(job.id);
 time=limits.ttl;await scope.prepare();await expect(scope.commit(job.id)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 expect(db.prepare('SELECT status FROM vaults WHERE id=?').get(result.id).status).toBe('active');expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
});
it('preserves explicit empty directories in a local manifest without accepting uploads into directory entries',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options([{path:'Empty',kind:'directory',size:0},{path:'Nested/Empty',kind:'directory',size:0},{path:'Note.md',size:5}]));
 expect(job.upload).toEqual([2]);expect(job.files).toBe(1);expect(job.directories).toBe(2);
 await expect(scope.put(job.id,0,Buffer.alloc(0))).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 await scope.put(job.id,2,Buffer.from('hello'));await scope.commit(job.id);
 for(const folder of ['Empty','Nested/Empty']){expect(fs.statSync(path.join(root,'alice/Imported',folder)).isDirectory()).toBe(true);expect(fs.readdirSync(path.join(root,'alice/Imported',folder))).toEqual([]);}
});
it('removes only the sole ZIP vault wrapper and preserves all empty subfolders',async()=>{
 const bytes=await zip([['Original/',''],['Original/Empty/',''],['Original/Deep/Empty/',''],['Original/Note.md','hello']]);
 const scope=service.scope('alice'),job=await scope.zip({name:'Imported',configuration:false},bytes);await scope.commit(job.id);
 expect(fs.existsSync(path.join(root,'alice/Imported','Original'))).toBe(false);
 expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
 for(const folder of ['Empty','Deep/Empty'])expect(fs.readdirSync(path.join(root,'alice/Imported',folder))).toEqual([]);
});
it('retains independent empty top-level ZIP directories when there is no single wrapper',async()=>{
 const scope=service.scope('alice'),job=await scope.zip({name:'Imported',configuration:false},await zip([['First/',''],['Second/','']]));await scope.commit(job.id);
 for(const folder of ['First','Second'])expect(fs.readdirSync(path.join(root,'alice/Imported',folder))).toEqual([]);
});
it('imports an empty selected folder or a directory-only ZIP as an empty vault',async()=>{
 const scope=service.scope('alice'),folder=await scope.begin({...options(),files:[]});await scope.commit(folder.id);
 expect(fs.readdirSync(path.join(root,'alice/Imported'))).toEqual(['.obsidian']);
 const zipped=await scope.zip({name:'Empty ZIP',configuration:false},await zip([['Original/','']]));await scope.commit(zipped.id);expect(fs.readdirSync(path.join(root,'alice/Empty ZIP'))).toEqual(['.obsidian']);
});
it.each([
 [{path:'../outside',kind:'directory',size:0}],
 [{path:'Same',kind:'directory',size:0},{path:'Same',size:0}],
 [{path:'folder',kind:'directory',size:0},{path:'Folder/child',size:0}],
 [{path:'dir',kind:'symlink',size:0}],
 [{path:'dir',kind:null,size:0}],
 [{path:'dir',kind:'directory',size:1}],
])('rejects unsafe directory metadata before creating output',async(...files)=>{
 await expect(service.scope('alice').begin(options(files))).rejects.toHaveProperty('code');expect(fs.readdirSync(root)).toEqual([]);
});
it('counts implicit directory nodes towards the transfer limit',async()=>{
 const files=Array.from({length:5001},(_,i)=>({path:`dir${i}/Note.md`,size:0}));
 await expect(service.scope('alice').begin(options(files))).rejects.toMatchObject({code:'IMPORT_LIMIT'});expect(fs.readdirSync(root)).toEqual([]);
});
it('returns the exact excluded paths, kinds and reasons for its own draft',async()=>{
 const scope=service.scope('alice'),files=[{path:'Note.md',size:5},{path:'.obsidian',kind:'directory',size:0},{path:'.obsidian/app.json',size:2},{path:'.obsidian/plugins/plugin/main.js',size:0},{path:'__MACOSX',kind:'directory',size:0},{path:'.hidden',size:0}];
 const job=await scope.begin({...options(files),configuration:false});
 expect(job.excluded).toBe(5);expect(job.excludedEntries).toEqual([
  {path:'.obsidian',kind:'directory',reason:'preferences-disabled',selectable:false,selected:false},
  {path:'.obsidian/app.json',kind:'file',reason:'preferences-disabled',selectable:true,selected:false},
  {path:'.obsidian/plugins/plugin/main.js',kind:'file',reason:'plugins-themes',selectable:false,selected:false},
  {path:'__MACOSX',kind:'directory',reason:'generated-files',selectable:false,selected:false},
  {path:'.hidden',kind:'file',reason:'hidden-state',selectable:false,selected:false},
 ]);
 expect(job.upload).toEqual([0]);await scope.cancel(job.id);
});
it.each([
 ['appearance.json','appearance-state'],['community-plugins.json','community-plugins-state'],['core-plugins.json','core-plugins-state'],['workspace.json','workspace-state'],
])('explains why the original %s is excluded even when preferences are selected',async(filename,reason)=>{
 const job=await service.scope('alice').begin(options([{path:'Note.md',size:0},{path:'.obsidian/'+filename,size:0}]));
 expect(job.excludedEntries).toEqual([{path:'.obsidian/'+filename,kind:'file',reason,selectable:filename==='workspace.json',selected:false}]);expect(job.upload).toEqual([0]);
});
it('selects excluded preferences for folder uploads and preserves selection in the review',async()=>{
 const scope=service.scope('alice'),files=[{path:'Note.md',size:0},{path:'.obsidian/workspace.json',size:2},{path:'.obsidian/app.json',size:2}];
 const job=await scope.begin({...options(files),configuration:false,selected:['.obsidian/workspace.json']});
 expect(job.upload).toEqual([0,1]);expect(job.excluded).toBe(1);
 expect(job.excludedEntries.find(e=>e.path.endsWith('workspace.json'))).toMatchObject({selected:true,selectable:true});
 await scope.put(job.id,0,Buffer.alloc(0));await scope.put(job.id,1,Buffer.from('{}'));await scope.commit(job.id);
 expect(fs.readFileSync(path.join(root,'alice/Imported','.obsidian/workspace.json'),'utf8')).toBe('{}');expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian/app.json'))).toBe(false);
});
it('imports selected ZIP preferences but still excludes unselected preferences',async()=>{
 const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/workspace.json','{}'],['Old/.obsidian/app.json','{}']]);
 const scope=service.scope('alice'),job=await scope.zip({name:'Imported',configuration:false,selected:['.obsidian/workspace.json']},bytes);
 await scope.commit(job.id);expect(fs.readFileSync(path.join(root,'alice/Imported','.obsidian/workspace.json'),'utf8')).toBe('{}');expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian/app.json'))).toBe(false);
});
it.each(['.obsidian/plugins/evil/main.js','.obsidian/community-plugins.json','.obsidian/appearance.json','.obsidian/core-plugins.json','.ignis-auth.json','.git/config','../outside','.obsidian/not-present.json'])('rejects forged import selections: %s',async selected=>{
 const files=[{path:'Note.md',size:0},...['.obsidian/plugins/evil/main.js','.obsidian/community-plugins.json','.obsidian/appearance.json','.obsidian/core-plugins.json','.ignis-auth.json','.git/config'].map(path=>({path,size:0}))];
 await expect(service.scope('alice').begin({...options(files),selected:[selected]})).rejects.toMatchObject({code:'IMPORT_REQUEST'});expect(fs.readdirSync(root)).toEqual([]);
});
it('validates selected ZIP preferences and never publishes malformed JSON',async()=>{
 const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/workspace.json','{"__proto__":{}}']]);
 await expect(service.scope('alice').zip({name:'Imported',configuration:false,selected:['.obsidian/workspace.json']},bytes)).rejects.toMatchObject({code:'IMPORT_CONFIGURATION'});expect(fs.readdirSync(root)).toEqual([]);
});
it('allows administrators to explicitly restore appearance and core plugin preferences, but not plugin code',async()=>{
 const adminService=createVaultImport({db,root,dataRoot:path.join(temp,'admin-data'),now:()=>time,sessions:{resolve:()=>({id:'admin-session',user:{id:'alice',role:'admin',authVersion:1}})}});
 try{
  const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/appearance.json','{}'],['Old/.obsidian/core-plugins.json','["file-explorer"]'],['Old/.obsidian/plugins/evil/main.js','throw 1']]);
  const scope=adminService.scope('admin'),job=await scope.zip({name:'Imported',configuration:false,selected:['.obsidian/appearance.json','.obsidian/core-plugins.json']},bytes);
  await scope.commit(job.id);expect(JSON.parse(fs.readFileSync(path.join(root,'alice/Imported','.obsidian/core-plugins.json')))).toEqual(['file-explorer']);expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian/plugins'))).toBe(false);
  await expect(scope.begin({...options([{path:'Note.md',size:0},{path:'.obsidian/plugins/evil/main.js',size:0}]),selected:['.obsidian/plugins/evil/main.js']})).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 }finally{adminService.close();}
});
it('updates a ZIP draft in place, supports deselection after upload and only publishes selected files',async()=>{
 const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/workspace.json','{}']]);
 const scope=service.scope('alice'),job=await scope.zip({name:'Imported',configuration:false},bytes);
 const selected=await scope.select(job.id,['.obsidian/workspace.json']);expect(selected.id).toBe(job.id);expect(selected.excluded).toBe(0);
 const deselected=await scope.select(job.id,[]);expect(deselected.excluded).toBe(1);
 await scope.commit(job.id);expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian/workspace.json'))).toBe(false);expect(fs.existsSync(path.join(root,'alice/Imported','source.zip'))).toBe(false);
});
it('keeps the original ZIP plan after a failed selection and never publishes malformed configuration',async()=>{
 const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/workspace.json','invalid']]);
 const scope=service.scope('alice'),job=await scope.zip({name:'Imported',configuration:false},bytes);
 await expect(scope.select(job.id,['.obsidian/workspace.json'])).rejects.toMatchObject({code:'IMPORT_CONFIGURATION'});
 await scope.commit(job.id);expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian/workspace.json'))).toBe(false);
});
it('binds selection to the draft owner, original session and fixed expiration',async()=>{
 const scope=service.scope('alice'),job=await scope.begin(options([{path:'Note.md',size:0},{path:'.obsidian/workspace.json',size:2}]));
 await expect(service.scope('bob').select(job.id,['.obsidian/workspace.json'])).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 await expect(scope.select(job.id,['.obsidian/plugins/evil/main.js'])).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 await scope.select(job.id,['.obsidian/workspace.json']);time=limits.ttl;
 await expect(scope.select(job.id,[])).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
});
it('detects tampering with the private ZIP source before selecting additional files',async()=>{
 const bytes=await zip([['Old/Note.md','hello'],['Old/.obsidian/workspace.json','{}']]);
 const scope=service.scope('alice'),job=await scope.zip({name:'Imported',configuration:false},bytes);
 const source=path.join(temp,'data','vault-imports',job.id,'source.zip');const changed=fs.readFileSync(source);changed[0]^=1;fs.writeFileSync(source,changed);
 await expect(scope.select(job.id,['.obsidian/workspace.json'])).rejects.toMatchObject({code:'IMPORT_STORAGE'});expect(fs.readdirSync(root)).toEqual([]);
});

it.each([[['file-explorer','workspaces']],[{'file-explorer':true,workspaces:false,sync:false}]])('imports appearance, core plugins and workspace together with either native core format: %j',async core=>{
 const adminService=createVaultImport({db,root,dataRoot:path.join(temp,'admin-formats'),now:()=>time,sessions:{resolve:()=>({id:'admin-session',user:{id:'alice',role:'admin',authVersion:1}})}});
 try{
  const files=[['Old/Note.md','hello'],['Old/.obsidian/appearance.json','{"accentColor":"#abcdef"}'],['Old/.obsidian/core-plugins.json',JSON.stringify(core)],['Old/.obsidian/workspace.json','{"main":{"type":"split","children":[]}}']];
  const scope=adminService.scope('admin'),job=await scope.zip({name:'Imported',configuration:false},await zip(files));
  const selection=await scope.select(job.id,files.slice(1).map(([name])=>name.slice(4)));expect(selection.excluded).toBe(0);
  await scope.commit(job.id);
  for(const [name,contents] of files)expect(fs.readFileSync(path.join(root,'alice/Imported',name.slice(4)),'utf8')).toBe(contents);
 }finally{adminService.close();}
});
it.each([null,true,1,'file-explorer',{'file-explorer':'true'},{'file-explorer':1},{'file-explorer':{}},{'../plugin':true},['file-explorer',false],JSON.parse('{"__proto__":true}')].map(core=>[core]))('rejects malformed core-plugin preferences: %j',async core=>{
 const adminService=createVaultImport({db,root,dataRoot:path.join(temp,'admin-invalid'),now:()=>time,sessions:{resolve:()=>({id:'admin-session',user:{id:'alice',role:'admin',authVersion:1}})}});
 try{
  const scope=adminService.scope('admin'),job=await scope.begin({...options([{path:'Note.md',size:0},{path:'.obsidian/core-plugins.json',size:Buffer.byteLength(JSON.stringify(core))}]),selected:['.obsidian/core-plugins.json']});
  await expect(scope.put(job.id,1,Buffer.from(JSON.stringify(core)))).rejects.toMatchObject({code:'IMPORT_CONFIGURATION'});expect(fs.readdirSync(root)).toEqual([]);
 }finally{adminService.close();}
});
it('rejects an existing vault name during preparation without creating private staging or changing existing content',async()=>{
 fs.mkdirSync(path.join(root,'alice/Imported'),{recursive:true});fs.writeFileSync(path.join(root,'alice/Imported','Original.md'),'keep');
 const scope=service.scope('alice');
 await expect(scope.begin(options())).rejects.toMatchObject({code:'VAULT_EXISTS'});
 await expect(scope.zip({name:'Imported',configuration:false},Buffer.from('not a zip'))).rejects.toMatchObject({code:'VAULT_EXISTS'});
 expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);expect(fs.readFileSync(path.join(root,'alice/Imported','Original.md'),'utf8')).toBe('keep');
});
it('checks durable name reservations during preparation even when the directory is absent',async()=>{
 db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES ('reserved','Imported','alice/Imported','pending',0)").run();
 await expect(service.scope('alice').begin(options())).rejects.toMatchObject({code:'VAULT_EXISTS'});expect(fs.readdirSync(root)).toEqual([]);
});

const attempt='10000000-0000-4000-8000-000000000001';
const sourceInput=(id,root,name,selected=[])=>({id,root,name,configuration:false,selected});
it('imports sibling ZIP vaults independently with per-vault exclusions and idempotent publication',async()=>{
 const bytes=await zip([['Backup/A/.obsidian/workspace.json','{}'],['Backup/A/Note.md','alpha'],['Backup/B/.obsidian/workspace.json','{}'],['Backup/B/Note.md','beta'],['Backup/Loose.md','outside']]);
 const scope=service.scope('alice'),source=await scope.scan({attempt},bytes);expect(source.vaults.map(v=>v.root)).toEqual(['A','B']);expect(source.outside.map(e=>e.path)).toEqual(['Loose.md']);
 const a=sourceInput(source.id,'A','First',['.obsidian/workspace.json']),b=sourceInput(source.id,'B','Second');
 const firstReview=await scope.reviewSource(a),secondReview=await scope.reviewSource(b);expect(firstReview.excluded).toBe(0);expect(secondReview.excluded).toBe(1);
 const first=await scope.prepareSource(a);expect((await scope.prepareSource(a)).id).toBe(first.id);const result=await scope.commit(first.id);expect(await scope.prepareSource(a)).toEqual({completed:result});expect(await scope.commit(first.id)).toEqual(result);
 await expect(scope.prepareSource({...a,name:'Duplicate'})).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 const second=await scope.prepareSource(b);await scope.commit(second.id);await scope.cancelSource({id:source.id});
 expect(fs.readFileSync(path.join(root,'alice/First','Note.md'),'utf8')).toBe('alpha');expect(fs.readFileSync(path.join(root,'alice/Second','Note.md'),'utf8')).toBe('beta');expect(fs.existsSync(path.join(root,'alice/First','.obsidian','workspace.json'))).toBe(true);expect(fs.existsSync(path.join(root,'alice/Second','.obsidian','workspace.json'))).toBe(false);expect(fs.existsSync(path.join(root,'alice/First','Loose.md'))).toBe(false);expect(db.prepare("SELECT COUNT(*) n FROM memberships WHERE user_id='alice' AND role='owner'").get().n).toBe(2);expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('maps local manifest indexes back to the original source and supports an empty vault',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt,files:[{path:'A/.obsidian',kind:'directory',size:0},{path:'A/Note.md',size:5},{path:'B/.obsidian',kind:'directory',size:0}]});
 const a=await scope.prepareSource(sourceInput(source.id,'A','First'));expect(a.sourceIndexes).toEqual([0,1]);expect(a.upload).toEqual([1]);await scope.put(a.id,1,Buffer.from('hello'));await scope.commit(a.id);
 const b=await scope.prepareSource(sourceInput(source.id,'B','Empty'));expect(b.upload).toEqual([]);await scope.commit(b.id);expect(fs.readdirSync(path.join(root,'alice/Empty'))).toEqual(['.obsidian']);
});
it('binds scanned origins and child drafts to the original principal/session, validates roots and rejects forged selections',async()=>{
 const alice=service.scope('alice'),bob=service.scope('bob'),source=await alice.scan({attempt,files:[{path:'A/.obsidian/workspace.json',size:2}]});const input=sourceInput(source.id,'A','Imported');
 await expect(bob.reviewSource(input)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});await expect(bob.cancelSource({id:source.id})).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
 for(const extra of [{root:'../A'},{root:'A/.obsidian'},{owner:'bob'},{selected:['.obsidian/plugins/evil/main.js']}])await expect(alice.prepareSource({...input,...extra})).rejects.toMatchObject({code:'IMPORT_REQUEST'});
 time=limits.ttl;await expect(alice.reviewSource(input)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});await alice.prepare();expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('allows only one scanned source per actor, applies aggregate limits and cancels lost scan responses by attempt',async()=>{
 const scope=service.scope('alice');await scope.scan({attempt,files:[{path:'Note.md',size:5}]});await expect(scope.scan({attempt,files:[]})).rejects.toMatchObject({code:'IMPORT_BUSY'});await scope.cancelSource({attempt});
 await expect(scope.scan({attempt,files:Array.from({length:9},(_,i)=>({path:`V${i}/Note.md`,size:limits.fileBytes}))})).rejects.toMatchObject({code:'IMPORT_LIMIT'});expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('reports name collisions and malformed selected ZIP preferences before publication',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt},await zip([['A/.obsidian/workspace.json','{'],['A/Note.md','hello'],['B/.obsidian/app.json','{}']]));fs.mkdirSync(path.join(root,'alice/Taken'),{recursive:true});
 await expect(scope.reviewSource(sourceInput(source.id,'A','Taken'))).rejects.toMatchObject({code:'VAULT_EXISTS'});
 await expect(scope.reviewSource(sourceInput(source.id,'A','Good',['.obsidian/workspace.json']))).rejects.toMatchObject({code:'IMPORT_CONFIGURATION'});expect(db.prepare('SELECT * FROM vaults').all()).toEqual([]);
 expect((await scope.reviewSource(sourceInput(source.id,'A','Good'))).excluded).toBe(1);
});
it('retains completed vaults when a later vault fails or the source is cancelled',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt},await zip([['A/.obsidian/', ''],['A/Note.md','first'],['B/.obsidian/', ''],['B/Note.md','second']]));
 const first=await scope.prepareSource(sourceInput(source.id,'A','First'));await scope.commit(first.id);const second=await scope.prepareSource(sourceInput(source.id,'B','Second'));fs.mkdirSync(path.join(root,'alice/Second'));await expect(scope.commit(second.id)).rejects.toMatchObject({code:'VAULT_EXISTS'});await scope.cancelSource({id:source.id});expect(fs.readFileSync(path.join(root,'alice/First','Note.md'),'utf8')).toBe('first');expect(db.prepare("SELECT COUNT(*) n FROM vaults WHERE status='active'").get().n).toBe(1);
});
it('rejects tampered or replaced private source archives before reading child content',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt},await zip([['A/.obsidian/', ''],['A/Note.md','hello']]));fs.writeFileSync(path.join(temp,'data','vault-imports',source.id,'source.zip'),'changed');await expect(scope.prepareSource(sourceInput(source.id,'','Imported'))).rejects.toMatchObject({code:'IMPORT_STORAGE'});expect(db.prepare('SELECT * FROM vaults').all()).toEqual([]);
});
it('rechecks ownership when recovering a completed child and never grants authority from a source receipt',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt},await zip([['A/.obsidian/',''],['A/Note.md','hello']])),input=sourceInput(source.id,'','Imported');const stage=await scope.prepareSource(input),result=await scope.commit(stage.id);db.prepare("UPDATE memberships SET role='reader' WHERE vault_id=? AND user_id='alice'").run(result.id);await expect(scope.prepareSource(input)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
});
it('denies a scanned source after session revocation and rejects unsafe optional preferences through source review',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt,files:[{path:'A/.obsidian/appearance.json',size:2},{path:'A/Note.md',size:5}]});await expect(scope.reviewSource(sourceInput(source.id,'A','Imported',['.obsidian/appearance.json']))).rejects.toMatchObject({code:'IMPORT_REQUEST'});active=false;await expect(scope.prepareSource(sourceInput(source.id,'A','Imported'))).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(db.prepare('SELECT * FROM vaults').all()).toEqual([]);
});
it('refuses source cancellation once a child publication has begun and never removes the published vault',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt,files:[]}),stage=await scope.prepareSource(sourceInput(source.id,'','Imported'));
 let resume,entered;const waiting=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;}),mkdir=fs.promises.mkdir;
 const spy=vi.spyOn(fs.promises,'mkdir').mockImplementation(async(...args)=>{const result=await mkdir(...args);if(args[0]===path.join(root,'alice/Imported')){entered();await waiting;}return result;});
 const pending=scope.commit(stage.id);try{await started;await expect(scope.cancelSource({id:source.id})).rejects.toMatchObject({code:'IMPORT_BUSY'});}finally{resume();spy.mockRestore();}
 await pending;await scope.cancelSource({id:source.id});expect(fs.existsSync(path.join(root,'alice/Imported','.obsidian','community-plugins.json'))).toBe(true);expect(db.prepare("SELECT status FROM vaults WHERE name='Imported'").get().status).toBe('active');
});
it('counts scanned origins and child drafts together towards the global actor capacity',async()=>{
 service.close();service=createVaultImport({db,root,dataRoot:path.join(temp,'data'),now:()=>time,sessions:{resolve:token=>({id:token+'-session',user:{id:token,role:'user',authVersion:1}})}});
 const actors=['a','b','c','d','e'];for(const id of actors)db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,'user',0)").run(id,'actor'+id);
 const sources=[];for(const id of actors.slice(0,4))sources.push(await service.scope(id).scan({attempt,files:[{path:'Note.md',size:1}]}));
 expect(()=>service.scope('e').claim('upload')).toThrow();await expect(service.scope('e').scan({attempt,files:[]})).rejects.toMatchObject({code:'IMPORT_BUSY'});
 await service.scope('a').cancelSource({id:sources[0].id});expect((await service.scope('e').scan({attempt,files:[]})).vaults).toHaveLength(1);
});

it.each(['node_modules','__MACOSX'])('does not unwrap generated outer ZIP directories into importable vaults: %s',async folder=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt},await zip([[folder+'/A/.obsidian/',''],[folder+'/A/Note.md','hello']]));expect(source.vaults.map(v=>v.root)).toEqual(['']);await expect(scope.reviewSource(sourceInput(source.id,'','Imported'))).rejects.toMatchObject({code:'IMPORT_EMPTY'});expect(db.prepare('SELECT * FROM vaults').all()).toEqual([]);
});
it('replaces only idle unpublished children when changing root or options after a lost preparation response',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt,files:[{path:'A/.obsidian',kind:'directory',size:0},{path:'B/.obsidian',kind:'directory',size:0}]}),a=sourceInput(source.id,'A','First');const lost=await scope.prepareSource(a);const b=await scope.prepareSource(sourceInput(source.id,'B','Second'));await expect(scope.commit(lost.id)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});await scope.commit(b.id);const renamed=await scope.prepareSource({...a,name:'Renamed'});await scope.commit(renamed.id);expect(fs.existsSync(path.join(root,'alice/First'))).toBe(false);expect(fs.existsSync(path.join(root,'alice/Renamed'))).toBe(true);expect(db.prepare("SELECT COUNT(*) n FROM vaults WHERE status='active'").get().n).toBe(2);
});
it('expires abandoned import sources earlier than the hard cap and never revives them',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt,files:[]});time=limits.idle;await expect(scope.reviewSource(sourceInput(source.id,'','Imported'))).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});await scope.prepare();expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('refreshes active import idle time without extending the absolute four-hour deadline',async()=>{
 const scope=service.scope('alice'),source=await scope.scan({attempt,files:[]}),input=sourceInput(source.id,'','Imported');
 for(time=limits.idle-1;time<limits.ttl;time+=limits.idle-1)await scope.reviewSource(input);
 time=limits.ttl;await expect(scope.prepareSource(input)).rejects.toMatchObject({code:'IMPORT_UNAVAILABLE'});
});
