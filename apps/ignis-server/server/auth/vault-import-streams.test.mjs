import {it,expect,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {Readable} from 'node:stream';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),archiver=require('archiver');
const {openDatabase}=require('../platform/persistence/database'),{createVaultImport}=require('../features/vaults/adapters/vault-import'),{openArchive}=require('../features/vaults/adapters/import-archive'),{readZip}=require('../features/vaults/adapters/import-zip'),{limits}=require('../features/vaults/application/import-policy');
let temp,root,db,service,active;
beforeEach(()=>{temp=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-streams-'));root=path.join(temp,'vaults');fs.mkdirSync(root);db=openDatabase(path.join(temp,'data'));db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('alice','alice','user',0)").run();active=true;service=createVaultImport({db,root,dataRoot:path.join(temp,'data'),sessions:{resolve:()=>active?{id:'session',user:{id:'alice',role:'user',authVersion:1}}:null}});});
afterEach(()=>{service.close();db.close();fs.rmSync(temp,{recursive:true,force:true});});
async function archiveBytes(store=false){const archive=archiver('zip',{store}),chunks=[];archive.on('data',b=>chunks.push(b));const done=new Promise((resolve,reject)=>{archive.on('end',resolve);archive.on('error',reject);});archive.append('hello',{name:'Old/Note.md'});archive.append('',{name:'Old/Empty/'});await archive.finalize();await done;return Buffer.concat(chunks);}
const metadata=bytes=>({size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
it.each([true,false])('uses the same index validation for file-backed and memory ZIPs (store=%s)',async store=>{
 const bytes=await archiveBytes(store),file=path.join(temp,'input.zip');fs.writeFileSync(file,bytes);const archive=await openArchive(file,metadata(bytes));try{expect(archive.entries).toEqual(readZip(bytes));expect((await archive.small(archive.entries.find(e=>e.kind==='file'))).toString()).toBe('hello');await archive.small(archive.entries.find(e=>e.kind==='directory'),0);}finally{await archive.close();}
});
it.each(['path','symlink','encrypted','size','overlap'])('rejects malformed ZIP metadata before extracting: %s',async kind=>{
 const bytes=await archiveBytes(),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 if(kind==='path'){const name=Buffer.from('Old/Note.md');for(let p=bytes.indexOf(name);p>=0;p=bytes.indexOf(name,p+name.length))bytes.write('../Note.mdX',p);}
 if(kind==='symlink')bytes.writeUInt32LE((0xa1ff<<16)>>>0,central+38);
 if(kind==='encrypted')bytes.writeUInt16LE(bytes.readUInt16LE(central+8)|1,central+8);
 if(kind==='size')bytes.writeUInt32LE(limits.fileBytes+1,central+24);
 if(kind==='overlap')bytes.writeUInt32LE(0xffffffff,central+42);
 const file=path.join(temp,'bad.zip');fs.writeFileSync(file,bytes);expect(()=>readZip(bytes)).toThrow();await expect(openArchive(file,metadata(bytes))).rejects.toThrow();
});
it('bounds expansion and validates CRC even when the ZIP digest itself matches',async()=>{
 for(const corruptSize of [true,false]){const bytes=await archiveBytes(),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(corruptSize?1:1234,central+(corruptSize?24:16));const file=path.join(temp,'bad.zip');fs.writeFileSync(file,bytes);const archive=await openArchive(file,metadata(bytes));try{await expect(archive.small(archive.entries.find(e=>e.kind==='file'))).rejects.toMatchObject({code:'IMPORT_ZIP'});}finally{await archive.close();}}
});
it('rejects a source archive modified after its handle was pinned',async()=>{
 const bytes=await archiveBytes(),file=path.join(temp,'input.zip');fs.writeFileSync(file,bytes);const archive=await openArchive(file,metadata(bytes));try{fs.writeFileSync(file,bytes);await expect(archive.small(archive.entries[0])).rejects.toMatchObject({code:'IMPORT_STORAGE'});}finally{await archive.close();}
});
it('cleans a failed streaming upload and accepts only identical acknowledged retries',async()=>{
 const scope=service.scope('alice'),stage=await scope.begin({name:'Imported',configuration:false,files:[{path:'Note.md',size:5}]});
 await expect(scope.putStream(stage.id,0,Readable.from((async function*(){yield Buffer.from('he');throw Object.assign(Error('I/O failure'),{code:'EIO'});})()))).rejects.toMatchObject({code:'EIO'});expect(fs.existsSync(path.join(temp,'data','vault-imports',stage.id,'0'))).toBe(false);
 await scope.putStream(stage.id,0,Readable.from([Buffer.from('he'),Buffer.from('llo')]));await scope.putStream(stage.id,0,Readable.from([Buffer.from('hello')]));await expect(scope.putStream(stage.id,0,Readable.from([Buffer.from('other')]))).rejects.toMatchObject({code:'IMPORT_REQUEST'});await scope.commit(stage.id);expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
});
it('rejects oversized/truncated bodies, oversized preferences and revocation without publishing',async()=>{
 const scope=service.scope('alice'),stage=await scope.begin({name:'Imported',configuration:true,files:[{path:'Note.md',size:5},{path:'.obsidian/app.json',size:1024*1024+1}]});
 await expect(scope.putStream(stage.id,0,Readable.from([Buffer.from('too long')]))).rejects.toMatchObject({code:'IMPORT_LIMIT'});await expect(scope.putStream(stage.id,0,Readable.from([Buffer.from('hey')]))).rejects.toMatchObject({code:'IMPORT_REQUEST'});await expect(scope.putStream(stage.id,1,Readable.from([]))).rejects.toMatchObject({code:'IMPORT_LIMIT'});active=false;await expect(scope.putStream(stage.id,0,Readable.from([Buffer.from('hello')]))).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(fs.readdirSync(root)).toEqual([]);
});
it('streams a ZIP into private storage, preserves per-source authority and removes failed scans',async()=>{
 const scope=service.scope('alice'),attempt='30000000-0000-4000-8000-000000000001';await expect(scope.scanStream({attempt},Readable.from([Buffer.from('bad ZIP')]))).rejects.toMatchObject({code:'IMPORT_ZIP'});expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
 const bytes=await archiveBytes(),source=await scope.scanStream({attempt},Readable.from([bytes.subarray(0,20),bytes.subarray(20)])),input={id:source.id,root:'',name:'Imported',configuration:false,selected:[]};const stage=await scope.prepareSource(input);await scope.commit(stage.id);expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');await scope.cancelSource({id:source.id});expect(fs.readdirSync(path.join(temp,'data','vault-imports'))).toEqual([]);
});
it('rejects oversized sparse archives and declared totals without allocating their payload',async()=>{
 const file=path.join(temp,'large.zip'),fd=fs.openSync(file,'w');fs.ftruncateSync(fd,limits.zipBytes+1);fs.closeSync(fd);await expect(openArchive(file,{size:limits.zipBytes+1,hash:'unused'})).rejects.toMatchObject({code:'IMPORT_ZIP'});
 await expect(service.scope('alice').begin({name:'Imported',configuration:false,files:Array.from({length:9},(_,i)=>({path:`file${i}`,size:limits.fileBytes}))})).rejects.toMatchObject({code:'IMPORT_LIMIT'});
});
it('keeps filesystem headroom during upload and recovers after space becomes available',async()=>{
 const scope=service.scope('alice'),stage=await scope.begin({name:'Imported',configuration:false,files:[{path:'Note.md',size:5}]});
 const statfs=fs.promises.statfs;fs.promises.statfs=async()=>({bavail:0n,bsize:4096n});try{await expect(scope.putStream(stage.id,0,Readable.from([Buffer.from('hello')]))).rejects.toMatchObject({code:'IMPORT_SPACE'});}finally{fs.promises.statfs=statfs;}
 expect(fs.existsSync(path.join(temp,'data','vault-imports',stage.id,'0'))).toBe(false);await scope.putStream(stage.id,0,Readable.from([Buffer.from('hello')]));await scope.commit(stage.id);expect(fs.readFileSync(path.join(root,'alice/Imported','Note.md'),'utf8')).toBe('hello');
});

it('preserves valid long UTF-8 paths while bounding the index read size',async()=>{
 const name=Array(5).fill('中'.repeat(80)).join('/')+'/Note.md',archiveWriter=archiver('zip'),chunks=[];archiveWriter.on('data',b=>chunks.push(b));const done=new Promise((resolve,reject)=>{archiveWriter.on('end',resolve);archiveWriter.on('error',reject);});archiveWriter.append('hello',{name:'Old/'+name});await archiveWriter.finalize();await done;const bytes=Buffer.concat(chunks),file=path.join(temp,'unicode.zip');fs.writeFileSync(file,bytes);const archive=await openArchive(file,metadata(bytes));try{expect(archive.entries[0].path).toBe(name);expect((await archive.small(archive.entries[0])).toString()).toBe('hello');}finally{await archive.close();}
});
