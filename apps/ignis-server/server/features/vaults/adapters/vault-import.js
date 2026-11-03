const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const {randomUUID,createHash}=require('node:crypto');
const {transaction}=require('../../../platform/persistence/database');
const {sessionContext,matchesSession}=require('../../../../../../packages/contracts/src/session');
const {validVaultName}=require('../application/vault-name');const {limits,fail,manifest}=require('../application/import-policy');
const {readZip,zipFile}=require('./import-zip');
function createVaultImport({db,root,dataRoot,sessions,now=Date.now}){
 const staging=path.join(dataRoot,'vault-imports'),jobs=new Map(),leases=new Map(),receipts=new Map();let closed=false;
 const dirOk=directory=>{const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())fail('IMPORT_STORAGE');};
 fs.mkdirSync(staging,{recursive:true,mode:0o700});dirOk(staging);
 async function drop(job){jobs.delete(job.id);await fsp.rm(job.stage,{recursive:true,force:true});}
 async function cleanup(){dirOk(staging);for(const entry of await fsp.readdir(staging))if(/^[a-f0-9-]{36}$/.test(entry))await fsp.rm(path.join(staging,entry),{recursive:true,force:true});}
 async function sweep(){for(const [id,receipt] of receipts)if(receipt.expires<=now())receipts.delete(id);for(const job of jobs.values())if(!job.busy&&job.expires<=now())await drop(job);}
 const audit=(actor,action,id)=>db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(),actor,action,id,now());
 function scope(token){
  let interrupted=false,createdJob=null;
  const original=sessions.resolve(token);if(!original)fail('SESSION_CHANGED');const context=sessionContext(original);
  const current=(withinTransaction=false)=>{if(interrupted||closed||!matchesSession(context,sessions.resolve(token,{withinTransaction})))fail('SESSION_CHANGED');};
  function jobFor(id){current();const job=jobs.get(id);if(!job||job.actor!==context.userId||job.session!==context.sessionId||job.expires<=now()||job.cancelled)fail('IMPORT_UNAVAILABLE');return job;}
  function receiptFor(id){
   current();const receipt=receipts.get(id);if(!receipt)return null;
   if(receipt.actor!==context.userId||receipt.session!==context.sessionId||receipt.expires<=now())fail('IMPORT_UNAVAILABLE');
   const vault=db.prepare("SELECT v.id,v.name FROM vaults v JOIN memberships m ON m.vault_id=v.id WHERE v.id=? AND v.status='active' AND m.user_id=? AND m.role='owner'").get(receipt.vault,context.userId);
   if(!vault)fail('IMPORT_UNAVAILABLE');return {id:vault.id,name:vault.name};
  }
  function availableName(name){
   if(!validVaultName(name))fail('IMPORT_REQUEST');
   dirOk(root);
   if(fs.existsSync(path.join(root,name))||db.prepare('SELECT 1 FROM vaults WHERE directory=? OR id=?').get(name,name)||db.prepare('SELECT 1 FROM vault_renames WHERE source=? OR target=?').get(name,name)||db.prepare("SELECT 1 FROM vault_deletions WHERE vault_id=? OR (state='pending' AND source=?)").get(name,name))fail('VAULT_EXISTS');
  }
  async function begin(input){
   current();await sweep();current();
   if(!input||Object.keys(input).some(k=>!['name','configuration','files','attempt','selected'].includes(k))||!validVaultName(input.name)||typeof input.configuration!=='boolean')fail('IMPORT_REQUEST');
   if(input.attempt!==undefined&&(typeof input.attempt!=='string'||!/^[a-f0-9-]{36}$/.test(input.attempt)))fail('IMPORT_REQUEST');
   const plan=manifest(input.files,input.configuration,input.selected,context.role);
   availableName(input.name);
   if(jobs.size>=limits.concurrent||[...jobs.values()].some(j=>j.actor===context.userId))fail('IMPORT_BUSY');
   const id=randomUUID(),stage=path.join(staging,id);fs.mkdirSync(stage,{mode:0o700});
   const job={id,stage,attempt:input.attempt,actor:context.userId,session:context.sessionId,name:input.name,configuration:input.configuration,plan,expires:now()+limits.ttl,received:new Map(),busy:false};jobs.set(id,job);createdJob=id;
   return describe(job);
  }
  function describe({id,plan}){return {id,files:plan.entries.filter(e=>e.kind==='file').length,directories:plan.entries.filter(e=>e.kind==='directory').length,bytes:plan.total,excluded:plan.excluded,excludedEntries:plan.excludedEntries,upload:plan.entries.map((e,i)=>e.include&&e.kind==='file'?i:null).filter(i=>i!==null),limits};
  }
  async function cancelJob(job){
   // Publication has a separate, explicit confirmation boundary. Uploads can be
   // canceled while a write is settling; publication cannot promise that undo.
   if(job.publishing)fail('IMPORT_BUSY');
   job.cancelled=true;if(!job.busy)await drop(job);return {ok:true};
  }
  async function exclusive(id,action,publishing=false){
   const job=jobFor(id);if(job.busy)fail('IMPORT_BUSY');job.busy=true;job.publishing=publishing;
   try{return await action(job);}finally{job.busy=false;job.publishing=false;if(job.cancelled&&jobs.get(job.id)===job)await drop(job);}
  }
  async function putJob(job,index,bytes,plan=job.plan){
   const entry=plan.entries[index];if(!Number.isSafeInteger(index)||!entry?.include||entry.kind!=='file'||!Buffer.isBuffer(bytes)||bytes.length!==entry.size)fail('IMPORT_REQUEST');
   const checksum=createHash('sha256').update(bytes).digest('hex');
   if(job.received.has(index)){if(job.received.get(index)!==checksum)fail('IMPORT_REQUEST');return {ok:true};}
   if(entry.path.startsWith('.obsidian/')){if(bytes.length>1024*1024)fail('IMPORT_LIMIT');let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('IMPORT_CONFIGURATION');}
    const inspect=(v,depth=0)=>{if(depth>32)fail('IMPORT_CONFIGURATION');if(v&&typeof v==='object')for(const key of Object.keys(v)){if(['__proto__','constructor','prototype'].includes(key))fail('IMPORT_CONFIGURATION');inspect(v[key],depth+1);}};
    if(!value||typeof value!=='object')fail('IMPORT_CONFIGURATION');
    if(entry.path==='.obsidian/core-plugins.json'){
     const identifier=id=>typeof id==='string'&&/^[a-z0-9-]+$/.test(id);
     // Obsidian reads the legacy enabled-ID list and the current boolean map.
     if(Array.isArray(value)?value.some(id=>!identifier(id)):Object.entries(value).some(([id,enabled])=>!identifier(id)||typeof enabled!=='boolean'))fail('IMPORT_CONFIGURATION');
    }else if(Array.isArray(value))fail('IMPORT_CONFIGURATION');
    inspect(value);
   }
   current();const file=path.join(job.stage,String(index));try{await fsp.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(error){
    if(error.code!=='EEXIST')await fsp.unlink(file).catch(()=>{});throw error;
   }try{current();if(job.cancelled)fail('IMPORT_UNAVAILABLE');}catch(error){await fsp.unlink(file);throw error;}job.received.set(index,checksum);return {ok:true};
  }
  async function put(id,index,bytes){return exclusive(id,job=>putJob(job,index,bytes));}
  async function select(id,selected){return exclusive(id,async job=>{
   const plan=manifest(job.plan.entries.map(({path,kind,size})=>({path,kind,size})),job.configuration,selected,context.role);
   if(job.zip&&plan.entries.some((entry,index)=>entry.include&&entry.kind==='file'&&!job.received.has(index))){
    const source=await fsp.open(path.join(job.stage,'source.zip'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
    try{const stat=await source.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==job.zip.size)fail('IMPORT_STORAGE');bytes=await source.readFile();}finally{await source.close();}
    if(createHash('sha256').update(bytes).digest('hex')!==job.zip.hash)fail('IMPORT_STORAGE');
    const entries=readZip(bytes);
    for(const [index,entry] of plan.entries.entries())if(entry.include&&entry.kind==='file'&&!job.received.has(index)){current();await putJob(job,index,await zipFile(bytes,entries[index]),plan);}
   }
   current();if(job.cancelled)fail('IMPORT_UNAVAILABLE');job.plan=plan;return describe(job);
  });}
  async function zip(input,bytes){
   current();availableName(input?.name);const entries=readZip(bytes);for(const entry of entries)if(entry.kind==='directory'){current();await zipFile(bytes,entry);}
   const start=await begin({...input,files:entries.map(e=>({path:e.path,kind:e.kind,size:e.size}))});
   try{for(const i of start.upload){current();await put(start.id,i,await zipFile(bytes,entries[i]));}
    const job=jobFor(start.id);await exclusive(start.id,async()=>{await fsp.writeFile(path.join(job.stage,'source.zip'),bytes,{flag:'wx',mode:0o600});current();if(job.cancelled)fail('IMPORT_UNAVAILABLE');job.zip={size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};});return start;}
   catch(error){const job=jobs.get(start.id);if(job)await drop(job);throw error;}
  }
  async function commit(id){const completed=receiptFor(id);if(completed)return completed;return exclusive(id,async job=>{
   if(job.plan.entries.some((e,i)=>e.include&&e.kind==='file'&&!job.received.has(i)))fail('IMPORT_INCOMPLETE');
   const uuid=randomUUID(),target=path.join(root,job.name);let reserved=false,created=false;
   try{
    transaction(db,()=>{
     current(true);dirOk(root);
     availableName(job.name);
     db.prepare("INSERT INTO vaults(id,name,directory,status,created_at) VALUES (?,?,?,'pending',?)").run(uuid,job.name,job.name,now());
     db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").run(uuid,context.userId);audit(context.userId,'begin-import-vault',uuid);reserved=true;
    });
    await fsp.mkdir(target,{mode:0o700});created=true;const identity=await fsp.lstat(target),directories=new Set([target,root]);
    await fsp.mkdir(path.join(target,'.obsidian'),{mode:0o700});directories.add(path.join(target,'.obsidian'));
    for(const [i,entry] of job.plan.entries.entries())if(entry.include){
     current();const destination=path.join(target,entry.path),parent=entry.kind==='directory'?destination:path.dirname(destination);
     let folder=target;for(const part of path.relative(target,parent).split(path.sep).filter(Boolean)){folder=path.join(folder,part);try{await fsp.mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}dirOk(folder);directories.add(folder);}
     if(entry.kind==='directory')continue;
     const source=await fsp.open(path.join(job.stage,String(i)),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
     try{const st=await source.stat();if(!st.isFile()||st.nlink!==1||st.size!==entry.size)fail('IMPORT_STORAGE');const output=await fsp.open(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{const bytes=await source.readFile();current();if(createHash('sha256').update(bytes).digest('hex')!==job.received.get(i))fail('IMPORT_STORAGE');await output.writeFile(bytes);await output.sync();}finally{await output.close();}}finally{await source.close();}
    }
    const disabled=await fsp.open(path.join(target,'.obsidian','community-plugins.json'),'wx',0o600);try{await disabled.writeFile('[]');await disabled.sync();}finally{await disabled.close();}
    for(const folder of [...directories].sort((a,b)=>b.length-a.length)){const fd=await fsp.open(folder,'r');try{await fd.sync();}finally{await fd.close();}}
    transaction(db,()=>{current(true);dirOk(root);const stat=fs.lstatSync(target);if(stat.isSymbolicLink()||stat.dev!==identity.dev||stat.ino!==identity.ino||db.prepare('SELECT status FROM vaults WHERE id=?').get(uuid)?.status!=='pending')fail('IMPORT_STORAGE');db.prepare("UPDATE vaults SET status='active' WHERE id=?").run(uuid);audit(context.userId,'import-vault',uuid);});
    // A lost confirmation must not create another vault or strand a successful
    // import. Receipts retain no files and remain session-bound and bounded.
    if(receipts.size>=256)receipts.delete(receipts.keys().next().value);
    receipts.set(job.id,{actor:context.userId,session:context.sessionId,vault:uuid,expires:now()+limits.ttl});
    try{await drop(job);}catch{/* Published successfully; private staging is reclaimed on restart. */}return {id:uuid,name:job.name};
   }catch(error){
    if(reserved)transaction(db,()=>{if(created)db.prepare("UPDATE vaults SET status='quarantine' WHERE id=? AND status='pending'").run(uuid);else db.prepare("DELETE FROM vaults WHERE id=? AND status='pending'").run(uuid);audit(context.userId,created?'quarantine-import-vault':'cancel-import-vault',uuid);});
    throw error;
   }
  },true);}
  const claim=mode=>{current();const actors=new Set([...jobs.values()].map(j=>j.actor));for(const actor of leases.keys())actors.add(actor);if(leases.has(context.userId)||(mode==='zip'&&[...jobs.values()].some(j=>j.actor===context.userId))||(!actors.has(context.userId)&&actors.size>=limits.concurrent))fail('IMPORT_BUSY');const lease=randomUUID();leases.set(context.userId,lease);return ()=>{if(leases.get(context.userId)===lease)leases.delete(context.userId);};};
  return {begin,put,zip,select,commit,claim,prepare:async()=>{current();await sweep();current();},cancelAttempt:async attempt=>{current();if(typeof attempt!=='string'||!/^[a-f0-9-]{36}$/.test(attempt))fail('IMPORT_REQUEST');const job=[...jobs.values()].find(j=>j.actor===context.userId&&j.session===context.sessionId&&j.attempt===attempt);if(job)return cancelJob(job);return {ok:true};},abort(){interrupted=true;const job=jobs.get(createdJob);if(job&&!job.publishing){job.cancelled=true;if(!job.busy)void drop(job).catch(()=>{});}},inspect:(id,completed=false)=>completed&&receiptFor(id)?{busy:false}:jobFor(id),cancel:async id=>cancelJob(jobFor(id))};
 }
 return {scope,cleanup,close(){closed=true;},limits};
}
module.exports={createVaultImport};
