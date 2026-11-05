const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),{pipeline}=require('node:stream/promises'),{createHash}=require('node:crypto');
const archiver=require('archiver'),{openDatabase}=require('../../apps/ignis-server/server/platform/persistence/database'),{createVaultImport}=require('../../apps/ignis-server/server/features/vaults/adapters/vault-import'),{limits}=require('../../apps/ignis-server/server/features/vaults/application/import-policy');
const temporary=fs.mkdtempSync(path.join(process.env.IGNIS_LARGE_IMPORT_ROOT||os.tmpdir(),'ignis-large-')),root=path.join(temporary,'vaults');let db,service,server;
const block=Buffer.alloc(256*1024,97);
async function* bytes(size){for(let position=0;position<size;position+=block.length)yield block.subarray(0,Math.min(block.length,size-position));}
async function digest(file){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file,{highWaterMark:block.length}))hash.update(chunk);return hash.digest('hex');}
function expected(size){const hash=createHash('sha256');for(let position=0;position<size;position+=block.length)hash.update(block.subarray(0,Math.min(block.length,size-position)));return hash.digest('hex');}
(async()=>{
 try{
  const space=fs.statfsSync(temporary,{bigint:true});assert.ok(space.bavail*space.bsize>=5n*1024n*1024n*1024n,'Large import acceptance needs 5 GiB free temporary space');
  fs.mkdirSync(root);db=openDatabase(path.join(temporary,'data'));db.prepare("INSERT INTO users(id,login,role,created_at) VALUES ('alice','alice','user',0)").run();service=createVaultImport({db,root,dataRoot:path.join(temporary,'data'),sessions:{resolve:()=>({id:'session',user:{id:'alice',role:'user',authVersion:1}})}});
  const app=require('express')();app.use((req,_res,next)=>{req.importToken='alice';next();});app.use(require('../../apps/ignis-server/server/transport/http/vault-import').createImportRouter(service));server=require('node:http').createServer(app);require('../../apps/ignis-server/server/transport/http/upload-timeouts').installUploadTimeouts(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const upload=(url,input,size)=>new Promise((resolve,reject)=>{const req=require('node:http').request({host:'127.0.0.1',port:server.address().port,path:url,method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':size}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks)));}catch(error){reject(error);}});});req.on('error',reject);pipeline(input,req).catch(reject);});
  const scope=service.scope('alice'),fileBytes=512*1024*1024,secondBytes=fileBytes-4096,archiveFile=path.join(temporary,'input.zip');
  const archive=archiver('zip',{store:true});const writing=pipeline(archive,fs.createWriteStream(archiveFile,{flags:'wx'}));writing.catch(()=>{});
  archive.append(Readable.from(bytes(fileBytes)),{name:'Old/Large.bin'});archive.append(Readable.from(bytes(secondBytes)),{name:'Old/Second.bin'});await archive.finalize();await writing;
  const zipBytes=fs.statSync(archiveFile).size;assert.ok(zipBytes>1023*1024*1024&&zipBytes<=limits.zipBytes);
  console.log('Large import: ZIP generated; beginning bounded-memory upload.');
  const allocated=Buffer.alloc,unsafe=Buffer.allocUnsafe,concat=Buffer.concat;
  Buffer.alloc=function(size,...args){assert.ok(size<=1024*1024,'No payload-sized Buffer allocation');return allocated(size,...args);};
  Buffer.allocUnsafe=function(size,...args){assert.ok(size<=1024*1024,'No payload-sized unsafe Buffer allocation');return unsafe(size,...args);};
  Buffer.concat=function(chunks,length){assert.ok((length??chunks.reduce((n,b)=>n+b.length,0))<=1024*1024,'No payload concatenation');return concat(chunks,length);};
  const source=await upload('/api/vault/import/scan-zip?attempt=40000000-0000-4000-8000-000000000001',fs.createReadStream(archiveFile,{highWaterMark:block.length}),zipBytes);
  const input={id:source.id,root:'',name:'Large ZIP',configuration:false,selected:[]};await scope.reviewSource(input);const prepared=await scope.prepareSource(input);await scope.commit(prepared.id);await scope.cancelSource({id:source.id});
  assert.equal(fs.statSync(path.join(root,'alice/Large ZIP','Large.bin')).size,fileBytes);assert.equal(await digest(path.join(root,'alice/Large ZIP','Large.bin')),expected(fileBytes));assert.equal(await digest(path.join(root,'alice/Large ZIP','Second.bin')),expected(secondBytes));
  console.log('Large import: ZIP published; beginning folder upload.');
  const folder=await scope.begin({name:'Large folder',configuration:false,files:[{path:'Large.bin',size:fileBytes}]});await upload('/api/vault/import/file?id='+folder.id+'&index=0',Readable.from(bytes(fileBytes)),fileBytes);await scope.commit(folder.id);assert.equal(await digest(path.join(root,'alice/Large folder','Large.bin')),expected(fileBytes));
  console.log('Large import: testing 512-MiB Deflate expansion.');
  const compressedFile=path.join(temporary,'compressed.zip'),compressed=archiver('zip',{zlib:{level:1}}),compressedWriting=pipeline(compressed,fs.createWriteStream(compressedFile));compressedWriting.catch(()=>{});compressed.append(Readable.from(bytes(fileBytes)),{name:'Old/Expanded.bin'});await compressed.finalize();await compressedWriting;const compressedSource=await upload('/api/vault/import/scan-zip?attempt=40000000-0000-4000-8000-000000000002',fs.createReadStream(compressedFile),fs.statSync(compressedFile).size);const expanded=await scope.prepareSource({id:compressedSource.id,root:'',name:'Deflated',configuration:false,selected:[]});await scope.commit(expanded.id);await scope.cancelSource({id:compressedSource.id});assert.equal(await digest(path.join(root,'alice/Deflated','Expanded.bin')),expected(fileBytes));
  assert.deepEqual(fs.readdirSync(path.join(temporary,'data','vault-imports')),[]);
  const peakRssMiB=process.resourceUsage().maxRSS/1024;assert.ok(peakRssMiB<256,`Peak RSS ${peakRssMiB.toFixed(1)} MiB exceeds 256 MiB`);
  console.log(JSON.stringify({largeImports:'passed',zipBytes,fileBytes,totalUncompressed:fileBytes+secondBytes,peakRssMiB:+peakRssMiB.toFixed(1),heapLimitMiB:64,checks:['real near-1-GiB ZIP','512-MiB file','stored and Deflate entry streaming','real HTTP ZIP and folder uploads','byte integrity','no payload-sized allocations','private staging cleanup']}));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));service?.close();db?.close();fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
