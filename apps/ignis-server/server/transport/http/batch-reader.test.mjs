import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {createBatchReader}=require('./batch-reader');
const policy={fileBytes:100,batchBytes:200,requests:2,requestsPerActor:1,workers:2};
const signal=()=>new AbortController().signal;
async function fixture(run) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ignis-batch-'));
 try {await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
it('bounds input and response bytes, skips large files and handles escaped text',async()=>fixture(async root=>{
 const entries=[];
 for(let i=0;i<8;i++){const filename=path.join(root,String(i));await fs.writeFile(filename,i===0?'x'.repeat(101):'\0'.repeat(60));entries.push({filename,keys:[String(i)]});}
 let bytes=0;
 const io={open:async(...args)=>{const handle=await fs.open(...args),read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);bytes+=result.bytesRead;return result;};return handle;}};
 const files=await createBatchReader({policy,io}).read({actor:'a',entries,signal:signal()});
 expect(bytes).toBeLessThanOrEqual(200);expect(Buffer.byteLength(JSON.stringify(files))).toBeLessThanOrEqual(202);
 expect(files['0']).toBeUndefined();
}));
it('bounds workers, rejects excess actor/global requests, and releases admission after abort',async()=>{
 let active=0,peak=0,started=0;const releases=[];
 const io={open:async()=>{started++;active++;peak=Math.max(peak,active);await new Promise(resolve=>releases.push(resolve));return {stat:async()=>({isFile:()=>true,size:1,mtimeMs:0,ctimeMs:0}),read:async(bytes,offset)=>{if(!offset)bytes[0]=65;return {bytesRead:offset?0:1};},close:async()=>{active--;}};}};
 const reader=createBatchReader({policy,io}),entries=Array.from({length:20},(_,i)=>({filename:String(i),keys:[String(i)]}));
 const abort=new AbortController(),first=reader.read({actor:'a',entries,signal:abort.signal});
 const secondAbort=new AbortController(),second=reader.read({actor:'b',entries,signal:secondAbort.signal});
 await expect(reader.read({actor:'a',entries,signal:signal()})).rejects.toMatchObject({status:429});
 await expect(reader.read({actor:'c',entries,signal:signal()})).rejects.toMatchObject({status:429});
 abort.abort();secondAbort.abort();releases.forEach(resolve=>resolve());
 await Promise.all([expect(first).rejects.toThrow(),expect(second).rejects.toThrow()]);
 expect(peak).toBe(4);expect(started).toBe(4);expect(active).toBe(0);
 expect(await reader.read({actor:'a',entries:[],signal:signal()})).toEqual({});
});
it('counts aliases and buffered data against budgets without opening disk files',async()=>{
 const reader=createBatchReader({policy,pending:()=>({data:'text',encoding:'utf8'}),io:{open:()=>{throw Error('must not open');}}});
 const files=await reader.read({actor:'a',signal:signal(),entries:[{filename:'one',keys:['one','./one']},{filename:'two',keys:Array.from({length:80},(_,i)=>String(i))}]});
 expect(files).toEqual({'one':'text','./one':'text'});
});
it('never reads a file that grows past its observed size without a bound',async()=>{
 let allocated=0;
 const io={open:async()=>({stat:async()=>({isFile:()=>true,size:5,mtimeMs:0,ctimeMs:0}),read:async(bytes)=>{allocated=bytes.length;return {bytesRead:bytes.length};},close:async()=>{}})};
 const files=await createBatchReader({policy,io}).read({actor:'a',signal:signal(),entries:[{filename:'grow',keys:['grow']}]});
 expect(allocated).toBe(6);expect(files).toEqual({});
});
it('fails closed if permissions are revoked while opening a file',async()=>fixture(async root=>{
 const filename=path.join(root,'note');await fs.writeFile(filename,'secret');let allowed=true;
 const io={open:async(...args)=>{const result=await fs.open(...args);allowed=false;return result;}};
 await expect(createBatchReader({policy,io}).read({actor:'a',signal:signal(),entries:[{filename,keys:['note']}],allowed:()=>allowed})).rejects.toMatchObject({status:403});
}));
it('holds admission until response delivery completes',async()=>{
 let release,delivering;
 const ready=new Promise(resolve=>{delivering=resolve;});
 const reader=createBatchReader({policy});
 const reading=reader.read({actor:'a',entries:[],signal:signal(),onResult:()=>{delivering();return new Promise(resolve=>{release=resolve;});}});
 await ready;
 await expect(reader.read({actor:'a',entries:[],signal:signal()})).rejects.toMatchObject({status:429});
 release();await reading;
 expect(await reader.read({actor:'a',entries:[],signal:signal()})).toEqual({});
});
