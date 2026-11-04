const fs = require('node:fs');

const limits = Object.freeze({fileBytes:4*1024*1024, batchBytes:16*1024*1024,
  requests:16, requestsPerActor:6, workers:2});
const busy = () => Object.assign(new Error('Batch reads temporarily busy'), {status:429});

// Admission bounds both queued work and aggregate response memory. No waiting
// request queue: callers can retry or use the ordinary individual read path.
function createBatchReader({policy=limits, io=fs.promises, pending=()=>null}={}) {
  let active=0;
  const actors=new Map();
  async function read({actor,entries,signal,allowed=()=>true,onResult=()=>{}}) {
    if(active>=policy.requests || (actors.get(actor)||0)>=policy.requestsPerActor)throw busy();
    active++;actors.set(actor,(actors.get(actor)||0)+1);
    const files=Object.create(null);
    let cursor=0,remaining=policy.batchBytes,inputRemaining=policy.batchBytes;
    const check=entry=>{signal.throwIfAborted();if(!allowed(entry))throw Object.assign(new Error('Batch access changed'),{status:403});};
    async function worker() {
      while(cursor<entries.length && inputRemaining>0 && remaining>0) {
        const entry=entries[cursor++];check(entry);
        const {filename,keys}=entry;
        let handle;
        try {
          const buffered=pending(filename);
          let data;
          if(buffered) {
            if(typeof buffered.data==='string')data=buffered.data;
            else if(['utf8','utf-8'].includes(buffered.encoding)) {
              if(buffered.data.length>policy.fileBytes)continue;
              data=buffered.data.toString('utf8');
            } else continue;
            const size=Buffer.byteLength(data);
            if(size>policy.fileBytes || size>inputRemaining)continue;
            inputRemaining-=size;
          } else {
            handle=await io.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
            check(entry);const before=await handle.stat();
            if(!before.isFile() || before.size>policy.fileBytes || before.size>inputRemaining)continue;
            inputRemaining-=before.size;
            // Read only the observed size, plus one byte to detect growth. Never
            // delegate to readFile, which can follow a growing file indefinitely.
            const bytes=Buffer.alloc(before.size+1);let offset=0;
            while(offset<bytes.length) {
              check(entry);const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
              if(!bytesRead)break;offset+=bytesRead;
            }
            const after=await handle.stat();
            if(offset!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)continue;
            data=bytes.subarray(0,offset).toString('utf8');
          }
          check(entry);
          // Include escaping and aliases in the response budget, not just disk
          // bytes: repeated spellings must not amplify a deduplicated read.
          const valueBytes=Buffer.byteLength(JSON.stringify(data));
          const cost=keys.reduce((n,key)=>n+Buffer.byteLength(JSON.stringify(key))+valueBytes+2,0);
          if(cost>remaining)continue;
          remaining-=cost;
          for(const key of keys)files[key]=data;
        } catch(error) {
          if(signal.aborted || error.status===403)throw error;
          // Missing, oversized or changing files fall back to individual reads.
        } finally {await handle?.close();}
      }
    }
    try {
      // Settle every worker before releasing admission, including cancellation.
      const results=await Promise.allSettled(Array.from({length:Math.min(policy.workers,entries.length)},worker));
      const failed=results.find(result=>result.status==='rejected');
      if(failed)throw failed.reason;
      check();await onResult(files);return files;
    } finally {
      active--;const count=actors.get(actor)-1;
      if(count)actors.set(actor,count);else actors.delete(actor);
    }
  }
  return {read};
}
module.exports={createBatchReader,limits};
