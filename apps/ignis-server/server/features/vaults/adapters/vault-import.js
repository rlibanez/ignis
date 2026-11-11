const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const {randomUUID,createHash}=require('node:crypto');
const {transaction}=require('../../../platform/persistence/database');
const {sessionContext,matchesSession}=require('../../../../../../packages/contracts/src/session');
const {ownedDirectory,ensureUserDirectory,storagePath,assertAvailable}=require('./vault-storage');
const {validVaultName}=require('../application/vault-name');const {limits,fail,manifest,restoreMode}=require('../application/import-policy');
const {consume,small,ensureSpace}=require('./import-streams');const {openArchive}=require('./import-archive');const {Readable,addAbortSignal}=require('node:stream');
function isPreference(name){return /^\.obsidian\/(app|hotkeys|graph|appearance|core-plugins|community-plugins|workspace|workspace-mobile|workspaces)\.json$/.test(name);}
function validatePreference(name,bytes){
 if(isPreference(name)){if(bytes.length>1024*1024)fail('IMPORT_LIMIT');let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('IMPORT_CONFIGURATION');}
    const inspect=(v,depth=0)=>{if(depth>32)fail('IMPORT_CONFIGURATION');if(v&&typeof v==='object')for(const key of Object.keys(v)){if(['__proto__','constructor','prototype'].includes(key))fail('IMPORT_CONFIGURATION');inspect(v[key],depth+1);}};
    if(!value||typeof value!=='object')fail('IMPORT_CONFIGURATION');
    if(name==='.obsidian/community-plugins.json'){
     if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id)))fail('IMPORT_CONFIGURATION');
    }else if(name==='.obsidian/core-plugins.json'){
     const identifier=id=>typeof id==='string'&&/^[a-z0-9-]+$/.test(id);
     // Obsidian reads the legacy enabled-ID list and the current boolean map.
     if(Array.isArray(value)?value.some(id=>!identifier(id)):Object.entries(value).some(([id,enabled])=>!identifier(id)||typeof enabled!=='boolean'))fail('IMPORT_CONFIGURATION');
    }else if(Array.isArray(value))fail('IMPORT_CONFIGURATION');
    inspect(value);
   }
}
function createVaultImport({db,root,dataRoot,sessions,now=Date.now}){
 const staging=path.join(dataRoot,'vault-imports'),jobs=new Map(),sources=new Map(),leases=new Map(),receipts=new Map();let closed=false;
 const dirOk=directory=>{const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())fail('IMPORT_STORAGE');};
 fs.mkdirSync(staging,{recursive:true,mode:0o700});dirOk(staging);
 async function drop(job){jobs.delete(job.id);await fsp.rm(job.stage,{recursive:true,force:true});}
 async function cleanup(){dirOk(staging);for(const entry of await fsp.readdir(staging))if(/^[a-f0-9-]{36}$/.test(entry))await fsp.rm(path.join(staging,entry),{recursive:true,force:true});}
 async function sweep(){for(const source of sources.values())if(source.expires<=now()&&![...jobs.values()].some(j=>j.source===source&&j.busy)){for(const job of jobs.values())if(job.source===source)await drop(job);sources.delete(source.id);await fsp.rm(source.stage,{recursive:true,force:true});}for(const [id,receipt] of receipts)if(receipt.expires<=now())receipts.delete(id);for(const job of jobs.values())if(!job.busy&&job.expires<=now())await drop(job);}
 const activity=item=>{if(item.expires<=now()||item.deadline<=now())fail('IMPORT_UNAVAILABLE');item.expires=Math.min(item.deadline,now()+limits.idle);};
 const audit=(actor,action,id)=>db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(),actor,action,id,now());
 const pluginPermission=db.prepare('SELECT community_plugins_allowed FROM users WHERE id=?');
 function scope(token){
  let interrupted=false,createdJob=null;const abortController=new AbortController();
  const original=sessions.resolve(token);if(!original)fail('SESSION_CHANGED');const context=sessionContext(original);
  const current=(withinTransaction=false)=>{if(interrupted||closed||!matchesSession(context,sessions.resolve(token,{withinTransaction})))fail('SESSION_CHANGED');};
  const canRestorePlugins=()=>context.role==='admin'||pluginPermission.get(context.userId)?.community_plugins_allowed===1;
  const checkRestore=mode=>restoreMode(mode,mode!=='none'&&canRestorePlugins());
  function checkSource(source){current();if(sources.get(source.id)!==source)fail('IMPORT_UNAVAILABLE');activity(source);}
  function checkJob(job){current();if(job.cancelled||jobs.get(job.id)!==job)fail('IMPORT_UNAVAILABLE');activity(job);if(job.source)checkSource(job.source);}
  function jobFor(id){current();const job=jobs.get(id);if(!job||(job.source&&(!sources.has(job.source.id)||job.source.expires<=now()))||job.actor!==context.userId||job.session!==context.sessionId||job.expires<=now()||job.cancelled)fail('IMPORT_UNAVAILABLE');checkJob(job);return job;}
  function receiptFor(id){
   current();const receipt=receipts.get(id);if(!receipt)return null;
   if(receipt.actor!==context.userId||receipt.session!==context.sessionId||receipt.expires<=now())fail('IMPORT_UNAVAILABLE');
   const vault=db.prepare("SELECT v.id,v.name FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE v.id=? AND v.status='active' AND m.user_id=? AND m.role='owner'").get(receipt.vault,context.userId);
   if(!vault)fail('IMPORT_UNAVAILABLE');return {id:vault.id,name:vault.name};
  }
  function availableName(name){
   if(!validVaultName(name))fail('IMPORT_REQUEST');
   dirOk(root);
   assertAvailable(db,root,ownedDirectory(db,context.userId,name));
  }
  async function begin(input,parent=null){
   current();await sweep();current();
   if(!input||Object.keys(input).some(k=>!['name','configuration','files','attempt','selected','restore'].includes(k))||!validVaultName(input.name)||typeof input.configuration!=='boolean')fail('IMPORT_REQUEST');
   if(input.attempt!==undefined&&(typeof input.attempt!=='string'||!/^[a-f0-9-]{36}$/.test(input.attempt)))fail('IMPORT_REQUEST');
   const restore=input.restore===undefined?'none':input.restore;
   const plan=manifest(input.files,input.configuration,input.selected,context.role,false,restore,restore!=='none'&&canRestorePlugins());
   availableName(input.name);
   const pending=plan.entries.filter(e=>e.include&&e.kind==='file').reduce((total,e)=>total+e.size,0);if(fs.statSync(staging).dev===fs.statSync(root).dev)await ensureSpace(staging,pending*2);else{await ensureSpace(staging,pending);await ensureSpace(root,pending);}current();checkRestore(restore);
   if(new Set([...jobs.values(),...sources.values()].map(j=>j.actor)).size>=limits.concurrent&&![...sources.values()].some(j=>j.actor===context.userId)||[...jobs.values()].some(j=>j.actor===context.userId)||(!parent&&[...sources.values()].some(j=>j.actor===context.userId)))fail('IMPORT_BUSY');
   const id=randomUUID(),stage=path.join(staging,id);fs.mkdirSync(stage,{mode:0o700});
   const job={id,stage,attempt:input.attempt,actor:context.userId,session:context.sessionId,name:input.name,configuration:input.configuration,restore,plan,deadline:now()+limits.ttl,expires:now()+limits.idle,received:new Map(),busy:false,source:parent,cancel:new AbortController()};jobs.set(id,job);createdJob=id;
   return describe(job);
  }
  function describe({id,plan}){return {id,files:plan.entries.filter(e=>e.kind==='file').length,directories:plan.entries.filter(e=>e.kind==='directory').length,bytes:plan.total,excluded:plan.excluded,excludedEntries:plan.excludedEntries,upload:plan.entries.map((e,i)=>e.include&&e.kind==='file'?i:null).filter(i=>i!==null),limits};
  }
  async function cancelJob(job){
   // Publication has a separate, explicit confirmation boundary. Uploads can be
   // canceled while a write is settling; publication cannot promise that undo.
   if(job.publishing)fail('IMPORT_BUSY');
   job.cancelled=true;job.cancel.abort();if(!job.busy)await drop(job);return {ok:true};
  }
  async function exclusive(id,action,publishing=false){
   const job=jobFor(id);checkRestore(job.restore);if(job.busy)fail('IMPORT_BUSY');job.busy=true;job.publishing=publishing;
   try{return await action(job);}finally{job.busy=false;job.publishing=false;if(job.cancelled&&jobs.get(job.id)===job)await drop(job);}
  }
  async function putJob(job,index,bytes,plan=job.plan){
   const entry=plan.entries[index];if(!Number.isSafeInteger(index)||!entry?.include||entry.kind!=='file'||!Buffer.isBuffer(bytes)||bytes.length!==entry.size)fail('IMPORT_REQUEST');
   const checksum=createHash('sha256').update(bytes).digest('hex');
   if(job.received.has(index)){if(job.received.get(index)!==checksum)fail('IMPORT_REQUEST');return {ok:true};}
   validatePreference(entry.path,bytes);
   current();await ensureSpace(staging,bytes.length);current();const file=path.join(job.stage,String(index));try{await fsp.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(error){
    if(error.code!=='EEXIST')await fsp.unlink(file).catch(()=>{});throw error;
   }try{current();if(job.cancelled)fail('IMPORT_UNAVAILABLE');}catch(error){await fsp.unlink(file);throw error;}job.received.set(index,checksum);return {ok:true};
  }
  async function put(id,index,bytes){if(!Buffer.isBuffer(bytes))fail('IMPORT_REQUEST');return putStream(id,index,Readable.from([bytes]));}
  async function putStreamJob(job,index,input,plan=job.plan){
   const entry=plan.entries[index];if(!Number.isSafeInteger(index)||!entry?.include||entry.kind!=='file')fail('IMPORT_REQUEST');
   const check=()=>{checkJob(job);checkRestore(job.restore);};
   if(input.headers?.['content-length']!==undefined&&Number(input.headers['content-length'])!==entry.size)fail('IMPORT_REQUEST');
   addAbortSignal(AbortSignal.any([abortController.signal,job.cancel.signal]),input);
   if(isPreference(entry.path)){if(entry.size>1024*1024)fail('IMPORT_LIMIT');return putJob(job,index,await small(input,1024*1024,check),plan);}
   if(job.received.has(index)){const result=await consume(input,{limit:limits.fileBytes,expected:entry.size,check});if(result.hash!==job.received.get(index))fail('IMPORT_REQUEST');return {ok:true};}
   const file=path.join(job.stage,String(index));let output;
   try{check();output=await fsp.open(file,'wx',0o600);const result=await consume(input,{limit:limits.fileBytes,expected:entry.size,check,output,space:staging});check();job.received.set(index,result.hash);return {ok:true};}
   catch(error){if(output)await fsp.unlink(file).catch(()=>{});if(job.cancelled)fail('IMPORT_UNAVAILABLE');current();throw error;}
   finally{await output?.close();}
  }
  async function putStream(id,index,input){return exclusive(id,job=>putStreamJob(job,index,input));}
  async function select(id,selected){return exclusive(id,async job=>{
   const plan=manifest(job.plan.entries.map(({path,kind,size})=>({path,kind,size})),job.configuration,selected,context.role,false,job.restore,job.restore!=='none'&&canRestorePlugins());
   if(job.zip&&plan.entries.some((entry,index)=>entry.include&&entry.kind==='file'&&!job.received.has(index))){
    const archive=await openArchive(job.zip.source||path.join(job.stage,'source.zip'),job.zip,()=>checkJob(job));
    try{for(const [index,entry] of plan.entries.entries())if(entry.include&&entry.kind==='file'&&!job.received.has(index)){current();await putStreamJob(job,index,archive.stream(archive.entries[job.zip.indexes?.[index]??index]),plan);}}
    finally{await archive.close();}
   }
   current();if(job.cancelled)fail('IMPORT_UNAVAILABLE');job.plan=plan;return describe(job);
  });}
  async function receive(input,limit){
   current();await ensureSpace(staging);current();const directory=path.join(staging,randomUUID());fs.mkdirSync(directory,{mode:0o700});const file=path.join(directory,'upload');let output;
   try{addAbortSignal(abortController.signal,input);output=await fsp.open(file,'wx',0o600);const result=await consume(input,{limit,check:current,output,space:staging});await output.close();output=null;return {...result,directory,file};}
   catch(error){await output?.close();await fsp.rm(directory,{recursive:true,force:true}).catch(()=>{});throw error;}
  }
  async function scanStream(input,body){
   current();await sweep();current();if(!input||Object.keys(input).join(',')!=='attempt'||typeof input.attempt!=='string'||!/^[a-f0-9-]{36}$/.test(input.attempt))fail('IMPORT_REQUEST');if([...jobs.values(),...sources.values()].some(j=>j.actor===context.userId))fail('IMPORT_BUSY');
   const artifact=await receive(body,limits.zipBytes);let archive;
   try{archive=await openArchive(artifact.file,artifact,current);return await scanOrigin(input,{archive,artifact});}
   finally{await archive?.close();await fsp.rm(artifact.directory,{recursive:true,force:true});}
  }
  async function zipStream(input,body){
   current();availableName(input?.name);const artifact=await receive(body,limits.zipBytes);let archive;
   try{archive=await openArchive(artifact.file,artifact,current);const entries=archive.entries;for(const entry of entries)if(entry.kind==='directory')await archive.small(entry,0);
    const start=await begin({...input,files:entries.map(({path,kind,size})=>({path,kind,size}))});const job=jobFor(start.id);
    try{for(const index of start.upload)await exclusive(start.id,j=>putStreamJob(j,index,archive.stream(entries[index])));await fsp.rename(artifact.file,path.join(job.stage,'source.zip'));job.zip={size:artifact.size,hash:artifact.hash};return start;}
    catch(error){await drop(job);throw error;}
   }finally{await archive?.close();await fsp.rm(artifact.directory,{recursive:true,force:true});}
  }
  async function zip(input,bytes){if(!Buffer.isBuffer(bytes))fail('IMPORT_REQUEST');return zipStream(input,Readable.from([bytes]));}
  async function commit(id){const completed=receiptFor(id);if(completed)return completed;return exclusive(id,async job=>{
   if(job.plan.entries.some((e,i)=>e.include&&e.kind==='file'&&!job.received.has(i)))fail('IMPORT_INCOMPLETE');
   const uuid=randomUUID(),directory=ownedDirectory(db,context.userId,job.name);let target,reserved=false,created=false;
   try{
    transaction(db,()=>{
     current(true);checkRestore(job.restore);dirOk(root);
     availableName(job.name);
     ensureUserDirectory(root,directory);target=storagePath(root,directory,{missingLeaf:true});
     db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'pending',?)").run(uuid,job.name,directory,now());
     db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").run(uuid,context.userId);audit(context.userId,'begin-import-vault',uuid);reserved=true;
    });
    await fsp.mkdir(target,{mode:0o700});created=true;const identity=await fsp.lstat(target),directories=new Set([target,path.dirname(target),root]);
    await fsp.mkdir(path.join(target,'.obsidian'),{mode:0o700});directories.add(path.join(target,'.obsidian'));
    for(const [i,entry] of job.plan.entries.entries())if(entry.include){
     current();const destination=path.join(target,entry.path),parent=entry.kind==='directory'?destination:path.dirname(destination);
     let folder=target;for(const part of path.relative(target,parent).split(path.sep).filter(Boolean)){folder=path.join(folder,part);try{await fsp.mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}dirOk(folder);directories.add(folder);}
     if(entry.kind==='directory')continue;
     const source=await fsp.open(path.join(job.stage,String(i)),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
     try{const st=await source.stat();if(!st.isFile()||st.nlink!==1||st.size!==entry.size)fail('IMPORT_STORAGE');const output=await fsp.open(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{const result=await consume(entry.size?source.createReadStream({autoClose:false,start:0,end:entry.size-1,highWaterMark:256*1024}):Readable.from([]),{limit:entry.size,expected:entry.size,check:()=>{checkJob(job);checkRestore(job.restore);},output,space:root});if(result.hash!==job.received.get(i))fail('IMPORT_STORAGE');await output.sync();}finally{await output.close();}
     }finally{await source.close();}
    }
    if(!job.plan.entries.some(entry=>entry.include&&entry.path==='.obsidian/community-plugins.json')){
     const disabled=await fsp.open(path.join(target,'.obsidian','community-plugins.json'),'wx',0o600);
     try{await disabled.writeFile('[]');await disabled.sync();}finally{await disabled.close();}
    }
    for(const folder of [...directories].sort((a,b)=>b.length-a.length)){const fd=await fsp.open(folder,'r');try{await fd.sync();}finally{await fd.close();}}
    transaction(db,()=>{current(true);checkRestore(job.restore);storagePath(root,directory);const stat=fs.lstatSync(target);if(stat.isSymbolicLink()||stat.dev!==identity.dev||stat.ino!==identity.ino||db.prepare('SELECT status FROM vaults WHERE id=?').get(uuid)?.status!=='pending')fail('IMPORT_STORAGE');db.prepare("UPDATE vaults SET status='active' WHERE id=?").run(uuid);audit(context.userId,'import-vault',uuid);});
    // A lost confirmation must not create another vault or strand a successful
    // import. Receipts retain no files and remain session-bound and bounded.
    if(receipts.size>=256)receipts.delete(receipts.keys().next().value);
    if(job.source)job.source.completed.set(job.sourceRoot,{result:{id:uuid,name:job.name},key:job.sourceKey});
    receipts.set(job.id,{actor:context.userId,session:context.sessionId,vault:uuid,expires:now()+limits.ttl});
    try{await drop(job);}catch{/* Published successfully; private staging is reclaimed on restart. */}return {id:uuid,name:job.name};
   }catch(error){
    if(reserved)transaction(db,()=>{if(created)db.prepare("UPDATE vaults SET status='quarantine' WHERE id=? AND status='pending'").run(uuid);else db.prepare("DELETE FROM vaults WHERE id=? AND status='pending'").run(uuid);audit(context.userId,created?'quarantine-import-vault':'cancel-import-vault',uuid);});
    throw error;
   }
  },true);}
  function sourceFor(id){current();const source=sources.get(id);if(!source||!source.ready||source.actor!==context.userId||source.session!==context.sessionId||source.expires<=now())fail('IMPORT_UNAVAILABLE');checkSource(source);return source;}
  function describeSource(source){return {id:source.id,vaults:source.layout.vaults.map(({root,name})=>({root,name})),nested:source.layout.nested,outside:source.layout.outside,canRestorePlugins:canRestorePlugins()};}
  async function scan(input,bytes){if(bytes!==undefined){if(!Buffer.isBuffer(bytes))fail('IMPORT_REQUEST');return scanStream(input,Readable.from([bytes]));}return scanOrigin(input);}
  async function scanOrigin(input,bytes){
   current();await sweep();current();
   if(!input||Object.keys(input).sort().join(',')!==(bytes?'attempt':'attempt,files')||typeof input.attempt!=='string'||!/^[a-f0-9-]{36}$/.test(input.attempt))fail('IMPORT_REQUEST');
   if([...jobs.values(),...sources.values()].some(j=>j.actor===context.userId)||new Set([...jobs.values(),...sources.values()].map(j=>j.actor)).size>=limits.concurrent)fail('IMPORT_BUSY');
   const disk=bytes?.archive,zipEntries=disk?disk.entries:null;
   const layout=require('../application/import-source').inspectSource(bytes?zipEntries.map(({path,kind,size})=>({path,kind,size})):input.files);
   // Validate even excluded/outer directory records before accepting the archive.
   if(bytes)for(const entry of zipEntries)if(entry.kind==='directory'){current();await disk.small(entry,0);}
   const id=randomUUID(),stage=path.join(staging,id);fs.mkdirSync(stage,{mode:0o700});
   const source={id,stage,attempt:input.attempt,actor:context.userId,session:context.sessionId,layout,zip:disk?{size:bytes.artifact.size,hash:bytes.artifact.hash}:null,completed:new Map(),deadline:now()+limits.ttl,expires:now()+limits.idle,ready:false};sources.set(id,source);
   try{if(disk)await fsp.rename(bytes.artifact.file,path.join(stage,'source.zip'));current();source.ready=true;return describeSource(source);}
   catch(error){sources.delete(id);await fsp.rm(stage,{recursive:true,force:true});throw error;}
  }
  function sourceKey(input){return JSON.stringify([input.root,input.name,input.configuration,input.restore??'none',[...input.selected].sort()]);}
  function validateSourceRequest(input){checkRestore(input?.restore);if(!input||!['configuration,id,name,root,selected','configuration,id,name,restore,root,selected'].includes(Object.keys(input).sort().join(','))||typeof input.configuration!=='boolean'||typeof input.root!=='string'||!Array.isArray(input.selected)||input.selected.some(p=>typeof p!=='string')||input.selected.length>8)fail('IMPORT_REQUEST');}
  function sourcePlan(input){
   validateSourceRequest(input);
   const source=sourceFor(input.id),vault=source.layout.vaults.find(v=>v.root===input.root);if(!vault)fail('IMPORT_REQUEST');
   const files=vault.indexes.map(i=>{const {path,kind,size}=source.layout.entries[i];return {path:vault.root?path.slice(vault.root.length+1):path,kind,size};});
   availableName(input.name);return {source,vault,files,plan:manifest(files,input.configuration,input.selected,context.role,false,input.restore,!!input.restore&&input.restore!=='none'&&canRestorePlugins())};
  }
  async function reviewSource(input){
   const {source,vault,plan}=sourcePlan(input);
   if(source.zip){const archive=await openArchive(path.join(source.stage,'source.zip'),source.zip,()=>checkSource(source));try{for(const [i,entry] of plan.entries.entries())if(entry.include&&isPreference(entry.path)&&entry.kind==='file')validatePreference(entry.path,await archive.small(archive.entries[vault.indexes[i]]));}finally{await archive.close();}}
   sourceFor(input.id);checkRestore(input.restore);return describe({plan});
  }
  async function prepareSource(input){
   validateSourceRequest(input);const source=sourceFor(input.id),completed=source.completed.get(input.root);
   if(completed){if(completed.key!==sourceKey(input))fail('IMPORT_REQUEST');const vault=db.prepare("SELECT v.id FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE v.id=? AND v.status='active' AND m.user_id=? AND m.role='owner'").get(completed.result.id,context.userId);if(!vault)fail('IMPORT_UNAVAILABLE');return {completed:completed.result};}
   const {vault,files}=sourcePlan(input),key=sourceKey(input);
   const existing=[...jobs.values()].find(j=>j.source===source);if(existing){jobFor(existing.id);if(existing.busy)fail('IMPORT_BUSY');if(existing.sourceKey===key)return {...describe(existing),sourceIndexes:vault.indexes};await cancelJob(existing);sourceFor(source.id);}
   const start=await begin({name:input.name,configuration:input.configuration,restore:input.restore,selected:input.selected,files},source),job=jobs.get(start.id);job.sourceRoot=vault.root;job.sourceKey=key;
   try{
    sourceFor(source.id);
    if(source.zip){
     const archive=await openArchive(path.join(source.stage,'source.zip'),source.zip,()=>checkSource(source));try{for(const i of start.upload){current();await exclusive(start.id,j=>putStreamJob(j,i,archive.stream(archive.entries[vault.indexes[i]])));}}finally{await archive.close();}
     job.zip={...source.zip,source:path.join(source.stage,'source.zip'),indexes:vault.indexes};
    }
    jobFor(start.id);return {...start,sourceIndexes:vault.indexes};
   }catch(error){if(jobs.has(job.id))await drop(job);throw error;}
  }
  async function cancelSource(input){
   current();if(!input||Object.keys(input).length!==1||!['id','attempt'].includes(Object.keys(input)[0])||typeof Object.values(input)[0]!=='string'||!/^[a-f0-9-]{36}$/.test(Object.values(input)[0]))fail('IMPORT_REQUEST');
   const source=input.id?sourceFor(input.id):[...sources.values()].find(s=>s.actor===context.userId&&s.session===context.sessionId&&s.attempt===input.attempt);
   if(source){for(const job of jobs.values())if(job.source===source)await cancelJob(job);sources.delete(source.id);await fsp.rm(source.stage,{recursive:true,force:true});}return {ok:true};
  }
  const claim=mode=>{current();const actors=new Set([...jobs.values(),...sources.values()].map(j=>j.actor));for(const actor of leases.keys())actors.add(actor);if(leases.has(context.userId)||(mode==='zip'&&[...jobs.values()].some(j=>j.actor===context.userId))||(!actors.has(context.userId)&&actors.size>=limits.concurrent))fail('IMPORT_BUSY');const lease=randomUUID();leases.set(context.userId,lease);return ()=>{if(leases.get(context.userId)===lease)leases.delete(context.userId);};};
  return {begin,put,putStream,zip,zipStream,scanStream,select,commit,claim,scan,reviewSource,prepareSource,cancelSource,prepare:async()=>{current();await sweep();current();},cancelAttempt:async attempt=>{current();if(typeof attempt!=='string'||!/^[a-f0-9-]{36}$/.test(attempt))fail('IMPORT_REQUEST');const job=[...jobs.values()].find(j=>j.actor===context.userId&&j.session===context.sessionId&&j.attempt===attempt);if(job)return cancelJob(job);return {ok:true};},abort(){interrupted=true;abortController.abort();const job=jobs.get(createdJob);if(job&&!job.publishing){job.cancelled=true;if(!job.busy)void drop(job).catch(()=>{});}},inspect:(id,completed=false)=>completed&&receiptFor(id)?{busy:false}:jobFor(id),cancel:async id=>cancelJob(jobFor(id))};
 }
 return {scope,cleanup,close(){closed=true;},limits};
}
module.exports={createVaultImport};
