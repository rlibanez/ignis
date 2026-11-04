const fs=require('node:fs');const {createHash}=require('node:crypto');
const {fail}=require('../application/import-policy');
const chunkBytes=256*1024;
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
async function ensureSpace(directory,bytes=0){const stat=await fs.promises.statfs(directory,{bigint:true});if(stat.bavail*stat.bsize<BigInt(bytes)+128n*1024n*1024n)fail('IMPORT_SPACE');}
function crcUpdate(crc,bytes){for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return crc;}
const stamp=st=>[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':');
async function consume(input,{limit,expected,check=()=>{},output,onChunk,space}={}){
 const hash=createHash('sha256');let size=0,quotaAt=-1;
 // Keep an HTTP body readable after a validation error so the route can flush
 // its rejection before closing the connection. Buffers remain bounded.
 const iterator=input.iterator?input.iterator({destroyOnReturn:false}):input;
 for await(const value of iterator){
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
  for(let start=0;start<bytes.length;start+=chunkBytes){
   check();const chunk=bytes.subarray(start,start+chunkBytes);size+=chunk.length;if(size>limit||(expected!==undefined&&size>expected))fail('IMPORT_LIMIT');
   hash.update(chunk);onChunk?.(chunk);
   if(output){if(space&&size>quotaAt){await ensureSpace(space,1024*1024);quotaAt=size+1024*1024;}let written=0;while(written<chunk.length){check();const result=await output.write(chunk,written,chunk.length-written,null);if(!result.bytesWritten)fail('IMPORT_STORAGE');written+=result.bytesWritten;}}
  }
 }
 check();if(expected!==undefined&&size!==expected)fail('IMPORT_REQUEST');return {size,hash:hash.digest('hex')};
}
async function small(input,limit,check){const chunks=[];await consume(input,{limit,check,onChunk:chunk=>chunks.push(Buffer.from(chunk))});return Buffer.concat(chunks);}
async function openPinned(file,expected,check=()=>{}){
 const handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||Number(before.size)!==expected.size)fail('IMPORT_STORAGE');
  const identity=stamp(before);
  const validate=async()=>{check();const after=await handle.stat({bigint:true});if(after.nlink!==1n||stamp(after)!==identity)fail('IMPORT_STORAGE');};
  const stream=(start=0,length=expected.size)=>length?handle.createReadStream({start,end:start+length-1,autoClose:false,highWaterMark:chunkBytes}):require('node:stream').Readable.from([]);
  const actual=await consume(stream(),{limit:expected.size,expected:expected.size,check});await validate();if(actual.hash!==expected.hash)fail('IMPORT_STORAGE');
  return {handle,validate,stream,close:()=>handle.close()};
 }catch(error){await handle.close();throw error;}
}
module.exports={chunkBytes,crcUpdate,consume,small,openPinned,ensureSpace};
