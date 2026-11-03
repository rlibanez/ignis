// Opt-in bounded load acceptance against a real disposable server, not a microbenchmark.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {waitForServerStarted} from './lib/server-readiness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {performance} from 'node:perf_hooks';
const repo=fileURLToPath(new URL('../',import.meta.url));
const {values:options}=parseArgs({options:{
  profile:{type:'string',default:'baseline'}, runs:{type:'string',default:'1'},
  samples:{type:'string',default:'10'}, warmup:{type:'string',default:'2'},
  output:{type:'string'},
}});
const profiles={baseline:[[1000,10],[10000,100]],stress:[[25000,1000]]};
function integer(value,name,min,max){
  if(!/^\d+$/.test(value) || Number(value)<min || Number(value)>max)throw Error(`Invalid --${name}: expected ${min}–${max}`);
  return Number(value);
}
if(!profiles[options.profile])throw Error('Invalid --profile: baseline or stress');
const runs=integer(options.runs,'runs',1,10),samples=integer(options.samples,'samples',5,30),warmup=integer(options.warmup,'warmup',1,5);
if(options.output){fs.mkdirSync(path.dirname(path.resolve(options.output)),{recursive:true});fs.writeFileSync(options.output,'',{flag:'wx'});}
const require=createRequire(import.meta.url);
const {openDatabase}=require('../apps/ignis-server/server/auth/database');
const {bootstrapAdmin,registerVault}=require('../apps/ignis-server/server/auth/store');
const {hashPassword}=require('../apps/ignis-server/server/auth/password');
const {createResourceSharesService}=require('../apps/ignis-server/server/auth/resource-shares');
function launch(root, env = {}) {
  const child = spawn(
    process.execPath,
    [path.join(repo,"apps/ignis-server/server/index.js")],
    {
      cwd: repo,
      env: {
        // Do not inherit deployment settings, credentials or logging destinations.
        ...Object.fromEntries(['PATH','HOME','TMPDIR','TZ','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),
        IGNIS_LOG_FORMAT: 'json', IGNIS_LOG_LEVEL: 'info', IGNIS_LOG_FILE_ENABLED: 'false',
        PORT: "0",
        DATA_ROOT: path.join(root, "data"),
        VAULT_ROOT: path.join(root, "vaults"),
        OBSIDIAN_ASSETS_PATH: path.join(root, "assets"),
        IGNIS_PUBLIC_ORIGIN: "http://localhost:8080",
        IGNIS_ALLOW_HTTP_LOOPBACK: "true",
        IGNIS_TRUSTED_PROXIES: "[]",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Drain both pipes: a full stderr pipe must not stall a measured process.
  child.stderr.resume();
  const ready=waitForServerStarted(child);
  child.stdout.on('data',()=>{});
  return {child,ready};
}
function request(port, route, jar = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: options.method || "GET",
        headers: {
          host: "localhost:8080",
          origin: "http://localhost:8080",
          cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          "content-type": "application/json",
          ...(options.body ? {"content-length":Buffer.byteLength(JSON.stringify(options.body))}:{}),
          ...options.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("error", reject);
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          for (const cookie of res.headers["set-cookie"] || []) {
            const [k, v] = cookie.split(";")[0].split("=");
            jar[k] = v;
          }
          resolve({ status: res.statusCode, text, headers: res.headers });
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}
async function stop(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
}

const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
const summary=values=>({samples:values.length,p50Ms:+percentile(values,.5).toFixed(1),p95Ms:+percentile(values,.95).toFixed(1),maxMs:+Math.max(...values).toFixed(1)});
const password='isolated-load-fixture-only-2026';
const cgroup=name=>{try{return fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();}catch{return null;}};
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const hash=value=>createHash('sha256').update(value).digest('hex');
const productDiff=git('diff','HEAD','--','apps','packages','package.json','package-lock.json');
const results={schemaVersion:1,fixtureVersion:1,profile:options.profile,runs,samples,warmup,
  sourceCommit:git('rev-parse','HEAD'),upstreamBase:git('merge-base','HEAD','upstream/main'),
  productDiffSha256:productDiff?hash(productDiff):null,
  harnessSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url),'utf8')+fs.readFileSync(new URL('./lib/server-readiness.mjs',import.meta.url),'utf8')),
  applicationVersion:JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8')).version,
  obsidianAssets:'synthetic; no Obsidian runtime loaded',
  cpuModel:os.cpus()[0]?.model,arch:process.arch,kernel:os.release(),totalMemoryBytes:os.totalmem(),
  fixture:{notePayloadBytes:Buffer.byteLength('# Synthetic note\n'+'x'.repeat(1000)),copyFiles:1200,copyPayloadBytes:Buffer.byteLength('copy 0\n'+'x'.repeat(1000)),transport:'HTTP localhost, no compression, sequential samples',crypto:'scrypt login excluded from operation samples'},
  cpuMax:cgroup('cpu.max'),memoryMax:cgroup('memory.max'),node:process.version,platform:process.platform,cpus:os.availableParallelism(),date:new Date().toISOString(),scenarios:[]};
async function scenario(fileCount,shareCount,run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-load-'));
 let db,server,sampler;let peakRssKiB=0;
 const metric={run,fileCount,shareCount};
 try{
  fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets/index.html'),'<script src="app.js"></script>');
  const vaultRoot=path.join(root,'vaults');
  for(const name of ['Owner','Receiver'])fs.mkdirSync(path.join(vaultRoot,name),{recursive:true});
  const ownerPath=path.join(vaultRoot,'Owner');
  for(let i=0;i<fileCount;i++){
   const directory=path.join(ownerPath,'Folder'+Math.floor(i/100));fs.mkdirSync(directory,{recursive:true});
   fs.writeFileSync(path.join(directory,`note${i}.md`),'# Synthetic note\n'+('x'.repeat(1000)));
  }
  for(let i=0;i<shareCount;i++){
   const directory=path.join(ownerPath,'Shared'+i);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'note.md'),'shared '+i);
  }
  fs.mkdirSync(path.join(ownerPath,'CopySource'));
  for(let i=0;i<1200;i++)fs.writeFileSync(path.join(ownerPath,'CopySource',i+'.md'),'copy '+i+'\n'+'x'.repeat(1000));
  db=openDatabase(path.join(root,'data'));bootstrapAdmin(db,'admin',await hashPassword(password));
  for(const id of ['owner','receiver','outsider']){
   db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,'user',0)").run(id,id);
   db.prepare('INSERT INTO local_credentials SELECT ?,password_hash,updated_at FROM local_credentials LIMIT 1').run(id);
  }
  const owner=registerVault(db,vaultRoot,'Owner','owner'),receiver=registerVault(db,vaultRoot,'Receiver','receiver');
  const service=createResourceSharesService(db,vaultRoot,{resolve:id=>({user:{id,authVersion:db.prepare('SELECT auth_version FROM users WHERE id=?').get(id).auth_version}})});
  for(let i=0;i<shareCount;i++){
   const id=service.create('owner',{vault:owner.id,path:'Shared'+i,login:'receiver',role:'reader'}).id;
   service.destination('receiver',{id,vault:receiver.id,localPath:'Received'+i});
  }
  db.close();db=null;
  const started=performance.now();server=launch(root,{IGNIS_OIDC_ENABLED:'false',IGNIS_INITIAL_ADMIN_KEY:'',IGNIS_SHARED_RESOURCE_MAX_FILE_MIB:'8'});const port=await server.ready;
  metric.startupMs=+(performance.now()-started).toFixed(1);
  const sample=()=>{try{const text=fs.readFileSync(`/proc/${server.child.pid}/status`,'utf8');peakRssKiB=Math.max(peakRssKiB,Number(text.match(/VmHWM:\s+(\d+)/)?.[1]||0));}catch{/* process may have exited */}};
  sample();sampler=setInterval(sample,50);
  async function client(login){
   const jar={};const challenge=JSON.parse((await request(port,'/api/auth/csrf',jar)).text).csrfToken;
   assert.equal((await request(port,'/api/auth/login',jar,{method:'POST',headers:{'x-ignis-csrf':challenge},body:{login,password}})).status,200);
   const session=JSON.parse((await request(port,'/api/auth/session',jar)).text),csrf=JSON.parse((await request(port,'/api/auth/csrf',jar)).text).csrfToken;
   return (route,body)=>request(port,route,jar,{method:body?'POST':'GET',headers:{'x-ignis-csrf':csrf,'x-ignis-context':session.sessionId},...(body?{body}:{})});
  }
  const alice=await client('owner'),bob=await client('receiver'),outsider=await client('outsider');
  async function measure(name,fn,check){
   for(let i=0;i<warmup;i++){const response=await fn();assert.equal(response.status,200,response.text.slice(0,200));check?.(response);}
   const times=[];let bytes=0;
   for(let i=0;i<samples;i++){const start=performance.now(),response=await fn();times.push(performance.now()-start);assert.equal(response.status,200,response.text.slice(0,200));check?.(response);bytes=Buffer.byteLength(response.text);}
   metric[name]={...summary(times),rawMs:times.map(value=>+value.toFixed(3)),responseBytes:bytes};
  }
  await measure('tree',()=>alice('/api/fs/tree?vault='+owner.id),r=>assert.ok(r.text.includes('Folder0/note0.md')));
  await measure('catalog',()=>bob('/api/shares'),r=>assert.equal(JSON.parse(r.text).resources.length,shareCount));
  await measure('mounts',()=>bob('/api/shares',{operation:'mounts',input:{vault:receiver.id}}),r=>assert.equal(JSON.parse(r.text).mounts.length,shareCount));
  await measure('bootstrap',()=>alice('/api/bootstrap?vault='+owner.id),r=>assert.equal(JSON.parse(r.text).vault.uuid,owner.id));
  await measure('read',()=>alice('/api/fs/readFile?vault='+owner.id+'&path=Folder0/note0.md&encoding=utf8'),r=>assert.ok(r.text.startsWith('# Synthetic note')));
  let version=hash(fs.readFileSync(path.join(ownerPath,'Folder0/note0.md'))),sequence=0;
  await measure('write',()=>alice('/api/fs/writeFile',{vault:owner.id,path:'Folder0/note0.md',content:`# Synthetic note\nversion ${++sequence}`,encoding:'utf8',expectedHash:version}),r=>{
   const result=JSON.parse(r.text);version=result.etag;
   assert.equal(version,hash(fs.readFileSync(path.join(ownerPath,'Folder0/note0.md'))));
  });
  const probesDuringTree=[];
  const busyTree=alice('/api/fs/tree?vault='+owner.id);
  for(let i=0;i<5;i++){const start=performance.now();assert.equal((await bob('/api/auth/session')).status,200);probesDuringTree.push(performance.now()-start);}
  assert.equal((await busyTree).status,200);metric.sessionDuringTree=summary(probesDuringTree);
  assert.equal((await outsider('/api/fs/tree?vault='+owner.id)).status,404);
  assert.equal(JSON.parse((await outsider('/api/shares')).text).resources.length,0);
  const from={id:null,vault:owner.id,path:'CopySource'},copies=[],copyStarted=performance.now();
  for(let i=0;i<6;i++)copies.push(alice('/api/shares',{operation:'copy',input:{from,to:{id:null,vault:owner.id,path:'Copy'+i}}}));
  const probes=[];for(let i=0;i<12;i++){const start=performance.now();assert.equal((await bob('/api/auth/session')).status,200);probes.push(performance.now()-start);}
  const responses=await Promise.all(copies),copyElapsed=performance.now()-copyStarted;const statuses=responses.map(r=>r.status);
  assert.deepEqual([...statuses].sort(),[200,200,503,503,503,503]);
  for(let i=0;i<responses.length;i++){
   if(responses[i].status===503){assert.equal(JSON.parse(responses[i].text).code,'SHARE_COPY_BUSY');assert.equal(fs.existsSync(path.join(ownerPath,'Copy'+i)),false);}
   else {const destination=path.join(ownerPath,'Copy'+i);assert.equal(fs.readdirSync(destination).length,1200);for(let n=0;n<1200;n++)assert.deepEqual(fs.readFileSync(path.join(destination,n+'.md')),fs.readFileSync(path.join(ownerPath,'CopySource',n+'.md')));}
  }
  assert.equal(fs.readdirSync(ownerPath).some(n=>n.startsWith('.ignis-copy-')),false);
  metric.concurrentCopies={requested:6,totalMs:+copyElapsed.toFixed(1),statuses,sessionResponse:summary(probes)};
  await measure('postLoadRead',()=>alice('/api/fs/readFile?vault='+owner.id+'&path=Folder0/note0.md&encoding=utf8'),r=>assert.ok(r.text.startsWith('# Synthetic note')));
  sample();metric.peakServerRssMiB=+(peakRssKiB/1024).toFixed(1);
  results.scenarios.push(metric);console.error(JSON.stringify(metric));
 }finally{clearInterval(sampler);db?.close();if(server)await stop(server.child);fs.rmSync(root,{recursive:true,force:true});}
}
for(let run=1;run<=runs;run++)for(const [files,shares] of profiles[options.profile])await scenario(files,shares,run);
results.medians=profiles[options.profile].map(([fileCount,shareCount])=>{
 const group=results.scenarios.filter(row=>row.fileCount===fileCount && row.shareCount===shareCount);
 const metric={fileCount,shareCount};
 for(const name of ['tree','catalog','mounts','bootstrap','read','write','postLoadRead','sessionDuringTree']){
  metric[name]={p50Ms:percentile(group.map(row=>row[name].p50Ms),.5),p95Ms:percentile(group.map(row=>row[name].p95Ms),.5)};
 }
 metric.peakServerRssMiB=percentile(group.map(row=>row.peakServerRssMiB),.5);
 return metric;
});
const json=JSON.stringify(results,null,2)+'\n';
if(options.output)fs.writeFileSync(options.output,json);
process.stdout.write(json);
