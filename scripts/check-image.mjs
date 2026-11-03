// Run after building the production Dockerfile. No network, host data or Obsidian download.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const image=process.argv[2] || 'ignis:architecture-smoke';
if(!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) || process.argv.length>3)throw new Error('Usage: node scripts/check-image.mjs [image]');
const name='ignis-image-smoke-'+randomUUID();
const source=`
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
fs.mkdirSync('/tmp/obsidian');
fs.writeFileSync('/tmp/obsidian/index.html','<script src="app.js"></script>');
fs.writeFileSync('/tmp/obsidian/app.js','');
fs.writeFileSync('/tmp/obsidian/package.json',JSON.stringify({version:'1.14.4'}));
const {createApplication}=require('./apps/ignis-server/server/app/create-application');
const app=createApplication();
const get=(port,path)=>new Promise((resolve,reject)=>{
  const request=http.get({host:'127.0.0.1',port,path,headers:{Host:'localhost:8080'}},response=>{
    let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body}));response.on('error',reject);
  });request.on('error',reject);
});
(async()=>{
  try {
    const {port}=await app.start();
    const status=await get(port,'/api/auth/status');
    assert.equal(status.status,200);assert.equal(JSON.parse(status.body).initialized,false);
    for(const path of ['/setup','/login','/auth/login.js'])assert.equal((await get(port,path)).status,200,path);
  } finally {await app.stop();}
  console.log('PASS: production image starts, serves authentication and stops cleanly (Node '+process.version+').');
})().catch(error=>{console.error('Image smoke failed:',error.code || error.name);process.exitCode=1;});
`;
try {
  const result=spawnSync('docker',['run','--rm','--init','--name',name,'--network','none','--read-only',
    '--user','1000:1000','--tmpfs','/tmp:rw,nosuid,noexec,size=64m',
    '-e','PORT=0','-e','DATA_ROOT=/tmp/data','-e','VAULT_ROOT=/tmp/vaults','-e','OBSIDIAN_ASSETS_PATH=/tmp/obsidian',
    '-e','IGNIS_PUBLIC_ORIGIN=http://localhost:8080','-e','IGNIS_ALLOW_HTTP_LOOPBACK=true',
    '-e','IGNIS_OIDC_ENABLED=false','-e','IGNIS_LOG_FILE_ENABLED=false','--entrypoint','node',image,'-e',source],
    {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error || result.status!==0)throw new Error('Production image acceptance failed');
} finally {
  // A killed Docker client can leave its container alive. Remove only our unique fixture.
  spawnSync('docker',['rm','--force',name],{stdio:'ignore',timeout:10000});
}
