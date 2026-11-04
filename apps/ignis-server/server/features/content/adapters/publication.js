const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {transaction}=require('../../../platform/persistence/database');
const {writeOutcome}=require('../../../../../../packages/contracts/src/content');
const identity=stat=>`${stat.ino}:${stat.birthtimeMs}`;
const conflict=code=>{throw Object.assign(new Error('Content changed'),{code});};
function versionOf(item,io,code,onChunk){
  if(!item.stat)return null;
  if(!item.stat.isFile() || item.stat.nlink!==1)conflict(code);
  const fd=io.openSync(item.filename,io.constants.O_RDONLY|io.constants.O_NOFOLLOW);
  try{
    const before=io.fstatSync(fd);
    if(before.dev!==item.stat.dev || before.ino!==item.stat.ino || before.nlink!==1 || !before.isFile())conflict(code);
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
    while(offset<before.size){const n=io.readSync(fd,buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!n)conflict(code);hash.update(buffer.subarray(0,n));onChunk?.(buffer.subarray(0,n));offset+=n;}
    const after=io.fstatSync(fd);
    if(after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)conflict(code);
    return hash.digest('hex');
  }finally{io.closeSync(fd);}
}
function createContentPublisher(db,{io=fs}={}){
  function replace({select,initial,bytes,expectedHash,mode,conflictCode}){
    const filename=initial.item.filename;
    const temporary=path.join(path.dirname(filename),'.ignis-content-'+randomUUID());
    let published=false,baseline,stagedHash;
    if(!['replace','append','copy'].includes(mode))throw new Error('Invalid content operation');
    const fileMode=mode==='copy'?initial.sourceItem.stat.mode&0o777:initial.item.stat?initial.item.stat.mode&0o777:0o600;
    try{
      const fd=io.openSync(temporary,io.constants.O_WRONLY|io.constants.O_CREAT|io.constants.O_EXCL|io.constants.O_NOFOLLOW,fileMode);
      try{
        const hash=createHash('sha256');let offset=0;
        const stage=chunk=>{
          let cursor=0;
          while(cursor<chunk.length){const n=io.writeSync(fd,chunk,cursor,chunk.length-cursor,offset);if(!n)throw Object.assign(new Error('Incomplete staging write'),{code:'EIO'});cursor+=n;offset+=n;}
          hash.update(chunk);
        };
        if(mode==='append')baseline=versionOf(initial.item,io,conflictCode,stage);
        if(mode==='copy')baseline=versionOf(initial.sourceItem,io,conflictCode,stage);
        stage(bytes);stagedHash=hash.digest('hex');
        io.fsyncSync(fd);
      }finally{io.closeSync(fd);}
      return transaction(db,()=>{
        // Re-read permissions, path identity and version after staging, inside the
        // same SQLite transaction as grant identity publication. No await follows.
        const current=select();
        if(current.item.filename!==filename || current.vaultId!==initial.vaultId || current.actorId!==initial.actorId)conflict(conflictCode);
        const actual=versionOf(current.item,io,conflictCode);
        const expected=mode==='append'?baseline:expectedHash;
        if(expected!==undefined && actual!==expected)conflict(conflictCode);
        if(mode==='copy' && (current.sourceItem?.filename!==initial.sourceItem.filename || versionOf(current.sourceItem,io,conflictCode)!==baseline))conflict(conflictCode);
        const replacement=io.lstatSync(temporary);
        io.renameSync(temporary,filename);published=true;
        const parent=io.openSync(path.dirname(filename),io.constants.O_RDONLY|io.constants.O_DIRECTORY);
        try{io.fsyncSync(parent);}finally{io.closeSync(parent);}
        if(current.item.stat)db.prepare('UPDATE shared_resources SET device=?,inode=? WHERE vault_id=? AND path=? AND device=? AND inode=?')
          .run(String(replacement.dev),identity(replacement),current.vaultId,current.relative,String(current.item.stat.dev),identity(current.item.stat));
        const stat=io.lstatSync(filename);
        return {ok:true,outcome:'committed',etag:stagedHash,mtime:stat.mtimeMs,size:stat.size};
      });
    }catch(error){
      if(published)throw Object.assign(new Error('Content publication could not be confirmed'),{code:'CONTENT_WRITE_UNCERTAIN',outcome:'uncertain'});
      error.outcome=writeOutcome(error);throw error;
    }finally{
      try{io.unlinkSync(temporary);}catch{/* Never remove the destination or hide the original result. */}
    }
  }
  return Object.freeze({replace});
}
module.exports={createContentPublisher};
