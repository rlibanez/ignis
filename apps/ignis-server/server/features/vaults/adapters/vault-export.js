const fs = require('node:fs');
const path = require('node:path');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const archiver = require('archiver');
const {limits,portablePath,excludedTransferSegment} = require('../application/transfer-policy');
const fail = code => { throw Object.assign(new Error('Export unavailable'), {code}); };

// Only physical files in the authorized vault are enumerated. Sharing mounts
// belong to the virtual projection and must never enter this archive.
function createVaultExport({vaults, dataRoot, flush = async () => {}}) {
  const staging = path.join(dataRoot, 'vault-exports'), active = new Set();
  fs.mkdirSync(staging, {recursive:true, mode:0o700});
  function storage() { const st=fs.lstatSync(staging); if(!st.isDirectory() || st.isSymbolicLink()) fail('EXPORT_STORAGE'); }
  storage();
  async function cleanup() {
    storage();
    for(const entry of await fs.promises.readdir(staging))
      if(entry.startsWith('export-')) await fs.promises.rm(path.join(staging,entry), {recursive:true,force:true});
  }
  async function prepare(token, reference, configuration, signal, plugins=configuration) {
    const authority = vaults.scope(token).exportAuthority(reference);
    if(typeof configuration !== 'boolean' || typeof plugins !== 'boolean') fail('EXPORT_REQUEST');
    const actor=authority.actor;
    if(active.has(actor) || active.size>=limits.concurrent) fail('EXPORT_BUSY');
    active.add(actor);
    let temporary,disposed=false;
    const dispose=async()=>{if(disposed)return;disposed=true;try{if(temporary)await fs.promises.rm(temporary,{recursive:true,force:true});}
      catch(error){require('@ignis/server-core/src/logger').emit('warn','server.vault.export_cleanup_failed',{errorCode:error?.code});}
      finally{active.delete(actor);}};
    try {
      const rootIdentity=await fs.promises.lstat(authority.path);
      const validate=()=>{signal.throwIfAborted();authority.validate();const st=fs.lstatSync(authority.path);if(st.dev!==rootIdentity.dev || st.ino!==rootIdentity.ino || st.isSymbolicLink())fail('EXPORT_CHANGED');};
      validate(); storage();
      await flush(authority.path); validate();
      const prefix=portablePath(authority.name)||'vault';
      const entries=[],names=new Set();let total=0;
      async function walk(directory, relative='') {
        validate();
        const parent=await fs.promises.lstat(directory);
        if(!parent.isDirectory() || parent.isSymbolicLink()) fail('EXPORT_CHANGED');
        for(const item of await fs.promises.readdir(directory,{withFileTypes:true})) {
          signal.throwIfAborted();
          // Ignis temporary content operations and repository/trash state are not vault content.
          if(excludedTransferSegment(item.name)) continue;
          const itemName=item.name.toLowerCase();
          if(!relative && itemName==='.obsidian' && !configuration && !plugins) continue;
          if(relative.toLowerCase()==='.obsidian') {
            const isCommunityAddOn=itemName==='plugins' || itemName==='community-plugins.json';
            if(isCommunityAddOn ? !plugins : !configuration) continue;
          }
          const name=relative?relative+'/'+item.name:item.name;
          const portable=portablePath(prefix+'/'+name);if(portable===null || names.has(portable.toLowerCase()))fail('EXPORT_PATH');
          names.add(portable.toLowerCase());
          const filename=path.join(directory,item.name),stat=await fs.promises.lstat(filename);
          if(stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink!==1)) continue;
          if(entries.length>=limits.files-1) fail('EXPORT_LIMIT');
          entries.push({filename,name,stat});
          if(stat.isDirectory()) await walk(filename,name);
          else {total+=stat.size;if(stat.size>limits.fileBytes || total>limits.totalBytes)fail('EXPORT_LIMIT');}
        }
        const after=await fs.promises.lstat(directory);
        if(after.dev!==parent.dev || after.ino!==parent.ino || after.isSymbolicLink())fail('EXPORT_CHANGED');
      }
      await walk(authority.path); validate();
      temporary=await fs.promises.mkdtemp(path.join(staging,'export-'));
      const file=path.join(temporary,'vault.zip');
      const archive=archiver('zip',{zlib:{level:5},forceZip64:false});
      let zipBytes=0;
      const bound=new Transform({transform(chunk,encoding,callback){
        try{validate();zipBytes+=chunk.length;if(zipBytes>limits.zipBytes)fail('EXPORT_LIMIT');callback(null,chunk);}catch(error){callback(error);}
      }});
      const output=fs.createWriteStream(file,{flags:'wx',mode:0o600});
      const cancel=new AbortController();
      const workSignal=AbortSignal.any([signal,cancel.signal]);
      const done=pipeline(archive,bound,output,{signal:workSignal});
      // Attach a handler immediately: opening a later input may yield while ZIP
      // output fails (quota, cancellation, authorization or filesystem errors).
      let outputFailure;
      done.catch(error=>{outputFailure=error;cancel.abort(error);});
      try {
        // The outer directory identifies the vault, not a user content folder.
        archive.append('',{name:prefix+'/'});
        for(const entry of entries) {
          validate();
          // Recheck every parent and leaf immediately before opening; never
          // delegate filename opening to archiver's asynchronous directory walker.
          let parent=authority.path;
          for(const part of path.dirname(entry.name).split('/').filter(p=>p!=='.')) {
            parent=path.join(parent,part);const st=await fs.promises.lstat(parent);
            if(!st.isDirectory() || st.isSymbolicLink())fail('EXPORT_CHANGED');
          }
          const st=await fs.promises.lstat(entry.filename);
          if(st.dev!==entry.stat.dev || st.ino!==entry.stat.ino || st.isSymbolicLink())fail('EXPORT_CHANGED');
          if(st.isDirectory()){archive.append('',{name:prefix+'/'+entry.name+'/',date:st.mtime});continue;}
          const handle=await fs.promises.open(entry.filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
          try {
            const current=await handle.stat();
            if(!current.isFile() || current.nlink!==1 || current.dev!==st.dev || current.ino!==st.ino || current.size!==entry.stat.size)fail('EXPORT_CHANGED');
            let bytes=0;
            const checked=new Transform({transform(chunk,encoding,callback){
              try{validate();bytes+=chunk.length;if(bytes>entry.stat.size)fail('EXPORT_CHANGED');callback(null,chunk);}catch(error){callback(error);}
            },flush(callback){callback(bytes===entry.stat.size?null:Object.assign(new Error('Export changed'),{code:'EXPORT_CHANGED'}));}});
            archive.append(checked,{name:prefix+'/'+entry.name,date:st.mtime});
            await pipeline(handle.createReadStream({autoClose:false}),checked,{signal:workSignal});
            const after=await handle.stat();
            if(after.mtimeMs!==current.mtimeMs || after.ctimeMs!==current.ctimeMs)fail('EXPORT_CHANGED');
          }finally{await handle.close();}
        }
        await archive.finalize(); await done; validate();
      }catch(error){archive.destroy(error);await done.catch(()=>{});throw outputFailure||error;}
      return {file,name:authority.name+'.zip',validate,dispose};
    }catch(error){await dispose();throw error;}
  }
  return {prepare,cleanup};
}
module.exports={createVaultExport};
